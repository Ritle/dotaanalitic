"""Screen a supplied project folder for identifiers. Output contains no matching lines."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def scan(folder, manifest, output):
    root = folder.resolve(strict=True)
    if not root.is_dir() or root == Path(root.anchor):
        raise ValueError("Supply a project directory")
    if output.exists():
        raise FileExistsError(output.name)
    raw = manifest.read_bytes()
    targets = json.loads(raw)
    keys = ["maps", "openDotaSeries", "pandaScoreMeetings"]
    ids = {k: set(targets[k]) for k in keys}
    assert targets["format"] == "wallachia-archive-targets-v1"
    assert all(re.fullmatch(r"[1-9][0-9]{5,10}", n) for group in ids.values() for n in group)
    patterns = re.compile(r"(?<![0-9])[1-9][0-9]{5,10}(?![0-9])")
    edition = re.compile(r"\bwallachia[\s#:_-]*(?:season|сезон|s)?[\s#:_-]*([345])(?!\d)", re.I)
    skip_dirs = {".git", ".venv", "node_modules", ".pnpm", ".pnpm-store", "pnpm-store", "corepack",
                 "pgsql", "pgdata", "postgres-data", "dist", "__pycache__", ".aws", ".ssh", ".codex"}
    formats = {".json", ".jsonl", ".ndjson", ".csv", ".md", ".txt", ".log", ".sql", ".yaml", ".yml",
               ".ts", ".js", ".mjs", ".ps1", ".py", ".html", ".xml", ".tsv", ".ipynb"}
    skip_files = {manifest.resolve(), Path(__file__).resolve(), output.resolve()}
    counts = Counter()
    hits, issues, archives = [], [], []

    def relative(path):
        return path.relative_to(root).as_posix()

    def denied(exc):
        issues.append({"path": relative(Path(exc.filename)), "reason": type(exc).__name__})

    def can_read(p):
        try:
            meta = p.lstat()
        except OSError as exc:
            denied(exc)
            return False
        if stat.S_ISLNK(meta.st_mode) or getattr(meta, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            counts["linkSkipped"] += 1
            return False
        return True

    for base, dirs, files in os.walk(root, onerror=denied, followlinks=False):
        directory = Path(base)
        kept = [d for d in sorted(dirs) if d.lower() not in skip_dirs and can_read(directory / d)]
        counts["directoriesSkipped"] += len(dirs) - len(kept)
        dirs[:] = kept
        for name in sorted(files):
            path = directory / name
            low = name.lower()
            if low.startswith(".env") or any(s in low for s in ("credential", "secret", "passwd", "password", "token")):
                counts["sensitiveSkipped"] += 1
                continue
            if not can_read(path) or path in skip_files:
                continue
            if path.suffix.lower() in {".zip", ".7z", ".rar", ".gz", ".tar", ".bak", ".dump", ".sqlite", ".db"}:
                archives.append(relative(path))
                continue
            if path.suffix.lower() not in formats:
                counts["otherFormat"] += 1
                continue
            try:
                if path.stat().st_size > 48 * 1024 * 1024:
                    issues.append({"path": relative(path), "reason": "sizeLimit"})
                    continue
                data = path.read_bytes()
                encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
                body = data.decode(encoding)
                if "\x00" in body:
                    raise ValueError("binary")
            except (OSError, UnicodeError, ValueError) as exc:
                issues.append({"path": relative(path), "reason": type(exc).__name__})
                continue
            counts["textFiles"] += 1
            nums = set(patterns.findall(body))
            found = {k: sorted(nums & group) for k, group in ids.items()}
            found["editionNames"] = sorted(set(edition.findall(body)))
            if any(found.values()):
                hits.append({"path": relative(path), "sha256": hashlib.sha256(data).hexdigest(), **found})
    result = {"format": "wallachia-folder-screen-v1", "manifestSha256": hashlib.sha256(raw).hexdigest(),
              "counts": dict(counts), "hits": hits, "unread": issues, "archivesForReview": archives,
              "globalInventoryComplete": False}
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    print(f"{counts['textFiles']} files checked, {len(hits)} matching files. Output: {output.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--output", type=Path, default=Path("wallachia-folder-result.json"))
    args = parser.parse_args()
    scan(args.folder, Path(__file__).with_name("wallachia-archive-targets.json"), args.output)
