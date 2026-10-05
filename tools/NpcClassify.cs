using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using WowJev.Eye;

// Read-only offline helper. Does not depend on WinEye, InputCommon, or desktop access.
class NpcClassify
{
    static int Main(string[] args)
    {
        JavaScriptSerializer json = new JavaScriptSerializer();
        try
        {
            if (args.Length < 1 || args.Length > 3) throw new EyeFailure("usage_image_optional_calibration_optional_target_context");
            string imagePath = args[0]; FileInfo file = new FileInfo(imagePath);
            if (!Path.IsPathRooted(imagePath) || !file.Exists || file.Length > 16 * 1024 * 1024 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("invalid_image_path");
            Dictionary<string, object> target = args.Length == 3 ? EyeJson.Load(args[2], 65536) : null;
            NpcCalibration calibration = args.Length >= 2 ? new NpcCalibration(args[1]) : null;
            using (Bitmap image = new Bitmap(imagePath))
            {
                if ((long)image.Width * image.Height > 32000000) throw new EyeFailure("frame_too_large");
                FrameMetrics metrics = new FrameMetrics(image);
                Console.WriteLine(json.Serialize(EyeJson.Obj("type", "offline_npc_result", "image", EyeJson.Obj("sha256", EyeJson.Hash(imagePath), "width", image.Width, "height", image.Height),
                    "frame_status", metrics.Empty ? "unavailable" : "ok", "detectors", calibration == null ? NpcCalibration.Unsupported("calibration_unavailable") : calibration.Detect(image, target))));
            }
            return 0;
        }
        catch (EyeFailure failure) { Console.WriteLine(json.Serialize(EyeJson.Obj("type", "error", "code", failure.Code))); return 2; }
        catch { Console.WriteLine(json.Serialize(EyeJson.Obj("type", "error", "code", "npc_classify_failed"))); return 2; }
    }
}
