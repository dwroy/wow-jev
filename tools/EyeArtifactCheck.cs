// Actual Windows codecs and WinEye.Save exercised with one deterministic Bitmap.
// Reflection avoids opening a target window or constructing a capture server.
// No desktop capture, input, model, or credentials.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

static class EyeArtifactCheck
{
    static Type optionsType, serverType;
    static readonly BindingFlags Instance = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
    static readonly List<object> cases = new List<object>();
    static string root;
    static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    static string Hash(string file)
    { using (SHA256 hash = SHA256.Create()) using (Stream stream = File.OpenRead(file)) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static object Options(string format)
    {
        List<string> args = new List<string> { "serve", "--window", "0x1", "--expected-pid", "1", "--session", "11111111-1111-4111-8111-111111111111" };
        if (format != null) args.AddRange(new string[] { "--artifact-format", format });
        return optionsType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static).Invoke(null, new object[] { args.ToArray() });
    }
    static object Server(string name, string format)
    {
        object options = Options(format);
        string directory = Path.Combine(root, name); Directory.CreateDirectory(directory);
        string exported = Path.Combine(root, name + "-export");
        optionsType.GetField("ExportDirectory").SetValue(options, exported);
        object server = FormatterServices.GetUninitializedObject(serverType);
        serverType.GetField("options", Instance).SetValue(server, options);
        serverType.GetField("artifactRoot", Instance).SetValue(server, directory);
        return server;
    }
    static Dictionary<string, object> Save(object server, Bitmap image, long seq)
    { return (Dictionary<string, object>)serverType.GetMethod("Save", Instance).Invoke(server, new object[] { image, seq }); }
    static void Error(Action action, string code)
    {
        try { action(); }
        catch (TargetInvocationException error) { Require(error.InnerException.Message == code, "wrong_failure:" + error.InnerException.Message); return; }
        throw new Exception("missing_failure:" + code);
    }
    static void Record(string name, object result) { cases.Add(new Dictionary<string, object> { { "case", name }, { "ok", true }, { "result", result } }); }
    static void RoundTrip(Bitmap raw, string format)
    {
        object server = Server(format ?? "default", format);
        Dictionary<string, object> artifact = Save(server, raw, 0);
        string path = (string)artifact["windows_path"], exported = (string)artifact["exported_windows_path"];
        byte[] bytes = File.ReadAllBytes(path);
        bool png = format == "png";
        Require(Path.GetExtension(path) == (png ? ".png" : ".jpg"), "extension");
        Require(png ? bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 : bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255, "magic");
        Require(Hash(path) == (string)artifact["sha256"] && Hash(exported) == Hash(path), "sha_or_export");
        int changed = 0;
        using (Bitmap decoded = new Bitmap(exported))
        {
            Require(decoded.RawFormat.Guid == (png ? ImageFormat.Png.Guid : ImageFormat.Jpeg.Guid), "decoded_format");
            Require(decoded.Width == raw.Width && decoded.Height == raw.Height, "decoded_size");
            for (int y = 0; y < raw.Height; y++) for (int x = 0; x < raw.Width; x++) if (raw.GetPixel(x, y).ToArgb() != decoded.GetPixel(x, y).ToArgb()) changed++;
        }
        Require(png ? changed == 0 : changed > 0, "pixel_roundtrip");
        if (!png)
        {
            string expected = Path.Combine(root, "jpeg90-reference.jpg");
            ImageCodecInfo encoder = null; foreach (ImageCodecInfo item in ImageCodecInfo.GetImageEncoders()) if (item.MimeType == "image/jpeg") encoder = item;
            using (EncoderParameters parameters = new EncoderParameters(1))
            { parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L); raw.Save(expected, encoder, parameters); }
            Require(Hash(path) == Hash(expected), "default_jpeg90_changed");
        }
        Record(png ? "png_exact_pixels_and_export" : "default_jpeg90_compatible", new Dictionary<string, object> { { "artifact", artifact }, { "changed_pixels", changed } });
    }
    static void Quotas(Bitmap image)
    {
        string mixed = Path.Combine(root, "mixed"); Directory.CreateDirectory(mixed);
        for (int i = 0; i < 127; i++) File.WriteAllBytes(Path.Combine(mixed, i + (i % 2 == 0 ? ".PNG" : ".jpg")), new byte[] { 1 });
        object server = Server("mixed", "png"); Save(server, image, 1);
        Require(Directory.GetFiles(mixed).Length == 128, "mixed_128th_save");
        Error(delegate { Save(server, image, 2); }, "artifact_quota_exceeded");
        // A fresh default-JPEG server must count existing PNG files too.
        Error(delegate { Save(Server("mixed", null), image, 3); }, "artifact_quota_exceeded");
        Require(Directory.GetFiles(mixed).Length == 128, "quota_keeps_existing_files");
        Record("mixed_format_file_quota_and_restart", 128);
        string total = Path.Combine(root, "total"); Directory.CreateDirectory(total);
        foreach (string extension in new string[] { ".jpg", ".png" }) using (FileStream file = File.Create(Path.Combine(total, "prior" + extension))) file.SetLength(64L * 1024 * 1024);
        Error(delegate { Save(Server("total", "png"), image, 0); }, "artifact_quota_exceeded");
        Require(Directory.GetFiles(total).Length == 2, "total_quota_cleanup");
        Directory.Delete(total, true);
        Record("mixed_format_byte_quota", 128L * 1024 * 1024);
        object near = Server("near", "png");
        serverType.GetField("savedFiles", Instance).SetValue(near, 1);
        serverType.GetField("savedBytes", Instance).SetValue(near, 128L * 1024 * 1024 - 1);
        Error(delegate { Save(near, image, 0); }, "artifact_quota_exceeded");
        Require(Directory.GetFiles(Path.Combine(root, "near")).Length == 0, "overlimit_partial_file_kept");
        Record("encoding_over_total_limit_removes_partial", true);
    }
    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || Directory.Exists(args[1])) throw new Exception("new_output_and_exe_required");
            root = Path.GetFullPath(args[1]); Directory.CreateDirectory(root);
            Type eye = Assembly.Load(File.ReadAllBytes(args[0])).GetType("WinEye", true);
            optionsType = eye.GetNestedType("Options", BindingFlags.NonPublic); serverType = eye.GetNestedType("Server", BindingFlags.NonPublic);
            foreach (string invalid in new string[] { "jpg", "PNG", "gif", "" }) Error(delegate { Options(invalid); }, "invalid_artifact_format");
            Record("invalid_formats_reject_before_window", 4);
            using (Bitmap image = new Bitmap(97, 83, PixelFormat.Format24bppRgb))
            {
                for (int y = 0; y < image.Height; y++) for (int x = 0; x < image.Width; x++) image.SetPixel(x, y,
                    (x + y) % 5 == 0 ? Color.FromArgb(230, 185, 5) : Color.FromArgb((x * 31 + y * 47) % 256, (x * 13 + y * 61) % 256, (x * 53 + y * 19) % 256));
                RoundTrip(image, null); RoundTrip(image, "png"); Quotas(image);
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "ok", true }, { "scope", "actual_windows_codecs_one_synthetic_bitmap" }, { "capture", false }, { "input", false }, { "model", false }, { "cases", cases } }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
