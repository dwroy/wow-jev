// Synthetic read-only PrintWindow fixture. Never activates or sends input.
// C# 5 / Windows .NET Framework 4.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class EyeCaptureFixture
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static string Hex(IntPtr value) { return "0x" + value.ToInt64().ToString("x"); }

    sealed class Fixture : Form
    {
        readonly System.Windows.Forms.Timer lifetime = new System.Windows.Forms.Timer();
        readonly IntPtr foregroundBefore;
        public Fixture(IntPtr foreground)
        {
            foregroundBefore = foreground;
            Text = "WoW Eye Passive Fixture";
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(60, 60);
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(640, 400);
            DoubleBuffered = true;
            lifetime.Interval = 15000;
            lifetime.Tick += delegate { lifetime.Stop(); Close(); };
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams value = base.CreateParams;
                value.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                return value;
            }
        }
        protected override void OnShown(EventArgs args)
        {
            base.OnShown(args);
            Invalidate(); Update();
            Console.WriteLine(Json.Serialize(new Dictionary<string, object> {
                { "type", "fixture_ready" }, { "hwnd", Hex(Handle) },
                { "pid", Process.GetCurrentProcess().Id },
                { "client_width", ClientSize.Width }, { "client_height", ClientSize.Height },
                { "foreground_before_hwnd", Hex(foregroundBefore) },
                { "foreground_after_hwnd", Hex(GetForegroundWindow()) },
                { "show_without_activation", true }, { "auto_close_ms", 15000 }
            }));
            Console.Out.Flush();
            lifetime.Start();
            Thread reader = new Thread(delegate()
            {
                try { while (Console.In.ReadLine() != null) { } }
                catch { }
                try { BeginInvoke(new Action(Close)); }
                catch { }
            });
            reader.IsBackground = true;
            reader.Start();
        }
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            Graphics graphics = args.Graphics;
            graphics.Clear(Color.FromArgb(24, 48, 80));
            for (int y = 0; y < 8; y++)
            for (int x = 0; x < 12; x++)
            {
                Color color = Color.FromArgb((x * 31 + y * 47 + 30) % 256, (x * 13 + y * 61 + 50) % 256, (x * 53 + y * 19 + 80) % 256);
                using (SolidBrush brush = new SolidBrush(color))
                    graphics.FillRectangle(brush, x * 48 + 18, y * 40 + 30, 44, 36);
            }
            using (Pen pen = new Pen(Color.White, 5)) graphics.DrawEllipse(pen, 200, 85, 170, 170);
            using (Font font = new Font(FontFamily.GenericSansSerif, 18))
                graphics.DrawString("Synthetic read-only capture fixture", font, Brushes.White, 20, 355);
        }
        protected override void OnFormClosed(FormClosedEventArgs args)
        {
            lifetime.Stop();
            Console.WriteLine(Json.Serialize(new Dictionary<string, object> {
                { "type", "fixture_stopped" }, { "pid", Process.GetCurrentProcess().Id },
                { "foreground_after_hwnd", Hex(GetForegroundWindow()) }
            }));
            Console.Out.Flush();
            base.OnFormClosed(args);
        }
        protected override void Dispose(bool disposing)
        { if (disposing) lifetime.Dispose(); base.Dispose(disposing); }
    }

    [STAThread]
    static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        IntPtr foreground = GetForegroundWindow();
        Application.EnableVisualStyles();
        using (Fixture fixture = new Fixture(foreground)) Application.Run(fixture);
        return 0;
    }
}
