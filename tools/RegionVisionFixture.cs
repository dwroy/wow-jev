// Real offscreen System.Drawing pixels. Does not enumerate/capture windows or input.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Web.Script.Serialization;
using WowJev.Eye;
static class RegionVisionFixture
{
    static object R(int x,int y,int w,int h){return EyeJson.Obj("x",x,"y",y,"width",w,"height",h);}
    static Dictionary<string,object> Scope(){return EyeJson.Obj("branch","retail","expansion","midnight","patch","12.1.0","build",69933,"region","cn","locale","zh_CN","client_width",128,"client_height",96,"dpi",96,"ui_scale",1,"layout_id","synthetic-fixture-v1","font_id","fixture","addons_sha256",new string('0',64));}
    static void Write(string path,object data){File.WriteAllText(path,new JavaScriptSerializer().Serialize(data));}
    static void Main(string[] args)
    {
        string root=Path.GetFullPath(args[0]);Directory.CreateDirectory(root);
        using(Bitmap image=new Bitmap(128,96,PixelFormat.Format24bppRgb))
        {
            for(int y=0;y<96;y++)for(int x=0;x<128;x++)image.SetPixel(x,y,Color.FromArgb((x*7+y*3)%110,(x+y*5)%100,(x*3+y*11)%130));
            Color[] colors={Color.Magenta,Color.Cyan,Color.Yellow,Color.White};for(int y=0;y<2;y++)for(int x=0;x<2;x++)image.SetPixel(3+x,3+y,colors[y*2+x]);
            for(int y=3;y<7;y++)for(int x=7;x<27;x++)image.SetPixel(x,y,x<17?Color.Lime:Color.Black);
            using(Bitmap anchor=image.Clone(new Rectangle(3,3,2,2),PixelFormat.Format24bppRgb))anchor.Save(Path.Combine(root,"anchor.png"),ImageFormat.Png);
            using(Bitmap blocker=image.Clone(new Rectangle(7,3,20,4),PixelFormat.Format24bppRgb))blocker.Save(Path.Combine(root,"blocker.png"),ImageFormat.Png);
            object template=EyeJson.Obj("path","anchor.png","sha256",EyeJson.Hash(Path.Combine(root,"anchor.png")));
            object detector=EyeJson.Obj("kind","fill_bar","color_min",new[]{0,150,0},"color_max",new[]{70,255,70},"axis","horizontal","reverse",false,"minimum_cross_fraction",0.9);
            Dictionary<string,object> target=EyeJson.Obj("id","target","module","target","parent_id",null,"roi",R(4,0,20,4),"anchor",EyeJson.Obj("template",template,"search",R(2,2,4,4),"step",1,"max_candidates",9,"max_distance",0.0001,"min_margin",0.01),"seed_allowed",true,"elements",new[]{EyeJson.Obj("id","health","field","target.health_ratio","roi",R(0,0,20,4),"detector",detector,"max_age_ms",750)});
            var scope=Scope();string context=Path.Combine(root,"context.json"),profile=Path.Combine(root,"profile.json");Write(context,scope);
            List<object> nodes=new List<object>();nodes.Add(target);
            foreach(string module in new[]{"player","cast","actionbar","quest","dialog","inventory","minimap","blocking"})nodes.Add(EyeJson.Obj("id",module,"module",module,"parent_id",null,"roi",R(40,20,4,4),"seed_allowed",true,"elements",new object[0]));
            var config=EyeJson.Obj("version",1,"kind","regional-eye-profile","id","fixture-regions","scope",scope,"regions",nodes);Write(profile,config);
            RegionVision parser=new RegionVision(profile,context);var first=parser.Detect(image,"frame-1",100,96);var second=parser.Detect(image,"frame-2",200,96);
            if((string)first["status"]!="ok")throw new Exception("scope");
            var one=EyeJson.Map(((List<object>)first["regions"])[0]);var atom=EyeJson.Map(((List<object>)one["elements"])[0]);
            if((string)atom["status"]!="known"||Math.Abs((double)atom["value"]-0.5)>0.001)throw new Exception("fill");
            var two=EyeJson.Map(((List<object>)second["regions"])[0]);var old=EyeJson.Map(((List<object>)two["elements"])[0]);
            if(!(bool)two["cached"]||Convert.ToInt64(old["parsed_at_qpc_ms"])!=100||Convert.ToInt64(two["pixels_verified_qpc_ms"])!=200)throw new Exception("cache_time");
            var mismatch=parser.Detect(image,"frame-3",300,144);if((string)mismatch["status"]!="unknown")throw new Exception("dpi_scope");
            var restored=parser.Detect(image,"frame-4",400,96);var fresh=EyeJson.Map(((List<object>)restored["regions"])[0]);if((bool)fresh["cached"])throw new Exception("cache_invalidation");
            image.Save(Path.Combine(root,"mother.png"),ImageFormat.Png);
            image.SetPixel(3,3,Color.Black);var hidden=parser.Detect(image,"frame-5",500,96);if((string)EyeJson.Map(((List<object>)hidden["regions"])[0])["presence"]!="unknown")throw new Exception("hidden_anchor");
            image.SetPixel(3,3,Color.Magenta);
            var block=EyeJson.Obj("id","blocking","module","blocking","parent_id",null,"roi",R(7,3,20,4),"visibility",EyeJson.Obj("present",EyeJson.Obj("path","blocker.png","sha256",EyeJson.Hash(Path.Combine(root,"blocker.png"))),"max_distance",0.001,"min_margin",0.01),"seed_allowed",false,"elements",new object[0]);object originalBlocking=nodes[nodes.Count-1];nodes[nodes.Count-1]=block;Write(profile,config);
            var occluded=new RegionVision(profile,context).Detect(image,"frame-6",600,96);if((string)EyeJson.Map(((List<object>)occluded["regions"])[0])["presence"]!="occluded")throw new Exception("blocker");
            nodes[nodes.Count-1]=originalBlocking;Write(profile,config);
            scope["build"]=69934;Write(context,scope);var version=new RegionVision(profile,context).Detect(image,"frame-7",700,96);if((string)version["status"]!="unknown")throw new Exception("build_scope");
            scope["build"]=69933;Write(context,scope);Write(profile,config);
            object originalElements=target["elements"];
            target["elements"]=new[]{EyeJson.Obj("id","ready","field","combat.ability.fixture.ready","roi",R(0,0,20,4),"detector",EyeJson.Obj("kind","color_fraction","color_min",new[]{0,150,0},"color_max",new[]{70,255,70},"minimum_fraction",0.49,"maximum_fraction",0.51),"max_age_ms",750)};Write(profile,config);
            RegionVision criticalParser=new RegionVision(profile,context);var criticalFirst=criticalParser.Detect(image,"critical-1",800,96);var criticalSecond=criticalParser.Detect(image,"critical-2",900,96);
            var criticalRow=EyeJson.Map(((List<object>)criticalSecond["regions"])[0]);if((bool)criticalRow["cached"]||Convert.ToInt64(EyeJson.Map(((List<object>)criticalRow["elements"])[0])["parsed_at_qpc_ms"])!=900)throw new Exception("critical_freshness");
            using(Bitmap other=new Bitmap(20,4)) {using(Graphics g=Graphics.FromImage(other))g.Clear(Color.White);other.Save(Path.Combine(root,"other.png"),ImageFormat.Png);}
            target["elements"]=new[]{EyeJson.Obj("id","mode","field","player.movement_mode","roi",R(0,0,20,4),"detector",EyeJson.Obj("kind","template_labels","candidates",new[]{EyeJson.Obj("label","ground","template",EyeJson.Obj("path","blocker.png","sha256",EyeJson.Hash(Path.Combine(root,"blocker.png")))),EyeJson.Obj("label","mounted","template",EyeJson.Obj("path","other.png","sha256",EyeJson.Hash(Path.Combine(root,"other.png"))))},"max_distance",0.01,"min_margin",0.1),"max_age_ms",750)};Write(profile,config);
            var labeled=new RegionVision(profile,context).Detect(image,"label-1",1000,96);if((string)EyeJson.Map(((List<object>)EyeJson.Map(((List<object>)labeled["regions"])[0])["elements"])[0])["value"]!="ground")throw new Exception("template_labels");
            target["elements"]=originalElements;Write(profile,config);

            Console.WriteLine(new JavaScriptSerializer().Serialize(EyeJson.Obj("kind","offscreen-region-fixture","real_bitmap",true,"game_capture",false,"game_input",false,"first",first,"cached",second,"dpi_mismatch",mismatch,"restored",restored,"hidden",hidden,"occluded",occluded,"build_mismatch",version,"critical_first",criticalFirst,"critical_second",criticalSecond,"labeled",labeled)));
        }
    }
}
