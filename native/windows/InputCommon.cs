// Shared Windows-local lease ledger. C# 5 / .NET Framework 4 only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WowJev.Input
{
    public static class Clock
    {
        [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long value);
        [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long value);
        static readonly long Frequency = GetFrequency();
        static long GetFrequency()
        {
            long value;
            if (!QueryPerformanceFrequency(out value) || value <= 0) throw new InvalidOperationException("QPC unavailable");
            return value;
        }
        public static long NowMs
        {
            get
            {
                long value;
                if (!QueryPerformanceCounter(out value)) throw new InvalidOperationException("QPC unavailable");
                return value / Frequency * 1000 + value % Frequency * 1000 / Frequency;
            }
        }
        public static double PreciseMs
        {
            get
            {
                long value;
                if (!QueryPerformanceCounter(out value)) throw new InvalidOperationException("QPC unavailable");
                return (double)value * 1000.0 / Frequency;
            }
        }
    }

    public sealed class KeySpec
    {
        public readonly int Index;
        public readonly string Name;
        public readonly ushort ScanCode;
        public readonly bool Extended;
        public readonly int VirtualKey;
        public KeySpec(int index, string name, ushort scanCode, bool extended, int virtualKey)
        { Index = index; Name = name; ScanCode = scanCode; Extended = extended; VirtualKey = virtualKey; }
        public ulong Mask { get { return 1UL << Index; } }
    }

    public static class KeyCatalog
    {
        public static readonly KeySpec[] All = Build();
        static readonly Dictionary<string, KeySpec> ByName = Index();
        static KeySpec[] Build()
        {
            List<KeySpec> result = new List<KeySpec>();
            ushort[] scans = { 0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
                0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c };
            for (int i = 0; i < 26; i++) result.Add(new KeySpec(result.Count, ((char)('A' + i)).ToString(), scans[i], false, 0x41 + i));
            for (int i = 0; i < 10; i++) result.Add(new KeySpec(result.Count, i.ToString(), (ushort)(i == 0 ? 0x0b : i + 1), false, 0x30 + i));
            for (int i = 1; i <= 12; i++) result.Add(new KeySpec(result.Count, "F" + i, (ushort)(i <= 10 ? 0x3a + i : i == 11 ? 0x57 : 0x58), false, 0x6f + i));
            Add(result, "SPACE", 0x39, false, 0x20);
            Add(result, "SHIFT", 0x2a, false, 0xa0);
            Add(result, "CTRL", 0x1d, false, 0xa2);
            Add(result, "ALT", 0x38, false, 0xa4);
            Add(result, "ESC", 0x01, false, 0x1b);
            Add(result, "TAB", 0x0f, false, 0x09);
            Add(result, "ENTER", 0x1c, false, 0x0d);
            Add(result, "BACKSPACE", 0x0e, false, 0x08);
            Add(result, "UP", 0x48, true, 0x26);
            Add(result, "DOWN", 0x50, true, 0x28);
            Add(result, "LEFT", 0x4b, true, 0x25);
            Add(result, "RIGHT", 0x4d, true, 0x27);
            return result.ToArray();
        }
        static void Add(List<KeySpec> list, string name, ushort scan, bool extended, int vk)
        { list.Add(new KeySpec(list.Count, name, scan, extended, vk)); }
        static Dictionary<string, KeySpec> Index()
        {
            Dictionary<string, KeySpec> result = new Dictionary<string, KeySpec>(StringComparer.Ordinal);
            foreach (KeySpec key in All) result.Add(key.Name, key);
            return result;
        }
        public static KeySpec Get(string name)
        {
            KeySpec value;
            if (name == null || !ByName.TryGetValue(name, out value)) throw new ArgumentException("Unsupported key: " + name);
            return value;
        }
    }

    public sealed class LeaseSnapshot
    {
        public int ExecutorPid;
        public int WatchdogPid;
        public long ExecutorStartTimeTicks;
        public long WatchdogStartTimeTicks;
        public long ExecutorHeartbeatMs;
        public long ControllerHeartbeatMs;
        public long LeaseDeadlineMs;
        public long WatchdogHeartbeatMs;
        public ulong HeldKeysMask;
        public int HeldMouseMask;
        public bool StopRequested;
        public string StopReason = "";
        public bool WatchdogReady;
    }

    public sealed class ReleaseResult
    {
        public int Requested;
        public int Inserted;
        public bool Released;
        public string FailureReason;
    }

    public sealed class LeaseStore : IDisposable
    {
        const int Magic = 0x57495631;
        const int Capacity = 256;
        public const string GlobalOwnerMutexName = "Local\\WowJevInput.GlobalOwner";
        // Main executor thread owns this for its entire lifetime. The guardian
        // separately owns GlobalOwnerMutex until the old ledger has been cleared.
        public const string GlobalExecutorAdmissionMutexName = "Local\\WowJevInput.ExecutorAdmission";
        public readonly string SessionId;
        public readonly string MemoryName;
        public readonly string MutexName;
        readonly MemoryMappedFile memory;
        readonly MemoryMappedViewAccessor view;
        readonly Mutex mutex;
        public LeaseStore(string sessionId, bool create)
        {
            Guid guid;
            if (!Guid.TryParseExact(sessionId, "D", out guid) || guid.ToString("D") != sessionId)
                throw new ArgumentException("Session must be a canonical lowercase UUID");
            SessionId = sessionId;
            MemoryName = "Local\\WowJevInput.Lease." + sessionId;
            MutexName = "Local\\WowJevInput.LeaseMutex." + sessionId;
            memory = create ? MemoryMappedFile.CreateOrOpen(MemoryName, Capacity) : MemoryMappedFile.OpenExisting(MemoryName);
            view = memory.CreateViewAccessor(0, Capacity, MemoryMappedFileAccess.ReadWrite);
            mutex = create ? new Mutex(false, MutexName) : Mutex.OpenExisting(MutexName);
            if (create && view.ReadInt32(0) == Magic)
            {
                Dispose();
                throw new InvalidOperationException("Session ledger already exists; use a new UUID");
            }
        }
        bool Enter(int timeoutMs)
        {
            if (timeoutMs < 0 || timeoutMs > 1000) throw new ArgumentOutOfRangeException("timeoutMs");
            try
            {
                if (!mutex.WaitOne(timeoutMs)) throw new TimeoutException("Lease mutex timeout");
                return false;
            }
            catch (AbandonedMutexException) { return true; }
        }
        LeaseSnapshot ReadUnlocked()
        {
            if (view.ReadInt32(0) != Magic || view.ReadInt32(4) != 1) throw new InvalidOperationException("Invalid lease ledger");
            LeaseSnapshot value = new LeaseSnapshot();
            value.ExecutorPid = view.ReadInt32(8); value.WatchdogPid = view.ReadInt32(12);
            value.ExecutorStartTimeTicks = view.ReadInt64(16); value.WatchdogStartTimeTicks = view.ReadInt64(24);
            value.ExecutorHeartbeatMs = view.ReadInt64(32); value.ControllerHeartbeatMs = view.ReadInt64(40);
            value.LeaseDeadlineMs = view.ReadInt64(48); value.WatchdogHeartbeatMs = view.ReadInt64(56);
            value.HeldKeysMask = view.ReadUInt64(64); value.HeldMouseMask = view.ReadInt32(72);
            value.StopRequested = view.ReadInt32(76) != 0; value.WatchdogReady = view.ReadInt32(80) != 0;
            int length = view.ReadInt32(84);
            if (length < 0 || length > 128) throw new InvalidOperationException("Invalid lease reason");
            byte[] bytes = new byte[length];
            view.ReadArray(88, bytes, 0, length);
            value.StopReason = Encoding.UTF8.GetString(bytes);
            return value;
        }
        void WriteUnlocked(LeaseSnapshot value)
        {
            byte[] reason = Encoding.UTF8.GetBytes(value.StopReason ?? "");
            if (reason.Length > 128) throw new ArgumentException("Lease reason exceeds 128 bytes");
            view.Write(4, 1); view.Write(8, value.ExecutorPid); view.Write(12, value.WatchdogPid);
            view.Write(16, value.ExecutorStartTimeTicks); view.Write(24, value.WatchdogStartTimeTicks);
            view.Write(32, value.ExecutorHeartbeatMs); view.Write(40, value.ControllerHeartbeatMs);
            view.Write(48, value.LeaseDeadlineMs); view.Write(56, value.WatchdogHeartbeatMs);
            view.Write(64, value.HeldKeysMask); view.Write(72, value.HeldMouseMask);
            view.Write(76, value.StopRequested ? 1 : 0); view.Write(80, value.WatchdogReady ? 1 : 0);
            view.Write(84, reason.Length); view.WriteArray(88, reason, 0, reason.Length);
            view.Write(0, Magic);
        }
        static void MarkAbandoned(LeaseSnapshot value)
        { value.StopRequested = true; value.WatchdogReady = false; value.StopReason = "abandoned_lease_mutex"; }
        public LeaseSnapshot Read(int timeoutMs = 100)
        {
            bool abandoned = Enter(timeoutMs);
            try
            {
                LeaseSnapshot value = ReadUnlocked();
                if (abandoned) { MarkAbandoned(value); WriteUnlocked(value); }
                return value;
            }
            finally { mutex.ReleaseMutex(); }
        }
        public void Write(LeaseSnapshot value, int timeoutMs = 100)
        {
            bool abandoned = Enter(timeoutMs);
            try
            {
                if (abandoned)
                {
                    LeaseSnapshot existing = ReadUnlocked(); MarkAbandoned(existing); WriteUnlocked(existing);
                    throw new InvalidOperationException("Abandoned lease mutex");
                }
                WriteUnlocked(value);
            }
            finally { mutex.ReleaseMutex(); }
        }
        public void WithLock(Action<LeaseSnapshot> update, int timeoutMs = 100)
        {
            if (update == null) throw new ArgumentNullException("update");
            bool abandoned = Enter(timeoutMs);
            try
            {
                LeaseSnapshot value = ReadUnlocked();
                if (abandoned)
                { MarkAbandoned(value); WriteUnlocked(value); throw new InvalidOperationException("Abandoned lease mutex"); }
                update(value);
                WriteUnlocked(value);
            }
            finally { mutex.ReleaseMutex(); }
        }
        // Registration is flushed before SendInput while still holding the mutex.
        // This prevents a killed executor from losing a down already sent to Windows.
        public void WithRegisteredInput(Action<LeaseSnapshot> register, Action<LeaseSnapshot> send, int timeoutMs = 100)
        {
            bool abandoned = Enter(timeoutMs);
            try
            {
                LeaseSnapshot value = ReadUnlocked();
                if (abandoned)
                { MarkAbandoned(value); WriteUnlocked(value); throw new InvalidOperationException("Abandoned lease mutex"); }
                register(value);
                WriteUnlocked(value);
                view.Flush();
                send(value);
                WriteUnlocked(value);
            }
            finally { mutex.ReleaseMutex(); }
        }
        public ReleaseResult ReleaseOwned(string reason)
        {
            bool abandoned = Enter(100);
            try
            {
                LeaseSnapshot value = ReadUnlocked();
                if (abandoned) MarkAbandoned(value);
                ReleaseResult result = Native.ReleaseOwned(value);
                if (result.Released)
                { value.HeldKeysMask = 0; value.HeldMouseMask = 0; value.LeaseDeadlineMs = 0; }
                WriteUnlocked(value);
                return result;
            }
            finally { mutex.ReleaseMutex(); }
        }
        public void Dispose()
        { view.Dispose(); memory.Dispose(); mutex.Dispose(); }
    }

    public sealed class WindowInfo
    {
        public IntPtr Hwnd;
        public int Pid;
        public int Width;
        public int Height;
        public bool Focused;
        public string ProcessName;
        public string Title;
    }

    // Pure geometry/clock helpers are also used by the no-input acceptance fixture.
    public struct RecoveryRect
    {
        public int Left, Top, Right, Bottom;
        public RecoveryRect(int left, int top, int right, int bottom)
        { Left = left; Top = top; Right = right; Bottom = bottom; }
        public bool Valid { get { return Left < Right && Top < Bottom; } }
        public bool Intersects(RecoveryRect other)
        { return Valid && other.Valid && Left < other.Right && Right > other.Left && Top < other.Bottom && Bottom > other.Top; }
    }
    public static class RecoverySafety
    {
        public const uint IdleThresholdMs = 5000;
        public const int FocusPointRadius = 2;
        public static bool PointPatchWithinClient(int x, int y, int width, int height)
        { return x >= FocusPointRadius && y >= FocusPointRadius && x < width - FocusPointRadius && y < height - FocusPointRadius; }
        public static bool FocusCandidate(int x, int y, int width, int height)
        { return (x == (int)Math.Floor(width * .6) || x == (int)Math.Floor(width * .75)) &&
            (y == (int)Math.Floor(height * .25) || y == (int)Math.Floor(height * .75)); }
        public static bool RetailWowIdentity(string name, string executable, string windowClass)
        { return String.Equals(name, "Wow", StringComparison.OrdinalIgnoreCase) && executable != null &&
            executable.EndsWith(@"\_retail_\Wow.exe", StringComparison.OrdinalIgnoreCase) &&
            (windowClass == "GxWindowClass" || windowClass == "GxWindowClassD3d" || windowClass == "waApplication Window"); }
        public static bool CursorFree(bool known, bool visible, bool handleKnown, bool captureFree, bool anyButton)
        { return known && visible && handleKnown && captureFree && !anyButton; }
        public static bool WindowVisible(bool visible, bool minimized) { return visible && !minimized; }
        public static string OccluderGeometry(bool succeeded, bool windowExists, RecoveryRect rect)
        {
            if (!succeeded) return windowExists ? "unknown" : "changed";
            if (rect.Right < rect.Left || rect.Bottom < rect.Top) return "unknown";
            if (rect.Right == rect.Left || rect.Bottom == rect.Top) return "empty";
            return "valid";
        }
        public static bool TryIdle(uint now, uint last, out uint idle)
        {
            idle = unchecked(now - last);
            // Handle the DWORD wrap; reject a future/ambiguous half-cycle value.
            return idle <= Int32.MaxValue;
        }
        public static bool IdleAllowed(uint now, uint last)
        { uint idle; return TryIdle(now, last, out idle) && idle > IdleThresholdMs; }
        public static bool CoveredByMonitors(RecoveryRect client, IList<RecoveryRect> monitors)
        {
            if (!client.Valid || monitors == null || monitors.Count == 0) return false;
            List<RecoveryRect> uncovered = new List<RecoveryRect>(); uncovered.Add(client);
            foreach (RecoveryRect monitor in monitors)
            {
                if (!monitor.Valid) return false;
                List<RecoveryRect> next = new List<RecoveryRect>();
                foreach (RecoveryRect part in uncovered)
                {
                    if (!part.Intersects(monitor)) { next.Add(part); continue; }
                    int left = Math.Max(part.Left, monitor.Left), right = Math.Min(part.Right, monitor.Right);
                    int top = Math.Max(part.Top, monitor.Top), bottom = Math.Min(part.Bottom, monitor.Bottom);
                    if (part.Top < top) next.Add(new RecoveryRect(part.Left, part.Top, part.Right, top));
                    if (bottom < part.Bottom) next.Add(new RecoveryRect(part.Left, bottom, part.Right, part.Bottom));
                    if (part.Left < left) next.Add(new RecoveryRect(part.Left, top, left, bottom));
                    if (right < part.Right) next.Add(new RecoveryRect(right, top, part.Right, bottom));
                }
                uncovered = next;
                if (uncovered.Count == 0) return true;
            }
            return uncovered.Count == 0;
        }
    }

    public static class Native
    {
        delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr parameter);
        delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr parameter);
        [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct KeyboardPacket
        { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] public struct MousePacket
        { public int Dx, Dy; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion
        { [FieldOffset(0)] public MousePacket Mouse; [FieldOffset(0)] public KeyboardPacket Keyboard; }
        [StructLayout(LayoutKind.Sequential)] public struct InputPacket
        { public uint Type; public InputUnion Data; }
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, InputPacket[] inputs, int size);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
        [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Tick; }
        [StructLayout(LayoutKind.Sequential)] struct RecoveryCursor { public uint Size, Flags; public IntPtr Handle; public Point Position; }
        [StructLayout(LayoutKind.Sequential)] struct RecoveryGui { public uint Size, Flags; public IntPtr Active, Focus, Capture, Menu, MoveSize, Caret; public Rect CaretRect; }
        [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorInfo(ref RecoveryCursor cursor);
        [DllImport("user32.dll", SetLastError = true)] static extern bool GetGUIThreadInfo(uint thread, ref RecoveryGui gui);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)] static extern bool DiagnosticUserObjectInformation(IntPtr handle, int index, IntPtr value, uint bytes, out uint needed);
        [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] static extern bool GetLastInputInfo(ref LastInput value);
        [DllImport("kernel32.dll")] static extern uint GetTickCount();
        [DllImport("kernel32.dll")] static extern void SetLastError(uint code);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetTopWindow(IntPtr hwnd);
        [DllImport("user32.dll", EntryPoint = "GetWindow", SetLastError = true)] static extern IntPtr GetRelatedWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
        [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] static extern int OffsetRgn(IntPtr region, int x, int y);
        [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dest, IntPtr one, IntPtr two, int mode);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out uint value, int size);

        static Dictionary<string, object> RecoveryObject(params object[] values)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            for (int i = 0; i < values.Length; i += 2) result.Add((string)values[i], values[i + 1]);
            return result;
        }
        static Dictionary<string, object> RecoveryDenied(Dictionary<string, object> value, string reason)
        { value["allowed"] = false; value["reason"] = reason; return value; }
        static List<IntPtr> ReadWindowOrder()
        {
            HashSet<IntPtr> enumerated = new HashSet<IntPtr>();
            if (!EnumWindows(delegate(IntPtr window, IntPtr unused) { enumerated.Add(window); return true; }, IntPtr.Zero))
                throw new InvalidOperationException("window_enumeration_failed");
            List<IntPtr> order = new List<IntPtr>(); HashSet<IntPtr> visited = new HashSet<IntPtr>();
            SetLastError(0); IntPtr cursor = GetTopWindow(IntPtr.Zero);
            if (cursor == IntPtr.Zero && (Marshal.GetLastWin32Error() != 0 || enumerated.Count != 0))
                throw new InvalidOperationException("window_order_unverified");
            while (cursor != IntPtr.Zero)
            {
                if (order.Count >= 4096 || !visited.Add(cursor) || !IsWindow(cursor))
                    throw new InvalidOperationException("window_order_changed");
                order.Add(cursor); SetLastError(0); cursor = GetRelatedWindow(cursor, 2);
                if (cursor == IntPtr.Zero && Marshal.GetLastWin32Error() != 0)
                    throw new InvalidOperationException("window_order_failed");
            }
            if (!visited.SetEquals(enumerated)) throw new InvalidOperationException("window_order_changed");
            return order;
        }
        static void RecordOccluderGeometry(List<object> diagnostics, IntPtr window, bool succeeded, int error, Rect raw, string disposition)
        {
            StringBuilder className = new StringBuilder(256); SetLastError(0);
            int count = GetClassName(window, className, className.Capacity), classError = Marshal.GetLastWin32Error();
            // Only identity and geometry are diagnostic; no title or image from
            // any other application is read or copied into the evidence.
            diagnostics.Add(RecoveryObject("hwnd", "0x" + window.ToInt64().ToString("x"),
                "class", count > 0 ? (object)className.ToString() : null, "class_error", count > 0 ? 0 : classError,
                "rect_success", succeeded, "win32_error", succeeded ? 0 : error, "disposition", disposition,
                "raw_rect", RecoveryObject("left", raw.Left, "top", raw.Top, "right", raw.Right, "bottom", raw.Bottom)));
        }
        static bool UpperWindowIntersectsClient(IntPtr window, RecoveryRect client, List<object> diagnostics)
        {
            if (!IsWindow(window))
            { RecordOccluderGeometry(diagnostics, window, false, 1400, new Rect(), "changed"); throw new InvalidOperationException("window_order_changed"); }
            if (!IsWindowVisible(window) || IsIconic(window)) return false;
            Rect outer; SetLastError(0);
            bool read = GetWindowRect(window, out outer); int error = Marshal.GetLastWin32Error();
            RecoveryRect bounds = new RecoveryRect(outer.Left, outer.Top, outer.Right, outer.Bottom);
            string disposition = RecoverySafety.OccluderGeometry(read, read || IsWindow(window), bounds);
            if (disposition != "valid")
            {
                RecordOccluderGeometry(diagnostics, window, read, error, outer, disposition);
                if (disposition == "empty") return false;
                if (disposition == "changed") throw new InvalidOperationException("window_order_changed");
                throw new InvalidOperationException("occluder_geometry_unknown");
            }
            if (!bounds.Intersects(client)) return false;
            uint cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(uint)) != 0)
                throw new InvalidOperationException("occluder_cloak_unknown");
            if (cloaked != 0) return false;
            IntPtr region = CreateRectRgn(0, 0, 0, 0), clientRegion = IntPtr.Zero, overlap = IntPtr.Zero;
            if (region == IntPtr.Zero) throw new InvalidOperationException("occluder_region_unknown");
            try
            {
                int kind = GetWindowRgn(window, region);
                // ERROR means either no explicitly-set region or failure. Treat its
                // complete bounding rectangle as an occluder instead of allowing it.
                if (kind == 0) return true;
                if (kind == 1) return false;
                if (kind != 2 && kind != 3 || OffsetRgn(region, outer.Left, outer.Top) == 0)
                    throw new InvalidOperationException("occluder_region_unknown");
                clientRegion = CreateRectRgn(client.Left, client.Top, client.Right, client.Bottom);
                overlap = CreateRectRgn(0, 0, 0, 0);
                if (clientRegion == IntPtr.Zero || overlap == IntPtr.Zero) throw new InvalidOperationException("occluder_region_unknown");
                int intersection = CombineRgn(overlap, region, clientRegion, 1);
                if (intersection == 0) throw new InvalidOperationException("occluder_region_unknown");
                return intersection != 1;
            }
            finally
            { if (region != IntPtr.Zero) DeleteObject(region); if (clientRegion != IntPtr.Zero) DeleteObject(clientRegion); if (overlap != IntPtr.Zero) DeleteObject(overlap); }
        }
        // Read-only. This is an observation, never permission for a later input;
        // the executor calls it again while holding its lease mutex before DOWN.
        public static Dictionary<string, object> GetRecoverySafety(IntPtr hwnd)
        {
            Dictionary<string, object> result = RecoveryObject("allowed", false, "reason", "unverified", "hwnd", "0x" + hwnd.ToInt64().ToString("x"),
                "checked_at_ms", Clock.PreciseMs, "visible", false, "minimized", false, "focused", false, "client_fully_visible", false,
                "idle_threshold_ms", RecoverySafety.IdleThresholdMs, "user_idle_scope", "calling-session-only", "input_source_distinguishable", false,
                "visibility_method", "monitor_union_and_upper_window_regions", "occluders", new List<string>(),
                "occluder_diagnostics", new List<object>(), "enumeration_retries", 0);
            try
            {
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || GetAncestor(hwnd, 2) != hwnd) return RecoveryDenied(result, "invalid_window");
                result["visible"] = IsWindowVisible(hwnd); result["minimized"] = IsIconic(hwnd); result["focused"] = GetForegroundWindow() == hwnd;
                if (!RecoverySafety.WindowVisible((bool)result["visible"], (bool)result["minimized"])) return RecoveryDenied(result, "window_not_visible");
                uint pid;
                if (GetWindowThreadProcessId(hwnd, out pid) == 0) return RecoveryDenied(result, "window_identity_unknown");
                int currentSession = Process.GetCurrentProcess().SessionId;
                using (Process process = Process.GetProcessById(checked((int)pid)))
                {
                    result["pid"] = pid; result["process_start_ticks"] = process.StartTime.ToUniversalTime().Ticks;
                    result["session_id"] = process.SessionId; result["probe_session_id"] = currentSession;
                    result["process_name"] = process.ProcessName;
                    if (process.SessionId != 1 || currentSession != 1) return RecoveryDenied(result, "wrong_interactive_session");
                }
                Rect raw; Point origin = new Point();
                if (!GetClientRect(hwnd, out raw) || !ClientToScreen(hwnd, ref origin) || raw.Right <= 0 || raw.Bottom <= 0)
                    return RecoveryDenied(result, "client_geometry_unknown");
                RecoveryRect client = new RecoveryRect(origin.X, origin.Y, checked(origin.X + raw.Right), checked(origin.Y + raw.Bottom));
                result["client_screen_rect"] = RecoveryObject("left", client.Left, "top", client.Top, "right", client.Right, "bottom", client.Bottom);
                List<RecoveryRect> monitors = new List<RecoveryRect>();
                if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr unused)
                    { monitors.Add(new RecoveryRect(rect.Left, rect.Top, rect.Right, rect.Bottom)); return true; }, IntPtr.Zero))
                    return RecoveryDenied(result, "monitor_geometry_unknown");
                if (!RecoverySafety.CoveredByMonitors(client, monitors)) return RecoveryDenied(result, "client_outside_monitors");
                List<string> occluders = (List<string>)result["occluders"];
                List<object> diagnostics = (List<object>)result["occluder_diagnostics"];
                bool stable = false;
                for (int attempt = 0; attempt < 2 && !stable; attempt++)
                {
                    occluders.Clear();
                    try
                    {
                        List<IntPtr> order = ReadWindowOrder(); int targetIndex = order.IndexOf(hwnd);
                        if (targetIndex < 0) return RecoveryDenied(result, "window_order_unverified");
                        for (int i = 0; i < targetIndex; i++)
                            if (UpperWindowIntersectsClient(order[i], client, diagnostics)) occluders.Add("0x" + order[i].ToInt64().ToString("x"));
                        List<IntPtr> checkedOrder = ReadWindowOrder();
                        if (order.Count != checkedOrder.Count) throw new InvalidOperationException("window_order_changed");
                        for (int i = 0; i < order.Count; i++)
                            if (order[i] != checkedOrder[i]) throw new InvalidOperationException("window_order_changed");
                        stable = true;
                    }
                    catch (InvalidOperationException error)
                    {
                        if (error.Message != "window_order_changed" || attempt != 0) throw;
                        result["enumeration_retries"] = 1;
                    }
                }
                if (!stable) return RecoveryDenied(result, "window_order_changed");
                if (occluders.Count > 0) return RecoveryDenied(result, "client_occluded");
                // This is supplementary hit-testing, never a replacement for the
                // whole-client region check above. Includes all four boundaries.
                Point[] checks = { new Point { X = client.Left, Y = client.Top }, new Point { X = client.Right - 1, Y = client.Top },
                    new Point { X = client.Left, Y = client.Bottom - 1 }, new Point { X = client.Right - 1, Y = client.Bottom - 1 },
                    new Point { X = client.Left + raw.Right / 2, Y = client.Top + raw.Bottom / 2 } };
                foreach (Point point in checks) if (GetAncestor(WindowFromPoint(point), 2) != hwnd) return RecoveryDenied(result, "client_hit_test_mismatch");
                result["client_fully_visible"] = true;
                LastInput input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                if (!GetLastInputInfo(ref input)) return RecoveryDenied(result, "last_input_unknown");
                uint now = GetTickCount(), idle;
                result["last_input_tick"] = input.Tick; result["current_tick"] = now;
                if (!RecoverySafety.TryIdle(now, input.Tick, out idle)) return RecoveryDenied(result, "last_input_clock_invalid");
                result["user_idle_ms"] = idle;
                if (idle <= RecoverySafety.IdleThresholdMs) return RecoveryDenied(result, "user_recent_input");
                result["allowed"] = true; result["reason"] = "safe"; return result;
            }
            catch (Exception error) { result["failure_detail"] = error.Message; return RecoveryDenied(result, "recovery_safety_unverified"); }
        }
        public static bool RecoveryPointOwnedByWindow(IntPtr hwnd, int x, int y)
        {
            WindowInfo window = GetWindow(hwnd); Point point = new Point { X = x, Y = y };
            return x >= 0 && y >= 0 && x < window.Width && y < window.Height && ClientToScreen(hwnd, ref point) && GetAncestor(WindowFromPoint(point), 2) == hwnd;
        }
        public static string WindowClassName(IntPtr hwnd)
        { var value = new StringBuilder(256); return GetClassName(hwnd, value, value.Capacity) > 0 ? value.ToString() : ""; }
        // Explicit recovery-only alternative. The default complete-client probe is
        // unchanged. No input is issued here; the hand rechecks under its lease.
        public static Dictionary<string, object> GetRecoveryPointSafety(IntPtr hwnd, int x, int y)
        { return GetRecoveryPointSafety(hwnd, x, y, false); }
        public static Dictionary<string, object> GetRecoveryPointSafety(IntPtr hwnd, int x, int y, bool ownedClickStarted)
        {
            var result = RecoveryObject("mode", "visible_point", "allowed", false, "reason", "unverified", "hwnd", "0x" + hwnd.ToInt64().ToString("x"),
                "checked_at_ms", Clock.PreciseMs, "visible", false, "minimized", false, "focused", false,
                "point", RecoveryObject("x", x, "y", y), "patch_radius", RecoverySafety.FocusPointRadius,
                "on_monitor", false, "point_owned", false, "point_visible", false, "cursor_free", false, "mouse_buttons_held", true,
                "idle_threshold_ms", RecoverySafety.IdleThresholdMs, "user_idle_scope", "calling-session-only", "input_source_distinguishable", false,
                "visibility_method", "physical_patch_monitor_union_and_each_pixel_root_hit_test", "owned_click_started", ownedClickStarted);
            try
            {
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || GetAncestor(hwnd, 2) != hwnd) return RecoveryDenied(result, "invalid_window");
                result["visible"] = IsWindowVisible(hwnd); result["minimized"] = IsIconic(hwnd); result["focused"] = GetForegroundWindow() == hwnd;
                if (!RecoverySafety.WindowVisible((bool)result["visible"], (bool)result["minimized"])) return RecoveryDenied(result, "window_not_visible");
                uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
                if (thread == 0) return RecoveryDenied(result, "window_identity_unknown");
                int session = Process.GetCurrentProcess().SessionId; string windowClass = WindowClassName(hwnd);
                using (Process process = Process.GetProcessById(checked((int)pid)))
                {
                    result["pid"] = pid; result["process_start_ticks"] = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
                    result["session_id"] = process.SessionId; result["probe_session_id"] = session; result["class"] = windowClass;
                    result["process_name"] = process.ProcessName; result["executable"] = process.MainModule.FileName;
                    if (process.SessionId != 1 || session != 1) return RecoveryDenied(result, "wrong_interactive_session");
                    if (!RecoverySafety.RetailWowIdentity(process.ProcessName, (string)result["executable"], windowClass)) return RecoveryDenied(result, "focus_recovery_target_unsupported");
                }
                Rect raw; Point origin = new Point();
                if (!GetClientRect(hwnd, out raw) || !ClientToScreen(hwnd, ref origin)) return RecoveryDenied(result, "client_geometry_unknown");
                result["client_width"] = raw.Right; result["client_height"] = raw.Bottom;
                if (!RecoverySafety.PointPatchWithinClient(x, y, raw.Right, raw.Bottom)) return RecoveryDenied(result, "point_patch_outside_client");
                int sx = checked(origin.X + x), sy = checked(origin.Y + y), radius = RecoverySafety.FocusPointRadius;
                result["screen_point"] = RecoveryObject("x", sx, "y", sy);
                var patch = new RecoveryRect(sx - radius, sy - radius, sx + radius + 1, sy + radius + 1);
                result["patch_screen_rect"] = RecoveryObject("left", patch.Left, "top", patch.Top, "right", patch.Right, "bottom", patch.Bottom);
                var monitors = new List<RecoveryRect>();
                if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr unused)
                    { monitors.Add(new RecoveryRect(rect.Left, rect.Top, rect.Right, rect.Bottom)); return true; }, IntPtr.Zero)) return RecoveryDenied(result, "monitor_geometry_unknown");
                if (!RecoverySafety.CoveredByMonitors(patch, monitors)) return RecoveryDenied(result, "point_patch_outside_monitors");
                result["on_monitor"] = true;
                for (int py = patch.Top; py < patch.Bottom; py++) for (int px = patch.Left; px < patch.Right; px++)
                    if (GetAncestor(WindowFromPoint(new Point { X = px, Y = py }), 2) != hwnd) return RecoveryDenied(result, "point_patch_not_target");
                result["point_owned"] = true; result["point_visible"] = true;
                var cursor = new RecoveryCursor { Size = (uint)Marshal.SizeOf(typeof(RecoveryCursor)) };
                var gui = new RecoveryGui { Size = (uint)Marshal.SizeOf(typeof(RecoveryGui)) };
                bool known = GetCursorInfo(ref cursor) && GetGUIThreadInfo(thread, ref gui), captureFree = gui.Capture == IntPtr.Zero;
                IntPtr foreground = GetForegroundWindow();
                if (foreground != IntPtr.Zero && foreground != hwnd)
                { uint fgPid; uint fgThread = GetWindowThreadProcessId(foreground, out fgPid); var fgGui = new RecoveryGui { Size = (uint)Marshal.SizeOf(typeof(RecoveryGui)) }; known = known && fgThread > 0 && GetGUIThreadInfo(fgThread, ref fgGui); captureFree = captureFree && fgGui.Capture == IntPtr.Zero; }
                bool held = IsMouseDown(1) || IsMouseDown(2) || IsMouseDown(4); result["mouse_buttons_held"] = held;
                bool free = RecoverySafety.CursorFree(known, (cursor.Flags & 1) != 0, cursor.Handle != IntPtr.Zero, captureFree, held); result["cursor_free"] = free;
                // The hand's registered LEFT_DOWN can itself change capture/idle.
                // Only its bounded hold may omit first-DOWN pointer/idle checks;
                // target visibility/identity and other human buttons still apply.
                if (!ownedClickStarted && !free) return RecoveryDenied(result, held ? "user_button_held" : "cursor_not_free");
                if (ownedClickStarted && (IsMouseDown(2) || IsMouseDown(4))) return RecoveryDenied(result, "user_button_held");
                LastInput input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                if (!GetLastInputInfo(ref input)) return RecoveryDenied(result, "last_input_unknown");
                uint now = GetTickCount(), idle; result["last_input_tick"] = input.Tick; result["current_tick"] = now;
                if (!RecoverySafety.TryIdle(now, input.Tick, out idle)) return RecoveryDenied(result, "last_input_clock_invalid");
                result["user_idle_ms"] = idle;
                if (!ownedClickStarted && idle <= RecoverySafety.IdleThresholdMs) return RecoveryDenied(result, "user_recent_input");
                result["allowed"] = true; result["reason"] = "safe"; return result;
            }
            catch (Exception error) { result["failure_detail"] = error.Message; return RecoveryDenied(result, "recovery_safety_unverified"); }
        }
        public static List<object> GetRecoveryFocusCandidates(IntPtr hwnd)
        {
            var candidates = new List<object>(); WindowInfo window = GetWindow(hwnd);
            double[,] ratios = { { .6, .25 }, { .75, .25 }, { .6, .75 }, { .75, .75 } };
            for (int i = 0; i < ratios.GetLength(0); i++) candidates.Add(GetRecoveryPointSafety(hwnd, (int)Math.Floor(window.Width * ratios[i, 0]), (int)Math.Floor(window.Height * ratios[i, 1])));
            return candidates;
        }
        static string DiagnosticHandle(IntPtr value) { return "0x" + value.ToInt64().ToString("x"); }
        static Dictionary<string, object> DiagnosticWindow(IntPtr hwnd, IList<IntPtr> order)
        {
            uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid); Rect bounds = new Rect(); SetLastError(0);
            bool rectKnown = hwnd != IntPtr.Zero && GetWindowRect(hwnd, out bounds); int rectError = rectKnown ? 0 : Marshal.GetLastWin32Error();
            // Definite assignment also covers a null HWND without calling USER32.
            if (!rectKnown) bounds = new Rect();
            var title = new StringBuilder(261); int titleLength = hwnd == IntPtr.Zero ? 0 : GetWindowText(hwnd, title, title.Capacity);
            var value = RecoveryObject("hwnd", DiagnosticHandle(hwnd), "root_hwnd", DiagnosticHandle(GetAncestor(hwnd, 2)), "exists", IsWindow(hwnd),
                "thread_id", thread, "pid", pid, "class", WindowClassName(hwnd), "title", titleLength > 0 ? (object)title.ToString() : null,
                "visible", IsWindowVisible(hwnd), "minimized", IsIconic(hwnd), "z_index", order == null ? -1 : order.IndexOf(hwnd),
                "rect_known", rectKnown, "rect_error", rectError, "rect", rectKnown ? (object)RecoveryObject("left", bounds.Left, "top", bounds.Top, "right", bounds.Right, "bottom", bounds.Bottom) : null);
            try { using (Process process = Process.GetProcessById(checked((int)pid)))
                { value["process_name"] = process.ProcessName; value["process_start_ticks"] = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture); value["session_id"] = process.SessionId; } }
            catch (Exception error) { value["process_identity_error"] = error.GetType().Name; }
            return value;
        }
        static Dictionary<string, object> DiagnosticDesktop(IntPtr desktop, int openError)
        {
            var value = RecoveryObject("handle", DiagnosticHandle(desktop), "open_error", openError, "name_known", false, "name", null,
                "receives_input_known", false, "receives_input", null);
            if (desktop == IntPtr.Zero) return value;
            IntPtr buffer = Marshal.AllocHGlobal(512);
            try {
                uint needed; SetLastError(0); bool named = DiagnosticUserObjectInformation(desktop, 2, buffer, 512, out needed); int nameError = named ? 0 : Marshal.GetLastWin32Error();
                value["name_known"] = named; value["name_error"] = nameError; value["name"] = named ? (object)Marshal.PtrToStringUni(buffer) : null;
                Marshal.WriteInt32(buffer, 0); SetLastError(0); bool ioKnown = DiagnosticUserObjectInformation(desktop, 6, buffer, 4, out needed); int ioError = ioKnown ? 0 : Marshal.GetLastWin32Error();
                value["receives_input_known"] = ioKnown; value["receives_input_error"] = ioError; value["receives_input"] = ioKnown ? (object)(Marshal.ReadInt32(buffer) != 0) : null;
            } finally { Marshal.FreeHGlobal(buffer); }
            return value;
        }
        // Independent read-only diagnostic, deliberately not an input permission.
        // Titles are read only for the target, actual hit owners and intersecting
        // visible Z-order entries requested by this field investigation.
        public static Dictionary<string, object> GetRecoveryVisibilityDiagnostic(IntPtr hwnd)
        {
            var result = RecoveryObject("version", 1, "kind", "recovery_visibility_diagnostic", "input_permission", false,
                "started_windows_qpc_ms", Clock.PreciseMs, "status", "unknown", "target_hwnd", DiagnosticHandle(hwnd));
            try {
                uint currentThread = GetCurrentThreadId(); SetLastError(0); IntPtr threadDesktop = GetThreadDesktop(currentThread); int threadError = threadDesktop == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                result["thread_id"] = currentThread; result["thread_desktop"] = DiagnosticDesktop(threadDesktop, threadError);
                SetLastError(0); IntPtr inputDesktop = OpenInputDesktop(0, false, 1); int inputError = inputDesktop == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                try { result["input_desktop"] = DiagnosticDesktop(inputDesktop, inputError); } finally { if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop); }
                // Name only: UOI_IO applies to desktop handles, not stations.
                IntPtr station = GetProcessWindowStation(), stationBuffer = Marshal.AllocHGlobal(512);
                try { uint needed; SetLastError(0); bool stationKnown = station != IntPtr.Zero && DiagnosticUserObjectInformation(station, 2, stationBuffer, 512, out needed);
                    result["window_station"] = RecoveryObject("name_known", stationKnown, "name", stationKnown ? (object)Marshal.PtrToStringUni(stationBuffer) : null, "error", stationKnown ? 0 : Marshal.GetLastWin32Error()); }
                finally { Marshal.FreeHGlobal(stationBuffer); }
                var gui = new RecoveryGui { Size = (uint)Marshal.SizeOf(typeof(RecoveryGui)) }; SetLastError(0); bool guiKnown = GetGUIThreadInfo(0, ref gui); int guiError = guiKnown ? 0 : Marshal.GetLastWin32Error();
                result["foreground_gui"] = RecoveryObject("requested_thread", 0, "known", guiKnown, "error", guiError, "flags", guiKnown ? (object)gui.Flags : null,
                    "active_hwnd", guiKnown ? (object)DiagnosticHandle(gui.Active) : null, "focus_hwnd", guiKnown ? (object)DiagnosticHandle(gui.Focus) : null, "capture_hwnd", guiKnown ? (object)DiagnosticHandle(gui.Capture) : null);
                var cursor = new RecoveryCursor { Size = (uint)Marshal.SizeOf(typeof(RecoveryCursor)) }; SetLastError(0); bool cursorKnown = GetCursorInfo(ref cursor); int cursorError = cursorKnown ? 0 : Marshal.GetLastWin32Error();
                result["cursor"] = RecoveryObject("known", cursorKnown, "error", cursorError, "visible", cursorKnown ? (object)((cursor.Flags & 1) != 0) : null,
                    "handle", cursorKnown ? (object)DiagnosticHandle(cursor.Handle) : null, "flags", cursorKnown ? (object)cursor.Flags : null,
                    "screen_point", cursorKnown ? (object)RecoveryObject("x", cursor.Position.X, "y", cursor.Position.Y) : null,
                    "left_button_down", IsMouseDown(1), "right_button_down", IsMouseDown(2), "middle_button_down", IsMouseDown(4));
                var lastInput = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) }; SetLastError(0); bool idleRead = GetLastInputInfo(ref lastInput); int idleError = idleRead ? 0 : Marshal.GetLastWin32Error();
                uint now = GetTickCount(), idle = 0; bool idleKnown = idleRead && RecoverySafety.TryIdle(now, lastInput.Tick, out idle);
                result["last_input"] = RecoveryObject("read_succeeded", idleRead, "error", idleError, "idle_known", idleKnown, "user_idle_ms", idleKnown ? (object)idle : null,
                    "current_tick", now, "last_input_tick", idleRead ? (object)lastInput.Tick : null, "calling_session_only", true);
                try { IntPtr context = GetThreadDpiAwarenessContext(); result["thread_dpi_awareness"] = RecoveryObject("context", DiagnosticHandle(context), "awareness", GetAwarenessFromDpiAwarenessContext(context)); }
                catch (EntryPointNotFoundException) { result["thread_dpi_awareness"] = null; }
                var monitors = new List<RecoveryRect>(); var monitorRows = new List<object>();
                SetLastError(0); bool monitorsKnown = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr unused)
                    { monitors.Add(new RecoveryRect(rect.Left, rect.Top, rect.Right, rect.Bottom)); monitorRows.Add(RecoveryObject("handle", DiagnosticHandle(monitor), "left", rect.Left, "top", rect.Top, "right", rect.Right, "bottom", rect.Bottom)); return true; }, IntPtr.Zero);
                result["monitors_known"] = monitorsKnown; result["monitors_error"] = monitorsKnown ? 0 : Marshal.GetLastWin32Error(); result["monitors"] = monitorRows;
                List<IntPtr> order = ReadWindowOrder(); result["target"] = DiagnosticWindow(hwnd, order); result["foreground"] = DiagnosticWindow(GetForegroundWindow(), order);
                Rect raw; Point origin = new Point(); if (!GetClientRect(hwnd, out raw) || !ClientToScreen(hwnd, ref origin)) throw new InvalidOperationException("client_geometry_unknown");
                var client = new RecoveryRect(origin.X, origin.Y, checked(origin.X + raw.Right), checked(origin.Y + raw.Bottom));
                result["client_screen_rect"] = RecoveryObject("left", client.Left, "top", client.Top, "right", client.Right, "bottom", client.Bottom);
                result["client_covered_by_monitors"] = monitorsKnown && RecoverySafety.CoveredByMonitors(client, monitors);
                var owners = new Dictionary<string, object>(); var points = new List<object>(); double[,] ratios = { { .6, .25 }, { .75, .25 }, { .6, .75 }, { .75, .75 } };
                for (int i = 0; i < ratios.GetLength(0); i++) {
                    int x = (int)Math.Floor(raw.Right * ratios[i, 0]), y = (int)Math.Floor(raw.Bottom * ratios[i, 1]); var screen = new Point { X = checked(origin.X + x), Y = checked(origin.Y + y) };
                    IntPtr hit = WindowFromPoint(screen), root = GetAncestor(hit, 2); var patchOwners = new Dictionary<string, int>();
                    for (int py = screen.Y - 2; py <= screen.Y + 2; py++) for (int px = screen.X - 2; px <= screen.X + 2; px++) {
                        IntPtr patchRoot = GetAncestor(WindowFromPoint(new Point { X = px, Y = py }), 2); string id = DiagnosticHandle(patchRoot);
                        if (!owners.ContainsKey(id)) owners.Add(id, DiagnosticWindow(patchRoot, order)); if (!patchOwners.ContainsKey(id)) patchOwners.Add(id, 0); patchOwners[id]++;
                    }
                    if (!owners.ContainsKey(DiagnosticHandle(hit))) owners.Add(DiagnosticHandle(hit), DiagnosticWindow(hit, order));
                    points.Add(RecoveryObject("client_point", RecoveryObject("x", x, "y", y), "screen_point", RecoveryObject("x", screen.X, "y", screen.Y),
                        "hit_hwnd", DiagnosticHandle(hit), "root_hwnd", DiagnosticHandle(root), "root_is_target", root == hwnd,
                        "patch_on_monitor", monitorsKnown && RecoverySafety.CoveredByMonitors(new RecoveryRect(screen.X - 2, screen.Y - 2, screen.X + 3, screen.Y + 3), monitors), "patch_root_pixel_counts", patchOwners));
                }
                result["points"] = points; result["hit_windows"] = owners;
                var relevant = new List<object>();
                foreach (IntPtr window in order) {
                    Rect bounds; bool read = GetWindowRect(window, out bounds);
                    if (window == hwnd || owners.ContainsKey(DiagnosticHandle(window)) || IsWindowVisible(window) && !IsIconic(window) && (!read || new RecoveryRect(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom).Intersects(client))) relevant.Add(DiagnosticWindow(window, order));
                }
                result["related_z_order"] = relevant; result["z_order_total"] = order.Count; result["target_z_index"] = order.IndexOf(hwnd);
                List<IntPtr> after = ReadWindowOrder(); bool stable = after.Count == order.Count; if (stable) for (int i = 0; i < order.Count; i++) if (after[i] != order[i]) { stable = false; break; }
                result["z_order_stable"] = stable; result["status"] = "observed";
            } catch (Exception error) { result["status"] = "partial"; result["error_type"] = error.GetType().Name; result["error"] = error.Message; }
            result["finished_windows_qpc_ms"] = Clock.PreciseMs; return result;
        }
        public static int LastError { get; private set; }
        public static void MakeDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }
            catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }
        public static long GetProcessStartTicks(int pid)
        { using (Process process = Process.GetProcessById(pid)) return process.StartTime.ToUniversalTime().Ticks; }
        public static bool IsProcessAlive(int pid)
        {
            try { using (Process process = Process.GetProcessById(pid)) return !process.HasExited; }
            catch { return false; }
        }
        public static bool IsProcessAlive(int pid, long startTicks)
        {
            try { using (Process process = Process.GetProcessById(pid)) return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == startTicks; }
            catch { return false; }
        }
        public static bool IsKeyDown(KeySpec key)
        {
            if ((GetAsyncKeyState(key.VirtualKey) & 0x8000) != 0) return true;
            // Either modifier side already pressed belongs to the human, not this executor.
            if (key.Name == "SHIFT") return (GetAsyncKeyState(0xa1) & 0x8000) != 0;
            if (key.Name == "CTRL") return (GetAsyncKeyState(0xa3) & 0x8000) != 0;
            if (key.Name == "ALT") return (GetAsyncKeyState(0xa5) & 0x8000) != 0;
            return false;
        }
        public static bool IsMouseDown(int buttonBit)
        { return (GetAsyncKeyState(buttonBit == 1 ? 1 : buttonBit == 2 ? 2 : 4) & 0x8000) != 0; }
        public static WindowInfo GetWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || IsIconic(hwnd)) throw new InvalidOperationException("invalid_window");
            uint pid; Rect rect;
            if (GetWindowThreadProcessId(hwnd, out pid) == 0 || !GetClientRect(hwnd, out rect) || rect.Right <= 0 || rect.Bottom <= 0)
                throw new InvalidOperationException("invalid_window");
            return new WindowInfo { Hwnd = hwnd, Pid = checked((int)pid), Width = rect.Right, Height = rect.Bottom, Focused = GetForegroundWindow() == hwnd };
        }
        public static List<WindowInfo> ListCandidates()
        {
            List<WindowInfo> result = new List<WindowInfo>();
            EnumWindows(delegate(IntPtr hwnd, IntPtr parameter)
            {
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                try
                {
                    WindowInfo info = GetWindow(hwnd);
                    using (Process process = Process.GetProcessById(info.Pid)) info.ProcessName = process.ProcessName;
                    StringBuilder title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity); info.Title = title.ToString();
                    string name = info.ProcessName.ToLowerInvariant();
                    bool game = name == "wow" || name == "wowclassic" || name == "wowclassict" || name == "wowb";
                    bool recorder = name == "inputrecorder" && info.Title.StartsWith("WoW Jev Input Recorder - ", StringComparison.Ordinal);
                    bool playFixture = name == "playfixture" && info.Title.StartsWith("WoW Jev Play Fixture - ", StringComparison.Ordinal);
                    if (game || recorder || playFixture) result.Add(info);
                }
                catch { }
                return true;
            }, IntPtr.Zero);
            return result;
        }
        public static InputPacket KeyEvent(KeySpec key, bool up)
        {
            InputPacket input = new InputPacket(); input.Type = 1;
            input.Data.Keyboard.Scan = key.ScanCode;
            input.Data.Keyboard.Flags = 8U | (key.Extended ? 1U : 0U) | (up ? 2U : 0U);
            return input;
        }
        public static InputPacket MouseButton(int buttonBit, bool up)
        {
            InputPacket input = new InputPacket(); input.Type = 0;
            input.Data.Mouse.Flags = buttonBit == 1 ? (up ? 4U : 2U) : buttonBit == 2 ? (up ? 16U : 8U) : (up ? 64U : 32U);
            return input;
        }
        public static InputPacket[] ClickBatch(InputPacket absoluteMove, int buttonBit)
        {
            // Pure construction: the caller has checked identity/point ownership
            // and registered this button before sending the contiguous batch.
            if (absoluteMove.Type != 0 || absoluteMove.Data.Mouse.Flags != (1U | 0x8000U | 0x4000U) ||
                absoluteMove.Data.Mouse.Dx < 0 || absoluteMove.Data.Mouse.Dx > 65535 ||
                absoluteMove.Data.Mouse.Dy < 0 || absoluteMove.Data.Mouse.Dy > 65535)
                throw new ArgumentException("absolute_click_move_required");
            if (buttonBit != 1 && buttonBit != 2 && buttonBit != 4) throw new ArgumentException("unsupported_click_button");
            return new[] { absoluteMove, MouseButton(buttonBit, false) };
        }
        public static InputPacket MouseWheel(int delta)
        { InputPacket input = new InputPacket(); input.Data.Mouse.Flags = 0x0800; input.Data.Mouse.Data = unchecked((uint)delta); return input; }
        public static InputPacket MouseRelative(int dx, int dy)
        { InputPacket input = new InputPacket(); input.Data.Mouse.Flags = 1; input.Data.Mouse.Dx = dx; input.Data.Mouse.Dy = dy; return input; }
        public static InputPacket MouseAbsolute(IntPtr hwnd, int x, int y)
        {
            WindowInfo window = GetWindow(hwnd);
            if (x < 0 || y < 0 || x >= window.Width || y >= window.Height) throw new ArgumentException("coordinate_out_of_client");
            Point point = new Point { X = x, Y = y };
            if (!ClientToScreen(hwnd, ref point)) throw new InvalidOperationException("client_to_screen_failed");
            int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
            if (width <= 1 || height <= 1 || point.X < left || point.Y < top || point.X >= left + width || point.Y >= top + height)
                throw new ArgumentException("coordinate_out_of_desktop");
            InputPacket input = new InputPacket(); input.Data.Mouse.Flags = 1 | 0x8000U | 0x4000U;
            input.Data.Mouse.Dx = (int)Math.Round((point.X - left) * 65535.0 / (width - 1));
            input.Data.Mouse.Dy = (int)Math.Round((point.Y - top) * 65535.0 / (height - 1));
            return input;
        }
        public static bool CursorWithinClient(IntPtr hwnd)
        {
            Point point;
            WindowInfo window = GetWindow(hwnd);
            return GetCursorPos(out point) && ScreenToClient(hwnd, ref point) && point.X >= 0 && point.Y >= 0 && point.X < window.Width && point.Y < window.Height;
        }
        public static int Send(InputPacket[] inputs)
        {
            if (inputs.Length == 0) return 0;
            uint result = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(InputPacket)));
            LastError = Marshal.GetLastWin32Error();
            return checked((int)result);
        }
        public static ReleaseResult ReleaseOwned(LeaseSnapshot snapshot)
        {
            List<InputPacket> inputs = new List<InputPacket>();
            ulong validMask = 0;
            foreach (KeySpec key in KeyCatalog.All) validMask |= key.Mask;
            if ((snapshot.HeldKeysMask & ~validMask) != 0 || (snapshot.HeldMouseMask & ~7) != 0)
                return new ReleaseResult { Released = false, FailureReason = "invalid_owned_mask" };
            for (int i = KeyCatalog.All.Length - 1; i >= 0; i--)
                if ((snapshot.HeldKeysMask & KeyCatalog.All[i].Mask) != 0) inputs.Add(KeyEvent(KeyCatalog.All[i], true));
            for (int bit = 1; bit <= 4; bit *= 2)
                if ((snapshot.HeldMouseMask & bit) != 0) inputs.Add(MouseButton(bit, true));
            int inserted = Send(inputs.ToArray());
            return new ReleaseResult { Requested = inputs.Count, Inserted = inserted, Released = inserted == inputs.Count,
                FailureReason = inserted == inputs.Count ? null : "release_sendinput_partial" };
        }
    }
}
