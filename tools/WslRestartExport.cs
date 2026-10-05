using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

static partial class WslRestartAcceptance
{
    static string ProductionNativeRoot;
    static string ExportRoot, RepoWsl = "/home/dai/Projects/wow-jev";
    static string WslUnc(string linux) { return "\\\\wsl.localhost\\Ubuntu" + linux.Replace('/', '\\'); }
    static string UncLinux(string path)
    {
        var match = Regex.Match(path, "^\\\\\\\\(?:wsl\\.localhost|wsl\\$)\\\\Ubuntu\\\\(.+)\\z", RegexOptions.IgnoreCase);
        Require(match.Success && !path.Contains("\\..\\") && !path.Contains("\\.\\"), "explicit_ubuntu_unc_export_required");
        return "/" + match.Groups[1].Value.Replace('\\', '/');
    }
    static void NoReparseDirectory(string path)
    {
        string current = path;
        while (Directory.Exists(current))
        {
            Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "directory_reparse_rejected");
            string parent = Path.GetDirectoryName(current); if (String.IsNullOrEmpty(parent) || parent == current) break; current = parent;
        }
    }
    static object CopyVerified(string source, string target)
    {
        FileInfo original = new FileInfo(source); Require(original.Exists && original.Length <= 32 * 1024 * 1024 && (original.Attributes & FileAttributes.ReparsePoint) == 0, "copy_source_invalid");
        NoReparseDirectory(Path.GetDirectoryName(source)); NoReparseDirectory(Path.GetDirectoryName(target));
        string expected = Hash(source); long length = original.Length;
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        if (File.Exists(target)) Require(new FileInfo(target).Length == length && Hash(target) == expected && (File.GetAttributes(target) & FileAttributes.ReparsePoint) == 0, "export_existing_file_changed");
        else File.Copy(source, target, false);
        Require(new FileInfo(target).Length == length && Hash(target) == expected && new FileInfo(source).Length == length && Hash(source) == expected, "copy_length_or_hash_mismatch");
        return Obj("source", source, "target", target, "length", length, "sha256", expected);
    }
    static void PrepareExport(string primary)
    {
        if (ExportRoot == null) return;
        UncLinux(ExportRoot); Require(!Directory.Exists(ExportRoot) && !File.Exists(ExportRoot), "export_directory_must_be_new");
        NoReparseDirectory(Path.GetDirectoryName(ExportRoot)); Directory.CreateDirectory(ExportRoot);
        Export(primary, "preflight");
    }
    static void Export(string primary, string phase)
    {
        if (ExportRoot == null) return;
        var entries = new List<object>();
        foreach (string source in Directory.GetFiles(primary, "*", SearchOption.AllDirectories))
        {
            string relative = source.Substring(primary.TrimEnd('\\').Length + 1);
            // Earlier ACKs are immutable. Controller's mutable exchange directory stays separate.
            string target = Path.Combine(ExportRoot, relative); entries.Add(CopyVerified(source, target));
        }
        string ack = Path.Combine(primary, "export-ack-" + phase + ".json");
        Save(ack, Obj("schema_version", 1, "type", "explicit_export_ack", "primary_root", primary, "primary_domain", "windows_local",
            "export_root", ExportRoot, "export_domain", "wsl_unc", "entries", entries, "acknowledged_windows_qpc_ms", Qpc()));
        CopyVerified(ack, Path.Combine(ExportRoot, Path.GetFileName(ack)));
    }
    static void ControllerEvidence(string primary, string mode, bool beforeRestart)
    {
        string exchange = Path.Combine(ExportRoot, "controller");
        foreach (string source in Directory.GetFiles(exchange, mode + "-*", SearchOption.TopDirectoryOnly))
        {
            string name = Path.GetFileName(source);
            if (beforeRestart && (name.EndsWith(".jsonl") || name.EndsWith(".stderr"))) name = name.Insert(name.LastIndexOf('.'), "-before-restart");
            string target = Path.Combine(primary, name);
            if (!File.Exists(target)) CopyVerified(source, target);
        }
    }
    static void VerifyClientSource(string primary)
    {
        var expected = Map(Need(Map(Need(Load(Path.Combine(primary, "preflight.json")), "binaries")), "wsl_controller_production_sources"));
        foreach (var item in expected)
            Require(Hash(Path.Combine(WslUnc(RepoWsl), item.Key.Replace('/', '\\'))) == Text(Map(item.Value), "sha256"), "production_source_changed_after_preflight");
        var binaries = Map(Need(Load(Path.Combine(primary, "preflight.json")), "binaries"));
        foreach (string file in new[] { "WinInput.exe", "WinInputWatchdog.exe" }) Require(Hash(Path.Combine(ProductionNativeRoot, file)) == Text(Map(binaries[file]), "sha256"), "production_binary_changed_after_preflight");
    }
    static void FreezeClientSource(string frozen, Dictionary<string, object> binaries)
    {
        Require(Regex.IsMatch(RepoWsl, "^/[A-Za-z0-9/._-]{1,2048}\\z") && !RepoWsl.Contains("/../"), "absolute_repo_wsl_required");
        var source = new Dictionary<string, object>();
        foreach (string relative in new[] { "agent/src/hand/client.ts", "agent/src/hand/protocol.ts", "agent/src/core/process.ts", "agent/package-lock.json" })
            source[relative] = Obj("sha256", Hash(Path.Combine(WslUnc(RepoWsl), relative.Replace('/', '\\'))));
        string schema = Path.Combine(WslUnc(RepoWsl), "protocol", "native-input-v1.schema.json"), target = Path.Combine(frozen, "native-input-v1.schema.json");
        CopyVerified(schema, target); binaries["native-input-v1.schema.json"] = Obj("sha256", Hash(target), "file", "native/native-input-v1.schema.json");
        binaries["wsl_controller_production_sources"] = source;
    }
}
