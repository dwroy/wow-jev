// WinSnap：列出可见窗口 / 截取指定窗口，给慢系统"看一眼"用。只读窗口内容，不发送任何输入。
//
//   WinSnap.exe list
//   WinSnap.exe snap <0x句柄 | 标题片段> <out.png|out.jpg> [--client] [--screen]
//     默认用 PrintWindow(PW_RENDERFULLCONTENT)，窗口被遮挡也能截；--screen 改为从屏幕拷贝（窗口须在最前）
//     --client 只要客户区（去掉标题栏和边框）；输出扩展名为 .jpg 时存 JPEG（质量 90），比 PNG 快得多
//
// 语法限制：C# 5（csc 4.0.30319），不能用 $""、?.、=>、nameof。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

static class WinSnap
{
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static string Proc(IntPtr h)
    {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "pid" + pid; }
    }

    // 真正可见的顶层窗口：可见、未最小化、未被隐藏（cloaked，如后台 UWP）、有标题、有面积
    static List<IntPtr> Windows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsIconic(h) || Text(h).Length == 0) return true;
            int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            RECT r; GetWindowRect(h, out r);
            if (r.R - r.L < 50 || r.B - r.T < 50) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static RECT Bounds(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);  // 9 = 去掉隐形边框的外框
        return r;
    }

    static int Main(string[] a)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (a.Length >= 1 && a[0] == "list")
        {
            foreach (IntPtr h in Windows())
            {
                RECT r = Bounds(h);
                Console.WriteLine(string.Format("{{\"hwnd\":\"0x{0:x}\",\"proc\":\"{1}\",\"class\":\"{2}\",\"w\":{3},\"h\":{4},\"title\":\"{5}\"}}",
                    h.ToInt64(), Esc(Proc(h)), Esc(Cls(h)), r.R - r.L, r.B - r.T, Esc(Text(h))));
            }
            return 0;
        }
        if (a.Length >= 3 && a[0] == "snap")
        {
            Stopwatch sw = Stopwatch.StartNew();
            IntPtr hwnd = IntPtr.Zero;
            if (a[1].StartsWith("0x")) hwnd = new IntPtr(Convert.ToInt64(a[1].Substring(2), 16));
            else foreach (IntPtr h in Windows()) if (Text(h).IndexOf(a[1], StringComparison.OrdinalIgnoreCase) >= 0) { hwnd = h; break; }
            if (hwnd == IntPtr.Zero) { Console.WriteLine("{\"error\":\"找不到窗口\"}"); return 1; }
            bool client = Array.IndexOf(a, "--client") >= 0, screen = Array.IndexOf(a, "--screen") >= 0;
            RECT wr; GetWindowRect(hwnd, out wr);
            RECT crop = Bounds(hwnd);
            if (client)
            {
                RECT c; GetClientRect(hwnd, out c);
                POINT o = new POINT(); ClientToScreen(hwnd, ref o);
                crop.L = o.X; crop.T = o.Y; crop.R = o.X + c.R; crop.B = o.Y + c.B;
            }
            int w = crop.R - crop.L, hh = crop.B - crop.T;
            Bitmap outBmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(outBmp))
            {
                if (screen) g.CopyFromScreen(crop.L, crop.T, 0, 0, new Size(w, hh));
                else
                {
                    using (Bitmap full = new Bitmap(wr.R - wr.L, wr.B - wr.T, PixelFormat.Format32bppArgb))
                    {
                        using (Graphics fg = Graphics.FromImage(full))
                        {
                            IntPtr dc = fg.GetHdc();
                            PrintWindow(hwnd, dc, 2);  // 2 = PW_RENDERFULLCONTENT，能截到硬件加速内容
                            fg.ReleaseHdc(dc);
                        }
                        g.DrawImage(full, new Rectangle(0, 0, w, hh), new Rectangle(crop.L - wr.L, crop.T - wr.T, w, hh), GraphicsUnit.Pixel);
                    }
                }
            }
            double capMs = sw.Elapsed.TotalMilliseconds;
            if (a[2].EndsWith(".jpg", StringComparison.OrdinalIgnoreCase))
            {
                ImageCodecInfo jpeg = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
                outBmp.Save(a[2], jpeg, ep);
            }
            else outBmp.Save(a[2], ImageFormat.Png);
            Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"hwnd\":\"0x{0:x}\",\"title\":\"{1}\",\"w\":{2},\"h\":{3},\"mode\":\"{4}\",\"cap_ms\":{5:0.0},\"total_ms\":{6:0.0},\"file\":\"{7}\"}}",
                hwnd.ToInt64(), Esc(Text(hwnd)), w, hh, screen ? "screen" : "printwindow", capMs, sw.Elapsed.TotalMilliseconds, Esc(a[2])));
            return 0;
        }
        Console.Error.WriteLine("用法：WinSnap.exe list | snap <0x句柄|标题片段> <out.png|out.jpg> [--client] [--screen]");
        return 2;
    }
}
