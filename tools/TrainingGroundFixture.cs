using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using WowJev.Resident;

// Original saved PNGs plus pure pixel faults. No windows/capture/input/model.
static class TrainingGroundFixture {
    static int checks;
    static void Need(bool ok,string name){if(!ok)throw new Exception(name);checks++;}
    static byte[] Pixels(Bitmap input,Rectangle rect){using(var image=new Bitmap(rect.Width,rect.Height,PixelFormat.Format32bppArgb)){
        using(var g=Graphics.FromImage(image))g.DrawImage(input,new Rectangle(0,0,rect.Width,rect.Height),rect.X,rect.Y,rect.Width,rect.Height,GraphicsUnit.Pixel);
        var data=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{var pixels=new byte[image.Width*image.Height*4];for(int y=0;y<image.Height;y++)Marshal.Copy(IntPtr.Add(data.Scan0,y*data.Stride),pixels,y*image.Width*4,image.Width*4);return pixels;}finally{image.UnlockBits(data);}
    }}
    static int Main(string[] args){try{
        if(args.Length<2)throw new Exception("source_png then positive:png or negative:png");Rectangle rect=new Rectangle(1220,1064,110,96),deck=new Rectangle(1380,1110,60,25);var results=new List<object>();
        using(var original=new Bitmap(args[0])){
            var source=Pixels(original,rect);var mask=TrainingGroundVision.Mask(source,rect.Width,rect.Height);var deckPixels=Pixels(original,deck);var template=TrainingDummyVision.Template(deckPixels,deck.Width,deck.Height,new Rectangle(0,0,deck.Width,deck.Height));
            Need(TrainingGroundVision.Match(source,110,96,mask).Matched,"original_supported_boots");
            for(int i=1;i<args.Length;i++){bool positive=args[i].StartsWith("positive:");string path=args[i].Substring(args[i].IndexOf(':')+1);using(var current=new Bitmap(path)){
                var pixels=Pixels(current,rect);var contact=TrainingGroundVision.Match(pixels,110,96,mask);var currentDeck=Pixels(current,deck);var texture=TrainingDummyVision.Score(currentDeck,deck.Width,deck.Height,new Rectangle(0,0,deck.Width,deck.Height),template);bool matched=contact.Matched&&texture.Matched;
                Need(matched==positive,"saved_scene_"+i);results.Add(new{path=path,expected=positive,matched=matched,contact=contact,deck=texture});
            }}
            var blank=new byte[source.Length];for(int i=0;i<blank.Length;i+=4){blank[i]=120;blank[i+1]=120;blank[i+2]=120;blank[i+3]=255;}Need(!TrainingGroundVision.Match(blank,110,96,mask).Matched,"blank_modal_rejected");
            var single=(byte[])source.Clone();for(int y=0;y<96;y++)for(int x=0;x<55;x++){int p=(y*110+x)*4;single[p]=100;single[p+1]=110;single[p+2]=120;}Need(!TrainingGroundVision.Match(single,110,96,mask).Matched,"single_boot_rejected");
            var raised=(byte[])blank.Clone();for(int y=0;y<88;y++)Array.Copy(source,(y+8)*110*4,raised,y*110*4,110*4);Need(!TrainingGroundVision.Match(raised,110,96,mask).Matched,"raised_boots_rejected");
            var water=(byte[])source.Clone();for(int i=0;i<mask.Length;i++)if(!mask[i]){int p=i*4;water[p]=150;water[p+1]=80;water[p+2]=30;}Need(!TrainingGroundVision.Match(water,110,96,mask).Matched,"blue_support_rejected");
            var block=new byte[source.Length];Need(!TrainingGroundVision.Match(block,110,96,mask).Matched,"uniform_dark_block_rejected");
            bool referenceRejected=false;try{TrainingGroundVision.ValidateReference(new bool[110*96],110,96);}catch(InvalidOperationException){referenceRejected=true;}Need(referenceRejected,"empty_reference_rejected");
            bool budgetRejected=false;try{TrainingGroundVision.Mask(new byte[79*96*4],79,96);}catch(InvalidOperationException){budgetRejected=true;}Need(budgetRejected,"dimension_budget_rejected");
        }
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{status="passed",checks=checks,method=TrainingGroundVision.Method,saved_scenes=results,real_inputs=0,capture_calls=0,desktop_windows_created=0}));return 0;
    }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+":"+error.Message);return 2;}}
}
