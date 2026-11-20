"""Build the standalone Windows scanner, embedding the existing checked ID manifest."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

source = Path(__file__).with_name("WallachiaScan.cs").resolve()
evidence = source.parents[2] / "docs/evidence"
compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework/v4.0.30319/csc.exe"
with ZipFile(evidence / "s3-09-wallachia-old-pc.zip") as old:
    manifest = old.read("wallachia-archive-targets.json")
assert hashlib.sha256(manifest).hexdigest() == "ec9c331975ade2b640667902d0920743e699ec2827fa28e9817e741ff24c9f3b"
with tempfile.TemporaryDirectory() as tmp:
    folder = Path(tmp)
    (folder / "targets.json").write_bytes(manifest)
    subprocess.run([compiler, "/nologo", "/target:exe", "/platform:anycpu", "/optimize+", "/codepage:65001",
                    "/out:WallachiaScan.exe", "/resource:targets.json,targets.json",
                    "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll", source],
                   cwd=folder, check=True)
    with ZipFile(evidence / "wallachia-windows.zip", "x", compression=ZIP_DEFLATED) as bundle:
        bundle.write(folder / "WallachiaScan.exe", "WallachiaScan.exe")
