// Native session-0 fixture: an unactivated synthetic launcher-like form only.
// No real game/Battle.net window inspection, activation, capture, or input.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
using System.Text;
using WowJev.Input;

static class RecoveryWindowDiscoveryFixture
{
    sealed class PassiveForm : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    static int checks;
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")]static extern bool IsIconic(IntPtr handle);
    static void Check(bool value,string reason){if(!value)throw new InvalidOperationException(reason);checks++;}
    [STAThread] static int Main(string[] args)
    {
        try
        {
            using(Process self=Process.GetCurrentProcess())
            {
                Check(self.SessionId==0,"fixture_must_never_run_on_interactive_desktop");Native.MakeDpiAware();
                if(args.Length>0)
                {
                    Console.OutputEncoding=new UTF8Encoding(false);
                    Check(args.Length==2&&args[0]=="--ocr-file","exact_offline_ocr_fixture_options_required");
                    Check(Regex.IsMatch(args[1],@"^\\\\(?:wsl\.localhost|wsl\$)\\[A-Za-z0-9_.-]+\\home\\dw\\Projects\\wow-jev\\out\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*\\client\.png$",RegexOptions.IgnoreCase),"existing_project_capture_only");
                    foreach(string part in args[1].Split('\\'))Check(part!="."&&part!="..","path_traversal_rejected");
                    Console.WriteLine(new JavaScriptSerializer().Serialize(RecoveryOcr.Read(args[1])));return 0;
                }
                Check(RecoveryWindowDiscovery.Candidate(self.Id,(uint)self.Id,true,false,300,180),"visible_launcher_class_snapshot_accepted");
                Check(!RecoveryWindowDiscovery.Candidate(self.Id,(uint)self.Id,false,false,300,180),"hidden_snapshot_refused");
                Check(!RecoveryWindowDiscovery.Candidate(self.Id,(uint)self.Id,true,true,300,180),"minimized_snapshot_refused");
                Check(!RecoveryWindowDiscovery.Candidate(self.Id,(uint)self.Id+1,true,false,300,180),"other_pid_snapshot_refused");
                Check(!RecoveryWindowDiscovery.Candidate(self.Id,(uint)self.Id,true,false,0,180),"empty_client_snapshot_refused");
                using(var visible=new PassiveForm())using(var hidden=new PassiveForm())
                {
                    visible.Text="Synthetic launcher discovery boundary";visible.ClientSize=new Size(300,180);visible.ShowInTaskbar=false;
                    hidden.Text="Synthetic hidden launcher";hidden.ClientSize=new Size(100,80);IntPtr hiddenHandle=hidden.Handle;
                    visible.Show();Application.DoEvents();IntPtr handle=visible.Handle;
                    Check(!Native.ListCandidates().Exists(delegate(WindowInfo item){return item.Hwnd==handle;}),"game_filter_excludes_generic_launcher_class");
                    var found=RecoveryWindowDiscovery.VisibleForVerifiedPid(self.Id);
                    // Session 0 has no visible input desktop here: WinForms may
                    // report Visible while Win32 correctly reports nonvisible.
                    bool nativeVisible=IsWindowVisible(handle);
                    bool present=found.Exists(delegate(WindowInfo item){return item.Hwnd==handle&&item.Pid==self.Id&&item.Width>0&&item.Height>0;});
                    Check(present==nativeVisible,"native_visibility_controls_enumeration_without_game_class_filter");
                    Check(!found.Exists(delegate(WindowInfo item){return item.Hwnd==hiddenHandle;}),"hidden_window_excluded");
                    Check(RecoveryWindowDiscovery.VisibleForVerifiedPid(Int32.MaxValue).Count==0,"other_pid_never_enumerated");
                    visible.WindowState=FormWindowState.Minimized;Application.DoEvents();
                    Check(!RecoveryWindowDiscovery.VisibleForVerifiedPid(self.Id).Exists(delegate(WindowInfo item){return item.Hwnd==handle;}),"minimized_window_excluded");
                    visible.Hide();Check(!RecoveryWindowDiscovery.VisibleForVerifiedPid(self.Id).Exists(delegate(WindowInfo item){return item.Hwnd==handle;}),"hidden_previous_window_excluded");
                    bool invalid=false;try{RecoveryWindowDiscovery.VisibleForVerifiedPid(0);}catch(ArgumentException){invalid=true;}Check(invalid,"invalid_pid_refused");
                }
                // Delay the controller's validation for longer than its native
                // 1000ms lease. The independent worker must continue heartbeat
                // writes, and concurrent control commands remain complete JSON.
                var rows=new List<string>();var times=new List<long>();var watch=Stopwatch.StartNew();object rowsLock=new object();
                using(var pump=new RecoveryHeartbeatPump(Guid.NewGuid().ToString("D"),delegate(string line){lock(rowsLock){rows.Add(line);times.Add(watch.ElapsedMilliseconds);}Thread.Sleep(3);}))
                {
                    var controls=new Thread(delegate(){for(int i=0;i<20;i++){pump.Send("control-"+i,"status",null);Thread.Sleep(25);}});controls.Start();
                    Thread.Sleep(1350);controls.Join();Check(!pump.Failed&&pump.HeartbeatCount>=6,"slow_validation_does_not_starve_heartbeat");
                    pump.Send("release","release_all",null);pump.Send("shutdown","shutdown",null);
                }
                var ids=new HashSet<string>();long lastBeat=-1;int heartbeats=0;foreach(string line in rows)
                {
                    var value=(Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(line);Check(ids.Add((string)value["id"]),"all_writes_unique_and_valid_complete_json");
                    if((string)value["op"]=="heartbeat"){int index=rows.IndexOf(line);if(lastBeat>=0)Check(times[index]-lastBeat<1000,"heartbeat_gap_below_native_lease");lastBeat=times[index];heartbeats++;}
                }
                Check(heartbeats>=6,"heartbeat_worker_sent_during_delayed_gate");
            }
            Console.WriteLine("{\"status\":\"passed\",\"checks\":"+checks+",\"session_id\":0,\"game_inputs\":0,\"game_captures\":0,\"launches\":0,\"scope\":\"pure_launcher_predicates_and_session0_hidden_window_enumeration_plus_delayed_heartbeat\",\"session1_launcher_positive_verified\":false}");return 0;
        }
        catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
