// Read-only learned UI matcher. Knowledge may propose no input; Body/hand retain authority.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;

sealed class UiSkillVision
{
    public const string ChromaAlgorithm="chroma_surface_v1:rgb/(r+g+b);bins8x8x8;32x16-nearest;tv0.15;bt601_population_luma_variance300";
    public const string GreenAlgorithm="green_mask_v1:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;shift3;iou0.9";
    public const string GreenTolerantAlgorithm="green_glyph_tolerant_v2:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.65;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25";
    public const string GreenTolerantV3Algorithm="green_glyph_tolerant_v3:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.5;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25";
    sealed class Entry { public string Id,State,Signature,Status,Metric="rgb_exact_v1",Algorithm,NpcName; public int NpcAnchor=-1; public bool HardStop; public Dictionary<string,object> Box,Scope; public byte[] Template,Mask; public int Width,Height,MaskWidth,MaskHeight,ReferenceWidth,ReferenceHeight; public Rectangle? ReferenceRect; public double MaxError,MaxFraction; public List<Entry> Anchors=new List<Entry>(); }
    readonly List<Entry> entries=new List<Entry>();
    public string KnowledgeSha {get;private set;}
    public void Load(string canonical,string sha) {
        ResidentWire.Need(Encoding.UTF8.GetByteCount(canonical)<=60000&&ResidentWire.Hash(Encoding.UTF8.GetBytes(canonical))==sha,"ui_knowledge_sha_changed");
        var body=ResidentWire.Map(ResidentWire.Decode(canonical));ResidentWire.Need(ResidentWire.Text(body,"protocol")=="wow-ui-skill-snapshot"&&ResidentWire.Int(body,"version")==1,"ui_knowledge_protocol");
        bool features=false;if(body.ContainsKey("feature_policy")){var policy=ResidentWire.Map(body["feature_policy"]);ResidentWire.Need(policy.Count==2&&ResidentWire.Text(policy,"command")=="talk"&&ResidentWire.Text(policy,"scope")=="talk_jaina_layered","ui_feature_policy_rejected");features=true;}
        var skills=body["skills"] as object[];ResidentWire.Need(skills!=null&&skills.Length<=24,"ui_signature_capacity");var next=new List<Entry>();
        foreach(object row in skills) {
            var skill=ResidentWire.Map(row);var sig=ResidentWire.Map(skill["signature"]);var review=ResidentWire.Map(sig["review"]);string status=ResidentWire.Text(skill,"status");
            if((status!="active"&&status!="candidate"&&status!="hard_stop")||ResidentWire.Text(review,"status")!="approved")continue;
            var e=new Entry{Id=ResidentWire.Text(skill,"skill_id"),State=ResidentWire.Text(skill,"state_id"),Signature=ResidentWire.Text(sig,"signature_id"),Status=status,HardStop=ResidentWire.Bool(skill,"hard_stop"),Box=ResidentWire.Map(sig["bbox"]),Scope=ResidentWire.Map(skill["scope"]),Width=ResidentWire.Int(sig,"template_width"),Height=ResidentWire.Int(sig,"template_height"),MaxError=ResidentWire.Num(sig,"max_mean_abs_error"),MaxFraction=ResidentWire.Num(sig,"max_fraction_above_24")};
            ResidentWire.Need(e.Width>=1&&e.Width<=64&&e.Height>=1&&e.Height<=32&&e.MaxError>=0&&e.MaxError<=12&&e.MaxFraction>=0&&e.MaxFraction<=.1,"ui_template_bounds");
            e.Template=Convert.FromBase64String(ResidentWire.Text(sig,"rgb_base64"));ResidentWire.Need(e.Template.Length==e.Width*e.Height*3&&ResidentWire.Hash(e.Template)==ResidentWire.Text(sig,"template_sha256"),"ui_template_sha_changed");
            Feature(e,sig,false,features);
            Reference(e,sig);
            RectangleFor(e.Box,2560,1440);
            if(sig.ContainsKey("anchors"))foreach(object rawAnchor in (object[])sig["anchors"]) {
                var a=ResidentWire.Map(rawAnchor);var anchor=new Entry{Id=e.Id+"-anchor-"+e.Anchors.Count,Box=ResidentWire.Map(a["bbox"]),Scope=e.Scope,Width=ResidentWire.Int(a,"template_width"),Height=ResidentWire.Int(a,"template_height"),MaxError=ResidentWire.Num(a,"max_mean_abs_error"),MaxFraction=ResidentWire.Num(a,"max_fraction_above_24")};
                ResidentWire.Need(anchor.Width>=1&&anchor.Width<=64&&anchor.Height>=1&&anchor.Height<=32&&anchor.MaxError>=0&&anchor.MaxError<=12&&anchor.MaxFraction>=0&&anchor.MaxFraction<=.1&&e.Anchors.Count<8,"ui_anchor_bounds");
                anchor.Template=Convert.FromBase64String(ResidentWire.Text(a,"rgb_base64"));ResidentWire.Need(anchor.Template.Length==anchor.Width*anchor.Height*3&&ResidentWire.Hash(anchor.Template)==ResidentWire.Text(a,"template_sha256"),"ui_anchor_sha_changed");Feature(anchor,a,true,features&&e.State=="tutorial_talk_jaina");Reference(anchor,a);RectangleFor(anchor.Box,2560,1440);e.Anchors.Add(anchor);
            }
            if(sig.ContainsKey("npc_locator")){
                var locator=ResidentWire.Map(sig["npc_locator"]);
                ResidentWire.Need(locator.Count==3&&ResidentWire.Text(locator,"method")=="current_nameplate_yellow_outline_v1"&&features&&e.State=="tutorial_talk_jaina"&&e.Metric=="chroma_surface_v1"&&ResidentWire.Text(e.Scope,"target_scope")=="retail_wow","ui_npc_locator_scope_rejected");
                e.NpcName=ResidentWire.Text(locator,"name");e.NpcAnchor=ExactInteger(locator,"anchor_index",0,e.Anchors.Count-1);
                ResidentWire.Need(e.NpcName=="吉安娜·普罗德摩尔"&&e.Anchors[e.NpcAnchor].Metric=="green_glyph_tolerant_v3"&&e.Anchors.Count>=2&&e.Anchors.Any(a=>a.Metric=="rgb_exact_v1")&&e.ReferenceRect.HasValue&&e.Anchors[e.NpcAnchor].ReferenceRect.HasValue,"ui_npc_locator_proofs_missing");
            }
            next.Add(e);
        }
        entries.Clear();entries.AddRange(next);KnowledgeSha=sha;
    }
    public static string AlgorithmSha(string metric){ResidentWire.Need(metric=="chroma_surface_v1"||metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3","ui_feature_metric_unknown");return ResidentWire.Hash(Encoding.UTF8.GetBytes(metric=="green_mask_v1"?GreenAlgorithm:metric=="green_glyph_tolerant_v2"?GreenTolerantAlgorithm:metric=="green_glyph_tolerant_v3"?GreenTolerantV3Algorithm:ChromaAlgorithm));}
    static void Feature(Entry entry,Dictionary<string,object> part,bool anchor,bool enabled){
        if(!part.ContainsKey("metric"))return;string metric=ResidentWire.Text(part,"metric");
        ResidentWire.Need(metric=="rgb_exact_v1"||metric=="chroma_surface_v1"||metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3","ui_feature_metric_unknown");if(metric=="rgb_exact_v1")return;
        ResidentWire.Need(enabled&&ResidentWire.Text(entry.Scope,"target_scope")=="retail_wow"&&(anchor||entry.State=="tutorial_talk_jaina"),"ui_feature_not_reviewed_talk_scope");
        ResidentWire.Need(anchor?(metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3"):metric=="chroma_surface_v1","ui_feature_part_rejected");
        entry.Metric=metric;entry.Algorithm=ResidentWire.Text(part,"algorithm_sha256");ResidentWire.Need(entry.Algorithm==AlgorithmSha(metric),"ui_feature_algorithm_sha_changed");
        if(metric=="chroma_surface_v1"){
            ResidentWire.Need(entry.Width==32&&entry.Height==16,"ui_chroma_reference_dimensions");
            double variance;Chroma(entry.Template,out variance);ResidentWire.Need(variance>=300,"ui_chroma_reference_variance_low");
        }else{
            var mask=ResidentWire.Map(part["mask"]);ResidentWire.Need(mask.Count==5&&ResidentWire.Text(mask,"packing")=="msb0-row-major","ui_green_mask_shape");
            entry.MaskWidth=MaskDimension(mask,"width",1024);entry.MaskHeight=MaskDimension(mask,"height",256);
            string text=ResidentWire.Text(mask,"base64");ResidentWire.Need(text.Length<=43692,"ui_green_mask_data_too_large");entry.Mask=Convert.FromBase64String(text);
            ResidentWire.Need(ResidentWire.Hash(entry.Mask)==ResidentWire.Text(mask,"sha256"),"ui_green_mask_sha_changed");
            ValidateMask(entry.Mask,entry.MaskWidth,entry.MaskHeight);
        }
    }
    static int MaskDimension(Dictionary<string,object> mask,string name,int maximum){
        return ExactInteger(mask,name,1,maximum);
    }
    static int ExactInteger(Dictionary<string,object> fields,string name,int minimum,int maximum){
        object raw=ResidentWire.Field(fields,name);ResidentWire.Need(raw is int||raw is long||raw is double||raw is decimal,"ui_reference_integer_type");
        double number=ResidentWire.Num(fields,name);ResidentWire.Need(number>=minimum&&number<=maximum&&number==Math.Floor(number),"ui_reference_integer_bounds");return(int)number;
    }
    // The immutable Python crop is authoritative. A decimal JSON round-trip
    // can move an exact boundary across floor/ceil by one ULP; do not resize
    // its mask or silently change historical normalized-only crop semantics.
    public static Rectangle ReferenceRectangle(Dictionary<string,object> box,Dictionary<string,object> reference,int width,int height){
        ResidentWire.Need(reference.Count==6,"ui_source_rect_shape");
        int rw=ExactInteger(reference,"client_width",1,16384),rh=ExactInteger(reference,"client_height",1,16384);
        ResidentWire.Need(rw==width&&rh==height,"ui_source_rect_client_changed");
        int x=ExactInteger(reference,"x",0,width-1),y=ExactInteger(reference,"y",0,height-1),w=ExactInteger(reference,"width",1,width),h=ExactInteger(reference,"height",1,height);
        ResidentWire.Need(x+w<=width&&y+h<=height,"ui_source_rect_outside_client");
        RectangleFor(box,width,height);double left=ResidentWire.Num(box,"x")*width,top=ResidentWire.Num(box,"y")*height,right=(ResidentWire.Num(box,"x")+ResidentWire.Num(box,"width"))*width,bottom=(ResidentWire.Num(box,"y")+ResidentWire.Num(box,"height"))*height;const double eps=1e-7;
        ResidentWire.Need(x>=Math.Floor(left-eps)&&x<=Math.Floor(left+eps)&&y>=Math.Floor(top-eps)&&y<=Math.Floor(top+eps)&&x+w>=Math.Ceiling(right-eps)&&x+w<=Math.Ceiling(right+eps)&&y+h>=Math.Ceiling(bottom-eps)&&y+h<=Math.Ceiling(bottom+eps),"ui_source_rect_not_normalized_crop");
        return new Rectangle(x,y,w,h);
    }
    static void Reference(Entry entry,Dictionary<string,object> part){
        if(!part.ContainsKey("source_rect"))return;var reference=ResidentWire.Map(part["source_rect"]);
        int width=ExactInteger(reference,"client_width",1,16384),height=ExactInteger(reference,"client_height",1,16384);
        ResidentWire.Need(ResidentWire.Text(entry.Scope,"size_bucket")==width+"x"+height,"ui_source_rect_scope_changed");
        entry.ReferenceRect=ReferenceRectangle(entry.Box,reference,width,height);entry.ReferenceWidth=width;entry.ReferenceHeight=height;
        if(entry.Mask!=null)ResidentWire.Need(entry.ReferenceRect.Value.Width==entry.MaskWidth&&entry.ReferenceRect.Value.Height==entry.MaskHeight,"ui_source_rect_mask_dimensions");
    }
    static Rectangle RegionRectangle(Entry entry,int width,int height){
        if(!entry.ReferenceRect.HasValue)return RectangleFor(entry.Box,width,height);
        ResidentWire.Need(width==entry.ReferenceWidth&&height==entry.ReferenceHeight,"ui_source_rect_client_changed");return entry.ReferenceRect.Value;
    }
    static int[] ValidateMask(byte[] mask,int width,int height){
        ResidentWire.Need(width>=1&&width<=1024&&height>=1&&height<=256&&mask!=null,"ui_green_mask_dimensions");int n=width*height;
        ResidentWire.Need(mask.Length==(n+7)/8,"ui_green_mask_length");int remainder=n%8;
        ResidentWire.Need(remainder==0||(mask[mask.Length-1]&((1<<(8-remainder))-1))==0,"ui_green_mask_padding");
        var points=new List<int>();for(int i=0;i<n;i++)if((mask[i/8]&(1<<(7-i%8)))!=0)points.Add(i);
        ResidentWire.Need(points.Count>=100,"ui_green_mask_foreground_low");return points.ToArray();
    }
    static byte[] CellRgb(byte[] bgra,int width,int height){
        ResidentWire.Need(width>=1&&width<=1024&&height>=1&&height<=1024&&(long)width*height<=262144&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_feature_pixels_shape");
        var rgb=new byte[32*16*3];for(int y=0;y<16;y++)for(int x=0;x<32;x++){
            int px=Math.Min(width-1,(int)((x+.5)*width/32)),py=Math.Min(height-1,(int)((y+.5)*height/16));int p=(py*width+px)*4,t=(y*32+x)*3;
            rgb[t]=bgra[p+2];rgb[t+1]=bgra[p+1];rgb[t+2]=bgra[p];
        }return rgb;
    }
    static double[] Chroma(byte[] rgb,out double variance){
        ResidentWire.Need(rgb!=null&&rgb.Length==32*16*3,"ui_chroma_reference_dimensions");var hist=new double[512];double sumLuma=0,sumSquares=0;
        for(int i=0;i<rgb.Length;i+=3){int r=rgb[i],g=rgb[i+1],b=rgb[i+2],sum=r+g+b;
            int rb=sum==0?0:Math.Min(7,r*8/sum),gb=sum==0?0:Math.Min(7,g*8/sum),bb=sum==0?0:Math.Min(7,b*8/sum);hist[rb*64+gb*8+bb]++;
            double luma=.299*r+.587*g+.114*b;sumLuma+=luma;sumSquares+=luma*luma;
        }
        for(int i=0;i<hist.Length;i++)hist[i]/=512;double mean=sumLuma/512;variance=Math.Max(0,sumSquares/512-mean*mean);return hist;
    }
    public static Dictionary<string,object> ScoreChroma(byte[] bgra,int width,int height,byte[] rgb){
        double sourceVariance,liveVariance;var source=Chroma(rgb,out sourceVariance);var live=Chroma(CellRgb(bgra,width,height),out liveVariance);double distance=0;
        for(int i=0;i<source.Length;i++)distance+=Math.Abs(source[i]-live[i]);distance*=.5;
        return ResidentWire.Obj("metric","chroma_surface_v1","algorithm_sha256",AlgorithmSha("chroma_surface_v1"),"matched",distance<=.15&&sourceVariance>=300&&liveVariance>=300,"tv_distance",distance,"max_tv_distance",.15,"source_luma_variance",sourceVariance,"live_luma_variance",liveVariance,"min_luma_variance",300);
    }
    public static Dictionary<string,object> ScoreGreenMask(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        int[] points=ValidateMask(reference,referenceWidth,referenceHeight);
        ResidentWire.Need(width==referenceWidth&&height==referenceHeight&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_green_live_dimensions_actual"+width+"x"+height+"_ref"+referenceWidth+"x"+referenceHeight);
        var live=new bool[width*height];int count=0;for(int i=0;i<live.Length;i++){int p=i*4,r=bgra[p+2],g=bgra[p+1],b=bgra[p];bool green=g>=60&&g*10>r*13&&g*10>b*13;live[i]=green;if(green)count++;}
        double best=0;int bestX=0,bestY=0;
        if(count>=100)for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++){
            int intersection=0;foreach(int p in points){int x=p%width+dx,y=p/width+dy;if(x>=0&&y>=0&&x<width&&y<height&&live[y*width+x])intersection++;}
            double iou=(double)intersection/(points.Length+count-intersection);if(iou>best){best=iou;bestX=dx;bestY=dy;}
        }
        return ResidentWire.Obj("metric","green_mask_v1","algorithm_sha256",AlgorithmSha("green_mask_v1"),"matched",count>=100&&best>=.9,"mask_iou",best,"min_iou",.9,"source_foreground",points.Length,"live_foreground",count,"min_foreground",100,"shift_x",bestX,"shift_y",bestY,"max_shift",3);
    }
    static bool[] DilateGlyph(bool[] mask,int width,int height){
        var dilated=new bool[mask.Length];for(int p=0;p<mask.Length;p++)if(mask[p]){
            int x=p%width,y=p/width;for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
                int nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height)dilated[ny*width+nx]=true;
            }
        }return dilated;
    }
    public static Dictionary<string,object> ScoreGreenGlyphTolerant(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        return ScoreGreenGlyph(bgra,width,height,reference,referenceWidth,referenceHeight,.65,"green_glyph_tolerant_v2");
    }
    public static Dictionary<string,object> ScoreGreenGlyphTolerantV3(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        return ScoreGreenGlyph(bgra,width,height,reference,referenceWidth,referenceHeight,.5,"green_glyph_tolerant_v3");
    }
    static Dictionary<string,object> ScoreGreenGlyph(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight,double minRaw,string metric){
        int[] points=ValidateMask(reference,referenceWidth,referenceHeight);
        ResidentWire.Need(width==referenceWidth&&height==referenceHeight&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_green_live_dimensions_actual"+width+"x"+height+"_ref"+referenceWidth+"x"+referenceHeight);
        var source=new bool[width*height];foreach(int p in points)source[p]=true;
        var live=new bool[source.Length];var livePoints=new List<int>();for(int i=0;i<live.Length;i++){
            int p=i*4,r=bgra[p+2],g=bgra[p+1],b=bgra[p];live[i]=g>=60&&g*10>r*13&&g*10>b*13;if(live[i])livePoints.Add(i);
        }
        double ratio=(double)livePoints.Count/points.Length;bool eligible=livePoints.Count>=100&&ratio>=.8&&ratio<=1.25,matched=false;
        double bestCoverage=-1,bestIou=0,bestSourceCoverage=0,bestLiveCoverage=0;int bestX=0,bestY=0;
        if(eligible){
            var sourceDilated=DilateGlyph(source,width,height);var liveDilated=DilateGlyph(live,width,height);
            for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++){
                int intersection=0,sourceCovered=0,liveCovered=0;
                foreach(int p in points){int x=p%width+dx,y=p/width+dy;if(x>=0&&y>=0&&x<width&&y<height){int q=y*width+x;if(live[q])intersection++;if(liveDilated[q])sourceCovered++;}}
                foreach(int p in livePoints){int x=p%width-dx,y=p/width-dy;if(x>=0&&y>=0&&x<width&&y<height&&sourceDilated[y*width+x])liveCovered++;}
                // Counts use the full original masks. Clipping at a shifted
                // ROI boundary never reduces the denominators or grants coverage.
                double iou=(double)intersection/(points.Length+livePoints.Count-intersection),sourceCoverage=(double)sourceCovered/points.Length,liveCoverage=(double)liveCovered/livePoints.Count,coverage=Math.Min(sourceCoverage,liveCoverage);
                bool passed=iou>=minRaw&&coverage>=.95;
                if(passed&&!matched||passed==matched&&(coverage>bestCoverage||coverage==bestCoverage&&iou>bestIou)){
                    matched=passed;bestCoverage=coverage;bestIou=iou;bestSourceCoverage=sourceCoverage;bestLiveCoverage=liveCoverage;bestX=dx;bestY=dy;
                }
            }
        }
        return ResidentWire.Obj("metric",metric,"algorithm_sha256",AlgorithmSha(metric),"matched",matched,"raw_iou",bestIou,"min_raw_iou",minRaw,"source_coverage",bestSourceCoverage,"live_coverage",bestLiveCoverage,"bidirectional_coverage",Math.Max(0,bestCoverage),"min_bidirectional_coverage",.95,"foreground_ratio",ratio,"min_foreground_ratio",.8,"max_foreground_ratio",1.25,"source_foreground",points.Length,"live_foreground",livePoints.Count,"min_foreground",100,"dilation_radius",1,"shift_x",bestX,"shift_y",bestY,"max_shift",3);
    }
    static Dictionary<string,object> EntryScore(Entry entry,WgcCapture.Roi roi){
        if(entry.Metric=="chroma_surface_v1")return ScoreChroma(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Template);
        if(entry.Metric=="green_mask_v1")return ScoreGreenMask(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        if(entry.Metric=="green_glyph_tolerant_v2")return ScoreGreenGlyphTolerant(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        if(entry.Metric=="green_glyph_tolerant_v3")return ScoreGreenGlyphTolerantV3(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        return Score(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Template,entry.Width,entry.Height,entry.MaxError,entry.MaxFraction);
    }
    static byte[] CropPixels(byte[] pixels,int width,int height,Rectangle rect){
        ResidentWire.Need(rect.Left>=0&&rect.Top>=0&&rect.Width>0&&rect.Height>0&&rect.Right<=width&&rect.Bottom<=height,"npc_current_crop_bounds");
        var crop=new byte[rect.Width*rect.Height*4];for(int y=0;y<rect.Height;y++)Buffer.BlockCopy(pixels,((rect.Y+y)*width+rect.X)*4,crop,y*rect.Width*4,rect.Width*4);return crop;
    }
    /** Locates the reference glyph in the CURRENT pixels, then derives a body
     * interior from its yellow contour. No reference click point is accepted. */
    public static Dictionary<string,object> LocateNpc(byte[] pixels,int width,int height,byte[] nameMask,int maskWidth,int maskHeight,string name){
        ResidentWire.Need(width>=1&&width<=7680&&height>=1&&height<=4320&&pixels!=null&&(long)pixels.Length==(long)width*height*4,"npc_current_pixels_shape");
        ResidentWire.Need(!String.IsNullOrWhiteSpace(name)&&name.Length<=200,"npc_current_name_missing");
        int[] reference=ValidateMask(nameMask,maskWidth,maskHeight);int minX=maskWidth,minY=maskHeight,maxX=0,maxY=0;
        foreach(int p in reference){int x=p%maskWidth,y=p/maskWidth;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);}
        var rowCounts=new int[height];var green=new bool[width*height];for(int p=0;p<green.Length;p++){int b=p*4,r=pixels[b+2],g=pixels[b+1],bl=pixels[b];if(g>=60&&g*10>r*13&&g*10>bl*13){green[p]=true;rowCounts[p/width]++;}}
        var refColumns=new bool[maskWidth];foreach(int p in reference)refColumns[p%maskWidth]=true;int maxColumnGap=0,columnGap=0;for(int x=minX;x<=maxX;x++){if(refColumns[x]){maxColumnGap=Math.Max(maxColumnGap,columnGap);columnGap=0;}else columnGap++;}
        int joinGap=Math.Min(64,Math.Max(10,maxColumnGap+4));
        var found=new List<Dictionary<string,object>>();var rects=new List<Rectangle>();var attempts=new List<object>();int rowThreshold=Math.Max(4,reference.Length/Math.Max(1,maxY-minY+1)/5);
        var referenceRows=new int[maskHeight];foreach(int p in reference)referenceRows[p/maskWidth]++;
        // Both origins use the same significant-row rule. A few green sea
        // pixels above the lettering must not become the template origin.
        int referenceTextTop=0;while(referenceTextTop<maskHeight&&referenceRows[referenceTextTop]<rowThreshold)referenceTextTop++;
        ResidentWire.Need(referenceTextTop<maskHeight,"npc_reference_glyph_rows_missing");
        for(int top=0;top<height;top++){
            if(rowCounts[top]<rowThreshold)continue;int bottom=top,last=top,gap=0;
            while(bottom+1<height&&gap<3){bottom++;if(rowCounts[bottom]>=rowThreshold){last=bottom;gap=0;}else gap++;}
            bottom=last;if(bottom-top+1>maskHeight+6){top=bottom;continue;}
            var columns=new int[width];for(int y=top;y<=bottom;y++)for(int x=0;x<width;x++)if(green[y*width+x])columns[x]++;
            for(int left=0;left<width;left++){
                if(columns[left]==0)continue;int right=left,end=left,cgap=0,count=0;
                while(right+1<width&&cgap<joinGap){right++;if(columns[right]>0){end=right;cgap=0;}else cgap++;}
                right=end;for(int x=left;x<=right;x++)count+=columns[x];int span=right-left+1,refSpan=maxX-minX+1;
                if(count>=100&&span>=refSpan*.85&&span<=refSpan*1.15){
                    var canvas=new Rectangle(left-minX,top-referenceTextTop,maskWidth,maskHeight);
                    if(canvas.Left>=0&&canvas.Top>=0&&canvas.Right<=width&&canvas.Bottom<=height){
                        var score=ScoreGreenGlyphTolerantV3(CropPixels(pixels,width,height,canvas),maskWidth,maskHeight,nameMask,maskWidth,maskHeight);
                        if(attempts.Count<16)attempts.Add(ResidentWire.Obj("rect",Rect(canvas),"score",score));
                        if(ResidentWire.Bool(score,"matched")){rects.Add(canvas);found.Add(score);}
                    }
                }left=right;
            }top=bottom;
        }
        if(found.Count!=1)return ResidentWire.Obj("status","unknown","reason",found.Count==0?"current_nameplate_not_found":"current_nameplate_ambiguous","candidates",found.Count,"proposals",attempts,"method","current_nameplate_yellow_outline_v1");
        Rectangle plate=rects[0];var body=YellowBody(pixels,width,height,plate);
        if(body==null)return ResidentWire.Obj("status","unknown","reason","current_yellow_body_not_unique_or_enclosed","nameplate_rect",Rect(plate),"name_score",found[0],"method","current_nameplate_yellow_outline_v1");
        body["status"]="known";body["name"]=name;body["nameplate_rect"]=Rect(plate);body["name_score"]=found[0];body["method"]="current_nameplate_yellow_outline_v1";return body;
    }
    static Dictionary<string,object> Rect(Rectangle rect){return ResidentWire.Obj("x",rect.X,"y",rect.Y,"width",rect.Width,"height",rect.Height);}
    static Dictionary<string,object> YellowBody(byte[] pixels,int width,int height,Rectangle plate){
        int left=Math.Max(0,plate.Left-plate.Width/2),right=Math.Min(width,plate.Right+plate.Width/2),top=plate.Bottom,bottom=Math.Min(height,plate.Bottom+plate.Height*14);
        if(bottom<=top)return null;int w=right-left,h=bottom-top;var yellow=new bool[w*h];
        for(int y=0;y<h;y++)for(int x=0;x<w;x++){int p=((top+y)*width+left+x)*4,r=pixels[p+2],g=pixels[p+1],b=pixels[p];yellow[y*w+x]=r>=180&&g>=160&&b<=100&&r*2>b*3&&g*2>b*3;}
        var connected=DilateGlyph(yellow,w,h);var visited=new bool[connected.Length];var candidates=new List<Rectangle>();
        for(int p=0;p<connected.Length;p++)if(connected[p]&&!visited[p]){
            var queue=new Queue<int>();queue.Enqueue(p);visited[p]=true;int minX=w,minY=h,maxX=0,maxY=0,count=0;
            while(queue.Count>0){int at=queue.Dequeue(),x=at%w,y=at/w;count++;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);
                for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<w&&ny<h){int q=ny*w+nx;if(connected[q]&&!visited[q]){visited[q]=true;queue.Enqueue(q);}}}
            }
            var rect=new Rectangle(left+minX,top+minY,maxX-minX+1,maxY-minY+1);
            if(count>=100&&rect.Width>=plate.Width*.15&&rect.Width<=plate.Width*1.2&&rect.Height>=plate.Height*3&&rect.Bottom>=plate.Bottom+plate.Height*5)candidates.Add(rect);
        }
        // The two outline sides need not be pixel-connected: clothing and
        // weapon contours can be separated by the body interior. Merge only
        // components whose body-height bands substantially overlap and whose
        // horizontal bounds overlap or nearly touch under this nameplate.
        for(int i=0;i<candidates.Count;i++)for(int j=i+1;j<candidates.Count;j++){
            Rectangle a=candidates[i],b=candidates[j];int overlap=Math.Min(a.Bottom,b.Bottom)-Math.Max(a.Top,b.Top);
            int separation=Math.Max(0,Math.Max(a.Left,b.Left)-Math.Min(a.Right,b.Right));
            Rectangle union=Rectangle.Union(a,b);
            if(overlap>=Math.Min(a.Height,b.Height)*.7&&separation<=plate.Width*.15&&union.Width<=plate.Width*1.2){candidates[i]=union;candidates.RemoveAt(j);j=i;}
        }
        if(candidates.Count!=1)return null;Rectangle bounds=candidates[0];int desired=bounds.Top+35*bounds.Height/100;
        for(int offset=0;offset<=bounds.Height/12;offset++)for(int direction=0;direction<(offset==0?1:2);direction++){
            int y=desired+(direction==0?offset:-offset);if(y<top+3||y>=bottom-3)continue;int x0=width,x1=-1;
            for(int x=bounds.Left;x<bounds.Right;x++)if(yellow[(y-top)*w+x-left]){x0=Math.Min(x0,x);x1=Math.Max(x1,x);}
            int span=x1-x0;if(span<plate.Width*.15||span>plate.Width*.7)continue;int px=(x0+x1)/2;bool interior=true;
            for(int dy=-2;dy<=2;dy++)for(int dx=-2;dx<=2;dx++)if(yellow[(y+dy-top)*w+px+dx-left])interior=false;
            if(interior)return ResidentWire.Obj("body_point",ResidentWire.Obj("x",px,"y",y),"body_rect",Rect(bounds),"interior_span",span,"point_semantics","detected_body_interior");
        }return null;
    }
    public static Rectangle RectangleFor(Dictionary<string,object> box,int width,int height) {
        double x=ResidentWire.Num(box,"x"),y=ResidentWire.Num(box,"y"),w=ResidentWire.Num(box,"width"),h=ResidentWire.Num(box,"height");
        ResidentWire.Need(x>=0&&y>=0&&w>0&&h>0&&x+w<=1&&y+h<=1,"ui_normalized_bbox_invalid");
        int left=(int)Math.Floor(x*width),top=(int)Math.Floor(y*height),right=(int)Math.Ceiling((x+w)*width),bottom=(int)Math.Ceiling((y+h)*height);
        ResidentWire.Need(right>left&&bottom>top&&right<=width&&bottom<=height,"ui_roi_invalid");return new Rectangle(left,top,right-left,bottom-top);
    }
    public List<RecoveryCvRegion> Regions(int width,int height,Dictionary<string,object> scope) {
        var result=new List<RecoveryCvRegion>();foreach(var e in entries)if(ResidentWire.Same(e.Scope,scope)){
            if(e.NpcAnchor>=0){
                // One current in-memory ROI supplies both glyph search and
                // yellow contour. Never stage the old reference click patch.
                if(!result.Any(r=>r.Id=="learned-ui-npc-current-view"))result.Add(new RecoveryCvRegion{Id="learned-ui-npc-current-view",Rectangle=new Rectangle(0,0,width,height)});
                for(int a=0;a<e.Anchors.Count;a++)if(a!=e.NpcAnchor)result.Add(new RecoveryCvRegion{Id="learned-ui-"+e.Anchors[a].Id,Rectangle=RegionRectangle(e.Anchors[a],width,height)});
                continue;
            }
            result.Add(new RecoveryCvRegion{Id="learned-ui-"+e.Id,Rectangle=RegionRectangle(e,width,height)});
            foreach(var a in e.Anchors)result.Add(new RecoveryCvRegion{Id="learned-ui-"+a.Id,Rectangle=RegionRectangle(a,width,height)});
        }return result;
    }
    public static Dictionary<string,object> Score(byte[] bgra,int width,int height,byte[] rgb,int tw,int th,double maxError,double maxFraction) {
        ResidentWire.Need(bgra.Length==width*height*4&&rgb.Length==tw*th*3,"ui_pixels_shape");double sum=0;int over=0,n=rgb.Length;
        for(int y=0;y<th;y++)for(int x=0;x<tw;x++) {
            int px=Math.Min(width-1,(int)((x+.5)*width/tw)),py=Math.Min(height-1,(int)((y+.5)*height/th));int offset=(py*width+px)*4,t=(y*tw+x)*3;
            for(int c=0;c<3;c++){int error=Math.Abs(bgra[offset+2-c]-rgb[t+c]);sum+=error;if(error>24)over++;}
        }
        double mean=sum/n,fraction=(double)over/n;return ResidentWire.Obj("matched",mean<=maxError&&fraction<=maxFraction,"mean_abs_error",mean,"fraction_above_24",fraction);
    }
    public Dictionary<string,object> Match(IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> scope,Dictionary<string,object> frame=null) {
        double started=WowJev.Input.Clock.PreciseMs;var matches=new List<object>();
        foreach(var e in entries) {
            if(e.NpcAnchor>=0&&ResidentWire.Same(e.Scope,scope)){
                var current=DynamicMatch(e,rois,regions,frame);if(current!=null)matches.Add(current);continue;
            }
            if(!ResidentWire.Same(e.Scope,scope))continue;int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+e.Id){index=i;break;}if(index<0)continue;
            var roi=rois[index];var score=EntryScore(e,roi);
            var anchorScores=new List<object>();bool anchorsMatched=true;
            foreach(var a in e.Anchors) {
                int ai=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+a.Id){ai=i;break;}
                if(ai<0){anchorsMatched=false;continue;}var ar=rois[ai];var scored=EntryScore(a,ar);anchorsMatched&=ResidentWire.Bool(scored,"matched");scored["roi_sha256"]=ar.Hash;anchorScores.Add(scored);
            }
            score["anchors"]=anchorScores;
            if(anchorsMatched&&ResidentWire.Bool(score,"matched"))matches.Add(ResidentWire.Obj("skill_id",e.Id,"state_id",e.State,"signature_id",e.Signature,"status",e.Status,"hard_stop",e.HardStop,"roi_sha256",roi.Hash,"scores",score));
        }
        var states=matches.Select(row=>ResidentWire.Text(ResidentWire.Map(row),"state_id")).Distinct().ToArray();bool known=states.Length==1;
        return ResidentWire.Obj("status",known?"known":"unknown","state_id",known?(object)states[0]:null,"confidence",known?(object).95:0,"matches",matches,"knowledge_sha256",KnowledgeSha,"hard_stop",matches.Any(row=>ResidentWire.Bool(ResidentWire.Map(row),"hard_stop")),"started_qpc_ms",started,"finished_qpc_ms",WowJev.Input.Clock.PreciseMs);
    }
    Dictionary<string,object> DynamicMatch(Entry entry,IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> frame){
        if(frame==null)return null;int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-npc-current-view"){index=i;break;}if(index<0)return null;
        var view=rois[index];int width=ResidentWire.Int(frame,"client_width"),height=ResidentWire.Int(frame,"client_height");ResidentWire.Need(view.Rectangle==new Rectangle(0,0,width,height),"ui_npc_current_view_partial");
        var anchor=entry.Anchors[entry.NpcAnchor];var located=LocateNpc(view.Pixels,width,height,anchor.Mask,anchor.MaskWidth,anchor.MaskHeight,entry.NpcName);if(ResidentWire.Text(located,"status")!="known")return null;
        var plate=ResidentWire.Map(located["nameplate_rect"]);Rectangle referencePlate=RegionRectangle(anchor,width,height),referenceBody=RegionRectangle(entry,width,height);
        int dx=ResidentWire.Int(plate,"x")-referencePlate.X,dy=ResidentWire.Int(plate,"y")-referencePlate.Y;var bodyCrop=new Rectangle(referenceBody.X+dx,referenceBody.Y+dy,referenceBody.Width,referenceBody.Height);
        if(bodyCrop.Left<0||bodyCrop.Top<0||bodyCrop.Right>width||bodyCrop.Bottom>height)return null;
        var crop=CropPixels(view.Pixels,width,height,bodyCrop);var score=ScoreChroma(crop,bodyCrop.Width,bodyCrop.Height,entry.Template);if(!ResidentWire.Bool(score,"matched"))return null;
        var scores=new List<object>();for(int a=0;a<entry.Anchors.Count;a++){
            if(a==entry.NpcAnchor){var glyph=ResidentWire.Map(located["name_score"]);glyph["roi_sha256"]=view.Hash;glyph["current_rect"]=plate;scores.Add(glyph);continue;}
            int ai=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+entry.Anchors[a].Id){ai=i;break;}if(ai<0)return null;
            var ar=rois[ai];var result=EntryScore(entry.Anchors[a],ar);if(!ResidentWire.Bool(result,"matched"))return null;result["roi_sha256"]=ar.Hash;scores.Add(result);
        }
        score["anchors"]=scores;score["current_body_crop"]=Rect(bodyCrop);score["current_body_crop_sha256"]=ResidentWire.Hash(crop);
        var location=ResidentWire.Obj("method","current_nameplate_yellow_outline_v1","name",entry.NpcName,"frame_id",frame["frame_id"],"source_qpc_ms",frame["source_qpc_ms"],"layout_id",frame["layout_id"],"roi_id","learned-ui-npc-current-view","roi_sha256",view.Hash,"calibration_sha256",KnowledgeSha,"nameplate_rect",plate,"score",located["name_score"],"point_semantics","detected_body_interior");
        return ResidentWire.Obj("skill_id",entry.Id,"state_id",entry.State,"signature_id",entry.Signature,"status",entry.Status,"hard_stop",entry.HardStop,"roi_sha256",view.Hash,"scores",score,"current_point",located["body_point"],"current_rect",located["body_rect"],"location",location);
    }
}
