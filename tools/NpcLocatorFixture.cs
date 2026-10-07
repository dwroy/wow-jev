// Pure production-math harness: reads saved PNGs; no window, desktop or input API.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.IO;
namespace WowJev.Input { static class Clock { public static double PreciseMs {get{return (double)Stopwatch.GetTimestamp()*1000/Stopwatch.Frequency;}} } }
sealed class RecoveryCvRegion { public string Id; public Rectangle Rectangle; }
static class WgcCapture { public sealed class Roi { public byte[] Pixels; public Rectangle Rectangle; public string Hash; } }
static class ResidentWire {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 public static void Need(bool v,string reason){if(!v)throw new InvalidOperationException(reason);}
 public static Dictionary<string,object> Obj(params object[] args){var d=new Dictionary<string,object>();for(int i=0;i<args.Length;i+=2)d.Add((string)args[i],args[i+1]);return d;}
 public static Dictionary<string,object> Map(object x){var d=x as Dictionary<string,object>;Need(d!=null,"object_required");return d;}
 public static object Field(Dictionary<string,object>d,string k){return d[k];}public static string Text(Dictionary<string,object>d,string k){return(string)d[k];}public static int Int(Dictionary<string,object>d,string k){return(int)Num(d,k);}public static double Num(Dictionary<string,object>d,string k){return Convert.ToDouble(d[k]);}public static bool Bool(Dictionary<string,object>d,string k){return(bool)d[k];}
 public static string Hash(byte[] bytes){using(var s=SHA256.Create())return BitConverter.ToString(s.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
 public static object Decode(string text){return Json.DeserializeObject(text);}public static bool Same(object a,object b){return Json.Serialize(a)==Json.Serialize(b);}public static string Encode(object x){return Json.Serialize(x);}
}
static class NpcLocatorFixture {
 static byte[] Crop(byte[] src,int width,Rectangle rect){var dest=new byte[rect.Width*rect.Height*4];for(int y=0;y<rect.Height;y++)Buffer.BlockCopy(src,((y+rect.Y)*width+rect.X)*4,dest,y*rect.Width*4,rect.Width*4);return dest;}
 static byte[] Shift(byte[] src,int width,int height,int dx,int dy){var dest=new byte[src.Length];for(int y=0;y<height;y++)for(int x=0;x<width;x++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)Buffer.BlockCopy(src,(y*width+x)*4,dest,((y+dy)*width+x+dx)*4,4);return dest;}
 static void Case(List<object> results,string name,byte[] frame,int width,int height,byte[] mask,int mw,int mh,bool expected){var r=UiSkillVision.LocateNpc(frame,width,height,mask,mw,mh,"吉安娜·普罗德摩尔");bool actual=(string)r["status"]=="known";results.Add(ResidentWire.Obj("case",name,"expected_known",expected,"pass",actual==expected,"result",r));ResidentWire.Need(actual==expected,"locator_case_failed:"+name);}
 static void Checks(byte[] source,byte[] live,int width,int height,byte[] mask,int mw,int mh){var results=new List<object>();
  Case(results,"source_positive",source,width,height,mask,mw,mh,true);Case(results,"independent_current_positive",live,width,height,mask,mw,mh,true);
  var shifted=Shift(live,width,height,120,70);Case(results,"translated_name_and_body",shifted,width,height,mask,mw,mh,true);
  var noYellow=(byte[])live.Clone();var noGreen=(byte[])live.Clone();for(int p=0;p<live.Length;p+=4){int r=live[p+2],g=live[p+1],b=live[p];if(r>=180&&g>=160&&b<=100&&r*2>b*3&&g*2>b*3)noYellow[p]=noYellow[p+1]=noYellow[p+2]=100;if(g>=60&&g*10>r*13&&g*10>b*13)noGreen[p]=noGreen[p+1]=noGreen[p+2]=100;}
  Case(results,"name_without_yellow_body",noYellow,width,height,mask,mw,mh,false);Case(results,"body_without_name",noGreen,width,height,mask,mw,mh,false);
  var modal=(byte[])live.Clone();for(int y=350;y<1000;y++)for(int x=1650;x<2150;x++){int p=(y*width+x)*4;modal[p]=modal[p+1]=modal[p+2]=90;modal[p+3]=255;}Case(results,"opaque_modal_over_target",modal,width,height,mask,mw,mh,false);
  var duplicate=(byte[])live.Clone();for(int y=350;y<1000;y++)for(int x=1650;x<2150;x++)Buffer.BlockCopy(live,(y*width+x)*4,duplicate,((y-50)*width+x-1200)*4,4);Case(results,"two_current_nameplates",duplicate,width,height,mask,mw,mh,false);
  var wrongMask=new byte[mask.Length];for(int y=0;y<mh;y++)for(int x=0;x<mw;x++)if((mask[(y*mw+x)/8]&(1<<(7-(y*mw+x)%8)))!=0){int q=y*mw+mw-1-x;wrongMask[q/8]|=(byte)(1<<(7-q%8));}Case(results,"wrong_glyph",live,width,height,wrongMask,mw,mh,false);
  Console.WriteLine(ResidentWire.Encode(ResidentWire.Obj("protocol","wow-npc-locator-offline-fixture","version",1,"desktop_access",false,"input_events",0,"cases",results,"passed",results.Count)));
 }
 static byte[] Read(string path,out int width,out int height){using(var image=new Bitmap(path)){
  width=image.Width;height=image.Height;var d=image.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{var bytes=new byte[width*height*4];for(int y=0;y<height;y++)Marshal.Copy(IntPtr.Add(d.Scan0,y*d.Stride),bytes,y*width*4,width*4);return bytes;}finally{image.UnlockBits(d);}
 }}
 static int Main(string[] args){try{Console.OutputEncoding=new UTF8Encoding(false);Console.InputEncoding=new UTF8Encoding(false);
  if(args[0]=="--match"){string text=File.ReadAllText(args[1]);var snapshot=ResidentWire.Map(ResidentWire.Decode(text));var skills=(object[])snapshot["skills"];var scope=ResidentWire.Map(ResidentWire.Map(skills[0])["scope"]);var vision=new UiSkillVision();vision.Load(text,ResidentWire.Hash(Encoding.UTF8.GetBytes(text)));int iw,ih;var pixels=Read(args[2],out iw,out ih);var frame=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(args[3])));var regions=vision.Regions(iw,ih,scope);var rois=new List<WgcCapture.Roi>();foreach(var region in regions){var p=Crop(pixels,iw,region.Rectangle);rois.Add(new WgcCapture.Roi{Pixels=p,Rectangle=region.Rectangle,Hash=ResidentWire.Hash(p)});}var matched=vision.Match(rois,regions,scope,frame);Console.WriteLine(ResidentWire.Encode(matched));return(string)matched["status"]=="known"?0:2;}
  int sw,sh;var source=Read(args[0],out sw,out sh);int x=Int32.Parse(args[2]),y=Int32.Parse(args[3]),w=Int32.Parse(args[4]),h=Int32.Parse(args[5]);var mask=new byte[(w*h+7)/8];int foreground=0;for(int iy=0;iy<h;iy++)for(int ix=0;ix<w;ix++){int p=((y+iy)*sw+x+ix)*4,r=source[p+2],g=source[p+1],b=source[p];if(g>=60&&g*10>r*13&&g*10>b*13){int q=iy*w+ix;mask[q/8]|=(byte)(1<<(7-q%8));foreground++;}}
  Console.Error.WriteLine("source:"+sw+"x"+sh+" mask:"+w+"x"+h+" fg:"+foreground);
  int lw,lh;var live=Read(args[1],out lw,out lh);if(args.Length>6&&args[6]=="--checks"){ResidentWire.Need(lw==sw&&lh==sh,"fixture_source_size_changed");Checks(source,live,lw,lh,mask,w,h);return 0;}var result=UiSkillVision.LocateNpc(live,lw,lh,mask,w,h,"吉安娜·普罗德摩尔");Console.WriteLine(ResidentWire.Encode(result));return(string)result["status"]=="known"?0:2;
 }catch(Exception e){Console.WriteLine(e.GetType().Name+":"+e.Message);return 1;}}
}
