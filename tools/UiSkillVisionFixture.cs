// Pure: reflection invokes the production math; no HWND, capture, task or input.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Drawing;
class UiSkillVisionFixture {
 static int checks;
 static Type Type;
 static object Call(string name,params object[] args){return Type.GetMethod(name,BindingFlags.Public|BindingFlags.Static).Invoke(null,args);}
 static void Need(bool value,string label){if(!value)throw new Exception(label);checks++;}
 static void Bad(string name,params object[] args){bool denied=false;try{Call(name,args);}catch(TargetInvocationException){denied=true;}Need(denied,"invalid shape must be refused");}
 static int Main(string[] args){try{
  Type=Assembly.Load(System.IO.File.ReadAllBytes(args[0])).GetType("UiSkillVision",true);
  var box=new Dictionary<string,object>{{"x",.4},{"y",.45},{"width",.2},{"height",.1}};
  var r=(Rectangle)Call("RectangleFor",box,2560,1440);Need(r.X==1024&&r.Y==648&&r.Width>=512&&r.Height>=144,"native client normalization");
  r=(Rectangle)Call("RectangleFor",box,1728,972);Need(r.Left>=691&&r.Right<=1037,"windowed client normalization");
  Bad("RectangleFor",new Dictionary<string,object>{{"x",.9},{"y",.1},{"width",.2},{"height",.1}},2560,1440);
  byte[] bgra=new byte[64*32*4],rgb=new byte[32*16*3];for(int i=0;i<bgra.Length;i+=4){bgra[i]=17;bgra[i+1]=33;bgra[i+2]=99;bgra[i+3]=255;}for(int i=0;i<rgb.Length;i+=3){rgb[i]=99;rgb[i+1]=33;rgb[i+2]=17;}
  var s=(Dictionary<string,object>)Call("Score",bgra,64,32,rgb,32,16,8.0,.05);Need((bool)s["matched"]&&Convert.ToDouble(s["mean_abs_error"])==0,"RGB/BGRA exact cell-center match");
  byte[] other=new byte[bgra.Length];s=(Dictionary<string,object>)Call("Score",other,64,32,rgb,32,16,8.0,.05);Need(!(bool)s["matched"],"negative template");
  Bad("Score",new byte[1],64,32,rgb,32,16,8.0,.05);
  var host=Type.Assembly.GetType("ResidentSessionHost+Host",true);var sweep=host.GetMethod("ReviewedCameraSweep",BindingFlags.NonPublic|BindingFlags.Static);
  var events=new List<object>();events.Add(new Dictionary<string,object>{{"kind","absolute_mouse_move"},{"at_ms",0},{"x",1792},{"y",892}});events.Add(new Dictionary<string,object>{{"kind","button_down"},{"at_ms",150},{"button","right"}});
  int[] deltas={77,77,76,77,-77,-76,-77,-77};for(int i=0;i<8;i++)events.Add(new Dictionary<string,object>{{"kind","relative_mouse_move"},{"at_ms",250+i*100},{"dx",deltas[i]},{"dy",0}});events.Add(new Dictionary<string,object>{{"kind","button_up"},{"at_ms",950},{"button","right"}});
  var action=new Dictionary<string,object>{{"kind","timeline"},{"duration_ms",950},{"events",events.ToArray()}};
  Need((bool)sweep.Invoke(null,new object[]{action,2560,1440}),"reviewed camera finite exact shape");
  var move=(Dictionary<string,object>)events[0];move["x"]=1793;Need(!(bool)sweep.Invoke(null,new object[]{action,2560,1440}),"camera rejects different origin");move["x"]=1792;
  var down=(Dictionary<string,object>)events[1];down["button"]="left";Need(!(bool)sweep.Invoke(null,new object[]{action,2560,1440}),"camera only right button");down["button"]="right";
  var delta=(Dictionary<string,object>)events[2];delta["dx"]=78;Need(!(bool)sweep.Invoke(null,new object[]{action,2560,1440}),"camera rejects nonreturning motion");delta["dx"]=77;
  delta["at_ms"]=0;Need(!(bool)sweep.Invoke(null,new object[]{action,2560,1440}),"camera rejects changed timing");
  byte[] surface=new byte[32*16*3],dim=new byte[32*16*4],flat=new byte[32*16*4];
  for(int i=0;i<512;i++){int r0=i%2==0?200:40,g0=i%2==0?200:70,b0=i%2==0?200:150;surface[i*3]=(byte)r0;surface[i*3+1]=(byte)g0;surface[i*3+2]=(byte)b0;dim[i*4]=(byte)(b0/2);dim[i*4+1]=(byte)(g0/2);dim[i*4+2]=(byte)(r0/2);dim[i*4+3]=255;flat[i*4]=flat[i*4+1]=flat[i*4+2]=120;flat[i*4+3]=255;}
  var color=(Dictionary<string,object>)Call("ScoreChroma",dim,32,16,surface);Need((bool)color["matched"],"surface survives brightness change");
  color=(Dictionary<string,object>)Call("ScoreChroma",flat,32,16,surface);Need(!(bool)color["matched"],"flat gray UI is not an NPC body");
  if(args.Length>=3){using(var sourceImage=new Bitmap(args[1]))using(var liveImage=new Bitmap(args[2])){
    var sourceRgb=new byte[32*16*3];var liveBgra=new byte[32*32*4];
    for(int y=0;y<16;y++)for(int x=0;x<32;x++){var pixel=sourceImage.GetPixel(1494+x,589+y*2+1);int i=(y*32+x)*3;sourceRgb[i]=pixel.R;sourceRgb[i+1]=pixel.G;sourceRgb[i+2]=pixel.B;}
    for(int y=0;y<32;y++)for(int x=0;x<32;x++){var pixel=liveImage.GetPixel(1494+x,589+y);int i=(y*32+x)*4;liveBgra[i]=pixel.B;liveBgra[i+1]=pixel.G;liveBgra[i+2]=pixel.R;liveBgra[i+3]=255;}
    color=(Dictionary<string,object>)Call("ScoreChroma",liveBgra,32,32,sourceRgb);Console.WriteLine("actual_surface:"+String.Join(",",color));Need((bool)color["matched"],"independent real body positive");
    int w=315,h=48;var mask=new byte[(w*h+7)/8];var pixels=new byte[w*h*4];
    for(int y=0;y<h;y++)for(int x=0;x<w;x++){int i=y*w+x;var p0=sourceImage.GetPixel(1373+x,330+y);if(p0.G>=60&&p0.G>p0.R*1.3&&p0.G>p0.B*1.3)mask[i/8]|=(byte)(1<<(7-i%8));var p1=liveImage.GetPixel(1373+x,330+y);pixels[i*4]=p1.B;pixels[i*4+1]=p1.G;pixels[i*4+2]=p1.R;pixels[i*4+3]=255;}
    var glyph=(Dictionary<string,object>)Call("ScoreGreenMask",pixels,w,h,mask,w,h);Console.WriteLine("actual_glyph:"+String.Join(",",glyph));Need(!(bool)glyph["matched"],"v1 rejects this real subpixel glyph variant");glyph=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerant",pixels,w,h,mask,w,h);Console.WriteLine("actual_glyph_v2:"+String.Join(",",glyph));Need(!(bool)glyph["matched"],"v2 correctly retains joint-threshold rejection");glyph=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerantV3",pixels,w,h,mask,w,h);Console.WriteLine("actual_glyph_v3:"+String.Join(",",glyph));Need((bool)glyph["matched"],"independent real tolerant v3 glyph positive");
    glyph=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerantV3",new byte[pixels.Length],w,h,mask,w,h);Need(!(bool)glyph["matched"],"empty negative has no glyph");
    byte[] solid=new byte[pixels.Length];for(int i=0;i<solid.Length;i+=4){solid[i+1]=255;solid[i+3]=255;}glyph=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerantV3",solid,w,h,mask,w,h);Need(!(bool)glyph["matched"],"solid green UI not a name");
    byte[] erased=(byte[])pixels.Clone();for(int y=0;y<h;y++)for(int x=0;x<40;x++){int i=(y*w+x)*4;erased[i]=erased[i+1]=erased[i+2]=0;}glyph=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerantV3",erased,w,h,mask,w,h);Need(!(bool)glyph["matched"],"missing name glyphs rejected");
    for(int ai=3;ai<args.Length;ai++)using(var negative=new Bitmap(args[ai])){
      var patch=new byte[32*32*4];for(int y=0;y<32;y++)for(int x=0;x<32;x++){var p=negative.GetPixel(1494+x,589+y);int i=(y*32+x)*4;patch[i]=p.B;patch[i+1]=p.G;patch[i+2]=p.R;patch[i+3]=255;}
      var bodyScore=(Dictionary<string,object>)Call("ScoreChroma",patch,32,32,sourceRgb);
      var labelPixels=new byte[w*h*4];for(int y=0;y<h;y++)for(int x=0;x<w;x++){var p=negative.GetPixel(1373+x,330+y);int i=(y*w+x)*4;labelPixels[i]=p.B;labelPixels[i+1]=p.G;labelPixels[i+2]=p.R;labelPixels[i+3]=255;}
      var labelScore=(Dictionary<string,object>)Call("ScoreGreenGlyphTolerantV3",labelPixels,w,h,mask,w,h);
      var hintRgb=new byte[32*16*3];var hintLive=new byte[365*33*4];for(int y=0;y<16;y++)for(int x=0;x<32;x++){var p=sourceImage.GetPixel(1120+(int)((x+.5)*365/32),938+(int)((y+.5)*33/16));int i=(y*32+x)*3;hintRgb[i]=p.R;hintRgb[i+1]=p.G;hintRgb[i+2]=p.B;}
      for(int y=0;y<33;y++)for(int x=0;x<365;x++){var p=negative.GetPixel(1120+x,938+y);int i=(y*365+x)*4;hintLive[i]=p.B;hintLive[i+1]=p.G;hintLive[i+2]=p.R;hintLive[i+3]=255;}
      var hintScore=(Dictionary<string,object>)Call("Score",hintLive,365,33,hintRgb,32,16,8.0,.05);bool composite=(bool)bodyScore["matched"]&&(bool)labelScore["matched"]&&(bool)hintScore["matched"];
      Console.WriteLine("negative:"+System.IO.Path.GetFileName(args[ai])+":body="+bodyScore["matched"]+",name="+labelScore["matched"]+",hint="+hintScore["matched"]);Need(!composite,"other known state must not match NPC composite");
    }

  }}
  Console.WriteLine("{\"checks\":"+checks+",\"inputs\":0,\"captures\":0}");return 0;
 }catch(Exception e){Console.WriteLine(e.GetType().Name+":"+e.Message);return 1;}}
}
