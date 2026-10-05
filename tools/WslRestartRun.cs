// Actual execution is gated by --run --confirm-distro-restart Ubuntu in the other partial file.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;
using System.Threading;
using WowJev.Input;

static partial class WslRestartAcceptance
{
    sealed class OwnedChild : IDisposable
    {
        public readonly Process Process;
        public readonly long StartTicks;
        readonly Thread stdout, stderr;
        readonly string output;
        public readonly ConcurrentQueue<Dictionary<string, object>> Rows = new ConcurrentQueue<Dictionary<string, object>>();
        public OwnedChild(string executable, string[] arguments, string path)
        {
            output = path; var command = new StringBuilder(); foreach (string arg in arguments) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
            Process = System.Diagnostics.Process.Start(new ProcessStartInfo(executable, command.ToString()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, WorkingDirectory = Path.GetDirectoryName(executable) });
            StartTicks = Process.StartTime.ToUniversalTime().Ticks;
            stdout = new Thread(delegate() { Drain(Process.StandardOutput, output, true); }); stdout.IsBackground = true; stdout.Start();
            stderr = new Thread(delegate() { Drain(Process.StandardError, output + ".stderr", false); }); stderr.IsBackground = true; stderr.Start();
        }
        void Drain(StreamReader reader, string path, bool parse)
        {
            try
            {
                using (var file = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)))
                {
                    file.AutoFlush = true; string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length > 65536) break;
                        file.WriteLine(line);
                        if (parse) try { Rows.Enqueue(Map(Decode(line))); } catch { }
                    }
                }
            }
            catch { }
        }
        public void Send(object value) { Process.StandardInput.WriteLine(Encode(value)); Process.StandardInput.Flush(); }
        public void Join() { stdout.Join(1000); stderr.Join(1000); }
        public void Dispose()
        {
            try { Process.StandardInput.Close(); } catch { }
            try { if (!Process.WaitForExit(1500) && Native.IsProcessAlive(Process.Id, StartTicks)) Process.Kill(); } catch { }
            try { Process.WaitForExit(1000); } catch { }
            Join(); Process.Dispose();
        }
    }
    sealed class ReadonlyLease : IDisposable
    {
        readonly MemoryMappedFile memory;
        readonly MemoryMappedViewAccessor view;
        public readonly string Session;
        public ReadonlyLease(string session)
        {
            Session = session; memory = MemoryMappedFile.OpenExisting("Local\\WowJevInput.Lease." + session, MemoryMappedFileRights.Read);
            view = memory.CreateViewAccessor(0, 256, MemoryMappedFileAccess.Read);
        }
        public Dictionary<string, object> Read()
        {
            Require(view.ReadInt32(0) == 0x57495631 && view.ReadInt32(4) == 1, "invalid_lease_snapshot");
            int length = view.ReadInt32(84); Require(length >= 0 && length <= 128, "invalid_lease_reason");
            byte[] reason = new byte[length]; view.ReadArray(88, reason, 0, length);
            return Obj("session_id", Session, "observed_windows_qpc_ms", Qpc(), "executor_pid", view.ReadInt32(8), "watchdog_pid", view.ReadInt32(12),
                "executor_start_ticks", view.ReadInt64(16).ToString(), "watchdog_start_ticks", view.ReadInt64(24).ToString(), "executor_heartbeat_ms", view.ReadInt64(32),
                "controller_heartbeat_ms", view.ReadInt64(40), "lease_deadline_windows_qpc_ms", view.ReadInt64(48), "watchdog_heartbeat_ms", view.ReadInt64(56),
                "held_keys_mask", checked((long)view.ReadUInt64(64)), "held_mouse_mask", view.ReadInt32(72), "stop_requested", view.ReadInt32(76) != 0,
                "watchdog_ready", view.ReadInt32(80) != 0, "stop_reason", Encoding.UTF8.GetString(reason));
        }
        public void Dispose() { view.Dispose(); memory.Dispose(); }
    }
    sealed class LeaseObserver : IDisposable
    {
        readonly Thread thread;
        readonly ReadonlyLease lease;
        volatile bool stopping;
        public Dictionary<string, object> Last;
        public readonly ConcurrentQueue<Dictionary<string, object>> Released = new ConcurrentQueue<Dictionary<string, object>>();
        public LeaseObserver(ReadonlyLease source, string path)
        {
            lease = source;
            thread = new Thread(delegate()
            {
                try
                {
                    using (var file = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)))
                    {
                        file.AutoFlush = true;
                        while (!stopping)
                        {
                            var state = lease.Read(); var physical = Physical(); state["physical"] = physical;
                            state["executor_alive"] = Native.IsProcessAlive((int)Integer(state, "executor_pid"), Convert.ToInt64(Ticks(state, "executor_start_ticks")));
                            state["watchdog_alive"] = Native.IsProcessAlive((int)Integer(state, "watchdog_pid"), Convert.ToInt64(Ticks(state, "watchdog_start_ticks")));
                            Interlocked.Exchange(ref Last, state); file.WriteLine(Encode(state));
                            if (Boolean(state, "stop_requested") && Integer(state, "held_keys_mask") == 0 && Integer(state, "held_mouse_mask") == 0 && AllUp(physical)) Released.Enqueue(state);
                            Thread.Sleep(20);
                        }
                    }
                }
                catch { }
            }); thread.IsBackground = true; thread.Start();
        }
        public void Dispose() { stopping = true; thread.Join(1000); }
    }
    static Dictionary<string, object> Physical()
    {
        var keys = new Dictionary<string, object>(); foreach (KeySpec key in KeyCatalog.All) keys[key.Name] = Native.IsKeyDown(key);
        return Obj("keys", keys, "buttons", Obj("left", Native.IsMouseDown(1), "right", Native.IsMouseDown(2), "middle", Native.IsMouseDown(4)));
    }
    static bool AllUp(Dictionary<string, object> physical)
    {
        foreach (object value in Map(physical["keys"]).Values) if (!(value is bool) || (bool)value) return false;
        foreach (object value in Map(physical["buttons"]).Values) if (!(value is bool) || (bool)value) return false;
        return true;
    }
    static void WaitUntil(Func<bool> condition, int maximumMs, string failure)
    { long deadline = Qpc() + BoundedTimeout(maximumMs); while (Qpc() < deadline) { if (condition()) return; Thread.Sleep(20); } throw new Failure(failure); }
    static Dictionary<string, object> WaitFile(string path, int maximumMs)
    { WaitUntil(delegate() { return File.Exists(path); }, maximumMs, "controller_file_timeout"); return Load(path); }
    static void Marker(string path) { using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { file.WriteByte(1); file.Flush(true); } }
    static void CheckRecorder(OwnedChild recorder, IntPtr hwnd)
    {
        Require(Native.IsProcessAlive(recorder.Process.Id, recorder.StartTicks), "dedicated_recorder_exited");
        WindowInfo info = Native.GetWindow(hwnd); Require(info.Pid == recorder.Process.Id && info.Focused, "dedicated_recorder_not_foreground");
        Require(String.Equals(recorder.Process.ProcessName, "InputRecorder", StringComparison.OrdinalIgnoreCase), "target_not_dedicated_recorder");
    }
    static OwnedChild Controller(string wsl, string root, string mode, string session, string token, string hwnd, int recorderPid)
    {
        VerifyClientSource(root);
        var config = Obj("mode", mode, "token", token, "session_id", session, "hwnd", hwnd, "pid", recorderPid, "native_wsl", UncLinux(ProductionNativeRoot),
            "native_windows", ProductionNativeRoot, "out_wsl", UncLinux(Path.Combine(ExportRoot, "controller")), "repo_wsl", RepoWsl, "schema_wsl", UncLinux(Path.Combine(ExportRoot, "native", "native-input-v1.schema.json")));
        string configPath = Path.Combine(root, mode + "-config.json"); Save(configPath, config);
        string exportedConfig = Path.Combine(ExportRoot, "controller", mode + "-config.json"); CopyVerified(configPath, exportedConfig);
        return new OwnedChild(wsl, new[] { "-d", "Ubuntu", "--exec", RepoWsl + "/agent/node_modules/.bin/tsx", UncLinux(Path.Combine(ExportRoot, "native", "wsl_restart_controller.ts")), UncLinux(exportedConfig) }, Path.Combine(root, mode + "-controller.stdout"));
    }
    static int RunRestart(string root, string nativeRoot)
    {
        // Running off UNC would make the observer depend on the distro being terminated.
        Local(Process.GetCurrentProcess().MainModule.FileName); Native.MakeDpiAware();
        Preflight(root, nativeRoot, true);
        Directory.CreateDirectory(Path.Combine(ExportRoot, "controller"));
        string wsl = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe");
        string oldSession = Guid.NewGuid().ToString("D"), freshSession = Guid.NewGuid().ToString("D"), oldToken = Guid.NewGuid().ToString("D"), freshToken = Guid.NewGuid().ToString("D");
        var host = Obj("pid", Process.GetCurrentProcess().Id, "start_ticks", Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString());
        var facts = Obj("schema_version", 1, "scope", "actual_ubuntu_distro_restart", "distro", "Ubuntu", "host_before", host);
        OwnedChild recorder = null, oldController = null, freshController = null, leaseGate = null; ReadonlyLease lease = null; LeaseObserver observer = null;
        bool restartDispatched = false, accepted = false, fallbackUsed = false; string failure = null; long begin = Qpc(); RunDeadlineMs = begin + 90000; ActualRunBegan = true;
        IntPtr hwnd = IntPtr.Zero; string window = null; string exchange = Path.Combine(ExportRoot, "controller");
        Process guardProcess = null;
        try
        {
            Require(AllUp(Physical()), "physical_input_initially_down");
            recorder = new OwnedChild(Path.Combine(root, "native", "InputRecorder.exe"), new[] { "--keep-open", "--state-interval-ms", "20" }, Path.Combine(root, "recorder.jsonl"));
            Dictionary<string, object> ready = null;
            WaitUntil(delegate() { Dictionary<string, object> row; while (recorder.Rows.TryDequeue(out row)) if (Object.Equals(row["type"], "recorder_ready")) ready = row; return ready != null; }, 5000, "dedicated_recorder_ready_timeout");
            window = Text(ready, "hwnd"); hwnd = new IntPtr(Convert.ToInt64(window.Substring(2), 16)); CheckRecorder(recorder, hwnd);
            Require(Integer(ready, "pid") == recorder.Process.Id && AllUp(Physical()), "dedicated_recorder_binding_or_physical_state_invalid");
            oldController = Controller(wsl, root, "old", oldSession, oldToken, window, recorder.Process.Id);
            var before = WaitFile(Path.Combine(exchange, "old-controller.json"), 8000); facts["before"] = Obj("boot_id", Text(before, "boot_id"), "init_start_ticks", Ticks(before, "init_start_ticks"), "controller_pid", Integer(before, "pid"), "controller_start_ticks", Ticks(before, "start_ticks"), "controller_token", GuidText(before, "token"));
            var oldReady = WaitFile(Path.Combine(exchange, "old-ready.json"), 5000);
            Require(GuidText(oldReady, "session_id") == oldSession && Integer(Map(Need(oldReady, "window")), "pid") == recorder.Process.Id, "old_session_binding_mismatch");
            lease = new ReadonlyLease(oldSession); observer = new LeaseObserver(lease, Path.Combine(root, "lease-old.jsonl"));
            CheckRecorder(recorder, hwnd); Require(AllUp(Physical()), "physical_input_down_before_hold"); Marker(Path.Combine(exchange, "go-old"));
            Dictionary<string, object> owned = null;
            WaitUntil(delegate()
            {
                var state = observer.Last;
                if (state == null || Integer(state, "held_keys_mask") != (long)KeyCatalog.Get("W").Mask || !Native.IsKeyDown(KeyCatalog.Get("W"))) return false;
                owned = state; return true;
            }, 3000, "owned_input_never_held");
            CheckRecorder(recorder, hwnd);
            Require(Boolean(owned, "watchdog_ready") && Native.IsProcessAlive((int)Integer(owned, "watchdog_pid"), Convert.ToInt64(Ticks(owned, "watchdog_start_ticks"))) &&
                Native.IsProcessAlive((int)Integer(owned, "executor_pid"), Convert.ToInt64(Ticks(owned, "executor_start_ticks"))), "native_actors_not_ready");
            facts["owned_before"] = owned; guardProcess = Process.GetProcessById((int)Integer(owned, "watchdog_pid"));
            ControllerEvidence(root, "old", true);
            leaseGate = new OwnedChild(Path.Combine(root, "native", "InputLeaseTestGate.exe"), new[] { oldSession }, Path.Combine(root, "lease-gate.jsonl"));
            bool locked = false;
            WaitUntil(delegate() { Dictionary<string, object> row; while (leaseGate.Rows.TryDequeue(out row)) if (Object.Equals(row["type"], "gate_locked")) locked = true; return locked; }, 1000, "finite_lease_gate_not_locked");
            facts["finite_lease_gate"] = Obj("pid", leaseGate.Process.Id, "start_ticks", leaseGate.StartTicks.ToString(), "maximum_lock_ms", 1500, "session_id", oldSession);
            long stopAt = Qpc(); Require(stopAt - Integer(owned, "observed_windows_qpc_ms") <= 250 && Integer(owned, "lease_deadline_windows_qpc_ms") - stopAt >= 1500, "held_lease_not_fresh_enough_for_restart");
            restartDispatched = true;
            Query(wsl, new[] { "--terminate", "Ubuntu" }, Encoding.UTF8);
            facts["termination"] = Obj("executable", "wsl.exe", "arguments", new[] { "--terminate", "Ubuntu" }, "exit_code", 0, "started_windows_qpc_ms", stopAt, "finished_windows_qpc_ms", Qpc());
            facts["native_actors_after_terminate"] = Obj("watchdog_alive", Native.IsProcessAlive((int)Integer(owned, "watchdog_pid"), Convert.ToInt64(Ticks(owned, "watchdog_start_ticks"))), "executor_alive", Native.IsProcessAlive((int)Integer(owned, "executor_pid"), Convert.ToInt64(Ticks(owned, "executor_start_ticks"))), "observed_windows_qpc_ms", Qpc());
            Dictionary<string, object> released = null;
            WaitUntil(delegate() { Dictionary<string, object> row; while (observer.Released.TryDequeue(out row)) if (Integer(row, "observed_windows_qpc_ms") >= stopAt && Integer(row, "observed_windows_qpc_ms") < Integer(owned, "lease_deadline_windows_qpc_ms")) { released = row; return true; } return false; }, 5000, "interruption_release_unconfirmed");
            facts["released_after"] = released; facts["host_fallback_release_used"] = false;
            // Guard disappearance cannot be replaced by host success. Keep this conservative until diagnostic proof exists.
            Require(Boolean(Map(facts["native_actors_after_terminate"]), "watchdog_alive"), "production_watchdog_survival_unconfirmed");
            WaitUntil(delegate() { return oldController.Process.HasExited; }, 5000, "old_wsl_controller_not_exited"); oldController.Join();
            // Starting this new bounded controller restarts only Ubuntu, after release is observed.
            Query(wsl, new[] { "-d", "Ubuntu", "--exec", "/usr/bin/true" }, Encoding.UTF8);
            ControllerEvidence(root, "old", false);
            freshController = Controller(wsl, root, "fresh", freshSession, freshToken, window, recorder.Process.Id);
            var freshIdentity = WaitFile(Path.Combine(exchange, "fresh-controller.json"), 10000);
            var freshReady = WaitFile(Path.Combine(exchange, "fresh-ready.json"), 5000); facts["fresh_ready"] = freshReady;
            facts["after"] = WslSnapshot(wsl);
            using (var freshLease = new ReadonlyLease(freshSession))
            {
                var actors = freshLease.Read();
                Require(Boolean(actors, "watchdog_ready") && Integer(actors, "held_keys_mask") == 0 && Integer(actors, "held_mouse_mask") == 0 &&
                    Native.IsProcessAlive((int)Integer(actors, "executor_pid"), Convert.ToInt64(Ticks(actors, "executor_start_ticks"))) &&
                    Native.IsProcessAlive((int)Integer(actors, "watchdog_pid"), Convert.ToInt64(Ticks(actors, "watchdog_start_ticks"))), "fresh_actor_identity_not_ready");
                Save(Path.Combine(root, "fresh-lease-ready.json"), actors); facts["fresh_actor_identity"] = actors;
            }
            Require(Text(freshIdentity, "token") == freshToken, "fresh_controller_token_mismatch");
            // Replay the old token explicitly: tombstone must reject before any native executor starts.
            using (var replay = new OwnedChild(wsl, new[] { "-d", "Ubuntu", "--exec", RepoWsl + "/agent/node_modules/.bin/tsx", UncLinux(Path.Combine(ExportRoot, "native", "wsl_restart_controller.ts")), UncLinux(Path.Combine(exchange, "old-config.json")) }, Path.Combine(root, "old-token-replay.stdout")))
            { Require(replay.Process.WaitForExit(BoundedTimeout(5000)) && replay.Process.ExitCode == 3, "old_controller_token_replay_not_rejected"); replay.Join(); }
            facts["old_task_resumed"] = false; facts["stale_input_events_inserted"] = 0;
            CheckRecorder(recorder, hwnd); Require(AllUp(Physical()), "physical_input_down_before_recovery_pulse");
            facts["fresh_pulse_started_windows_qpc_ms"] = Qpc(); Marker(Path.Combine(exchange, "go-fresh"));
            var receipt = WaitFile(Path.Combine(exchange, "fresh-receipt.json"), 5000); facts["fresh_pulse_finished_windows_qpc_ms"] = Qpc();
            Require(Text(receipt, "status") == "completed" && Integer(Map(Need(receipt, "input")), "events_requested") == 2 && Integer(Map(Need(receipt, "input")), "events_inserted") == 2 && Boolean(Map(Need(receipt, "input")), "released"), "fresh_input_not_completed_and_released");
            facts["fresh_receipt"] = receipt;
            int up = 0; WaitUntil(delegate() { up = AllUp(Physical()) ? up + 1 : 0; return up >= 3; }, 2000, "fresh_physical_release_unconfirmed"); Thread.Sleep(150);
            facts["host_after"] = Obj("pid", Process.GetCurrentProcess().Id, "start_ticks", Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString());
            recorder.Send(Obj("type", "recorder_control", "op", "close", "id", "acceptance-close"));
            Require(recorder.Process.WaitForExit(BoundedTimeout(3000)), "dedicated_recorder_close_timeout"); recorder.Join();
            facts["recorder"] = Obj("pid", recorder.Process.Id, "hwnd", window, "start_ticks", recorder.StartTicks.ToString(), "file", "recorder.jsonl", "sha256", Hash(Path.Combine(root, "recorder.jsonl")));
            Require(freshController.Process.WaitForExit(BoundedTimeout(5000)) && freshController.Process.ExitCode == 0, "fresh_controller_not_complete"); freshController.Join();
            ControllerEvidence(root, "fresh", false);
            facts["fresh_native_log"] = Obj("file", "fresh-native.jsonl", "sha256", Hash(Path.Combine(root, "fresh-native.jsonl")));
            Require(Qpc() - begin <= 90000, "overall_restart_acceptance_deadline");
            observer.Dispose(); observer = null; facts["lease_log"] = Obj("file", "lease-old.jsonl", "sha256", Hash(Path.Combine(root, "lease-old.jsonl")));
            Save(Path.Combine(root, "restart-facts.json"), facts); VerifyFacts(facts); VerifyRecorder(Path.Combine(root, "recorder.jsonl"), facts); Verify(root); accepted = true;
        }
        catch (Failure error) { failure = error.Code; }
        catch (Exception error) { failure = error.GetType().Name; }
        finally
        {
            // Never stop another process. On failure, cleanup UPs apply only to this UUID's owned mask.
            if (!accepted && lease != null)
            {
                try
                {
                    var state = lease.Read();
                    if (Integer(state, "held_keys_mask") != 0 || Integer(state, "held_mouse_mask") != 0)
                        using (var own = new LeaseStore(oldSession, false)) { own.ReleaseOwned("acceptance_cleanup"); fallbackUsed = true; }
                    if (facts.ContainsKey("owned_before") && !facts.ContainsKey("released_after") && Native.IsKeyDown(KeyCatalog.Get("W")))
                    { Native.ReleaseOwned(new LeaseSnapshot { HeldKeysMask = KeyCatalog.Get("W").Mask }); fallbackUsed = true; }
                }
                catch { }
            }
            if (guardProcess != null) { try { facts["watchdog_exit"] = Obj("exited", guardProcess.HasExited, "exit_code", guardProcess.HasExited ? (object)guardProcess.ExitCode : null); } catch { } guardProcess.Dispose(); }
            facts["host_fallback_release_used"] = fallbackUsed;
            if (observer != null) observer.Dispose(); if (lease != null) lease.Dispose();
            if (leaseGate != null) leaseGate.Dispose(); if (freshController != null) freshController.Dispose(); if (oldController != null) oldController.Dispose();
            if (recorder != null)
            {
                try { if (!recorder.Process.HasExited) recorder.Send(Obj("type", "recorder_control", "op", "close", "id", "cleanup-close")); } catch { }
                recorder.Dispose();
            }
            if (!File.Exists(Path.Combine(root, "restart-facts.json"))) Save(Path.Combine(root, "restart-facts.partial.json"), facts);
            Save(Path.Combine(root, "restart-summary.json"), Obj("schema_version", 1, "scope", "actual_ubuntu_distro_restart", "accepted", accepted, "release", accepted ? "confirmed" : "unconfirmed",
                "restart_dispatched", restartDispatched, "host_fallback_release_used", fallbackUsed, "native_actor_survival", facts.ContainsKey("native_actors_after_terminate") ? facts["native_actors_after_terminate"] : null, "failure", failure, "window", window, "old_session_id", oldSession, "fresh_session_id", freshSession, "duration_windows_qpc_ms", Qpc() - begin,
                "input_counts", accepted ? "old hold observed; old terminal counts may be unavailable; fresh pulse exactly 2" : "unknown; inspect raw native and recorder logs", "game_inputs", 0));
        }
        RunDeadlineMs = 0;
        try { if (restartDispatched) { Query(wsl, new[] { "-d", "Ubuntu", "--exec", "/usr/bin/true" }, Encoding.UTF8); Save(Path.Combine(root, "recovery-snapshot.json"), WslSnapshot(wsl)); } Export(root, "final"); } catch (Exception error) { Console.WriteLine(Encode(Obj("type", "export_unconfirmed", "error_type", error.GetType().Name, "primary_root", root))); accepted = false; }
        Console.WriteLine(Encode(Obj("type", "restart_acceptance_finished", "accepted", accepted, "out", root, "restart_dispatched", restartDispatched, "game_inputs", 0, "failure", failure)));
        return accepted ? 0 : 2;
    }
}
