using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using WowJev.Input;

// Independent Windows guardian. Readiness and ownership live in the native
// ledger, not in stdout or the WSL parent's lifetime.
static class WinInputWatchdog
{
    [STAThread]
    static int Main(string[] args)
    {
        Guardian context = null;
        Mutex owner = null;
        bool owns = false;
        DiagnosticSink log = null;
        try
        {
            Options options = Options.Parse(args);
            log = new DiagnosticSink(options.LogPath);
            owner = new Mutex(false, LeaseStore.GlobalOwnerMutexName);
            try { owns = owner.WaitOne(0); }
            catch (AbandonedMutexException) { owns = true; }
            if (!owns) { log.Emit("guardian_unavailable", "input_owner_busy"); return 1; }
            context = new Guardian(options, log);
            Application.Run(context);
            return context.ExitCode;
        }
        catch (Exception error)
        {
            // No exception message / window title is copied into diagnostics.
            if (log != null) log.Emit("guardian_error", error.GetType().Name);
            return 2;
        }
        finally
        {
            if (context != null) context.Dispose();
            if (owns && owner != null) owner.ReleaseMutex();
            if (owner != null) owner.Dispose();
        }
    }

    sealed class Options
    {
        public string Session;
        public int ExecutorPid;
        public int HeartbeatTimeoutMs = 1000;
        public string LogPath;

        public static Options Parse(string[] args)
        {
            if (args.Length < 1 || args[0] != "serve") throw new ArgumentException("Expected serve.");
            Options result = new Options();
            HashSet<string> seen = new HashSet<string>();
            for (int i = 1; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length || !seen.Add(args[i])) throw new ArgumentException("Invalid options.");
                string value = args[i + 1];
                if (args[i] == "--session") result.Session = value;
                else if (args[i] == "--executor-pid") result.ExecutorPid = int.Parse(value);
                else if (args[i] == "--heartbeat-timeout-ms") result.HeartbeatTimeoutMs = int.Parse(value);
                else if (args[i] == "--log") result.LogPath = Path.GetFullPath(value);
                else throw new ArgumentException("Unknown option.");
            }
            Guid session;
            if (!Guid.TryParse(result.Session, out session) || result.ExecutorPid <= 0 ||
                result.HeartbeatTimeoutMs < 200 || result.HeartbeatTimeoutMs > 10000)
                throw new ArgumentException("Invalid options.");
            // A native local path is intentional: cleanup must not wait on UNC/WSL I/O.
            if (result.LogPath != null && (result.LogPath.StartsWith("\\\\") || !Path.IsPathRooted(result.LogPath)))
                throw new ArgumentException("Log path must be native local.");
            return result;
        }
    }

    sealed class Guardian : ApplicationContext
    {
        readonly Options options;
        readonly DiagnosticSink log;
        readonly LeaseStore store;
        readonly HotkeyWindow hotkey;
        readonly System.Windows.Forms.Timer timer;
        readonly long executorStart;
        readonly long guardianStart;
        readonly int guardianPid;
        bool stopping;
        bool closed;
        string reason;
        public int ExitCode { get; private set; }

        public Guardian(Options options, DiagnosticSink log)
        {
            this.options = options;
            this.log = log;
            executorStart = Native.GetProcessStartTicks(options.ExecutorPid);
            if (executorStart <= 0 || !Native.IsProcessAlive(options.ExecutorPid, executorStart))
                throw new InvalidOperationException("Executor unavailable.");
            guardianPid = Process.GetCurrentProcess().Id;
            guardianStart = Native.GetProcessStartTicks(guardianPid);
            store = new LeaseStore(options.Session, false);
            HotkeyWindow created = null;
            try
            {
                // RegisterHotKey is part of the ready handshake, not best effort.
                created = new HotkeyWindow(delegate { BeginStop("emergency_hotkey"); Poll(); });
                hotkey = created;
                store.WithLock(delegate(LeaseSnapshot state)
                {
                    if (state.ExecutorPid != options.ExecutorPid || state.ExecutorStartTimeTicks != executorStart)
                        throw new InvalidOperationException("Executor identity mismatch.");
                    if (state.StopRequested) throw new InvalidOperationException("Session already stopped.");
                    state.WatchdogPid = guardianPid;
                    state.WatchdogStartTimeTicks = guardianStart;
                    state.WatchdogHeartbeatMs = Clock.NowMs;
                    state.WatchdogReady = true;
                });
                timer = new System.Windows.Forms.Timer();
                timer.Interval = 20;
                timer.Tick += delegate { Poll(); };
                timer.Start();
                log.Emit("guardian_ready", "ready");
            }
            catch
            {
                if (created != null) created.Dispose();
                store.Dispose();
                throw;
            }
        }

        void BeginStop(string code)
        {
            if (stopping) return;
            stopping = true;
            reason = code;
            ExitCode = code == "stop_requested" ? 0 : 1;
            log.Emit("guardian_stopping", code);
        }

        void Poll()
        {
            if (closed) return;
            try
            {
                bool alive = Native.IsProcessAlive(options.ExecutorPid, executorStart);
                store.WithLock(delegate(LeaseSnapshot state)
                {
                    // Compare the locked snapshot with a time sampled after the
                    // lock is acquired. A concurrent heartbeat may be newer than
                    // any sample taken before process checks / lock waiting.
                    long now = Clock.NowMs;
                    if (!stopping)
                    {
                        if (state.ExecutorPid != options.ExecutorPid || state.ExecutorStartTimeTicks != executorStart)
                            BeginStop("executor_identity_changed");
                        else if (state.StopRequested) BeginStop("stop_requested");
                        else if (!alive) BeginStop("executor_exited");
                        else if (state.ExecutorHeartbeatMs > now || now - state.ExecutorHeartbeatMs > options.HeartbeatTimeoutMs)
                            BeginStop("executor_heartbeat_expired");
                        else if (state.ControllerHeartbeatMs > now || now - state.ControllerHeartbeatMs > options.HeartbeatTimeoutMs)
                            BeginStop("controller_heartbeat_expired");
                        else if ((state.HeldKeysMask != 0 || state.HeldMouseMask != 0) && state.LeaseDeadlineMs <= now)
                            BeginStop("action_lease_expired");
                    }
                    state.WatchdogPid = guardianPid;
                    state.WatchdogStartTimeTicks = guardianStart;
                    state.WatchdogHeartbeatMs = now;
                    if (stopping)
                    {
                        state.WatchdogReady = false;
                        state.StopRequested = true;
                        if (String.IsNullOrEmpty(state.StopReason)) state.StopReason = reason;
                    }
                });
                if (stopping)
                {
                    ReleaseResult result = store.ReleaseOwned(reason);
                    if (result.Released)
                    {
                        log.Emit("guardian_released", reason);
                        closed = true;
                        timer.Stop();
                        ExitThread();
                    }
                    // A partial insertion retains the ledger and retries only UP.
                }
            }
            catch (Exception error)
            {
                BeginStop("ledger_" + error.GetType().Name);
                // Never claim cleanup or relinquish global ownership on a lock/
                // SendInput failure. Retry on the next native timer tick.
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (timer != null) timer.Dispose();
                if (hotkey != null) hotkey.Dispose();
                if (store != null) store.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        const int HotkeyId = 0x574A;
        readonly Action emergency;
        bool registered;
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")]
        static extern bool UnregisterHotKey(IntPtr hwnd, int id);

        public HotkeyWindow(Action emergency)
        {
            this.emergency = emergency;
            CreateHandle(new CreateParams { Caption = "WowJevInputGuardian", Parent = new IntPtr(-3) });
            registered = RegisterHotKey(Handle, HotkeyId, 0x0001 | 0x0002 | 0x4000, 0x79); // Alt+Ctrl+F10
            if (!registered) { DestroyHandle(); throw new InvalidOperationException("Emergency hotkey unavailable."); }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && message.WParam.ToInt32() == HotkeyId) emergency();
            base.WndProc(ref message);
        }
        public void Dispose()
        {
            if (registered) { UnregisterHotKey(Handle, HotkeyId); registered = false; }
            if (Handle != IntPtr.Zero) DestroyHandle();
        }
    }

    // Log transport runs on a bounded background queue. A blocked/broken stdout
    // or slow disk cannot block the timer, ledger, or key release path.
    sealed class DiagnosticSink
    {
        readonly Queue<string> queue = new Queue<string>();
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        readonly string path;
        public DiagnosticSink(string path)
        {
            this.path = path;
            Thread worker = new Thread(WriteLoop);
            worker.IsBackground = true;
            worker.Start();
        }
        public void Emit(string type, string code)
        {
            string text = new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "type", type }, { "reason", code }, { "at_native_ms", Clock.NowMs }
            });
            lock (queue) { if (queue.Count == 128) queue.Dequeue(); queue.Enqueue(text); }
            wake.Set();
        }
        void WriteLoop()
        {
            while (true)
            {
                wake.WaitOne();
                while (true)
                {
                    string item;
                    lock (queue) { if (queue.Count == 0) break; item = queue.Dequeue(); }
                    if (path != null) { try { File.AppendAllText(path, item + Environment.NewLine, Encoding.UTF8); } catch { } }
                    try { Console.Out.WriteLine(item); Console.Out.Flush(); } catch { }
                }
            }
        }
    }
}
