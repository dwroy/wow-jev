// Read-only incremental file reader. It never activates a window or sends input.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class WinCombatLog
{
    [StructLayout(LayoutKind.Sequential)] struct FileInfoNative
    {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfoNative info);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static volatile bool Stop;
    static long Qpc() { return (long)(Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency); }
    static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void Emit(string type, string session, Dictionary<string, object> values)
    {
        values["protocol"] = "wow-combat-log"; values["version"] = 1; values["type"] = type; values["session_id"] = session;
        values["received_qpc_ms"] = Qpc(); Console.WriteLine(Json.Serialize(values)); Console.Out.Flush();
    }
    static string Identity(FileStream file)
    {
        FileInfoNative info;
        if (!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(), out info)) throw new IOException("file_identity_unavailable");
        return info.Volume.ToString("x") + "-" + info.IndexHigh.ToString("x") + "-" + info.IndexLow.ToString("x");
    }
    static FileStream Open(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("reparse_file_rejected");
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    }
    static string Header(FileStream file)
    {
        long position = file.Position; file.Position = 0; List<byte> bytes = new List<byte>();
        try
        {
            int b;
            while (bytes.Count < 65536 && (b = file.ReadByte()) >= 0)
            { if (b == 10) return Utf8.GetString(bytes.ToArray()).TrimEnd('\r'); bytes.Add((byte)b); }
            return null; // An incomplete header is never treated as a complete record.
        }
        finally { file.Position = position; }
    }
    static byte[] Checkpoint(FileStream file, long position)
    {
        long saved = file.Position;
        try { int size = (int)Math.Min(64, position); byte[] bytes = new byte[size]; file.Position = position - size;
            int n = 0, read; while (n < size && (read = file.Read(bytes, n, size - n)) > 0) n += read;
            if (n != size) return null; return bytes; }
        finally { file.Position = saved; }
    }
    static bool Equal(byte[] a, byte[] b)
    { if (a == null || b == null || a.Length != b.Length) return false; for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }
    static string Select(string file, string directory)
    {
        if (file != null) return File.Exists(file) ? file : null;
        if (!Directory.Exists(directory)) return null;
        string[] paths = Directory.GetFiles(directory, "WoWCombatLog*.txt");
        if (paths.Length > 1024) throw new IOException("too_many_log_files");
        Array.Sort(paths, delegate(string a, string b)
        { int compare = File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)); return compare == 0 ? String.CompareOrdinal(a, b) : compare; });
        return paths.Length == 0 ? null : paths[0];
    }
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        string file = null, directory = null, session = null; int duration = 30000, poll = 250, maxLines = 10000; bool fromEnd = true;
        try
        {
            HashSet<string> seen = new HashSet<string>();
            for (int i = 0; i < args.Length; i += 2)
            {
                if (i + 1 == args.Length || !seen.Add(args[i])) throw new ArgumentException("invalid_options");
                string value = args[i + 1];
                switch (args[i])
                {
                    case "--file": if (!Path.IsPathRooted(value)) throw new ArgumentException("absolute_path_required"); file = Path.GetFullPath(value); break;
                    case "--directory": if (!Path.IsPathRooted(value)) throw new ArgumentException("absolute_path_required"); directory = Path.GetFullPath(value); break;
                    case "--session": session = value; break;
                    case "--duration-ms": duration = Int32.Parse(value); break;
                    case "--poll-ms": poll = Int32.Parse(value); break;
                    case "--max-lines": maxLines = Int32.Parse(value); break;
                    case "--from": if (value != "start" && value != "end") throw new ArgumentException("invalid_from"); fromEnd = value == "end"; break;
                    default: throw new ArgumentException("invalid_options");
                }
            }
            Guid parsed;
            if ((file == null) == (directory == null) || !Guid.TryParseExact(session, "D", out parsed) || parsed.ToString("D") != session ||
                duration < 1 || duration > 300000 || poll < 10 || poll > 5000 || maxLines < 1 || maxLines > 100000) throw new ArgumentException("invalid_options");
            if (file != null && !Path.GetFileName(file).StartsWith("WoWCombatLog", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("not_combat_log_file");
            Thread input = new Thread(delegate() { try { while (Console.ReadLine() != null) { } } catch { } Stop = true; });
            input.IsBackground = true; input.Start();
            Emit("ready", session, new Dictionary<string, object> { { "from", fromEnd ? "end" : "start" }, { "poll_ms", poll }, { "input_enabled", false } });
            long deadline = Qpc() + duration, lineOffset = 0; int generation = 0, count = 0;
            string activePath = null, activeIdentity = null; FileStream active = null;
            List<byte> pending = new List<byte>(); byte[] buffer = new byte[65536], checkpoint = null; bool discardPartial = false, oversized = false;
            try
            {
                while (!Stop && Qpc() < deadline && count < maxLines)
                {
                    string selected = Select(file, directory); bool changed = selected != activePath;
                    if (!changed && selected != null)
                    {
                        try { using (FileStream probe = Open(selected)) changed = Identity(probe) != activeIdentity; }
                        catch (FileNotFoundException) { Thread.Sleep(poll); continue; }
                        catch (DirectoryNotFoundException) { Thread.Sleep(poll); continue; }
                    }
                    if (active != null && active.Length < active.Position) changed = true;
                    if (!changed && active != null && checkpoint != null && !Equal(checkpoint, Checkpoint(active, active.Position))) changed = true;
                    if (changed || active == null && selected != null)
                    {
                        if (active != null) active.Dispose(); active = null; activePath = selected; activeIdentity = null;
                        pending.Clear(); checkpoint = null; discardPartial = false; oversized = false;
                        if (selected != null)
                        {
                            try { active = Open(selected); } catch (FileNotFoundException) { activePath = null; Thread.Sleep(poll); continue; }
                            catch (DirectoryNotFoundException) { activePath = null; Thread.Sleep(poll); continue; }
                            activeIdentity = Identity(active); generation++;
                            string header = Header(active);
                            // Skip existing data only on initial live attachment. New generations are read from start.
                            bool skip = fromEnd && generation == 1;
                            long start = skip ? active.Length : 0;
                            if (start > 0) { active.Position = start - 1; discardPartial = active.ReadByte() != 10; }
                            active.Position = start; lineOffset = start; checkpoint = Checkpoint(active, start);
                            Emit("file", session, new Dictionary<string, object> { { "path", selected }, { "file_id", activeIdentity }, { "generation", generation }, { "offset", start }, { "header", header } });
                        }
                    }
                    if (active == null) { Thread.Sleep(poll); continue; }
                    int read = active.Read(buffer, 0, buffer.Length);
                    if (read == 0) { Thread.Sleep(poll); continue; }
                    long chunkStart = active.Position - read;
                    checkpoint = Checkpoint(active, active.Position);
                    for (int i = 0; i < read && count < maxLines && !Stop; i++)
                    {
                        byte b = buffer[i];
                        if (b != 10)
                        {
                            if (!discardPartial && !oversized)
                            { if (pending.Count == 65536) { oversized = true; pending.Clear(); } else pending.Add(b); }
                            continue;
                        }
                        if (oversized)
                            Emit("error", session, new Dictionary<string, object> { { "code", "line_too_large" }, { "generation", generation }, { "offset", lineOffset } });
                        else if (!discardPartial)
                        {
                            byte[] bytes = pending.ToArray(); string raw = null;
                            try { raw = Utf8.GetString(bytes).TrimEnd('\r'); }
                            catch (DecoderFallbackException) { Emit("error", session, new Dictionary<string, object> { { "code", "invalid_utf8" }, { "generation", generation }, { "offset", lineOffset } }); }
                            if (raw != null)
                            {
                                Emit("line", session, new Dictionary<string, object> { { "path", activePath }, { "file_id", activeIdentity }, { "generation", generation },
                                    { "offset", lineOffset }, { "byte_length", bytes.Length + 1 }, { "raw", raw }, { "sha256", Hash(Utf8.GetBytes(raw)) } });
                                count++;
                            }
                        }
                        pending.Clear(); discardPartial = false; oversized = false; lineOffset = chunkStart + i + 1;
                    }
                }
            }
            finally { if (active != null) active.Dispose(); }
            Emit("stopped", session, new Dictionary<string, object> { { "lines", count }, { "reason", Stop ? "stdin_eof" : count >= maxLines ? "line_limit" : "duration" }, { "pending_bytes", pending.Count } });
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(Json.Serialize(new Dictionary<string, object> { { "error", e is ArgumentException || e is FormatException ? "invalid_options" : "reader_failed" }, { "detail", e.Message } }));
            return 2;
        }
    }
}
