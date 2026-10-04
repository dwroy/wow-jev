using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

namespace WowJev.Eye
{
    public sealed class EyeFailure : Exception
    {
        public readonly string Code;
        public EyeFailure(string code) : base(code) { Code = code; }
    }
    public static class EyeJson
    {
        public static Dictionary<string, object> Obj(params object[] pairs)
        {
            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
            return result;
        }
        public static Dictionary<string, object> Map(object value)
        { Dictionary<string, object> result = value as Dictionary<string, object>; if (result == null) throw new EyeFailure("invalid_object"); return result; }
        public static object Need(Dictionary<string, object> map, string key)
        { object value; if (!map.TryGetValue(key, out value)) throw new EyeFailure("missing_field"); return value; }
        public static string Text(Dictionary<string, object> map, string key)
        { string value = Need(map, key) as string; if (String.IsNullOrEmpty(value)) throw new EyeFailure("invalid_string"); return value; }
        public static int Int(Dictionary<string, object> map, string key, int minimum, int maximum)
        {
            object value = Need(map, key); if (!(value is int)) throw new EyeFailure("invalid_integer");
            int result = (int)value; if (result < minimum || result > maximum) throw new EyeFailure("integer_out_of_range"); return result;
        }
        public static double Number(Dictionary<string, object> map, string key)
        {
            object value = Need(map, key);
            if (!(value is int) && !(value is long) && !(value is double) && !(value is decimal)) throw new EyeFailure("invalid_number");
            double result = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (Double.IsNaN(result) || Double.IsInfinity(result)) throw new EyeFailure("invalid_number"); return result;
        }
        public static void Exact(Dictionary<string, object> map, params string[] allowed)
        { foreach (string key in map.Keys) if (Array.IndexOf(allowed, key) < 0) throw new EyeFailure("unknown_field"); }
        public static object Reason(string code, string message = null)
        { return Obj("code", code, "message", message ?? code); }
        public static string Hash(string path)
        { using (SHA256 hash = SHA256.Create()) using (FileStream input = File.OpenRead(path)) return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant(); }
        public static Dictionary<string, object> Load(string path, int maximumBytes)
        {
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length < 2 || file.Length > maximumBytes) throw new EyeFailure("invalid_json_file");
            return Map(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)));
        }
    }
    public sealed class FrameMetrics
    {
        public double Mean, Variance;
        public readonly double[] Thumbnail;
        public FrameMetrics(Bitmap image)
        {
            int width = Math.Min(64, image.Width), height = Math.Min(48, image.Height);
            Thumbnail = new double[width * height];
            using (Bitmap tiny = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(tiny))
                { graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor; graphics.DrawImage(image, 0, 0, width, height); }
                byte[] pixels = EyePixels.Read(tiny, new Rectangle(0, 0, width, height));
                double square = 0;
                for (int i = 0; i < Thumbnail.Length; i++)
                {
                    double luma = pixels[i * 3] * 0.2126 + pixels[i * 3 + 1] * 0.7152 + pixels[i * 3 + 2] * 0.0722;
                    Thumbnail[i] = luma; Mean += luma; square += luma * luma;
                }
                Mean /= Thumbnail.Length; Variance = Math.Max(0, square / Thumbnail.Length - Mean * Mean);
            }
        }
        public bool Empty { get { return Mean <= 2 || Variance <= 0.5 || (Mean <= 5 && Variance <= 2); } }
        public object Json(double[] previous)
        {
            object delta = null;
            if (previous != null && previous.Length == Thumbnail.Length)
            {
                double total = 0; for (int i = 0; i < previous.Length; i++) total += Math.Abs(previous[i] - Thumbnail[i]);
                delta = total / previous.Length / 255;
            }
            return EyeJson.Obj("mean_luma", Mean, "variance_luma", Variance, "frame_delta", delta);
        }
    }
    public static class EyePixels
    {
        public static byte[] Read(Bitmap image, Rectangle region)
        {
            using (Bitmap roi = image.Clone(region, PixelFormat.Format24bppRgb))
            {
                BitmapData data = roi.LockBits(new Rectangle(0, 0, roi.Width, roi.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    byte[] result = new byte[checked(roi.Width * roi.Height * 3)];
                    byte[] row = new byte[roi.Width * 3];
                    for (int y = 0; y < roi.Height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                        for (int x = 0; x < roi.Width; x++)
                        { int index = (y * roi.Width + x) * 3; result[index] = row[x * 3 + 2]; result[index + 1] = row[x * 3 + 1]; result[index + 2] = row[x * 3]; }
                    }
                    return result;
                }
                finally { roi.UnlockBits(data); }
            }
        }
        public static double Distance(byte[] first, byte[] second)
        {
            if (first.Length != second.Length || first.Length == 0) throw new EyeFailure("template_size_mismatch");
            long total = 0; for (int i = 0; i < first.Length; i++) total += Math.Abs(first[i] - second[i]);
            return total / (double)first.Length / 255;
        }
    }
    public sealed class InventoryCalibration
    {
        public readonly string Id;
        readonly int width, height;
        readonly Rectangle region;
        readonly double maximumDistance, minimumMargin;
        readonly byte[] open, closed;
        public InventoryCalibration(string path)
        {
            try
            {
                Dictionary<string, object> config = EyeJson.Load(path, 65536);
                EyeJson.Exact(config, "version", "id", "client_width", "client_height", "roi", "templates", "thresholds", "provenance");
                EyeJson.Int(config, "version", 1, 1); Id = EyeJson.Text(config, "id");
                if (!System.Text.RegularExpressions.Regex.IsMatch(Id, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")) throw new EyeFailure("invalid_calibration_id");
                width = EyeJson.Int(config, "client_width", 1, 65535); height = EyeJson.Int(config, "client_height", 1, 65535);
                if ((long)width * height > 64000000) throw new EyeFailure("frame_too_large");
                Dictionary<string, object> roi = EyeJson.Map(EyeJson.Need(config, "roi")); EyeJson.Exact(roi, "x", "y", "width", "height");
                region = new Rectangle(EyeJson.Int(roi, "x", 0, width - 1), EyeJson.Int(roi, "y", 0, height - 1),
                    EyeJson.Int(roi, "width", 1, width), EyeJson.Int(roi, "height", 1, height));
                if (region.Right > width || region.Bottom > height || (long)region.Width * region.Height > 8000000) throw new EyeFailure("roi_out_of_bounds");
                Dictionary<string, object> thresholds = EyeJson.Map(EyeJson.Need(config, "thresholds")); EyeJson.Exact(thresholds, "max_distance", "min_margin");
                maximumDistance = EyeJson.Number(thresholds, "max_distance"); minimumMargin = EyeJson.Number(thresholds, "min_margin");
                if (maximumDistance <= 0 || maximumDistance > 1 || minimumMargin <= 0 || minimumMargin > 1) throw new EyeFailure("invalid_thresholds");
                Dictionary<string, object> provenance = EyeJson.Map(EyeJson.Need(config, "provenance")); EyeJson.Exact(provenance, "open_sha256", "closed_sha256");
                foreach (string key in new[] { "open_sha256", "closed_sha256" })
                    if (!System.Text.RegularExpressions.Regex.IsMatch(EyeJson.Text(provenance, key), "^[0-9a-f]{64}$")) throw new EyeFailure("invalid_provenance");
                Dictionary<string, object> templates = EyeJson.Map(EyeJson.Need(config, "templates")); EyeJson.Exact(templates, "open", "closed");
                string directory = Path.GetDirectoryName(Path.GetFullPath(path));
                open = Template(directory, EyeJson.Text(templates, "open")); closed = Template(directory, EyeJson.Text(templates, "closed"));
                if (EyePixels.Distance(open, closed) < minimumMargin) throw new EyeFailure("templates_inseparable");
            }
            catch (EyeFailure) { throw; }
            catch { throw new EyeFailure("invalid_calibration"); }
        }
        byte[] Template(string directory, string filename)
        {
            if (Path.GetFileName(filename) != filename || !filename.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) throw new EyeFailure("invalid_template_path");
            string path = Path.Combine(directory, filename);
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length > 32 * 1024 * 1024 || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new EyeFailure("invalid_template_file");
            using (Bitmap image = new Bitmap(path))
            {
                if (image.RawFormat.Guid != ImageFormat.Png.Guid || image.Width != region.Width || image.Height != region.Height) throw new EyeFailure("template_size_mismatch");
                return EyePixels.Read(image, new Rectangle(0, 0, image.Width, image.Height));
            }
        }
        public object Detect(Bitmap image)
        {
            if (image.Width != width || image.Height != height) return Result("unknown", null, 0, "layout_size_mismatch");
            byte[] pixels = EyePixels.Read(image, region);
            double openDistance = EyePixels.Distance(pixels, open), closedDistance = EyePixels.Distance(pixels, closed);
            double best = Math.Min(openDistance, closedDistance), margin = Math.Abs(openDistance - closedDistance);
            string detail = String.Format(CultureInfo.InvariantCulture, "open_distance={0:F6};closed_distance={1:F6};margin={2:F6}", openDistance, closedDistance, margin);
            if (best > maximumDistance) return Result("unknown", null, 0, "template_distance_exceeded", detail);
            if (margin < minimumMargin) return Result("unknown", null, 0, "template_margin_insufficient", detail);
            return Result("known", openDistance < closedDistance, 1 - best, "calibrated_match", detail);
        }
        object Result(string status, object value, double confidence, string reason, string detail = null)
        { return EyeJson.Obj("status", status, "value", value, "confidence", confidence, "reason", EyeJson.Reason(reason, detail), "calibration_id", Id); }
        public static object Unsupported(string code)
        { return EyeJson.Obj("status", "unavailable", "value", null, "confidence", 0, "reason", EyeJson.Reason(code), "calibration_id", null); }
    }
}
