// The session-0 relay never captures or sends input. Its only port is fixed JSONL.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

static class ResidentRelay
{
    static int Main(string[] args){
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        try{
            ResidentWire.Need(args.Length==5&&args[0]=="serve"&&args[1]=="--config"&&args[3]=="--config-sha256","relay_fixed_options");
            ResidentWire.Need(ResidentWire.HashFile(args[2])==args[4],"relay_config_changed");
            var config=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(args[2])));string root=AppDomain.CurrentDomain.BaseDirectory;
            var schema=new ResidentSchema(Path.Combine(root,"resident-session-v1.schema.json"),Path.Combine(root,"native-input-v1.schema.json"));schema.Definition(config,"launch_config");
            var access=ResidentSelfAccess.GrantLimitedQuery();access["relay_token"]=ResidentPipe.OwnTokenSummary();ResidentWire.WriteNew(Path.Combine(ResidentWire.Text(config,"output"),"relay-access.json"),access);
            var ready=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(Path.Combine(ResidentWire.Text(config,"output"),"host-ready.json"))));
            using(var pipe=new NamedPipeClientStream(".",ResidentWire.Text(config,"pipe_name"),PipeDirection.InOut,PipeOptions.Asynchronous,System.Security.Principal.TokenImpersonationLevel.Identification)){
                pipe.Connect(5000);int pid=ResidentPipe.ServerPid(pipe);ResidentWire.Need(pid==ResidentWire.Int(ready,"host_pid"),"relay_server_pid_changed");
                var hashes=ResidentWire.Map(config["payload_hashes"]);ResidentWire.Need(ResidentPipe.ServerSession(pipe)==1,"relay_server_not_session1");ResidentPipe.VerifyProcess(pid,Path.Combine(root,"ResidentSessionHost.exe"),ResidentWire.Text(hashes,"ResidentSessionHost.exe"));
                ResidentWire.Need(ResidentPipe.StartTicks(pid)==Int64.Parse(ResidentWire.Text(ready,"host_start_ticks")),"relay_server_start_changed");
                using(var input=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true))using(var output=new StreamWriter(pipe,new UTF8Encoding(false),4096,true)){
                    output.AutoFlush=true;output.WriteLine(ResidentWire.Encode(ResidentWire.Obj("nonce",ResidentWire.Text(config,"nonce"),"session_id",ResidentWire.Text(config,"session_id"),"relay_pid",Process.GetCurrentProcess().Id,"relay_start_ticks",ResidentPipe.StartTicks(Process.GetCurrentProcess().Id).ToString())));
                    bool failed=false;var stdin=new Thread(delegate(){try{string line;while((line=ResidentWire.ReadBounded(Console.In,65536))!=null){var message=ResidentWire.Decode(line);schema.Definition(message,"command");output.WriteLine(ResidentWire.Encode(message));}}catch{failed=true;}finally{try{pipe.Dispose();}catch{}}});stdin.IsBackground=true;stdin.Start();
                    string reply;while((reply=ResidentWire.ReadBounded(input,262144))!=null){Console.WriteLine(reply);Console.Out.Flush();var message=ResidentWire.Map(ResidentWire.Decode(reply));if(ResidentWire.Text(message,"type")=="stopped")break;}
                    return failed?2:0;
                }
            }
        }catch(Exception error){Console.Error.WriteLine(error is InvalidOperationException?error.Message:"resident_relay_failed:"+error.GetType().Name);return 2;}
    }
}
