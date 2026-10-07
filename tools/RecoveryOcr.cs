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
public static class RecoveryOcr
{
    internal static readonly string[] Terms = {
        "小呵", "战士", "联盟", "进入魔兽世界", "进入游戏", "开始游戏", "魔兽世界",
        "与吉安娜·普罗德摩尔交谈", "吉安娜·普罗德摩尔", "吉安娜", "普罗德摩尔", "与吉安娜", "交谈", "接受", "拒绝", "完成", "完成任务", "继续", "再见", "关闭", "热身", "作战假人", "0/1摧毁作战假人", "1/1摧毁作战假人", "战斗训练", "重连", "重新连接", "断开连接", "断线", "已断开", "连接丢失", "登录", "登陆",
        "账号", "帐号", "密码", "验证码", "验证", "身份验证", "安全令牌", "协议", "同意", "许可", "更新", "安装", "下载", "修复", "扫描", "排队", "加载", "取消",
        "Play", "Reconnect", "Disconnected", "Password", "Authenticator", "Verification", "Agreement", "Update", "Install", "Download" };
    public static Dictionary<string, object> Read(string path)
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
        foreach(string name in new string[]{"blocked_auth_token","blocked_terms_token","blocked_update_token","auth_context_token","reconnect_state_token"})foreach(object token in (object[])MapProtocol(definitions[name])["enum"])allTerms.Add((string)token);
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

// The same cached, resolution-aware CV implementation serves both the one-shot
// recovery bridge and the persistent play host. Per-frame work is ROI-only.
public static class RecoveryCalibration
{
    public static Dictionary<string, object> Match(System.Drawing.Bitmap image, string fixedDirectory)
    { return RecoveryCvProfile.Selection(image, fixedDirectory); }
}
