// One caller-owned raw Bitmap, scoped regions, bounded anchors and atomic CV.
// No capture, input, model, account or network access. C# 5 / Framework 4.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
namespace WowJev.Eye
{
    public sealed class RegionVision
    {
        readonly Dictionary<string, object> profile, context;
        readonly string directory, profileHash, scopeText;
        readonly List<Dictionary<string, object>> nodes = new List<Dictionary<string, object>>();
        readonly Dictionary<string, byte[]> templates = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        readonly Dictionary<string, Size> templateSizes = new Dictionary<string, Size>(StringComparer.Ordinal);
        readonly Dictionary<string, Cache> cache = new Dictionary<string, Cache>();
        sealed class Cache { public string Hash; public Rectangle Roi; public List<object> Elements; }
        static readonly Regex Id = new Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
        static readonly string[] ScopeKeys = { "branch", "expansion", "patch", "build", "region", "locale", "client_width", "client_height", "dpi", "ui_scale", "layout_id", "font_id", "addons_sha256" };
        public RegionVision(string profilePath, string contextPath)
        {
            if (contextPath == null) throw new EyeFailure("region_context_required");
            profile = EyeJson.Load(profilePath, 262144); context = EyeJson.Load(contextPath, 16384);
            EyeJson.Exact(profile, "version", "kind", "id", "scope", "regions");
            EyeJson.Int(profile, "version", 1, 1);
            if (EyeJson.Text(profile, "kind") != "regional-eye-profile") throw new EyeFailure("region_profile_kind");
            CheckId(EyeJson.Text(profile, "id"));
            ValidateScope(EyeJson.Map(profile["scope"])); ValidateScope(context);
            scopeText = ScopeText(EyeJson.Map(profile["scope"]));
            directory = Path.GetDirectoryName(Path.GetFullPath(profilePath)); profileHash = EyeJson.Hash(profilePath);
            HashSet<string> ids = new HashSet<string>(), fields = new HashSet<string>(); int total = 0; long anchorPixels = 0;
            object[] values = EyeJson.Need(profile, "regions") as object[];
            if (values == null || values.Length < 1 || values.Length > 32) throw new EyeFailure("region_count");
            int width = EyeJson.Int(EyeJson.Map(profile["scope"]), "client_width", 1, 65535), height = EyeJson.Int(EyeJson.Map(profile["scope"]), "client_height", 1, 65535);
            foreach (object item in values)
            {
                Dictionary<string, object> node = EyeJson.Map(item);
                EyeJson.Exact(node, "id", "module", "parent_id", "roi", "anchor", "visibility", "seed_allowed", "elements");
                string id = EyeJson.Text(node, "id"); CheckId(id); if (!ids.Add(id)) throw new EyeFailure("region_duplicate_id");
                string module = EyeJson.Text(node, "module");
                if (Array.IndexOf(new[] { "player", "target", "cast", "actionbar", "quest", "dialog", "inventory", "minimap", "blocking", "world" }, module) < 0) throw new EyeFailure("region_module");
                object parent = EyeJson.Need(node, "parent_id"); if (parent != null && (!(parent is string) || !ids.Contains((string)parent))) throw new EyeFailure("region_parent_order");
                if (!(EyeJson.Need(node, "seed_allowed") is bool)) throw new EyeFailure("region_seed_flag");
                Rectangle roi = Rect(EyeJson.Map(node["roi"]), width, height);
                if (node.ContainsKey("visibility")) ValidateBinary(EyeJson.Map(node["visibility"]), roi.Size);
                if (node.ContainsKey("anchor"))
                {
                    Dictionary<string, object> anchor = EyeJson.Map(node["anchor"]);
                    EyeJson.Exact(anchor, "template", "search", "step", "max_candidates", "max_distance", "min_margin");
                    string path = LoadTemplate(EyeJson.Map(anchor["template"]));
                    Rectangle search = Rect(EyeJson.Map(anchor["search"]), width, height); Size size = templateSizes[path];
                    int step = EyeJson.Int(anchor, "step", 1, 32), max = EyeJson.Int(anchor, "max_candidates", 1, 4096);
                    if (size.Width > search.Width || size.Height > search.Height ||
                        (1L + (search.Width - size.Width) / step) * (1L + (search.Height - size.Height) / step) > max) throw new EyeFailure("region_anchor_budget");
                    if ((anchorPixels += (long)size.Width * size.Height * max) > 33554432) throw new EyeFailure("region_anchor_pixel_budget");
                    Threshold(anchor, "max_distance", false); Threshold(anchor, "min_margin", true);
                }
                object[] elements = EyeJson.Need(node, "elements") as object[];
                if (elements == null || elements.Length > 16 || (total += elements.Length) > 64) throw new EyeFailure("region_element_budget");
                HashSet<string> elementIds = new HashSet<string>();
                foreach (object raw in elements)
                {
                    Dictionary<string, object> element = EyeJson.Map(raw);
                    EyeJson.Exact(element, "id", "field", "roi", "detector", "max_age_ms");
                    string eid = EyeJson.Text(element, "id"), field = EyeJson.Text(element, "field"); CheckId(eid); CheckId(field);
                    if (!elementIds.Add(eid) || !fields.Add(field)) throw new EyeFailure("region_duplicate_element_or_field");
                    Rectangle eroi = Rect(EyeJson.Map(element["roi"]), roi.Width, roi.Height);
                    EyeJson.Int(element, "max_age_ms", 1, 30000);
                    Dictionary<string, object> detector = EyeJson.Map(element["detector"]); string kind = EyeJson.Text(detector, "kind");
                    if (kind == "geometry") EyeJson.Exact(detector, "kind");
                    else if (kind == "ocr") { EyeJson.Exact(detector, "kind", "language"); CheckId(EyeJson.Text(detector, "language")); }
                    else if (kind == "template") { EyeJson.Exact(detector, "kind", "templates"); ValidateBinary(EyeJson.Map(detector["templates"]), eroi.Size); }
                    else if (kind == "template_labels")
                    {
                        EyeJson.Exact(detector, "kind", "candidates", "max_distance", "min_margin"); Threshold(detector,"max_distance",false); double margin = Threshold(detector,"min_margin",true);
                        object[] candidates = EyeJson.Need(detector,"candidates") as object[]; if(candidates == null || candidates.Length < 2 || candidates.Length > 16) throw new EyeFailure("region_template_label_count");
                        HashSet<string> labels = new HashSet<string>(); List<string> paths = new List<string>();
                        foreach(object c in candidates) { Dictionary<string,object> candidate=EyeJson.Map(c); EyeJson.Exact(candidate,"label","template"); string label=EyeJson.Text(candidate,"label"); if(label.Length>128 || !labels.Add(label)) throw new EyeFailure("region_template_label_duplicate"); string path=LoadTemplate(EyeJson.Map(candidate["template"])); if(templateSizes[path]!=eroi.Size) throw new EyeFailure("region_template_size");paths.Add(path); }
                        for(int i=0;i<paths.Count;i++)for(int j=i+1;j<paths.Count;j++)if(EyePixels.Distance(templates[paths[i]],templates[paths[j]])<margin)throw new EyeFailure("region_templates_inseparable");
                    }
                    else if (kind == "color_fraction" || kind == "fill_bar")
                    {
                        if (kind == "color_fraction") { EyeJson.Exact(detector, "kind", "color_min", "color_max", "minimum_fraction", "maximum_fraction"); if (Threshold(detector, "minimum_fraction", false) > Threshold(detector, "maximum_fraction", false)) throw new EyeFailure("region_color_thresholds"); }
                        else { EyeJson.Exact(detector, "kind", "color_min", "color_max", "axis", "reverse", "minimum_cross_fraction"); Threshold(detector, "minimum_cross_fraction", true); if (EyeJson.Text(detector, "axis") != "horizontal" && EyeJson.Text(detector, "axis") != "vertical" || !(EyeJson.Need(detector, "reverse") is bool)) throw new EyeFailure("region_bar_options"); }
                        int[] min = ColorList(detector, "color_min"), max = ColorList(detector, "color_max"); for (int c = 0; c < 3; c++) if (min[c] > max[c]) throw new EyeFailure("region_color_range");
                    }
                    else throw new EyeFailure("region_detector_unsupported");
                }
                nodes.Add(node);
            }
        }
        static void CheckId(string id) { if (!Id.IsMatch(id)) throw new EyeFailure("region_identifier"); }
        static void ValidateScope(Dictionary<string, object> scope)
        {
            EyeJson.Exact(scope, ScopeKeys); foreach (string key in ScopeKeys) EyeJson.Need(scope, key);
            foreach (string key in new[] { "branch", "expansion", "patch", "region", "locale", "layout_id", "font_id" }) CheckId(EyeJson.Text(scope, key));
            EyeJson.Int(scope, "build", 1, Int32.MaxValue); EyeJson.Int(scope, "client_width", 1, 65535); EyeJson.Int(scope, "client_height", 1, 65535); EyeJson.Int(scope, "dpi", 1, 960);
            double scale = EyeJson.Number(scope, "ui_scale"); if (scale <= 0 || scale > 4 || !Regex.IsMatch(EyeJson.Text(scope, "addons_sha256"), "^[a-f0-9]{64}$")) throw new EyeFailure("region_scope");
        }
        static string ScopeText(Dictionary<string, object> scope) { List<string> values = new List<string>(); foreach (string key in ScopeKeys) values.Add(key + "=" + Convert.ToString(scope[key], System.Globalization.CultureInfo.InvariantCulture)); return String.Join("|", values.ToArray()); }
        static double Threshold(Dictionary<string, object> map, string key, bool positive) { double v = EyeJson.Number(map, key); if (v < 0 || v > 1 || positive && v == 0) throw new EyeFailure("region_threshold"); return v; }
        static int[] ColorList(Dictionary<string, object> map, string key) { object[] list = EyeJson.Need(map, key) as object[]; if (list == null || list.Length != 3) throw new EyeFailure("region_color"); int[] output = new int[3]; for (int i = 0; i < 3; i++) { if (!(list[i] is int) || (int)list[i] < 0 || (int)list[i] > 255) throw new EyeFailure("region_color"); output[i] = (int)list[i]; } return output; }
        static Rectangle Rect(Dictionary<string, object> map, int width, int height) { EyeJson.Exact(map, "x", "y", "width", "height"); Rectangle r = new Rectangle(EyeJson.Int(map, "x", 0, width - 1), EyeJson.Int(map, "y", 0, height - 1), EyeJson.Int(map, "width", 1, width), EyeJson.Int(map, "height", 1, height)); if (r.Right > width || r.Bottom > height || (long)r.Width * r.Height > 4000000) throw new EyeFailure("region_roi_bounds"); return r; }
        static object RectJson(Rectangle r) { return EyeJson.Obj("x", r.X, "y", r.Y, "width", r.Width, "height", r.Height); }
        static string Hash(byte[] bytes) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        string LoadTemplate(Dictionary<string, object> spec)
        {
            EyeJson.Exact(spec, "path", "sha256"); string name = EyeJson.Text(spec, "path"), sha = EyeJson.Text(spec, "sha256");
            if (!Regex.IsMatch(name, "^[A-Za-z0-9_.-]+\\.png$") || name == ".png" || !Regex.IsMatch(sha, "^[a-f0-9]{64}$")) throw new EyeFailure("region_template_path");
            string path = Path.Combine(directory, name); FileInfo f = new FileInfo(path);
            if (!f.Exists || f.Length < 8 || f.Length > 4 * 1024 * 1024 || (f.Attributes & FileAttributes.ReparsePoint) != 0 || EyeJson.Hash(path) != sha) throw new EyeFailure("region_template_hash_or_file");
            if (!templates.ContainsKey(name)) using (Bitmap bitmap = new Bitmap(path))
            { if (bitmap.RawFormat.Guid != ImageFormat.Png.Guid || bitmap.Width * (long)bitmap.Height > 262144) throw new EyeFailure("region_template_format"); templateSizes[name] = bitmap.Size; templates[name] = EyePixels.Read(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height)); }
            return name;
        }
        void ValidateBinary(Dictionary<string, object> spec, Size size)
        {
            EyeJson.Exact(spec, "present", "absent", "occluded", "max_distance", "min_margin"); Threshold(spec, "max_distance", false); double margin = Threshold(spec, "min_margin", true); List<string> paths = new List<string>();
            foreach (string key in new[] { "present", "absent", "occluded" }) if (spec.ContainsKey(key)) { string path = LoadTemplate(EyeJson.Map(spec[key])); if (templateSizes[path] != size) throw new EyeFailure("region_template_size"); paths.Add(path); }
            if (!spec.ContainsKey("present")) throw new EyeFailure("region_template_present_required");
            for (int i = 0; i < paths.Count; i++) for (int j = i + 1; j < paths.Count; j++) if (EyePixels.Distance(templates[paths[i]], templates[paths[j]]) < margin) throw new EyeFailure("region_templates_inseparable");
        }
        string Binary(byte[] rgb, Dictionary<string, object> spec, out double confidence)
        {
            double best = Double.MaxValue, runner = Double.MaxValue; string selected = "unknown";
            foreach (string key in new[] { "present", "absent", "occluded" }) if (spec.ContainsKey(key)) { double distance = EyePixels.Distance(rgb, templates[EyeJson.Text(EyeJson.Map(spec[key]), "path")]); if (distance < best) { runner = best; best = distance; selected = key; } else runner = Math.Min(runner, distance); }
            confidence = 1 - best;
            return best <= EyeJson.Number(spec, "max_distance") && runner - best >= EyeJson.Number(spec, "min_margin") ? selected : "unknown";
        }
        Rectangle? Locate(Bitmap image, Dictionary<string, object> node, Rectangle parent, out string reason)
        {
            Dictionary<string, object> raw = EyeJson.Map(node["roi"]); Rectangle roi = Rect(raw, parent.Width, parent.Height); roi.Offset(parent.X, parent.Y); reason = "fixed_roi";
            if (!node.ContainsKey("anchor")) return roi;
            Dictionary<string, object> anchor = EyeJson.Map(node["anchor"]); Rectangle search = Rect(EyeJson.Map(anchor["search"]), parent.Width, parent.Height); search.Offset(parent.X, parent.Y);
            string path = EyeJson.Text(EyeJson.Map(anchor["template"]), "path"); Size size = templateSizes[path]; int step = EyeJson.Int(anchor, "step", 1, 32); double best = Double.MaxValue, runner = Double.MaxValue; Point selected = Point.Empty;
            for (int y = search.Y; y + size.Height <= search.Bottom; y += step) for (int x = search.X; x + size.Width <= search.Right; x += step) { double score = EyePixels.Distance(EyePixels.Read(image, new Rectangle(x, y, size.Width, size.Height)), templates[path]); if (score < best) { runner = best; best = score; selected = new Point(x, y); } else runner = Math.Min(runner, score); }
            if (best > EyeJson.Number(anchor, "max_distance") || runner - best < EyeJson.Number(anchor, "min_margin")) { reason = "anchor_missing_or_ambiguous"; return null; }
            roi = new Rectangle(selected.X + roi.X - parent.X, selected.Y + roi.Y - parent.Y, roi.Width, roi.Height);
            if (roi.Right > parent.Right || roi.Bottom > parent.Bottom) { reason = "anchor_roi_bounds"; return null; }
            reason = "anchor_verified"; return roi;
        }
        object ParseElement(Bitmap image, Dictionary<string, object> raw, Rectangle parent, string presence, long at, string frame)
        {
            Rectangle roi = Rect(EyeJson.Map(raw["roi"]), parent.Width, parent.Height); roi.Offset(parent.X, parent.Y);
            Dictionary<string, object> d = EyeJson.Map(raw["detector"]); string kind = EyeJson.Text(d, "kind"), status = "unknown", reason = "region_" + presence; object value = null; double confidence = 0;
            if (presence == "present")
            {
                if (kind == "geometry") { value = RectJson(roi); status = "known"; confidence = 1; reason = "geometry_observed"; }
                else if (kind == "ocr") { status = "unavailable"; reason = "local_ocr_required"; }
                else
                {
                    byte[] rgb = EyePixels.Read(image, roi);
                    if (kind == "template") { string matched = Binary(rgb, EyeJson.Map(d["templates"]), out confidence); if (matched == "present" || matched == "absent") { status = "known"; value = matched == "present"; reason = "template_matched"; } else reason = "element_" + matched; }
                    else if (kind == "template_labels")
                    {
                        double best=Double.MaxValue,runner=Double.MaxValue;string label=null;
                        foreach(object c in (object[])d["candidates"]) { Dictionary<string,object> candidate=EyeJson.Map(c);double distance=EyePixels.Distance(rgb,templates[EyeJson.Text(EyeJson.Map(candidate["template"]),"path")]);if(distance<best){runner=best;best=distance;label=EyeJson.Text(candidate,"label");}else runner=Math.Min(runner,distance); }
                        confidence=1-best;if(best<=EyeJson.Number(d,"max_distance") && runner-best>=EyeJson.Number(d,"min_margin")){status="known";value=label;reason="template_label_observed";}else reason="template_label_ambiguous";
                    }
                    else
                    {
                        int[] min = ColorList(d, "color_min"), max = ColorList(d, "color_max"); bool[] matches = new bool[rgb.Length / 3]; int total = 0;
                        for (int p = 0; p < matches.Length; p++) { bool yes = true; for (int c = 0; c < 3; c++) yes &= rgb[p * 3 + c] >= min[c] && rgb[p * 3 + c] <= max[c]; if (yes) total++; matches[p] = yes; }
                        if (kind == "color_fraction") { double fraction = total / (double)matches.Length; value = fraction >= EyeJson.Number(d, "minimum_fraction") && fraction <= EyeJson.Number(d, "maximum_fraction"); status = "known"; confidence = 1; reason = "color_fraction_observed"; }
                        else
                        {
                            bool horizontal = EyeJson.Text(d, "axis") == "horizontal", reverse = (bool)d["reverse"]; int axis = horizontal ? roi.Width : roi.Height, cross = horizontal ? roi.Height : roi.Width, filled = 0; bool hole = false, fragmented = false;
                            for (int a = 0; a < axis; a++) { int source = reverse ? axis - 1 - a : a, count = 0; for (int c = 0; c < cross; c++) if (matches[horizontal ? c * roi.Width + source : source * roi.Width + c]) count++; bool active = count / (double)cross >= EyeJson.Number(d, "minimum_cross_fraction"); if (!active) hole = true; else if (hole) fragmented = true; else filled++; }
                            if (fragmented) reason = "fill_bar_fragmented"; else { status = "known"; value = filled / (double)axis; confidence = 1; reason = "contiguous_fill_observed"; }
                        }
                    }
                }
            }
            else if (presence == "unsupported") status = "unavailable";
            return EyeJson.Obj("id", raw["id"], "field", raw["field"], "detector", kind, "roi", RectJson(roi), "status", status, "value", value, "confidence", confidence, "reason", reason, "parsed_at_qpc_ms", at, "source_frame_id", frame, "max_age_ms", raw["max_age_ms"]);
        }
        static bool Critical(Dictionary<string,object> node)
        {
            foreach(object raw in (object[])node["elements"]) {
                Dictionary<string,object> element=EyeJson.Map(raw); string field=EyeJson.Text(element,"field");
                if(field=="player.movement_mode" || field=="input.mouse_mode" || field=="ui.layout_id" || Array.IndexOf(new[]{"target.dead","target.alive","target.signature","target.hostile","target.attackable","target.lootable"},field)>=0 || field.StartsWith("combat.ability.") || field.StartsWith("dialog.") || field.StartsWith("navigation.") || field.StartsWith("hazard.") || field.StartsWith("loot.") || field.StartsWith("quest.")) return true;
            }
            return false;
        }
        public Dictionary<string, object> Detect(Bitmap image, string frame, long at, int actualDpi, string failure = null)
        {
            CheckId(frame); bool match = scopeText == ScopeText(context) && image.Width == (int)context["client_width"] && image.Height == (int)context["client_height"] && actualDpi == (int)context["dpi"];
            string reason = failure ?? (match ? "scope_matched" : "profile_scope_mismatch"); List<object> results = new List<object>(); Dictionary<string, Rectangle> located = new Dictionary<string, Rectangle>(); Dictionary<string, string> presences = new Dictionary<string, string>();
            foreach (Dictionary<string, object> node in nodes)
            {
                string id = (string)node["id"], parentId = node["parent_id"] as string, presence = "unknown", why = reason; Rectangle? roi = null; string hash = null; bool cached = false; List<object> elements = new List<object>();
                Rectangle parent = new Rectangle(0, 0, image.Width, image.Height);
                if (failure == null && match)
                {
                    if (parentId != null && (!located.ContainsKey(parentId) || presences[parentId] != "present")) why = "parent_not_present";
                    else
                    {
                        if (parentId != null) parent = located[parentId];
                        roi = Locate(image, node, parent, out why);
                        if (roi != null)
                        {
                            byte[] pixels = EyePixels.Read(image, roi.Value); hash = Hash(pixels);
                            if (node.ContainsKey("visibility")) { double confidence; presence = Binary(pixels, EyeJson.Map(node["visibility"]), out confidence); why = presence == "unknown" ? "visibility_ambiguous" : "visibility_verified"; }
                            else if (node.ContainsKey("anchor")) presence = "present";
                            else why = "layout_visibility_not_verified";
                            located[id] = roi.Value;
                        }
                    }
                }
                if (failure != null) presence = "unsupported";
                presences[id] = presence;
                if (roi != null)
                {
                    Cache prior;
                    if (presence == "present" && !Critical(node) && cache.TryGetValue(id, out prior) && prior.Hash == hash && prior.Roi == roi.Value) { elements = prior.Elements; cached = true; }
                    else { foreach (object raw in (object[])node["elements"]) elements.Add(ParseElement(image, EyeJson.Map(raw), roi.Value, presence, at, frame)); if (presence == "present") cache[id] = new Cache { Hash = hash, Roi = roi.Value, Elements = elements }; else cache.Remove(id); }
                }
                else cache.Remove(id);
                results.Add(EyeJson.Obj("id", id, "parent_id", parentId, "module", node["module"], "presence", presence, "reason", why, "roi", roi == null ? null : RectJson(roi.Value), "content_sha256", hash, "cached", cached, "pixels_verified_qpc_ms", at, "elements", elements));
            }
            // Verified blocking containers invalidate overlapped regions before publishing any atoms.
            foreach (object b in results) { Dictionary<string, object> blocker = EyeJson.Map(b); string bid = (string)blocker["id"]; if ((string)blocker["module"] != "blocking" || (string)blocker["presence"] != "present") continue;
                foreach (object r in results) { Dictionary<string, object> row = EyeJson.Map(r); string rid = (string)row["id"]; if (rid == bid || (string)row["presence"] != "present" || !located[bid].IntersectsWith(located[rid])) continue; row["presence"] = "occluded"; row["reason"] = "blocking_region_overlap"; row["cached"] = false; cache.Remove(rid); foreach (object e in (List<object>)row["elements"]) { Dictionary<string, object> atom = EyeJson.Map(e); atom["status"] = "unknown"; atom["value"] = null; atom["reason"] = "region_occluded"; atom["parsed_at_qpc_ms"] = at; atom["source_frame_id"] = frame; } }
            }
            // A hidden/covered container also invalidates its children, even outside the cover rectangle.
            Dictionary<string,string> finalPresence=new Dictionary<string,string>();
            foreach(object r in results) { Dictionary<string,object> row=EyeJson.Map(r);string id=(string)row["id"],parent=row["parent_id"] as string;
                if(parent!=null && finalPresence[parent]!="present") { row["presence"]=finalPresence[parent]=="occluded"?"occluded":"unknown"; row["reason"]="parent_not_present";row["cached"]=false;cache.Remove(id);foreach(object e in (List<object>)row["elements"]) { Dictionary<string,object> atom=EyeJson.Map(e);atom["status"]="unknown";atom["value"]=null;atom["reason"]="parent_not_present";atom["parsed_at_qpc_ms"]=at;atom["source_frame_id"]=frame; } }
                finalPresence[id]=(string)row["presence"];
            }
            if (!match || failure != null) cache.Clear();
            return EyeJson.Obj("version", 1, "kind", "regional-eye-batch", "profile_id", profile["id"], "profile_sha256", profileHash, "layout_id", EyeJson.Map(profile["scope"])["layout_id"], "frame_id", frame, "captured_at_qpc_ms", at, "frame_sha256", failure == null ? Hash(EyePixels.Read(image, new Rectangle(0, 0, image.Width, image.Height))) : null, "scope", context, "status", failure != null ? "unavailable" : match ? "ok" : "unknown", "reason", reason, "regions", results);
        }
        public int ContextDpi { get { return (int)context["dpi"]; } }
    }
}
