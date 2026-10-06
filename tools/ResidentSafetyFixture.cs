// Pure policy/schema fixture. Never creates a desktop window or sends input.
using System;
using System.Collections.Generic;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using WowJev.Input;

static class ResidentSafetyFixture
{
    static int checks;
    static void Need(bool value,string reason){if(!value)throw new Exception(reason);checks++;}
    static void Reject(Action action,string reason){bool rejected=false;try{action();}catch(InvalidOperationException){rejected=true;}Need(rejected,reason);}
    static Dictionary<string,object> Target(){return ResidentWire.Obj("pid",123,"start_ticks","123456","hwnd","0x123","class","waApplication Window","executable",@"C:\Fixture\_retail_\Wow.exe","windows_session_id",1);}
    static Dictionary<string,object> Config(){return ResidentWire.Obj("version",1,"target_scope","retail_wow","fixture_executable",null,"session_id","11111111-1111-4111-8111-111111111111","channel_generation","22222222-2222-4222-8222-222222222222","pipe_name","WowJevResident-"+new string('a',32),"nonce",new string('b',64),"target",Target(),"authorized_input",false,"focus_recovery_authorized",false,"max_actions",0,"duration_ms",60000,"output",@"C:\fixture\output","local_output",@"C:\fixture\local","payload_hashes",ResidentWire.Obj("ResidentSessionHost.exe",new string('c',64)),"dialog_absence_calibration",null);}
    static Dictionary<string,object> Command(string op){return ResidentWire.Obj("protocol","wow-resident","version",1,"type","command","session_id","11111111-1111-4111-8111-111111111111","id","fixture","op",op);}
    static int Main(string[] args){try{
        if(args.Length!=1)throw new Exception("fixed_fixture_directory_required");var schema=new ResidentSchema(Path.Combine(args[0],"resident-session-v1.schema.json"),Path.Combine(args[0],"native-input-v1.schema.json"));
        schema.Definition(Config(),"launch_config");checks++;
        foreach(string field in new[]{"nonce","pipe_name","session_id","channel_generation"}){var invalid=Config();invalid[field]="bad";Reject(()=>schema.Definition(invalid,"launch_config"),field);}
        foreach(int value in new[]{0,300001}){var invalid=Config();invalid["duration_ms"]=value;Reject(()=>schema.Definition(invalid,"launch_config"),"run_budget");}
        var unsafeConfig=Config();unsafeConfig["arbitrary_executable"]="cmd.exe";Reject(()=>schema.Definition(unsafeConfig,"launch_config"),"unowned_launch");
        foreach(string op in new[]{"heartbeat","observe","cancel","release_all","shutdown","status"}){schema.Definition(Command(op),"command");checks++;}
        foreach(string op in new[]{"set_foreground","background_key","run_shell","update_install"})Reject(()=>schema.Definition(Command(op),"command"),"unsupported_operation");
        var evidence=Command("evidence");evidence.Add("ocr",false);schema.Definition(evidence,"command");checks++;
        var invalidOcr=Command("evidence");invalidOcr.Add("ocr","yes");Reject(()=>schema.Definition(invalidOcr,"command"),"ocr_boolean");
        var alias=ResidentWire.Map(ResidentWire.Clone(Target()));Need(ResidentWire.Same(alias,Target()),"same_target");alias["pid"]=124;Need(!ResidentWire.Same(alias,Target()),"different_pid");
        for(int mask=0;mask<32;mask++){bool known=(mask&1)!=0,visible=(mask&2)!=0,handle=(mask&4)!=0,capture=(mask&8)!=0,user=(mask&16)!=0;Need(TimelineCursorSafety.EvaluateFirstDown(known,visible,handle,capture,user)==(mask==15),"cursor_policy");}
        Need(ResidentSelfAccess.AllowedMask(0),"unchanged_access");Need(ResidentSelfAccess.AllowedMask(0x1000),"limited_access");foreach(uint mask in new uint[]{1,0x10,0x20,0x400,0x20000,0x40000,0x1fffff})Need(!ResidentSelfAccess.AllowedMask(mask),"overbroad_process_access");
        Reject(()=>ResidentSelfAccess.GrantLimitedQuery(),"wrong_executable_cannot_modify_dacl");
        using(var image=new Bitmap(192,132,PixelFormat.Format32bppArgb)){
            using(var g=Graphics.FromImage(image)){
                g.Clear(Color.FromArgb(32,32,32));g.FillRectangle(Brushes.Magenta,0,0,192,4);
                for(int bit=0;bit<32;bit++){g.FillRectangle((2u&(1u<<bit))!=0?Brushes.Lime:Brushes.Red,bit*6,4,6,8);g.FillRectangle((10u&(1u<<bit))!=0?Brushes.Lime:Brushes.Red,bit*6,20,6,8);}
                using(var blue=new SolidBrush(Color.FromArgb(0,120,220)))g.FillRectangle(blue,0,52,192,80);
            }
            var match=ResidentRecordingCv.Match(image,800,440,new string('a',64),new string('b',64),new string('c',64));Need((bool)match["verified"],"recording_roi_positive");Need(Convert.ToUInt32(match["click_count"])==2,"recording_count");Need(Convert.ToUInt32(match["frame_nonce"])==10,"recording_nonce");Need((string)match["game_effect"]=="unverified","fixture_not_game_effect");
            image.SetPixel(0,0,Color.Black);Need(!(bool)ResidentRecordingCv.Match(image,800,440,new string('a',64),new string('b',64),new string('c',64))["verified"],"changed_marker_denied");
            image.SetPixel(0,0,Color.Magenta);image.SetPixel(20,90,Color.Black);Need(!(bool)ResidentRecordingCv.Match(image,800,440,new string('a',64),new string('b',64),new string('c',64))["verified"],"changed_control_denied");
            Need(!(bool)ResidentRecordingCv.Match(image,200,100,new string('a',64),new string('b',64),new string('c',64))["verified"],"recording_client_bounds_denied");
        }
        Console.WriteLine(ResidentWire.Encode(ResidentWire.Obj("status","passed","checks",checks,"real_inputs",0,"desktop_windows_created",0,"capture_calls",0,"scope","pure_schema_and_first_down_policy")));return 0;
    }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}}
}
