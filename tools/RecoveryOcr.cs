using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

// No model call and no OCR text dump. Only state/character allowlist terms leave
// this method; account names, chat, passwords, and arbitrary recognized text do not.
static class RecoveryOcr
{
    internal static readonly string[] Terms = {
        "小啊", "战士", "联盟", "进入魔兽世界", "进入游戏", "开始游戏", "魔兽世界",
        "与吉安娜·普罗德摩尔交谈", "吉安娜·普罗德摩尔", "吉安娜", "普罗德摩尔", "与吉安娜", "交谈", "接受", "完成任务", "继续", "再见", "关闭", "战斗训练", "重连", "重新连接", "断开连接", "断线", "已断开", "连接丢失", "登录", "登陆",
        "账号", "帐号", "密码", "验证码", "验证", "身份验证", "安全令牌", "协议", "同意", "许可", "更新", "安装", "下载", "修复", "扫描", "排队", "加载", "取消",
        "Play", "Reconnect", "Disconnected", "Password", "Authenticator", "Verification", "Agreement", "Update", "Install", "Download" };
    internal static Dictionary<string, object> Read(string path)
    {
        try { return ReadFile(path); }
        catch { return InteractiveSessionHost.Obj("status", "unknown", "reason", "windows_builtin_ocr_unavailable", "items", new object[0], "raw_text_retained", false); }
    }
    static T Await<T>(IAsyncOperation<T> operation)
    {
        var watch=System.Diagnostics.Stopwatch.StartNew();
        while(operation.Status==AsyncStatus.Started){if(watch.ElapsedMilliseconds>5000){operation.Cancel();throw new TimeoutException();}Thread.Sleep(10);}
        return operation.GetResults();
    }
    static Dictionary<string, object> ReadFile(string path)
    {
        var allTerms=new HashSet<string>(Terms,StringComparer.OrdinalIgnoreCase);
        var protocol=MapProtocol(new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(System.IO.File.ReadAllText(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"session-recovery-v1.schema.json"))));
        var definitions=MapProtocol(protocol["definitions"]);
        foreach(string name in new string[]{"blocked_auth_token","blocked_terms_token","blocked_update_token"})foreach(object token in (object[])MapProtocol(definitions[name])["enum"])allTerms.Add((string)token);
        OcrEngine engine = OcrEngine.TryCreateFromLanguage(new Language("zh-Hans"));
        if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) return InteractiveSessionHost.Obj("status", "unknown", "reason", "ocr_language_pack_unavailable", "items", new object[0], "raw_text_retained", false);
        StorageFile file = Await(StorageFile.GetFileFromPathAsync(path));
        using (IRandomAccessStream stream = Await(file.OpenAsync(FileAccessMode.Read)))
        {
            BitmapDecoder decoder = Await(BitmapDecoder.CreateAsync(stream));
            using (SoftwareBitmap bitmap = Await(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore)))
            {
                OcrResult result = Await(engine.RecognizeAsync(bitmap));
                var items = new List<object>();
                foreach (OcrLine line in result.Lines)
                {
                    // Join neighboring OCR words to tolerate Chinese word segmentation.
                    string normalized = line.Text.Replace(" ", "").Replace("·", "");
                    foreach (string term in allTerms)
                    {
                        if (normalized.IndexOf(term.Replace(" ", "").Replace("·", ""), StringComparison.OrdinalIgnoreCase) < 0) continue;
                        double left = Double.MaxValue, top = Double.MaxValue, right = 0, bottom = 0;
                        foreach (OcrWord word in line.Words)
                        {
                            var box = word.BoundingRect;
                            left = Math.Min(left, box.X); top = Math.Min(top, box.Y);
                            right = Math.Max(right, box.X + box.Width); bottom = Math.Max(bottom, box.Y + box.Height);
                        }
                        if (left != Double.MaxValue) items.Add(InteractiveSessionHost.Obj("text", term, "x", (int)left, "y", (int)top,
                            "width", (int)Math.Ceiling(right-left), "height", (int)Math.Ceiling(bottom-top), "box_scope", "matched_line", "matching", "whitelist_normalized_substring"));
                    }
                }
                return InteractiveSessionHost.Obj("status", "available", "language", engine.RecognizerLanguage.LanguageTag,
                    "items", items, "raw_text_retained", false, "box_scope", "matched_line", "credential_text_retained", false);
            }
        }
    }
    static Dictionary<string,object> MapProtocol(object value){return (Dictionary<string,object>)value;}
}

// Fixed-layout visual identity, reviewed local game evidence. Each critical
// subregion must match independently, so a large background cannot hide a wrong
// name, class, faction emblem, or selection state.
public static class RecoveryCalibration
{
    static System.Collections.Generic.Dictionary<string, object> Map(object value) { return (System.Collections.Generic.Dictionary<string, object>)value; }
    static int Integer(System.Collections.Generic.Dictionary<string,object> value,string key) { return Convert.ToInt32(value[key]); }
    static string Sha(string path) { using(var file=System.IO.File.OpenRead(path))using(var hash=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant(); }
    public static Dictionary<string, object> Match(System.Drawing.Bitmap image,string fixedDirectory)
    {
        var unknown=InteractiveSessionHost.Obj("verified",false,"source","calibrated_cv","reason","calibration_unknown");
        try
        {
            string profilePath=System.IO.Path.Combine(fixedDirectory,"selected-alliance-warrior.json");
            string referencePath=System.IO.Path.Combine(fixedDirectory,"selected-alliance-warrior.png");
            var profile=Map(new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(System.IO.File.ReadAllText(profilePath,System.Text.Encoding.UTF8)));
            var layout=Map(profile["layout"]);var reference=Map(profile["reference"]);var referenceRect=Map(reference["rect"]);
            string calibrationHash=Sha(profilePath);string referenceHash=Sha(referencePath);
            unknown["calibration_sha256"]=calibrationHash;unknown["reference_sha256"]=referenceHash;unknown["layout_width"]=Integer(layout,"width");unknown["layout_height"]=Integer(layout,"height");
            if(image.Width!=Integer(layout,"width")||image.Height!=Integer(layout,"height")){unknown["reason"]="calibration_layout_mismatch";return unknown;}
            if((string)reference["file"]!="selected-alliance-warrior.png"||(string)reference["sha256"]!=referenceHash){unknown["reason"]="calibration_reference_hash_changed";return unknown;}
            var scores=new List<object>();bool verified=true;var found=new HashSet<string>();
            using(var template=new System.Drawing.Bitmap(referencePath))
            {
                if(template.Width!=Integer(referenceRect,"width")||template.Height!=Integer(referenceRect,"height")){unknown["reason"]="calibration_reference_dimensions";return unknown;}
                foreach(object row in (object[])profile["regions"])
                {
                    var region=Map(row);string id=(string)region["id"];if(!found.Add(id)){unknown["reason"]="calibration_duplicate_region";return unknown;}var rect=Map(region["rect"]);
                    int x=Integer(rect,"x"),y=Integer(rect,"y"),width=Integer(rect,"width"),height=Integer(rect,"height"),rx=x-Integer(referenceRect,"x"),ry=y-Integer(referenceRect,"y");
                    if(width<=0||height<=0||x<0||y<0||x+width>image.Width||y+height>image.Height||rx<0||ry<0||rx+width>template.Width||ry+height>template.Height){unknown["reason"]="calibration_region_out_of_bounds";return unknown;}
                    long sum=0,above=0;for(int yy=0;yy<height;yy++)for(int xx=0;xx<width;xx++)
                    {
                        var live=image.GetPixel(x+xx,y+yy);var original=template.GetPixel(rx+xx,ry+yy);
                        int r=Math.Abs(live.R-original.R),g=Math.Abs(live.G-original.G),b=Math.Abs(live.B-original.B);sum+=r+g+b;if(Math.Max(r,Math.Max(g,b))>24)above++;
                    }
                    double mean=(double)sum/(width*height*3),fraction=(double)above/(width*height);double maxMean=Convert.ToDouble(region["max_mean_abs_error"]),maxFraction=Convert.ToDouble(region["max_fraction_above_24"]);
                    bool matched=mean<=maxMean&&fraction<=maxFraction;verified&=matched;scores.Add(InteractiveSessionHost.Obj("region",id,"mean_abs_error",mean,"fraction_above_24",fraction,"max_mean_abs_error",maxMean,"max_fraction_above_24",maxFraction,"matched",matched));
                }
            }
            verified&=found.SetEquals(new string[]{"selected_card","name","class","alliance_glyph"});var character=Map(profile["character"]);
            verified&=(string)character["name"]=="小啊"&&(string)character["class"]=="warrior"&&(string)character["faction"]=="alliance";
            unknown["verified"]=verified;unknown["reason"]=verified?"calibrated_regions_match":"calibration_region_mismatch";unknown["regions"]=scores;
            if(verified){unknown["name"]="小啊";unknown["class"]="warrior";unknown["faction"]="alliance";if(profile.ContainsKey("safe_focus_point"))unknown["safe_focus_point"]=profile["safe_focus_point"];}return unknown;
        }
        catch { return unknown; }
    }
}
