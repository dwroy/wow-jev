// Offline image tests only: no desktop capture, process launch, or input API.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;

static class RecoveryCalibrationFixture
{
    static readonly List<object> Rows = new List<object>();
    static readonly Dictionary<string,object> Timing = new Dictionary<string,object>();
    static void Need(bool condition, string name)
    { Rows.Add(new Dictionary<string, object> { { "check", name }, { "passed", condition } }); if (!condition) throw new InvalidOperationException(name); }
    static bool Selected(Bitmap image, string root) { return (bool)RecoveryCalibration.Match(image, root)["verified"]; }
    static bool Tutorial(Bitmap image, string root) { return (bool)RecoveryTutorialCv.Match(image, root)["verified"]; }
    static Bitmap Changed(Bitmap image, Rectangle rectangle, Color color)
    { var copy = new Bitmap(image); using (var graphics = Graphics.FromImage(copy)) using (var brush = new SolidBrush(color)) graphics.FillRectangle(brush, rectangle); return copy; }
    static Bitmap Resized(Bitmap image,int width,int height) { return RecoveryCvProfile.Resize(image,width,height); }
    static Bitmap Anchored(Bitmap original,int width,int height,double factor,bool tutorial)
    {
        double scale=height/1440.0*factor;
        var canvas=Resized(original,width,height);
        // Remove the old UI from the resized real background, then replay the
        // authentic source ROIs with an independently specified UI transform.
        using(var graphics=Graphics.FromImage(canvas))
        {
            graphics.CompositingMode=System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            if(!tutorial)
            {
                var rectangle=new Rectangle(2014,598,483,148);
                graphics.FillRectangle(Brushes.Black,new Rectangle((int)(width*.65),0,width-(int)(width*.65),height));
                using(var crop=original.Clone(rectangle,System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    graphics.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;graphics.PixelOffsetMode=System.Drawing.Drawing2D.PixelOffsetMode.Half;
                    graphics.DrawImage(crop,new RectangleF((float)(width-546*scale),(float)(height*.5-122*scale),(float)(483*scale),(float)(148*scale)),new RectangleF(0,0,483,148),GraphicsUnit.Pixel);
                }
            }
            else
            {
                var names=new[]{new Rectangle(1194,332,309,44),new Rectangle(1114,921,446,65)};
                // The fixtures deliberately relocate both independently anchored
                // label/hint, rather than stretching all text with client aspect.
                foreach(var rect in names)
                {
                    graphics.FillRectangle(Brushes.Black,new Rectangle((int)(rect.X*width/2560.0)-12,(int)(rect.Y*height/1440.0)-12,(int)(rect.Width*width/2560.0)+24,(int)(rect.Height*height/1440.0)+24));
                    int w=(int)Math.Round(rect.Width*scale,MidpointRounding.AwayFromZero),h=(int)Math.Round(rect.Height*scale,MidpointRounding.AwayFromZero);
                    double x=rect.Y==332?1348.5*width/2560.0-rect.Width*scale*.5:width*.5-166*scale;
                    double y=rect.Y==332?354.0*height/1440.0-rect.Height*scale*.5:height-519*scale;
                    using(var crop=original.Clone(rect,System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                    {
                        graphics.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;graphics.PixelOffsetMode=System.Drawing.Drawing2D.PixelOffsetMode.Half;
                        graphics.DrawImage(crop,new RectangleF((float)x,(float)y,(float)(rect.Width*scale),(float)(rect.Height*scale)),new RectangleF(0,0,rect.Width,rect.Height),GraphicsUnit.Pixel);
                    }
                }
            }
        }
        return canvas;
    }
    static List<RecoveryCvFrameRegion> Stage(Bitmap image,string root)
    {
        var frames=new List<RecoveryCvFrameRegion>();
        foreach(var region in RecoveryCvProfile.DescribeRegions(image.Width,image.Height,root))
            frames.Add(new RecoveryCvFrameRegion{Rectangle=region.Rectangle,Image=image.Clone(region.Rectangle,System.Drawing.Imaging.PixelFormat.Format32bppArgb)});
        return frames;
    }
    static void DisposeFrames(List<RecoveryCvFrameRegion> frames){foreach(var frame in frames)frame.Image.Dispose();}
    static double Percentile(List<double> samples,double fraction){samples.Sort();return samples[(int)Math.Ceiling(samples.Count*fraction)-1];}
    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3 && args.Length != 4) throw new InvalidOperationException("three_offline_paths_required");
            using (var selection = new Bitmap(args[0])) using (var tutorial = new Bitmap(args[1]))
            {
                string root = args[2];
                var cold=System.Diagnostics.Stopwatch.StartNew();
                RecoveryCvProfile.DescribeRegions(2560,1440,root);cold.Stop();Timing["cold_template_initialization_ms"]=cold.Elapsed.TotalMilliseconds;
                cold.Restart();Need(Selected(selection, root), "reviewed_selected_alliance_warrior");cold.Stop();Timing["first_warm_selection_ms"]=cold.Elapsed.TotalMilliseconds;
                using (var image = Changed(selection, new Rectangle(2037, 614, 110, 45), Color.Magenta)) Need(!Selected(image, root), "wrong_name_rejected");
                using (var image = Changed(selection, new Rectangle(2052, 638, 6, 5), Color.Magenta)) Need(!Selected(image, root), "thirty_changed_name_pixels_not_hidden_by_background");
                using (var image = Changed(selection, new Rectangle(2119, 657, 66, 43), Color.Magenta)) Need(!Selected(image, root), "wrong_class_rejected");
                using (var image = Changed(selection, new Rectangle(2390, 625, 101, 112), Color.Black)) Need(!Selected(image, root), "wrong_or_missing_alliance_glyph_rejected");
                using (var image = Changed(selection, new Rectangle(2014, 598, 483, 148), Color.Gray)) Need(!Selected(image, root), "unselected_row_rejected");
                using (var image = new Bitmap(1280, 720)) Need(!Selected(image, root), "selection_wrong_dimensions_rejected");
                Need(!Selected(tutorial, root), "world_not_selection");
                cold.Restart();Need(Tutorial(tutorial, root), "reviewed_named_npc_and_same_tutorial_hint");cold.Stop();Timing["first_warm_tutorial_ms"]=cold.Elapsed.TotalMilliseconds;
                using (var image = Changed(tutorial, new Rectangle(1194, 332, 309, 44), Color.Black)) Need(!Tutorial(image, root), "missing_or_wrong_npc_name_rejected");
                using (var image = Changed(tutorial, new Rectangle(1114, 921, 446, 65), Color.Black)) Need(!Tutorial(image, root), "different_or_missing_task_hint_rejected");
                using (var image = new Bitmap(2560, 1440))
                {
                    using (var graphics = Graphics.FromImage(image)) graphics.DrawImageUnscaled(tutorial, 50, 0);
                    Need(!Tutorial(image, root), "uncalibrated_camera_shift_rejected");
                }
                Need(!Tutorial(selection, root), "selection_not_world_conversation");
                using (var image = new Bitmap(1280, 720)) Need(!Tutorial(image, root), "tutorial_wrong_dimensions_rejected");
                foreach(var size in new[]{new Size(1280,720),new Size(1920,1080)})
                {
                    using(var image=Resized(selection,size.Width,size.Height))Need(Selected(image,root),"whole_selection_image_scaled_"+size.Width);
                    using(var image=Resized(tutorial,size.Width,size.Height))Need(Tutorial(image,root),"whole_tutorial_image_scaled_"+size.Width);
                }
                foreach(var size in new[]{new Size(1280,720),new Size(1920,1080)})
                {
                    foreach(var rectangle in new[]{new Rectangle(2037,614,110,45),new Rectangle(2119,657,66,43),new Rectangle(2390,625,101,112),new Rectangle(2014,598,483,148)})
                        using(var bad=Changed(selection,rectangle,Color.Magenta))using(var scaled=Resized(bad,size.Width,size.Height))Need(!Selected(scaled,root),"scaled_wrong_identity_"+size.Width+"_"+rectangle.X);
                    using(var bad=Changed(selection,new Rectangle(2052,638,6,5),Color.Magenta))using(var scaled=Resized(bad,size.Width,size.Height))Need(!Selected(scaled,root),"scaled_thirty_name_pixels_"+size.Width);
                    foreach(var rectangle in new[]{new Rectangle(1194,332,309,44),new Rectangle(1114,921,446,65)})
                        using(var bad=Changed(tutorial,rectangle,Color.Black))using(var scaled=Resized(bad,size.Width,size.Height))Need(!Tutorial(scaled,root),"scaled_missing_npc_or_hint_"+size.Width+"_"+rectangle.Y);
                }
                foreach(var size in new[]{new Size(1600,1200),new Size(1920,800),new Size(1713,956)})foreach(double factor in new[]{.75,1.0,1.25,1.5})
                {
                    string suffix=size.Width+"x"+size.Height+"_"+factor.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    using(var image=Anchored(selection,size.Width,size.Height,factor,false))Need(Selected(image,root),"anchored_selection_"+suffix);
                    using(var image=Anchored(tutorial,size.Width,size.Height,factor,true))Need(Tutorial(image,root),"anchored_tutorial_"+suffix);
                    using(var bad=Changed(selection,new Rectangle(2037,614,110,45),Color.Magenta))using(var image=Anchored(bad,size.Width,size.Height,factor,false))Need(!Selected(image,root),"anchored_wrong_name_"+suffix);
                    using(var bad=Changed(selection,new Rectangle(2390,625,101,112),Color.Black))using(var image=Anchored(bad,size.Width,size.Height,factor,false))Need(!Selected(image,root),"anchored_wrong_faction_"+suffix);
                    using(var bad=Changed(tutorial,new Rectangle(1194,332,309,44),Color.Black))using(var image=Anchored(bad,size.Width,size.Height,factor,true))Need(!Tutorial(image,root),"anchored_wrong_npc_"+suffix);
                    using(var bad=Changed(tutorial,new Rectangle(1114,921,446,65),Color.Black))using(var image=Anchored(bad,size.Width,size.Height,factor,true))Need(!Tutorial(image,root),"anchored_wrong_hint_"+suffix);
                }
                using(var image=Resized(selection,1600,1200))Need(!Selected(image,root),"nonuniform_stretched_glyph_selection_rejected");
                using(var image=Resized(tutorial,1600,1200))Need(!Tutorial(image,root),"nonuniform_stretched_glyph_tutorial_rejected");
                using(var image=Anchored(selection,1920,1080,1.7,false))Need(!Selected(image,root),"unsupported_ui_scale_selection_rejected");
                using(var image=Anchored(tutorial,1920,1080,1.7,true))Need(!Tutorial(image,root),"unsupported_ui_scale_tutorial_rejected");
                foreach(var actual in new[]{selection,tutorial})
                {
                    var frames=Stage(actual,root);
                    try
                    {
                        var match=RecoveryCvProfile.MatchRegions(frames,actual.Width,actual.Height,root);
                        string field=actual==selection?"selected_character":"tutorial_interaction";
                        Need((bool)((Dictionary<string,object>)match[field])["verified"],"roi_staging_matches_full_frame_"+field);
                        foreach(var frame in frames)frame.Rectangle=new Rectangle(frame.Rectangle.X+20,frame.Rectangle.Y,frame.Rectangle.Width,frame.Rectangle.Height);
                        match=RecoveryCvProfile.MatchRegions(frames,actual.Width,actual.Height,root);
                        Need(!(bool)((Dictionary<string,object>)match[field])["verified"],"roi_wrong_origins_rejected_"+field);
                    }
                    finally{DisposeFrames(frames);}
                }
                var empty=RecoveryCvProfile.MatchRegions(new List<RecoveryCvFrameRegion>(),2560,1440,root);
                Need(!(bool)((Dictionary<string,object>)empty["selected_character"])["verified"]&&!(bool)((Dictionary<string,object>)empty["tutorial_interaction"])["verified"],"missing_staged_regions_unknown");
                foreach(var actual in new[]{selection,tutorial})
                {
                    var frames=Stage(actual,root);var samples=new List<double>();
                    try
                    {
                        for(int i=0;i<5;i++)RecoveryCvProfile.MatchRegions(frames,actual.Width,actual.Height,root);
                        for(int i=0;i<100;i++){var watch=System.Diagnostics.Stopwatch.StartNew();RecoveryCvProfile.MatchRegions(frames,actual.Width,actual.Height,root);watch.Stop();samples.Add(watch.Elapsed.TotalMilliseconds);}
                        Timing[actual==selection?"warm_selection_frame_roi_cv":"warm_tutorial_frame_roi_cv"]=new{n=100,p50_ms=Percentile(samples,.5),p95_ms=Percentile(samples,.95),max_ms=Percentile(samples,1),clock_domain="windows_qpc",scope="selected_character and tutorial_interaction CV only; no capture, PNG, OCR, input or coordinator"};
                    }
                    finally{DisposeFrames(frames);}
                }
                if(args.Length==4)using(var field=new Bitmap(args[3]))
                {
                    Need(!Selected(field,root),"current_disconnected_frame_not_selected");
                    Need(!Tutorial(field,root),"current_disconnected_frame_not_world_interaction");
                }

            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { status = "passed", checks = Rows.Count, results = Rows, timing = Timing, game_inputs = 0, desktop_capture = 0, model_calls = 0 }));
            return 0;
        }
        catch (Exception error)
        { Console.WriteLine(new JavaScriptSerializer().Serialize(new { status = "failed", reason = error.Message, results = Rows, game_inputs = 0 })); return 1; }
    }
}
