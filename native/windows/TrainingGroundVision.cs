using System;
using System.Collections.Generic;
using System.Drawing;

namespace WowJev.Resident {
    // Scene-limited standing boots/deck evidence. Pure pixels, no input.
    public static class TrainingGroundVision {
        public const string Method="standing_boots_deck_v1";
        public const string Algorithm="standing_boots_deck_v1:bt601-dark35;full-mask;two-top-attached-components;min500;sole-bottom-delta3;raw-iou0.90;fg-ratio0.90:1.10;under-sole-inset-quarter-gap2-height6;wood-r>=g>=b-luma25-fraction0.90;independent-deck-rgb8-fraction0.05";
        public sealed class ScoreResult {public bool Matched;public double RawIou,ForegroundRatio,LeftSupport,RightSupport;public int BottomDelta;public string Reason;}
        static void Need(bool value,string reason){if(!value)throw new InvalidOperationException(reason);}
        public static bool[] Mask(byte[] bgra,int width,int height){
            Need(width>=80&&width<=180&&height>=80&&height<=160&&bgra!=null&&bgra.Length==width*height*4,"ground_pixels_shape");
            var mask=new bool[width*height];for(int i=0;i<mask.Length;i++){int p=i*4;mask[i]=.299*bgra[p+2]+.587*bgra[p+1]+.114*bgra[p]<35;}return mask;
        }
        static List<Rectangle> Boots(bool[] mask,int width,int height){
            var visited=new bool[mask.Length];var found=new List<Rectangle>();var stack=new Stack<int>();
            for(int i=0;i<mask.Length;i++)if(mask[i]&&!visited[i]){
                visited[i]=true;stack.Push(i);int minX=width,minY=height,maxX=0,maxY=0,count=0;
                while(stack.Count>0){int p=stack.Pop(),x=p%width,y=p/width;count++;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);
                    if(x>0)Push(p-1,mask,visited,stack);if(x+1<width)Push(p+1,mask,visited,stack);if(y>0)Push(p-width,mask,visited,stack);if(y+1<height)Push(p+width,mask,visited,stack);
                }
                if(count>=500){var rect=new Rectangle(minX,minY,maxX-minX+1,maxY-minY+1);if(rect.Top>3||rect.Width<20||rect.Width>width*.55||rect.Height<height*.5||rect.Bottom+8>height)return new List<Rectangle>();found.Add(rect);}
            }
            found.Sort((a,b)=>a.X.CompareTo(b.X));if(found.Count!=2||found[1].Left-found[0].Right<width*.12)return new List<Rectangle>();return found;
        }
        static void Push(int p,bool[] mask,bool[] visited,Stack<int> stack){if(mask[p]&&!visited[p]){visited[p]=true;stack.Push(p);}}
        public static void ValidateReference(bool[] mask,int width,int height){Need(mask!=null&&mask.Length==width*height&&width>=80&&width<=180&&height>=80&&height<=160&&Boots(mask,width,height).Count==2,"ground_reference_not_two_supported_boots");}
        static double Support(byte[] pixels,int width,Rectangle boot){
            int left=boot.Left+boot.Width/4,right=boot.Right-boot.Width/4,top=boot.Bottom+2;int good=0,total=(right-left)*6;
            for(int y=top;y<top+6;y++)for(int x=left;x<right;x++){int p=(y*width+x)*4,r=pixels[p+2],g=pixels[p+1],b=pixels[p];if(r>=g&&g>=b&&.299*r+.587*g+.114*b>=25)good++;}return (double)good/total;
        }
        public static ScoreResult Match(byte[] pixels,int width,int height,bool[] reference){
            ValidateReference(reference,width,height);var live=Mask(pixels,width,height);var result=new ScoreResult{Reason="current_boot_contact_not_known"};
            var sourceBoots=Boots(reference,width,height);var currentBoots=Boots(live,width,height);if(currentBoots.Count!=2)return result;
            int intersection=0,sourceCount=0,currentCount=0;for(int i=0;i<live.Length;i++){if(reference[i])sourceCount++;if(live[i])currentCount++;if(reference[i]&&live[i])intersection++;}
            result.RawIou=(double)intersection/(sourceCount+currentCount-intersection);result.ForegroundRatio=(double)currentCount/sourceCount;
            result.BottomDelta=Math.Max(Math.Abs(sourceBoots[0].Bottom-currentBoots[0].Bottom),Math.Abs(sourceBoots[1].Bottom-currentBoots[1].Bottom));
            result.LeftSupport=Support(pixels,width,currentBoots[0]);result.RightSupport=Support(pixels,width,currentBoots[1]);
            result.Matched=result.RawIou>=.90&&result.ForegroundRatio>=.90&&result.ForegroundRatio<=1.10&&result.BottomDelta<=3&&result.LeftSupport>=.90&&result.RightSupport>=.90;
            result.Reason=result.Matched?null:"current_boot_contact_not_known";return result;
        }
    }
}
