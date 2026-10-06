using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using WowJev.Input;

sealed class ResidentNativeHand : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long PerProcess,PerJob;public uint Flags;public UIntPtr Minimum,Maximum;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inJob);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr job,int information,out ExtendedLimits limits,uint length,out uint returned);
    Process process;readonly BlockingCollection<Dictionary<string,object>> responses=new BlockingCollection<Dictionary<string,object>>(4096);
    readonly object sendLock=new object();string session;Func<bool> controllerAlive;Thread reader,pump;StreamWriter raw;
    LeaseStore ledger;volatile bool closing;int counter;
    public Dictionary<string,object> Ready;
    public Dictionary<string,object> ReleaseReceipt;public bool? LedgerEmpty,NativeExited;public bool ReleaseConfirmed;
    public static void CheckJob(){using(var self=Process.GetCurrentProcess()){bool inside;ResidentWire.Need(IsProcessInJob(self.Handle,IntPtr.Zero,out inside),"host_job_membership_unknown");if(inside){ExtendedLimits limits;uint returned;ResidentWire.Need(QueryInformationJobObject(IntPtr.Zero,9,out limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),out returned),"host_job_limits_unknown");ResidentWire.Need((limits.Basic.Flags&0x2000)==0,"host_job_kill_on_close_unsafe");}}}
    public void Start(Dictionary<string,object> target,string session,string root,string localOutput,Func<bool> controllerAlive){
        this.session=session;this.controllerAlive=controllerAlive;CheckJob();
        var start=new ProcessStartInfo(Path.Combine(root,"WinInput.exe"),"serve --window "+ResidentWire.Text(target,"hwnd")+" --expected-pid "+ResidentWire.Int(target,"pid")+" --session "+session+" --watchdog \""+Path.Combine(root,"WinInputWatchdog.exe")+"\"");
        start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
        raw=new StreamWriter(new FileStream(Path.Combine(localOutput,"native-input.jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
        process=Process.Start(start);
        reader=new Thread(delegate(){try{string line;while((line=ResidentWire.ReadBounded(process.StandardOutput,262144))!=null){raw.WriteLine(line);var value=ResidentWire.Map(ResidentWire.Decode(line));if(!responses.TryAdd(value))break;}}catch{}finally{responses.CompleteAdding();try{raw.Flush();}catch{}}});reader.IsBackground=true;reader.Start();
        var errors=new Thread(delegate(){try{string line;using(var w=new StreamWriter(Path.Combine(localOutput,"native-stderr.log"),false,new UTF8Encoding(false))){while((line=ResidentWire.ReadBounded(process.StandardError,16384))!=null)w.WriteLine(line);}}catch{}});errors.IsBackground=true;errors.Start();
        double deadline=Clock.PreciseMs+4000;while(Clock.PreciseMs<deadline){Dictionary<string,object> message;if(responses.TryTake(out message,20)){string type=ResidentWire.Text(message,"type");if(type=="ready"){Ready=message;break;}if(type=="error")throw new InvalidOperationException("native_ready_failed");}ResidentWire.Need(!process.HasExited,"native_exited_before_ready");}
        ResidentWire.Need(Ready!=null,"native_ready_timeout");ledger=new LeaseStore(session,false);var initial=ledger.Read();ResidentWire.Need(initial.WatchdogReady&&initial.HeldKeysMask==0&&initial.HeldMouseMask==0,"native_guardian_not_ready");
        pump=new Thread(delegate(){try{while(!closing){if(!controllerAlive())break;Send("heartbeat",null,"hb-"+Interlocked.Increment(ref counter));Thread.Sleep(400);}}catch{}});pump.IsBackground=true;pump.Start();
    }
    void Send(string op,object action,string id){lock(sendLock){var command=ResidentWire.Obj("protocol","wow-input","version",1,"type","command","session_id",session,"id",id,"op",op);if(action!=null)command.Add("action",action);process.StandardInput.WriteLine(ResidentWire.Encode(command));process.StandardInput.Flush();}}
    public void RequestCancel(){try{Send("cancel",null,"abort-"+Interlocked.Increment(ref counter));}catch{}}
    public Dictionary<string,object> Invoke(string op,object action,string id,int timeoutMs,Func<bool> stop){
        Send(op,action,id);double deadline=Clock.PreciseMs+timeoutMs;bool cancelled=false;
        while(Clock.PreciseMs<deadline){if(stop()&&!cancelled){RequestCancel();cancelled=true;}Dictionary<string,object> reply;
            if(responses.TryTake(out reply,10)&&ResidentWire.Text(reply,"type")=="receipt"&&ResidentWire.Text(reply,"id")==id&&ResidentWire.Text(reply,"status")!="accepted"){
                ResidentWire.Need(ResidentWire.Text(reply,"session_id")==session&&ResidentWire.Text(reply,"op")==op,"native_receipt_identity_changed");return reply;
            }
            ResidentWire.Need(!process.HasExited,"native_executor_disconnected");
        }
        throw new InvalidOperationException("native_receipt_timeout");
    }
    public void Close(){
        if(closing)return;closing=true;if(process==null){NativeExited=true;return;}
        try{RequestCancel();ReleaseReceipt=Invoke("release_all",null,"final-release-"+Interlocked.Increment(ref counter),1500,()=>false);}catch{}
        try{Send("shutdown",null,"final-shutdown-"+Interlocked.Increment(ref counter));process.StandardInput.Close();process.WaitForExit(2500);}catch{}
        try{var state=ledger.Read();LedgerEmpty=state.HeldKeysMask==0&&state.HeldMouseMask==0;}catch{}
        try{NativeExited=process.HasExited;}catch{}
        ReleaseConfirmed=ReleaseReceipt!=null&&ResidentWire.Text(ReleaseReceipt,"session_id")==session&&ResidentWire.Text(ReleaseReceipt,"op")=="release_all"&&ResidentWire.Text(ReleaseReceipt,"id").StartsWith("final-release-")&&ResidentWire.Text(ReleaseReceipt,"status")=="ok"&&ResidentWire.Bool(ResidentWire.Map(ReleaseReceipt["input"]),"released")&&LedgerEmpty==true&&NativeExited==true;
    }
    public void Dispose(){Close();if(pump!=null)pump.Join(500);if(reader!=null)reader.Join(500);if(ledger!=null)ledger.Dispose();try{if(raw!=null)raw.Dispose();}catch{}if(process!=null)process.Dispose();responses.Dispose();}
}
