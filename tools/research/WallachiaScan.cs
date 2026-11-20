using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Standalone Windows reader for the same public ID manifest as screen-wallachia-folder.py.
internal static class WallachiaScan
{
    private const string ResultName = "wallachia-folder-result";
    private const string ManifestDigest = "ec9c331975ade2b640667902d0920743e699ec2827fa28e9817e741ff24c9f3b";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private static readonly Regex Seasons = new Regex(@"\bwallachia[\s#:_-]*(?:season|сезон|s)?[\s#:_-]*([345])(?!\d)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> SkipDirs = Set(".git .venv node_modules .pnpm .pnpm-store pnpm-store corepack pgsql pgdata postgres-data dist __pycache__ .aws .ssh .codex");
    private static readonly HashSet<string> Formats = Set(".json .jsonl .ndjson .csv .md .txt .log .sql .yaml .yml .ts .js .mjs .ps1 .py .html .xml .tsv .ipynb");
    private static readonly HashSet<string> Archives = Set(".zip .7z .rar .gz .tar .bak .dump .sqlite .db");
    private static HashSet<string> Set(string list) { return new HashSet<string>(list.Split(' '), StringComparer.OrdinalIgnoreCase); }
    private static string Sha(byte[] bytes)
    {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static bool FileError(Exception e) { return e is IOException || e is UnauthorizedAccessException || e is System.Security.SecurityException; }

    private sealed class Manifest
    {
        public string[] maps { get; set; }
        public string[] openDotaSeries { get; set; }
        public string[] pandaScoreMeetings { get; set; }
    }

    private sealed class Report
    {
        public string format { get { return "wallachia-folder-screen-v1"; } }
        public string manifestSha256 { get { return ManifestDigest; } }
        public bool globalInventoryComplete { get { return false; } }
        public Dictionary<string,int> counts { get; private set; }
        public List<object> hits { get; private set; }
        public List<object> unread { get; private set; }
        public List<string> archivesForReview { get; private set; }
        public Report()
        {
            counts = new Dictionary<string,int> { { "textFiles", 0 } };
            hits = new List<object>(); unread = new List<object>(); archivesForReview = new List<string>();
        }
        public void Count(string name)
        {
            int n; counts.TryGetValue(name, out n); counts[name] = n + 1;
        }
    }

    private static Report Scan(string input)
    {
        string root = new DirectoryInfo(input).FullName;
        if (!Directory.Exists(root) || root.TrimEnd('\\') == Path.GetPathRoot(root).TrimEnd('\\'))
            throw new IOException("Выберите существующую папку проекта.");
        var prefix = root.TrimEnd('\\') + "\\";
        Manifest targets;
        using (var manifest = Assembly.GetExecutingAssembly().GetManifestResourceStream("targets.json"))
        using (var buffer = new MemoryStream())
        {
            manifest.CopyTo(buffer);
            var bytes = buffer.ToArray();
            if (Sha(bytes) != ManifestDigest) throw new InvalidDataException("Контрольная сумма списка ID не совпала.");
            targets = Json.Deserialize<Manifest>(Encoding.UTF8.GetString(bytes));
        }
        // Boundaries also reject an ID embedded in a longer decimal number.
        var pattern = new Regex(@"(?<![0-9])(?:" + String.Join("|", targets.maps.Concat(targets.openDotaSeries).Concat(targets.pandaScoreMeetings).Distinct()) + @")(?![0-9])", RegexOptions.Compiled);
        var report = new Report();
        var pending = new Stack<string>(); pending.Push(root);
        var progress = System.Diagnostics.Stopwatch.StartNew();
        while (pending.Count > 0)
        {
            string dir = pending.Pop();
            string[] entries;
            try { entries = Directory.GetFileSystemEntries(dir); }
            catch (Exception e)
            {
                if (!FileError(e)) throw;
                report.unread.Add(new { path = dir.Length < prefix.Length ? "." : dir.Substring(prefix.Length).Replace('\\','/'), reason = e.GetType().Name });
                continue;
            }
            Array.Sort(entries, StringComparer.OrdinalIgnoreCase);
            foreach (string file in entries)
            {
                string relative = file.Substring(prefix.Length).Replace('\\','/');
                try
                {
                    var attrs = File.GetAttributes(file);
                    if ((attrs & FileAttributes.ReparsePoint) != 0) { report.Count("linkSkipped"); continue; }
                    string name = Path.GetFileName(file).ToLowerInvariant();
                    if ((attrs & FileAttributes.Directory) != 0)
                    {
                        if (SkipDirs.Contains(name)) report.Count("directoriesSkipped"); else pending.Push(file);
                        continue;
                    }
                    if (name.StartsWith(".env") || new[] {"credential","secret","passwd","password","token"}.Any(name.Contains))
                    { report.Count("sensitiveSkipped"); continue; }
                    if (name == "wallachia-archive-targets.json" || Regex.IsMatch(name, @"^wallachia-folder-result(?:-[0-9]+)?\.json$")) continue;
                    string ext = Path.GetExtension(name);
                    if (Archives.Contains(ext)) { report.archivesForReview.Add(relative); continue; }
                    if (!Formats.Contains(ext)) { report.Count("otherFormat"); continue; }
                    if (new FileInfo(file).Length > 48 * 1024 * 1024) { report.unread.Add(new { path = relative, reason = "sizeLimit" }); continue; }
                    var data = File.ReadAllBytes(file);
                    Encoding codec = new UTF8Encoding(false, true);
                    if (data.Length >= 2 && data[0] == 255 && data[1] == 254) codec = new UnicodeEncoding(false, true, true);
                    if (data.Length >= 2 && data[0] == 254 && data[1] == 255) codec = new UnicodeEncoding(true, true, true);
                    string body = codec.GetString(data);
                    if (body.IndexOf('\0') >= 0) { report.unread.Add(new { path = relative, reason = "binary" }); continue; }
                    report.Count("textFiles");
                    var numbers = new HashSet<string>(pattern.Matches(body).Cast<Match>().Select(m => m.Value));
                    var editions = Seasons.Matches(body).Cast<Match>().Select(m => m.Groups[1].Value).Distinct().OrderBy(s => s).ToArray();
                    if (numbers.Count != 0 || editions.Length != 0)
                        report.hits.Add(new { path = relative, sha256 = Sha(data), maps = targets.maps.Where(numbers.Contains).ToArray(),
                            openDotaSeries = targets.openDotaSeries.Where(numbers.Contains).ToArray(),
                            pandaScoreMeetings = targets.pandaScoreMeetings.Where(numbers.Contains).ToArray(), editionNames = editions });
                }
                catch (Exception e)
                {
                    if (!FileError(e) && !(e is DecoderFallbackException)) throw;
                    report.unread.Add(new { path = relative, reason = e.GetType().Name });
                }
                if (progress.Elapsed.TotalSeconds >= 5)
                { Console.WriteLine("Проверено текстовых файлов: " + report.counts["textFiles"]); progress.Restart(); }
            }
        }
        return report;
    }

    private static string Save(Report report, string outputDirectory)
    {
        // Place the finished document atomically. Repeated runs keep previous reports.
        string temp = Path.Combine(outputDirectory, Guid.NewGuid().ToString("N") + ".tmp");
        using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            try
            {
                using (var writer = new StreamWriter(file, new UTF8Encoding(false), 4096, true)) writer.WriteLine(Json.Serialize(report));
            }
            catch { file.Close(); File.Delete(temp); throw; }
        }
        try
        {
            for (int i = 0; ; i++)
            {
                string dest = Path.Combine(outputDirectory, ResultName + (i == 0 ? "" : "-" + i) + ".json");
                try { File.Move(temp, dest); return dest; }
                catch (IOException) { if (!File.Exists(dest)) throw; }
            }
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        bool interactive = args.Length == 0;
        try
        {
            if (args.Length > 2) throw new ArgumentException("WallachiaScan.exe [папка проекта] [папка для отчёта]");
            string input;
            if (interactive)
            {
                using (var dialog = new FolderBrowserDialog { Description = "Выберите папку старого проекта Dota 2", ShowNewFolderButton = false })
                {
                    if (dialog.ShowDialog() != DialogResult.OK) return 2;
                    input = dialog.SelectedPath;
                }
            }
            else input = args[0];
            Console.WriteLine("Идёт проверка папки " + input);
            var report = Scan(input);
            string directory = args.Length == 2 ? Path.GetFullPath(args[1]) : AppDomain.CurrentDomain.BaseDirectory;
            string output;
            try { output = Save(report, directory); }
            catch (Exception e)
            {
                if (!interactive || !FileError(e)) throw;
                using (var dialog = new FolderBrowserDialog { Description = "В папку программы записать не удалось. Выберите папку для готового JSON." })
                {
                    if (dialog.ShowDialog() != DialogResult.OK) throw;
                    output = Save(report, dialog.SelectedPath);
                }
            }
            string message = "Проверено текстовых файлов: " + report.counts["textFiles"] +
                ". Файлов с совпадениями: " + report.hits.Count + ".\n\nОтчёт сохранён:\n" + output;
            Console.WriteLine(message);
            if (interactive) MessageBox.Show(message, "Проверка BO3 завершена", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            if (interactive) MessageBox.Show(e.Message, "Не удалось сохранить отчёт BO3", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
