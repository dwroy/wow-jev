// Pure geometry and first-DOWN decisions. No window, capture, or input calls.
using System;
using System.Collections.Generic;
using WowJev.Input;
static class NativeVisibleFocusFixture
{
    static int checks;
    static void Check(bool value,string label) { if(!value)throw new Exception(label);checks++; }
    static int Main()
    {
        try {
            Check(RecoverySafety.FocusPointRadius==2,"5x5 physical patch");
            Check(RecoverySafety.PointPatchWithinClient(2,2,100,100),"inclusive safe upper boundary");
            Check(!RecoverySafety.PointPatchWithinClient(1,2,100,100),"left patch beyond client denied");
            Check(!RecoverySafety.PointPatchWithinClient(98,50,100,100),"right patch beyond client denied");
            Check(!RecoverySafety.PointPatchWithinClient(50,98,100,100),"bottom patch beyond client denied");
            Check(!RecoverySafety.PointPatchWithinClient(2,2,4,4),"undersized client denied");
            Check(RecoverySafety.FocusCandidate(1536,360,2560,1440),"first physical candidate");
            Check(RecoverySafety.FocusCandidate(1920,1080,2560,1440),"last physical candidate");
            Check(RecoverySafety.FocusCandidate(600,200,1000,800),"windowed candidate");
            Check(!RecoverySafety.FocusCandidate(1280,746,2560,1440),"disconnect control cannot be visible candidate");
            Check(RecoverySafety.RetailWowIdentity("Wow",@"C:\Games\World of Warcraft\_retail_\Wow.exe","GxWindowClassD3d"),"retail identity");
            Check(!RecoverySafety.RetailWowIdentity("Wow",@"C:\Games\_classic_\Wow.exe","GxWindowClassD3d"),"nonretail denied");
            Check(!RecoverySafety.RetailWowIdentity("Wow",@"C:\Games\_retail_\Wow.exe","Chrome_WidgetWin_1"),"wrong class denied");
            Check(!RecoverySafety.RetailWowIdentity("NotWow",@"C:\Games\_retail_\Wow.exe","GxWindowClassD3d"),"wrong name denied");
            Check(RecoverySafety.CursorFree(true,true,true,true,false),"free pointer accepted");
            Check(!RecoverySafety.CursorFree(false,true,true,true,false),"unknown pointer denied");
            Check(!RecoverySafety.CursorFree(true,false,true,true,false),"hidden pointer denied");
            Check(!RecoverySafety.CursorFree(true,true,false,true,false),"missing cursor handle denied");
            Check(!RecoverySafety.CursorFree(true,true,true,false,false),"captured pointer denied");
            Check(!RecoverySafety.CursorFree(true,true,true,true,true),"human held button denied");
            var monitors=new List<RecoveryRect>{new RecoveryRect(0,0,1920,1080)};
            Check(RecoverySafety.CoveredByMonitors(new RecoveryRect(1915,1075,1920,1080),monitors),"complete patch visible while large client may extend offscreen");
            Check(!RecoverySafety.CoveredByMonitors(new RecoveryRect(1916,1075,1921,1080),monitors),"one patch pixel offscreen denied");
            Check(!RecoverySafety.IdleAllowed(6000,1000),"exact idle boundary denied");
            Check(RecoverySafety.IdleAllowed(6001,1000),"strict idle boundary accepted");
            Console.WriteLine("{\"status\":\"passed\",\"checks\":"+checks+",\"game_inputs\":0,\"effect\":\"unverified\"}");return 0;
        }catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
