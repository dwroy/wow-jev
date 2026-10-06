// Calibration is immutable for the lifetime of a host. Templates are hashed and
// loaded once; warm matching touches bounded client ROIs with LockBits only.
// This file is shared by the recovery bridge and persistent host. It never
// captures a desktop, changes a window or issues input.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

public static class RecoveryTutorialCv
{
    public static Dictionary<string, object> Match(Bitmap image, string fixedDirectory)
    { return RecoveryCvProfile.Tutorial(image, fixedDirectory); }
}

public sealed class RecoveryCvRegion
{
    public string Id; public Rectangle Rectangle;
}
public sealed class RecoveryCvFrameRegion
{
    public Rectangle Rectangle; public Bitmap Image;
}

public static class RecoveryCvProfile
{
    public static Dictionary<string, object> Obj(params object[] values)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < values.Length; i += 2) result.Add((string)values[i], values[i + 1]);
        return result;
    }
    static Dictionary<string, object> Map(object value) { return (Dictionary<string, object>)value; }
    static int Int(Dictionary<string, object> value, string key) { return Convert.ToInt32(value[key], CultureInfo.InvariantCulture); }
    static double Number(Dictionary<string, object> value, string key) { return Convert.ToDouble(value[key], CultureInfo.InvariantCulture); }
    static string Hash(string path)
    {
        using (var file = File.OpenRead(path)) using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
    }
    public static int Round(double value) { return (int)Math.Round(value, MidpointRounding.AwayFromZero); }
    static Rectangle Rect(Dictionary<string, object> row)
    { return new Rectangle(Int(row,"x"),Int(row,"y"),Int(row,"width"),Int(row,"height")); }
    public static Bitmap Resize(Bitmap source, int width, int height)
    {
        var target = new Bitmap(width,height,PixelFormat.Format32bppArgb);
        using (var graphics=Graphics.FromImage(target)) using (var attributes=new ImageAttributes())
        {
            graphics.CompositingMode=CompositingMode.SourceCopy;
            graphics.InterpolationMode=InterpolationMode.HighQualityBilinear;
            graphics.PixelOffsetMode=PixelOffsetMode.Half;
            attributes.SetWrapMode(WrapMode.TileFlipXY);
            graphics.DrawImage(source,new Rectangle(0,0,width,height),0,0,source.Width,source.Height,GraphicsUnit.Pixel,attributes);
        }
        return target;
    }
    static Bitmap ResizeAt(Bitmap source,int width,int height,double scale,double left,double top)
    {
        var target=new Bitmap(width,height,PixelFormat.Format32bppArgb);
        using(var graphics=Graphics.FromImage(target))using(var attributes=new ImageAttributes())
        {
            graphics.CompositingMode=CompositingMode.SourceCopy;graphics.InterpolationMode=InterpolationMode.HighQualityBilinear;
            graphics.PixelOffsetMode=PixelOffsetMode.Half;attributes.SetWrapMode(WrapMode.TileFlipXY);
            graphics.DrawImage(source,new RectangleF((float)left,(float)top,(float)(source.Width*scale),(float)(source.Height*scale)),
                new RectangleF(0,0,source.Width,source.Height),GraphicsUnit.Pixel);
        }
        return target;
    }
    public sealed class Pixels
    {
        public readonly int Width, Height; public readonly byte[] Data;
        public Pixels(Bitmap image,Rectangle rectangle)
        {
            if(rectangle.Width<1||rectangle.Height<1||rectangle.X<0||rectangle.Y<0||rectangle.Right>image.Width||rectangle.Bottom>image.Height)
                throw new InvalidOperationException("roi_bounds");
            Width=rectangle.Width;Height=rectangle.Height;Data=new byte[Width*Height*4];
            var bits=image.LockBits(rectangle,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            try { for(int y=0;y<Height;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),Data,y*Width*4,Width*4); }
            finally { image.UnlockBits(bits); }
        }
        public bool[] Mask(string mask)
        {
            var values=new bool[Width*Height];
            for(int i=0;i<values.Length;i++)
            {
                int b=Data[i*4],g=Data[i*4+1],r=Data[i*4+2];
                if(mask=="green")values[i]=g>=155&&r<=110&&b<=120&&g-r>=60;
                else if(mask=="gray")values[i]=r>=140&&g>=140&&b>=140&&Math.Max(r,Math.Max(g,b))-Math.Min(r,Math.Min(g,b))<=35;
                else throw new InvalidOperationException("unknown_mask");
            }
            return values;
        }
    }
    sealed class Profile
    {
        public Dictionary<string,object> Row;public string CalibrationHash,ReferenceHash;
        public Bitmap Card;public readonly Dictionary<string,Bitmap> Tutorial=new Dictionary<string,Bitmap>();
        public readonly Dictionary<string,Scaled> Scales=new Dictionary<string,Scaled>();
    }
    sealed class Scaled
    {
        public readonly Dictionary<string,Pixels> Pixels=new Dictionary<string,Pixels>();
        public readonly Dictionary<string,bool[]> Masks=new Dictionary<string,bool[]>();
        public readonly Dictionary<string,int[]> InkOffsets=new Dictionary<string,int[]>();
    }
    static readonly object CacheLock=new object();
    static readonly Dictionary<string,Profile> Profiles=new Dictionary<string,Profile>(StringComparer.OrdinalIgnoreCase);
    static int TemplateLoads;
    static Profile Load(string folder,bool tutorial)
    {
        string directory=Path.GetFullPath(folder),key=directory+(tutorial?"|tutorial":"|selection");
        lock(CacheLock)
        {
            Profile cached;if(Profiles.TryGetValue(key,out cached))return cached;
            string file=Path.Combine(directory,tutorial?"tutorial-talk-jaina.json":"selected-alliance-warrior.json");
            var row=Map(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file,Encoding.UTF8)));
            var layout=Map(row["layout"]);
            if(Int(row,"version")!=2||Int(layout,"width")!=2560||Int(layout,"height")!=1440)
                throw new InvalidOperationException("calibration_profile_version");
            var normalization=Map(row["normalization"]);
            if((string)normalization["id"]!="anchored-uniform-ui-v1")throw new InvalidOperationException("calibration_anchor_model");
            if(((object[])normalization["ui_scale_factors"]).Length>8)throw new InvalidOperationException("scale_budget");
            var profile=new Profile{Row=row,CalibrationHash=Hash(file)};
            if(tutorial)
            {
                if((string)row["npc_name"]!="吉安娜·普罗德摩尔"||(string)row["tutorial_step"]!="与吉安娜·普罗德摩尔交谈")
                    throw new InvalidOperationException("tutorial_identity");
                var ids=new HashSet<string>();
                foreach(object value in (object[])row["regions"])
                {
                    var region=Map(value);string id=(string)region["id"],name=(string)region["file"],mask=(string)region["mask"];
                    if(!ids.Add(id)||!((id=="npc_name"&&name=="tutorial-npc-name.png"&&mask=="green")||
                        (id=="tutorial_hint"&&name=="tutorial-talk-hint.png"&&mask=="gray")))throw new InvalidOperationException("region_identity");
                    if(Number(region,"min_iou")<.90||Number(region,"min_iou")>1||Int(region,"max_shift_px")<0||Int(region,"max_shift_px")>3)
                        throw new InvalidOperationException("mask_threshold");
                    string path=Path.Combine(directory,name);if(Hash(path)!=(string)region["sha256"])throw new InvalidOperationException("template_hash");
                    var bitmap=new Bitmap(path);var rectangle=Rect(Map(region["rect"]));
                    if(bitmap.Width!=rectangle.Width||bitmap.Height!=rectangle.Height)throw new InvalidOperationException("template_dimensions");
                    var maskValues=new Pixels(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height)).Mask(mask);int ink=0;
                    foreach(bool pixel in maskValues)if(pixel)ink++;
                    if(ink<150||ink>maskValues.Length/2)throw new InvalidOperationException("template_ink");
                    profile.Tutorial.Add(id,bitmap);
                }
                if(!ids.SetEquals(new[]{"npc_name","tutorial_hint"}))throw new InvalidOperationException("tutorial_regions");
                profile.ReferenceHash=(string)Map(row["source"])["original_capture_sha256"];
            }
            else
            {
                var reference=Map(row["reference"]);string path=Path.Combine(directory,"selected-alliance-warrior.png");
                profile.ReferenceHash=Hash(path);
                if((string)reference["file"]!="selected-alliance-warrior.png"||(string)reference["sha256"]!=profile.ReferenceHash)
                    throw new InvalidOperationException("selection_reference_hash");
                profile.Card=new Bitmap(path);var rectangle=Rect(Map(reference["rect"]));
                if(profile.Card.Width!=rectangle.Width||profile.Card.Height!=rectangle.Height)throw new InvalidOperationException("selection_template_dimensions");
                var character=Map(row["character"]);
                if((string)character["name"]!="小啊"||(string)character["class"]!="warrior"||(string)character["faction"]!="alliance")
                    throw new InvalidOperationException("selection_identity");
                var ids=new HashSet<string>();
                foreach(object value in (object[])row["regions"])
                {
                    var region=Map(value);string id=(string)region["id"];if(!ids.Add(id))throw new InvalidOperationException("duplicate_region");
                    double maxMean=Number(region,"max_mean_abs_error"),maxFraction=Number(region,"max_fraction_above_24");
                    if(maxMean<0||maxFraction<0||(id=="name"||id=="class")&&(maxMean>.8||maxFraction>.002)||
                        id=="alliance_glyph"&&(maxMean>2||maxFraction>.01)||id=="selected_card"&&(maxMean>8||maxFraction>.05))
                        throw new InvalidOperationException("selection_threshold");
                }
                if(!ids.SetEquals(new[]{"selected_card","name","class","alliance_glyph"}))throw new InvalidOperationException("selection_regions");
            }
            Profiles.Add(key,profile);TemplateLoads++;return profile;
        }
    }
    // One scalar controls font/glyph aspect; different client aspect ratios only
    // change anchor positions. Stretching letters independently in X/Y cannot pass.
    public static Rectangle SelectionCard(int width,int height,double scale,Rectangle reference)
    {
        return new Rectangle(Round(width+(reference.X-2560)*scale),Round(height*.5+(reference.Y-720)*scale),
            Round(reference.Width*scale),Round(reference.Height*scale));
    }
    public static Rectangle TutorialRegion(int width,int height,double scale,Rectangle reference,string id)
    {
        int w=Round(reference.Width*scale),h=Round(reference.Height*scale),x,y;
        if(id=="npc_name")
        {
            // The world-space label position follows normalized client geometry;
            // UI scale changes label size around that independently anchored point.
            x=Round((reference.X+reference.Width*.5)*width/2560.0-reference.Width*scale*.5);
            y=Round((reference.Y+reference.Height*.5)*height/1440.0-reference.Height*scale*.5);
        }
        else if(id=="tutorial_hint")
        {
            x=Round(width*.5+(reference.X-1280)*scale);
            y=height+Round((reference.Y-1440)*scale);
        }
        else throw new InvalidOperationException("region_identity");
        return new Rectangle(x,y,w,h);
    }
    static Rectangle Subrectangle(Rectangle region,Rectangle reference,double scale)
    {
        int left=Round((region.X-reference.X)*scale),top=Round((region.Y-reference.Y)*scale);
        return new Rectangle(left,top,Round((region.Right-reference.X)*scale)-left,Round((region.Bottom-reference.Y)*scale)-top);
    }
    static bool Inside(Rectangle rect,int width,int height)
    { return rect.Width>=8&&rect.Height>=5&&rect.X>=0&&rect.Y>=0&&rect.Right<=width&&rect.Bottom<=height; }
    static bool Inside(Rectangle rect,Frame frame){return Inside(rect,frame.Width,frame.Height);}
    static Scaled Scale(Profile profile,double scale,bool tutorial,int width,int height)
    {
        string key=width+"x"+height+":"+scale.ToString("F6",CultureInfo.InvariantCulture)+(tutorial?"t":"s");
        lock(CacheLock)
        {
            Scaled cached;if(profile.Scales.TryGetValue(key,out cached))return cached;
            var result=new Scaled();
            if(tutorial)
            {
                foreach(object value in (object[])profile.Row["regions"])
                {
                    var region=Map(value);string id=(string)region["id"];var source=profile.Tutorial[id];
                    var reference=Rect(Map(region["rect"]));var transformed=TutorialRegion(width,height,scale,reference,id);
                    double left=id=="npc_name"?(reference.X+reference.Width*.5)*width/2560.0-reference.Width*scale*.5:width*.5+(reference.X-1280)*scale;
                    double top=id=="npc_name"?(reference.Y+reference.Height*.5)*height/1440.0-reference.Height*scale*.5:height+(reference.Y-1440)*scale;
                    using(var resized=ResizeAt(source,transformed.Width,transformed.Height,scale,left-transformed.X,top-transformed.Y))
                    {
                        var pixels=new Pixels(resized,new Rectangle(0,0,resized.Width,resized.Height));
                        result.Pixels.Add(id,pixels);var mask=pixels.Mask((string)region["mask"]);result.Masks.Add(id,mask);
                        int shift=Math.Max(1,Round(Int(region,"max_shift_px")*scale)),liveWidth=pixels.Width+2*shift;
                        var offsets=new List<int>();for(int y=0;y<pixels.Height;y++)for(int x=0;x<pixels.Width;x++)if(mask[y*pixels.Width+x])offsets.Add(y*liveWidth+x);
                        result.InkOffsets.Add(id,offsets.ToArray());
                    }
                }
            }
            else
            {
                var reference=Rect(Map(Map(profile.Row["reference"])["rect"]));
                var transformed=SelectionCard(width,height,scale,reference);
                double left=width+(reference.X-2560)*scale,top=height*.5+(reference.Y-720)*scale;
                using(var resized=ResizeAt(profile.Card,transformed.Width,transformed.Height,scale,left-transformed.X,top-transformed.Y))
                {
                    foreach(object value in (object[])profile.Row["regions"])
                    {
                        var region=Map(value);var sub=Subrectangle(Rect(Map(region["rect"])),reference,scale);
                        result.Pixels.Add((string)region["id"],new Pixels(resized,sub));
                    }
                }
            }
            // Limit cached transformed copies when callers resize repeatedly.
            // The common stable-window path keeps every allowed UI scale warm.
            if(profile.Scales.Count>=64)profile.Scales.Clear();
            profile.Scales.Add(key,result);return result;
        }
    }
    static double[] Scales(Profile profile,int imageWidth,int imageHeight)
    {
        if(imageWidth<640||imageHeight<360||imageWidth>7680||imageHeight>4320||
            (double)imageWidth/imageHeight<1|| (double)imageWidth/imageHeight>3.5)
            throw new InvalidOperationException("unsupported_client_geometry");
        var list=new List<double>();double viewport=(double)imageHeight/1440;
        foreach(object value in (object[])Map(profile.Row["normalization"])["ui_scale_factors"])
        {
            double factor=Convert.ToDouble(value,CultureInfo.InvariantCulture),scale=viewport*factor;
            if(factor<.75||factor>1.5)throw new InvalidOperationException("ui_scale_range");
            if(scale>=.375&&scale<=3&&!list.Contains(scale))list.Add(scale);
        }
        return list.ToArray();
    }
    abstract class Frame
    {
        public int Width,Height;
        public abstract Pixels Read(Rectangle rectangle);
    }
    sealed class WholeFrame:Frame
    {
        readonly Bitmap Image;
        public WholeFrame(Bitmap image){Image=image;Width=image.Width;Height=image.Height;}
        public override Pixels Read(Rectangle rectangle){return new Pixels(Image,rectangle);}
    }
    sealed class RegionFrame:Frame
    {
        readonly List<RecoveryCvFrameRegion> Regions;
        public RegionFrame(List<RecoveryCvFrameRegion> regions,int width,int height){Regions=regions;Width=width;Height=height;}
        public override Pixels Read(Rectangle rectangle)
        {
            foreach(var region in Regions)
            {
                if(region.Image.Width!=region.Rectangle.Width||region.Image.Height!=region.Rectangle.Height)
                    throw new InvalidOperationException("roi_staging_dimensions");
                if(region.Rectangle.Contains(rectangle))return new Pixels(region.Image,
                    new Rectangle(rectangle.X-region.Rectangle.X,rectangle.Y-region.Rectangle.Y,rectangle.Width,rectangle.Height));
            }
            throw new InvalidOperationException("roi_staging_missing_region");
        }
    }
    // Origins are client physical pixels. Host must stage these exact regions
    // from the same source frame, preserve origins, and bind frame identity/time.
    public static List<RecoveryCvRegion> DescribeRegions(int width,int height,string folder)
    {
        var result=new List<RecoveryCvRegion>();
        foreach(bool tutorial in new[]{false,true})
        {
            var profile=Load(folder,tutorial);
            foreach(double scale in Scales(profile,width,height))
            {
                Scale(profile,scale,tutorial,width,height); // initialization, outside hot path
                string suffix=scale.ToString("F6",CultureInfo.InvariantCulture);
                if(!tutorial)
                {
                    var rect=SelectionCard(width,height,scale,Rect(Map(Map(profile.Row["reference"])["rect"])));
                    if(Inside(rect,width,height))result.Add(new RecoveryCvRegion{Id="selection-"+suffix,Rectangle=rect});
                }
                else foreach(object row in (object[])profile.Row["regions"])
                {
                    var spec=Map(row);string id=(string)spec["id"];
                    var rect=TutorialRegion(width,height,scale,Rect(Map(spec["rect"])),id);int shift=Math.Max(1,Round(Int(spec,"max_shift_px")*scale));
                    var expanded=new Rectangle(rect.X-shift,rect.Y-shift,rect.Width+2*shift,rect.Height+2*shift);
                    if(Inside(expanded,width,height))result.Add(new RecoveryCvRegion{Id=id+"-"+suffix,Rectangle=expanded});
                }
            }
        }
        return result;
    }
    public static Dictionary<string,object> MatchRegions(List<RecoveryCvFrameRegion> regions,int width,int height,string folder)
    {
        var frame=new RegionFrame(regions,width,height);
        return Obj("selected_character",Selection(frame,folder),"tutorial_interaction",Tutorial(frame,folder));
    }
    public static Dictionary<string,object> Selection(Bitmap image,string folder){return Selection(new WholeFrame(image),folder);}
    public static Dictionary<string,object> Tutorial(Bitmap image,string folder){return Tutorial(new WholeFrame(image),folder);}
    static Dictionary<string,object> Base(Profile profile,Frame image)
    {
        return Obj("verified",false,"source","calibrated_cv","calibration_sha256",profile.CalibrationHash,
            "reference_sha256",profile.ReferenceHash,"layout_width",image.Width,"layout_height",image.Height,
            "reference_layout_width",2560,"reference_layout_height",1440,"anchor_layout","anchored-uniform-ui-v1",
            "template_load_count",TemplateLoads,"hot_path_file_reads",0,"hot_path_getpixel_calls",0);
    }
    static Dictionary<string,object> Selection(Frame image,string folder)
    {
        var unknown=Obj("verified",false,"source","calibrated_cv","reason","calibration_unknown");
        try
        {
            var profile=Load(folder,false);unknown=Base(profile,image);unknown["reason"]="calibration_region_mismatch";
            var reference=Rect(Map(Map(profile.Row["reference"])["rect"]));Dictionary<string,object> winner=null;int matches=0;
            foreach(double scale in Scales(profile,image.Width,image.Height))
            {
                var card=SelectionCard(image.Width,image.Height,scale,reference);if(!Inside(card,image))continue;
                var scaled=Scale(profile,scale,false,image.Width,image.Height);var scores=new List<object>();bool verified=true;
                // Lock the single selected card once, never the full client image.
                var liveCard=image.Read(card);
                foreach(object value in (object[])profile.Row["regions"])
                {
                    var region=Map(value);string id=(string)region["id"];
                    var relative=Subrectangle(Rect(Map(region["rect"])),reference,scale);var template=scaled.Pixels[id];
                    long sum=0,above=0;
                    for(int y=0;y<relative.Height;y++)for(int x=0;x<relative.Width;x++)
                    {
                        int ti=(y*template.Width+x)*4,li=((relative.Y+y)*liveCard.Width+relative.X+x)*4;
                        int b=Math.Abs(liveCard.Data[li]-template.Data[ti]),g=Math.Abs(liveCard.Data[li+1]-template.Data[ti+1]),r=Math.Abs(liveCard.Data[li+2]-template.Data[ti+2]);
                        sum+=r+g+b;if(Math.Max(r,Math.Max(g,b))>24)above++;
                    }
                    double mean=(double)sum/(relative.Width*relative.Height*3),fraction=(double)above/(relative.Width*relative.Height);
                    double maxMean=Number(region,"max_mean_abs_error"),maxFraction=Number(region,"max_fraction_above_24");
                    bool passed=mean<=maxMean&&fraction<=maxFraction;verified&=passed;
                    scores.Add(Obj("region",id,"mean_abs_error",mean,"fraction_above_24",fraction,"max_mean_abs_error",maxMean,
                        "max_fraction_above_24",maxFraction,"matched",passed,"live_rect",Obj("x",card.X+relative.X,"y",card.Y+relative.Y,"width",relative.Width,"height",relative.Height)));
                }
                if(!unknown.ContainsKey("candidate_regions"))unknown["candidate_regions"]=new List<object>();
                ((List<object>)unknown["candidate_regions"]).Add(Obj("ui_scale",scale,"regions",scores));
                if(verified)
                {
                    matches++;winner=Base(profile,image);winner["verified"]=true;winner["reason"]="calibrated_regions_match";
                    winner["regions"]=scores;winner["name"]="小啊";winner["class"]="warrior";winner["faction"]="alliance";winner["ui_scale"]=scale;
                    winner["ui_scale_factor"]=scale*1440/image.Height;
                    var point=Map(profile.Row["safe_focus_point"]);
                    winner["safe_focus_point"]=Obj("x",card.X+Round((Int(point,"x")-reference.X)*scale),
                        "y",card.Y+Round((Int(point,"y")-reference.Y)*scale));
                }
            }
            if(matches==1)return winner;
            if(matches>1)unknown["reason"]="calibration_ambiguous_ui_scale";
            return unknown;
        }
        catch { unknown["verified"]=false;unknown["reason"]="calibration_invalid_or_unsupported";return unknown; }
    }
    static Dictionary<string,object> MaskRegion(Frame image,Profile profile,Scaled scaled,Dictionary<string,object> spec,double scale)
    {
        string id=(string)spec["id"];var rectangle=TutorialRegion(image.Width,image.Height,scale,Rect(Map(spec["rect"])),id);
        int shift=Math.Max(1,Round(Int(spec,"max_shift_px")*scale));
        var expanded=new Rectangle(rectangle.X-shift,rectangle.Y-shift,rectangle.Width+2*shift,rectangle.Height+2*shift);
        if(!Inside(expanded,image))return Obj("region",id,"matched",false,"reason","live_roi_outside_client");
        var live=image.Read(expanded).Mask((string)spec["mask"]);var inkOffsets=scaled.InkOffsets[id];
        int liveWidth=expanded.Width,width=rectangle.Width,height=rectangle.Height,stride=liveWidth+1;
        // Integral ink counts give each shifted ROI's union in O(1); only
        // reference ink pixels are visited for intersection, not every pixel.
        var sums=new int[(liveWidth+1)*(expanded.Height+1)];
        for(int y=0;y<expanded.Height;y++)
        {
            int row=0;for(int x=0;x<liveWidth;x++){if(live[y*liveWidth+x])row++;sums[(y+1)*stride+x+1]=sums[y*stride+x+1]+row;}
        }
        double best=0;int bestX=0,bestY=0;
        for(int dy=-shift;dy<=shift;dy++)for(int dx=-shift;dx<=shift;dx++)
        {
            int x=dx+shift,y=dy+shift,offset=y*liveWidth+x;
            int liveInk=sums[(y+height)*stride+x+width]-sums[y*stride+x+width]-sums[(y+height)*stride+x]+sums[y*stride+x];
            int intersection=0;foreach(int index in inkOffsets)if(live[index+offset])intersection++;
            int union=inkOffsets.Length+liveInk-intersection;
            double score=union>0?(double)intersection/union:0;
            if(score>best){best=score;bestX=dx;bestY=dy;}
        }
        double threshold=Number(spec,"min_iou");
        return Obj("region",id,"matched",best>=threshold,"mask_iou",best,"min_iou",threshold,
            "offset_x",bestX,"offset_y",bestY,"live_rect",Obj("x",rectangle.X,"y",rectangle.Y,"width",width,"height",height));
    }
    static Dictionary<string,object> Tutorial(Frame image,string folder)
    {
        var unknown=Obj("verified",false,"source","calibrated_cv","reason","tutorial_calibration_unknown");
        try
        {
            var profile=Load(folder,true);unknown=Base(profile,image);unknown["reason"]="tutorial_region_mismatch";
            Dictionary<string,object> winner=null;int matches=0;
            foreach(double scale in Scales(profile,image.Width,image.Height))
            {
                var scaled=Scale(profile,scale,true,image.Width,image.Height);var scores=new List<object>();bool verified=true;int dx=0,dy=0;
                foreach(object value in (object[])profile.Row["regions"])
                {
                    var spec=Map(value);var score=MaskRegion(image,profile,scaled,spec,scale);scores.Add(score);verified&=(bool)score["matched"];
                    if((string)spec["id"]=="npc_name"&&score.ContainsKey("offset_x")){dx=Int(score,"offset_x");dy=Int(score,"offset_y");}
                }
                if(verified)
                {
                    matches++;winner=Base(profile,image);winner["verified"]=true;winner["reason"]="tutorial_current_regions_match";
                    winner["regions"]=scores;winner["ui_scale"]=scale;winner["ui_scale_factor"]=scale*1440/image.Height;
                    winner["kind"]="talk_jaina";winner["npc_name"]="吉安娜·普罗德摩尔";
                    var point=Map(profile.Row["action_point"]);var safe=Map(profile.Row["safe_focus_point"]);
                    winner["action_point"]=Obj("x",Round(Int(point,"x")*image.Width/2560.0)+dx,"y",Round(Int(point,"y")*image.Height/1440.0)+dy);
                    winner["safe_focus_point"]=Obj("x",Round(Int(safe,"x")*image.Width/2560.0),"y",Round(Int(safe,"y")*image.Height/1440.0));
                }
            }
            if(matches==1)return winner;if(matches>1)unknown["reason"]="tutorial_ambiguous_ui_scale";return unknown;
        }
        catch { unknown["verified"]=false;unknown["reason"]="tutorial_calibration_invalid_or_unsupported";return unknown; }
    }
}
