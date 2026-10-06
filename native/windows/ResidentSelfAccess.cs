// Relay-only process DACL adjustment. Never accepts a PID or alters other objects.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class ResidentSelfAccess
{
    [StructLayout(LayoutKind.Sequential)]struct Trustee{public IntPtr Multiple;public uint Operation,Form,Type;public IntPtr Sid;}
    [StructLayout(LayoutKind.Sequential)]struct ExplicitAccess{public uint Permissions,Mode,Inheritance;public Trustee Trustee;}
    [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")]static extern uint GetSecurityInfo(IntPtr handle,int objectType,uint securityInfo,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]static extern uint SetEntriesInAcl(uint count,ref ExplicitAccess entry,IntPtr oldAcl,out IntPtr newAcl);
    [DllImport("advapi32.dll")]static extern uint SetSecurityInfo(IntPtr handle,int objectType,uint securityInfo,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    static RawAcl ReadAcl(IntPtr pointer){ResidentWire.Need(pointer!=IntPtr.Zero,"relay_null_dacl_not_modified");int size=(ushort)Marshal.ReadInt16(pointer,2);ResidentWire.Need(size>=8&&size<=65535,"relay_dacl_size_unknown");var bytes=new byte[size];Marshal.Copy(pointer,bytes,0,size);return new RawAcl(bytes,0);}
    static string AceHash(GenericAce ace){var bytes=new byte[ace.BinaryLength];ace.GetBinaryForm(bytes,0);return ResidentWire.Hash(bytes);}
    static uint Allows(RawAcl acl,SecurityIdentifier sid){uint mask=0;foreach(GenericAce ace in acl){var common=ace as CommonAce;if(common!=null&&common.AceQualifier==AceQualifier.AccessAllowed&&common.SecurityIdentifier.Equals(sid))mask|=unchecked((uint)common.AccessMask);}return mask;}
    public static bool AllowedMask(uint added){return(added&~0x1000u)==0;}
    public static Dictionary<string,object> GrantLimitedQuery(){
        using(var self=Process.GetCurrentProcess())ResidentWire.Need(String.Equals(self.ProcessName,"ResidentRelay",StringComparison.OrdinalIgnoreCase),"self_access_relay_only");
        IntPtr handle=GetCurrentProcess(),owner,group,old,sacl,descriptor,newAcl=IntPtr.Zero,sidMemory=IntPtr.Zero;
        uint error=GetSecurityInfo(handle,6,4,out owner,out group,out old,out sacl,out descriptor);if(error!=0)throw new System.ComponentModel.Win32Exception((int)error,"relay_self_dacl_read_failed");
        try{
            RawAcl before=ReadAcl(old);SecurityIdentifier sid=WindowsIdentity.GetCurrent().User;var bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);sidMemory=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,sidMemory,bytes.Length);
            var entry=new ExplicitAccess{Permissions=0x1000,Mode=1,Inheritance=0,Trustee=new Trustee{Form=0,Type=1,Sid=sidMemory}};
            error=SetEntriesInAcl(1,ref entry,old,out newAcl);if(error!=0)throw new System.ComponentModel.Win32Exception((int)error,"relay_self_dacl_merge_failed");
            RawAcl candidate=ReadAcl(newAcl);uint added=Allows(candidate,sid)&~Allows(before,sid);ResidentWire.Need(AllowedMask(added),"relay_access_grant_exceeds_limited_query");
            var candidateHashes=new HashSet<string>();foreach(GenericAce ace in candidate)candidateHashes.Add(AceHash(ace));
            foreach(GenericAce ace in before){var common=ace as CommonAce;bool mergeable=common!=null&&common.AceQualifier==AceQualifier.AccessAllowed&&common.SecurityIdentifier.Equals(sid);ResidentWire.Need(mergeable||candidateHashes.Contains(AceHash(ace)),"relay_existing_ace_not_preserved");}
            error=SetSecurityInfo(handle,6,4,IntPtr.Zero,IntPtr.Zero,newAcl,IntPtr.Zero);if(error!=0)throw new System.ComponentModel.Win32Exception((int)error,"relay_self_dacl_write_failed");
            IntPtr ownerAfter,groupAfter,aclAfter,saclAfter,descriptorAfter;error=GetSecurityInfo(handle,6,4,out ownerAfter,out groupAfter,out aclAfter,out saclAfter,out descriptorAfter);if(error!=0)throw new System.ComponentModel.Win32Exception((int)error,"relay_self_dacl_verify_failed");
            try{RawAcl after=ReadAcl(aclAfter);ResidentWire.Need((Allows(after,sid)&0x1000)!=0,"relay_limited_query_ace_missing");
                return ResidentWire.Obj("scope","current_relay_process_only","pid",Process.GetCurrentProcess().Id,"user_sid_sha256",ResidentWire.Hash(Encoding.UTF8.GetBytes(sid.Value)),"allowed_access_mask",4096,"added_access_mask",added,"before_ace_count",before.Count,"after_ace_count",after.Count,"existing_other_aces_preserved",true,"inheritance",0,"process_exit_removes_object",true,"global_configuration_changed",false,"debug_privilege_requested",false);
            }finally{LocalFree(descriptorAfter);}
        }finally{if(sidMemory!=IntPtr.Zero)Marshal.FreeHGlobal(sidMemory);if(newAcl!=IntPtr.Zero)LocalFree(newAcl);LocalFree(descriptor);}
    }
}
