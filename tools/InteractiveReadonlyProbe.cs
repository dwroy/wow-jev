// One-shot read-only retail WoW desktop evidence. C# 5 / .NET Framework 4.
// Does not activate windows, send input, read credentials, or change configuration.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using WowJev.Input;

class InteractiveReadonlyProbe
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Native.Point point);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectory(string path, IntPtr securityAttributes);
    const string RetailPath = @"C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Need(bool good, string reason) { if (!good) throw new InvalidOperationException(reason); }
    static Dictionary<string, string> Parse(string[] args)
    {
        bool diagnostic = args.Length == 7 && args[6] == "--diagnose-desktop";
        if (diagnostic) Array.Resize(ref args, 6);
        Need(args.Length == 6, "exactly_three_readonly_options_required");
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < args.Length; i += 2)
        {
            string key = args[i];
            Need(key == "--pid" || key == "--expected-start-ticks" || key == "--out", "unknown_option_readonly_probe_only");
            Need(!options.ContainsKey(key) && args[i + 1].Length > 0, "duplicate_or_empty_option");
            options.Add(key, args[i + 1]);
        }
        Need(options.ContainsKey("--pid") && options.ContainsKey("--expected-start-ticks") && options.ContainsKey("--out"), "missing_required_option");
        int pid; long ticks;
        Need(Int32.TryParse(options["--pid"], NumberStyles.None, CultureInfo.InvariantCulture, out pid) && pid > 0, "invalid_pid");
        Need(Int64.TryParse(options["--expected-start-ticks"], NumberStyles.None, CultureInfo.InvariantCulture, out ticks) && ticks > 0, "invalid_start_ticks");
        string output = options["--out"];
        Need(Regex.IsMatch(output, @"^\\\\(?:wsl\.localhost|wsl\$)\\[A-Za-z0-9_.-]+\\home\\dw\\Projects\\wow-jev\\out\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*$", RegexOptions.IgnoreCase), "explicit_project_output_unc_required");
        foreach (string component in output.Split('\\')) Need(component != "." && component != "..", "path_traversal_rejected");
        Need(String.Equals(Path.GetFullPath(output), output, StringComparison.OrdinalIgnoreCase), "canonical_output_required");
        if (diagnostic) options.Add("diagnose-desktop", "true");
        return options;
    }
    static void NoReparse(string path)
    {
        string current = path;
        while (!String.IsNullOrEmpty(current))
        {
            if (Directory.Exists(current) || File.Exists(current)) Need((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "output_reparse_rejected");
            string parent = Path.GetDirectoryName(current);
            if (parent == current) break;
            current = parent;
        }
    }
    static Dictionary<string, object> Identity(int pid, long expectedTicks)
    {
        using (Process process = Process.GetProcessById(pid))
        {
            Need(!process.HasExited, "wow_process_exited");
            Need(process.SessionId == 1, "wow_not_interactive_session_1");
            Need(process.ProcessName == "Wow", "not_wow_process");
            long ticks = process.StartTime.ToUniversalTime().Ticks;
            Need(ticks == expectedTicks, "wow_start_identity_changed");
            string executable = process.MainModule.FileName;
            Need(String.Equals(executable, RetailPath, StringComparison.OrdinalIgnoreCase), "not_expected_retail_executable");
            return new Dictionary<string, object> { { "pid", pid }, { "start_ticks", ticks.ToString(CultureInfo.InvariantCulture) }, { "session_id", process.SessionId }, { "executable", executable } };
        }
    }
    static Dictionary<string, object> Window(IntPtr hwnd, int pid)
    {
        WindowInfo window = Native.GetWindow(hwnd);
        Need(window.Pid == pid, "window_pid_changed");
        var className = new StringBuilder(256);
        Need(GetClassName(hwnd, className, className.Capacity) > 0, "window_class_unavailable");
        string name = className.ToString();
        // Readonly discovery records the actual class. No input authority is
        // granted by this probe; any later executor must bind this exact class.
        bool standardClass = name == "GxWindowClass" || name == "GxWindowClassD3d";
        Rect outer; Need(GetWindowRect(hwnd, out outer), "window_bounds_unavailable");
        var origin = new Native.Point(); Need(ClientToScreen(hwnd, ref origin), "client_origin_unavailable");
        uint dpi = GetDpiForWindow(hwnd); Need(dpi > 0, "window_dpi_unavailable");
        return new Dictionary<string, object> {
            { "hwnd", "0x" + hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture) }, { "pid", window.Pid },
            { "class", name }, { "standard_class_known", standardClass }, { "client_width_physical_px", window.Width }, { "client_height_physical_px", window.Height },
            { "client_screen_x_physical_px", origin.X }, { "client_screen_y_physical_px", origin.Y },
            { "window_bounds_physical_px", new int[] { outer.Left, outer.Top, outer.Right, outer.Bottom } },
            { "dpi", dpi }, { "dpi_source", "GetDpiForWindow" }, { "focused", window.Focused },
            { "foreground_hwnd", "0x" + GetForegroundWindow().ToInt64().ToString("x", CultureInfo.InvariantCulture) }, { "minimized", IsIconic(hwnd) }
        };
    }
    static void NewJson(string path, object value)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + "\n");
        using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) output.Write(bytes, 0, bytes.Length);
    }
    static string Sha256(string path)
    {
        using (var stream = File.OpenRead(path)) using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    static int Main(string[] args)
    {
        string directory = null; bool ownsDirectory = false;
        var result = new Dictionary<string, object> { { "schema_version", 1 }, { "probe", "interactive-readonly-v1" }, { "status", "failed" }, { "real_inputs", 0 }, { "model_calls", 0 }, { "clock_domain", "windows-qpc" }, { "utc_started", DateTime.UtcNow.ToString("o") } };
        try
        {
            var options = Parse(args);
            directory = options["--out"];
            Need(!Directory.Exists(directory) && !File.Exists(directory), "output_directory_must_be_new");
            NoReparse(Path.GetDirectoryName(directory));
            // Reserve ownership before any desktop access. Every artifact uses CreateNew.
            Need(CreateDirectory(directory, IntPtr.Zero), "exclusive_output_directory_creation_failed:" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            using (var lease = new FileStream(Path.Combine(directory, "owned.lock"), FileMode.CreateNew, FileAccess.Write, FileShare.None)) { ownsDirectory = true; }
            int pid = Int32.Parse(options["--pid"], CultureInfo.InvariantCulture);
            long ticks = Int64.Parse(options["--expected-start-ticks"], CultureInfo.InvariantCulture);
            using (Process self = Process.GetCurrentProcess())
            {
                result["probe_pid"] = self.Id; result["probe_session_id"] = self.SessionId;
                Need(self.SessionId == 1, "probe_not_interactive_session_1");
            }
            Native.MakeDpiAware();
            result["dpi_awareness_attempt"] = "per-monitor-v2-with-system-aware-fallback";
            result["observation_started_windows_qpc_ms"] = Clock.PreciseMs;
            result["process_before"] = Identity(pid, ticks);
            if (options.ContainsKey("diagnose-desktop"))
            {
                var samples = new List<object>();
                for (int sample = 0; sample < 3; sample++)
                {
                    if (sample > 0) System.Threading.Thread.Sleep(500);
                    samples.Add(ReadonlyDesktopDiagnostics.Snapshot(pid));
                }
                result["desktop_samples"] = samples;
                result["process_after"] = Identity(pid, ticks);
                result["observation_finished_windows_qpc_ms"] = Clock.PreciseMs;
                result["status"] = "diagnosed";
                result["capture_count"] = 0;
                NewJson(Path.Combine(directory, "result.json"), result);
                return 0;
            }
            var windows = Native.ListCandidates().FindAll(delegate(WindowInfo item) { return item.Pid == pid; });
            Need(windows.Count == 1, "one_visible_nonminimized_wow_window_required");
            WindowInfo window = windows[0];
            result["window_title"] = window.Title;
            var before = Window(window.Hwnd, pid); result["window_before"] = before;
            string capture = Path.Combine(directory, "client.png");
            result["capture_started_windows_qpc_ms"] = Clock.PreciseMs;
            bool captured; int captureError;
            using (var bitmap = new Bitmap(window.Width, window.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr dc = graphics.GetHdc();
                    try
                    {
                        captured = PrintWindow(window.Hwnd, dc, 3); // PW_CLIENTONLY | PW_RENDERFULLCONTENT.
                        captureError = captured ? 0 : Marshal.GetLastWin32Error();
                    }
                    finally { graphics.ReleaseHdc(dc); }
                }
                result["capture_finished_windows_qpc_ms"] = Clock.PreciseMs;
                result["print_window_returned"] = captured;
                result["print_window_error"] = captureError;
                result["process_after"] = Identity(pid, ticks);
                var windowsAfter = Native.ListCandidates().FindAll(delegate(WindowInfo item) { return item.Pid == pid; });
                Need(windowsAfter.Count == 1 && windowsAfter[0].Hwnd == window.Hwnd, "wow_window_identity_changed");
                var after = Window(window.Hwnd, pid); result["window_after"] = after;
                Need((int)before["client_width_physical_px"] == (int)after["client_width_physical_px"] && (int)before["client_height_physical_px"] == (int)after["client_height_physical_px"] && (uint)before["dpi"] == (uint)after["dpi"], "window_dimensions_or_dpi_changed");
                // Retain capture bytes even when PrintWindow reports failure; appearance requires review.
                using (var output = new FileStream(capture, FileMode.CreateNew, FileAccess.Write, FileShare.None)) bitmap.Save(output, ImageFormat.Png);
            }
            result["capture_file"] = "client.png"; result["capture_sha256"] = Sha256(capture);
            result["capture_method"] = "PrintWindow(PW_CLIENTONLY|PW_RENDERFULLCONTENT)";
            result["capture_visual_validity"] = "unverified_requires_image_review";
            result["observation_finished_windows_qpc_ms"] = Clock.PreciseMs;
            Need(captured, "print_window_failed_capture_retained");
            result["status"] = "captured";
            NewJson(Path.Combine(directory, "result.json"), result);
            try { Console.WriteLine(Json.Serialize(result)); } catch (IOException) { }
            return 0;
        }
        catch (Exception error)
        {
            result["error"] = error.Message; result["exception_type"] = error.GetType().Name;
            result["utc_finished"] = DateTime.UtcNow.ToString("o");
            if (ownsDirectory)
            {
                try { NewJson(Path.Combine(directory, "result.json"), result); }
                catch (Exception saveError) { result["failure_record_error"] = saveError.GetType().Name + ":" + saveError.Message; }
            }
            try { Console.Error.WriteLine(Json.Serialize(result)); } catch (IOException) { }
            return 2;
        }
    }
}
