import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("recover_draft_h2", ROOT / "scripts/recover-draft-h2.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    raw = b'{"format":"player-hero-research-fit-v1","syntheticOnly":true}\n'
    digest = hashlib.sha256(raw).hexdigest()

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / "test.json"

    def test_pinned_digest_and_synthetic_rejection(self):
        fit = json.loads((ROOT / "docs/evidence/s3-04-player-hero-experiment-fit.json").read_bytes())
        self.assertEqual(recovery.EXPECTED, fit["artifacts"]["artifact.json"])
        self.path.write_bytes(self.raw)
        self.assertIsNone(recovery.candidate_bytes(self.path, recovery.EXPECTED))

    def test_direct_file_and_line_endings(self):
        self.path.write_bytes(self.raw)
        self.assertEqual(recovery.candidate_bytes(self.path, self.digest), self.raw)
        self.path.write_bytes(self.raw.replace(b"\n", b"\r\n"))
        self.assertIsNone(recovery.candidate_bytes(self.path, self.digest))

    def test_export_shapes_preserve_exact_text(self):
        artifact = self.raw.decode()
        result = {"candidate": {"artifactText": artifact}}
        runs = [{"resultText": json.dumps(result)}]
        for document in ({"candidateText": artifact}, result, {"runs": runs}, {"source": {"runs": runs}}):
            with self.subTest(keys=document.keys()):
                self.path.write_text(json.dumps(document), encoding="utf-8")
                self.assertEqual(recovery.candidate_bytes(self.path, self.digest), self.raw)

    def test_matching_claim_cannot_replace_bytes(self):
        self.path.write_text(json.dumps({"candidate": {"sha256": self.digest, "artifactText": self.raw.decode().strip()}}))
        self.assertIsNone(recovery.candidate_bytes(self.path, self.digest))

    def test_stream_marker_across_chunk_boundary(self):
        self.assertTrue(recovery.contains_marker(io.BytesIO(b"x" * (128 * 1024 - 3) + recovery.MARKER)))

    def test_project_walk(self):
        original = self.root / ".tools/s304-hero-fit-r1/artifact.json"
        original.parent.mkdir(parents=True)
        original.write_bytes(self.raw)
        ignored = self.root / "node_modules/test.json"
        ignored.parent.mkdir()
        ignored.write_bytes(self.raw)
        self.path.write_bytes(self.raw)
        self.assertEqual(list(recovery.files(self.root, self.fail)), [original, self.path])

    def test_write_repeat_and_conflict(self):
        recovery.save_verified(self.path, self.raw)
        recovery.save_verified(self.path, self.raw)
        with self.assertRaises(FileExistsError):
            recovery.save_verified(self.path, b"other")
        self.assertEqual(self.path.read_bytes(), self.raw)

    def test_transfer_starts_with_export_and_writes_only_the_model(self):
        self.path.write_text(json.dumps({"candidateText": self.raw.decode(), "other": "private"}))
        with patch.object(recovery, "EXPECTED", self.digest), patch.object(sys, "argv", ["recover", str(self.root)]):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(recovery.main(), 0)
        result_dir = self.root / "DraftLab-H2-recovered"
        self.assertEqual(list(result_dir.iterdir()), [result_dir / "artifact.json"])
        self.assertEqual((result_dir / "artifact.json").read_bytes(), self.raw)

    def test_cli_with_production_pin_rejects_wrong_export(self):
        self.path.write_text(json.dumps({"candidateText": self.raw.decode()}))
        run = subprocess.run([sys.executable, spec.origin, str(self.root)], capture_output=True)
        self.assertEqual(run.returncode, 1)
        self.assertFalse((self.root / "DraftLab-H2-recovered").exists())


if __name__ == "__main__":
    unittest.main()
