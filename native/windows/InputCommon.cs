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

    public static class Native
    {
        delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr parameter);
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
                    if (game || recorder) result.Add(info);
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
