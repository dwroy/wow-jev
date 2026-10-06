using System;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

static class ResidentPipe
{
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Size;public IntPtr Descriptor;public int Inherit;}
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint pipeMode,uint maximum,uint outBytes,uint inBytes,uint timeout,ref SecurityAttributes attributes);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe,out uint session);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe,out uint session);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,System.Text.StringBuilder name,ref uint count);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int returned);
    public static NamedPipeServerStream Create(string name){
        ResidentWire.Need(System.Text.RegularExpressions.Regex.IsMatch(name,"^WowJevResident-[0-9a-f]{32}$"),"pipe_name_invalid");
        string sid=WindowsIdentity.GetCurrent().User.Value;IntPtr descriptor;uint size;
        ResidentWire.Need(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+sid+")",1,out descriptor,out size),"pipe_security_failed");
        try{
            var attributes=new SecurityAttributes{Size=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor};
            // First instance, overlapped, local clients only. No network socket.
            SafePipeHandle handle=CreateNamedPipe("\\\\.\\pipe\\"+name,3|0x00080000|0x40000000,0x8,1,65536,65536,0,ref attributes);
            ResidentWire.Need(!handle.IsInvalid,"pipe_creation_failed");return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
        }finally{LocalFree(descriptor);}
    }
    public static int ClientPid(NamedPipeServerStream pipe){uint pid;ResidentWire.Need(GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)&&pid>0,"pipe_client_identity_unknown");return checked((int)pid);}
    public static int ServerPid(NamedPipeClientStream pipe){uint pid;ResidentWire.Need(GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid)&&pid>0,"pipe_server_identity_unknown");return checked((int)pid);}
    public static int ClientSession(NamedPipeServerStream pipe){uint session;if(!GetNamedPipeClientSessionId(pipe.SafePipeHandle,out session))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"pipe_client_session_query_failed");return checked((int)session);}
    public static int ServerSession(NamedPipeClientStream pipe){uint session;if(!GetNamedPipeServerSessionId(pipe.SafePipeHandle,out session))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"pipe_server_session_query_failed");return checked((int)session);}
    public static System.Collections.Generic.Dictionary<string,object> OwnTokenSummary(){
        using(var identity=WindowsIdentity.GetCurrent()){
            object elevation=null,integrity=null,session=null;int returned;IntPtr buffer=Marshal.AllocHGlobal(1024);try{
                if(GetTokenInformation(identity.Token,18,buffer,4,out returned))elevation=Marshal.ReadInt32(buffer);
                if(GetTokenInformation(identity.Token,12,buffer,4,out returned))session=Marshal.ReadInt32(buffer);
                if(GetTokenInformation(identity.Token,25,buffer,1024,out returned)){var label=new SecurityIdentifier(Marshal.ReadIntPtr(buffer));var binary=new byte[label.BinaryLength];label.GetBinaryForm(binary,0);int n=binary[1];if(n>0)integrity=BitConverter.ToUInt32(binary,8+(n-1)*4);}
            }finally{Marshal.FreeHGlobal(buffer);}
            // Identification impersonation permits querying this token. Do not
            // ask Process.SessionId here: that .NET wrapper opens a process and
            // can fail under the identification token despite a live peer.
            return ResidentWire.Obj("user_sid_sha256",ResidentWire.Hash(System.Text.Encoding.UTF8.GetBytes(identity.User.Value)),"windows_session_id",session,"session_identity_api","GetTokenInformation.TokenSessionId","token_elevation_type",elevation,"integrity_rid",integrity,"impersonation_level",identity.ImpersonationLevel.ToString());
        }
    }
    public static System.Collections.Generic.Dictionary<string,object> VerifyCurrentSid(NamedPipeServerStream pipe){
        string own;using(var identity=WindowsIdentity.GetCurrent())own=identity.User.Value;string client=null;System.Collections.Generic.Dictionary<string,object> peer=null;
        pipe.RunAsClient(delegate{using(var identity=WindowsIdentity.GetCurrent())client=identity.User.Value;peer=OwnTokenSummary();});
        var result=ResidentWire.Obj("host_token",OwnTokenSummary(),"client_effective_token",peer,"same_user_sid",client==own);
        ResidentWire.Need(client==own,"pipe_peer_user_sid_changed");return result;
    }
    public static long StartTicks(int pid){
        IntPtr handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"limited_process_open_failed");
        try{long created,exited,kernel,user;if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"limited_process_times_failed");return DateTime.FromFileTimeUtc(created).Ticks;}finally{CloseHandle(handle);}
    }
    static string NormalPath(string path){if(path.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))return "\\\\"+path.Substring(8);if(path.StartsWith("\\\\?\\"))return path.Substring(4);return path;}
    public static void VerifyProcess(int pid,string executable,string hash){
        IntPtr handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"pipe_peer_limited_open_failed");
        try{uint count=32768;var name=new System.Text.StringBuilder((int)count);if(!QueryFullProcessImageName(handle,0,name,ref count))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(),"pipe_peer_image_query_failed");
            ResidentWire.Need(String.Equals(NormalPath(name.ToString()),NormalPath(executable),StringComparison.OrdinalIgnoreCase)&&ResidentWire.HashFile(name.ToString())==hash,"pipe_peer_identity_changed");
        }finally{CloseHandle(handle);}
    }
}
