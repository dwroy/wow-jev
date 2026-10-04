using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Only the two dedicated harness windows receive event records. State samples
// query the real Windows key/button state and are never cleared on focus loss.
static class InputRecorder
{
    [STAThread]
    static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "type", "recorder_error" }, { "reason", "initialization_or_ui_failure" },
                { "error_type", error.GetType().FullName }, { "message", error.Message }
            }));
            return 2;
        }
    }
    static int Run(string[] args)
    {
        bool keepOpen = false;
        int interval = 100;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--keep-open") keepOpen = true;
            else if (args[i] == "--state-interval-ms" && ++i < args.Length) interval = int.Parse(args[i]);
            else return 2;
        }
        if (interval < 20 || interval > 1000) return 2;
        RecorderNative.EnableDpi();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        RecorderContext context = new RecorderContext(keepOpen, interval);
        Application.Run(context.Primary);
        context.Dispose();
        return 0;
    }

    sealed class RecorderContext : IDisposable
    {
        public readonly RecorderForm Primary;
        readonly RecorderForm secondary;
        readonly JsonSink output = new JsonSink();
        readonly Dictionary<string, long> counts = new Dictionary<string, long>();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly bool keepOpen;
        long sequence;
        bool ready;
        bool closing;

        public RecorderContext(bool keepOpen, int interval)
        {
            this.keepOpen = keepOpen;
            string[] events = { "key_down", "key_up", "mouse_down", "mouse_up", "mouse_move", "wheel" };
            foreach (string kind in events) counts[kind] = 0;
            Primary = new RecorderForm(this, "primary", 600, 400);
            secondary = new RecorderForm(this, "secondary", 360, 240);
            Primary.StartPosition = FormStartPosition.CenterScreen;
            Primary.Shown += delegate
            {
                secondary.Location = new Point(Primary.Left + Primary.Width + 20, Primary.Top);
                secondary.Show();
                Focus(Primary);
                ready = true;
                output.Emit(new Dictionary<string, object> {
                    { "type", "recorder_ready" }, { "hwnd", Hex(Primary.Handle) },
                    { "pid", Process.GetCurrentProcess().Id },
                    { "client_width", Primary.ClientSize.Width }, { "client_height", Primary.ClientSize.Height },
                    { "secondary_hwnd", Hex(secondary.Handle) }, { "window_class", RecorderNative.WindowClassName(Primary.Handle) },
                    { "focused", RecorderNative.GetForegroundWindow() == Primary.Handle }
                });
                timer.Start();
                Thread reader = new Thread(ReadControls);
                reader.IsBackground = true;
                reader.Start();
            };
            Primary.FormClosing += delegate { closing = true; timer.Stop(); if (!secondary.IsDisposed) secondary.Close(); };
            secondary.FormClosing += delegate(object sender, FormClosingEventArgs eventArgs)
            {
                if (!closing) { eventArgs.Cancel = true; secondary.Hide(); }
            };
            timer.Interval = interval;
            timer.Tick += delegate { output.Emit(State("recorder_state")); };
        }

        public void Record(RecorderForm window, Dictionary<string, object> message)
        {
            if (!ready) return;
            string kind = (string)message["event"];
            counts[kind]++;
            message["type"] = "recorder_event";
            message["window"] = window.WindowName;
            message["hwnd"] = Hex(window.Handle);
            message["seq"] = sequence++;
            message["at_native_ms"] = RecorderNative.NowMs;
            output.Emit(message);
            window.Invalidate();
        }

        Dictionary<string, object> State(string type)
        {
            Dictionary<string, object> keys = new Dictionary<string, object>();
            foreach (string name in new string[] { "W", "SPACE", "CTRL", "SHIFT", "ALT", "F10" })
                keys[name] = RecorderNative.IsKeyDown(name);
            Dictionary<string, object> buttons = new Dictionary<string, object> {
                { "left", RecorderNative.IsMouseDown(1) }, { "right", RecorderNative.IsMouseDown(2) }, { "middle", RecorderNative.IsMouseDown(4) }
            };
            IntPtr foreground = RecorderNative.GetForegroundWindow();
            string active = foreground == Primary.Handle ? "primary" : (foreground == secondary.Handle ? "secondary" : "other");
            return new Dictionary<string, object> {
                { "type", type }, { "at_native_ms", RecorderNative.NowMs }, { "focused", active == "primary" },
                { "active_window", active }, { "keys", keys }, { "buttons", buttons },
                { "counts", new Dictionary<string, long>(counts) }, { "output_dropped", output.Dropped },
                { "client_width", Primary.ClientSize.Width }, { "client_height", Primary.ClientSize.Height },
                { "x", Primary.Left }, { "y", Primary.Top }
            };
        }

        void ReadControls()
        {
            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    string captured = line;
                    if (line.Length > 8192) { ReportControlError("control_too_large"); continue; }
                    try { Primary.BeginInvoke((Action)delegate { Control(captured); }); }
                    catch (InvalidOperationException) { return; }
                }
            }
            catch { }
            if (!keepOpen)
            {
                try { Primary.BeginInvoke((Action)delegate { Primary.Close(); }); }
                catch (InvalidOperationException) { }
            }
        }

        void ReportControlError(string reason)
        {
            output.Emit(new Dictionary<string, object> {
                { "type", "recorder_status" }, { "ok", false }, { "reason", reason }
            });
        }

        void Control(string line)
        {
            string operation = null;
            object requestId = null;
            try
            {
                Dictionary<string, object> command = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                if (command == null || !command.ContainsKey("type") || !Object.Equals(command["type"], "recorder_control"))
                    throw new ArgumentException("Wrong control type.");
                operation = command.ContainsKey("op") ? command["op"] as string : null;
                if (command.ContainsKey("id") && command["id"] is string) requestId = command["id"];
                if (operation == "focus_primary") Focus(Primary);
                else if (operation == "focus_secondary") Focus(secondary);
                else if (operation == "move_window") Primary.Location = new Point(Integer(command, "x", -32768, 32767), Integer(command, "y", -32768, 32767));
                else if (operation == "resize") Primary.ClientSize = new Size(Integer(command, "width", 120, 8192), Integer(command, "height", 120, 8192));
                else if (operation == "trigger_emergency")
                {
                    IntPtr active = RecorderNative.GetForegroundWindow();
                    if (active != Primary.Handle && active != secondary.Handle) throw new InvalidOperationException("Recorder is not foreground.");
                    RecorderNative.TriggerEmergency();
                }
                else if (operation != "status" && operation != "close") throw new ArgumentException("Unknown operation.");
                Dictionary<string, object> status = State("recorder_status");
                status["ok"] = true;
                status["op"] = operation;
                if (requestId != null) status["id"] = requestId;
                output.Emit(status);
                if (operation == "close") Primary.Close();
            }
            catch
            {
                Dictionary<string, object> status = State("recorder_status");
                status["ok"] = false;
                status["reason"] = "invalid_or_unavailable_control";
                if (operation != null) status["op"] = operation;
                if (requestId != null) status["id"] = requestId;
                output.Emit(status);
            }
        }

        static int Integer(Dictionary<string, object> command, string field, int minimum, int maximum)
        {
            object value;
            if (!command.TryGetValue(field, out value) || !(value is int)) throw new ArgumentException("Integer required.");
            int result = (int)value;
            if (result < minimum || result > maximum) throw new ArgumentException("Out of range.");
            return result;
        }

        static void Focus(Form window)
        {
            if (!window.Visible) window.Show();
            window.WindowState = FormWindowState.Normal;
            window.BringToFront();
            window.Activate();
            RecorderNative.SetForegroundWindow(window.Handle);
        }

        public void Dispose()
        {
            timer.Dispose();
            secondary.Dispose();
            Primary.Dispose();
            output.Stop();
        }
    }

    sealed class RecorderForm : Form
    {
        readonly RecorderContext context;
        public readonly string WindowName;
        public RecorderForm(RecorderContext context, string name, int width, int height)
        {
            this.context = context;
            WindowName = name;
            Text = "WoW Jev Input Recorder - " + name;
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(width, height);
            MinimumSize = new Size(160, 160);
            KeyPreview = true;
            DoubleBuffered = true;
        }
        protected override bool IsInputKey(Keys keyData) { return true; }
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            args.Graphics.Clear(WindowName == "primary" ? Color.FromArgb(22, 37, 57) : Color.FromArgb(54, 43, 39));
            using (Brush brush = new SolidBrush(Color.White))
            {
                args.Graphics.DrawString("WoW Jev 输入测试 / " + WindowName, Font, brush, 24, 24);
                args.Graphics.DrawString("专用键鼠测试窗口\n按键、鼠标操作会记录在测试日志中。\n急停：Ctrl + Alt + F10\n测试仅面向这两个记录窗口。", Font, brush, 24, 70);
            }
        }
        protected override void WndProc(ref Message message)
        {
            int kind = message.Msg;
            if (kind == 0x0100 || kind == 0x0101 || kind == 0x0104 || kind == 0x0105)
            {
                long bits = message.LParam.ToInt64();
                context.Record(this, new Dictionary<string, object> {
                    { "event", kind == 0x0100 || kind == 0x0104 ? "key_down" : "key_up" },
                    { "vk", message.WParam.ToInt32() }, { "scan_code", (int)((bits >> 16) & 255) },
                    { "extended", (bits & (1L << 24)) != 0 }, { "repeat", (bits & (1L << 30)) != 0 }
                });
            }
            else if (kind >= 0x0200 && kind <= 0x020A && kind != 0x0203 && kind != 0x0206 && kind != 0x0209)
            {
                int x = (short)(message.LParam.ToInt64() & 65535);
                int y = (short)((message.LParam.ToInt64() >> 16) & 65535);
                Dictionary<string, object> record = new Dictionary<string, object>();
                if (kind == 0x0200) record["event"] = "mouse_move";
                else if (kind == 0x020A)
                {
                    Point client = PointToClient(new Point(x, y)); x = client.X; y = client.Y;
                    record["event"] = "wheel";
                    record["delta"] = (short)((message.WParam.ToInt64() >> 16) & 65535);
                }
                else
                {
                    record["event"] = kind == 0x0201 || kind == 0x0204 || kind == 0x0207 ? "mouse_down" : "mouse_up";
                    record["button"] = kind == 0x0201 || kind == 0x0202 ? "left" : (kind == 0x0204 || kind == 0x0205 ? "right" : "middle");
                }
                record["x"] = x; record["y"] = y;
                context.Record(this, record);
            }
            base.WndProc(ref message);
        }
    }

    sealed class JsonSink
    {
        readonly Queue<string> queue = new Queue<string>();
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        readonly Thread thread;
        long dropped;
        volatile bool stopping;
        public long Dropped { get { return Interlocked.Read(ref dropped); } }
        public JsonSink()
        {
            thread = new Thread(WriteLoop); thread.IsBackground = true; thread.Start();
        }
        public void Emit(Dictionary<string, object> message)
        {
            string text = new JavaScriptSerializer().Serialize(message);
            lock (queue)
            {
                if (queue.Count >= 2048) { Interlocked.Increment(ref dropped); return; }
                queue.Enqueue(text);
            }
            wake.Set();
        }
        void WriteLoop()
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            while (true)
            {
                wake.WaitOne();
                while (true)
                {
                    string text;
                    lock (queue) { if (queue.Count == 0) break; text = queue.Dequeue(); }
                    try { Console.Out.WriteLine(text); Console.Out.Flush(); } catch { }
                }
                if (stopping) return;
            }
        }
        public void Stop()
        {
            stopping = true;
            wake.Set();
            // A broken/unread pipe must not keep the recorder alive either.
            thread.Join(100);
        }
    }

    static string Hex(IntPtr handle) { return "0x" + handle.ToInt64().ToString("x"); }

    static class RecorderNative
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int virtualKey);
        [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long value);
        [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
        static readonly long frequency = GetFrequency();
        [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Keyboard Key; [FieldOffset(0)] public Mouse Mouse; }
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public Union Data; }

        public static void EnableDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }
        static long GetFrequency()
        {
            long value;
            if (!QueryPerformanceFrequency(out value) || value <= 0) throw new InvalidOperationException("QPC unavailable.");
            return value;
        }
        public static long NowMs
        {
            get
            {
                long value;
                if (!QueryPerformanceCounter(out value)) throw new InvalidOperationException("QPC unavailable.");
                return value / frequency * 1000 + value % frequency * 1000 / frequency;
            }
        }
        public static bool IsKeyDown(string name)
        {
            int vk = name == "W" ? 0x57 : name == "SPACE" ? 0x20 : name == "CTRL" ? 0x11 :
                name == "SHIFT" ? 0x10 : name == "ALT" ? 0x12 : name == "F10" ? 0x79 : 0;
            if (vk == 0) throw new ArgumentException("Unsupported state key.");
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }
        public static bool IsMouseDown(int button)
        { return (GetAsyncKeyState(button == 1 ? 1 : button == 2 ? 2 : 4) & 0x8000) != 0; }
        public static string WindowClassName(IntPtr hwnd)
        {
            StringBuilder value = new StringBuilder(256);
            GetClassName(hwnd, value, value.Capacity);
            return value.ToString();
        }
        static Input Key(ushort scan, bool up)
        {
            Input input = new Input(); input.Type = 1; input.Data.Key.Scan = scan;
            input.Data.Key.Flags = 0x0008u | (up ? 0x0002u : 0); return input;
        }
        public static void TriggerEmergency()
        {
            // Only explicit harness control calls this, with a harness foreground
            // and the chord initially UP. Do not release someone else's keys.
            foreach (string name in new string[] { "CTRL", "ALT", "F10" })
                if (IsKeyDown(name)) throw new InvalidOperationException("Emergency chord already down.");
            Input[] chord = { Key(0x1D, false), Key(0x38, false), Key(0x44, false), Key(0x44, true), Key(0x38, true), Key(0x1D, true) };
            uint inserted = 0;
            try
            {
                inserted = SendInput((uint)chord.Length, chord, Marshal.SizeOf(typeof(Input)));
                if (inserted != chord.Length) throw new InvalidOperationException("Emergency chord insertion failed.");
            }
            finally
            {
                if (inserted > 0)
                {
                    List<Input> ups = new List<Input>();
                    if (inserted >= 3) ups.Add(Key(0x44, true));
                    if (inserted >= 2) ups.Add(Key(0x38, true));
                    ups.Add(Key(0x1D, true));
                    SendInput((uint)ups.Count, ups.ToArray(), Marshal.SizeOf(typeof(Input)));
                }
            }
        }
    }
}
