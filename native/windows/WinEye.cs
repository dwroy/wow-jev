using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using WowJev.Input;
using WowJev.Eye;

// Read-only Windows capture/CV. No input, focus changes, global hooks or input lease.
static class WinEye
{
    const int MaxIds = 4096, MaxFiles = 128;
    const long MaxArtifactBytes = 128L * 1024 * 1024;
    static readonly Regex Identifier = new Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    [DllImport("user32.dll", SetLastError = true)] static extern bool PrintWindow(IntPtr hwnd, IntPtr deviceContext, uint flags);

    sealed class Options
    {
        public string Mode, Session, Calibration, Image, ExportDirectory;
        public IntPtr Window;
        public int Pid;
        public static Options Parse(string[] args)
        {
            if (args.Length < 1 || (args[0] != "serve" && args[0] != "classify")) throw new EyeFailure("invalid_mode");
            Options options = new Options { Mode = args[0] };
            HashSet<string> seen = new HashSet<string>();
            for (int i = 1; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length || !seen.Add(args[i])) throw new EyeFailure("invalid_options");
                string value = args[i + 1];
                if (args[i] == "--window" && options.Mode == "serve")
                {
                    if (!Regex.IsMatch(value, "^0x[0-9a-fA-F]{1,16}$")) throw new EyeFailure("invalid_hwnd");
                    options.Window = new IntPtr(unchecked((long)UInt64.Parse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture)));
                }
                else if (args[i] == "--expected-pid" && options.Mode == "serve")
                { if (!Int32.TryParse(value, out options.Pid) || options.Pid <= 0) throw new EyeFailure("invalid_pid"); }
                else if (args[i] == "--session" && options.Mode == "serve") options.Session = value;
                else if (args[i] == "--export-dir" && options.Mode == "serve") options.ExportDirectory = Absolute(value);
                else if (args[i] == "--calibration") options.Calibration = Absolute(value);
                else if (args[i] == "--image" && options.Mode == "classify") options.Image = Absolute(value);
                else throw new EyeFailure("invalid_options");
            }
            if (options.Mode == "serve")
            {
                Guid id;
                if (options.Window == IntPtr.Zero || options.Pid <= 0 || !Guid.TryParseExact(options.Session, "D", out id) || id.ToString("D") != options.Session)
                    throw new EyeFailure("invalid_options");
            }
            else if (options.Image == null) throw new EyeFailure("missing_image");
            return options;
        }
        static string Absolute(string value)
        {
            if (!Path.IsPathRooted(value)) throw new EyeFailure("windows_absolute_path_required");
            return Path.GetFullPath(value);
        }
    }

    sealed class Server : IDisposable
    {
        readonly Options options;
        readonly InventoryCalibration calibration;
        readonly long targetStart;
        readonly string artifactRoot;
        readonly HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
        readonly object state = new object();
        readonly JsonOutput output = new JsonOutput();
        Thread worker;
        bool inFlight;
        volatile bool ending;
        long sequence;
        double[] previous;
        int previousWidth, previousHeight;
        int savedFiles;
        long savedBytes;

        public Server(Options options)
        {
            this.options = options;
            calibration = options.Calibration == null ? null : new InventoryCalibration(options.Calibration);
            WindowInfo window = CheckWindow();
            targetStart = Native.GetProcessStartTicks(options.Pid);
            artifactRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WowJevEye", options.Session);
            if (!Path.IsPathRooted(artifactRoot) || artifactRoot.StartsWith("\\\\")) throw new EyeFailure("native_artifact_root_unavailable");
            Dictionary<string, object> ready = Envelope("ready");
            ready["window"] = WindowJson(window); ready["artifact_root"] = artifactRoot; ready["capture_method"] = "printwindow";
            ready["capture_pid"] = Process.GetCurrentProcess().Id;
            ready["export_root"] = options.ExportDirectory;
            Emit(ready);
        }
        WindowInfo CheckWindow()
        {
            try
            {
                if (targetStart != 0 && !Native.IsProcessAlive(options.Pid, targetStart)) throw new EyeFailure("window_process_changed");
                WindowInfo window = Native.GetWindow(options.Window);
                if (window.Pid != options.Pid) throw new EyeFailure("window_pid_mismatch");
                if (window.Width > 65535 || window.Height > 65535 || (long)window.Width * window.Height > 64000000) throw new EyeFailure("frame_too_large");
                return window;
            }
            catch (EyeFailure) { throw; }
            catch { throw new EyeFailure("window_unavailable"); }
        }
        object WindowJson(WindowInfo window)
        { return EyeJson.Obj("hwnd", "0x" + options.Window.ToInt64().ToString("x"), "pid", window.Pid, "client_width", window.Width, "client_height", window.Height, "focused", window.Focused); }
        Dictionary<string, object> Envelope(string type)
        { return EyeJson.Obj("protocol", "wow-eye", "version", 1, "type", type, "session_id", options.Session, "local_clock", LocalClock()); }
        void Emit(Dictionary<string, object> message)
        { if (!output.Emit(message)) ending = true; }
        void Error(string id, string reason)
        {
            Dictionary<string, object> message = Envelope("error");
            if (id != null) message["id"] = id;
            message["reason"] = EyeJson.Reason(reason); Emit(message);
        }
        public void Run()
        {
            while (!ending)
            {
                bool oversized;
                string line = ReadBounded(out oversized);
                if (line == null) break;
                if (oversized) { Error(null, "command_too_large"); continue; }
                if (line.Trim().Length == 0) continue;
                string id = null;
                try
                {
                    Dictionary<string, object> command = EyeJson.Map(new JavaScriptSerializer().DeserializeObject(line));
                    EyeJson.Exact(command, "protocol", "version", "type", "session_id", "id", "op", "save");
                    if (EyeJson.Text(command, "protocol") != "wow-eye" || EyeJson.Int(command, "version", 1, 1) != 1 ||
                        EyeJson.Text(command, "type") != "command" || EyeJson.Text(command, "session_id") != options.Session) throw new EyeFailure("invalid_command");
                    id = EyeJson.Text(command, "id"); if (!Identifier.IsMatch(id)) { id = null; throw new EyeFailure("invalid_id"); }
                    string op = EyeJson.Text(command, "op");
                    if (op != "sample" && op != "shutdown") throw new EyeFailure("invalid_op");
                    bool save = false;
                    if (command.ContainsKey("save"))
                    {
                        if (op != "sample" || !(command["save"] is bool)) throw new EyeFailure("invalid_save");
                        save = (bool)command["save"];
                    }
                    lock (state)
                    {
                        if (ids.Contains(id)) throw new EyeFailure("duplicate_id");
                        if (op == "sample" && ids.Count >= MaxIds) throw new EyeFailure("id_capacity");
                        if (ids.Count < MaxIds) ids.Add(id);
                        if (op == "shutdown") ending = true;
                        else
                        {
                            if (inFlight) throw new EyeFailure("sample_busy");
                            inFlight = true;
                            string requestId = id; bool saveRequested = save;
                            worker = new Thread(delegate() { Sample(requestId, saveRequested); });
                            worker.IsBackground = true; worker.Start();
                        }
                    }
                    if (op == "shutdown")
                    {
                        if (worker != null) worker.Join(1000);
                        Dictionary<string, object> stopped = Envelope("stopped"); stopped["id"] = id; Emit(stopped);
                    }
                }
                catch (EyeFailure error) { Error(id, error.Code); }
                catch { Error(id, "invalid_json_or_command"); }
            }
            ending = true;
        }
        void Sample(string id, bool save)
        {
            try
            {
                long started = Clock.NowMs;
                WindowInfo before = CheckWindow();
                using (Bitmap image = new Bitmap(before.Width, before.Height, PixelFormat.Format24bppRgb))
                {
                    bool captured;
                    using (Graphics graphics = Graphics.FromImage(image))
                    {
                        graphics.Clear(Color.Black);
                        IntPtr dc = graphics.GetHdc();
                        try { captured = PrintWindow(options.Window, dc, 3); } // PW_CLIENTONLY | PW_RENDERFULLCONTENT
                        finally { graphics.ReleaseHdc(dc); }
                    }
                    WindowInfo after = CheckWindow();
                    long finished = Clock.NowMs;
                    string failure = !captured ? "printwindow_failed" : before.Width != after.Width || before.Height != after.Height ? "client_size_changed" : null;
                    FrameMetrics metrics = failure == null ? new FrameMetrics(image) : null;
                    if (metrics != null && metrics.Empty) failure = "empty_or_near_black_frame";
                    long seq = sequence++;
                    Dictionary<string, object> capture = EyeJson.Obj("status", failure == null ? "ok" : "unavailable", "started_qpc_ms", started,
                        "finished_qpc_ms", finished, "method", "printwindow");
                    if (failure != null) capture["reason"] = EyeJson.Reason(failure);
                    object detector = failure != null ? InventoryCalibration.Unsupported(failure) :
                        calibration == null ? InventoryCalibration.Unsupported("calibration_unavailable") : calibration.Detect(image);
                    object metricJson = metrics == null ? EyeJson.Obj("mean_luma", null, "variance_luma", null, "frame_delta", null) :
                        metrics.Json(previousWidth == image.Width && previousHeight == image.Height ? previous : null);
                    object artifact = failure == null && save && !ending ? Save(image, seq) : null;
                    if (failure == null) { previous = metrics.Thumbnail; previousWidth = image.Width; previousHeight = image.Height; }
                    else previous = null;
                    Dictionary<string, object> message = Envelope("sample");
                    message["id"] = id; message["seq"] = seq; message["window"] = WindowJson(after);
                    message["capture"] = capture; message["metrics"] = metricJson;
                    message["detectors"] = EyeJson.Obj("inventory_open", detector); message["artifact"] = artifact;
                    lock (state) { if (!ending) Emit(message); }
                }
            }
            catch (EyeFailure error) { if (!ending) Error(id, error.Code); previous = null; }
            catch { if (!ending) Error(id, "capture_or_processing_failed"); previous = null; }
            finally { lock (state) inFlight = false; }
        }
        object Save(Bitmap image, long seq)
        {
            Directory.CreateDirectory(artifactRoot);
            if ((new DirectoryInfo(artifactRoot).Attributes & FileAttributes.ReparsePoint) != 0 ||
                (new DirectoryInfo(Path.GetDirectoryName(artifactRoot)).Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("unsafe_artifact_directory");
            if (savedFiles == 0)
            {
                foreach (string existing in Directory.GetFiles(artifactRoot, "*.jpg"))
                { FileInfo info = new FileInfo(existing); savedFiles++; savedBytes += info.Length; }
            }
            if (savedFiles >= MaxFiles || savedBytes >= MaxArtifactBytes) throw new EyeFailure("artifact_quota_exceeded");
            string token = Guid.NewGuid().ToString("N");
            string path = Path.Combine(artifactRoot, "capture-" + token + ".jpg");
            string exported = null;
            bool exportCreated = false;
            try
            {
                ImageCodecInfo encoder = null;
                foreach (ImageCodecInfo item in ImageCodecInfo.GetImageEncoders()) if (item.MimeType == "image/jpeg") encoder = item;
                if (encoder == null) throw new EyeFailure("jpeg_encoder_unavailable");
                using (EncoderParameters parameters = new EncoderParameters(1))
                using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L); image.Save(file, encoder, parameters); }
                long bytes = new FileInfo(path).Length;
                if (bytes > 64L * 1024 * 1024 || bytes + savedBytes > MaxArtifactBytes) throw new EyeFailure("artifact_quota_exceeded");
                string sha = EyeJson.Hash(path);
                if (options.ExportDirectory != null)
                {
                    Directory.CreateDirectory(options.ExportDirectory);
                    if ((new DirectoryInfo(options.ExportDirectory).Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("unsafe_export_directory");
                    exported = Path.Combine(options.ExportDirectory, Path.GetFileName(path));
                    // CreateNew never overwrites an existing user's file. Only
                    // explicit low-frequency JPEGs cross this export boundary.
                    using (FileStream destination = new FileStream(exported, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        exportCreated = true;
                        using (FileStream source = File.OpenRead(path)) source.CopyTo(destination);
                        destination.Flush(true);
                    }
                    if (new FileInfo(exported).Length != bytes || EyeJson.Hash(exported) != sha) throw new EyeFailure("export_verification_failed");
                }
                savedBytes += bytes; savedFiles++;
                Dictionary<string, object> artifact = EyeJson.Obj("id", "image-" + options.Session + "-" + seq, "windows_path", path, "sha256", sha, "width", image.Width, "height", image.Height);
                if (exported != null) artifact["exported_windows_path"] = exported;
                return artifact;
            }
            catch (EyeFailure)
            { try { File.Delete(path); } catch { } if (exportCreated) { try { File.Delete(exported); } catch { } } throw; }
            catch
            { try { File.Delete(path); } catch { } if (exportCreated) { try { File.Delete(exported); } catch { } } throw new EyeFailure(exported != null ? "artifact_export_failed" : "artifact_save_failed"); }
        }
        public void Dispose()
        { ending = true; if (worker != null) worker.Join(1000); output.Close(); }
    }

    sealed class JsonOutput
    {
        readonly BlockingCollection<string> queue = new BlockingCollection<string>(128);
        readonly Thread writer;
        public JsonOutput()
        {
            writer = new Thread(delegate()
            { try { foreach (string item in queue.GetConsumingEnumerable()) { Console.Out.WriteLine(item); Console.Out.Flush(); } } catch { } });
            writer.IsBackground = true; writer.Start();
        }
        public bool Emit(object value)
        {
            string line = new JavaScriptSerializer().Serialize(value);
            if (Encoding.UTF8.GetByteCount(line) > 65536) return false;
            try { return queue.TryAdd(line); } catch (InvalidOperationException) { return false; }
        }
        public void Close() { queue.CompleteAdding(); writer.Join(200); }
    }
    static string ReadBounded(out bool oversized)
    {
        oversized = false; StringBuilder line = new StringBuilder(); int value;
        while ((value = Console.In.Read()) >= 0)
        {
            if (value == '\n') break;
            if (line.Length < 65536) line.Append((char)value); else oversized = true;
        }
        if (value < 0 && line.Length == 0 && !oversized) return null;
        return line.ToString();
    }
    static object LocalClock() { return EyeJson.Obj("domain", "windows-qpc", "at_ms", Clock.NowMs); }
    static int Classify(Options options)
    {
        InventoryCalibration calibration = options.Calibration == null ? null : new InventoryCalibration(options.Calibration);
        FileInfo file = new FileInfo(options.Image);
        if (!file.Exists || file.Length < 1 || file.Length > 64L * 1024 * 1024 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("invalid_image_file");
        using (Bitmap image = new Bitmap(options.Image))
        {
            if (image.Width > 65535 || image.Height > 65535 || (long)image.Width * image.Height > 64000000) throw new EyeFailure("frame_too_large");
            FrameMetrics metrics = new FrameMetrics(image);
            object detector = metrics.Empty ? InventoryCalibration.Unsupported("empty_or_near_black_frame") :
                calibration == null ? InventoryCalibration.Unsupported("calibration_unavailable") : calibration.Detect(image);
            Console.WriteLine(new JavaScriptSerializer().Serialize(EyeJson.Obj("protocol", "wow-eye", "version", 1, "type", "offline_result",
                "image", EyeJson.Obj("width", image.Width, "height", image.Height, "sha256", EyeJson.Hash(options.Image)),
                "frame_status", metrics.Empty ? "unavailable" : "ok", "metrics", metrics.Json(null),
                "detectors", EyeJson.Obj("inventory_open", detector), "local_clock", LocalClock())));
        }
        return 0;
    }
    static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        Options options = null;
        try
        {
            options = Options.Parse(args); Native.MakeDpiAware();
            if (options.Mode == "classify") return Classify(options);
            using (Server server = new Server(options)) server.Run();
            return 0;
        }
        catch (Exception error)
        {
            EyeFailure known = error as EyeFailure;
            Dictionary<string, object> response = EyeJson.Obj("protocol", "wow-eye", "version", 1, "type", "error", "reason",
                EyeJson.Reason(known == null ? "native_eye_failed" : known.Code), "local_clock", LocalClock());
            if (options != null && options.Session != null) response["session_id"] = options.Session;
            Console.WriteLine(new JavaScriptSerializer().Serialize(response)); return 2;
        }
    }
}
