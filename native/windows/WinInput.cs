// Windows-local input executor. No game-effect confirmation. C# 5 / .NET Framework 4.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using WowJev.Input;

static class WinInput
{
    const int MaxRecords = 1024;
    const int HeartbeatLeaseMs = 1000;
    const int MaxDurationMs = 5000;
    static readonly Regex IdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant);

    sealed class InputFailure : Exception
    {
        public readonly string Code;
        public InputFailure(string code, string message) : base(message) { Code = code; }
    }
    sealed class Command
    {
        public string Id, Op, Fingerprint;
        public Dictionary<string, object> Action;
    }
    sealed class Record
    {
        public string Fingerprint;
        public Dictionary<string, object> Reply;
    }
    sealed class TimelineEvent
    {
        public string Kind;
        public int At, Button, X, Y, Dx, Dy;
        public KeySpec Key;
    }
    sealed class Work
    {
        public Command Command;
        public string Kind, Mode;
        public KeySpec[] Keys;
        public TimelineEvent[] Events;
        public long TimelineStart;
        public int Duration, Button, X, Y, Dx, Dy, Delta, FromX, FromY, ToX, ToY;
        public long StartedMs = -1;
        public double FirstSendStartedMs = -1, FirstSendFinishedMs = -1, LastSendFinishedMs = -1;
        public long Requested, Inserted;
        public bool OwnedEver;
        public bool ReleaseAccounted;
        public volatile bool FocusClickStarted;
        public volatile bool FocusObserved;
        public bool TimelineMousePointSet, TimelineMouseDownIssued;
        public int TimelineMouseX, TimelineMouseY;
        public long FocusActivationDeadlineMs;
        public readonly object ReleaseSync = new object();
        public readonly ManualResetEvent Cancel = new ManualResetEvent(false);
        public string CancelReason = "cancel_requested";
        public Thread Thread;
    }
    sealed class Server : IDisposable
    {
        readonly string session;
        readonly IntPtr hwnd;
        readonly int expectedPid;
        readonly long targetStartTicks;
        readonly LeaseStore store;
        readonly Process watchdog;
        readonly object stateLock = new object();
        readonly Dictionary<string, Record> records = new Dictionary<string, Record>(StringComparer.Ordinal);
        readonly BlockingCollection<string> output = new BlockingCollection<string>(4096);
        readonly Thread outputThread;
        Thread monitorThread;
        Work active;
        volatile bool ending;
        volatile bool stopped;
        string stopReason = "";
        readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

        public Server(string sessionId, IntPtr window, int pid, string watchdogPath)
        {
            session = sessionId; hwnd = window; expectedPid = pid;
            WindowInfo info = Native.GetWindow(hwnd);
            if (info.Pid != expectedPid) throw new InputFailure("window_pid_mismatch", "Window PID does not match expected PID");
            targetStartTicks = Native.GetProcessStartTicks(expectedPid);
            store = new LeaseStore(session, true);
            int executorPid = Process.GetCurrentProcess().Id;
            long now = Clock.NowMs;
            store.Write(new LeaseSnapshot { ExecutorPid = executorPid, ExecutorStartTimeTicks = Native.GetProcessStartTicks(executorPid),
                ExecutorHeartbeatMs = now, ControllerHeartbeatMs = now });
            outputThread = new Thread(DrainOutput); outputThread.IsBackground = true; outputThread.Start();
            ProcessStartInfo start = new ProcessStartInfo(Path.GetFullPath(watchdogPath),
                "serve --session " + session + " --executor-pid " + executorPid.ToString(CultureInfo.InvariantCulture));
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            watchdog = Process.Start(start);
            Thread guardOut = new Thread(delegate() { Drain(watchdog.StandardOutput); }); guardOut.IsBackground = true; guardOut.Start();
            Thread guardErr = new Thread(delegate() { Drain(watchdog.StandardError); }); guardErr.IsBackground = true; guardErr.Start();
            long deadline = Clock.NowMs + 3000;
            while (Clock.NowMs < deadline)
            {
                store.WithLock(delegate(LeaseSnapshot value) { value.ExecutorHeartbeatMs = Clock.NowMs; value.ControllerHeartbeatMs = Clock.NowMs; });
                LeaseSnapshot state = store.Read();
                if (state.StopRequested) throw new InputFailure("watchdog_unavailable", state.StopReason);
                if (state.WatchdogReady && state.WatchdogPid == watchdog.Id &&
                    Native.IsProcessAlive(state.WatchdogPid, state.WatchdogStartTimeTicks) && Clock.NowMs - state.WatchdogHeartbeatMs <= HeartbeatLeaseMs)
                {
                    monitorThread = new Thread(Monitor); monitorThread.IsBackground = true; monitorThread.Start();
                    EmitReady(info, state.WatchdogPid);
                    return;
                }
                if (watchdog.HasExited) throw new InputFailure("watchdog_unavailable", "Watchdog exited before becoming ready");
                Thread.Sleep(20);
            }
            throw new InputFailure("watchdog_unavailable", "Watchdog did not become ready within 3000ms");
        }
        static void Drain(StreamReader reader)
        { try { while (reader.ReadLine() != null) { } } catch { } }
        void DrainOutput()
        {
            try
            {
                foreach (string line in output.GetConsumingEnumerable()) { Console.WriteLine(line); Console.Out.Flush(); }
            }
            catch { RequestStop("stdout_failed"); }
        }
        void Emit(Dictionary<string, object> value)
        {
            string line;
            lock (serializer) line = serializer.Serialize(value);
            if (!output.TryAdd(line)) RequestStop("stdout_queue_full");
        }
        Dictionary<string, object> Base(string type)
        { return Obj("protocol", "wow-input", "version", 1, "type", type, "session_id", session,
            "local_clock", Obj("domain", "windows-qpc", "at_ms", Clock.NowMs)); }
        void EmitReady(WindowInfo info, int watchdogPid)
        {
            string[] names = new string[KeyCatalog.All.Length];
            for (int i = 0; i < names.Length; i++) names[i] = KeyCatalog.All[i].Name;
            Dictionary<string, object> ready = Base("ready");
            ready.Add("executor_pid", Process.GetCurrentProcess().Id); ready.Add("watchdog_pid", watchdogPid);
            ready.Add("window", Obj("hwnd", "0x" + hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture), "pid", info.Pid,
                "client_width", info.Width, "client_height", info.Height, "focused", info.Focused));
            ready.Add("capabilities", Obj("keys", names, "max_duration_ms", MaxDurationMs, "heartbeat_lease_ms", HeartbeatLeaseMs, "timeline", true, "focus_click", true));
            Emit(ready);
        }
        Dictionary<string, object> Reply(Command command, string status, string inputStatus, long requested, long inserted,
            bool released, long startedMs, long finishedMs, string reason, string message)
        {
            Dictionary<string, object> reply = Base("receipt");
            reply.Add("id", command.Id); reply.Add("op", command.Op); reply.Add("status", status);
            reply.Add("input", Obj("status", inputStatus, "events_requested", requested, "events_inserted", inserted, "released", released));
            reply.Add("effect", Obj("status", "unknown"));
            reply.Add("timing", Obj("clock", "windows_qpc", "started_ms", startedMs < 0 ? null : (object)startedMs,
                "finished_ms", finishedMs < 0 ? null : (object)finishedMs));
            if (reason != null) reply.Add("reason", Reason(reason, message));
            return reply;
        }
        void SendReply(Command command, Dictionary<string, object> reply)
        {
            lock (stateLock)
            {
                Record record;
                if (records.TryGetValue(command.Id, out record) && record.Fingerprint == command.Fingerprint) record.Reply = reply;
            }
            Emit(reply);
        }
        void Error(string code, string message)
        { Dictionary<string, object> value = Base("error"); value.Add("reason", Reason(code, message)); Emit(value); }

        void Monitor()
        {
            while (!ending)
            {
                try
                {
                    LeaseSnapshot state = store.Read();
                    long now = Clock.NowMs;
                    string reason = state.StopRequested ? (state.StopReason.Length == 0 ? "stop_requested" : state.StopReason) : null;
                    if (reason == null && (!state.WatchdogReady || !Native.IsProcessAlive(state.WatchdogPid, state.WatchdogStartTimeTicks))) reason = "watchdog_unavailable";
                    if (reason == null && (state.WatchdogHeartbeatMs > now || now - state.WatchdogHeartbeatMs > HeartbeatLeaseMs)) reason = "watchdog_heartbeat_expired";
                    if (reason == null && (state.ControllerHeartbeatMs > now || now - state.ControllerHeartbeatMs > HeartbeatLeaseMs)) reason = "controller_heartbeat_expired";
                    if (reason == null && !Native.IsProcessAlive(expectedPid, targetStartTicks)) reason = "window_process_exited";
                    Work current;
                    lock (stateLock) current = active;
                    if (reason == null && current != null)
                    {
                        WindowInfo info = Native.GetWindow(hwnd);
                        if (info.Pid != expectedPid) reason = "window_pid_mismatch";
                        else if (!info.Focused && current.Kind != "focus_click") reason = "window_unfocused";
                        else if (!info.Focused && current.Kind == "focus_click" && (current.FocusObserved ||
                            current.FocusClickStarted && Clock.NowMs >= Interlocked.Read(ref current.FocusActivationDeadlineMs))) reason = "focus_recovery_failed";
                        else if (info.Focused && current.Kind == "focus_click" && current.FocusClickStarted) current.FocusObserved = true;
                    }
                    if (reason != null)
                    {
                        RequestStop(reason);
                        ReleaseUntilSafe(current);
                        Error("session_stopped", reason);
                        WaitOutput(150);
                        Environment.Exit(3);
                        return;
                    }
                    store.WithLock(delegate(LeaseSnapshot value) { if (!value.StopRequested) value.ExecutorHeartbeatMs = Clock.NowMs; });
                }
                catch (Exception error)
                {
                    RequestStop("lease_monitor_failed");
                    Work current; lock (stateLock) current = active;
                    ReleaseUntilSafe(current);
                    Error("session_stopped", error.Message); WaitOutput(150); Environment.Exit(3); return;
                }
                Thread.Sleep(20);
            }
        }
        void RequestStop(string reason)
        {
            stopped = true; stopReason = reason;
            lock (stateLock) if (active != null) { active.CancelReason = reason; active.Cancel.Set(); }
            try { store.WithLock(delegate(LeaseSnapshot state) { state.StopRequested = true; state.StopReason = reason; }); }
            catch { }
        }
        void CheckSafe(Work work, LeaseSnapshot state)
        {
            if (work.Cancel.WaitOne(0)) throw new InputFailure(work.CancelReason, "Action cancelled");
            if (stopped || ending || state.StopRequested) throw new InputFailure(state.StopReason.Length > 0 ? state.StopReason : stopReason, "Session stopped");
            long now = Clock.NowMs;
            if (!state.WatchdogReady || state.WatchdogPid != watchdog.Id || !Native.IsProcessAlive(state.WatchdogPid, state.WatchdogStartTimeTicks) ||
                state.WatchdogHeartbeatMs > now || now - state.WatchdogHeartbeatMs > HeartbeatLeaseMs) throw new InputFailure("watchdog_unavailable", "Independent watchdog is not ready");
            if (state.ControllerHeartbeatMs > now || now - state.ControllerHeartbeatMs > HeartbeatLeaseMs) throw new InputFailure("controller_heartbeat_expired", "Controller heartbeat expired");
            if (!Native.IsProcessAlive(expectedPid, targetStartTicks)) throw new InputFailure("window_process_exited", "Target process identity changed");
            WindowInfo info = Native.GetWindow(hwnd);
            if (info.Pid != expectedPid) throw new InputFailure("window_pid_mismatch", "Window process identity changed");
            if (work.Kind == "focus_click")
            {
                if (work.FocusClickStarted)
                {
                    if (info.Focused) work.FocusObserved = true;
                    else if (work.FocusObserved || Clock.NowMs >= Interlocked.Read(ref work.FocusActivationDeadlineMs))
                        throw new InputFailure("focus_recovery_failed", "Focus did not activate promptly or was lost after activation");
                }
                Dictionary<string, object> safety = Native.GetRecoverySafety(hwnd);
                if (!safety.ContainsKey("pid") || Convert.ToInt64(safety["pid"], CultureInfo.InvariantCulture) != expectedPid ||
                    !safety.ContainsKey("process_start_ticks") || Convert.ToInt64(safety["process_start_ticks"], CultureInfo.InvariantCulture) != targetStartTicks)
                    throw new InputFailure("window_identity_unknown", "Focus recovery target identity was not confirmed");
                string reason = (string)safety["reason"];
                // Our first SendInput updates this session's last-input timestamp.
                // Afterwards visibility is still required; idle alone is not reused
                // as a human-input classifier and is checked only before this batch.
                if (!(bool)safety["allowed"] && !(work.FocusClickStarted && reason == "user_recent_input"))
                    throw new InputFailure(reason, "Focus recovery safety checks failed");
                if (!Native.RecoveryPointOwnedByWindow(hwnd, work.X, work.Y))
                    throw new InputFailure("recovery_point_not_target", "Focus recovery point is not owned by target window");
                if (!work.FocusClickStarted)
                {
                    using (Process process = Process.GetProcessById(expectedPid))
                        if (!String.Equals(process.ProcessName, "Wow", StringComparison.OrdinalIgnoreCase))
                            throw new InputFailure("focus_recovery_target_unsupported", "Focus recovery is limited to retail Wow.exe");
                    if (Native.IsMouseDown(1) || Native.IsMouseDown(2) || Native.IsMouseDown(4))
                        throw new InputFailure("user_button_held", "A mouse button is already held; no recovery input issued");
                }
            }
            else
            {
                if (!info.Focused) throw new InputFailure("window_unfocused", "Target window is not foreground");
                // A non-activating topmost overlay can appear after observation
                // without changing foreground. Recheck the actual click point
                // before movement, ledger registration and the DOWN batch.
                if (work.Kind == "mouse_click" && !Native.RecoveryPointOwnedByWindow(hwnd, work.X, work.Y))
                    throw new InputFailure("click_point_not_target", "Click point is no longer owned by the target window");
                if (work.Kind == "timeline" && work.TimelineMouseDownIssued)
                {
                    if (work.TimelineMousePointSet && !Native.RecoveryPointOwnedByWindow(hwnd, work.TimelineMouseX, work.TimelineMouseY))
                        throw new InputFailure("timeline_point_not_target", "Timeline mouse origin no longer belongs to target");
                    // Own RMB may hide the cursor or establish capture. During
                    // the hold only ownership/focus is checked, never treating
                    // our registered button as new human input.
                    if (!TimelineCursorSafety.CurrentPointOwned(hwnd))
                        throw new InputFailure("timeline_cursor_not_target", "Current cursor point no longer belongs to target");
                }
            }
        }
        void StartTimestamp(Work work)
        { if (work.StartedMs < 0) work.StartedMs = Clock.NowMs; }
        void SendEvents(Work work, Native.InputPacket[] packets)
        {
            Interlocked.Add(ref work.Requested, packets.Length);
            double sendStarted = Clock.PreciseMs;
            int inserted = Native.Send(packets); Interlocked.Add(ref work.Inserted, inserted);
            double sendFinished = Clock.PreciseMs;
            if (inserted > 0)
            {
                if (work.FirstSendStartedMs < 0) { work.FirstSendStartedMs = sendStarted; work.FirstSendFinishedMs = sendFinished; }
                work.LastSendFinishedMs = sendFinished;
            }
            if (inserted != packets.Length) throw new InputFailure("sendinput_partial", "Input was not fully inserted; Win32 error " + Native.LastError);
        }
        void SendUnowned(Work work, Func<Native.InputPacket[]> build)
        {
            store.WithLock(delegate(LeaseSnapshot state) { CheckSafe(work, state); StartTimestamp(work); SendEvents(work, build()); });
        }
        void MoveBeforeButton(Work work, int x, int y)
        {
            store.WithLock(delegate(LeaseSnapshot state)
            {
                CheckSafe(work, state);
                if (Native.IsMouseDown(work.Button)) throw new InputFailure("user_button_held", "Mouse button is already held; no cursor move issued");
                StartTimestamp(work); SendEvents(work, new[] { Native.MouseAbsolute(hwnd, x, y) });
            });
        }
        void PressOwned(Work work)
        {
            store.WithRegisteredInput(delegate(LeaseSnapshot state)
            {
                CheckSafe(work, state);
                if (state.HeldKeysMask != 0 || state.HeldMouseMask != 0) throw new InputFailure("owned_inputs_busy", "Previous inputs are still owned");
                if (work.Keys != null)
                {
                    foreach (KeySpec key in work.Keys) if (Native.IsKeyDown(key)) throw new InputFailure("user_key_held", "Key already held: " + key.Name);
                    foreach (KeySpec key in work.Keys) state.HeldKeysMask |= key.Mask;
                }
                if (work.Button != 0)
                {
                    if (Native.IsMouseDown(work.Button)) throw new InputFailure("user_button_held", "Mouse button is already held");
                    state.HeldMouseMask |= work.Button;
                }
                StartTimestamp(work); work.OwnedEver = true;
                state.LeaseDeadlineMs = Clock.NowMs + work.Duration + 250;
            }, delegate(LeaseSnapshot state)
            {
                CheckSafe(work, state);
                List<Native.InputPacket> packets = new List<Native.InputPacket>();
                if (work.Keys != null) foreach (KeySpec key in work.Keys) packets.Add(Native.KeyEvent(key, false));
                if (work.Kind == "focus_click" || work.Kind == "mouse_click")
                    packets.AddRange(Native.ClickBatch(Native.MouseAbsolute(hwnd, work.X, work.Y), work.Button));
                else if (work.Button != 0) packets.Add(Native.MouseButton(work.Button, false));
                if (work.Kind == "focus_click")
                { Interlocked.Exchange(ref work.FocusActivationDeadlineMs, Clock.NowMs + Math.Min(work.Duration, 75)); work.FocusClickStarted = true; }
                SendEvents(work, packets.ToArray());
            });
        }
        void WaitDuration(Work work)
        {
            long deadline = Clock.NowMs + work.Duration;
            while (Clock.NowMs < deadline)
            {
                if (work.Cancel.WaitOne(10)) throw new InputFailure(work.CancelReason, "Action cancelled");
                CheckSafe(work, store.Read());
            }
        }
        void WaitUntil(Work work, long deadline)
        {
            while (Clock.NowMs < deadline)
            {
                int remaining = (int)Math.Min(10, deadline - Clock.NowMs);
                if (work.Cancel.WaitOne(Math.Max(1, remaining))) throw new InputFailure(work.CancelReason, "Action cancelled");
                CheckSafe(work, store.Read());
            }
        }
        void RunTimeline(Work work)
        {
            // One command owns all keys/buttons. Each same-time batch is one SendInput.
            work.TimelineStart = Clock.NowMs;
            ulong expectedKeys = 0; int expectedMouse = 0;
            int cursor = 0;
            while (cursor < work.Events.Length)
            {
                int at = work.Events[cursor].At, end = cursor + 1;
                while (end < work.Events.Length && work.Events[end].At == at) end++;
                WaitUntil(work, work.TimelineStart + at);
                List<Native.InputPacket> packets = new List<Native.InputPacket>();
                ulong downKeys = 0, upKeys = 0; int downMouse = 0, upMouse = 0;
                for (int i = cursor; i < end; i++)
                {
                    TimelineEvent item = work.Events[i];
                    if (item.Kind == "key_down") { downKeys |= item.Key.Mask; packets.Add(Native.KeyEvent(item.Key, false)); }
                    else if (item.Kind == "key_up") { upKeys |= item.Key.Mask; packets.Add(Native.KeyEvent(item.Key, true)); }
                    else if (item.Kind == "button_down") { downMouse |= item.Button; packets.Add(Native.MouseButton(item.Button, false)); }
                    else if (item.Kind == "button_up") { upMouse |= item.Button; packets.Add(Native.MouseButton(item.Button, true)); }
                    else if (item.Kind == "relative_mouse_move") packets.Add(Native.MouseRelative(item.Dx, item.Dy));
                    else { CheckPoint(item.X, item.Y); work.TimelineMousePointSet=true;work.TimelineMouseX=item.X;work.TimelineMouseY=item.Y;packets.Add(Native.MouseAbsolute(hwnd, item.X, item.Y)); }
                }
                store.WithRegisteredInput(delegate(LeaseSnapshot state)
                {
                    CheckSafe(work, state);
                    if (state.HeldKeysMask != expectedKeys || state.HeldMouseMask != expectedMouse)
                        throw new InputFailure("timeline_ownership_changed", "Timeline ledger no longer matches this command");
                    if ((upKeys & state.HeldKeysMask) != upKeys || (upMouse & state.HeldMouseMask) != upMouse)
                        throw new InputFailure("timeline_unowned_up", "Timeline cannot release another owner's input");
                    for (int i = cursor; i < end; i++)
                    {
                        TimelineEvent item = work.Events[i];
                        if (item.Kind == "key_down" && Native.IsKeyDown(item.Key)) throw new InputFailure("user_key_held", "Key already held: " + item.Key.Name);
                        if (item.Kind == "button_down" && Native.IsMouseDown(item.Button)) throw new InputFailure("user_button_held", "Mouse button is already held");
                        if (item.Kind == "absolute_mouse_move")
                        { CheckPoint(item.X, item.Y); if (!Native.RecoveryPointOwnedByWindow(hwnd,item.X,item.Y)) throw new InputFailure("timeline_point_not_target","Timeline move point is outside target ownership"); }
                    }
                    if (downMouse != 0)
                    {
                        if (!work.TimelineMousePointSet && !TimelineCursorSafety.CurrentPointOwned(hwnd))
                            throw new InputFailure("timeline_cursor_not_target","Timeline has no target-owned mouse origin");
                        if (work.TimelineMousePointSet && !Native.RecoveryPointOwnedByWindow(hwnd,work.TimelineMouseX,work.TimelineMouseY))
                            throw new InputFailure("timeline_point_not_target","Timeline DOWN point is no longer target-owned");
                        if (!work.TimelineMouseDownIssued && !TimelineCursorSafety.FreeForFirstDown(hwnd))
                            throw new InputFailure("timeline_cursor_not_free","First mouse DOWN requires known free cursor and no human buttons");
                    }
                    // Registration is persisted before DOWN. Keep all ownership after a partial batch.
                    state.HeldKeysMask |= downKeys; state.HeldMouseMask |= downMouse;
                    if (downKeys != 0 || downMouse != 0) { work.OwnedEver = true; work.ReleaseAccounted = false; }
                    state.LeaseDeadlineMs = work.TimelineStart + work.Duration + 250;
                    StartTimestamp(work);
                }, delegate(LeaseSnapshot state)
                {
                    CheckSafe(work, state);
                    if (downMouse != 0)
                    {
                        if (work.TimelineMousePointSet && !Native.RecoveryPointOwnedByWindow(hwnd,work.TimelineMouseX,work.TimelineMouseY))
                            throw new InputFailure("timeline_point_not_target","Timeline point ownership changed before DOWN");
                        if (!work.TimelineMouseDownIssued && !TimelineCursorSafety.FreeForFirstDown(hwnd))
                            throw new InputFailure("timeline_cursor_not_free","Cursor ownership changed before DOWN");
                        work.TimelineMouseDownIssued=true;
                    }
                    SendEvents(work, packets.ToArray());
                    state.HeldKeysMask &= ~upKeys; state.HeldMouseMask &= ~upMouse;
                    expectedKeys = state.HeldKeysMask; expectedMouse = state.HeldMouseMask;
                    if (state.HeldKeysMask == 0 && state.HeldMouseMask == 0)
                    { state.LeaseDeadlineMs = 0; if (work.OwnedEver) work.ReleaseAccounted = true; }
                });
                cursor = end;
            }
            WaitUntil(work, work.TimelineStart + work.Duration);
        }
        ReleaseResult TryRelease(Work work, int timeoutMs)
        {
            if (work != null) lock (work.ReleaseSync) return ReleaseLoop(work, timeoutMs);
            return ReleaseLoop(null, timeoutMs);
        }
        void ReleaseUntilSafe(Work work)
        {
            // When the guardian is gone, exiting would relinquish admission
            // while old UP retries can still affect a new session. Quarantine
            // remains alive and owns admission until the ledger is empty.
            while (true)
            {
                if (TryRelease(work, 500).Released) return;
                Thread.Sleep(20);
            }
        }
        ReleaseResult ReleaseLoop(Work work, int timeoutMs)
        {
            long deadline = Clock.NowMs + timeoutMs;
            ReleaseResult last = new ReleaseResult { Released = false, FailureReason = "release_timeout" };
            int requested = 0, inserted = 0;
            do
            {
                try
                {
                    last = store.ReleaseOwned("executor_release");
                    requested += last.Requested; inserted += last.Inserted;
                    if (work != null) { Interlocked.Add(ref work.Requested, last.Requested); Interlocked.Add(ref work.Inserted, last.Inserted); }
                    if (last.Released)
                    {
                        if (work != null && last.Requested > 0) work.ReleaseAccounted = true;
                        return new ReleaseResult { Requested = requested, Inserted = inserted, Released = true };
                    }
                }
                catch (Exception error) { last.FailureReason = error.Message; }
                Thread.Sleep(10);
            } while (Clock.NowMs < deadline);
            return new ReleaseResult { Requested = requested, Inserted = inserted, Released = false, FailureReason = last.FailureReason };
        }
        void RunWork(Work work)
        {
            string status = "completed", reason = null, message = null;
            try
            {
                if (work.Kind == "timeline") RunTimeline(work);
                else if (work.Kind == "key") { PressOwned(work); WaitDuration(work); }
                else if (work.Kind == "mouse_move")
                {
                    SendUnowned(work, delegate() { return new[] { work.Mode == "absolute" ? Native.MouseAbsolute(hwnd, work.X, work.Y) : Native.MouseRelative(work.Dx, work.Dy) }; });
                }
                else if (work.Kind == "mouse_wheel")
                    SendUnowned(work, delegate()
                    {
                        if (!Native.CursorWithinClient(hwnd)) throw new InputFailure("cursor_outside_client", "Wheel requires cursor within the target client");
                        return new[] { Native.MouseWheel(work.Delta) };
                    });
                else if (work.Kind == "focus_click") { PressOwned(work); WaitDuration(work); }
                else if (work.Kind == "mouse_click")
                {
                    PressOwned(work); WaitDuration(work);
                }
                else if (work.Kind == "mouse_drag")
                {
                    MoveBeforeButton(work, work.FromX, work.FromY);
                    PressOwned(work);
                    long start = Clock.NowMs, end = start + work.Duration;
                    while (Clock.NowMs < end)
                    {
                        if (work.Cancel.WaitOne(10)) throw new InputFailure(work.CancelReason, "Action cancelled");
                        double fraction = Math.Min(1.0, (Clock.NowMs - start) / (double)work.Duration);
                        int x = (int)Math.Round(work.FromX + (work.ToX - work.FromX) * fraction);
                        int y = (int)Math.Round(work.FromY + (work.ToY - work.FromY) * fraction);
                        SendUnowned(work, delegate() { return new[] { Native.MouseAbsolute(hwnd, x, y) }; });
                    }
                    SendUnowned(work, delegate() { return new[] { Native.MouseAbsolute(hwnd, work.ToX, work.ToY) }; });
                }
            }
            catch (InputFailure error)
            {
                reason = error.Code; message = error.Message;
                status = work.Cancel.WaitOne(0) ? "cancelled" : work.Requested == 0 ? "rejected" : "failed";
            }
            catch (Exception error) { status = "failed"; reason = "execution_failed"; message = error.Message; }
            ReleaseResult release = TryRelease(work, 500);
            if (!release.Released)
            { status = "failed"; reason = "release_failed"; message = release.FailureReason; RequestStop("release_failed"); }
            else if (work.OwnedEver && !work.ReleaseAccounted)
            { status = "failed"; reason = "external_release_unaccounted"; message = "Ownership cleared externally; release event counts are unknown"; }
            else if (status == "completed" && work.Inserted != work.Requested)
            { status = "failed"; reason = "sendinput_partial"; message = "At least one input batch was only partly inserted"; }
            if (work.Kind == "focus_click" && status == "completed")
            {
                try
                {
                    WindowInfo info = Native.GetWindow(hwnd);
                    if (!Native.IsProcessAlive(expectedPid, targetStartTicks) || info.Pid != expectedPid || !info.Focused)
                        throw new InputFailure("focus_recovery_failed", "Focus recovery click did not activate the expected target");
                }
                catch (Exception error)
                { status = "failed"; reason = "focus_recovery_failed"; message = error.Message; RequestStop(reason); }
            }
            if (work.Kind == "focus_click" && status != "completed" && work.Requested > 0) RequestStop(reason ?? "focus_recovery_failed");
            string inputStatus = InputSummary(work.Requested, work.Inserted, release.Released, work.OwnedEver);
            if (reason == "external_release_unaccounted") inputStatus = "failed";
            Dictionary<string, object> reply = Reply(work.Command, status, inputStatus, work.Requested, work.Inserted,
                release.Released, work.StartedMs, Clock.NowMs, reason, message);
            reply.Add("input_timing", work.FirstSendStartedMs < 0 ? null : Obj("clock", "windows_qpc",
                "first_send_started_ms", work.FirstSendStartedMs, "first_send_finished_ms", work.FirstSendFinishedMs,
                "last_send_finished_ms", work.LastSendFinishedMs));
            lock (stateLock) if (active == work) active = null;
            SendReply(work.Command, reply);
        }

        Command Parse(string line)
        {
            if (line.Length > 65536) throw new InputFailure("invalid_json", "Command exceeds 65536 characters");
            object parsed;
            new JsonMemberCheck(line).Check();
            try { lock (serializer) parsed = serializer.DeserializeObject(line); }
            catch (Exception error) { throw new InputFailure("invalid_json", error.Message); }
            Dictionary<string, object> value = Map(parsed, "command");
            Exact(value, "protocol", "version", "type", "id", "session_id", "op", "action");
            if (Text(value, "protocol") != "wow-input" || Integer(value, "version", 1, 1) != 1 || Text(value, "type") != "command")
                throw new InputFailure("invalid_command", "Wrong protocol, version or message type");
            string id = Text(value, "id");
            if (!IdPattern.IsMatch(id)) throw new InputFailure("invalid_command", "Invalid command id");
            if (Text(value, "session_id") != session) throw new InputFailure("invalid_command", "Session does not match");
            string op = Text(value, "op");
            if (op != "execute" && op != "heartbeat" && op != "cancel" && op != "release_all" && op != "shutdown" && op != "status")
                throw new InputFailure("invalid_command", "Unsupported command op");
            Command command = new Command { Id = id, Op = op, Fingerprint = Canonical(value) };
            if (op == "execute") command.Action = Map(Required(value, "action"), "action");
            else if (value.ContainsKey("action")) throw new InputFailure("invalid_command", "Only execute permits action");
            return command;
        }
        Work ValidateAction(Command command)
        {
            Dictionary<string, object> action = command.Action;
            Work work = new Work { Command = command, Kind = Text(action, "kind") };
            if (work.Kind == "timeline")
            {
                WindowInfo info = Native.GetWindow(hwnd);
                work.Events = ParseTimeline(action, info.Width, info.Height, out work.Duration);
            }
            else if (work.Kind == "key")
            {
                Exact(action, "kind", "keys", "duration_ms");
                object[] names = Required(action, "keys") as object[];
                if (names == null || names.Length == 0 || names.Length > KeyCatalog.All.Length) throw new InputFailure("invalid_action", "keys must contain 1..60 distinct canonical key names");
                HashSet<string> distinct = new HashSet<string>(StringComparer.Ordinal); work.Keys = new KeySpec[names.Length];
                for (int i = 0; i < names.Length; i++)
                {
                    string name = names[i] as string;
                    if (name == null || !distinct.Add(name)) throw new InputFailure("invalid_action", "keys must be distinct strings");
                    try { work.Keys[i] = KeyCatalog.Get(name); }
                    catch (ArgumentException error) { throw new InputFailure("invalid_action", error.Message); }
                }
                work.Duration = Integer(action, "duration_ms", 1, MaxDurationMs);
            }
            else if (work.Kind == "mouse_move")
            {
                work.Mode = Text(action, "mode");
                if (work.Mode == "absolute")
                { Exact(action, "kind", "mode", "x", "y"); work.X = Integer(action, "x", 0, 65535); work.Y = Integer(action, "y", 0, 65535); CheckPoint(work.X, work.Y); }
                else if (work.Mode == "relative")
                { Exact(action, "kind", "mode", "dx", "dy"); work.Dx = Integer(action, "dx", -32767, 32767); work.Dy = Integer(action, "dy", -32767, 32767); }
                else throw new InputFailure("invalid_action", "mouse_move mode must be absolute or relative");
            }
            else if (work.Kind == "focus_click")
            {
                Exact(action, "kind", "x", "y", "duration_ms"); work.Button = 1;
                work.X = Integer(action, "x", 0, 65535); work.Y = Integer(action, "y", 0, 65535); CheckPoint(work.X, work.Y);
                work.Duration = Integer(action, "duration_ms", 1, 150);
            }
            else if (work.Kind == "mouse_click")
            {
                Exact(action, "kind", "button", "x", "y", "duration_ms"); work.Button = Button(Text(action, "button"));
                work.X = Integer(action, "x", 0, 65535); work.Y = Integer(action, "y", 0, 65535); CheckPoint(work.X, work.Y);
                work.Duration = Integer(action, "duration_ms", 1, MaxDurationMs);
            }
            else if (work.Kind == "mouse_wheel")
            {
                Exact(action, "kind", "delta"); work.Delta = Integer(action, "delta", -12000, 12000);
                if (work.Delta == 0 || work.Delta % 120 != 0) throw new InputFailure("invalid_action", "wheel delta must be a nonzero multiple of 120");
            }
            else if (work.Kind == "mouse_drag")
            {
                Exact(action, "kind", "button", "from", "to", "duration_ms"); work.Button = Button(Text(action, "button"));
                Dictionary<string, object> from = Map(Required(action, "from"), "from"), to = Map(Required(action, "to"), "to");
                Exact(from, "x", "y"); Exact(to, "x", "y");
                work.FromX = Integer(from, "x", 0, 65535); work.FromY = Integer(from, "y", 0, 65535);
                work.ToX = Integer(to, "x", 0, 65535); work.ToY = Integer(to, "y", 0, 65535);
                CheckPoint(work.FromX, work.FromY); CheckPoint(work.ToX, work.ToY);
                work.Duration = Integer(action, "duration_ms", 1, MaxDurationMs);
            }
            else throw new InputFailure("invalid_action", "Unsupported action kind");
            CheckSafe(work, store.Read());
            return work;
        }
        void CheckPoint(int x, int y)
        { WindowInfo info = Native.GetWindow(hwnd); if (x >= info.Width || y >= info.Height) throw new InputFailure("invalid_action", "Coordinate outside client area"); }
        public void Run()
        {
            string line;
            while (!ending && (line = Console.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Command command;
                try { command = Parse(line); }
                catch (InputFailure error) { Error(error.Code, error.Message); continue; }
                bool cached = false;
                if (command.Op != "heartbeat" && command.Op != "status")
                {
                    Dictionary<string, object> oldReply = null;
                    string reject = null;
                    lock (stateLock)
                    {
                        Record old;
                        if (records.TryGetValue(command.Id, out old))
                        {
                            if (old.Fingerprint != command.Fingerprint) reject = "duplicate_id";
                            else { cached = true; oldReply = old.Reply; }
                        }
                        else if (records.Count >= MaxRecords && command.Op == "execute") reject = "id_capacity";
                        else if (records.Count < MaxRecords) records.Add(command.Id, new Record { Fingerprint = command.Fingerprint });
                        // At capacity, safety control operations remain available but never issue downs.
                    }
                    if (reject != null)
                    { Emit(Reply(command, "rejected", "not_sent", 0, 0, false, -1, Clock.NowMs, reject, reject)); continue; }
                    if (cached) { if (oldReply != null) Emit(oldReply); continue; }
                }
                try { Handle(command); }
                catch (InputFailure error)
                { SendReply(command, Reply(command, "rejected", "not_sent", 0, 0, IsReleased(), -1, Clock.NowMs, error.Code, error.Message)); }
                catch (Exception error)
                { SendReply(command, Reply(command, "failed", "failed", 0, 0, IsReleased(), -1, Clock.NowMs, "command_failed", error.Message)); }
            }
            ending = true; if (!stopped) RequestStop("stdin_eof");
        }
        bool IsReleased()
        { try { LeaseSnapshot state = store.Read(); return state.HeldKeysMask == 0 && state.HeldMouseMask == 0; } catch { return false; } }
        void Handle(Command command)
        {
            if (command.Op == "heartbeat")
            {
                if (stopped) throw new InputFailure("session_stopped", stopReason);
                store.WithLock(delegate(LeaseSnapshot state) { if (!state.StopRequested) state.ControllerHeartbeatMs = Clock.NowMs; });
                SendReply(command, Reply(command, "ok", "not_sent", 0, 0, IsReleased(), -1, Clock.NowMs, null, null)); return;
            }
            if (command.Op == "status")
            {
                LeaseSnapshot state = store.Read(); string activeId;
                lock (stateLock) activeId = active == null ? null : active.Command.Id;
                Dictionary<string, object> reply = Reply(command, "ok", "not_sent", 0, 0, state.HeldKeysMask == 0 && state.HeldMouseMask == 0, -1, Clock.NowMs, null, null);
                reply.Add("state", Obj("active_action_id", activeId, "held_keys_mask", "0x" + state.HeldKeysMask.ToString("x", CultureInfo.InvariantCulture),
                    "held_mouse_mask", state.HeldMouseMask, "watchdog_ready", state.WatchdogReady, "stop_requested", state.StopRequested,
                    "stop_reason", state.StopReason, "lease_deadline_ms", state.LeaseDeadlineMs)); SendReply(command, reply); return;
            }
            if (command.Op == "execute")
            {
                Work work = ValidateAction(command);
                lock (stateLock)
                {
                    if (active != null) throw new InputFailure("action_busy", "Only one action may be in flight");
                    if (stopped || ending) throw new InputFailure("session_stopped", stopReason);
                    active = work;
                }
                SendReply(command, Reply(command, "accepted", "not_sent", 0, 0, IsReleased(), -1, -1, null, null));
                work.Thread = new Thread(delegate() { RunWork(work); }); work.Thread.IsBackground = true; work.Thread.Start(); return;
            }
            Work current;
            lock (stateLock)
            {
                current = active;
                if (current != null) { current.CancelReason = command.Op == "cancel" ? "cancel_requested" : command.Op + "_requested"; current.Cancel.Set(); }
            }
            if (command.Op == "shutdown") { ending = true; RequestStop("shutdown_requested"); }
            ReleaseResult release = TryRelease(current, 500);
            string status = release.Released ? "ok" : "failed";
            SendReply(command, Reply(command, status, InputSummary(release.Requested, release.Inserted, release.Released, true),
                release.Requested, release.Inserted, release.Released, -1, Clock.NowMs,
                release.Released ? command.Op + "_requested" : "release_failed", release.Released ? command.Op : release.FailureReason));
            if (!release.Released) RequestStop("release_failed");
        }
        void WaitOutput(int timeoutMs)
        { long deadline = Clock.NowMs + timeoutMs; while (output.Count > 0 && Clock.NowMs < deadline) Thread.Sleep(10); }
        public void Dispose()
        {
            ending = true; RequestStop(stopReason.Length == 0 ? "executor_exit" : stopReason);
            Work current; lock (stateLock) current = active;
            if (current != null && current.Thread != null) current.Thread.Join(700);
            ReleaseUntilSafe(current); WaitOutput(200);
            // Leave the watchdog alive until it has independently observed stop and released the ledger.
            try { watchdog.WaitForExit(1500); } catch { }
            output.CompleteAdding(); outputThread.Join(200);
            if (monitorThread != null) monitorThread.Join(200);
            store.Dispose(); watchdog.Dispose(); output.Dispose();
        }
    }

    static Dictionary<string, object> Obj(params object[] pairs)
    {
        Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
        for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    // Preserve strict native command semantics before JavaScriptSerializer can
    // overwrite duplicate member names (including escaped aliases).
    static TimelineEvent[] ParseTimeline(Dictionary<string, object> action, int width, int height, out int duration)
    {
        Exact(action, "kind", "duration_ms", "events");
        if (Text(action, "kind") != "timeline") throw new InputFailure("invalid_action", "Expected timeline");
        duration = Integer(action, "duration_ms", 1, MaxDurationMs);
        object[] raw = Required(action, "events") as object[];
        if (raw == null || raw.Length < 1 || raw.Length > 256) throw new InputFailure("invalid_timeline", "Timeline needs 1..256 events");
        TimelineEvent[] events = new TimelineEvent[raw.Length];
        Dictionary<string, int> held = new Dictionary<string, int>(StringComparer.Ordinal);
        HashSet<string> touched = new HashSet<string>(StringComparer.Ordinal);
        int previous = -1;
        for (int i = 0; i < raw.Length; i++)
        {
            Dictionary<string, object> value = Map(raw[i], "timeline event");
            TimelineEvent item = new TimelineEvent { Kind = Text(value, "kind"), At = Integer(value, "at_ms", 0, duration) };
            if (item.At < previous) throw new InputFailure("invalid_timeline", "Timeline event times must be sorted");
            if (item.At != previous) touched.Clear(); previous = item.At;
            string resource = null;
            if (item.Kind == "key_down" || item.Kind == "key_up")
            {
                Exact(value, "kind", "at_ms", "key"); string key = Text(value, "key");
                try { item.Key = KeyCatalog.Get(key); }
                catch (ArgumentException error) { throw new InputFailure("invalid_timeline", error.Message); }
                resource = "key:" + key;
            }
            else if (item.Kind == "button_down" || item.Kind == "button_up")
            { Exact(value, "kind", "at_ms", "button"); string button = Text(value, "button"); item.Button = Button(button); resource = "button:" + button; }
            else if (item.Kind == "relative_mouse_move")
            { Exact(value, "kind", "at_ms", "dx", "dy"); item.Dx = Integer(value, "dx", -32767, 32767); item.Dy = Integer(value, "dy", -32767, 32767); }
            else if (item.Kind == "absolute_mouse_move")
            {
                Exact(value, "kind", "at_ms", "x", "y"); item.X = Integer(value, "x", 0, 65535); item.Y = Integer(value, "y", 0, 65535);
                if (item.X >= width || item.Y >= height) throw new InputFailure("invalid_timeline", "Timeline coordinate outside client area");
            }
            else throw new InputFailure("invalid_timeline", "Unsupported timeline event");
            if (resource != null)
            {
                if (!touched.Add(resource)) throw new InputFailure("invalid_timeline", "Resource repeated at one timestamp");
                if (item.Kind == "key_down" || item.Kind == "button_down")
                {
                    if (held.ContainsKey(resource)) throw new InputFailure("invalid_timeline", "Duplicate DOWN");
                    held.Add(resource, item.At);
                }
                else
                {
                    int down;
                    if (!held.TryGetValue(resource, out down) || down >= item.At) throw new InputFailure("invalid_timeline", "UP needs an earlier DOWN");
                    held.Remove(resource);
                }
            }
            events[i] = item;
        }
        if (held.Count != 0) throw new InputFailure("invalid_timeline", "Every DOWN needs a paired UP in this command");
        return events;
    }
    static int ValidateTimelineFixture(string[] args)
    {
        int width = 65536, height = 65536;
        if (args.Length != 1 && (args.Length != 5 || args[1] != "--width" || args[3] != "--height" ||
            !int.TryParse(args[2], out width) || !int.TryParse(args[4], out height) || width < 1 || width > 65536 || height < 1 || height > 65536))
        { Console.Error.WriteLine("Usage: validate-timeline [--width N --height N]"); return 2; }
        string line; int failed = 0;
        while ((line = Console.ReadLine()) != null)
        {
            try
            {
                new JsonMemberCheck(line).Check();
                Dictionary<string, object> value = Map(new JavaScriptSerializer().DeserializeObject(line), "timeline");
                int duration; TimelineEvent[] events = ParseTimeline(value, width, height, out duration);
                Console.WriteLine(new JavaScriptSerializer().Serialize(Obj("status", "valid", "duration_ms", duration, "events", events.Length, "real_inputs", 0, "effect", "unverified")));
            }
            catch (Exception error)
            { failed++; Console.WriteLine(new JavaScriptSerializer().Serialize(Obj("status", "invalid", "reason", error.Message, "real_inputs", 0))); }
        }
        return failed == 0 ? 0 : 2;
    }
    sealed class JsonMemberCheck
    {
        readonly string text;
        int cursor, depth;
        public JsonMemberCheck(string value) { text = value; }
        void Fail() { throw new InputFailure("invalid_json", "Malformed JSON or duplicate object key"); }
        void Space() { while (cursor < text.Length && (text[cursor] == ' ' || text[cursor] == '\t' || text[cursor] == '\r' || text[cursor] == '\n')) cursor++; }
        string StringToken()
        {
            if (cursor >= text.Length || text[cursor] != '"') { Fail(); return null; }
            int start = cursor++;
            while (cursor < text.Length)
            {
                char value = text[cursor++];
                if (value == '"') return text.Substring(start, cursor - start);
                if (value < 0x20) Fail();
                if (value == '\\') { if (cursor >= text.Length) Fail(); cursor++; }
            }
            Fail(); return null;
        }
        void Value()
        {
            Space(); if (cursor >= text.Length || ++depth > 100) Fail();
            char first = text[cursor];
            if (first == '{')
            {
                cursor++; Space(); HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
                if (cursor < text.Length && text[cursor] == '}') cursor++;
                else while (true)
                {
                    Space(); string token = StringToken(), name;
                    try { name = new JavaScriptSerializer().DeserializeObject(token) as string; }
                    catch { Fail(); return; }
                    if (name == null || !names.Add(name)) Fail();
                    Space(); if (cursor >= text.Length || text[cursor++] != ':') Fail();
                    Value(); Space(); if (cursor >= text.Length) Fail();
                    char separator = text[cursor++]; if (separator == '}') break; if (separator != ',') Fail();
                }
            }
            else if (first == '[')
            {
                cursor++; Space();
                if (cursor < text.Length && text[cursor] == ']') cursor++;
                else while (true)
                {
                    Value(); Space(); if (cursor >= text.Length) Fail();
                    char separator = text[cursor++]; if (separator == ']') break; if (separator != ',') Fail();
                }
            }
            else if (first == '"') StringToken();
            else
            {
                int start = cursor;
                while (cursor < text.Length && text[cursor] != ',' && text[cursor] != '}' && text[cursor] != ']' &&
                    text[cursor] != ' ' && text[cursor] != '\t' && text[cursor] != '\r' && text[cursor] != '\n') cursor++;
                if (cursor == start) Fail();
                // Primitive syntax is checked by JavaScriptSerializer afterwards.
            }
            depth--;
        }
        public void Check() { Value(); Space(); if (cursor != text.Length) Fail(); }
    }
    static Dictionary<string, object> Reason(string code, string message)
    {
        if (String.IsNullOrEmpty(code) || !IdPattern.IsMatch(code)) code = "execution_failed";
        if (String.IsNullOrEmpty(message)) message = code;
        if (message.Length > 2048) message = message.Substring(0, 2048);
        return Obj("code", code, "message", message);
    }
    static string InputSummary(long requested, long inserted, bool released, bool ownedEver)
    {
        if (requested == 0) return "not_sent";
        if (inserted == 0) return "failed";
        if (inserted < requested) return "partial";
        return ownedEver && released ? "released" : "sent";
    }
    static object Required(Dictionary<string, object> value, string key)
    { object result; if (!value.TryGetValue(key, out result)) throw new InputFailure("invalid_command", "Missing field: " + key); return result; }
    static Dictionary<string, object> Map(object value, string name)
    { Dictionary<string, object> result = value as Dictionary<string, object>; if (result == null) throw new InputFailure("invalid_command", name + " must be an object"); return result; }
    static string Text(Dictionary<string, object> value, string key)
    { string result = Required(value, key) as string; if (result == null) throw new InputFailure("invalid_command", key + " must be a string"); return result; }
    static int Integer(Dictionary<string, object> value, string key, int min, int max)
    {
        object raw = Required(value, key);
        // JavaScriptSerializer represents integer literals as Int32/Int64. Reject strings,
        // booleans, floating point and decimal literals rather than rounding/coercing.
        if (!(raw is int) && !(raw is long)) throw new InputFailure("invalid_action", key + " must be an integer literal");
        long number = raw is int ? (int)raw : (long)raw;
        if (number < min || number > max) throw new InputFailure("invalid_action", key + " is outside the allowed range");
        return (int)number;
    }
    static void Exact(Dictionary<string, object> value, params string[] names)
    {
        HashSet<string> allowed = new HashSet<string>(names, StringComparer.Ordinal);
        foreach (string key in value.Keys) if (!allowed.Contains(key)) throw new InputFailure("invalid_command", "Unexpected field: " + key);
    }
    static int Button(string name)
    { if (name == "left") return 1; if (name == "right") return 2; if (name == "middle") return 4; throw new InputFailure("invalid_action", "Unsupported mouse button"); }
    static string Canonical(object value)
    {
        Dictionary<string, object> map = value as Dictionary<string, object>;
        if (map != null)
        {
            List<string> keys = new List<string>(map.Keys); keys.Sort(StringComparer.Ordinal);
            List<string> pairs = new List<string>();
            foreach (string key in keys) pairs.Add(new JavaScriptSerializer().Serialize(key) + ":" + Canonical(map[key]));
            return "{" + string.Join(",", pairs.ToArray()) + "}";
        }
        object[] array = value as object[];
        if (array != null)
        { string[] items = new string[array.Length]; for (int i = 0; i < array.Length; i++) items[i] = Canonical(array[i]); return "[" + string.Join(",", items) + "]"; }
        return new JavaScriptSerializer().Serialize(value);
    }
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length > 0 && args[0] == "validate-timeline") return ValidateTimelineFixture(args);
        Native.MakeDpiAware(); string session = Guid.Empty.ToString("D");
        Mutex admission = null; bool ownsAdmission = false;
        try
        {
            if (args.Length == 1 && args[0] == "list")
            {
                foreach (WindowInfo info in Native.ListCandidates())
                    Console.WriteLine(new JavaScriptSerializer().Serialize(Obj("hwnd", "0x" + info.Hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture),
                        "pid", info.Pid, "client_width", info.Width, "client_height", info.Height, "focused", info.Focused,
                        "proc", info.ProcessName, "title", info.Title)));
                return 0;
            }
            if (args.Length != 9 || args[0] != "serve" || args[1] != "--window" || args[3] != "--expected-pid" || args[5] != "--session" || args[7] != "--watchdog")
                throw new ArgumentException("Usage: WinInput.exe serve --window HWND --expected-pid PID --session UUID --watchdog PATH");
            if (!Regex.IsMatch(args[2], "^0x[0-9a-fA-F]{1,16}$")) throw new ArgumentException("Window handle must be hexadecimal");
            long handle = long.Parse(args[2].Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            int pid;
            if (handle == 0 || !int.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid <= 0)
                throw new ArgumentException("Invalid window or PID");
            string requestedSession = args[6]; Guid guid;
            if (!Guid.TryParseExact(requestedSession, "D", out guid) || guid.ToString("D") != requestedSession || guid == Guid.Empty)
                throw new ArgumentException("Session must be a nonempty canonical lowercase UUID");
            session = requestedSession;
            if (!File.Exists(args[8])) throw new ArgumentException("Watchdog executable does not exist");
            admission = new Mutex(false, LeaseStore.GlobalExecutorAdmissionMutexName);
            try { ownsAdmission = admission.WaitOne(0); }
            catch (AbandonedMutexException) { ownsAdmission = true; }
            if (!ownsAdmission) throw new InputFailure("executor_busy", "A previous executor still owns input admission or is releasing its ledger");
            using (Server server = new Server(session, new IntPtr(handle), pid, args[8])) server.Run();
            return 0;
        }
        catch (Exception error)
        {
            InputFailure failure = error as InputFailure;
            Dictionary<string, object> result = Obj("protocol", "wow-input", "version", 1, "type", "error", "session_id", session,
                "reason", Reason(failure == null ? "startup_failed" : failure.Code, error.Message),
                "local_clock", Obj("domain", "windows-qpc", "at_ms", Clock.NowMs));
            Console.WriteLine(new JavaScriptSerializer().Serialize(result));
            return 2;
        }
        finally
        {
            if (ownsAdmission && admission != null) admission.ReleaseMutex();
            if (admission != null) admission.Dispose();
        }
    }
}

// Native first-DOWN and holding checks. Kept outside perception and invoked by
// the original executor under its lease registration lock.
public static class TimelineCursorSafety
{
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Cursor {public uint Size,Flags;public IntPtr Handle;public Point Position;}
    [StructLayout(LayoutKind.Sequential)] struct Gui {public uint Size,Flags;public IntPtr Active,Focus,Capture,Menu,MoveSize,Caret;public Rect CaretRect;}
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref Cursor cursor);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref Gui gui);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd,ref Point point);
    public static bool EvaluateFirstDown(bool cursorKnown,bool cursorVisible,bool cursorHandleKnown,bool captureFree,bool anyUserButton)
    {return cursorKnown&&cursorVisible&&cursorHandleKnown&&captureFree&&!anyUserButton;}
    public static bool FreeForFirstDown(IntPtr hwnd)
    {
        uint pid;uint thread=GetWindowThreadProcessId(hwnd,out pid);var cursor=new Cursor{Size=(uint)Marshal.SizeOf(typeof(Cursor))};var gui=new Gui{Size=(uint)Marshal.SizeOf(typeof(Gui))};
        bool known=thread>0&&GetCursorInfo(ref cursor)&&GetGUIThreadInfo(thread,ref gui);
        return EvaluateFirstDown(known,(cursor.Flags&1)!=0,cursor.Handle!=IntPtr.Zero,gui.Capture==IntPtr.Zero,Native.IsMouseDown(1)||Native.IsMouseDown(2)||Native.IsMouseDown(4));
    }
    public static bool CurrentPointOwned(IntPtr hwnd)
    {
        var cursor=new Cursor{Size=(uint)Marshal.SizeOf(typeof(Cursor))};if(!GetCursorInfo(ref cursor))return false;var point=cursor.Position;
        return ScreenToClient(hwnd,ref point)&&Native.RecoveryPointOwnedByWindow(hwnd,point.X,point.Y);
    }
}
