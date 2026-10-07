// Explicit one-shot visible-background activation trial. Reuses native admission,
// ownership ledger, SendInput packets and independent WinInputWatchdog.
using System;using System.Collections.Generic;using System.Diagnostics;using System.IO;using System.Runtime.InteropServices;using System.Threading;using System.Web.Script.Serialization;using WowJev.Input;
static class ForegroundClickTrial {
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int L,T,R,B;}
 [StructLayout(LayoutKind.Sequential)]struct Gui{public uint Size,Flags;public IntPtr Active,Focus,Capture,Menu,Move,Caret;public Rect CaretRect;}
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",SetLastError=true)]static extern bool GetGUIThreadInfo(uint thread,ref Gui g);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 static readonly IntPtr Wow=new IntPtr(0x904a6),ExpectedForeground=new IntPtr(0x3607de);static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 static void Need(bool b,string reason){if(!b)throw new InvalidOperationException(reason);}
 static Dictionary<string,object> Map(object v){return(Dictionary<string,object>)v;}
 static string S(Dictionary<string,object>d,string k){return Convert.ToString(d[k]);}
 static Dictionary<string,object> Proof(string cancel){
  Need(!File.Exists(cancel),"cancelled");Need(Process.GetCurrentProcess().SessionId==1,"session1_required");var d=Native.GetRecoveryVisibilityDiagnostic(Wow);
  Need(S(d,"status")=="observed"&&Convert.ToBoolean(Map(d["input_desktop"])["receives_input"]),"input_desktop_unknown");var t=Map(d["target"]);
  Need(Convert.ToInt32(t["pid"])==22072&&S(t,"process_start_ticks")=="639268827443062278"&&S(t,"class")=="waApplication Window"&&Convert.ToInt32(t["session_id"])==1,"target_identity_changed");
  using(var p=Process.GetProcessById(22072))Need(p.MainModule.FileName.Equals(@"C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe",StringComparison.OrdinalIgnoreCase),"target_path_changed");
  Need(GetForegroundWindow()==ExpectedForeground,"initial_foreground_changed");var idle=Map(d["last_input"]);Need(Convert.ToBoolean(idle["idle_known"])&&Convert.ToDouble(idle["user_idle_ms"])>5000,"recent_human_input");
  var c=Map(d["cursor"]);Need(Convert.ToBoolean(c["known"])&&!Convert.ToBoolean(c["left_button_down"])&&!Convert.ToBoolean(c["right_button_down"])&&!Convert.ToBoolean(c["middle_button_down"]),"pointer_or_buttons_unknown");
  // This explicit trial distinguishes OS suppression from an unknown/hidden
  // mouse-look cursor. It does not change the ordinary production cursor gate.
  int flags=Convert.ToInt32(c["flags"]);Need(Convert.ToBoolean(c["visible"])||flags==2&&S(c,"handle")=="0x0","cursor_state_unsupported");
  foreach(IntPtr h in new[]{Wow,ExpectedForeground}){uint pid;uint thread=GetWindowThreadProcessId(h,out pid);var g=new Gui{Size=(uint)Marshal.SizeOf(typeof(Gui))};Need(thread>0&&GetGUIThreadInfo(thread,ref g)&&g.Capture==IntPtr.Zero,"mouse_capture_unknown_or_held");}
  var point=Native.GetRecoveryPointSafety(Wow,1536,360);Need(Convert.ToBoolean(point["visible"])&&!Convert.ToBoolean(point["minimized"])&&Convert.ToBoolean(point["on_monitor"])&&Convert.ToBoolean(point["point_owned"])&&Convert.ToBoolean(point["point_visible"]),"background_point_not_visible_target");
  var w=Native.GetWindow(Wow);Need(w.Width==2560&&w.Height==1440,"reviewed_layout_changed");d["background_point_safety"]=point;return d;
 }
 static int Main(string[] args){
  var r=new Dictionary<string,object>{{"op","focus_click"},{"single_attempt",true},{"target_hwnd","0x904a6"},{"client_point",new[]{1536,360}},{"input_issued",false},{"sendinput_requested",2},{"sendinput_return",null},{"sendinput_last_error_raw",null},{"focus_confirmed",false},{"normal_game_gate_unchanged",true}};
  LeaseStore store=null;Process guard=null;Mutex admission=null;bool owns=false;Timer pulse=null;
  try{
   Need(args.Length==2,"out_cancel_required");Native.MakeDpiAware();r["before"]=Proof(args[1]);admission=new Mutex(false,LeaseStore.GlobalExecutorAdmissionMutexName);try{owns=admission.WaitOne(0);}catch(AbandonedMutexException){owns=true;}Need(owns,"executor_admission_busy");
   string session=Guid.NewGuid().ToString("D");r["session_id"]=session;store=new LeaseStore(session,true);int self=Process.GetCurrentProcess().Id;long at=Clock.NowMs;store.Write(new LeaseSnapshot{ExecutorPid=self,ExecutorStartTimeTicks=Native.GetProcessStartTicks(self),ExecutorHeartbeatMs=at,ControllerHeartbeatMs=at});
   string path=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"WinInputWatchdog.exe");var start=new ProcessStartInfo(path,"serve --session "+session+" --executor-pid "+self);start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;guard=Process.Start(start);r["watchdog_pid"]=guard.Id;var go=new Thread(delegate(){try{while(guard.StandardOutput.ReadLine()!=null){}}catch{}});go.IsBackground=true;go.Start();var ge=new Thread(delegate(){try{while(guard.StandardError.ReadLine()!=null){}}catch{}});ge.IsBackground=true;ge.Start();
   pulse=new Timer(delegate(object unused){try{store.WithLock(delegate(LeaseSnapshot s){s.ExecutorHeartbeatMs=Clock.NowMs;s.ControllerHeartbeatMs=Clock.NowMs;});}catch{}},null,0,100);
   double until=Clock.PreciseMs+3000;while(!store.Read().WatchdogReady&&Clock.PreciseMs<until&&!guard.HasExited)Thread.Sleep(10);Need(store.Read().WatchdogReady&&!guard.HasExited,"independent_watchdog_not_ready");
   r["before_send"]=Proof(args[1]);int inserted=0;store.WithRegisteredInput(delegate(LeaseSnapshot s){Need(s.WatchdogReady&&!s.StopRequested&&s.HeldKeysMask==0&&s.HeldMouseMask==0,"ownership_not_clear");s.HeldMouseMask=1;s.LeaseDeadlineMs=Clock.NowMs+150;},delegate(LeaseSnapshot s){
    r["send_started_qpc_ms"]=Clock.PreciseMs;inserted=Native.Send(new[]{Native.MouseAbsolute(Wow,1536,360),Native.MouseButton(1,false)});r["send_finished_qpc_ms"]=Clock.PreciseMs;r["sendinput_return"]=inserted;r["sendinput_last_error_raw"]=Native.LastError;r["input_issued"]=inserted>0;if(inserted<2)s.HeldMouseMask=0;
   });
   Need(inserted==2,"sendinput_failed_or_partial");until=Clock.PreciseMs+60;while(Clock.PreciseMs<until&&!File.Exists(args[1]))Thread.Sleep(2);
   var up=store.ReleaseOwned("finite_focus_click_up");r["release_up_requested"]=up.Requested;r["release_up_inserted"]=up.Inserted;r["release_up_confirmed"]=up.Released;Need(up.Released,"release_unconfirmed");
   Need(!File.Exists(args[1]),"cancelled");until=Clock.PreciseMs+200;while(GetForegroundWindow()!=Wow&&Clock.PreciseMs<until)Thread.Sleep(5);Need(GetForegroundWindow()==Wow&&Native.GetWindow(Wow).Pid==22072,"focus_not_confirmed_after_click");r["focus_confirmed"]=true;r["status"]="completed";
  }catch(Exception e){r["status"]="blocked";r["reason"]=e is InvalidOperationException?e.Message:e.GetType().Name;}
  finally{
   if(store!=null){try{var rel=store.ReleaseOwned("focus_trial_finished");r["final_release_requested"]=rel.Requested;r["final_release_inserted"]=rel.Inserted;r["release_confirmed"]=rel.Released;store.WithLock(delegate(LeaseSnapshot s){s.StopRequested=true;s.StopReason="focus_trial_finished";});var state=store.Read();r["held_keys_mask"]=state.HeldKeysMask.ToString("x");r["held_mouse_mask"]=state.HeldMouseMask;}catch{r["release_confirmed"]=false;}}
   if(pulse!=null)pulse.Dispose();if(guard!=null){r["watchdog_exited"]=guard.WaitForExit(1500);guard.Dispose();}if(store!=null)store.Dispose();if(owns&&admission!=null)admission.ReleaseMutex();if(admission!=null)admission.Dispose();
   r["foreground_after"]="0x"+GetForegroundWindow().ToInt64().ToString("x");r["finished_qpc_ms"]=Clock.PreciseMs;if(args.Length>0)try{File.WriteAllText(Path.Combine(args[0],"result.json"),Json.Serialize(r),new System.Text.UTF8Encoding(false));}catch{}
  }return S(r,"status")=="completed"?0:2;
 }
}
