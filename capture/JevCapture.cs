// JevCapture：像素桥 v1 的 Windows 侧截屏 + 解码器。只做定位、读档位、校验 CRC，不解析载荷字段。
// 仅用于本地自建服务器的研究实验。只截取窗口客户区左上角的一小块，不做任何键鼠输入。
//
//   JevCapture.exe --image <png>...  [--repeat N]
//   JevCapture.exe --live  [--title T] [--class C] [--w 640] [--h 32] [--poll 1] [--stats 10]
//   JevCapture.exe --show  <png>... [--x 100] [--y 100] [--interval 33] [--title T]
//
// 语法限制：C# 5（csc 4.0.30319），不能用 $""、?.、=>、nameof。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace JevCapture
{
    static class Native
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr hwnd, ref POINT pt);
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("winmm.dll")]
        public static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")]
        public static extern uint timeEndPeriod(uint ms);

        public const uint SRCCOPY = 0x00CC0020;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
            public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
            public uint biClrUsed; public uint biClrImportant;
        }

        // 先声明 Per-Monitor V2（-4），老系统没有这个接口时退回 SetProcessDPIAware
        public static string EnableDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per_monitor_v2";
            }
            catch (EntryPointNotFoundException) { }
            return SetProcessDPIAware() ? "system_aware" : "unaware";
        }
    }

    class Result
    {
        public bool Ok;
        public string Reason = "no_sync";
        public int Rank;          // 失败时用来挑“最接近成功”的候选：crc > len > magic > sync > no_sync
        public int Seq = -1, Ver = -1, Len = -1;
        public byte[] Payload;
        public double Pitch, X0, Y0;
        public int MaxErr = -1;
    }

    // BGRA 像素，自上而下
    class Pixels
    {
        public byte[] Data; public int W, H, Stride;
        public Pixels(byte[] data, int w, int h, int stride) { Data = data; W = w; H = h; Stride = stride; }
        public int Ch(int x, int y, int c) { return Data[y * Stride + x * 4 + (2 - c)]; }  // c: 0=R 1=G 2=B
        public double Mean(int x, int y)
        {
            int i = y * Stride + x * 4;
            return (Data[i] + Data[i + 1] + Data[i + 2]) / 3.0;
        }
    }

    static class Decoder
    {
        const int COLUMNS = 128, SYNC = 8, HEADER = 6, MAX_LEN = 4096;
        const double WHITE = 128.0;

        public static Result Decode(Pixels px)
        {
            Result best = new Result();
            List<double[]> tried = new List<double[]>();
            double[] m = new double[px.W];
            List<int> starts = new List<int>();
            for (int y = 0; y < px.H; y++)
            {
                for (int x = 0; x < px.W; x++) m[x] = px.Mean(x, y);
                starts.Clear();
                for (int x = 0; x < px.W; x++)
                    if (x == 0 || (m[x] >= WHITE) != (m[x - 1] >= WHITE)) starts.Add(x);
                for (int k = 0; k + 7 < starts.Count; k++)
                {
                    if (m[starts[k]] < WHITE) continue;
                    // 格距：规格是 (第 8 段起点 − 第 1 段起点)/7；第 1 段左侧可能是亮背景，改用第 2–8 段起点
                    double[] e = new double[8];
                    for (int j = 0; j < 8; j++) e[j] = Crossing(m, starts[k + j]);
                    double p = (e[7] - e[1]) / 6.0;
                    if (p < 1.5 || p > 40) continue;
                    bool good = true;
                    for (int j = 1; j < 7 && good; j++)
                    {
                        double len = e[j + 1] - e[j];
                        if (len < 0.55 * p || len > 1.45 * p) good = false;
                    }
                    if (!good) continue;
                    double x0 = e[1] - p;
                    // 行的上下边界：在 8 个同步格中心各测一次。随机背景可能让某一列向外延伸，
                    // 延伸只会让上边界变小、下边界变大，所以上边界取最大、下边界取最小
                    double top = double.MinValue, bottom = double.MaxValue;
                    for (int j = 0; j < 8; j++)
                    {
                        int xc = (int)Math.Round(x0 + (j + 0.5) * p);
                        bool white = j % 2 == 0;
                        if (xc < 0 || xc >= px.W || (px.Mean(xc, y) >= WHITE) != white) continue;
                        double t0, b0;
                        VerticalEdges(px, xc, y, white, out t0, out b0);
                        if (t0 > top) top = t0;
                        if (b0 < bottom) bottom = b0;
                    }
                    if (top == double.MinValue) continue;
                    double h = bottom - top;
                    if (h < 0.55 * p || h > 1.45 * p) continue;
                    double yc = (top + bottom) / 2.0;
                    bool dup = false;
                    foreach (double[] t in tried)
                        if (Math.Abs(t[0] - x0) < 1.0 && Math.Abs(t[1] - yc) < 0.5 * p) { dup = true; break; }
                    if (dup) continue;
                    tried.Add(new double[] { x0, yc });
                    Result r = TryDecode(px, x0, p, yc);
                    if (r.Ok) return r;
                    if (r.Rank > best.Rank) best = r;
                }
            }
            return best;
        }

        // 第 s 个像素开始的新段，其左边界的亚像素位置（阈值 128 处线性插值）
        static double Crossing(double[] m, int s)
        {
            if (s <= 0) return -0.5;
            double a = m[s - 1], b = m[s];
            if (a == b) return s - 0.5;
            return s - 1 + (WHITE - a) / (b - a);
        }

        // 从 (x, y) 沿竖直方向找同类（白或黑）像素段的上下边界，亚像素
        static void VerticalEdges(Pixels px, int x, int y, bool white, out double top, out double bottom)
        {
            int t = y;
            while (t > 0 && (px.Mean(x, t - 1) >= WHITE) == white) t--;
            if (t == 0) top = -0.5;
            else { double a = px.Mean(x, t - 1), b = px.Mean(x, t); top = t - 1 + (WHITE - a) / (b - a); }
            int u = y;
            while (u + 1 < px.H && (px.Mean(x, u + 1) >= WHITE) == white) u++;
            if (u == px.H - 1) bottom = px.H - 0.5;
            else { double a = px.Mean(x, u), b = px.Mean(x, u + 1); bottom = u + (a - WHITE) / (a - b); }
        }

        static void Fit(List<double> ks, List<double> xs, ref double x0, ref double p)
        {
            int n = ks.Count;
            if (n < 2) return;
            double sk = 0, sx = 0, skk = 0, skx = 0;
            for (int i = 0; i < n; i++) { sk += ks[i]; sx += xs[i]; skk += ks[i] * ks[i]; skx += ks[i] * xs[i]; }
            double d = n * skk - sk * sk;
            if (d == 0) return;
            p = (n * skx - sk * sx) / d;
            x0 = (sx - p * sk) / n;
        }

        // 用行内的格边界精修 x0 和格距：同步格只有 8 个，直接外推到第 127 格误差会放大十几倍
        static void Refine(Pixels px, int yr, int cellsInRow, ref double x0, ref double p)
        {
            List<double> ks = new List<double>(), xs = new List<double>();
            for (int k = 1; k < cellsInRow; k++)
            {
                double b = x0 + k * p;
                int lo = (int)Math.Ceiling(b - 0.45 * p + 0.5), hi = (int)Math.Floor(b + 0.45 * p + 0.5);
                double wsum = 0, psum = 0;
                for (int x = Math.Max(1, lo); x <= Math.Min(px.W - 1, hi); x++)
                {
                    double w = 0;
                    for (int c = 0; c < 3; c++)
                    {
                        double d = Math.Abs(px.Ch(x, yr, c) - px.Ch(x - 1, yr, c)) - 12;
                        if (d > 0) w += d;
                    }
                    wsum += w; psum += w * (x - 0.5);
                }
                if (wsum >= 30) { ks.Add(k); xs.Add(psum / wsum); }
                if (k % 8 == 7) Fit(ks, xs, ref x0, ref p);
            }
            Fit(ks, xs, ref x0, ref p);
        }

        static bool Sample(Pixels px, double x0, double p, double yc, int cell, int[] lv, ref int maxErr)
        {
            int col = cell % COLUMNS, row = cell / COLUMNS;
            int sx = (int)Math.Round(x0 + (col + 0.5) * p), sy = (int)Math.Round(yc + row * p);
            if (sx < 0 || sy < 0 || sx >= px.W || sy >= px.H) return false;
            for (int c = 0; c < 3; c++)
            {
                int v = px.Ch(sx, sy, c);
                int l = (v + 8) / 17;
                if (l > 15) l = 15;
                int err = Math.Abs(v - l * 17);
                if (err > maxErr) maxErr = err;
                lv[c] = l;
            }
            return true;
        }

        // 读出第 8 格起的 nBytes 个字节
        static byte[] ReadBytes(Pixels px, double x0, double p, double yc, int nBytes, ref int maxErr)
        {
            int nibbles = nBytes * 2;
            int cells = (nibbles + 2) / 3;
            byte[] outb = new byte[nBytes];
            int[] lv = new int[3];
            int k = 0;
            for (int i = 0; i < cells; i++)
            {
                if (!Sample(px, x0, p, yc, SYNC + i, lv, ref maxErr)) return null;
                for (int c = 0; c < 3; c++, k++)
                {
                    if (k >= nibbles) break;
                    if (k % 2 == 0) outb[k / 2] = (byte)(lv[c] << 4);
                    else outb[k / 2] |= (byte)lv[c];
                }
            }
            return outb;
        }

        static Result TryDecode(Pixels px, double x0, double p, double yc)
        {
            Result r = new Result();
            r.Reason = "sync"; r.Rank = 1;
            r.Pitch = p; r.X0 = x0; r.Y0 = yc - 0.5 * p;
            int maxErr = 0;
            int[] lv = new int[3];
            for (int i = 0; i < SYNC; i++)
            {
                if (!Sample(px, x0, p, yc, i, lv, ref maxErr)) return r;
                int want = (i % 2 == 0) ? 15 : 0;
                if (lv[0] != want || lv[1] != want || lv[2] != want) return r;
            }
            byte[] head = ReadBytes(px, x0, p, yc, HEADER, ref maxErr);
            if (head == null) return r;
            r.MaxErr = maxErr;
            if (head[0] != 0x4A) { r.Reason = "magic"; r.Rank = 2; return r; }
            r.Ver = head[1];
            r.Seq = (head[2] << 8) | head[3];
            r.Len = (head[4] << 8) | head[5];
            r.Reason = "len"; r.Rank = 3;
            if (r.Len > MAX_LEN) return r;
            int total = HEADER + r.Len + 2;
            int cells = SYNC + (total * 2 + 2) / 3;
            int yr = (int)Math.Round(yc);
            if (yr < 0 || yr >= px.H) return r;
            Refine(px, yr, Math.Min(cells, COLUMNS), ref x0, ref p);
            r.Pitch = p; r.X0 = x0; r.Y0 = yc - 0.5 * p;
            maxErr = 0;
            for (int i = 0; i < SYNC; i++)
                if (!Sample(px, x0, p, yc, i, lv, ref maxErr)) return r;
            byte[] frame = ReadBytes(px, x0, p, yc, total, ref maxErr);
            if (frame == null) return r;
            r.MaxErr = maxErr;
            // 精修后头部可能读出不同的值，以整帧为准
            r.Ver = frame[1]; r.Seq = (frame[2] << 8) | frame[3];
            if (frame[0] != 0x4A || ((frame[4] << 8) | frame[5]) != r.Len) { r.Reason = "magic"; r.Rank = 2; return r; }
            int crc = Crc16(frame, HEADER + r.Len);
            if (crc != ((frame[total - 2] << 8) | frame[total - 1])) { r.Reason = "crc"; r.Rank = 4; return r; }
            r.Payload = new byte[r.Len];
            Array.Copy(frame, HEADER, r.Payload, 0, r.Len);
            r.Ok = true; r.Reason = ""; r.Rank = 5;
            return r;
        }

        static ushort[] table;
        public static int Crc16(byte[] data, int n)
        {
            if (table == null)
            {
                ushort[] t = new ushort[256];
                for (int i = 0; i < 256; i++)
                {
                    int c = i << 8;
                    for (int j = 0; j < 8; j++) c = (c & 0x8000) != 0 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
                    t[i] = (ushort)c;
                }
                table = t;
            }
            int crc = 0xFFFF;
            for (int i = 0; i < n; i++) crc = ((crc << 8) & 0xFFFF) ^ table[((crc >> 8) ^ data[i]) & 0xFF];
            return crc;
        }
    }

    static class Json
    {
        static string F(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }

        static string Esc(string s)
        {
            StringBuilder sb = new StringBuilder();
            foreach (char ch in s)
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch < 0x20) sb.AppendFormat("\\u{0:x4}", (int)ch);
                else sb.Append(ch);
            }
            return sb.ToString();
        }

        public static string Frame(Result r, long tick, double capMs, double decMs, string file)
        {
            StringBuilder sb = new StringBuilder(700);
            sb.Append("{\"ok\":").Append(r.Ok ? "true" : "false");
            sb.Append(",\"reason\":\"").Append(r.Reason).Append('"');
            sb.Append(",\"seq\":").Append(r.Seq);
            sb.Append(",\"ver\":").Append(r.Ver);
            sb.Append(",\"len\":").Append(r.Len);
            sb.Append(",\"payload\":\"");
            if (r.Payload != null) foreach (byte b in r.Payload) sb.Append(b.ToString("x2"));
            sb.Append('"');
            sb.Append(",\"pitch\":").Append(F(r.Pitch));
            sb.Append(",\"x0\":").Append(F(r.X0));
            sb.Append(",\"y0\":").Append(F(r.Y0));
            sb.Append(",\"max_err\":").Append(r.MaxErr);
            sb.Append(",\"tick_ms\":").Append(tick);
            sb.Append(",\"cap_ms\":").Append(F(capMs));
            sb.Append(",\"dec_ms\":").Append(F(decMs));
            if (file != null) sb.Append(",\"file\":\"").Append(Esc(file)).Append('"');
            sb.Append('}');
            return sb.ToString();
        }
    }

    // 只截屏幕上一小块：常驻 DIB section，每次 BitBlt 后拷出像素
    class ScreenGrabber : IDisposable
    {
        IntPtr screenDc, memDc, dib, old, bits;
        public int W, H;
        byte[] buf;

        public ScreenGrabber(int w, int h)
        {
            W = w; H = h;
            screenDc = Native.GetDC(IntPtr.Zero);
            memDc = Native.CreateCompatibleDC(screenDc);
            Native.BITMAPINFOHEADER bi = new Native.BITMAPINFOHEADER();
            bi.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
            dib = Native.CreateDIBSection(memDc, ref bi, 0, out bits, IntPtr.Zero, 0);
            old = Native.SelectObject(memDc, dib);
            buf = new byte[w * h * 4];
        }

        public Pixels Grab(int sx, int sy)
        {
            if (!Native.BitBlt(memDc, 0, 0, W, H, screenDc, sx, sy, Native.SRCCOPY)) return null;
            Marshal.Copy(bits, buf, 0, buf.Length);
            return new Pixels(buf, W, H, W * 4);
        }

        public void Dispose()
        {
            Native.SelectObject(memDc, old);
            Native.DeleteObject(dib);
            Native.DeleteDC(memDc);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    class ShowForm : Form
    {
        Bitmap[] images; int index;
        public ShowForm(Bitmap[] imgs, int x, int y, int interval, string title)
        {
            images = imgs;
            Text = title;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            ShowInTaskbar = true;
            DoubleBuffered = true;
            BackColor = Color.Black;
            Location = new Point(x, y);
            ClientSize = imgs[0].Size;
            if (imgs.Length > 1)
            {
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = interval;
                t.Tick += new EventHandler(OnTick);
                t.Start();
            }
        }
        void OnTick(object sender, EventArgs e) { index = (index + 1) % images.Length; Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
            e.Graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
            e.Graphics.DrawImage(images[index], new Rectangle(0, 0, images[index].Width, images[index].Height));
        }
    }

    static class Program
    {
        static TextWriter Out;

        static string Arg(string[] args, string name, string def)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return def;
        }

        static List<string> Positional(string[] args)
        {
            List<string> list = new List<string>();
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i].StartsWith("--")) { i++; continue; }
                list.Add(args[i]);
            }
            return list;
        }

        static Pixels Load(string path)
        {
            using (Bitmap bmp = new Bitmap(path))
            {
                Rectangle rc = new Rectangle(0, 0, bmp.Width, bmp.Height);
                BitmapData bd = bmp.LockBits(rc, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                byte[] data = new byte[bd.Stride * bd.Height];
                Marshal.Copy(bd.Scan0, data, 0, data.Length);
                bmp.UnlockBits(bd);
                return new Pixels(data, bmp.Width, bmp.Height, bd.Stride);
            }
        }

        static int RunImage(string[] args)
        {
            int repeat = int.Parse(Arg(args, "--repeat", "1"), CultureInfo.InvariantCulture);
            foreach (string path in Positional(args))
            {
                Stopwatch sw = Stopwatch.StartNew();
                long tick = Environment.TickCount;
                Pixels px;
                try { px = Load(path); }
                catch (Exception ex)
                {
                    Result bad = new Result(); bad.Reason = "load: " + ex.Message.Replace('"', '\'');
                    Out.WriteLine(Json.Frame(bad, tick, 0, 0, path));
                    continue;
                }
                double capMs = sw.Elapsed.TotalMilliseconds;
                Result r = null;
                sw.Restart();
                for (int i = 0; i < repeat; i++) r = Decoder.Decode(px);
                double decMs = sw.Elapsed.TotalMilliseconds / repeat;
                Out.WriteLine(Json.Frame(r, tick, capMs, decMs, path));
            }
            return 0;
        }

        static IntPtr FindTarget(string title, string cls)
        {
            if (title != null) return Native.FindWindow(null, title);
            IntPtr h = Native.FindWindow(cls, null);
            if (h == IntPtr.Zero) h = Native.FindWindow(null, "World of Warcraft");
            return h;
        }

        static int RunLive(string[] args)
        {
            string title = Arg(args, "--title", null);
            string cls = Arg(args, "--class", "GxWindowClassD3d");
            int w = int.Parse(Arg(args, "--w", "640"), CultureInfo.InvariantCulture);
            int h = int.Parse(Arg(args, "--h", "32"), CultureInfo.InvariantCulture);
            int poll = int.Parse(Arg(args, "--poll", "1"), CultureInfo.InvariantCulture);
            int statsSec = int.Parse(Arg(args, "--stats", "10"), CultureInfo.InvariantCulture);
            Native.timeBeginPeriod(1);
            try
            {
                using (ScreenGrabber grab = new ScreenGrabber(w, h))
                {
                    IntPtr hwnd = IntPtr.Zero;
                    int lastSeq = -1, lastFindTick = 0, lastFailTick = 0, lastStatsTick = Environment.TickCount;
                    string lastReason = null;
                    long captures = 0, oks = 0, crcFails = 0, otherFails = 0, frames = 0, seqGaps = 0;
                    double capSum = 0, decSum = 0, decMax = 0;
                    Stopwatch sw = new Stopwatch();
                    while (true)
                    {
                        int now = Environment.TickCount;
                        if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd))
                        {
                            hwnd = IntPtr.Zero;
                            if (now - lastFindTick >= 1000 || lastFindTick == 0)
                            {
                                lastFindTick = now;
                                hwnd = FindTarget(title, cls);
                                if (hwnd == IntPtr.Zero && lastReason != "no_window")
                                {
                                    Result nw = new Result(); nw.Reason = "no_window";
                                    Out.WriteLine(Json.Frame(nw, now, 0, 0, null));
                                    lastReason = "no_window";
                                }
                            }
                            if (hwnd == IntPtr.Zero) { Thread.Sleep(50); continue; }
                        }
                        Native.POINT pt = new Native.POINT();
                        Native.ClientToScreen(hwnd, ref pt);
                        long tick = Environment.TickCount;
                        sw.Restart();
                        Pixels px = grab.Grab(pt.X, pt.Y);
                        double capMs = sw.Elapsed.TotalMilliseconds;
                        Result r;
                        double decMs = 0;
                        if (px == null) { r = new Result(); r.Reason = "capture"; }
                        else
                        {
                            sw.Restart();
                            r = Decoder.Decode(px);
                            decMs = sw.Elapsed.TotalMilliseconds;
                        }
                        captures++; capSum += capMs; decSum += decMs; if (decMs > decMax) decMax = decMs;
                        if (r.Ok)
                        {
                            oks++;
                            if (r.Seq != lastSeq)
                            {
                                if (lastSeq >= 0 && ((r.Seq - lastSeq + 65536) % 65536) > 1) seqGaps++;
                                frames++;
                                lastSeq = r.Seq;
                                Out.WriteLine(Json.Frame(r, tick, capMs, decMs, null));
                            }
                            lastReason = null;
                        }
                        else
                        {
                            if (r.Reason == "crc") crcFails++; else otherFails++;
                            // 失败行限流：原因变了立刻报，同一原因每秒最多一行
                            if (r.Reason != lastReason || (int)tick - lastFailTick >= 1000)
                            {
                                Out.WriteLine(Json.Frame(r, tick, capMs, decMs, null));
                                lastFailTick = (int)tick; lastReason = r.Reason;
                            }
                        }
                        if (statsSec > 0 && now - lastStatsTick >= statsSec * 1000)
                        {
                            lastStatsTick = now;
                            double n = Math.Max(1, captures);
                            Console.Error.WriteLine(string.Format(CultureInfo.InvariantCulture,
                                "{{\"stats\":true,\"captures\":{0},\"ok\":{1},\"crc_fail\":{2},\"other_fail\":{3},\"frames\":{4},\"seq_gaps\":{5},\"cap_ms_avg\":{6:0.###},\"dec_ms_avg\":{7:0.###},\"dec_ms_max\":{8:0.###}}}",
                                captures, oks, crcFails, otherFails, frames, seqGaps, capSum / n, decSum / n, decMax));
                        }
                        if (poll > 0) Thread.Sleep(poll);
                    }
                }
            }
            finally { Native.timeEndPeriod(1); }
        }

        static int RunShow(string[] args)
        {
            List<string> paths = Positional(args);
            if (paths.Count == 0) { Console.Error.WriteLine("--show 需要至少一张图片"); return 2; }
            Bitmap[] imgs = new Bitmap[paths.Count];
            for (int i = 0; i < paths.Count; i++) imgs[i] = new Bitmap(paths[i]);
            int x = int.Parse(Arg(args, "--x", "100"), CultureInfo.InvariantCulture);
            int y = int.Parse(Arg(args, "--y", "100"), CultureInfo.InvariantCulture);
            int interval = int.Parse(Arg(args, "--interval", "33"), CultureInfo.InvariantCulture);
            string title = Arg(args, "--title", "JevCapture Show");
            Native.timeBeginPeriod(1);
            try { Application.Run(new ShowForm(imgs, x, y, interval, title)); }
            finally { Native.timeEndPeriod(1); }
            return 0;
        }

        [STAThread]
        static int Main(string[] args)
        {
            string dpi = Native.EnableDpiAwareness();
            StreamWriter w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            w.AutoFlush = true;
            w.NewLine = "\n";
            Out = w;
            string mode = args.Length > 0 ? args[0] : "";
            if (mode == "--image") return RunImage(args);
            if (mode == "--live") return RunLive(args);
            if (mode == "--show") return RunShow(args);
            if (mode == "--dpi") { Out.WriteLine("{\"dpi\":\"" + dpi + "\"}"); return 0; }
            Console.Error.WriteLine("用法：JevCapture.exe --image <png>... [--repeat N] | --live [--title T] [--class C] [--w 640] [--h 32] [--poll 1] [--stats 10] | --show <png>... [--x N] [--y N] [--interval ms] [--title T]");
            return 2;
        }
    }
}
