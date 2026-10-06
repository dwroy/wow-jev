// A classifier for the project's fixed recording surface, never for a game UI.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

static class ResidentRecordingCv
{
    public static readonly Rectangle Region=new Rectangle(32,28,192,132);
    static uint Decode(byte[] pixels,int stride,int y){uint result=0;for(int bit=0;bit<32;bit++){
        int x=bit*6;bool? value=null;
        for(int yy=y;yy<y+8;yy++)for(int xx=x;xx<x+6;xx++){int at=yy*stride+xx*4;bool green=pixels[at]==0&&pixels[at+1]==255&&pixels[at+2]==0;bool red=pixels[at]==0&&pixels[at+1]==0&&pixels[at+2]==255;ResidentWire.Need(green||red,"recording_bit_unknown");if(value.HasValue)ResidentWire.Need(value.Value==green,"recording_bit_inconsistent");value=green;}
        if(value.Value)result|=1u<<bit;
    }return result;}
    public static Dictionary<string,object> Match(Bitmap image,int width,int height,string layout,string targetSignature,string calibrationHash){
        try{
            ResidentWire.Need(width>=224&&height>=240&&image.Width==Region.Width&&image.Height==Region.Height,"recording_layout_unknown");
            byte[] pixels=new byte[image.Width*image.Height*4];var locked=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            try{for(int y=0;y<image.Height;y++)Marshal.Copy(IntPtr.Add(locked.Scan0,y*locked.Stride),pixels,y*image.Width*4,image.Width*4);}finally{image.UnlockBits(locked);}
            int stride=image.Width*4;for(int y=0;y<4;y++)for(int x=0;x<192;x++){int at=y*stride+x*4;ResidentWire.Need(pixels[at]==255&&pixels[at+1]==0&&pixels[at+2]==255,"recording_marker_unknown");}
            for(int y=52;y<132;y++)for(int x=0;x<192;x++){int at=y*stride+x*4;ResidentWire.Need(pixels[at]==220&&pixels[at+1]==120&&pixels[at+2]==0,"recording_control_unknown");}
            uint count=Decode(pixels,stride,4),nonce=Decode(pixels,stride,20);
            return ResidentWire.Obj("verified",true,"source","fixed_recording_cv","target_signature",targetSignature,"button",ResidentWire.Obj("id","fixture-click","x",128,"y",120,"layout_id",layout,"enabled",true),"click_count",count,"frame_nonce",nonce,"calibration_sha256",calibrationHash,"game_effect","unverified");
        }catch{return ResidentWire.Obj("verified",false,"source","fixed_recording_cv","reason","recording_current_roi_unknown","game_effect","unverified");}
    }
}
