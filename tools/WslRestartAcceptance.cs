// Windows-host preflight, explicit Ubuntu-only restart harness, and evidence verifier.
// C# 5 / .NET Framework 4. Actual run requires --run --confirm-distro-restart Ubuntu.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using WowJev.Input;

static partial class WslRestartAcceptance
{
    sealed class Failure : Exception { public readonly string Code; public Failure(string code) { Code = code; } }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    static Dictionary<string, object> HostJob()
    {
        bool inside;
        bool known = IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inside);
        return Obj("known", known, "in_job", known ? (object)inside : null, "win32_error", known ? 0 : Marshal.GetLastWin32Error(),
            "pid", Process.GetCurrentProcess().Id, "start_ticks", Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),
            "launch_path", Process.GetCurrentProcess().MainModule.FileName, "breakaway_evidence", "not_provided", "survival", "requires_actual_before_after_observation");
    }
    static bool ActualRunBegan, SelfTesting;
    static long RunDeadlineMs;
    static int BoundedTimeout(int milliseconds)
    { long remaining = RunDeadlineMs == 0 ? milliseconds : RunDeadlineMs - Qpc(); Require(remaining > 0, "overall_restart_acceptance_deadline"); return (int)Math.Min(milliseconds, remaining); }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static string Encode(object value) { lock (Json) return Json.Serialize(value); }
    static object Decode(string value) { lock (Json) return Json.DeserializeObject(value); }
    static Dictionary<string, object> Obj(params object[] pairs)
    { var result = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]); return result; }
    static Dictionary<string, object> Map(object value)
    { var result = value as Dictionary<string, object>; if (result == null) throw new Failure("object_required"); return result; }
    static object Need(Dictionary<string, object> value, string key)
    { object result; if (!value.TryGetValue(key, out result)) throw new Failure("missing_" + key); return result; }
    static string Text(Dictionary<string, object> value, string key)
    { string result = Need(value, key) as string; if (String.IsNullOrEmpty(result)) throw new Failure("text_" + key); return result; }
    static long Integer(Dictionary<string, object> value, string key)
    { object v = Need(value, key); if (!(v is int) && !(v is long)) throw new Failure("integer_" + key); return Convert.ToInt64(v, CultureInfo.InvariantCulture); }
    static bool Boolean(Dictionary<string, object> value, string key)
    { object v = Need(value, key); if (!(v is bool)) throw new Failure("boolean_" + key); return (bool)v; }
    static object[] List(Dictionary<string, object> value, string key)
    { object[] v = Need(value, key) as object[]; if (v == null) throw new Failure("list_" + key); return v; }
    static string Hash(string path)
    { using (SHA256 digest = SHA256.Create()) using (FileStream file = File.OpenRead(path)) return BitConverter.ToString(digest.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    static string GuidText(Dictionary<string, object> value, string key)
    { string text = Text(value, key); Guid parsed; if (!Guid.TryParseExact(text, "D", out parsed) || parsed.ToString("D") != text) throw new Failure("uuid_" + key); return text; }
    static string Ticks(Dictionary<string, object> value, string key)
    { string text = Text(value, key); if (!Regex.IsMatch(text, "^[0-9]{1,20}\\z")) throw new Failure("ticks_" + key); return text; }
    static long Qpc()
    { long ticks = Stopwatch.GetTimestamp(), frequency = Stopwatch.Frequency; return ticks / frequency * 1000 + ticks % frequency * 1000 / frequency; }
    static void Require(bool condition, string reason) { if (!condition) throw new Failure(reason); }
    static void Local(string path)
    { Require(Path.IsPathRooted(path) && !path.StartsWith("\\\\", StringComparison.Ordinal) && Regex.IsMatch(path, "^[A-Za-z]:\\\\"), "windows_local_path_required"); }
    static void Save(string path, object value)
    { using (var file = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false))) file.WriteLine(Encode(value)); }
    static Dictionary<string, object> Load(string path)
    {
        FileInfo info = new FileInfo(path);
        Require(info.Exists && info.Length >= 2 && info.Length <= 4 * 1024 * 1024 && (info.Attributes & FileAttributes.ReparsePoint) == 0, "bounded_regular_json_required");
        return Map(Decode(File.ReadAllText(path)));
    }
    static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (!Regex.IsMatch(value, "[\\s\"]")) return value;
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; }
            else { result.Append('\\', slashes); result.Append(c); slashes = 0; }
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static string Query(string executable, string[] arguments, Encoding encoding)
    {
        var command = new StringBuilder(); foreach (string item in arguments) { if (command.Length > 0) command.Append(' '); command.Append(Quote(item)); }
        var options = new ProcessStartInfo(executable, command.ToString()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = encoding, WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System) };
        int timeout = BoundedTimeout(8000);
        using (Process process = Process.Start(options))
        {
            string output = null, error = null;
            Thread stdout = new Thread(delegate() { try { output = process.StandardOutput.ReadToEnd(); } catch { output = null; } }); stdout.IsBackground = true; stdout.Start();
            Thread stderr = new Thread(delegate() { try { error = process.StandardError.ReadToEnd(); } catch { error = null; } }); stderr.IsBackground = true; stderr.Start();
            if (!process.WaitForExit(timeout)) { try { process.Kill(); } catch { } throw new Failure("readonly_query_timeout"); }
            Require(stdout.Join(1000) && stderr.Join(1000), "readonly_query_drain_timeout");
            Require(process.ExitCode == 0 && output != null && output.Length <= 4 * 1024 * 1024 && (error == null || error.Length <= 65536), "readonly_query_failed_exit_" + process.ExitCode + "_stdout_" + (output == null ? "null" : output.Length.ToString()) + "_stderr_" + (error == null ? "null" : error.Length.ToString()));
            return output;
        }
    }
    static object WslSnapshot(string wsl)
    {
        // Includes process names and cwd for impact review. No command lines, environment, or credentials.
        string program = @"import os,json,pathlib
root=pathlib.Path('/proc')
rows=[]
truncated=False
for p in root.iterdir():
 if not p.name.isdigit(): continue
 if len(rows)>=2048:
  truncated=True
  break
 try:
  tail=(p/'stat').read_text().rsplit(')',1)[1].split()
  row={'pid':int(p.name),'ppid':int(tail[1]),'start_ticks':tail[19],'comm':(p/'comm').read_text().strip()}
  try: row['cwd']=os.readlink(str(p/'cwd'))
  except OSError: row['cwd']=None
  rows.append(row)
 except (OSError,ValueError,IndexError): pass
init=(root/'1/stat').read_text().rsplit(')',1)[1].split()[19]
print(json.dumps({'boot_id':(root/'sys/kernel/random/boot_id').read_text().strip(),'init_start_ticks':init,'clock_ticks_per_second':os.sysconf('SC_CLK_TCK'),'process_inventory_complete':not truncated,'processes':sorted(rows,key=lambda x:x['pid'])}))";
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(program));
        return Map(Decode(Query(wsl, new[] { "-d", "Ubuntu", "--exec", "/usr/bin/python3", "-c", "import base64;exec(base64.b64decode('" + encoded + "'))" }, Encoding.UTF8)));
    }
    static int Preflight(string outDir, string nativeRoot, bool confirmed)
    {
        ProductionNativeRoot = Path.GetFullPath(nativeRoot);
        Local(outDir); Require(!Directory.Exists(outDir) && !File.Exists(outDir), "output_must_be_new");
        string wsl = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe");
        string running = Query(wsl, new[] { "--list", "--running", "--quiet" }, Encoding.Unicode).Replace("\0", "");
        bool ubuntuRunning = false;
        foreach (string line in running.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) if (line.Trim() == "Ubuntu") ubuntuRunning = true;
        Require(ubuntuRunning, "ubuntu_not_running_no_implicit_start");
        Directory.CreateDirectory(outDir); string frozen = Path.Combine(outDir, "native"); Directory.CreateDirectory(frozen);
        var binaries = new Dictionary<string, object>();
        foreach (string name in new[] { "InputRecorder.exe", "WinInput.exe", "WinInputWatchdog.exe" })
        {
            string source = Path.Combine(nativeRoot, name), target = Path.Combine(frozen, name); FileInfo info = new FileInfo(source);
            Require(info.Exists && info.Length > 0 && info.Length <= 32 * 1024 * 1024 && (info.Attributes & FileAttributes.ReparsePoint) == 0, "native_binary_invalid");
            File.Copy(source, target, false); binaries[name] = Obj("sha256", Hash(target), "file", "native/" + name);
        }
        string toolPath = Process.GetCurrentProcess().MainModule.FileName;
        File.Copy(toolPath, Path.Combine(frozen, "WslRestartAcceptance.exe"), false);
        string controllerSource = Path.Combine(Path.GetDirectoryName(toolPath), "wsl_restart_controller.ts");
        Require(File.Exists(controllerSource), "controller_source_missing");
        File.Copy(controllerSource, Path.Combine(frozen, "wsl_restart_controller.ts"), false);
        binaries["WslRestartAcceptance.exe"] = Obj("sha256", Hash(Path.Combine(frozen, "WslRestartAcceptance.exe")), "file", "native/WslRestartAcceptance.exe");
        binaries["wsl_restart_controller.ts"] = Obj("sha256", Hash(Path.Combine(frozen, "wsl_restart_controller.ts")), "file", "native/wsl_restart_controller.ts");
        string gateSource = Path.Combine(Path.GetDirectoryName(toolPath), "InputLeaseTestGate.exe"); Require(File.Exists(gateSource), "finite_lease_gate_missing");
        File.Copy(gateSource, Path.Combine(frozen, "InputLeaseTestGate.exe"), false); binaries["InputLeaseTestGate.exe"] = Obj("sha256", Hash(Path.Combine(frozen, "InputLeaseTestGate.exe")), "file", "native/InputLeaseTestGate.exe");
        FreezeClientSource(frozen, binaries);
        long started = Qpc(); object snapshot = WslSnapshot(wsl); long finished = Qpc();
        Save(Path.Combine(outDir, "preflight.json"), Obj("schema_version", 1, "type", "wsl_restart_preflight", "distro", "Ubuntu", "host_pid", Process.GetCurrentProcess().Id,
            "host_start_ticks", Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(), "host_job", HostJob(), "clock", "windows-qpc", "snapshot_started_ms", started, "snapshot_finished_ms", finished,
            "snapshot", snapshot, "binaries", binaries, "repo_wsl", RepoWsl, "production_native_root", ProductionNativeRoot, "primary_root", outDir, "primary_domain", "windows_local", "export_root", ExportRoot, "export_domain", ExportRoot == null ? null : "wsl_unc", "wsl_exe_sha256", Hash(wsl), "tool_sha256", Hash(Process.GetCurrentProcess().MainModule.FileName), "shared_impact_review_required", true,
            "confirm_flag_present", confirmed, "restart_executed", false, "input_events", 0, "recorder_opened", false));
        Save(Path.Combine(outDir, "ready-plan.json"), Obj("schema_version", 1, "status", confirmed ? "prepared_needs_shared_impact_review" : "preflight_only", "distro", "Ubuntu",
            "restart_executed", false, "input_events", 0, "actual_acceptance", false, "explicit_confirmation_required_for_execution", true,
            "planned_restart_arguments", new[] { "--terminate", "Ubuntu" }, "planned_fixture", "new dedicated InputRecorder only; no WoW input", "planned_hold_max_ms", 5000,
            "required_evidence", new[] { "same Windows host survives", "Ubuntu init instance changes", "old controller PID/start/token does not revive", "owned lease held before restart", "lease masks zero and stop requested after restart", "three physical UP samples before original lease deadline", "fresh session/watchdog ready", "no stale resumed input" }));
        PrepareExport(outDir);
        Console.WriteLine(Encode(Obj("type", "preflight_written", "out", outDir, "restart_executed", false, "input_events", 0))); return 0;
    }
    static void VerifyFacts(Dictionary<string, object> facts)
    {
        Require(Boolean(facts, "host_fallback_release_used") == false && Boolean(Map(Need(facts, "native_actors_after_terminate")), "watchdog_alive"), "production_watchdog_survival_unconfirmed");
        Require(Integer(facts, "schema_version") == 1 && Text(facts, "scope") == "actual_ubuntu_distro_restart" && Text(facts, "distro") == "Ubuntu", "actual_ubuntu_restart_scope_required");
        var before = Map(Need(facts, "before")); var after = Map(Need(facts, "after"));
        Require(GuidText(before, "boot_id") != GuidText(after, "boot_id") || Ticks(before, "init_start_ticks") != Ticks(after, "init_start_ticks"), "distro_instance_unchanged");
        Require(Boolean(after, "process_inventory_complete"), "incomplete_after_inventory");
        long oldPid = Integer(before, "controller_pid"); string oldStart = Ticks(before, "controller_start_ticks"); GuidText(before, "controller_token");
        foreach (object row in List(after, "processes"))
        { var process = Map(row); Require(Integer(process, "pid") != oldPid || Ticks(process, "start_ticks") != oldStart, "old_controller_still_alive"); }
        var hostBefore = Map(Need(facts, "host_before")); var hostAfter = Map(Need(facts, "host_after"));
        Require(Boolean(hostBefore, "known") && Boolean(hostAfter, "known") && !Boolean(hostBefore, "in_job") && !Boolean(hostAfter, "in_job"), "host_job_independence_unconfirmed");
        Require(Integer(hostBefore, "pid") == Integer(hostAfter, "pid") && Ticks(hostBefore, "start_ticks") == Ticks(hostAfter, "start_ticks"), "windows_observer_did_not_survive");
        var termination = Map(Need(facts, "termination")); object[] arguments = List(termination, "arguments");
        Require(Text(termination, "executable") == "wsl.exe" && arguments.Length == 2 && Object.Equals(arguments[0], "--terminate") && Object.Equals(arguments[1], "Ubuntu") && Integer(termination, "exit_code") == 0, "actual_distro_termination_required");
        long stopAt = Integer(termination, "started_windows_qpc_ms"); Require(Integer(termination, "finished_windows_qpc_ms") >= stopAt, "termination_clock_invalid");
        var owned = Map(Need(facts, "owned_before")); var released = Map(Need(facts, "released_after"));
        string session = GuidText(owned, "session_id");
        Require(GuidText(released, "session_id") == session && Integer(owned, "held_keys_mask") == (long)KeyCatalog.Get("W").Mask && Integer(owned, "held_mouse_mask") == 0 && Boolean(owned, "watchdog_ready"), "owned_held_lease_required");
        Require(Integer(owned, "observed_windows_qpc_ms") <= stopAt && Integer(owned, "lease_deadline_windows_qpc_ms") > stopAt, "restart_not_while_owned_input_held");
        long releasedAt = Integer(released, "observed_windows_qpc_ms");
        Require(releasedAt >= stopAt && releasedAt < Integer(owned, "lease_deadline_windows_qpc_ms") && Integer(released, "held_keys_mask") == 0 && Integer(released, "held_mouse_mask") == 0 && Boolean(released, "stop_requested"), "interruption_release_unconfirmed");
        Require(Array.IndexOf(new[] { "stdin_eof", "executor_exit", "executor_exited", "controller_heartbeat_expired", "executor_heartbeat_expired", "stdout_failed", "stdout_queue_full", "lease_monitor_failed", "ledger_TimeoutException" }, Text(released, "stop_reason")) >= 0, "restart_release_cause_unconfirmed");
        var fresh = Map(Need(facts, "fresh_ready"));
        Require(Text(fresh, "type") == "ready" && Text(fresh, "protocol") == "wow-input" && Integer(fresh, "version") == 1 && GuidText(fresh, "session_id") != session && Integer(fresh, "watchdog_pid") > 0 && Integer(fresh, "executor_pid") > 0, "fresh_native_session_not_ready");
        var actors = Map(Need(facts, "fresh_actor_identity"));
        Require(Integer(actors, "executor_pid") == Integer(fresh, "executor_pid") && Integer(actors, "watchdog_pid") == Integer(fresh, "watchdog_pid") &&
            Boolean(actors, "watchdog_ready") && Integer(actors, "held_keys_mask") == 0 && Integer(actors, "held_mouse_mask") == 0, "fresh_actor_identity_mismatch");
        Ticks(actors, "executor_start_ticks"); Ticks(actors, "watchdog_start_ticks");
        long pulseStart = Integer(facts, "fresh_pulse_started_windows_qpc_ms"), pulseEnd = Integer(facts, "fresh_pulse_finished_windows_qpc_ms");
        Require(pulseStart > releasedAt && pulseEnd >= pulseStart && pulseEnd - pulseStart <= 5000, "fresh_pulse_clock_invalid");
        Require(AllUp(Map(Need(released, "physical"))), "released_physical_state_not_up");
        var receipt = Map(Need(facts, "fresh_receipt")); var input = Map(Need(receipt, "input"));
        Require(Text(receipt, "protocol") == "wow-input" && Integer(receipt, "version") == 1 && Text(receipt, "type") == "receipt" && Text(receipt, "op") == "execute" && GuidText(receipt, "session_id") == GuidText(fresh, "session_id") && Text(receipt, "id") == "recovery-pulse" && Text(receipt, "status") == "completed" && Integer(input, "events_requested") == 2 && Integer(input, "events_inserted") == 2 && Boolean(input, "released"), "fresh_pulse_not_confirmed");
        Require(Boolean(facts, "old_task_resumed") == false && Integer(facts, "stale_input_events_inserted") == 0, "old_task_resumed_or_inserted_input");
    }
    static string EvidencePath(string root, Dictionary<string, object> source)
    {
        string name = Text(source, "file"); Require(Regex.IsMatch(name, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.jsonl\\z"), "evidence_file_name_invalid");
        string path = Path.Combine(root, name); FileInfo file = new FileInfo(path);
        Require(file.Exists && file.Length > 0 && file.Length <= 16 * 1024 * 1024 && (file.Attributes & FileAttributes.ReparsePoint) == 0 && Hash(path) == Text(source, "sha256"), "evidence_file_hash_mismatch"); return path;
    }
    static void VerifyRecorder(string path, Dictionary<string, object> facts)
    {
        long stopAt = Integer(Map(Need(facts, "termination")), "started_windows_qpc_ms"), releaseAt = Integer(Map(Need(facts, "released_after")), "observed_windows_qpc_ms");
        bool held = false, ownDown = false, ready = false, freshDown = false, oldUpConfirmed = false; int up = 0, freshUp = 0; long previous = -1;
        long pulseStart = Integer(facts, "fresh_pulse_started_windows_qpc_ms"), pulseEnd = Integer(facts, "fresh_pulse_finished_windows_qpc_ms");
        long originalDeadline = Integer(Map(Need(facts, "owned_before")), "lease_deadline_windows_qpc_ms");
        var recorder = Map(Need(facts, "recorder")); long pid = Integer(recorder, "pid"); string hwnd = Text(recorder, "hwnd");
        foreach (string line in File.ReadLines(path))
        {
            Require(line.Length <= 65536, "recorder_line_too_large"); var row = Map(Decode(line)); string type = Text(row, "type");
            if (type == "recorder_ready") { Require(Integer(row, "pid") == pid && Text(row, "hwnd") == hwnd, "recorder_identity_changed"); ready = true; }
            if (type == "recorder_event")
            {
                Require(Text(row, "event") != "mouse_down" && (Text(row, "event") != "key_down" || Text(row, "key") == "W"), "unplanned_input_in_recorder");
                Require(Text(row, "window") == "primary" && Text(row, "hwnd") == hwnd, "input_reached_other_window");
                if (Text(row, "event") == "key_down" && Text(row, "key") == "W")
                {
                    long at = Integer(row, "at_native_ms");
                    if (at <= stopAt) ownDown = true;
                    else if (at >= pulseStart && at <= pulseEnd) freshDown = true;
                    else if (at < releaseAt && row.ContainsKey("repeat") && Boolean(row, "repeat")) { /* OS autorepeat during the still-held fault interval is not a new DOWN. */ }
                    else throw new Failure("unplanned_down_after_restart");
                }
            }
            if (type != "recorder_state" && type != "recorder_status") continue;
            long now = Integer(row, "at_native_ms"); Require(now >= previous && Integer(row, "output_dropped") == 0, "recorder_clock_or_drops_invalid"); previous = now;
            var keys = Map(Need(row, "keys")); var buttons = Map(Need(row, "buttons"));
            if (now <= stopAt && Boolean(keys, "W")) held = true;
            if (now < releaseAt) continue;
            bool any = false; foreach (string key in new[] { "W", "SPACE", "CTRL", "SHIFT", "ALT", "F10" }) if (!(key == "W" && now >= pulseStart && now <= pulseEnd)) any |= Boolean(keys, key);
            foreach (string button in new[] { "left", "right", "middle" }) any |= Boolean(buttons, button);
            Require(!any, "physical_input_still_down_or_resumed");
            if (now < pulseStart && now < originalDeadline) { up++; if (up >= 3) oldUpConfirmed = true; }
            else if (now < pulseStart) up = 0;
            if (now > pulseEnd) freshUp++;
        }
        Require(ready && ownDown && held && oldUpConfirmed && freshDown && freshUp >= 3, "physical_release_samples_insufficient");
        var freshWindow = Map(Need(Map(Need(facts, "fresh_ready")), "window"));
        Require(Integer(freshWindow, "pid") == pid && Text(freshWindow, "hwnd") == hwnd, "fresh_session_not_dedicated_recorder");
    }
    static int Verify(string root)
    {
        Local(root); var facts = Load(Path.Combine(root, "restart-facts.json")); VerifyFacts(facts);
        var recorder = Map(Need(facts, "recorder")); VerifyRecorder(EvidencePath(root, recorder), facts);
        string ledger = EvidencePath(root, Map(Need(facts, "lease_log"))); bool heldPacket = false, releasedPacket = false;
        foreach (string line in File.ReadLines(ledger))
        {
            Require(line.Length <= 65536, "lease_line_too_large"); var packet = Map(Decode(line));
            if (Encode(packet) == Encode(Need(facts, "owned_before"))) heldPacket = true;
            if (Encode(packet) == Encode(Need(facts, "released_after"))) releasedPacket = true;
        }
        Require(heldPacket && releasedPacket, "lease_facts_not_in_raw_log");
        string freshLog = EvidencePath(root, Map(Need(facts, "fresh_native_log"))); bool found = false, foundReceipt = false;
        foreach (string line in File.ReadLines(freshLog))
        {
            Require(line.Length <= 65536, "native_line_too_large"); var row = Map(Decode(line));
            if (row.ContainsKey("type") && Object.Equals(row["type"], "ready") && Encode(row) == Encode(Need(facts, "fresh_ready"))) found = true;
            if (row.ContainsKey("type") && Object.Equals(row["type"], "receipt") && Encode(row) == Encode(Need(facts, "fresh_receipt"))) foundReceipt = true;
            if (row.ContainsKey("input") && Integer(Map(row["input"]), "events_inserted") > 0)
                Require(GuidText(row, "session_id") == GuidText(Map(Need(facts, "fresh_ready")), "session_id") && Text(row, "id") == "recovery-pulse" && Text(row, "status") == "completed" && Integer(Map(row["input"]), "events_inserted") == 2 && Boolean(Map(row["input"]), "released"), "unexpected_fresh_input");
        }
        Require(found && foundReceipt, "fresh_ready_or_terminal_receipt_not_in_raw_log");
        Console.WriteLine(Encode(Obj("type", "restart_evidence_verified", "restart_facts_sha256", Hash(Path.Combine(root, "restart-facts.json")), "scope", SelfTesting ? "synthetic_mock_trace" : "recorded_restart_evidence", "physical_release", SelfTesting ? "validated_from_synthetic_states" : "confirmed_from_three_samples", "live_test_executed_by_this_tool", false))); return 0;
    }
    static Dictionary<string, object> MockFacts()
    {
        string old = "11111111-1111-4111-8111-111111111111", fresh = "22222222-2222-4222-8222-222222222222", boot = "33333333-3333-4333-8333-333333333333";
        return Obj("host_fallback_release_used", false, "native_actors_after_terminate", Obj("watchdog_alive", true), "schema_version", 1, "scope", "actual_ubuntu_distro_restart", "distro", "Ubuntu", "before", Obj("boot_id", boot, "init_start_ticks", "100", "controller_pid", 77, "controller_start_ticks", "101", "controller_token", old),
            "after", Obj("boot_id", boot, "init_start_ticks", "200", "process_inventory_complete", true, "processes", new object[] { Obj("pid", 77, "start_ticks", "201") }),
            "host_before", Obj("pid", 80, "start_ticks", "12345", "known", true, "in_job", false), "host_after", Obj("pid", 80, "start_ticks", "12345", "known", true, "in_job", false),
            "termination", Obj("executable", "wsl.exe", "arguments", new object[] { "--terminate", "Ubuntu" }, "exit_code", 0, "started_windows_qpc_ms", 1500, "finished_windows_qpc_ms", 1700),
            "owned_before", Obj("session_id", old, "held_keys_mask", 4194304, "held_mouse_mask", 0, "watchdog_ready", true, "observed_windows_qpc_ms", 1400, "lease_deadline_windows_qpc_ms", 6000),
            "released_after", Obj("session_id", old, "held_keys_mask", 0, "held_mouse_mask", 0, "stop_requested", true, "stop_reason", "controller_heartbeat_expired", "observed_windows_qpc_ms", 2500, "physical", MockPhysical(false)),
            "fresh_ready", Obj("protocol", "wow-input", "version", 1, "type", "ready", "session_id", fresh, "executor_pid", 800, "watchdog_pid", 801, "window", Obj("pid", 900, "hwnd", "0x123")),
            "fresh_actor_identity", Obj("executor_pid", 800, "watchdog_pid", 801, "executor_start_ticks", "12346", "watchdog_start_ticks", "12347", "watchdog_ready", true, "held_keys_mask", 0, "held_mouse_mask", 0),
            "fresh_pulse_started_windows_qpc_ms", 3000, "fresh_pulse_finished_windows_qpc_ms", 3200,
            "fresh_receipt", Obj("protocol", "wow-input", "version", 1, "type", "receipt", "op", "execute", "session_id", fresh, "id", "recovery-pulse", "status", "completed", "input", Obj("events_requested", 2, "events_inserted", 2, "released", true)),
            "old_task_resumed", false, "stale_input_events_inserted", 0);
    }
    static object MockPhysical(bool down)
    { var keys = new Dictionary<string, object>(); foreach (var key in KeyCatalog.All) keys[key.Name] = key.Name == "W" && down; return Obj("keys", keys, "buttons", Obj("left", false, "right", false, "middle", false)); }
    static object MockState(int at, bool down)
    { return Obj("type", "recorder_state", "at_native_ms", at, "output_dropped", 0, "keys", Obj("W", down, "SPACE", false, "CTRL", false, "SHIFT", false, "ALT", false, "F10", false), "buttons", Obj("left", false, "right", false, "middle", false)); }
    static int SelfTest()
    {
        SelfTesting = true;
        VerifyFacts(MockFacts()); int checkedCases = 1;
        foreach (string failure in new[] { "same-instance", "old-controller", "no-held", "late-release", "still-held", "old-session", "stale-input", "wrong-distro", "different-observer", "incomplete-inventory", "fresh-partial", "fresh-not-released", "wrong-stop-cause", "guardian-killed", "host-fallback", "host-in-job", "host-job-unknown", "receipt-session-mismatch", "released-physical-down" })
        {
            var facts = MockFacts();
            if (failure == "same-instance") Map(facts["after"])["init_start_ticks"] = "100";
            if (failure == "old-controller") Map(facts["after"])["processes"] = new object[] { Obj("pid", 77, "start_ticks", "101") };
            if (failure == "no-held") Map(facts["owned_before"])["held_keys_mask"] = 0;
            if (failure == "late-release") Map(facts["released_after"])["observed_windows_qpc_ms"] = 6001;
            if (failure == "still-held") Map(facts["released_after"])["held_mouse_mask"] = 2;
            if (failure == "old-session") Map(facts["fresh_ready"])["session_id"] = Map(facts["owned_before"])["session_id"];
            if (failure == "stale-input") facts["stale_input_events_inserted"] = 1;
            if (failure == "wrong-distro") facts["distro"] = "Debian";
            if (failure == "different-observer") Map(facts["host_after"])["pid"] = 81;
            if (failure == "incomplete-inventory") Map(facts["after"])["process_inventory_complete"] = false;
            if (failure == "fresh-partial") Map(Map(facts["fresh_receipt"])["input"])["events_inserted"] = 1;
            if (failure == "fresh-not-released") Map(Map(facts["fresh_receipt"])["input"])["released"] = false;
            if (failure == "wrong-stop-cause") Map(facts["released_after"])["stop_reason"] = "shutdown_requested";
            if (failure == "guardian-killed") Map(facts["native_actors_after_terminate"])["watchdog_alive"] = false;
            if (failure == "host-fallback") facts["host_fallback_release_used"] = true;
            if (failure == "host-in-job") Map(facts["host_before"])["in_job"] = true;
            if (failure == "host-job-unknown") Map(facts["host_before"])["known"] = false;
            if (failure == "receipt-session-mismatch") Map(facts["fresh_receipt"])["session_id"] = Map(facts["owned_before"])["session_id"];
            if (failure == "released-physical-down") Map(facts["released_after"])["physical"] = MockPhysical(true);
            bool rejected = false; try { VerifyFacts(facts); } catch (Failure) { rejected = true; }
            Require(rejected, "self_test_expected_rejection_missing"); checkedCases++;
        }
        foreach (string scenario in new[] { "valid", "still-down", "foreign-down", "stale-down", "missing-held", "missing-up", "hash-tamper", "missing-lease-packet", "missing-terminal", "raw-receipt-other-session", "late-up-samples" })
        {
            string root = Path.Combine(Path.GetTempPath(), "WowJevRestartMock-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try
            {
                var facts = MockFacts();
                var rows = new List<object>(); rows.Add(Obj("type", "recorder_ready", "pid", 900, "hwnd", "0x123"));
                rows.Add(Obj("type", "recorder_event", "window", "primary", "hwnd", "0x123", "event", "key_down", "key", "W", "at_native_ms", 1400));
                if (scenario != "missing-held") rows.Add(MockState(1450, true));
                int shift = scenario == "late-up-samples" ? 4000 : 0;
                if (shift > 0) { facts["fresh_pulse_started_windows_qpc_ms"] = 7000; facts["fresh_pulse_finished_windows_qpc_ms"] = 7200; }
                rows.Add(MockState(2600 + shift, scenario == "still-down")); rows.Add(MockState(2700 + shift, false)); rows.Add(MockState(2800 + shift, false));
                rows.Add(Obj("type", "recorder_event", "window", "primary", "hwnd", "0x123", "event", "key_down", "key", "W", "at_native_ms", 3100 + shift));
                rows.Add(MockState(3150 + shift, true)); rows.Add(MockState(3210 + shift, false));
                if (scenario != "missing-up") { rows.Add(MockState(3300 + shift, false)); rows.Add(MockState(3400 + shift, false)); }
                if (scenario == "foreign-down") rows.Add(Obj("type", "recorder_event", "window", "primary", "hwnd", "0x123", "event", "mouse_down", "at_native_ms", 3500));
                if (scenario == "stale-down") rows.Add(Obj("type", "recorder_event", "window", "primary", "hwnd", "0x123", "event", "key_down", "key", "W", "at_native_ms", 3500));
                using (var file = new StreamWriter(Path.Combine(root, "recorder.jsonl"), false, new UTF8Encoding(false))) foreach (object row in rows) file.WriteLine(Encode(row));
                var rawReceipt = Map(Decode(Encode(facts["fresh_receipt"])));
                if (scenario == "raw-receipt-other-session") rawReceipt["session_id"] = Map(facts["owned_before"])["session_id"];
                File.WriteAllText(Path.Combine(root, "fresh-native.jsonl"), Encode(facts["fresh_ready"]) + "\n" + (scenario == "missing-terminal" ? "" : Encode(rawReceipt) + "\n"));
                File.WriteAllText(Path.Combine(root, "lease-old.jsonl"), Encode(facts["owned_before"]) + "\n" + (scenario == "missing-lease-packet" ? "" : Encode(facts["released_after"]) + "\n"));
                facts["recorder"] = Obj("pid", 900, "hwnd", "0x123", "file", "recorder.jsonl", "sha256", Hash(Path.Combine(root, "recorder.jsonl")));
                facts["fresh_native_log"] = Obj("file", "fresh-native.jsonl", "sha256", Hash(Path.Combine(root, "fresh-native.jsonl")));
                facts["lease_log"] = Obj("file", "lease-old.jsonl", "sha256", Hash(Path.Combine(root, "lease-old.jsonl")));
                Save(Path.Combine(root, "restart-facts.json"), facts);
                if (scenario == "hash-tamper") File.AppendAllText(Path.Combine(root, "recorder.jsonl"), "{}\n");
                bool rejected = false; try { Verify(root); } catch (Failure) { rejected = true; }
                Require(rejected == (scenario != "valid"), "mock_physical_trace_result_mismatch"); checkedCases++;
            }
            finally { Directory.Delete(root, true); }
        }
        Console.WriteLine(Encode(Obj("type", "self_test", "passed", checkedCases, "restart_executed", false, "input_events", 0))); return 0;
    }
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if (args.Length == 2 && args[0] == "--verify") return Verify(args[1]);
            string outDir = null, nativeRoot = null, distro = "Ubuntu"; bool confirmed = false, run = false; var seen = new HashSet<string>();
            for (int i = 0; i < args.Length; i++)
            {
                Require(seen.Add(args[i]), "duplicate_option");
                if (args[i] == "--run") { run = true; continue; }
                if (args[i] == "--confirm-distro-restart") { Require(i + 1 < args.Length && args[++i] == "Ubuntu", "explicit_ubuntu_restart_confirmation_required"); confirmed = true; continue; }
                Require(i + 1 < args.Length, "missing_option_value");
                if (args[i] == "--out") outDir = args[++i];
                else if (args[i] == "--native-root") nativeRoot = args[++i];
                else if (args[i] == "--distro") distro = args[++i];
                else if (args[i] == "--export-dir") ExportRoot = args[++i];
                else if (args[i] == "--repo-wsl") RepoWsl = args[++i];
                else throw new Failure("unknown_option");
            }
            Require(distro == "Ubuntu" && outDir != null && nativeRoot != null, "ubuntu_and_paths_required");
            Require(!run || confirmed, "run_requires_explicit_confirmation");
            Require(!run || ExportRoot != null, "actual_run_requires_explicit_export_controller_mapping");
            return run ? RunRestart(outDir, nativeRoot) : Preflight(outDir, nativeRoot, confirmed);
        }
        catch (Failure failure) { Console.WriteLine(Encode(Obj("type", "error", "code", failure.Code, "restart_execution", ActualRunBegan ? "unconfirmed" : "not_started", "input_events", ActualRunBegan ? (object)null : 0))); return 2; }
        catch (Exception error) { Console.WriteLine(Encode(Obj("type", "error", "code", error.GetType().Name, "restart_execution", ActualRunBegan ? "unconfirmed" : "not_started", "input_events", ActualRunBegan ? (object)null : 0))); return 2; }
    }
}
