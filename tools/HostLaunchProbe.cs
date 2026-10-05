// Dedicated read-only host launch probe. It never accepts or constructs --run/confirmation flags.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

static class HostLaunchProbe
{
    const uint Breakaway = 0x01000000, Suspended = 0x00000004, NoWindow = 0x08000000;
    const uint QueryLimited = 0x1000, StillActive = 259;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    sealed class Failure : Exception { public readonly string Code; public Failure(string code) { Code = code; } }
    static Dictionary<string, object> Obj(params object[] args) { var row = new Dictionary<string, object>(); for (int i=0;i<args.Length;i+=2) row.Add((string)args[i],args[i+1]); return row; }
    static void Need(bool condition, string reason) { if (!condition) throw new Failure(reason); }
    static string Hash(string path) { using (SHA256 hash=SHA256.Create()) using (var file=File.OpenRead(path)) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant(); }
    static void Save(string path, object value) { using(var file=new StreamWriter(new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false))) file.WriteLine(Json.Serialize(value)); }
    static void Local(string path) { Need(Regex.IsMatch(path,"^[A-Za-z]:\\\\") && Path.IsPathRooted(path),"windows_local_output_required"); }
    static void Copy(string source,string target) { var file=new FileInfo(source); Need(file.Exists && file.Length<=32*1024*1024 && (file.Attributes&FileAttributes.ReparsePoint)==0,"bounded_regular_source_required"); string hash=Hash(source); File.Copy(source,target,false); Need(Hash(target)==hash && new FileInfo(target).Length==file.Length,"copy_hash_mismatch"); }
    static void NoReparse(string path) {
        string current=Path.GetFullPath(path);
        while(!String.IsNullOrEmpty(current)) {
            if(Directory.Exists(current) || File.Exists(current))Need((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"path_reparse_rejected");
            string parent=Path.GetDirectoryName(current);if(parent==current)break;current=parent;
        }
    }
    static void CleanPath(string path) {
        Need(path.Length<=4096 && path.IndexOf('\0')<0,"bounded_path_required");
        foreach(string piece in path.Split('\\','/'))Need(piece!="." && piece!="..","path_traversal_rejected");
    }
    static Dictionary<string,string> Parse(string[] args) {
        var options=new Dictionary<string,string>();for(int i=0;i<args.Length;i+=2){Need(i+1<args.Length && !options.ContainsKey(args[i]),"invalid_options");Need(args[i+1].Length<=4096 && args[i+1].IndexOf('\0')<0,"bounded_argument_required");options.Add(args[i],args[i+1]);}
        foreach(string key in options.Keys)Need(Array.IndexOf(new[]{"--host-source","--host-sha256","--out","--export-dir","--native-root","--repo-wsl","--method"},key)>=0,"unknown_option_readonly_probe_only");
        foreach(string key in new[]{"--host-source","--host-sha256","--out","--export-dir","--native-root"})Need(options.ContainsKey(key),"missing_required_option");
        Need(!options.ContainsKey("--method") || options["--method"]=="breakaway" || options["--method"]=="explorer","unknown_launch_method");
        Need(Regex.IsMatch(options["--host-sha256"],"^[0-9a-f]{64}\\z"),"specific_host_source_hash_mismatch");return options;
    }
    static string Parameters(string output,string export,string nativeRoot,string repo) {
        Need(Regex.IsMatch(repo,"^/[A-Za-z0-9/._-]{1,2048}\\z") && !repo.Contains("/../"),"absolute_repo_wsl_required");
        return "--out "+Quote(output)+" --native-root "+Quote(nativeRoot)+" --export-dir "+Quote(export)+" --repo-wsl "+Quote(repo);
    }
    static int SelfTest() {
        int count=0;string[] good={"--host-source",@"C:\own\WslRestartAcceptance.exe","--host-sha256",new string('a',64),"--out",@"C:\own\new","--export-dir",@"\\wsl.localhost\Ubuntu\own\new","--native-root",@"\\wsl.localhost\Ubuntu\own\native"};Parse(good);count++;
        foreach(string[] bad in new[]{new[]{"--run","true"},new[]{"--confirm-distro-restart","Ubuntu"},new[]{"--out"},new[]{"--out","a","--out","b"}}) {bool rejected=false;try{Parse(bad);}catch(Failure){rejected=true;}Need(rejected,"readonly_option_gate_failed");count++;}
        var wrong=(string[])good.Clone();wrong[3]=new string('g',64);bool invalidHash=false;try{Parse(wrong);}catch(Failure){invalidHash=true;}Need(invalidHash,"invalid_sha_not_rejected");count++;
        foreach(string path in new[]{@"C:\own\..\other",@"\\wsl.localhost\Ubuntu\own\.."}) {bool rejected=false;try{CleanPath(path);}catch(Failure){rejected=true;}Need(rejected,"path_traversal_not_rejected");count++;}
        Need(Quote("a b")=="\"a b\"" && Quote("x")=="x" && Quote("a\"b")=="\"a\\\"b\"" && Quote("a b\\")=="\"a b\\\\\"","win32_argument_quote_mismatch");count++;
        string parameters=Parameters(@"C:\own\folder --run",@"\\wsl.localhost\Ubuntu\own\new",@"\\wsl.localhost\Ubuntu\own\native","/home/dai/Projects/wow-jev");Need(!parameters.Contains("--confirm-distro-restart") && parameters.StartsWith("--out \""),"constructed_run_flag_forbidden");count++;
        Console.WriteLine(Json.Serialize(Obj("type","self_test","passed",count,"restart_executed",false,"fixture_opened",false,"input_events",0)));return 0;
    }
    static string Quote(string value) {
        if(value.Length==0)return "\"\""; if(!Regex.IsMatch(value,"[\\s\"]"))return value; var output=new StringBuilder("\"");int slash=0;
        foreach(char c in value){if(c=='\\'){slash++;continue;}if(c=='"'){output.Append('\\',slash*2+1);output.Append(c);}else{output.Append('\\',slash);output.Append(c);}slash=0;}
        return output.Append('\\',slash*2).Append('"').ToString();
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int Size; public string Reserved,Desktop,Title; public uint X,Y,Width,Height,Cols,Rows,Fill,Flags; public ushort Show,ReservedBytes; public IntPtr ReservedData,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low,High; public long Value {get{return ((long)High<<32)|Low;}} }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref Startup start,out ProcessInfo child);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint size,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    static string ActualFilePath(string file) {
        using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)) {
            var path=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(stream.SafeFileHandle.DangerousGetHandle(),path,32768,0);
            Need(size>0 && size<32768,"actual_owned_file_path_unavailable");string result=path.ToString();
            Need(result.StartsWith(@"\\?\",StringComparison.Ordinal),"actual_owned_file_path_not_local");
            result=result.Substring(4);Local(result);return result;
        }
    }
    static Dictionary<string,object> Identity(IntPtr handle,uint pid) {
        bool inside;bool known=IsProcessInJob(handle,IntPtr.Zero,out inside);int error=known?0:Marshal.GetLastWin32Error();FileTime c,e,k,u;bool times=GetProcessTimes(handle,out c,out e,out k,out u);
        var name=new StringBuilder(32768);uint capacity=32768;bool image=QueryFullProcessImageName(handle,0,name,ref capacity);
        return Obj("pid",pid,"job_known",known,"in_job",known?(object)inside:null,"job_win32_error",error,"creation_filetime",times?(object)c.Value.ToString():null,"image_path",image?name.ToString():null);
    }
    static Dictionary<string,object> BreakawayProbe(string executable,string arguments,string workingDirectory) {
        var startup=new Startup {Size=Marshal.SizeOf(typeof(Startup))};ProcessInfo child;
        bool created=CreateProcessW(executable,new StringBuilder(Quote(executable)+" "+arguments),IntPtr.Zero,IntPtr.Zero,false,Breakaway|Suspended|NoWindow,IntPtr.Zero,workingDirectory,ref startup,out child);
        int error=created?0:Marshal.GetLastWin32Error();var record=Obj("method","CreateProcessW","flags",Breakaway|Suspended|NoWindow,"created",created,"win32_error",error,"restart_executed",false,"fixture_opened",false,"input_events",0);
        if(!created)return record;
        try {
            record["child_before_resume"]=Identity(child.Process,child.Pid);
            uint resumed=ResumeThread(child.Thread);record["resume_result"]=resumed;record["resume_win32_error"]=resumed==UInt32.MaxValue?Marshal.GetLastWin32Error():0;
            if(resumed==UInt32.MaxValue){TerminateProcess(child.Process,2);return record;}
            uint waited=WaitForSingleObject(child.Process,25000);record["wait_result"]=waited;
            if(waited!=0){record["owned_probe_timeout"]=true;TerminateProcess(child.Process,124);WaitForSingleObject(child.Process,1000);}
            uint code;record["exit_code"]=GetExitCodeProcess(child.Process,out code)?(object)code:null;record["child_after"]=Identity(child.Process,child.Pid);
            return record;
        } finally {CloseHandle(child.Thread);CloseHandle(child.Process);}
    }
    [ComImport,Guid("6D5140C1-7436-11CE-8034-00AA006009FA"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ServiceProvider { [PreserveSig]int QueryService(ref Guid service,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out object result); }
    [ComImport,Guid("000214E2-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ShellBrowser {
        [PreserveSig]int GetWindow(out IntPtr hwnd);[PreserveSig]int ContextSensitiveHelp(bool enter);
        [PreserveSig]int InsertMenusSB(IntPtr menu,IntPtr widths);[PreserveSig]int SetMenuSB(IntPtr menu,IntPtr oleMenu,IntPtr window);[PreserveSig]int RemoveMenusSB(IntPtr menu);
        [PreserveSig]int SetStatusTextSB([MarshalAs(UnmanagedType.LPWStr)]string text);[PreserveSig]int EnableModelessSB(bool enable);[PreserveSig]int TranslateAcceleratorSB(IntPtr msg,ushort id);
        [PreserveSig]int BrowseObject(IntPtr pidl,uint flags);[PreserveSig]int GetViewStateStream(uint mode,out IntPtr stream);[PreserveSig]int GetControlWindow(uint id,out IntPtr window);[PreserveSig]int SendControlMsg(uint id,uint msg,IntPtr w,IntPtr l,out IntPtr result);
        [PreserveSig]int QueryActiveShellView(out ShellView view);
    }
    [ComImport,Guid("000214E3-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ShellView {
        [PreserveSig]int GetWindow(out IntPtr hwnd);[PreserveSig]int ContextSensitiveHelp(bool enter);[PreserveSig]int TranslateAccelerator(IntPtr msg);[PreserveSig]int EnableModeless(bool enable);[PreserveSig]int UIActivate(uint state);[PreserveSig]int Refresh();
        [PreserveSig]int CreateViewWindow(IntPtr previous,IntPtr settings,IntPtr browser,out IntPtr window);[PreserveSig]int DestroyViewWindow();[PreserveSig]int GetCurrentInfo(IntPtr settings);[PreserveSig]int AddPropertySheetPages(uint reserved,IntPtr callback,IntPtr parameter);
        [PreserveSig]int SaveViewState();[PreserveSig]int SelectItem(IntPtr item,uint flags);[PreserveSig]int GetItemObject(uint kind,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out object result);
    }
    static Dictionary<string,object> ExplorerProbe(string executable,string arguments,string workingDirectory,string childOutput) {
        uint pid=0;Need(GetShellWindow()!=IntPtr.Zero && GetWindowThreadProcessId(GetShellWindow(),out pid)!=0,"desktop_shell_unavailable");
        IntPtr handle=OpenProcess(QueryLimited,false,pid);Need(handle!=IntPtr.Zero,"broker_process_query_denied");var record=Obj("method","Explorer_shell_broker","restart_executed",false,"fixture_opened",false,"input_events",0);
        try {record["broker_before"]=Identity(handle,pid);using(var process=Process.GetProcessById((int)pid))Need(process.ProcessName.Equals("explorer",StringComparison.OrdinalIgnoreCase),"broker_not_existing_explorer");}
        finally{CloseHandle(handle);}
        object windows=null,dispatch=null,browserObject=null,background=null,application=null;
        try {
            windows=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));object location=0,root=0;int desktop;
            dispatch=((dynamic)windows).FindWindowSW(ref location,ref root,8,out desktop,1);
            Need(dispatch!=null,"desktop_automation_unavailable");var provider=(ServiceProvider)dispatch;Guid service=new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837"),browserIid=new Guid("000214E2-0000-0000-C000-000000000046");
            Marshal.ThrowExceptionForHR(provider.QueryService(ref service,ref browserIid,out browserObject));var browser=(ShellBrowser)browserObject;IntPtr browserWindow;Marshal.ThrowExceptionForHR(browser.GetWindow(out browserWindow));uint browserPid;Need(GetWindowThreadProcessId(browserWindow,out browserPid)!=0 && browserPid==pid,"automation_not_in_checked_desktop_broker");
            ShellView view;Marshal.ThrowExceptionForHR(browser.QueryActiveShellView(out view));Guid dispatchIid=new Guid("00020400-0000-0000-C000-000000000046");Marshal.ThrowExceptionForHR(view.GetItemObject(0,ref dispatchIid,out background));
            application=((dynamic)background).Application;((dynamic)application).ShellExecute(executable,arguments,workingDirectory,"open",0);record["shell_execute_called"]=true;
            long deadline=Stopwatch.GetTimestamp()+Stopwatch.Frequency*25;while(!File.Exists(childOutput) && Stopwatch.GetTimestamp()<deadline)Thread.Sleep(50);
            if(File.Exists(childOutput))record["child_preflight_observed"]=true;else record["child_preflight_observed"]=false;
        } catch(Exception error){record["error_type"]=error.GetType().Name;record["hresult"]=Marshal.GetHRForException(error);}
        finally {foreach(object item in new[]{application,background,browserObject,dispatch,windows})if(item!=null && Marshal.IsComObject(item))Marshal.ReleaseComObject(item);}
        return record;
    }
    static Dictionary<string,object> ReadPreflight(string path,string expected) {
        long deadline=Stopwatch.GetTimestamp()+Stopwatch.Frequency*5;
        while(Stopwatch.GetTimestamp()<deadline) {
            try {
                var file=new FileInfo(path);Need(file.Exists && file.Length>=2 && file.Length<=4*1024*1024 && (file.Attributes&FileAttributes.ReparsePoint)==0,"bounded_preflight_required");
                var value=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));
                Need((string)value["tool_sha256"]==expected && (string)value["type"]=="wsl_restart_preflight" && !(bool)value["restart_executed"] && Convert.ToInt32(value["input_events"])==0 && !(bool)value["recorder_opened"],"readonly_child_preflight_binding_mismatch");
                string before=Hash(path);Thread.Sleep(25);Need(before==Hash(path),"child_preflight_not_finished");return value;
            } catch(Failure error) { if(error.Code=="readonly_child_preflight_binding_mismatch")throw; }
            catch(IOException) {} catch(ArgumentException) {} catch(InvalidOperationException) {} catch(KeyNotFoundException) {}
            Thread.Sleep(25);
        }
        throw new Failure("complete_child_preflight_unavailable");
    }
    static void FailureRecord(string primary,string export,string code,int hresult) {
        if(primary==null || !Directory.Exists(primary))return;
        try {
            string path=Path.Combine(primary,"launch-probe.failure.json");
            Save(path,Obj("scope","readonly_host_launch_probe","code",code,"hresult",hresult,"host_detachment_proved",false,"restart_executed",false,"fixture_opened",false,"input_events",0,"primary",primary,"export",export));
            if(export!=null && Directory.Exists(export))Copy(path,Path.Combine(export,"launch-probe.failure.json"));
        }catch{}
    }
    [STAThread]static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);string primary=null,export=null;bool ownsPrimary=false;
        try {
            if(args.Length==1 && args[0]=="--self-test")return SelfTest();
            var options=Parse(args);
            string source=options["--host-source"],expected=options["--host-sha256"];primary=options["--out"];export=options["--export-dir"];
            CleanPath(primary);CleanPath(export);CleanPath(source);Local(primary);NoReparse(Path.GetDirectoryName(primary));NoReparse(Path.GetDirectoryName(export));Need(!Directory.Exists(primary) && !File.Exists(primary),"primary_directory_must_be_new");Need(Regex.IsMatch(export,"^\\\\\\\\(?:wsl\\.localhost|wsl\\$)\\\\Ubuntu\\\\",RegexOptions.IgnoreCase) && !export.Contains("\\..\\") && !Directory.Exists(export) && !File.Exists(export),"new_explicit_ubuntu_export_required");
            Need(Path.GetFileName(source).Equals("WslRestartAcceptance.exe",StringComparison.OrdinalIgnoreCase) && Regex.IsMatch(expected,"^[0-9a-f]{64}\\z") && Hash(source)==expected,"specific_host_source_hash_mismatch");
            string method=options.ContainsKey("--method")?options["--method"]:"breakaway";Need(method=="breakaway" || method=="explorer","unknown_launch_method");
            Directory.CreateDirectory(primary);ownsPrimary=true;Directory.CreateDirectory(export);string package=Path.Combine(primary,"host");Directory.CreateDirectory(package);
            foreach(string name in new[]{"WslRestartAcceptance.exe","wsl_restart_controller.ts","InputLeaseTestGate.exe"})Copy(Path.Combine(Path.GetDirectoryName(source),name),Path.Combine(package,name));
            string requestedExe=Path.Combine(package,"WslRestartAcceptance.exe"),executable=ActualFilePath(requestedExe);
            Need(Hash(executable)==expected,"actual_local_host_hash_mismatch");
            string actualPrimary=Path.GetDirectoryName(Path.GetDirectoryName(executable));
            string hostOutput=Path.Combine(actualPrimary,"host-preflight"),hostExport=Path.Combine(export,"host-preflight");
            string parameters=Parameters(hostOutput,hostExport,options["--native-root"],options.ContainsKey("--repo-wsl")?options["--repo-wsl"]:"/home/dai/Projects/wow-jev");
            var record=Obj("schema_version",1,"scope","readonly_host_launch_probe","method",method,"source_sha256",expected,"requested_primary",primary,"actual_primary",actualPrimary,"primary_domain","windows_local","export_domain","wsl_unc","requested_host_exe",requestedExe,"local_host_exe",executable,"local_host_sha256",Hash(executable),"parent",Identity(Process.GetCurrentProcess().Handle,(uint)Process.GetCurrentProcess().Id),"host_primary",hostOutput,"host_export",hostExport,"launch_probe_exe_sha256",Hash(Process.GetCurrentProcess().MainModule.FileName),"restart_executed",false,"fixture_opened",false,"input_events",0);
            Save(Path.Combine(primary,"prepared-manifest.json"),record);
            record["launch"]=method=="breakaway"?BreakawayProbe(executable,parameters,Path.GetDirectoryName(executable)):ExplorerProbe(executable,parameters,Path.GetDirectoryName(executable),Path.Combine(hostOutput,"preflight.json"));
            string proof=Path.Combine(hostOutput,"preflight.json");if(File.Exists(proof)) {
                var preflight=ReadPreflight(proof,expected);record["host_job"]=preflight["host_job"];if(preflight.ContainsKey("host_job_at_entry"))record["host_job_at_entry"]=preflight["host_job_at_entry"];record["host_preflight_sha256"]=Hash(proof);
                var after=(Dictionary<string,object>)preflight["host_job"];var entry=preflight.ContainsKey("host_job_at_entry")?(Dictionary<string,object>)preflight["host_job_at_entry"]:null;
                record["host_detachment_proved"]=entry!=null && (bool)entry["known"] && !(bool)entry["in_job"] && (bool)after["known"] && !(bool)after["in_job"] && Convert.ToInt32(entry["pid"])==Convert.ToInt32(after["pid"]) && (string)entry["start_ticks"]==(string)after["start_ticks"];
            }else record["host_detachment_proved"]=false;
            string result=Path.Combine(primary,"launch-probe.json");Save(result,record);Copy(result,Path.Combine(export,"launch-probe.json"));
            Console.WriteLine(Json.Serialize(Obj("type","readonly_launch_probe_finished","primary",primary,"export",export,"host_detachment_proved",record["host_detachment_proved"],"restart_executed",false,"input_events",0)));return 0;
        }catch(Failure error){if(ownsPrimary)FailureRecord(primary,export,error.Code,Marshal.GetHRForException(error));Console.WriteLine(Json.Serialize(Obj("type","error","code",error.Code,"restart_executed",false,"input_events",0)));return 2;}
        catch(Exception error){if(ownsPrimary)FailureRecord(primary,export,error.GetType().Name,Marshal.GetHRForException(error));Console.WriteLine(Json.Serialize(Obj("type","error","code",error.GetType().Name,"hresult",Marshal.GetHRForException(error),"restart_executed",false,"input_events",0)));return 2;}
    }
}
