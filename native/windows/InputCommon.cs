// Shared Windows-local lease ledger. C# 5 / .NET Framework 4 only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
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
        public static bool WindowVisible(bool visible, bool minimized) { return visible && !minimized; }
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
        static bool UpperWindowIntersectsClient(IntPtr window, RecoveryRect client)
        {
            if (!IsWindow(window)) throw new InvalidOperationException("window_order_changed");
            if (!IsWindowVisible(window) || IsIconic(window)) return false;
            Rect outer;
            if (!GetWindowRect(window, out outer)) throw new InvalidOperationException("occluder_geometry_unknown");
            RecoveryRect bounds = new RecoveryRect(outer.Left, outer.Top, outer.Right, outer.Bottom);
            if (!bounds.Valid) throw new InvalidOperationException("occluder_geometry_unknown");
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
                "visibility_method", "monitor_union_and_upper_window_regions", "occluders", new List<string>());
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
                List<IntPtr> order = ReadWindowOrder(); int targetIndex = order.IndexOf(hwnd);
                if (targetIndex < 0) return RecoveryDenied(result, "window_order_unverified");
                List<string> occluders = (List<string>)result["occluders"];
                for (int i = 0; i < targetIndex; i++)
                    if (UpperWindowIntersectsClient(order[i], client)) occluders.Add("0x" + order[i].ToInt64().ToString("x"));
                if (occluders.Count > 0) return RecoveryDenied(result, "client_occluded");
                List<IntPtr> checkedOrder = ReadWindowOrder();
                if (order.Count != checkedOrder.Count) return RecoveryDenied(result, "window_order_changed");
                for (int i = 0; i < order.Count; i++) if (order[i] != checkedOrder[i]) return RecoveryDenied(result, "window_order_changed");
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
