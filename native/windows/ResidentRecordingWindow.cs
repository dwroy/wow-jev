// Explicit project-owned recording surface. Compile alone; only an authorized
// interactive launch creates it. ShowWindow(SW_SHOWNOACTIVATE), no focus API/input.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using WowJev.Input;

static class ResidentRecordingWindow
{
    const string ClassName="WowJevResidentRecordingWindowV1";
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Hwnd;public uint Code;public IntPtr WParam,LParam;public uint Time;public Point Point;public uint Private;}
    [StructLayout(LayoutKind.Sequential)] struct Paint {public IntPtr Dc;public int Erase;public Rect Rect;public int Restore,Incremental;[MarshalAs(UnmanagedType.ByValArray,SizeConst=32)]public byte[] Reserved;}
    delegate IntPtr WindowProcedure(IntPtr hwnd,uint code,IntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {public uint Size,Style;public WindowProcedure Procedure;public int ClassBytes,WindowBytes;public IntPtr Instance,Icon,Cursor,Background;public string Menu,Name;public IntPtr SmallIcon;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern ushort RegisterClassEx(ref WindowClass cls);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowEx(uint extended,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
    [DllImport("user32.dll")]static extern IntPtr LoadCursor(IntPtr instance,IntPtr name);
    [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")]static extern bool UpdateWindow(IntPtr hwnd);
    [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")]static extern bool InvalidateRect(IntPtr hwnd,IntPtr rect,bool erase);
    [DllImport("user32.dll")]static extern IntPtr BeginPaint(IntPtr hwnd,out Paint paint);
    [DllImport("user32.dll")]static extern bool EndPaint(IntPtr hwnd,ref Paint paint);
    [DllImport("user32.dll")]static extern int FillRect(IntPtr dc,ref Rect rect,IntPtr brush);
    [DllImport("gdi32.dll")]static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern bool TextOut(IntPtr dc,int x,int y,string text,int count);
    [DllImport("gdi32.dll")]static extern uint SetTextColor(IntPtr dc,uint color);
    [DllImport("gdi32.dll")]static extern int SetBkMode(IntPtr dc,int mode);
    [DllImport("user32.dll")]static extern UIntPtr SetTimer(IntPtr hwnd,UIntPtr id,uint interval,IntPtr timer);
    [DllImport("user32.dll")]static extern bool KillTimer(IntPtr hwnd,UIntPtr id);
    [DllImport("user32.dll")]static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")]static extern void PostQuitMessage(int exit);
    [DllImport("user32.dll")]static extern int GetMessage(out Message message,IntPtr hwnd,uint first,uint last);
    [DllImport("user32.dll")]static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")]static extern IntPtr DefWindowProc(IntPtr hwnd,uint code,IntPtr wParam,IntPtr lParam);
    static readonly WindowProcedure Procedure=WndProc;static StreamWriter log;static string output;static uint count,nonce;static bool leftDown,rightDown;static double started;static int budget;
    static void Event(string kind,object detail){if(log!=null){log.WriteLine(ResidentWire.Encode(ResidentWire.Obj("event",kind,"clock","windows-qpc","at_ms",Clock.PreciseMs,"click_count",count,"frame_nonce",nonce,"detail",detail,"game_inputs",0,"game_effect","unverified")));log.Flush();}}
    static void Fill(IntPtr dc,int x,int y,int width,int height,uint color){var rect=new Rect{Left=x,Top=y,Right=x+width,Bottom=y+height};IntPtr brush=CreateSolidBrush(color);try{FillRect(dc,ref rect,brush);}finally{DeleteObject(brush);}}
    static void Bits(IntPtr dc,int y,uint value){for(int bit=0;bit<32;bit++)Fill(dc,32+bit*6,y,6,8,(value&(1u<<bit))!=0?0x0000ff00u:0x000000ffu);}
    static void Draw(IntPtr hwnd){Paint paint;IntPtr dc=BeginPaint(hwnd,out paint);try{Rect client;GetClientRect(hwnd,out client);Fill(dc,0,0,client.Right,client.Bottom,0x00202020);Fill(dc,32,80,192,80,0x00dc7800);Fill(dc,32,28,192,4,0x00ff00ff);Bits(dc,32,count);Bits(dc,48,nonce);SetTextColor(dc,0x00ffffff);SetBkMode(dc,1);string text="Recording fixture: click the blue control. ESC cancels. No WoW inputs.";TextOut(dc,32,185,text,text.Length);text="Input acknowledgements: "+count;TextOut(dc,32,210,text,text.Length);}finally{EndPaint(hwnd,ref paint);}}
    static bool Inside(IntPtr value){int packed=unchecked((int)value.ToInt64());int x=(short)(packed&65535),y=(short)((packed>>16)&65535);return x>=32&&x<224&&y>=80&&y<160;}
    static IntPtr WndProc(IntPtr hwnd,uint code,IntPtr wParam,IntPtr lParam){
        if(code==0xF){Draw(hwnd);return IntPtr.Zero;}
        if(code==0x113){if(Clock.PreciseMs-started>budget){Event("deadline",null);DestroyWindow(hwnd);}else{nonce++;InvalidateRect(hwnd,IntPtr.Zero,false);}return IntPtr.Zero;}
        if(code==0x201||code==0x204){if(code==0x201)leftDown=Inside(lParam);else rightDown=Inside(lParam);Event("mouse_down",ResidentWire.Obj("button",code==0x201?"left":"right","inside_control",Inside(lParam)));return IntPtr.Zero;}
        if(code==0x202||code==0x205){bool down=code==0x202?leftDown:rightDown;if(code==0x202)leftDown=false;else rightDown=false;if(down&&Inside(lParam))count++;Event("mouse_up",ResidentWire.Obj("button",code==0x202?"left":"right","paired_down",down,"inside_control",Inside(lParam)));InvalidateRect(hwnd,IntPtr.Zero,false);return IntPtr.Zero;}
        if(code==0x100&&wParam.ToInt64()==27){Event("escape_cancel",null);DestroyWindow(hwnd);return IntPtr.Zero;}
        if(code==2){KillTimer(hwnd,new UIntPtr(1));Event("window_destroyed",null);PostQuitMessage(0);return IntPtr.Zero;}
        return DefWindowProc(hwnd,code,wParam,lParam);
    }
    [STAThread]static int Main(string[] args){try{
        ResidentWire.Need(args.Length==4&&args[0]=="--out"&&args[2]=="--duration-ms","recording_fixed_options");output=Path.GetFullPath(args[1]);budget=Int32.Parse(args[3]);ResidentWire.Need(budget>=1000&&budget<=300000&&!output.StartsWith("\\\\")&&!Directory.Exists(output),"recording_local_output_and_budget");ResidentWire.Need(Process.GetCurrentProcess().SessionId==1,"recording_requires_session1");
        Native.MakeDpiAware();Directory.CreateDirectory(output);log=new StreamWriter(new FileStream(Path.Combine(output,"recording.jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));started=Clock.PreciseMs;
        IntPtr instance=GetModuleHandle(null);var cls=new WindowClass{Size=(uint)Marshal.SizeOf(typeof(WindowClass)),Procedure=Procedure,Instance=instance,Cursor=LoadCursor(IntPtr.Zero,new IntPtr(32512)),Name=ClassName};ResidentWire.Need(RegisterClassEx(ref cls)!=0,"recording_class_failed");
        IntPtr hwnd=CreateWindowEx(0,ClassName,"WoW Agent latency recording fixture",0x00cf0000,80,80,800,480,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero);ResidentWire.Need(hwnd!=IntPtr.Zero,"recording_window_failed");
        ResidentWire.WriteNew(Path.Combine(output,"recording-ready.json"),ResidentWire.Obj("target_scope","recording_fixture","pid",Process.GetCurrentProcess().Id,"start_ticks",Native.GetProcessStartTicks(Process.GetCurrentProcess().Id).ToString(),"hwnd","0x"+hwnd.ToInt64().ToString("x"),"class",ClassName,"executable",Process.GetCurrentProcess().MainModule.FileName,"windows_session_id",1,"duration_ms",budget,"foreground_requested",false,"game_effect","unverified"));
        SetTimer(hwnd,new UIntPtr(1),16,IntPtr.Zero);ShowWindow(hwnd,4);UpdateWindow(hwnd);Event("window_shown_noactivate",null);Message message;int status;while((status=GetMessage(out message,IntPtr.Zero,0,0))>0){TranslateMessage(ref message);DispatchMessage(ref message);}ResidentWire.Need(status>=0,"recording_message_failed");return 0;
    }catch(Exception e){Console.Error.WriteLine(e.Message);return 2;}finally{if(log!=null)log.Dispose();}}
}
