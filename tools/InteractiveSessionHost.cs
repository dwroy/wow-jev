// Bounded session-1 host. C# 5/.NET Framework 4; winexe never steals focus via a console.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using WowJev.Input;

static class InteractiveSessionHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    const string Retail = @"C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe";
    static string Output, Cancel;
    static double Started;
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct JobBasic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct JobExtended { public JobBasic Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,IntPtr security);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out JobExtended data,uint size,out uint returned);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll",SetLastError=true)] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Native.Point point);
    internal static Dictionary<string,object> Obj(params object[] items) { var value=new Dictionary<string,object>(StringComparer.Ordinal);for(int i=0;i<items.Length;i+=2)value.Add((string)items[i],items[i+1]);return value; }
    static void Need(bool condition,string reason) { if(!condition)throw new InvalidOperationException(reason); }
    static Dictionary<string,object> Map(object value) { var map=value as Dictionary<string,object>;Need(map!=null,"object_required");return map; }
    static object Field(Dictionary<string,object> value,string name) { Need(value.ContainsKey(name),"required_field_missing:"+name);return value[name]; }
    static string Text(Dictionary<string,object> value,string name) { string text=Field(value,name) as string;Need(!String.IsNullOrEmpty(text),"text_required:"+name);return text; }
    static int Number(Dictionary<string,object> value,string name) { object raw=Field(value,name);Need(raw is int,"integer_required:"+name);return (int)raw; }
    static double Numeric(Dictionary<string,object> value,string name) { return Convert.ToDouble(Field(value,name),CultureInfo.InvariantCulture); }
    static void Exact(Dictionary<string,object> value,params string[] fields) { Need(value.Count==fields.Length,"exact_fields_required");foreach(string field in fields)Need(value.ContainsKey(field),"exact_fields_required"); }
    static string Hash(string path) { using(var file=File.OpenRead(path))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant(); }
    static void WriteNew(string path,object value) { using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { byte[] bytes=new UTF8Encoding(false).GetBytes(Json.Serialize(value)+"\n");stream.Write(bytes,0,bytes.Length); } }
    static void WriteResult(object value) {string staged=Path.Combine(Output,"result.pending.json");WriteNew(staged,value);File.Move(staged,Path.Combine(Output,"result.json"));}
    static void SafePath(string path,bool directory) {
        Need(Regex.IsMatch(path,@"^\\\\(?:wsl\.localhost|wsl\$)\\[A-Za-z0-9_.-]+\\home\\dw\\Projects\\wow-jev\\out\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*$",RegexOptions.IgnoreCase),"project_output_unc_required");
        foreach(string part in path.Split('\\'))Need(part!="."&&part!="..","traversal_rejected");
        Need(String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase),"canonical_path_required");
        string current=directory?path:Path.GetDirectoryName(path);
        while(!String.IsNullOrEmpty(current)) {if(Directory.Exists(current)||File.Exists(current))Need((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"reparse_rejected");string parent=Path.GetDirectoryName(current);if(parent==current)break;current=parent;}
    }
    static void CheckCancel() { Need(!File.Exists(Cancel),"cancelled");Need(Clock.PreciseMs-Started<29000,"stage_deadline_exceeded"); }
    static IntPtr Handle(Dictionary<string,object> target) { string value=Text(target,"hwnd");Need(Regex.IsMatch(value,"^0x[0-9a-fA-F]{1,16}$"),"invalid_hwnd");return new IntPtr(Int64.Parse(value.Substring(2),NumberStyles.HexNumber,CultureInfo.InvariantCulture)); }
    static Dictionary<string,object> Target(Process process,WindowInfo window) {
        var name=new StringBuilder(256);Need(GetClassName(window.Hwnd,name,name.Capacity)>0,"window_class_unavailable");
        return Obj("pid",process.Id,"start_ticks",process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),"hwnd","0x"+window.Hwnd.ToInt64().ToString("x",CultureInfo.InvariantCulture),"class",name.ToString(),"executable",process.MainModule.FileName);
    }
    static WindowInfo Identity(Dictionary<string,object> target) {
        Exact(target,"pid","start_ticks","hwnd","class","executable");
        int pid=Number(target,"pid");Need(pid>0,"invalid_pid");
        using(Process process=Process.GetProcessById(pid)) {
            Need(!process.HasExited&&process.SessionId==1,"target_session_or_lifetime_changed");
            Need(process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)==Text(target,"start_ticks"),"target_start_identity_changed");
            string path=process.MainModule.FileName;
            Need(String.Equals(path,Text(target,"executable"),StringComparison.OrdinalIgnoreCase),"target_executable_changed");
            bool wow=String.Equals(path,Retail,StringComparison.OrdinalIgnoreCase)&&String.Equals(process.ProcessName,"Wow",StringComparison.OrdinalIgnoreCase);
            bool launcher=String.Equals(Path.GetFileName(path),"Battle.net.exe",StringComparison.OrdinalIgnoreCase)&&String.Equals(process.ProcessName,"Battle.net",StringComparison.OrdinalIgnoreCase);
            Need(wow||launcher,"unsupported_target_executable");
            if(launcher)Need(Convert.ToBoolean(Field(Signature(path),"allowed")),"launcher_signature_unconfirmed");
            WindowInfo window=Native.GetWindow(Handle(target));Need(window.Pid==pid,"target_window_pid_changed");
            var name=new StringBuilder(256);Need(GetClassName(window.Hwnd,name,name.Capacity)>0&&name.ToString()==Text(target,"class"),"target_window_class_changed");
            Need(window.Width>0&&window.Height>0,"target_client_dimensions_unavailable");return window;
        }
    }
    static Dictionary<string,object> Window(WindowInfo window) {
        return Obj("client_width",window.Width,"client_height",window.Height,"dpi",GetDpiForWindow(window.Hwnd),"focused",window.Focused,"visible",IsWindowVisible(window.Hwnd),"minimized",IsIconic(window.Hwnd),"recovery_safety",Native.GetRecoverySafety(window.Hwnd),"recovery_focus_candidates",Native.GetRecoveryFocusCandidates(window.Hwnd));
    }
    static Dictionary<string,object> Signature(string path) {
        Need(File.Exists(path)&&String.Equals(Path.GetFileName(path),"Battle.net.exe",StringComparison.OrdinalIgnoreCase),"launcher_basename_or_file_invalid");
        string encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(path));
        string script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$s=Get-AuthenticodeSignature -LiteralPath $p;@{status=$s.Status.ToString();publisher=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''}}|ConvertTo-Json -Compress";
        var start=new ProcessStartInfo(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe","-NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
        start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
        using(Process child=Process.Start(start)) {
            Need(child.WaitForExit(5000),"launcher_signature_timeout");string output=child.StandardOutput.ReadToEnd();
            Need(child.ExitCode==0,"launcher_signature_query_failed");var data=Map(Json.DeserializeObject(output));
            string publisher=Text(data,"publisher");string status=Text(data,"status");
            bool allowed=status=="Valid"&&(publisher.IndexOf("Blizzard",StringComparison.OrdinalIgnoreCase)>=0||publisher.IndexOf("NetEase",StringComparison.OrdinalIgnoreCase)>=0||publisher.IndexOf("网之易",StringComparison.Ordinal)>=0);
            return Obj("executable",path,"signature_status",status,"publisher",publisher,"sha256",Hash(path),"allowed",allowed);
        }
    }
    static List<object> LauncherCandidates() {
        var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        paths.Add(@"C:\Program Files (x86)\Battle.net\Battle.net.exe");paths.Add(@"C:\Program Files\Battle.net\Battle.net.exe");
        foreach(RegistryHive hive in new RegistryHive[]{RegistryHive.CurrentUser,RegistryHive.LocalMachine})foreach(RegistryView view in new RegistryView[]{RegistryView.Registry32,RegistryView.Registry64}) {
            try {using(RegistryKey root=RegistryKey.OpenBaseKey(hive,view))using(RegistryKey key=root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Battle.net.exe",false)){if(key!=null){string value=key.GetValue(null) as string;if(value!=null)paths.Add(value.Trim('"'));}}}catch{}
            try {using(RegistryKey root=RegistryKey.OpenBaseKey(hive,view))using(RegistryKey key=root.OpenSubKey(@"SOFTWARE\Blizzard Entertainment\Battle.net",false)){if(key!=null){string value=key.GetValue("InstallPath") as string;if(value!=null)paths.Add(Path.Combine(value,"Battle.net.exe"));}}}catch{}
        }
        var result=new List<object>();foreach(string path in paths){CheckCancel();if(File.Exists(path)){try{result.Add(Signature(path));}catch{result.Add(Obj("executable",path,"allowed",false,"reason","launcher_signature_unconfirmed"));}}}return result;
    }
    static void Discover(Dictionary<string,object> result) {
        var items=new List<object>();var inventory=new List<object>();
        foreach(string name in new string[]{"Wow","Battle.net"})foreach(Process process in Process.GetProcessesByName(name))using(process) {
            try {if(process.SessionId!=1)continue;string path=process.MainModule.FileName;if(name=="Wow"&&!String.Equals(path,Retail,StringComparison.OrdinalIgnoreCase))continue;
                if(name=="Battle.net"){Need(String.Equals(Path.GetFileName(path),"Battle.net.exe",StringComparison.OrdinalIgnoreCase),"launcher_executable_basename_changed");Need(Convert.ToBoolean(Field(Signature(path),"allowed")),"launcher_signature_unconfirmed");}
                // The normal game-only candidate filter deliberately excludes
                // Battle.net. Enumerate only this already verified PID here.
                var windows=RecoveryWindowDiscovery.VisibleForVerifiedPid(process.Id);
                int matching=windows.Count;
                inventory.Add(Obj("kind",name=="Wow"?"wow":"battle_net","pid",process.Id,"start_ticks",process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),"session_id",1,"executable",path,"visible_nonminimized_windows",matching));
                foreach(WindowInfo window in windows)if(window.Pid==process.Id){var target=Target(process,window);Identity(target);items.Add(Obj("kind",name=="Wow"?"wow":"battle_net","target",target,"window",Window(window)));}
            }catch{}
        }
        result["processes"]=items;result["process_inventory"]=inventory;result["launcher_candidates"]=LauncherCandidates();result["status"]="discovered";
    }
    static void Observe(Dictionary<string,object> request,Dictionary<string,object> result) {
        var target=Map(Field(request,"target"));WindowInfo before=Identity(target);Need(IsWindowVisible(before.Hwnd)&&!IsIconic(before.Hwnd),"visible_nonminimized_target_required");
        result["target"]=target;result["window"]=Window(before);double captureStart=Clock.PreciseMs;string path=Path.Combine(Output,"client.png");string method="PrintWindow-client-renderfullcontent";bool okay;
        using(var bitmap=new Bitmap(before.Width,before.Height,PixelFormat.Format32bppArgb)) {
            using(Graphics graphics=Graphics.FromImage(bitmap)){IntPtr dc=graphics.GetHdc();try{result["capture_api_started_windows_qpc_ms"]=Clock.PreciseMs;okay=PrintWindow(before.Hwnd,dc,3);result["capture_api_finished_windows_qpc_ms"]=Clock.PreciseMs;}finally{graphics.ReleaseHdc(dc);}}
            if(!okay){var safety=Native.GetRecoverySafety(before.Hwnd);Need(Convert.ToBoolean(Field(safety,"client_fully_visible")),"capture_failed_client_occluded");var origin=new Native.Point();Need(ClientToScreen(before.Hwnd,ref origin),"client_origin_unavailable");using(Graphics graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(origin.X,origin.Y,0,0,new Size(before.Width,before.Height),CopyPixelOperation.SourceCopy);method="CopyFromScreen-client-visible";}
            if(!okay)result["capture_api_finished_windows_qpc_ms"]=Clock.PreciseMs;
            result["png_write_started_windows_qpc_ms"]=Clock.PreciseMs;
            using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read))bitmap.Save(stream,ImageFormat.Png);
            result["png_write_finished_windows_qpc_ms"]=Clock.PreciseMs;
        }
        double captureEnd=Clock.PreciseMs;result["window_revalidate_started_windows_qpc_ms"]=Clock.PreciseMs;WindowInfo after=Identity(target);Need(before.Width==after.Width&&before.Height==after.Height,"capture_dimensions_changed");
        result["window"]=Window(after);result["window_revalidate_finished_windows_qpc_ms"]=Clock.PreciseMs;result["capture"]=Obj("file","client.png","sha256",Hash(path),"width",after.Width,"height",after.Height,"started_windows_qpc_ms",captureStart,"finished_windows_qpc_ms",captureEnd,"method",method);
        result["observation_id"]="session-observe-"+Guid.NewGuid().ToString("D");double cvStart=Clock.PreciseMs;
        using(var capturedImage=new Bitmap(path)){var selected=RecoveryCalibration.Match(capturedImage,AppDomain.CurrentDomain.BaseDirectory);selected["observation_id"]=result["observation_id"];selected["capture_sha256"]=Hash(path);result["selected_character"]=selected;var tutorial=RecoveryTutorialCv.Match(capturedImage,AppDomain.CurrentDomain.BaseDirectory);tutorial["observation_id"]=result["observation_id"];tutorial["capture_sha256"]=Hash(path);result["tutorial_cv"]=tutorial;}
        result["cv_started_windows_qpc_ms"]=cvStart;result["cv_finished_windows_qpc_ms"]=Clock.PreciseMs;
        double ocrStart=Clock.PreciseMs;result["ocr"]=RecoveryOcr.Read(path);result["ocr_started_windows_qpc_ms"]=ocrStart;result["ocr_finished_windows_qpc_ms"]=Clock.PreciseMs;result["status"]="observed";
    }
    static Dictionary<string,object> Source(Dictionary<string,object> request,WindowInfo window) {
        var source=Map(Field(request,"source"));Exact(source,"observation_id","capture_sha256","width","height","observation_path");string path=Text(source,"observation_path");SafePath(path,true);
        var prior=Map(Json.DeserializeObject(File.ReadAllText(Path.Combine(path,"result.json"),Encoding.UTF8)));
        Need(Text(prior,"status")=="observed"&&Number(prior,"session_id")==1,"source_observation_invalid");Need(Text(prior,"observation_id")==Text(source,"observation_id"),"source_observation_id_changed");
        var priorTarget=Map(Field(prior,"target"));var requestedTarget=Map(Field(request,"target"));foreach(string field in new string[]{"pid","start_ticks","hwnd","class","executable"})Need(Object.Equals(Field(priorTarget,field),Field(requestedTarget,field)),"source_target_identity_changed");
        var capture=Map(Field(prior,"capture"));Need(Text(capture,"file")=="client.png","source_capture_filename_invalid");
        string hash=Text(source,"capture_sha256");Need(Regex.IsMatch(hash,"^[0-9a-f]{64}$")&&Hash(Path.Combine(path,"client.png"))==hash&&Text(capture,"sha256")==hash,"source_capture_hash_changed");
        Need(Number(source,"width")==window.Width&&Number(source,"height")==window.Height&&Number(capture,"width")==window.Width&&Number(capture,"height")==window.Height,"source_dimensions_changed");
        Need(Number(Map(Field(prior,"window")),"dpi")==checked((int)GetDpiForWindow(window.Hwnd)),"source_window_dpi_changed");
        double age=Clock.PreciseMs-Numeric(capture,"finished_windows_qpc_ms");Need(age>=0&&age<=15000,"source_observation_stale");return prior;
    }
    static Dictionary<string,object> JobSafety() {
        using(Process self=Process.GetCurrentProcess()) {
            bool inside;bool success=IsProcessInJob(self.Handle,IntPtr.Zero,out inside);Need(success,"host_job_membership_unknown");
            if(!inside)return Obj("host_in_job",false,"allowed",true,"guardian_boundary","independent-process-heartbeat-ledger","forced_entire_tree_kill_validated",false,"nested_parent_jobs_checked",false);
            JobExtended limits;uint returned;success=QueryInformationJobObject(IntPtr.Zero,9,out limits,(uint)Marshal.SizeOf(typeof(JobExtended)),out returned);
            Need(success,"host_job_limits_unknown");bool dangerous=(limits.Basic.Flags&0x2000)!=0;
            return Obj("host_in_job",true,"limit_flags",limits.Basic.Flags,"kill_on_job_close",dangerous,"allowed",!dangerous,"guardian_boundary","independent-process-heartbeat-ledger","forced_entire_tree_kill_validated",false,"nested_parent_jobs_checked",false);
        }
    }
    static Dictionary<string,object> Command(string session,string id,string op,object action) {var value=Obj("protocol","wow-input","version",1,"type","command","session_id",session,"id",id,"op",op);if(action!=null)value.Add("action",action);return value;}
    static void Input(Dictionary<string,object> request,Dictionary<string,object> envelope,Dictionary<string,object> result) {
        var target=Map(Field(request,"target"));WindowInfo window=Identity(target);var prior=Source(request,window);result["target"]=target;result["window"]=Window(window);result["source_observation_id"]=Text(prior,"observation_id");
        var action=Map(Field(request,"action"));string kind=Text(action,"kind");Need(kind=="key"||kind=="mouse_click"||kind=="focus_click","one_finite_action_required");int duration=Number(action,"duration_ms");Need(duration>=1&&duration<=150,"finite_action_1_to_150ms_required");
        if(kind=="focus_click"&&action.ContainsKey("visibility_mode")) {
            string mode=Text(action,"visibility_mode");Need(mode=="complete_client"||mode=="visible_point","focus_visibility_mode_invalid");
            if(mode=="visible_point") {
                int x=Number(action,"x"),y=Number(action,"y");Need(RecoverySafety.FocusCandidate(x,y,window.Width,window.Height),"focus_background_candidate_required");
                var priorWindow=Map(Field(prior,"window"));var candidates=Field(priorWindow,"recovery_focus_candidates") as object[];Need(candidates!=null,"source_focus_candidates_missing");bool matched=false;
                foreach(object row in candidates) {var candidate=Map(row);var point=Map(Field(candidate,"point"));if(Number(point,"x")!=x||Number(point,"y")!=y)continue;
                    matched=Text(candidate,"mode")=="visible_point"&&Convert.ToBoolean(Field(candidate,"allowed"))&&Text(candidate,"reason")=="safe"&&
                        Convert.ToBoolean(Field(candidate,"point_visible"))&&Convert.ToBoolean(Field(candidate,"point_owned"))&&Convert.ToBoolean(Field(candidate,"on_monitor"))&&
                        Convert.ToBoolean(Field(candidate,"cursor_free"))&&!Convert.ToBoolean(Field(candidate,"mouse_buttons_held"))&&!Convert.ToBoolean(Field(candidate,"owned_click_started"))&&
                        Numeric(candidate,"user_idle_ms")>5000&&Number(candidate,"idle_threshold_ms")==5000&&Number(candidate,"patch_radius")==2&&
                        Number(candidate,"pid")==Number(target,"pid")&&Text(candidate,"process_start_ticks")==Text(target,"start_ticks")&&Text(candidate,"hwnd")==Text(target,"hwnd")&&Text(candidate,"class")==Text(target,"class")&&
                        String.Equals(Text(candidate,"executable"),Text(target,"executable"),StringComparison.OrdinalIgnoreCase)&&Number(candidate,"session_id")==1&&Number(candidate,"probe_session_id")==1&&
                        Number(candidate,"client_width")==window.Width&&Number(candidate,"client_height")==window.Height&&Numeric(candidate,"checked_at_ms")>=Numeric(prior,"started_windows_qpc_ms")&&Numeric(candidate,"checked_at_ms")<=Numeric(prior,"finished_windows_qpc_ms");
                    if(matched)break;
                }
                Need(matched,"source_focus_point_proof_invalid");var current=Native.GetRecoveryPointSafety(window.Hwnd,x,y);Need(Convert.ToBoolean(Field(current,"allowed")),"current_focus_point_not_safe");
            }
        }
        Need(kind=="focus_click"||window.Focused,"target_unfocused");var job=JobSafety();result["guardian_job_safety"]=job;Need(Convert.ToBoolean(Field(job,"allowed")),"guardian_job_kill_on_close_unsafe");
        var hashes=Map(Field(envelope,"payload_hashes"));string root=AppDomain.CurrentDomain.BaseDirectory;string input=Path.Combine(root,"WinInput.exe"),watchdog=Path.Combine(root,"WinInputWatchdog.exe");
        Need(Hash(input)==Text(hashes,"WinInput.exe")&&Hash(watchdog)==Text(hashes,"WinInputWatchdog.exe"),"native_payload_changed");
        string session=Guid.NewGuid().ToString("D");result["native_session_id"]=session;var lines=new List<object>();var receipts=new List<object>();result["native_lines"]=lines;result["receipts"]=receipts;
        var queue=new BlockingCollection<string>();LeaseStore ledger=null;Process executor=null;Thread stdout=null;RecoveryHeartbeatPump pump=null;bool shutdownSent=false;bool sent=false;bool executeDone=false;bool releaseDone=false;bool ledgerEmpty=false;
        string nativeRaw=Path.Combine(Output,"native-input.jsonl");var raw=new StreamWriter(new FileStream(nativeRaw,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));raw.AutoFlush=true;
        var start=new ProcessStartInfo(input,"serve --window "+Text(target,"hwnd")+" --expected-pid "+window.Pid.ToString(CultureInfo.InvariantCulture)+" --session "+session+" --watchdog \""+watchdog+"\"");
        start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
        try {
            result["native_spawn_started_windows_qpc_ms"]=Clock.PreciseMs;executor=Process.Start(start);result["executor_pid"]=executor.Id;
            stdout=new Thread(delegate(){try{string line;while((line=executor.StandardOutput.ReadLine())!=null){if(line.Length<262144){raw.WriteLine(line);queue.Add(line);}}}catch{}finally{queue.CompleteAdding();}});stdout.IsBackground=true;stdout.Start();
            var stderr=new Thread(delegate(){try{while(executor.StandardError.ReadLine()!=null){}}catch{}});stderr.IsBackground=true;stderr.Start();
            double readyDeadline=Clock.PreciseMs+4000;bool ready=false;
            while(Clock.PreciseMs<readyDeadline&&!ready){CheckCancel();string line;if(queue.TryTake(out line,50)){var value=Map(Json.DeserializeObject(line));lines.Add(value);if(Text(value,"type")=="ready"){ready=true;result["native_ready_windows_qpc_ms"]=Clock.PreciseMs;result["watchdog_pid"]=Number(value,"watchdog_pid");}}Need(!executor.HasExited||ready,"native_exited_before_ready");}
            Need(ready,"native_ready_timeout");
            // Start the independent heartbeat immediately after ready, before
            // signature, source-hash or UNC checks that can exceed the lease.
            pump=new RecoveryHeartbeatPump(session,delegate(string line){executor.StandardInput.WriteLine(line);executor.StandardInput.Flush();});
            ledger=new LeaseStore(session,false);LeaseSnapshot live=ledger.Read();Need(live.WatchdogReady&&live.HeldKeysMask==0&&live.HeldMouseMask==0,"guardian_ledger_not_ready");
            WindowInfo fresh=Identity(target);Need(fresh.Width==window.Width&&fresh.Height==window.Height,"input_dimensions_changed");Source(request,fresh);CheckCancel();
            result["gate_validated_windows_qpc_ms"]=Clock.PreciseMs;
            Need(!pump.Failed,"heartbeat_transport_failed");pump.Send("action","execute",action);sent=true;result["input_command_written_windows_qpc_ms"]=Clock.PreciseMs;
            double deadline=Clock.PreciseMs+4500;
            while(Clock.PreciseMs<deadline&&!executeDone){
                if(File.Exists(Cancel)){pump.Send("cancel","cancel",null);result["cancel_requested"]=true;}
                string line;if(queue.TryTake(out line,20)){var value=Map(Json.DeserializeObject(line));lines.Add(value);if(Text(value,"type")=="receipt"){receipts.Add(value);if(Text(value,"id")=="action"&&Text(value,"status")!="accepted"){executeDone=true;result["execute_receipt"]=value;}}}
                if(executor.HasExited)break;
            }
            Need(executeDone,"native_action_completion_unconfirmed");
        } finally {
            if(executor!=null&&!executor.HasExited){
                try{if(pump==null)pump=new RecoveryHeartbeatPump(session,delegate(string line){executor.StandardInput.WriteLine(line);executor.StandardInput.Flush();});pump.Send("release","release_all",null);double deadline=Clock.PreciseMs+1500;
                    while(Clock.PreciseMs<deadline&&!releaseDone){string line;if(queue.TryTake(out line,20)){var value=Map(Json.DeserializeObject(line));lines.Add(value);if(Text(value,"type")=="receipt"){receipts.Add(value);if(Text(value,"id")=="release"){var outcome=Map(Field(value,"input"));releaseDone=Text(value,"status")=="ok"&&Convert.ToBoolean(Field(outcome,"released"));}}}if(executor.HasExited)break;}
                    pump.Send("shutdown","shutdown",null);shutdownSent=true;pump.Dispose();result["heartbeat_commands_written"]=pump.HeartbeatCount;executor.StandardInput.Close();executor.WaitForExit(2500);
                }catch{}
            }
            if(pump!=null){pump.Dispose();result["heartbeat_commands_written"]=pump.HeartbeatCount;}if(stdout!=null)stdout.Join(500);string remaining;while(queue.TryTake(out remaining)){try{var value=Map(Json.DeserializeObject(remaining));lines.Add(value);if(Text(value,"type")=="receipt")receipts.Add(value);}catch{}}
            if(ledger!=null){try{var state=ledger.Read();ledgerEmpty=state.HeldKeysMask==0&&state.HeldMouseMask==0;result["release_ledger"]=Obj("held_keys_mask","0x"+state.HeldKeysMask.ToString("x",CultureInfo.InvariantCulture),"held_mouse_mask",state.HeldMouseMask,"stop_requested",state.StopRequested,"watchdog_pid",state.WatchdogPid,"watchdog_ready",state.WatchdogReady,"checked_windows_qpc_ms",Clock.PreciseMs);}catch{}ledger.Dispose();}
            bool executorExited=executor!=null&&executor.HasExited;result["shutdown_sent"]=shutdownSent;result["release_confirmed"]=releaseDone&&ledgerEmpty&&executorExited;result["input_command_dispatched"]=sent;
            bool inserted=false;foreach(object row in receipts){var receipt=Map(row);if(Text(receipt,"op")=="execute"&&Numeric(Map(Field(receipt,"input")),"events_inserted")>0)inserted=true;}
            result["input_sent"]=inserted;result["effect_status"]="unknown";if(executor!=null){result["executor_exited"]=executorExited;executor.Dispose();}raw.Dispose();result["native_raw_file"]="native-input.jsonl";result["native_raw_sha256"]=Hash(nativeRaw);queue.Dispose();
        }
        Need(Convert.ToBoolean(Field(result,"release_confirmed")),"input_release_unconfirmed");var receiptResult=Map(Field(result,"execute_receipt"));Need(Text(receiptResult,"status")=="completed","native_action_not_completed");result["status"]=File.Exists(Cancel)?"cancelled":"input_released";
    }
    static void Launch(Dictionary<string,object> request,Dictionary<string,object> result) {
        string op=Text(request,"op"),path=null;string arguments="";
        // An invisible/minimized existing client is not a missing installation.
        // Do not issue a second launch command to compensate for unknown UI state.
        foreach(Process game in Process.GetProcessesByName("Wow"))using(game){if(game.SessionId==1&&String.Equals(game.MainModule.FileName,Retail,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("existing_wow_process_requires_observe_not_relaunch");}
        if(op=="launch_wow") {
            var target=Map(Field(request,"target"));WindowInfo window=Identity(target);path=Text(target,"executable");Need(String.Equals(Path.GetFileName(path),"Battle.net.exe",StringComparison.OrdinalIgnoreCase),"launcher_target_required");var prior=Source(request,window);var ocr=Map(Field(prior,"ocr"));Need(Text(ocr,"status")=="available","launcher_state_unknown");
            bool play=false;object[] items=Field(ocr,"items") as object[];Need(items!=null,"launcher_ocr_invalid");
            var wire=Map(Json.DeserializeObject(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"session-recovery-v1.schema.json"),Encoding.UTF8)));var definitions=Map(Field(wire,"definitions"));var blocks=new List<string>();
            foreach(string key in new string[]{"blocked_auth_token","blocked_terms_token","blocked_update_token"})foreach(object token in (object[])Field(Map(Field(definitions,key)),"enum"))blocks.Add((string)token);
            foreach(object row in items){string term=Text(Map(row),"text");if(term=="进入游戏"||term=="开始游戏"||term=="Play")play=true;foreach(string block in blocks)Need(term.IndexOf(block,StringComparison.OrdinalIgnoreCase)<0,"launcher_requires_user:"+block);}
            Need(play,"launcher_ready_play_button_unconfirmed");arguments="--exec=\"launch WoW\"";result["source_observation_id"]=Text(prior,"observation_id");
        } else {
            foreach(Process launcher in Process.GetProcessesByName("Battle.net"))using(launcher){if(launcher.SessionId==1)throw new InvalidOperationException("existing_launcher_process_requires_observe_not_relaunch");}
            var candidates=LauncherCandidates();result["launcher_candidates"]=candidates;var allowed=new List<Dictionary<string,object>>();foreach(object row in candidates){var item=Map(row);if(Convert.ToBoolean(Field(item,"allowed")))allowed.Add(item);}Need(allowed.Count==1,"one_verified_launcher_installation_required");path=Text(allowed[0],"executable");
        }
        CheckCancel();var signature=Signature(path);Need(Convert.ToBoolean(Field(signature,"allowed")),"launcher_signature_unconfirmed");result["launcher_identity"]=signature;
        var start=new ProcessStartInfo(path,arguments);start.UseShellExecute=false;start.CreateNoWindow=true;start.WorkingDirectory=Path.GetDirectoryName(path);
        CheckCancel();result["launch_started_windows_qpc_ms"]=Clock.PreciseMs;using(Process child=Process.Start(start)){result["launched_pid"]=child.Id;result["launch_command_process_pid"]=child.Id;result["launch_finished_windows_qpc_ms"]=Clock.PreciseMs;result["status"]="launched";result["launch_requested"]=true;result["launch_effect"]="unknown";result["wow_process_started_confirmed"]=false;result["world_entered"]=false;}
    }
    [STAThread] static int Main(string[] args) {
        bool owns=false;var result=Obj("schema_version",1,"host","interactive-session-recovery-v1","status","blocked","session_id",Process.GetCurrentProcess().SessionId,"input_sent",false,"release_confirmed",true,"effect_status","unknown","model_calls",0,"utc_started",DateTime.UtcNow.ToString("o"));
        try {
            Need(args.Length==8&&args[0]=="--request"&&args[2]=="--request-sha256"&&args[4]=="--out"&&args[6]=="--cancel","fixed_host_options_required");
            SafePath(args[1],false);SafePath(args[5],true);SafePath(args[7],false);Output=args[5];Cancel=args[7];
            Need(Path.GetDirectoryName(args[1])==Path.GetDirectoryName(Output)&&Path.GetDirectoryName(Cancel)==Path.GetDirectoryName(Output),"owned_request_cancel_siblings_required");
            Need(Regex.IsMatch(Path.GetFileName(args[1]),"^WowJev-SessionRecovery-[0-9a-f]{32}\\.request\\.json$")&&Path.GetFileName(Cancel)==Path.GetFileName(args[1]).Replace(".request.json",".cancel"),"owned_request_cancel_names_required");
            Need(Regex.IsMatch(args[3],"^[0-9a-f]{64}$")&&Hash(args[1])==args[3],"request_hash_changed");
            Need(!Directory.Exists(Output)&&!File.Exists(Output),"new_output_directory_required");Need(CreateDirectory(Output,IntPtr.Zero),"exclusive_output_creation_failed");owns=true;WriteNew(Path.Combine(Output,"owned.json"),Obj("host_pid",Process.GetCurrentProcess().Id,"cancel_file",Cancel));
            Need(Number(result,"session_id")==1,"host_not_interactive_session_1");Started=Clock.PreciseMs;result["started_windows_qpc_ms"]=Started;Native.MakeDpiAware();CheckCancel();
            var envelope=Map(Json.DeserializeObject(File.ReadAllText(args[1],Encoding.UTF8)));Exact(envelope,"request","payload_hashes");var hashes=Map(Field(envelope,"payload_hashes"));
            foreach(string fixedFile in new string[]{"InteractiveSessionHost.exe","WinInput.exe","WinInputWatchdog.exe","selected-alliance-warrior.json","selected-alliance-warrior.png","session-recovery-v1.schema.json"})Need(Hash(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,fixedFile))==Text(hashes,fixedFile),"fixed_payload_manifest_changed");
            foreach(var entry in hashes){Need(Regex.IsMatch(entry.Key,"^[A-Za-z0-9_.-]+\\.(?:exe|json|png)$"),"payload_manifest_name_rejected");Need(Hash(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,entry.Key))==(string)entry.Value,"fixed_payload_manifest_changed");}
            result["protocol_sha256"]=Text(hashes,"session-recovery-v1.schema.json");result["payload_hashes"]=hashes;
            var request=Map(Field(envelope,"request"));Need(Number(request,"version")==1,"unsupported_request_version");string op=Text(request,"op");result["operation"]=op;
            if(op=="discover"){Exact(request,"version","op");Discover(result);}else if(op=="observe"){Exact(request,"version","op","target");Observe(request,result);}else if(op=="input"){Exact(request,"version","op","target","source","action");Input(request,envelope,result);}else if(op=="launch_battlenet"){Exact(request,"version","op");Launch(request,result);}else if(op=="launch_wow"){Exact(request,"version","op","target","source");Launch(request,result);}else throw new InvalidOperationException("unknown_operation");
            result["finished_windows_qpc_ms"]=Clock.PreciseMs;WriteResult(result);return 0;
        } catch(Exception error) {
            result["status"]=error is InvalidOperationException&&error.Message=="cancelled"?"cancelled":"blocked";
            result["reason"]=error is InvalidOperationException?error.Message:"host_operation_failed:"+error.GetType().Name;
            result["finished_windows_qpc_ms"]=Clock.PreciseMs;if(owns)try{WriteResult(result);}catch{}return 2;
        }
    }
}

// PID-local read-only enumeration. The production caller must verify the live
// process session/start/path/signature before calling and revalidate each HWND
// afterwards. This helper grants no input authority and no arbitrary capture.
public static class RecoveryWindowDiscovery
{
    delegate bool Callback(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(Callback callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    public static bool Candidate(int verifiedPid,uint owner,bool visible,bool minimized,int width,int height)
    {return verifiedPid>0&&owner==(uint)verifiedPid&&visible&&!minimized&&width>0&&height>0;}
    public static List<WindowInfo> VisibleForVerifiedPid(int pid)
    {
        if(pid<=0)throw new ArgumentException("verified_pid_required");
        var windows=new List<WindowInfo>();
        bool okay=EnumWindows(delegate(IntPtr hwnd,IntPtr parameter){
            uint owner;uint thread=GetWindowThreadProcessId(hwnd,out owner);
            if(thread==0||owner!=(uint)pid||!IsWindowVisible(hwnd)||IsIconic(hwnd))return true;
            try {WindowInfo info=Native.GetWindow(hwnd);if(Candidate(pid,(uint)info.Pid,true,false,info.Width,info.Height))windows.Add(info);}catch{}
            return true;
        },IntPtr.Zero);
        if(!okay)throw new InvalidOperationException("verified_pid_window_enumeration_failed");
        return windows;
    }
}

// All native stdin writes share one lock. A separate worker keeps the controller
// lease alive through slow process-signature and UNC evidence validation.
public sealed class RecoveryHeartbeatPump : IDisposable
{
    readonly string session;readonly Action<string> write;readonly object gate=new object();readonly ManualResetEvent stop=new ManualResetEvent(false);readonly Thread worker;
    bool disposed;volatile bool failed;int beats;
    public bool Failed {get{return failed;}}
    public int HeartbeatCount {get{return beats;}}
    public RecoveryHeartbeatPump(string id,Action<string> sink)
    {
        session=id;write=sink;Beat();worker=new Thread(delegate(){while(!stop.WaitOne(200)){try{Beat();}catch{failed=true;return;}}});worker.IsBackground=true;worker.Start();
    }
    void Beat(){Send("heartbeat-"+Interlocked.Increment(ref beats).ToString(CultureInfo.InvariantCulture),"heartbeat",null);}
    public void Send(string id,string op,object action)
    {
        lock(gate){if(disposed)throw new ObjectDisposedException("RecoveryHeartbeatPump");var value=new Dictionary<string,object>{{"protocol","wow-input"},{"version",1},{"type","command"},{"session_id",session},{"id",id},{"op",op}};if(action!=null)value.Add("action",action);write(new JavaScriptSerializer().Serialize(value));}
    }
    public void Dispose(){lock(gate){if(disposed)return;disposed=true;stop.Set();}worker.Join(500);stop.Dispose();}
}
