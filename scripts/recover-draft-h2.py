"""Find the original Draft Lab candidate in a project directory or an exported JSON."""

import argparse
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile


EXPECTED = "9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b"
MARKER = b"player-hero-research-fit-v1"
ARTIFACT_LIMIT = 4 * 1024 * 1024
EXPORT_LIMIT = 256 * 1024 * 1024
SKIP_DIRS = {".git", ".venv", "node_modules", "pnpm-store", "pgdata", "__pycache__"}


def contains_marker(stream):
    tail = b""
    while chunk := stream.read(128 * 1024):
        block = tail + chunk
        if MARKER in block:
            return True
        tail = block[-(len(MARKER) - 1):]
    return False


def embedded(document):
    if not isinstance(document, dict):
        return
    yield document.get("candidateText")
    candidate = document.get("candidate")
    if isinstance(candidate, dict):
        yield candidate.get("artifactText")
    source = document.get("source", document)
    if isinstance(source, dict) and isinstance(source.get("runs"), list):
        for row in source["runs"]:
            if isinstance(row, dict) and isinstance(row.get("resultText"), str):
                try:
                    result = json.loads(row["resultText"])
                except (ValueError, RecursionError):
                    continue
                if isinstance(result, dict) and isinstance(result.get("candidate"), dict):
                    yield result["candidate"].get("artifactText")


def candidate_bytes(path, expected):
    with path.open("rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        if not contains_marker(stream):
            return None
        if size > EXPORT_LIMIT:
            raise ValueError("превышен предел размера экспорта Draft Lab")
        stream.seek(0)
        if size <= ARTIFACT_LIMIT:
            raw = stream.read()
            if hashlib.sha256(raw).hexdigest() == expected:
                return raw
            document = json.loads(raw)
        else:
            document = json.load(stream)
    for value in embedded(document):
        if isinstance(value, str) and len(value) <= ARTIFACT_LIMIT:
            raw = value.encode("utf-8")
            if hashlib.sha256(raw).hexdigest() == expected:
                return raw
    return None


def files(root, warn):
    if root.is_file():
        yield root
        return
    usual = root / ".tools" / "s304-hero-fit-r1" / "artifact.json"
    if usual.is_file():
        yield usual
    for base, dirs, names in os.walk(root, onerror=warn, followlinks=False):
        directory = Path(base)
        for name in dirs[:]:
            child = directory / name
            if name in SKIP_DIRS:
                dirs.remove(name)
                continue
            try:
                info = child.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    dirs.remove(name)
            except OSError as error:
                dirs.remove(name)
                warn(error)
        for name in names:
            path = directory / name
            if path.suffix.lower() == ".json" and path != usual and not path.is_symlink():
                yield path


def save_verified(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
    try:
        temporary.write_bytes(raw)
        if temporary.read_bytes() != raw:
            raise OSError(f"Проверка записанной копии не прошла: {temporary}")
        try:
            if os.name == "nt":
                temporary.rename(path)  # Windows rename refuses an existing target.
            else:
                os.link(temporary, path)
        except FileExistsError:
            if not (path.is_file() and path.stat().st_size == len(raw) and path.read_bytes() == raw):
                raise FileExistsError(f"В месте назначения уже есть другой файл: {path}")
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Поиск точной копии H2 для переноса на другой ПК.")
    parser.add_argument("source", nargs="?", type=Path, default=Path.cwd(), help="Папка старого проекта или файл экспорта")
    args = parser.parse_args()
    root = args.source.resolve()
    if not (root.is_file() or root.is_dir()):
        parser.error("Указанный путь не существует")
    destination = (root if root.is_dir() else root.parent) / "DraftLab-H2-recovered" / "artifact.json"
    checked = skipped = 0

    def warn(error):
        nonlocal skipped
        skipped += 1
        print(f"Пропущено: {error}", file=sys.stderr)

    for path in files(root, warn):
        checked += 1
        try:
            raw = candidate_bytes(path, EXPECTED)
        except (OSError, ValueError, RecursionError) as error:
            warn(f"{path} ({error})")
            continue
        if raw is not None:
            try:
                save_verified(destination, raw)
            except OSError as error:
                print(error, file=sys.stderr)
                return 2
            print(f"Найден H2: {path}\nSHA-256: {EXPECTED}\nФайл для переноса: {destination}")
            return 0
    print(f"Точная копия H2 не найдена. Проверено файлов: {checked}. Пропущено с ошибкой: {skipped}.")
    return 2 if skipped else 1


if __name__ == "__main__":
    sys.exit(main())
