using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Diagnostics;
using WowJev.Resident;

public static class TrainingDummyFixture {
    static byte[] Pixels(Bitmap bitmap){
        using(var image=new Bitmap(bitmap.Width,bitmap.Height,PixelFormat.Format32bppArgb)){
            using(var graphics=Graphics.FromImage(image))graphics.DrawImage(bitmap,new Rectangle(0,0,image.Width,image.Height),0,0,bitmap.Width,bitmap.Height,GraphicsUnit.Pixel);
            var locked=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            try{var result=new byte[image.Width*image.Height*4];for(int y=0;y<image.Height;y++)Marshal.Copy(IntPtr.Add(locked.Scan0,y*locked.Stride),result,y*image.Width*4,image.Width*4);return result;}
            finally{image.UnlockBits(locked);}
        }
    }
    public static int Main(string[] args){
        try{
            if(args.Length!=2)throw new Exception("source_png current_png; pure offline fixture only");
            using(var original=new Bitmap(args[0]))using(var current=new Bitmap(args[1])){
                var source=Pixels(original);var pixels=Pixels(current);
                // Fixed source rectangles are calibration material only. Locate
                // searches current neutral bars; no source click point is used.
                var reference=new TrainingDummyVision.Reference{Name="作战假人",Width=original.Width,Height=original.Height,
                    NameRect=new Rectangle(1138,163,68,16),BodyRect=new Rectangle(1208,278,45,50),GoldRect=new Rectangle(1150,162,200,19)};
                reference.NameRgb=TrainingDummyVision.Template(source,original.Width,original.Height,reference.NameRect);
                reference.BodyRgb=TrainingDummyVision.Template(source,original.Width,original.Height,reference.BodyRect);
                reference.NameMask=TrainingDummyVision.NameMask(source,original.Width,original.Height,reference.NameRect);
                var clock=Stopwatch.StartNew();List<Rectangle> candidates;var hits=TrainingDummyVision.Locate(pixels,current.Width,current.Height,reference,out candidates);
                clock.Stop();var instruction=new Rectangle(1290,944,255,28);var instructionScore=TrainingDummyVision.Score(pixels,current.Width,current.Height,instruction,TrainingDummyVision.Template(source,original.Width,original.Height,instruction));
                var result=new List<object>();foreach(var hit in hits)result.Add(new{point=new{x=hit.Point.X,y=hit.Point.Y},name_rect=new{x=hit.NameRect.X,y=hit.NameRect.Y,width=hit.NameRect.Width,height=hit.NameRect.Height},body_rect=new{x=hit.BodyRect.X,y=hit.BodyRect.Y,width=hit.BodyRect.Width,height=hit.BodyRect.Height},name_score=hit.NameScore,body_score=hit.BodyScore});
                Console.WriteLine(new JavaScriptSerializer().Serialize(new{method=TrainingDummyVision.Method,status=hits.Count>0&&instructionScore.Matched?"known":"unknown",entity_status=hits.Count>0?"known":"unknown",scene_anchor=instructionScore,elapsed_ms=clock.Elapsed.TotalMilliseconds,hits=result,source_dimensions=new{width=original.Width,height=original.Height,dpi=original.HorizontalResolution,pixel=original.GetPixel(1250,170).ToString(),copied=new{r=source[(170*original.Width+1250)*4+2],g=source[(170*original.Width+1250)*4+1],b=source[(170*original.Width+1250)*4]}},candidates=candidates,source_name=TrainingDummyVision.Score(source,original.Width,original.Height,reference.NameRect,reference.NameRgb),source_body=TrainingDummyVision.Score(source,original.Width,original.Height,reference.BodyRect,reference.BodyRgb),scope="saved_png_offline_only",input_issued=false}));return 0;
            }
        }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+":"+error.Message);return 2;}
    }
}
