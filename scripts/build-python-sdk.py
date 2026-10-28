#!/usr/bin/env python3
"""Build clean Python distributions, optionally install/test both from outside the repository."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def run(arguments, cwd):
    subprocess.run([str(item) for item in arguments], cwd=str(cwd), check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/sdk")
    parser.add_argument("--verify", action="store_true")
    options = parser.parse_args()
    if not importlib.util.find_spec("build"):
        parser.error("Install the build tools in a virtualenv: python3 -m pip install -r scripts/sdk-build-requirements.txt")
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="smart-flint-python-artifacts-") as directory:
        temporary = Path(directory)
        source = temporary / "source"
        source.mkdir()
        for name in ["pyproject.toml", "MANIFEST.in", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]:
            shutil.copy2(ROOT / "sdks/python" / name, source / name)
        shutil.copytree(ROOT / "sdks/python/src", source / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info"))
        built = temporary / "built"
        # Use the caller's explicitly provisioned toolchain; building never installs dependencies.
        run([sys.executable, "-m", "build", "--no-isolation", "--outdir", built], source)
        wheels = list(built.glob("*.whl"))
        sdists = list(built.glob("*.tar.gz"))
        if len(wheels) != 1 or len(sdists) != 1:
            raise RuntimeError("Expected one wheel and one source distribution")
        with zipfile.ZipFile(wheels[0]) as archive:
            names = archive.namelist()
            for suffix in ["/LICENSE", "/THIRD_PARTY_NOTICES.md", "/METADATA"]:
                if not any(name.endswith(suffix) for name in names):
                    raise RuntimeError("The wheel is missing distribution metadata or notices")
            if "smart_flint/py.typed" not in names:
                raise RuntimeError("The wheel is missing its typing marker")
            if any(".env" in name or ".sqlite" in name or "/tests/" in name for name in names):
                raise RuntimeError("The wheel contains unexpected files")
        if options.verify:
            unpacked = temporary / "unpacked"
            unpacked.mkdir()
            with tarfile.open(sdists[0]) as archive:
                # All generated archive members must remain inside the extraction directory.
                for member in archive.getmembers():
                    if member.issym() or member.islnk() or not (unpacked / member.name).resolve().is_relative_to(unpacked.resolve()):
                        raise RuntimeError("Unsafe source-distribution member")
                archive.extractall(unpacked)
            extracted = list(unpacked.iterdir())
            if len(extracted) != 1:
                raise RuntimeError("Expected a single source-distribution root")
            rebuilt = temporary / "rebuilt"
            run([sys.executable, "-m", "build", "--no-isolation", "--wheel", "--outdir", rebuilt], extracted[0])
            for index, wheel in enumerate([wheels[0], *rebuilt.glob("*.whl")]):
                consumer = temporary / ("consumer-" + str(index))
                consumer.mkdir()
                environment = consumer / "venv"
                venv.EnvBuilder(with_pip=True, clear=True).create(environment)
                python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
                run([python, "-m", "pip", "install", "--no-index", "--no-deps", "--disable-pip-version-check", wheel], consumer)
                shutil.copy2(ROOT / "sdks/python/tests/test_client.py", consumer / "test_client.py")
                run([python, "-I", "-m", "unittest", "discover", "-s", str(consumer), "-p", "test_client.py"], consumer)
            print("Python artifacts passed: wheel and rebuilt sdist installed into independent virtualenvs; all SDK transport, credential, isolation and error checks passed.")
        for artifact in [wheels[0], sdists[0]]:
            shutil.copy2(artifact, output / artifact.name)
            print("Created " + str(output / artifact.name))


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print("Python SDK artifact build failed: " + str(error), file=sys.stderr)
        sys.exit(1)
