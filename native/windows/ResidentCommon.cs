// C# 5 / inbox .NET Framework. No installation, global settings or credentials.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using WowJev.Input;

static class ResidentWire
{
    public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=1048576, RecursionLimit=64 };
    public static Dictionary<string,object> Obj(params object[] values) {var r=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)r.Add((string)values[i],values[i+1]);return r;}
    public static Dictionary<string,object> Map(object o){var r=o as Dictionary<string,object>;Need(r!=null,"object_required");return r;}
    public static object Field(Dictionary<string,object> d,string k){Need(d.ContainsKey(k),"missing_"+k);return d[k];}
    public static string Text(Dictionary<string,object>d,string k){var s=Field(d,k)as string;Need(s!=null,"string_"+k);return s;}
    public static double Num(Dictionary<string,object>d,string k){return Convert.ToDouble(Field(d,k),System.Globalization.CultureInfo.InvariantCulture);}
    public static int Int(Dictionary<string,object>d,string k){return checked((int)Num(d,k));}
    public static bool Bool(Dictionary<string,object>d,string k){return (bool)Field(d,k);}
    public static void Need(bool yes,string reason){if(!yes)throw new InvalidOperationException(reason);}
    public static string Encode(object value){lock(Json)return Json.Serialize(value);}
    public static object Decode(string value){lock(Json)return Json.DeserializeObject(value);}
    public static string Hash(byte[] bytes){using(var h=SHA256.Create())return Hex(h.ComputeHash(bytes));}
    public static string HashFile(string path){using(var f=File.OpenRead(path))using(var h=SHA256.Create())return Hex(h.ComputeHash(f));}
    public static string Hex(byte[] bytes){return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();}
    public static string SerializeHash(object value){return Hash(Encoding.UTF8.GetBytes(Encode(value)));}
    public static string Canonical(object value){var map=value as Dictionary<string,object>;if(map!=null){var keys=new List<string>(map.Keys);keys.Sort(StringComparer.Ordinal);return "{"+String.Join(",",keys.Select(k=>Encode(k)+":"+Canonical(map[k])))+"}";}var array=value as object[];if(array!=null)return "["+String.Join(",",array.Select(Canonical))+"]";return Encode(value);}
    public static string ActionHash(object value){return Hash(Encoding.UTF8.GetBytes(Canonical(value)));}
    public static void WriteNew(string path,object value){using(var f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read))using(var w=new StreamWriter(f,new UTF8Encoding(false))){w.Write(Encode(value));w.Write('\n');}}
    public static string ReadBounded(TextReader reader,int limit){var b=new StringBuilder();int c;while((c=reader.Read())!=-1){if(c==10)return b.ToString().TrimEnd('\r');Need(b.Length<limit,"line_too_large");b.Append((char)c);}return b.Length==0?null:b.ToString();}
    public static bool Same(object a,object b){
        var x=a as Dictionary<string,object>;var y=b as Dictionary<string,object>;
        if(x!=null||y!=null){if(x==null||y==null||x.Count!=y.Count)return false;foreach(var kv in x)if(!y.ContainsKey(kv.Key)||!Same(kv.Value,y[kv.Key]))return false;return true;}
        var aa=a as object[];var bb=b as object[];
        if(aa!=null||bb!=null){if(aa==null||bb==null||aa.Length!=bb.Length)return false;for(int i=0;i<aa.Length;i++)if(!Same(aa[i],bb[i]))return false;return true;}
        if(a==null||b==null)return a==b;
        if(IsNumber(a)&&IsNumber(b))return Convert.ToDouble(a)==Convert.ToDouble(b);
        return Object.Equals(a,b);
    }
    static bool IsNumber(object value){return value is int||value is long||value is double||value is decimal||value is uint;}
    public static object Clone(object value){return Decode(Encode(value));}
}

// The wire definitions, not hand-written language DTOs, are the format authority.
sealed class ResidentSchema
{
    readonly Dictionary<string,object> root,native;
    public ResidentSchema(string path,string nativePath){root=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(path)));native=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(nativePath)));}
    public void Definition(object value,string name){Check(value,ResidentWire.Map(ResidentWire.Field(ResidentWire.Map(root["definitions"]),name)),root,0);}
    void Check(object value,Dictionary<string,object> schema,Dictionary<string,object> authority,int depth){
        ResidentWire.Need(depth<64,"schema_depth");
        if(schema.ContainsKey("$ref")){
            string reference=(string)schema["$ref"];var use=authority;string path=reference;
            if(reference.StartsWith("urn:wow-input:protocol:native-v1#")){use=native;path=reference.Substring("urn:wow-input:protocol:native-v1".Length);}
            ResidentWire.Need(path.StartsWith("#/"),"schema_reference");object row=use;foreach(string part in path.Substring(2).Split('/'))row=ResidentWire.Map(row)[part];Check(value,ResidentWire.Map(row),use,depth+1);return;
        }
        if(schema.ContainsKey("allOf"))foreach(object branch in (object[])schema["allOf"])Check(value,ResidentWire.Map(branch),authority,depth+1);
        if(schema.ContainsKey("oneOf")){int passed=0;foreach(object branch in (object[])schema["oneOf"])try{Check(value,ResidentWire.Map(branch),authority,depth+1);passed++;}catch(InvalidOperationException){}ResidentWire.Need(passed==1,"schema_oneof");}
        if(schema.ContainsKey("type")){
            object[] choices=schema["type"]as object[]??new object[]{schema["type"]};bool ok=false;
            foreach(object kind in choices){string k=(string)kind;ok|=k=="null"?value==null:k=="object"?value is Dictionary<string,object>:k=="array"?value is object[]:k=="string"?value is string:k=="boolean"?value is bool:k=="number"?value is int||value is long||value is double||value is decimal:k=="integer"?value is int||value is long||value is double&&Math.Truncate((double)value)==(double)value:false;}
            ResidentWire.Need(ok,"schema_type");
        }
        if(schema.ContainsKey("const"))ResidentWire.Need(ResidentWire.Same(value,schema["const"]),"schema_const");
        if(schema.ContainsKey("enum"))ResidentWire.Need(((object[])schema["enum"]).Any(v=>ResidentWire.Same(value,v)),"schema_enum");
        var map=value as Dictionary<string,object>;if(map!=null){
            if(schema.ContainsKey("required"))foreach(string k in (object[])schema["required"])ResidentWire.Need(map.ContainsKey(k),"schema_required");
            var props=schema.ContainsKey("properties")?ResidentWire.Map(schema["properties"]):new Dictionary<string,object>();
            foreach(var kv in map){if(props.ContainsKey(kv.Key))Check(kv.Value,ResidentWire.Map(props[kv.Key]),authority,depth+1);else if(schema.ContainsKey("additionalProperties")){var add=schema["additionalProperties"];ResidentWire.Need(!(add is bool)||((bool)add),"schema_extra");if(add is Dictionary<string,object>)Check(kv.Value,ResidentWire.Map(add),authority,depth+1);}}
            if(schema.ContainsKey("minProperties"))ResidentWire.Need(map.Count>=Convert.ToInt32(schema["minProperties"]),"schema_properties");
        }
        var array=value as object[];if(array!=null){if(schema.ContainsKey("minItems"))ResidentWire.Need(array.Length>=Convert.ToInt32(schema["minItems"]),"schema_array");if(schema.ContainsKey("maxItems"))ResidentWire.Need(array.Length<=Convert.ToInt32(schema["maxItems"]),"schema_array");if(schema.ContainsKey("items"))foreach(var item in array)Check(item,ResidentWire.Map(schema["items"]),authority,depth+1);if(schema.ContainsKey("uniqueItems")&&(bool)schema["uniqueItems"])for(int i=0;i<array.Length;i++)for(int j=0;j<i;j++)ResidentWire.Need(!ResidentWire.Same(array[i],array[j]),"schema_unique");}
        if(value is string){string s=(string)value;if(schema.ContainsKey("pattern"))ResidentWire.Need(Regex.IsMatch(s,(string)schema["pattern"]),"schema_pattern");if(schema.ContainsKey("minLength"))ResidentWire.Need(s.Length>=Convert.ToInt32(schema["minLength"]),"schema_length");if(schema.ContainsKey("maxLength"))ResidentWire.Need(s.Length<=Convert.ToInt32(schema["maxLength"]),"schema_length");}
        if(value is int||value is long||value is double||value is decimal){double n=Convert.ToDouble(value);ResidentWire.Need(!Double.IsNaN(n)&&!Double.IsInfinity(n),"schema_finite");if(schema.ContainsKey("minimum"))ResidentWire.Need(n>=Convert.ToDouble(schema["minimum"]),"schema_minimum");if(schema.ContainsKey("maximum"))ResidentWire.Need(n<=Convert.ToDouble(schema["maximum"]),"schema_maximum");}
    }
}

static class ResidentFrameClock
{
    // SystemRelativeTime is kept in its own source domain until alignment is
    // verified. Only the actual FrameArrived QPC can establish acquisition.
    public static bool Fresh(double requested,double arrived,double now,double render,double previousRender)
    {
        return !Double.IsNaN(render)&&!Double.IsInfinity(render)&&render>=0&&render>previousRender&&
            !Double.IsNaN(arrived)&&!Double.IsInfinity(arrived)&&arrived>=requested&&arrived<=now;
    }
}

static class ResidentRoiBytes
{
    public static byte[] Slice(byte[] pixels,int width,int height,Rectangle rectangle)
    {
        ResidentWire.Need(pixels!=null&&width>0&&height>0&&pixels.Length==checked(width*height*4)&&
            rectangle.X>=0&&rectangle.Y>=0&&rectangle.Width>0&&rectangle.Height>0&&rectangle.Right<=width&&rectangle.Bottom<=height,"roi_slice_bounds");
        var result=new byte[checked(rectangle.Width*rectangle.Height*4)];
        for(int y=0;y<rectangle.Height;y++)Buffer.BlockCopy(pixels,checked(((rectangle.Y+y)*width+rectangle.X)*4),result,y*rectangle.Width*4,rectangle.Width*4);
        return result;
    }
}

static class ResidentIdentity
{
    public static string TargetScope="retail_wow",FixtureExecutable=null,FixtureHash=null;
    static long fixtureVerifiedStart;
    [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct Cursor {public uint Size,Flags;public IntPtr Handle;public Point Position;}
    [StructLayout(LayoutKind.Sequential)] struct Gui {public uint Size,Flags;public IntPtr Active,Focus,Capture,Menu,MoveSize,Caret;public Rect CaretRect;}
    [StructLayout(LayoutKind.Sequential)] struct SystemTimes {public long Boot,Current,TimeZone;public uint TimeZoneId,Reserved;public ulong BootBias,SleepBias;}
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind,out SystemTimes times,int size,out int returned);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder value,int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref Cursor cursor);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref Gui gui);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll",SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int bytes,out int needed);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("wtsapi32.dll",SetLastError=true)]static extern bool WTSQuerySessionInformation(IntPtr server,int session,int information,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")]static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out Rect rect,int size);
    public static string ClockId(){SystemTimes t;int returned;ResidentWire.Need(NtQuerySystemInformation(3,out t,Marshal.SizeOf(typeof(SystemTimes)),out returned)>=0&&t.Boot>0,"clock_boot_identity_unknown");return "windows-qpc-boot-"+t.Boot.ToString(System.Globalization.CultureInfo.InvariantCulture);}
    public static IntPtr Hwnd(Dictionary<string,object> target){return new IntPtr(unchecked((long)UInt64.Parse(ResidentWire.Text(target,"hwnd").Substring(2),System.Globalization.NumberStyles.HexNumber)));}
    public static Dictionary<string,object> Check(Dictionary<string,object> target){
        int pid=ResidentWire.Int(target,"pid");long ticks=Int64.Parse(ResidentWire.Text(target,"start_ticks"));IntPtr hwnd=Hwnd(target);
        ResidentWire.Need(Native.IsProcessAlive(pid,ticks),"target_process_changed");WindowInfo window=Native.GetWindow(hwnd);ResidentWire.Need(window.Pid==pid,"target_hwnd_changed");
        using(var process=Process.GetProcessById(pid)){
            ResidentWire.Need(process.SessionId==1&&String.Equals(process.MainModule.FileName,ResidentWire.Text(target,"executable"),StringComparison.OrdinalIgnoreCase),"target_executable_changed");
            if(TargetScope=="retail_wow")ResidentWire.Need(String.Equals(process.ProcessName,"Wow",StringComparison.OrdinalIgnoreCase)&&process.MainModule.FileName.EndsWith("\\_retail_\\Wow.exe",StringComparison.OrdinalIgnoreCase),"retail_wow_required");
            else {
                ResidentWire.Need(TargetScope=="recording_fixture"&&String.Equals(process.ProcessName,"ResidentRecordingWindow",StringComparison.OrdinalIgnoreCase)&&String.Equals(process.MainModule.FileName,FixtureExecutable,StringComparison.OrdinalIgnoreCase)&&ResidentWire.Text(target,"class")=="WowJevResidentRecordingWindowV1","fixed_recording_fixture_identity_required");
                if(fixtureVerifiedStart!=ticks){ResidentWire.Need(ResidentWire.HashFile(FixtureExecutable)==FixtureHash,"recording_fixture_binary_changed");fixtureVerifiedStart=ticks;}
            }
        }
        var klass=new StringBuilder(256);ResidentWire.Need(GetClassName(hwnd,klass,klass.Capacity)>0&&klass.ToString()==ResidentWire.Text(target,"class"),"target_class_changed");
        Rect client;var origin=new Point();ResidentWire.Need(GetClientRect(hwnd,out client)&&ClientToScreen(hwnd,ref origin),"client_geometry_unknown");int dpi=checked((int)GetDpiForWindow(hwnd));ResidentWire.Need(dpi>=48&&window.Width>0&&window.Height>0&&(long)window.Width*window.Height<=64000000,"client_dimensions_unknown");
        return ResidentWire.Obj("hwnd",ResidentWire.Text(target,"hwnd"),"pid",pid,"client_width",window.Width,"client_height",window.Height,"focused",window.Focused,"class",klass.ToString(),"executable",ResidentWire.Text(target,"executable"),"start_ticks",ResidentWire.Text(target,"start_ticks"),"dpi",dpi,"visible",IsWindowVisible(hwnd),"minimized",IsIconic(hwnd),"client_rect",ResidentWire.Obj("left",origin.X,"top",origin.Y,"right",origin.X+window.Width,"bottom",origin.Y+window.Height));
    }
    public static Rect FrameBounds(IntPtr hwnd){Rect r;ResidentWire.Need(DwmGetWindowAttribute(hwnd,9,out r,Marshal.SizeOf(typeof(Rect)))>=0&&r.Right>r.Left&&r.Bottom>r.Top,"wgc_frame_geometry_unknown");return r;}
    public static Dictionary<string,object> CursorState(IntPtr hwnd){
        uint pid;uint thread=GetWindowThreadProcessId(hwnd,out pid);var cursor=new Cursor{Size=(uint)Marshal.SizeOf(typeof(Cursor))};var gui=new Gui{Size=(uint)Marshal.SizeOf(typeof(Gui))};bool known=thread>0&&GetCursorInfo(ref cursor)&&GetGUIThreadInfo(thread,ref gui);
        bool held=Native.IsMouseDown(1)||Native.IsMouseDown(2)||Native.IsMouseDown(4);bool visible=(cursor.Flags&1)!=0;bool free=known&&visible&&cursor.Handle!=IntPtr.Zero&&gui.Capture==IntPtr.Zero;
        return ResidentWire.Obj("status",known?"known":"unknown","cursor_visible",known?(object)visible:null,"cursor_free",known?(object)free:null,"mouse_buttons_held",known?(object)held:null,"cursor_flags",known?(object)cursor.Flags:null,"capture_hwnd",known?(object)("0x"+gui.Capture.ToInt64().ToString("x")):null,"target_thread_id",thread,"sampled_qpc_ms",Clock.PreciseMs,"reason",known?null:"native_cursor_state_unknown");
    }
    static object DesktopName(IntPtr desktop){if(desktop==IntPtr.Zero)return null;int bytes;var name=new StringBuilder(256);return GetUserObjectInformation(desktop,2,name,512,out bytes)?(object)name.ToString():null;}
    public static Dictionary<string,object> DesktopDiagnostic(){
        IntPtr thread=GetThreadDesktop(GetCurrentThreadId()),input=OpenInputDesktop(0,false,1);int inputError=input==IntPtr.Zero?Marshal.GetLastWin32Error():0;object inputName=DesktopName(input);if(input!=IntPtr.Zero)CloseDesktop(input);
        IntPtr wts;int bytes;object state=null;int wtsError=0;if(WTSQuerySessionInformation(IntPtr.Zero,1,8,out wts,out bytes)){try{if(bytes>=4)state=Marshal.ReadInt32(wts);}finally{WTSFreeMemory(wts);}}else wtsError=Marshal.GetLastWin32Error();
        IntPtr foreground=GetForegroundWindow();uint foregroundPid;GetWindowThreadProcessId(foreground,out foregroundPid);
        return ResidentWire.Obj("thread_desktop",DesktopName(thread),"input_desktop",inputName,"input_desktop_error",inputError,"wts_connect_state",state,"wts_error",wtsError,"foreground_hwnd","0x"+foreground.ToInt64().ToString("x"),"foreground_pid",foregroundPid,"session_id",1,"at_windows_qpc_ms",Clock.PreciseMs);
    }
}
