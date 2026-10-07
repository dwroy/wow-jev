// One explicitly authorized window-state operation; no keyboard/mouse port.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using WowJev.Input;
static class ForegroundOccluderMinimizer {
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",SetLastError=true)]static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 static readonly IntPtr Wow=new IntPtr(0x904a6),Other=new IntPtr(0x3607de);
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 static void Need(bool b,string code){if(!b)throw new InvalidOperationException(code);}
 static Dictionary<string,object> Map(object o){return(Dictionary<string,object>)o;}
 static string Text(Dictionary<string,object>d,string k){return Convert.ToString(d[k]);}
 static int Main(string[] args){
  var result=new Dictionary<string,object>{{"operation","minimize_one_verified_occluder"},{"game_inputs",0},{"keys_mouse_inputs",0},{"release_scope","no_input_executor_acquired"},{"target_hwnd","0x904a6"},{"occluder_hwnd","0x3607de"},{"operation_issued",false},{"foreground_confirmed",false}};
  try{
   Need(args.Length==2,"out_and_cancel_required");string output=args[0],cancel=args[1];
   Need(!File.Exists(cancel),"cancelled");Need(Process.GetCurrentProcess().SessionId==1,"interactive_session1_required");Native.MakeDpiAware();
   var proof=Native.GetRecoveryVisibilityDiagnostic(Wow);result["before"]=proof;
   Need(Text(proof,"status")=="observed","desktop_unknown");
   Need(Convert.ToBoolean(Map(proof["input_desktop"])["receives_input"]),"input_desktop_unavailable");
   var target=Map(proof["target"]);Need(Convert.ToInt32(target["pid"])==22072&&Text(target,"process_start_ticks")=="639268827443062278"&&Text(target,"class")=="waApplication Window"&&Convert.ToInt32(target["session_id"])==1,"target_identity_changed");
   Need(Convert.ToBoolean(target["visible"])&&!Convert.ToBoolean(target["minimized"]),"target_not_visible");
   var idle=Map(proof["last_input"]);Need(Convert.ToBoolean(idle["idle_known"])&&Convert.ToDouble(idle["user_idle_ms"])>5000,"recent_or_unknown_human_input");
   var cursor=Map(proof["cursor"]);Need(!Convert.ToBoolean(cursor["left_button_down"])&&!Convert.ToBoolean(cursor["right_button_down"])&&!Convert.ToBoolean(cursor["middle_button_down"]),"human_mouse_held");
   Need(GetForegroundWindow()==Other,"occluder_not_current_foreground");uint owner;GetWindowThreadProcessId(Other,out owner);Need(owner==32924,"occluder_pid_changed");
   using(var process=Process.GetProcessById(32924))Need(process.SessionId==1&&process.ProcessName=="WindowsTerminal"&&process.StartTime.ToUniversalTime().Ticks.ToString()=="639269272456499052","occluder_process_changed");
   var name=new StringBuilder(256);GetClassName(Other,name,256);Need(name.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"&&!IsIconic(Other),"occluder_class_or_state_changed");
   bool overlapping=false;foreach(object item in (List<object>)proof["related_z_order"]){var row=Map(item);if(Text(row,"hwnd")=="0x3607de"&&Convert.ToInt32(row["z_index"])<Convert.ToInt32(target["z_index"])&&Convert.ToBoolean(row["visible"])&&!Convert.ToBoolean(row["minimized"]))overlapping=true;}
   Need(overlapping,"occluder_overlap_not_verified");Need(!File.Exists(cancel),"cancelled");
   result["gate_qpc_ms"]=Clock.PreciseMs;bool accepted=ShowWindowAsync(Other,6);result["show_window_accepted"]=accepted;result["show_window_error_raw"]=Marshal.GetLastWin32Error();result["operation_issued"]=true;
   double end=Clock.PreciseMs+1500;while(Clock.PreciseMs<end&&GetForegroundWindow()!=Wow&&!File.Exists(cancel))Thread.Sleep(20);
   result["foreground_hwnd"]="0x"+GetForegroundWindow().ToInt64().ToString("x");result["occluder_minimized"]=IsIconic(Other);
   Need(!File.Exists(cancel),"cancelled");Need(GetForegroundWindow()==Wow&&Native.GetWindow(Wow).Pid==22072&&Native.IsProcessAlive(22072,639268827443062278L),"focus_not_confirmed_after_minimize");
   result["foreground_confirmed"]=true;result["status"]="completed";result["finished_qpc_ms"]=Clock.PreciseMs;File.WriteAllText(Path.Combine(output,"result.json"),Json.Serialize(result),new UTF8Encoding(false));return 0;
  }catch(Exception e){result["status"]="blocked";result["reason"]=e is InvalidOperationException?e.Message:e.GetType().Name;result["finished_qpc_ms"]=Clock.PreciseMs;if(args.Length>=1)try{File.WriteAllText(Path.Combine(args[0],"result.json"),Json.Serialize(result),new UTF8Encoding(false));}catch{}return 2;}
 }
}
