import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/evidence"


@unittest.skipUnless(sys.platform == "win32", "Windows executable")
class WindowsFolderReport(unittest.TestCase):
    def test_packaged_executable_emits_and_preserves_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            unpacked = base / "Программа BO3"
            with zipfile.ZipFile(EVIDENCE / "wallachia-windows.zip") as bundle:
                self.assertEqual(bundle.namelist(), ["WallachiaScan.exe"])
                bundle.extractall(unpacked)
            exe = unpacked / "WallachiaScan.exe"
            folder = base / "Старый проект"
            folder.mkdir()
            report = unpacked / "wallachia-folder-result.json"
            subprocess.run([exe, folder], cwd=base, check=True, capture_output=True)
            original = report.read_bytes()
            empty = json.loads(original)
            self.assertEqual(empty["counts"]["textFiles"], 0)
            self.assertEqual(empty["hits"], [])
            self.assertFalse((base / report.name).exists())

            with zipfile.ZipFile(EVIDENCE / "s3-09-wallachia-old-pc.zip") as old:
                target = json.loads(old.read("wallachia-archive-targets.json"))["maps"][0]
            sample = folder / "файл.txt"
            sample.write_text("private line " + target + " Wallachia сезон 3", encoding="utf-16")
            (folder / ".env").write_text(target)
            (folder / "другой.md").write_text("1" + target + "2")
            (folder / "архив.zip").touch()
            (folder / "binary.txt").write_bytes(b"\0")
            subprocess.run([exe, folder], cwd=base, check=True, capture_output=True)
            second = json.loads(report.with_name("wallachia-folder-result-1.json").read_bytes())
            self.assertEqual(report.read_bytes(), original)
            self.assertEqual(second["hits"], [{
                "path": sample.name, "sha256": hashlib.sha256(sample.read_bytes()).hexdigest(),
                "maps": [target], "openDotaSeries": [], "pandaScoreMeetings": [], "editionNames": ["3"]
            }])
            self.assertEqual(second["archivesForReview"], ["архив.zip"])
            self.assertEqual(second["counts"]["sensitiveSkipped"], 1)
            self.assertEqual(second["unread"][0]["path"], "binary.txt")
            self.assertNotIn("private line", json.dumps(second))

            subprocess.run([exe, ROOT / "reports", base], cwd=folder, check=True, capture_output=True)
            actual = json.loads((base / report.name).read_bytes())
            reference = json.loads((EVIDENCE / "s3-09-wallachia-reports-exposure.json").read_bytes())
            self.assertEqual(actual["counts"]["textFiles"], reference["counts"]["textFiles"])
            for key in ["manifestSha256", "hits", "unread", "archivesForReview", "globalInventoryComplete"]:
                self.assertEqual(actual[key], reference[key])
            error = subprocess.run([exe, base / "missing"], capture_output=True)
            self.assertNotEqual(error.returncode, 0)
            self.assertTrue(error.stderr)


if __name__ == "__main__":
    unittest.main()
