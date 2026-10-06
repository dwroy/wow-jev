// Narrow calibrated CV for the user's first Exile's Reach conversation.
// Reads only the captured bitmap; never sends input or changes a window.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

public static class RecoveryTutorialCv
{
    static Dictionary<string, object> Obj(params object[] values)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < values.Length; i += 2) result.Add((string)values[i], values[i + 1]);
        return result;
    }
    static Dictionary<string, object> Map(object value) { return (Dictionary<string, object>)value; }
    static int Int(Dictionary<string, object> value, string key) { return Convert.ToInt32(value[key], CultureInfo.InvariantCulture); }
    static string Hash(string path)
    {
        using (var file = File.OpenRead(path)) using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
    }
    static bool Ink(Color value, string mask)
    {
        if (mask == "green") return value.G >= 155 && value.R <= 110 && value.B <= 120 && value.G - value.R >= 60;
        if (mask == "gray") return value.R >= 140 && value.G >= 140 && value.B >= 140 &&
            Math.Max(value.R, Math.Max(value.G, value.B)) - Math.Min(value.R, Math.Min(value.G, value.B)) <= 35;
        throw new InvalidOperationException("unknown_mask");
    }
    static Dictionary<string, object> Region(Bitmap image, Dictionary<string, object> spec, string directory)
    {
        string id = (string)spec["id"], mask = (string)spec["mask"], file = (string)spec["file"];
        if (!((id == "npc_name" && mask == "green" && file == "tutorial-npc-name.png") ||
            (id == "tutorial_hint" && mask == "gray" && file == "tutorial-talk-hint.png"))) throw new InvalidOperationException("region_identity");
        string path = Path.Combine(directory, file);
        if (Hash(path) != (string)spec["sha256"]) throw new InvalidOperationException("template_hash");
        var rect = Map(spec["rect"]); int x = Int(rect, "x"), y = Int(rect, "y"), width = Int(rect, "width"), height = Int(rect, "height");
        int shift = Int(spec, "max_shift_px"); double threshold = Convert.ToDouble(spec["min_iou"], CultureInfo.InvariantCulture);
        if (width < 20 || height < 10 || shift < 0 || shift > 3 || threshold < .90 || threshold > 1 ||
            x < shift || y < shift || x + width + shift > image.Width || y + height + shift > image.Height)
            throw new InvalidOperationException("region_bounds");
        using (var reference = new Bitmap(path))
        {
            if (reference.Width != width || reference.Height != height) throw new InvalidOperationException("template_dimensions");
            bool[] original = new bool[width * height]; int ink = 0;
            for (int yy = 0; yy < height; yy++) for (int xx = 0; xx < width; xx++)
            { bool value = Ink(reference.GetPixel(xx, yy), mask); original[yy * width + xx] = value; if (value) ink++; }
            if (ink < 150 || ink > width * height / 2) throw new InvalidOperationException("template_ink");
            int liveWidth = width + shift * 2, liveHeight = height + shift * 2;
            bool[] liveMask = new bool[liveWidth * liveHeight];
            for (int yy = 0; yy < liveHeight; yy++) for (int xx = 0; xx < liveWidth; xx++)
                liveMask[yy * liveWidth + xx] = Ink(image.GetPixel(x + xx - shift, y + yy - shift), mask);
            double best = 0; int bestX = 0, bestY = 0;
            for (int dy = -shift; dy <= shift; dy++) for (int dx = -shift; dx <= shift; dx++)
            {
                int intersection = 0, union = 0;
                for (int yy = 0; yy < height; yy++) for (int xx = 0; xx < width; xx++)
                {
                    bool a = original[yy * width + xx], b = liveMask[(yy + dy + shift) * liveWidth + xx + dx + shift];
                    if (a || b) union++; if (a && b) intersection++;
                }
                double score = union > 0 ? (double)intersection / union : 0;
                if (score > best) { best = score; bestX = dx; bestY = dy; }
            }
            return Obj("region", id, "matched", best >= threshold, "mask_iou", best, "min_iou", threshold,
                "reference_ink_pixels", ink, "offset_x", bestX, "offset_y", bestY);
        }
    }
    public static Dictionary<string, object> Match(Bitmap image, string fixedDirectory)
    {
        var result = Obj("verified", false, "source", "calibrated_cv", "reason", "tutorial_calibration_unknown");
        try
        {
            string path = Path.Combine(fixedDirectory, "tutorial-talk-jaina.json");
            var profile = Map(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8)));
            result["calibration_sha256"] = Hash(path);
            var layout = Map(profile["layout"]); int width = Int(layout, "width"), height = Int(layout, "height");
            result["layout_width"] = width; result["layout_height"] = height;
            if (width != 2560 || height != 1440 || image.Width != width || image.Height != height || Int(profile, "version") != 1 ||
                (string)profile["npc_name"] != "吉安娜·普罗德摩尔" || (string)profile["tutorial_step"] != "与吉安娜·普罗德摩尔交谈")
            { result["reason"] = "tutorial_layout_or_identity_mismatch"; return result; }
            var regions = (object[])profile["regions"]; if (regions.Length != 2) throw new InvalidOperationException("region_count");
            var scores = new List<object>(); var names = new HashSet<string>(); bool matched = true; int dx = 0, dy = 0;
            foreach (object region in regions)
            {
                var spec = Map(region); if (!names.Add((string)spec["id"])) throw new InvalidOperationException("duplicate_region");
                var score = Region(image, spec, fixedDirectory); scores.Add(score); matched &= (bool)score["matched"];
                if ((string)spec["id"] == "npc_name") { dx = Int(score, "offset_x"); dy = Int(score, "offset_y"); }
            }
            matched &= names.SetEquals(new[] { "npc_name", "tutorial_hint" });
            result["regions"] = scores; result["verified"] = matched; result["reason"] = matched ? "tutorial_current_regions_match" : "tutorial_region_mismatch";
            // The template provenance is separate from the source observation;
            // the host binds observation_id and capture_sha256 after this result.
            result["reference_sha256"] = (string)Map(profile["source"])["original_capture_sha256"];
            if (matched)
            {
                var point = Map(profile["action_point"]); var safe = Map(profile["safe_focus_point"]);
                int px = Int(point, "x") + dx, py = Int(point, "y") + dy, sx = Int(safe, "x"), sy = Int(safe, "y");
                if (px < 0 || py < 0 || px >= width || py >= height || sx < 0 || sy < 0 || sx >= width || sy >= height) throw new InvalidOperationException("point_bounds");
                result["kind"] = "talk_jaina"; result["npc_name"] = "吉安娜·普罗德摩尔";
                result["action_point"] = Obj("x", px, "y", py); result["safe_focus_point"] = Obj("x", sx, "y", sy);
            }
            return result;
        }
        catch { result["verified"] = false; result["reason"] = "tutorial_calibration_invalid"; return result; }
    }
}
