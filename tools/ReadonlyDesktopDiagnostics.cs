// Read-only desktop/session diagnosis. Never switches/attaches desktops or sends input.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using WowJev.Input;

static class ReadonlyDesktopDiagnostics
{
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SessionInfoLevel1
    {
        public uint SessionId; public int State, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
        public long LogonTime, ConnectTime, DisconnectTime, LastInputTime, CurrentTime;
        public uint IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames, IncomingCompressedBytes, OutgoingCompressedBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct SessionInfoEx { public uint Level; public SessionInfoLevel1 Data; }
    delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, uint bytes, out uint needed);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)] static extern bool GetUserObjectInput(IntPtr handle, int index, out int input, uint bytes, out uint needed);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll", SetLastError = true)] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    static string Hex(IntPtr handle) { return "0x" + handle.ToInt64().ToString("x", CultureInfo.InvariantCulture); }
    // last_error_raw is cleared before each API and captured immediately afterwards.
    // It is meaningful as an extended failure code only where the API documents it.
    static Dictionary<string, object> ObjectName(IntPtr handle)
    {
        var name = new StringBuilder(1024); uint needed;
        SetLastError(0);
        bool ok = GetUserObjectInformation(handle, 2, name, (uint)name.Capacity * 2, out needed);
        int error = Marshal.GetLastWin32Error();
        return new Dictionary<string, object> { { "success", ok }, { "name", ok ? name.ToString() : null }, { "last_error_raw", error }, { "bytes_needed", needed } };
    }
    static Dictionary<string, object> Desktop(uint tid)
    {
        SetLastError(0); IntPtr handle = GetThreadDesktop(tid); int error = Marshal.GetLastWin32Error();
        var record = new Dictionary<string, object> { { "thread_id", tid }, { "handle", Hex(handle) }, { "last_error_raw", error }, { "success", handle != IntPtr.Zero } };
        if (handle != IntPtr.Zero)
        {
            record["object_name"] = ObjectName(handle);
            record["UOI_IO"] = InputFlag(handle);
        }
        // GetThreadDesktop returns a borrowed handle. Never CloseDesktop it.
        return record;
    }
    static Dictionary<string, object> InputFlag(IntPtr handle)
    {
        int input; uint needed;
        SetLastError(0); bool ok = GetUserObjectInput(handle, 6, out input, 4, out needed); int error = Marshal.GetLastWin32Error();
        return new Dictionary<string, object> { { "success", ok }, { "is_input_desktop", ok ? (object)(input != 0) : null }, { "last_error_raw", error }, { "bytes_needed", needed } };
    }
    static Dictionary<string, object> WindowOwner(IntPtr hwnd)
    {
        uint pid; SetLastError(0); uint tid = GetWindowThreadProcessId(hwnd, out pid); int error = Marshal.GetLastWin32Error();
        return new Dictionary<string, object> { { "hwnd", Hex(hwnd) }, { "thread_id", tid }, { "pid", pid }, { "last_error_raw", error }, { "success", tid != 0 } };
    }
    static Dictionary<string, object> Gui(uint tid)
    {
        var info = new GuiInfo(); info.Size = (uint)Marshal.SizeOf(typeof(GuiInfo));
        SetLastError(0); bool ok = GetGUIThreadInfo(tid, ref info); int error = Marshal.GetLastWin32Error();
        return new Dictionary<string, object> {
            { "requested_thread_id", tid }, { "cb_size", info.Size }, { "success", ok }, { "last_error_raw", error }, { "flags", info.Flags },
            { "active", WindowOwner(info.Active) }, { "focus", WindowOwner(info.Focus) }, { "capture_hwnd", Hex(info.Capture) },
            { "menu_owner_hwnd", Hex(info.MenuOwner) }, { "move_size_hwnd", Hex(info.MoveSize) }, { "caret_hwnd", Hex(info.Caret) }
        };
    }
    static Dictionary<string, object> SessionValue(int session, int kind, bool number, bool shortNumber)
    {
        IntPtr buffer; uint bytes;
        SetLastError(0); bool ok = WTSQuerySessionInformation(IntPtr.Zero, session, kind, out buffer, out bytes); int error = Marshal.GetLastWin32Error();
        object value = null;
        try
        {
            if (ok && buffer != IntPtr.Zero)
            {
                if (number) { if (bytes >= (shortNumber ? 2 : 4)) value = shortNumber ? (int)(ushort)Marshal.ReadInt16(buffer) : Marshal.ReadInt32(buffer); }
                else value = Marshal.PtrToStringUni(buffer);
            }
        }
        finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
        return new Dictionary<string, object> { { "success", ok }, { "value", value }, { "last_error_raw", error }, { "bytes", bytes } };
    }
    static Dictionary<string, object> Session(int id)
    {
        var state = SessionValue(id, 8, true, false);
        string[] states = { "WTSActive", "WTSConnected", "WTSConnectQuery", "WTSShadow", "WTSDisconnected", "WTSIdle", "WTSListen", "WTSReset", "WTSDown", "WTSInit" };
        if (state["value"] != null) { int value = (int)state["value"]; state["name"] = value >= 0 && value < states.Length ? states[value] : "unknown"; }
        return new Dictionary<string, object> {
            { "session_id", id }, { "connect_state", state }, { "win_station_name", SessionValue(id, 6, false, false) },
            { "user", SessionValue(id, 5, false, false) }, { "domain", SessionValue(id, 7, false, false) },
            { "client_protocol_type", SessionValue(id, 16, true, true) }, { "extended", SessionExtended(id) }
        };
    }
    static Dictionary<string, object> SessionExtended(int id)
    {
        IntPtr buffer; uint bytes;
        SetLastError(0); bool ok = WTSQuerySessionInformation(IntPtr.Zero, id, 25, out buffer, out bytes); int error = Marshal.GetLastWin32Error();
        int size = Marshal.SizeOf(typeof(SessionInfoEx));
        var record = new Dictionary<string, object> { { "success", ok }, { "last_error_raw", error }, { "bytes", bytes }, { "expected_struct_bytes", size } };
        try
        {
            if (ok && buffer != IntPtr.Zero && bytes >= size)
            {
                var info = (SessionInfoEx)Marshal.PtrToStructure(buffer, typeof(SessionInfoEx)); record["level"] = info.Level;
                if (info.Level == 1 && info.Data.SessionId == id)
                {
                    record["session_id"] = info.Data.SessionId; record["session_state"] = info.Data.State; record["session_flags_raw"] = info.Data.Flags;
                    record["lock_state_windows_8_or_later"] = info.Data.Flags == 0 ? "locked" : info.Data.Flags == 1 ? "unlocked" : "unknown";
                    // Keep WTS FILETIME values in their own clock domain, as strings.
                    record["last_input_filetime"] = info.Data.LastInputTime.ToString(CultureInfo.InvariantCulture);
                    record["current_filetime"] = info.Data.CurrentTime.ToString(CultureInfo.InvariantCulture);
                    record["station"] = info.Data.Station;
                }
                else record["layout_or_session_unverified"] = true;
            }
            else if (ok) record["layout_or_session_unverified"] = true;
        }
        finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
        return record;
    }
    public static Dictionary<string, object> Snapshot(int wowPid)
    {
        double start = Clock.PreciseMs;
        SetLastError(0); IntPtr station = GetProcessWindowStation(); int stationError = Marshal.GetLastWin32Error();
        var stationRecord = new Dictionary<string, object> { { "handle", Hex(station) }, { "last_error_raw", stationError }, { "object_name", ObjectName(station) } };
        var threadDesktop = Desktop(GetCurrentThreadId());
        SetLastError(0); IntPtr input = OpenInputDesktop(0, false, 1); int inputError = Marshal.GetLastWin32Error();
        var inputRecord = new Dictionary<string, object> { { "handle", Hex(input) }, { "success", input != IntPtr.Zero }, { "last_error_raw", inputError }, { "desired_access", "DESKTOP_READOBJECTS (0x1)" } };
        if (input != IntPtr.Zero)
        {
            try { inputRecord["object_name"] = ObjectName(input); inputRecord["UOI_IO"] = InputFlag(input); }
            finally { SetLastError(0); bool closed = CloseDesktop(input); int error = Marshal.GetLastWin32Error(); inputRecord["closed"] = closed; inputRecord["close_last_error_raw"] = error; }
        }
        IntPtr foreground = GetForegroundWindow();
        var foregroundOwner = WindowOwner(foreground);
        var windows = new List<object>();
        EnumCallback callback = delegate(IntPtr hwnd, IntPtr unused)
        {
            uint pid; uint tid = GetWindowThreadProcessId(hwnd, out pid);
            if (pid == wowPid)
            {
                var name = new StringBuilder(256); SetLastError(0); int chars = GetClassName(hwnd, name, name.Capacity); int error = Marshal.GetLastWin32Error();
                windows.Add(new Dictionary<string, object> {
                    { "owner", WindowOwner(hwnd) }, { "class", chars > 0 ? name.ToString() : null }, { "class_last_error_raw", error },
                    { "IsWindowVisible", IsWindowVisible(hwnd) }, { "IsIconic", IsIconic(hwnd) }, { "thread_desktop", Desktop(tid) }, { "gui_thread", Gui(tid) }
                });
            }
            return true;
        };
        SetLastError(0); bool enumerated = EnumWindows(callback, IntPtr.Zero); int enumError = Marshal.GetLastWin32Error();
        var snapshot = new Dictionary<string, object> {
            { "utc", DateTime.UtcNow.ToString("o") }, { "started_windows_qpc_ms", start },
            { "process_window_station", stationRecord }, { "GetThreadDesktop", threadDesktop }, { "OpenInputDesktop", inputRecord },
            { "GetForegroundWindow", foregroundOwner }, { "GetGUIThreadInfo_0", Gui(0) },
            { "enum_windows_success", enumerated }, { "enum_windows_last_error_raw", enumError }, { "wow_windows", windows },
            { "sessions", new object[] { Session(0), Session(1), Session(2) } },
            { "active_console_session_id", WTSGetActiveConsoleSessionId() }, { "reported_os_version", Environment.OSVersion.Version.ToString() },
            { "foreground_api_error_note", "GetForegroundWindow has no documented extended error for NULL; WindowOwner error belongs to GetWindowThreadProcessId." }
        };
        snapshot["finished_windows_qpc_ms"] = Clock.PreciseMs;
        return snapshot;
    }
}
