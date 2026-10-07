using System;
using System.Collections.Generic;
using System.Drawing;

namespace WowJev.Resident {
    // Pure pixels only. This module never captures windows or sends input.
    public static class TrainingDummyVision {
        public const string Method = "current_neutral_nameplate_v1";
        public const string Algorithm = "current_neutral_nameplate_v1:min_rgb60;fullmask;min100;shift3;radius1;raw_iou0.5;bidirectional_coverage0.95;ratio0.8..1.25;goldbar90,70,85,r-g>=1.4b;body_chroma_tv0.15;luma_variance300;body_search16";
        public sealed class Reference {
            public string Name;
            public int Width, Height;
            public Rectangle NameRect, BodyRect, GoldRect;
            public byte[] NameRgb, BodyRgb;
            public bool[] NameMask;
        }
        public sealed class ScoreResult {
            public bool Matched;
            public double MeanError, FractionAbove24;
            public double RawIou, Coverage, ForegroundRatio, ChromaDistance, SourceVariance, LiveVariance;
        }
        public sealed class Hit {
            public Rectangle NameRect, BodyRect;
            public Point Point;
            public ScoreResult NameScore, BodyScore;
        }
        public static ScoreResult Score(byte[] pixels, int width, int height, Rectangle rect, byte[] reference) {
            Need(pixels != null && (long)pixels.Length == (long)width * height * 4 && width > 0 && height > 0, "dummy_pixels");
            Need(reference != null && reference.Length == 32 * 16 * 3 && Inside(rect,width,height), "dummy_template");
            int over = 0; double sum = 0;
            for(int y=0;y<16;y++)for(int x=0;x<32;x++) {
                int px=rect.X+Math.Min(rect.Width-1,(int)((x+.5)*rect.Width/32));
                int py=rect.Y+Math.Min(rect.Height-1,(int)((y+.5)*rect.Height/16));
                int offset=(py*width+px)*4, index=(y*32+x)*3;
                for(int c=0;c<3;c++){int error=Math.Abs(pixels[offset+2-c]-reference[index+c]);sum+=error;if(error>24)over++;}
            }
            double mean=sum/reference.Length, fraction=(double)over/reference.Length;
            return new ScoreResult{Matched=mean<=8 && fraction<=.05,MeanError=mean,FractionAbove24=fraction};
        }
        public static byte[] Template(byte[] pixels,int width,int height,Rectangle rect) {
            Need(pixels!=null&&(long)pixels.Length==(long)width*height*4&&Inside(rect,width,height),"dummy_reference_pixels");
            var result=new byte[32*16*3];
            for(int y=0;y<16;y++)for(int x=0;x<32;x++) {
                int px=rect.X+Math.Min(rect.Width-1,(int)((x+.5)*rect.Width/32)),py=rect.Y+Math.Min(rect.Height-1,(int)((y+.5)*rect.Height/16));
                int offset=(py*width+px)*4,index=(y*32+x)*3;
                for(int c=0;c<3;c++)result[index+c]=pixels[offset+2-c];
            }return result;
        }
        public static bool[] NameMask(byte[] pixels,int width,int height,Rectangle rect){
            Need(Inside(rect,width,height)&&pixels!=null&&(long)pixels.Length==(long)width*height*4,"dummy_reference_name_mask");
            var mask=new bool[rect.Width*rect.Height];for(int y=0;y<rect.Height;y++)for(int x=0;x<rect.Width;x++){
                int p=((rect.Y+y)*width+rect.X+x)*4;mask[y*rect.Width+x]=pixels[p]>=60&&pixels[p+1]>=60&&pixels[p+2]>=60;
            }return mask;
        }
        static bool[] Dilate(bool[] mask,int width,int height){
            var result=new bool[mask.Length];for(int i=0;i<mask.Length;i++)if(mask[i])for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
                int x=i%width+dx,y=i/width+dy;if(x>=0&&y>=0&&x<width&&y<height)result[y*width+x]=true;
            }return result;
        }
        public static ScoreResult ScoreName(byte[] pixels,int width,int height,Rectangle rect,bool[] reference){
            Need(Inside(rect,width,height)&&reference!=null&&reference.Length==rect.Width*rect.Height,"dummy_name_shape");
            var live=NameMask(pixels,width,height,rect);int sourceCount=0,liveCount=0;
            for(int i=0;i<reference.Length;i++){if(reference[i])sourceCount++;if(live[i])liveCount++;}
            double ratio=sourceCount==0?0:(double)liveCount/sourceCount;
            var result=new ScoreResult{ForegroundRatio=ratio};if(sourceCount<100||liveCount<100||ratio<.8||ratio>1.25)return result;
            var sourceDilated=Dilate(reference,rect.Width,rect.Height);var liveDilated=Dilate(live,rect.Width,rect.Height);
            int intersection=0,sourceCovered=0,liveCovered=0;
            for(int i=0;i<reference.Length;i++){if(reference[i]&&live[i])intersection++;if(reference[i]&&liveDilated[i])sourceCovered++;if(live[i]&&sourceDilated[i])liveCovered++;}
            result.RawIou=(double)intersection/(sourceCount+liveCount-intersection);result.Coverage=Math.Min((double)sourceCovered/sourceCount,(double)liveCovered/liveCount);
            result.Matched=result.RawIou>=.5&&result.Coverage>=.95;return result;
        }
        static double[] Chroma(byte[] rgb,out double variance){
            var hist=new double[512];double sumLuma=0,sumSquared=0;int count=rgb.Length/3;
            for(int i=0;i<rgb.Length;i+=3){int r=rgb[i],g=rgb[i+1],b=rgb[i+2],sum=r+g+b;
                int rr=sum==0?0:Math.Min(7,r*8/sum),gg=sum==0?0:Math.Min(7,g*8/sum),bb=sum==0?0:Math.Min(7,b*8/sum);hist[rr*64+gg*8+bb]++;
                double luma=.299*r+.587*g+.114*b;sumLuma+=luma;sumSquared+=luma*luma;
            }
            for(int i=0;i<hist.Length;i++)hist[i]/=count;variance=sumSquared/count-Math.Pow(sumLuma/count,2);return hist;
        }
        public static ScoreResult ScoreBody(byte[] pixels,int width,int height,Rectangle rect,byte[] reference){
            Need(reference!=null&&reference.Length==1536,"dummy_body_material");double sourceVariance,liveVariance;var source=Chroma(reference,out sourceVariance);var live=Chroma(Template(pixels,width,height,rect),out liveVariance);double distance=0;
            for(int i=0;i<source.Length;i++)distance+=Math.Abs(source[i]-live[i]);distance/=2;
            return new ScoreResult{Matched=sourceVariance>=300&&liveVariance>=300&&distance<=.15,ChromaDistance=distance,SourceVariance=sourceVariance,LiveVariance=liveVariance};
        }
        static ScoreResult ScoreBodyCached(byte[] pixels,int width,int height,Rectangle rect,double[] source,double sourceVariance,double[] histogram){
            Array.Clear(histogram,0,histogram.Length);double sumLuma=0,sumSquared=0;
            for(int y=0;y<16;y++)for(int x=0;x<32;x++){
                int px=rect.X+Math.Min(rect.Width-1,(int)((x+.5)*rect.Width/32)),py=rect.Y+Math.Min(rect.Height-1,(int)((y+.5)*rect.Height/16)),p=(py*width+px)*4;
                int r=pixels[p+2],g=pixels[p+1],b=pixels[p],sum=r+g+b,rr=sum==0?0:Math.Min(7,r*8/sum),gg=sum==0?0:Math.Min(7,g*8/sum),bb=sum==0?0:Math.Min(7,b*8/sum);histogram[rr*64+gg*8+bb]++;
                double luma=.299*r+.587*g+.114*b;sumLuma+=luma;sumSquared+=luma*luma;
            }
            double distance=0;for(int i=0;i<histogram.Length;i++)distance+=Math.Abs(source[i]-histogram[i]/512);distance/=2;
            double variance=sumSquared/512-Math.Pow(sumLuma/512,2);
            return new ScoreResult{Matched=sourceVariance>=300&&variance>=300&&distance<=.15,ChromaDistance=distance,SourceVariance=sourceVariance,LiveVariance=variance};
        }
        public static IList<Hit> Locate(byte[] pixels,int width,int height,Reference reference) {
            List<Rectangle> candidates;return Locate(pixels,width,height,reference,out candidates);
        }
        public static IList<Hit> Locate(byte[] pixels,int width,int height,Reference reference,out List<Rectangle> candidates) {
            Need(reference!=null&&reference.Name=="作战假人"&&reference.Width==width&&reference.Height==height,"dummy_reference_identity");
            Need(width>0&&width<=7680&&height>0&&height<=4320&&pixels!=null&&(long)pixels.Length==(long)width*height*4,"dummy_current_pixels");
            Need(Inside(reference.NameRect,width,height)&&Inside(reference.BodyRect,width,height)&&Inside(reference.GoldRect,width,height)&&reference.NameRect.Width<=180&&reference.NameRect.Height<=48&&reference.BodyRect.Width<=160&&reference.BodyRect.Height<=200,"dummy_reference_geometry");
            Need(reference.NameRgb!=null&&reference.NameRgb.Length==1536&&reference.BodyRgb!=null&&reference.BodyRgb.Length==1536,"dummy_reference_material");
            Need(reference.NameMask!=null&&reference.NameMask.Length==reference.NameRect.Width*reference.NameRect.Height,"dummy_reference_full_name_mask");
            // The upper world viewport excludes fixed quest tracker and action UI.
            // A gold bar alone is never a hit: both name glyph and wooden body
            // must match independently in the current pixels.
            int right=width*82/100,bottom=height*55/100;
            var gold=new bool[right*bottom];
            for(int y=0;y<bottom;y++)for(int x=0;x<right;x++){
                int p=(y*width+x)*4,r=pixels[p+2],g=pixels[p+1],b=pixels[p];
                gold[y*right+x]=r>=90&&g>=70&&b<=85&&r*10>=b*14&&g*10>=b*14;
            }
            var components=new List<Rectangle>();var stack=new Stack<int>();
            for(int i=0;i<gold.Length;i++){
                if(!gold[i])continue;gold[i]=false;stack.Push(i);int left=i%right,top=i/right,far=left,last=top,count=0;
                while(stack.Count>0){int at=stack.Pop(),x=at%right,y=at/right;count++;left=Math.Min(left,x);far=Math.Max(far,x);top=Math.Min(top,y);last=Math.Max(last,y);
                    if(x>0)Push(at-1,gold,stack);if(x+1<right)Push(at+1,gold,stack);if(y>0)Push(at-right,gold,stack);if(y+1<bottom)Push(at+right,gold,stack);
                }
                int cw=far-left+1,ch=last-top+1;
                if(cw>=90&&cw<=350&&ch>=8&&ch<=40&&count>=500&&cw>=reference.GoldRect.Width*.85&&cw<=reference.GoldRect.Width*1.15&&ch>=reference.GoldRect.Height*.8&&ch<=reference.GoldRect.Height*1.2)components.Add(new Rectangle(left,top,cw,ch));
                Need(components.Count<=32,"dummy_component_budget");
            }
            candidates=components;var hits=new List<Hit>();double sourceBodyVariance;var sourceBody=Chroma(reference.BodyRgb,out sourceBodyVariance);var liveHistogram=new double[512];
            foreach(var component in components){
                Hit best=null;double distance=Double.MaxValue;
                int originX=component.X+reference.NameRect.X-reference.GoldRect.X,originY=component.Y+reference.NameRect.Y-reference.GoldRect.Y;
                Rectangle? bestName=null;ScoreResult bestNameScore=null;double bestNameDistance=Double.MaxValue;
                for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++){
                    var name=new Rectangle(originX+dx,originY+dy,reference.NameRect.Width,reference.NameRect.Height);
                    if(!Inside(name,width,height))continue;
                    var nameScore=ScoreName(pixels,width,height,name,reference.NameMask);if(!nameScore.Matched)continue;
                    double quality=(1-nameScore.Coverage)/.05+(1-nameScore.RawIou)/.5;
                    if(quality<bestNameDistance){bestNameDistance=quality;bestName=name;bestNameScore=nameScore;}
                }
                if(bestName.HasValue){var name=bestName.Value;var nameScore=bestNameScore;
                    for(int bodyY=-16;bodyY<=16;bodyY++)for(int bodyX=-16;bodyX<=16;bodyX++){
                        var body=new Rectangle(name.X+reference.BodyRect.X-reference.NameRect.X+bodyX,name.Y+reference.BodyRect.Y-reference.NameRect.Y+bodyY,reference.BodyRect.Width,reference.BodyRect.Height);
                        if(!Inside(body,width,height))continue;
                        var bodyScore=ScoreBodyCached(pixels,width,height,body,sourceBody,sourceBodyVariance,liveHistogram);if(!bodyScore.Matched)continue;
                        double score=bodyScore.ChromaDistance/.15+(1-nameScore.Coverage)/.05+(1-nameScore.RawIou)/.5;
                        if(score<distance){distance=score;best=new Hit{NameRect=name,BodyRect=body,Point=new Point(body.X+body.Width/2,body.Y+body.Height/2),NameScore=nameScore,BodyScore=bodyScore};}
                    }
                }
                if(best!=null)hits.Add(best);
            }
            // Each hit independently names a real visible dummy. The caller may
            // choose a hit for an any-dummy objective; it must never infer GUID.
            hits.Sort((a,b)=>Distance(a.Point,width,height).CompareTo(Distance(b.Point,width,height)));
            return hits.AsReadOnly();
        }
        static long Distance(Point p,int width,int height){long x=p.X-width/2,y=p.Y-height/2;return x*x+y*y;}
        static void Push(int index,bool[] pixels,Stack<int> stack){if(pixels[index]){pixels[index]=false;stack.Push(index);}}
        static bool Inside(Rectangle r,int width,int height){return r.X>=0&&r.Y>=0&&r.Width>0&&r.Height>0&&(long)r.Right<=width&&(long)r.Bottom<=height;}
        static void Need(bool ok,string reason){if(!ok)throw new InvalidOperationException(reason);}
    }
}
