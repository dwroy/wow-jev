// Dedicated stage-three acceptance UI. C# 5 / .NET Framework 4.
// Never sends OS input; activation requires an explicit stdin control.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class PlayFixture
{
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static string Hex(IntPtr value) { return "0x" + value.ToInt64().ToString("x"); }
    static long Now { get { return Clock.ElapsedMilliseconds; } }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            int interval = 100, lifetime = 300000;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--state-interval-ms" && ++i < args.Length) interval = int.Parse(args[i]);
                else if (args[i] == "--lifetime-ms" && ++i < args.Length) lifetime = int.Parse(args[i]);
                else throw new ArgumentException("Unknown or missing argument.");
            }
            if (interval < 20 || interval > 1000 || lifetime < 5000 || lifetime > 900000) throw new ArgumentException("Argument out of range.");
            Console.InputEncoding = new UTF8Encoding(false);
            Native.EnableDpi();
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (Context context = new Context(interval, lifetime)) Application.Run(context.Primary);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "type", "fixture_error" }, { "reason", "initialization_or_ui_failure" }, { "error_type", error.GetType().FullName }
            }));
            return 2;
        }
    }

    sealed class Context : IDisposable
    {
        public readonly FixtureForm Primary;
        readonly FixtureForm secondary;
        readonly Sink output = new Sink();
        readonly Dictionary<string, long> counts = new Dictionary<string, long>();
        readonly HashSet<string> eventKeys = new HashSet<string>();
        readonly HashSet<string> eventButtons = new HashSet<string>();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer lifetime = new System.Windows.Forms.Timer();
        readonly IntPtr foregroundBefore;
        IntPtr primaryHwnd, secondaryHwnd;
        long sequence, toggles, settings;
        int pendingControls;
        volatile bool closing;
        bool ready;
        public bool InventoryOpen;
        public long ToggleCount { get { return toggles; } }

        public Context(int interval, int lifetimeMs)
        {
            foregroundBefore = Native.GetForegroundWindow();
            foreach (string name in new[] { "key_down", "key_down_new", "key_up", "mouse_down", "mouse_up", "mouse_move", "wheel" }) counts[name] = 0;
            Primary = new FixtureForm(this, "primary", 800, 600);
            secondary = new FixtureForm(this, "secondary", 360, 240);
            Primary.Location = new Point(30, 30);
            secondary.Location = new Point(860, 30);
            Primary.Shown += delegate
            {
                secondary.Show();
                Primary.Invalidate(); Primary.Update(); secondary.Invalidate(); secondary.Update();
                primaryHwnd = Primary.Handle; secondaryHwnd = secondary.Handle;
                ready = true;
                Dictionary<string, object> message = State("fixture_ready");
                message["hwnd"] = Hex(primaryHwnd); message["secondary_hwnd"] = Hex(secondaryHwnd);
                message["foreground_before_hwnd"] = Hex(foregroundBefore);
                message["foreground_after_hwnd"] = Hex(Native.GetForegroundWindow());
                message["show_without_activation"] = true;
                message["auto_close_ms"] = lifetimeMs;
                message["inventory_roi"] = new Dictionary<string, int> { { "x", 700 }, { "y", 480 }, { "width", 64 }, { "height", 64 } };
                message["state_source"] = "dedicated_test_ui";
                output.Emit(message);
                timer.Start(); lifetime.Start();
                Thread reader = new Thread(ReadControls); reader.IsBackground = true; reader.Start();
            };
            Primary.FormClosing += delegate
            {
                if (closing) return;
                closing = true; timer.Stop(); lifetime.Stop();
                output.Emit(State("fixture_closing"));
                if (!secondary.IsDisposed) secondary.Close();
            };
            Primary.FormClosed += delegate { output.Emit(State("fixture_stopped")); };
            secondary.FormClosing += delegate(object sender, FormClosingEventArgs args)
            {
                if (!closing) { args.Cancel = true; secondary.Hide(); }
            };
            timer.Interval = interval;
            timer.Tick += delegate { output.Emit(State("fixture_state")); };
            lifetime.Interval = lifetimeMs;
            lifetime.Tick += delegate { lifetime.Stop(); Primary.Close(); };
        }

        public void Record(FixtureForm window, Dictionary<string, object> message)
        {
            if (!ready || closing) return;
            string kind = (string)message["event"];
            counts[kind]++;
            bool changed = false;
            if (kind == "key_down")
            {
                string key = (string)message["key"];
                bool repeat = (bool)message["repeat"];
                eventKeys.Add(key);
                if (!repeat)
                {
                    counts["key_down_new"]++;
                    if (window.WindowName == "primary" && key == "B") { InventoryOpen = !InventoryOpen; toggles++; changed = true; }
                }
            }
            else if (kind == "key_up") eventKeys.Remove((string)message["key"]);
            else if (kind == "mouse_down") eventButtons.Add((string)message["button"]);
            else if (kind == "mouse_up") eventButtons.Remove((string)message["button"]);
            message["type"] = "input_event";
            message["window"] = window.WindowName;
            message["hwnd"] = Hex(window.Handle);
            message["seq"] = sequence++;
            message["at_ms"] = Now;
            message["clock_domain"] = "fixture-stopwatch";
            message["inventory_open"] = InventoryOpen;
            message["inventory_toggled"] = changed;
            output.Emit(message);
            if (changed) { Primary.Invalidate(); Primary.Update(); }
        }

        Dictionary<string, object> State(string type)
        {
            Dictionary<string, object> keys = new Dictionary<string, object>();
            foreach (string key in Native.CanonicalKeys) keys[key] = Native.IsDown(Native.KeyCode(key));
            Dictionary<string, object> buttons = new Dictionary<string, object> {
                { "left", Native.IsDown(1) }, { "right", Native.IsDown(2) }, { "middle", Native.IsDown(4) }
            };
            IntPtr foreground = Native.GetForegroundWindow();
            string active = foreground == primaryHwnd && primaryHwnd != IntPtr.Zero ? "primary" :
                (foreground == secondaryHwnd && secondaryHwnd != IntPtr.Zero ? "secondary" : "other");
            return new Dictionary<string, object> {
                { "type", type }, { "pid", Process.GetCurrentProcess().Id }, { "at_ms", Now }, { "clock_domain", "fixture-stopwatch" },
                { "focused", active == "primary" }, { "active_window", active }, { "foreground_hwnd", Hex(foreground) },
                { "keys", keys }, { "buttons", buttons }, { "key_state_source", "windows-getasynckeystate" },
                { "event_held_keys", Sorted(eventKeys) }, { "event_held_buttons", Sorted(eventButtons) },
                { "event_held_source", "received_events_not_executor_ownership" },
                { "counts", new Dictionary<string, long>(counts) }, { "output_dropped", output.Dropped },
                { "inventory_open", InventoryOpen }, { "inventory_toggle_count", toggles }, { "inventory_set_count", settings },
                { "inventory_source", "dedicated_test_ui" }, { "client_width", 800 }, { "client_height", 600 }
            };
        }
        static string[] Sorted(HashSet<string> values) { string[] result = new string[values.Count]; values.CopyTo(result); Array.Sort(result, StringComparer.Ordinal); return result; }

        // Bound memory before parsing, including lines larger than the limit.
        bool ReadLine(out string line, out bool oversized)
        {
            StringBuilder value = new StringBuilder(256); oversized = false;
            while (true)
            {
                int next = Console.In.Read();
                if (next == -1) { line = value.ToString(); return value.Length != 0 || oversized; }
                if (next == '\n') { line = value.ToString().TrimEnd('\r'); return true; }
                if (value.Length >= 4096) oversized = true;
                else if (!oversized) value.Append((char)next);
            }
        }
        void ReadControls()
        {
            try
            {
                string line; bool oversized;
                while (!closing && ReadLine(out line, out oversized))
                {
                    if (oversized || Encoding.UTF8.GetByteCount(line) > 4096) { Error("control_too_large"); continue; }
                    if (Interlocked.Increment(ref pendingControls) > 32) { Interlocked.Decrement(ref pendingControls); Error("control_queue_full"); continue; }
                    string captured = line;
                    try
                    {
                        Primary.BeginInvoke((Action)delegate
                        {
                            try { if (!closing) Control(captured); }
                            finally { Interlocked.Decrement(ref pendingControls); }
                        });
                    }
                    catch (InvalidOperationException) { Interlocked.Decrement(ref pendingControls); return; }
                }
            }
            catch { Error("control_read_failed"); }
            if (!closing)
            {
                try { Primary.BeginInvoke((Action)delegate { Primary.Close(); }); }
                catch (InvalidOperationException) { }
            }
        }
        void Error(string reason)
        { output.Emit(new Dictionary<string, object> { { "type", "fixture_status" }, { "ok", false }, { "reason", reason }, { "at_ms", Now } }); }

        void Control(string text)
        {
            object id = null; string op = null;
            try
            {
                JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 4096; json.RecursionLimit = 8;
                Dictionary<string, object> command = json.Deserialize<Dictionary<string, object>>(text);
                if (command == null || !command.ContainsKey("op") || !(command["op"] is string)) throw new ArgumentException();
                op = command["op"] as string;
                if (command.ContainsKey("id"))
                {
                    string requestId = command["id"] as string;
                    if (String.IsNullOrEmpty(requestId) || requestId.Length > 128) throw new ArgumentException();
                    id = requestId;
                }
                foreach (string field in command.Keys)
                    if (field != "op" && field != "id" && !(op == "set_inventory" && field == "value")) throw new ArgumentException();
                if (op == "focus_primary") Focus(Primary);
                else if (op == "focus_secondary") Focus(secondary);
                else if (op == "set_inventory")
                {
                    if (!command.ContainsKey("value") || !(command["value"] is bool)) throw new ArgumentException();
                    InventoryOpen = (bool)command["value"]; settings++;
                    Primary.Invalidate(); Primary.Update();
                }
                else if (op != "status" && op != "close") throw new ArgumentException();
                Dictionary<string, object> result = State("fixture_status");
                result["ok"] = true; result["op"] = op;
                if (id != null) result["id"] = id;
                output.Emit(result);
                if (op == "close") Primary.Close();
            }
            catch
            {
                Dictionary<string, object> result = State("fixture_status");
                result["ok"] = false; result["reason"] = "invalid_or_unavailable_control";
                if (id != null) result["id"] = id;
                output.Emit(result);
            }
        }
        static void Focus(Form window)
        {
            if (!window.Visible) window.Show();
            window.WindowState = FormWindowState.Normal;
            window.BringToFront(); window.Activate(); Native.SetForegroundWindow(window.Handle);
            if (Native.GetForegroundWindow() != window.Handle) throw new InvalidOperationException("Focus unavailable.");
        }
        public void Dispose()
        {
            timer.Dispose(); lifetime.Dispose(); secondary.Dispose(); Primary.Dispose(); output.Stop();
        }
    }

    sealed class FixtureForm : Form
    {
        readonly Context context;
        public readonly string WindowName;
        public FixtureForm(Context context, string name, int width, int height)
        {
            this.context = context; WindowName = name;
            Text = "WoW Jev Play Fixture - " + name;
            AutoScaleMode = AutoScaleMode.None; ClientSize = new Size(width, height);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.Manual; KeyPreview = true; DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override bool IsInputKey(Keys keyData) { return true; }
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            Graphics graphics = args.Graphics;
            graphics.Clear(Color.FromArgb(115, 147, 177));
            for (int y = 0; y < ClientSize.Height; y += 40)
            for (int x = 0; x < ClientSize.Width; x += 40)
            {
                Color color = Color.FromArgb(80 + (x / 40 * 17 + y / 40 * 13) % 130, 90 + (x / 40 * 29 + y / 40 * 7) % 130, 100 + (x / 40 * 11 + y / 40 * 31) % 120);
                using (Brush brush = new SolidBrush(color)) graphics.FillRectangle(brush, x + 2, y + 2, 35, 35);
            }
            using (Font font = new Font(FontFamily.GenericSansSerif, 16))
            {
                graphics.FillRectangle(Brushes.White, 20, 20, ClientSize.Width - 40, 130);
                graphics.DrawString("Dedicated play acceptance / " + WindowName, font, Brushes.Black, 30, 28);
                graphics.DrawString("No default activation. Explicit stdin focus only.\nE / SPACE / right drag record inputs only.", font, Brushes.Black, 30, 60);
                if (WindowName == "primary") graphics.DrawString("Inventory: " + (context.InventoryOpen ? "OPEN" : "CLOSED") + "   B toggles: " + context.ToggleCount, font, Brushes.Black, 30, 112);
            }
            if (WindowName == "primary")
            {
                Rectangle marker = new Rectangle(700, 480, 64, 64);
                using (Brush brush = new SolidBrush(context.InventoryOpen ? Color.FromArgb(255, 160, 20) : Color.FromArgb(16, 35, 90))) graphics.FillRectangle(brush, marker);
                if (context.InventoryOpen)
                {
                    graphics.FillEllipse(Brushes.White, 710, 490, 44, 44);
                    using (Pen pen = new Pen(Color.FromArgb(255, 160, 20), 6)) { graphics.DrawLine(pen, 732, 492, 732, 532); graphics.DrawLine(pen, 712, 512, 752, 512); }
                }
                else
                {
                    using (Pen pen = new Pen(Color.FromArgb(35, 70, 135), 5))
                    {
                        graphics.DrawRectangle(pen, 709, 489, 46, 46);
                        graphics.DrawLine(pen, 710, 490, 754, 534); graphics.DrawLine(pen, 754, 490, 710, 534);
                    }
                }
            }
        }
        protected override void WndProc(ref Message message)
        {
            int kind = message.Msg;
            if (kind == 0x0100 || kind == 0x0101 || kind == 0x0104 || kind == 0x0105)
            {
                long bits = message.LParam.ToInt64(); int vk = message.WParam.ToInt32();
                context.Record(this, new Dictionary<string, object> {
                    { "event", kind == 0x0100 || kind == 0x0104 ? "key_down" : "key_up" },
                    { "key", Native.KeyName(vk) }, { "vk", vk }, { "scan_code", (int)((bits >> 16) & 255) },
                    { "extended", (bits & (1L << 24)) != 0 }, { "repeat", (bits & (1L << 30)) != 0 }
                });
            }
            else if (kind >= 0x0200 && kind <= 0x020A)
            {
                int x = (short)(message.LParam.ToInt64() & 65535), y = (short)((message.LParam.ToInt64() >> 16) & 65535);
                Dictionary<string, object> item = new Dictionary<string, object>();
                if (kind == 0x0200) { item["event"] = "mouse_move"; item["buttons_mask"] = (int)(message.WParam.ToInt64() & 0x0013); }
                else if (kind == 0x020A)
                {
                    Point client = PointToClient(new Point(x, y)); x = client.X; y = client.Y;
                    item["event"] = "wheel"; item["delta"] = (short)((message.WParam.ToInt64() >> 16) & 65535);
                }
                else
                {
                    bool doubleClick = kind == 0x0203 || kind == 0x0206 || kind == 0x0209;
                    item["event"] = kind == 0x0201 || kind == 0x0204 || kind == 0x0207 || doubleClick ? "mouse_down" : "mouse_up";
                    item["button"] = kind >= 0x0201 && kind <= 0x0203 ? "left" : (kind >= 0x0204 && kind <= 0x0206 ? "right" : "middle");
                    item["double_click"] = doubleClick;
                }
                item["x"] = x; item["y"] = y; context.Record(this, item);
            }
            base.WndProc(ref message);
        }
    }

    sealed class Sink
    {
        readonly Queue<string> queue = new Queue<string>();
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        readonly Thread writer;
        long dropped;
        volatile bool stopping;
        public long Dropped { get { return Interlocked.Read(ref dropped); } }
        public Sink() { writer = new Thread(WriteLoop); writer.IsBackground = true; writer.Start(); }
        public void Emit(Dictionary<string, object> item)
        {
            string text = new JavaScriptSerializer().Serialize(item);
            lock (queue)
            {
                if (stopping || queue.Count >= 2048) { Interlocked.Increment(ref dropped); return; }
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
                    string value;
                    lock (queue) { if (queue.Count == 0) break; value = queue.Dequeue(); }
                    try { Console.Out.WriteLine(value); Console.Out.Flush(); }
                    catch { Interlocked.Increment(ref dropped); }
                }
                if (stopping) return;
            }
        }
        public void Stop() { stopping = true; wake.Set(); writer.Join(100); }
    }

    static class Native
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int virtualKey);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        public static readonly string[] CanonicalKeys = MakeKeys();
        static string[] MakeKeys()
        {
            List<string> keys = new List<string>();
            for (char key = 'A'; key <= 'Z'; key++) keys.Add(key.ToString());
            for (char key = '0'; key <= '9'; key++) keys.Add(key.ToString());
            for (int key = 1; key <= 12; key++) keys.Add("F" + key);
            keys.AddRange(new[] { "SPACE", "SHIFT", "CTRL", "ALT", "ESC", "TAB", "ENTER", "BACKSPACE", "UP", "DOWN", "LEFT", "RIGHT" });
            return keys.ToArray();
        }
        public static void EnableDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }
        public static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
        public static int KeyCode(string key)
        {
            if (key.Length == 1) return key[0];
            if (key.StartsWith("F", StringComparison.Ordinal)) return 0x6F + int.Parse(key.Substring(1));
            switch (key)
            {
                case "SPACE": return 0x20; case "SHIFT": return 0x10; case "CTRL": return 0x11; case "ALT": return 0x12;
                case "ESC": return 0x1B; case "TAB": return 0x09; case "ENTER": return 0x0D; case "BACKSPACE": return 0x08;
                case "UP": return 0x26; case "DOWN": return 0x28; case "LEFT": return 0x25; case "RIGHT": return 0x27;
                default: throw new ArgumentException("Unsupported key.");
            }
        }
        public static string KeyName(int vk)
        {
            foreach (string key in CanonicalKeys) if (KeyCode(key) == vk) return key;
            return "VK_" + vk.ToString("X2");
        }
    }
}
