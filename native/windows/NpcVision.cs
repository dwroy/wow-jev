using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace WowJev.Eye
{
    // Passive fixed-layout UI evidence only. No model calls, windows, input, or remembered target state.
    public sealed class NpcCalibration
    {
        public readonly string Id;
        readonly int width, height;
        readonly Dictionary<string, Detector> detectors = new Dictionary<string, Detector>(StringComparer.Ordinal);
        static readonly string[] Keys = { "npc_dialog_open", "npc_in_interaction_range" };
        public NpcCalibration(string path)
        {
            try
            {
                FileInfo configFile = new FileInfo(path);
                if (!Path.IsPathRooted(path) || (configFile.Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("invalid_npc_calibration_path");
                Dictionary<string, object> config = EyeJson.Load(path, 262144);
                EyeJson.Exact(config, "version", "kind", "id", "client_width", "client_height", "detectors");
                EyeJson.Int(config, "version", 1, 1);
                if (EyeJson.Text(config, "kind") != "npc-ui") throw new EyeFailure("invalid_npc_kind");
                Id = EyeJson.Text(config, "id");
                if (!Regex.IsMatch(Id, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z")) throw new EyeFailure("invalid_calibration_id");
                width = EyeJson.Int(config, "client_width", 1, 65535); height = EyeJson.Int(config, "client_height", 1, 65535);
                if ((long)width * height > 64000000) throw new EyeFailure("frame_too_large");
                Dictionary<string, object> definitions = EyeJson.Map(EyeJson.Need(config, "detectors")); EyeJson.Exact(definitions, Keys);
                if (definitions.Count == 0) throw new EyeFailure("empty_npc_detectors");
                string directory = Path.GetDirectoryName(Path.GetFullPath(path));
                foreach (KeyValuePair<string, object> item in definitions)
                    detectors.Add(item.Key, new Detector(directory, EyeJson.Map(item.Value), width, height, item.Key));
            }
            catch (EyeFailure) { throw; }
            catch { throw new EyeFailure("invalid_npc_calibration"); }
        }
        public Dictionary<string, object> Detect(Bitmap image, Dictionary<string, object> targetFields, string failure = null)
        {
            Dictionary<string, object> result = EyeJson.Obj();
            string unavailable = failure ?? (image.Width != width || image.Height != height ? "layout_size_mismatch" : new FrameMetrics(image).Empty ? "capture_empty" : null);
            foreach (string key in Keys)
            {
                if (!detectors.ContainsKey(key)) result[key] = Result("unavailable", null, 0, "calibration_unavailable", null);
                else if (unavailable != null) result[key] = Result(unavailable == "layout_size_mismatch" ? "unknown" : "unavailable", null, 0, unavailable, Id);
                else result[key] = detectors[key].Detect(image, Id, targetFields);
            }
            return result;
        }
        public Dictionary<string, object> Detect(Bitmap image, string failure = null) { return Detect(image, null, failure); }
        public static Dictionary<string, object> Unsupported(string code)
        {
            return EyeJson.Obj("npc_dialog_open", Result("unavailable", null, 0, code, null),
                "npc_in_interaction_range", Result("unavailable", null, 0, code, null));
        }
        static Dictionary<string, object> Result(string status, object value, double confidence, string reason, string id, string detail = null)
        { return EyeJson.Obj("status", status, "value", value, "confidence", confidence, "reason", EyeJson.Reason(reason, detail), "calibration_id", id); }
        static Rectangle Region(Dictionary<string, object> roi, int width, int height)
        {
            EyeJson.Exact(roi, "x", "y", "width", "height");
            Rectangle result = new Rectangle(EyeJson.Int(roi, "x", 0, width - 1), EyeJson.Int(roi, "y", 0, height - 1),
                EyeJson.Int(roi, "width", 1, width), EyeJson.Int(roi, "height", 1, height));
            if (result.Right > width || result.Bottom > height || (long)result.Width * result.Height > 1000000) throw new EyeFailure("roi_out_of_bounds");
            return result;
        }
        sealed class Detector
        {
            readonly Rectangle region;
            readonly double maxDistance, minMargin;
            readonly List<byte[]> positive, negative;
            readonly string name, signature;
            readonly bool bound;
            public Detector(string directory, Dictionary<string, object> config, int width, int height, string key)
            {
                if (key == "npc_in_interaction_range")
                {
                    EyeJson.Exact(config, "roi", "thresholds", "templates", "evidence_kind", "target_binding");
                    if (EyeJson.Text(config, "evidence_kind") != "target-interaction-indicator") throw new EyeFailure("unsupported_npc_range_evidence");
                    Dictionary<string, object> binding = EyeJson.Map(EyeJson.Need(config, "target_binding")); EyeJson.Exact(binding, "target_name", "target_signature");
                    name = EyeJson.Text(binding, "target_name"); signature = EyeJson.Text(binding, "target_signature");
                    if (name.Length > 128 || name != name.Trim() || Regex.IsMatch(name, "[\\x00-\\x1f]") || !Regex.IsMatch(signature, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z")) throw new EyeFailure("invalid_npc_target_binding");
                    bound = true;
                }
                else EyeJson.Exact(config, "roi", "thresholds", "templates");
                region = Region(EyeJson.Map(EyeJson.Need(config, "roi")), width, height);
                Dictionary<string, object> thresholds = EyeJson.Map(EyeJson.Need(config, "thresholds")); EyeJson.Exact(thresholds, "max_distance", "min_margin");
                maxDistance = EyeJson.Number(thresholds, "max_distance"); minMargin = EyeJson.Number(thresholds, "min_margin");
                if (maxDistance <= 0 || maxDistance > 1 || minMargin <= 0 || minMargin > 1) throw new EyeFailure("invalid_thresholds");
                Dictionary<string, object> templates = EyeJson.Map(EyeJson.Need(config, "templates")); EyeJson.Exact(templates, "positive", "negative");
                positive = Templates(directory, EyeJson.Need(templates, "positive")); negative = Templates(directory, EyeJson.Need(templates, "negative"));
                foreach (byte[] p in positive) foreach (byte[] n in negative) if (EyePixels.Distance(p, n) < minMargin) throw new EyeFailure("templates_inseparable");
            }
            List<byte[]> Templates(string directory, object entries)
            {
                object[] list = entries as object[]; if (list == null || list.Length < 1 || list.Length > 16) throw new EyeFailure("invalid_template_count");
                List<byte[]> result = new List<byte[]>(); HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (object entry in list)
                {
                    Dictionary<string, object> metadata = EyeJson.Map(entry); EyeJson.Exact(metadata, "file", "sha256", "source_sha256");
                    string filename = EyeJson.Text(metadata, "file");
                    if (!Regex.IsMatch(filename, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.png\\z") || Path.GetFileName(filename) != filename || !files.Add(filename)) throw new EyeFailure("invalid_template_path");
                    foreach (string key in new[] { "sha256", "source_sha256" }) if (!Regex.IsMatch(EyeJson.Text(metadata, key), "^[0-9a-f]{64}\\z")) throw new EyeFailure("invalid_provenance");
                    string path = Path.Combine(directory, filename); FileInfo file = new FileInfo(path);
                    if (!file.Exists || file.Length > 32 * 1024 * 1024 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("invalid_template_file");
                    if (EyeJson.Hash(path) != (string)metadata["sha256"]) throw new EyeFailure("template_hash_mismatch");
                    using (Bitmap image = new Bitmap(path))
                    {
                        if (image.RawFormat.Guid != ImageFormat.Png.Guid || image.Width != region.Width || image.Height != region.Height) throw new EyeFailure("template_size_mismatch");
                        result.Add(EyePixels.Read(image, new Rectangle(0, 0, image.Width, image.Height)));
                    }
                }
                return result;
            }
            static object Known(Dictionary<string, object> context, string key)
            {
                if (context == null || !context.ContainsKey(key)) return null;
                Dictionary<string, object> field = context[key] as Dictionary<string, object>;
                if (field == null || !field.ContainsKey("status") || !field.ContainsKey("value") || !(field["status"] is string) || (string)field["status"] != "known") return null;
                return field["value"];
            }
            static double Best(byte[] pixels, List<byte[]> templates)
            { double best = 1; foreach (byte[] template in templates) best = Math.Min(best, EyePixels.Distance(pixels, template)); return best; }
            public object Detect(Bitmap image, string id, Dictionary<string, object> targetFields)
            {
                if (bound)
                {
                    object present = Known(targetFields, "target_present");
                    if (!(present is bool) || !(bool)present || !String.Equals(Known(targetFields, "target_name") as string, name, StringComparison.Ordinal) ||
                        !String.Equals(Known(targetFields, "target_signature") as string, signature, StringComparison.Ordinal))
                        return Result("unknown", null, 0, "npc_target_binding_unconfirmed", id);
                }
                byte[] pixels = EyePixels.Read(image, region); double p = Best(pixels, positive), n = Best(pixels, negative), best = Math.Min(p, n), margin = Math.Abs(p - n);
                string detail = String.Format(CultureInfo.InvariantCulture, "positive_distance={0:F6};negative_distance={1:F6};margin={2:F6}", p, n, margin);
                if (best > maxDistance) return Result("unknown", null, 0, "template_distance_exceeded", id, detail);
                if (margin < minMargin) return Result("unknown", null, 0, "template_margin_insufficient", id, detail);
                return Result("known", p < n, 1 - best, "calibrated_match", id, detail);
            }
        }
    }
}
