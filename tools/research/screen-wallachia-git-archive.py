"""Scan the pre-existing project history without printing lines or match outcomes."""
import gzip
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from collections import Counter
from pathlib import Path


root = Path(__file__).resolve().parents[2]
evidence = root / "docs/evidence"
head = "525110947ad71771229ca7a43369e77154ec01ac"
registers = (evidence / "s3-09-wallachia-series-registers.json.gz").read_bytes()
assert hashlib.sha256(registers).hexdigest() == "9a438091827ef04003face2cc5d4fa0119998b410bf10ea6dc6ec8ae8515c0d0"
graph, panda = [json.loads(item["content"]) for item in json.loads(gzip.decompress(registers))]
screen = json.loads((evidence / "s3-09-wallachia-bo3-input-screen.json").read_bytes())
kept = {r["seriesId"] for edition in screen["editions"] for r in edition["rows"]
        if not r["overlap"] and not r["issues"] and r["observedFirstMap"]}
kept.remove("987722")  # First-map membership is held separately.
maps = {g["id"] for s in graph["snapshots"] for n in s["graph"] if n["seriesId"] in kept for g in n["games"]}
meetings = {m["id"] for s in panda for m in s["rows"] if m["format"] == 3}
assert len(meetings) == 138 and len(kept) == 114
if sys.argv[1:] == ["--bundle"]:
    target_file = {"format": "wallachia-archive-targets-v1", "maps": sorted(maps),
                   "openDotaSeries": sorted(kept), "pandaScoreMeetings": sorted(meetings)}
    script = Path(__file__).with_name("screen-wallachia-folder.py").read_bytes()
    with zipfile.ZipFile(evidence / "s3-09-wallachia-old-pc.zip", "x") as bundle:
        for name, body in [("wallachia-archive-targets.json", json.dumps(target_file, indent=2).encode()),
                           ("screen-wallachia-folder.py", script)]:
            bundle.writestr(zipfile.ZipInfo(name), body, compress_type=zipfile.ZIP_DEFLATED)
    sys.exit(0)
assert not sys.argv[1:]
numbers = re.compile(r"(?<![0-9])(?:[1-9][0-9]{5,10})(?![0-9])")
edition_name = re.compile(r"\bwallachia[\s#:_-]*(?:season|сезон|s)?[\s#:_-]*([345])(?!\d)", re.I)


def inspect(content, name, object_id):
    if content.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    elif b"\x00" in content:
        return "binary"
    else:
        encoding = "utf-8-sig"
    try:
        decoded = content.decode(encoding)
    except UnicodeError:
        return "encoding_unresolved"
    found = set(numbers.findall(decoded))
    matches = {"maps": sorted(found & maps), "openDotaSeries": sorted(found & kept),
               "pandaScoreMeetings": sorted(found & meetings), "editionNames": sorted(set(edition_name.findall(decoded)))}
    if any(matches.values()):
        hits.append({"path": name, "object": object_id, **matches})
    return "text"


def git(*args, data=None):
    return subprocess.check_output(["git", *args], input=data, cwd=root)


hits = []
objects = git("rev-list", "--objects", head).splitlines()
paths = {line.split(b" ", 1)[0]: line.partition(b" ")[2].decode("utf-8", "replace") for line in objects}
manifest = git("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", data=b"\n".join(paths) + b"\n")
counts = Counter()
with subprocess.Popen(["git", "cat-file", "--batch"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
    for row in manifest.splitlines():
        object_id, kind, size = row.split()
        if kind != b"blob":
            continue
        if int(size) > 48 * 1024 * 1024:
            counts["oversize"] += 1
            continue
        process.stdin.write(object_id + b"\n")
        process.stdin.flush()
        assert process.stdout.readline().split() == [object_id, kind, size]
        content = process.stdout.read(int(size))
        assert len(content) == int(size) and process.stdout.read(1) == b"\n"
        counts[inspect(content, paths[object_id], object_id.decode())] += 1
    process.stdin.close()
    assert process.wait() == 0

transfer = root / "DraftLab-H2-transfer.zip"
with zipfile.ZipFile(transfer) as archive:
    assert archive.namelist() == ["DraftLab-H2-recovered/artifact.json"]
    data = archive.read(archive.namelist()[0])
    assert inspect(data, transfer.name + "/" + archive.namelist()[0], hashlib.sha256(data).hexdigest()) == "text"
report = {"format": "wallachia-git-exposure-screen-v1", "gitHead": head,
          "commits": int(git("rev-list", "--count", head)), "gitBlobs": dict(counts),
          "transferSha256": hashlib.sha256(transfer.read_bytes()).hexdigest(),
          "search": {"unexposedCandidateSeriesChecked": len(kept), "maps": len(maps), "pandaScoreMeetings": len(meetings)},
          "hits": hits, "globalInventoryComplete": False, "scoredSeries": 0}
print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True))
