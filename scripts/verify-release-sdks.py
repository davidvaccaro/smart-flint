#!/usr/bin/env python3
"""Verify prebuilt release SDK archives without extracting or installing their contents."""
import argparse
from email.parser import BytesParser
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile


def safe_names(names):
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or "\\" in name or ".." in path.parts or ".env" in path.parts:
            raise ValueError("Unsafe SDK archive path")
        if any(part in {".data", "node_modules", ".git", "__pycache__"} for part in path.parts):
            raise ValueError("Private or generated SDK archive path")
        if re.search(r"\.(sqlite|db|key|pem|p12|pfx|log)$", name, re.I):
            raise ValueError("Private SDK archive file")


def read_tar(path):
    values = {}
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        safe_names([item.name for item in members])
        if len(members) > 2000 or sum(item.size for item in members) > 50 * 1024 * 1024:
            raise ValueError("SDK archive exceeds release limits")
        for item in members:
            if not (item.isfile() or item.isdir()) or item.name in values:
                raise ValueError("SDK archives must contain only unique regular files/directories")
            if item.isfile():
                values[item.name] = archive.extractfile(item).read()
    return values


def check_license(values, expected):
    licenses = [value for name, value in values.items() if name.endswith("/LICENSE")]
    if licenses != [expected] or not any(name.endswith("/THIRD_PARTY_NOTICES.md") for name in values):
        raise ValueError("SDK must retain the exact product license and third-party notices")


def verify(directory, version, license_path):
    paths = sorted(directory.iterdir())
    if len(paths) != 4 or any(path.is_symlink() or not path.is_file() for path in paths):
        raise ValueError("Expected exactly four regular SDK artifact files")
    expected_license = license_path.read_bytes()
    for package in ["contracts", "sdk"]:
        name = "smart-flint-" + package + "-" + version + ".tgz"
        values = read_tar(directory / name)
        manifest = json.loads(values["package/package.json"])
        if manifest.get("name") != "@smart-flint/" + package or manifest.get("version") != version:
            raise ValueError("npm SDK identity/version mismatch")
        for member in ["package/dist/index.js", "package/dist/index.d.ts", "package/README.md"]:
            if member not in values:
                raise ValueError("Missing compiled npm SDK entry point or documentation")
        check_license(values, expected_license)
    python_version = re.sub(r"-(alpha|beta|rc)\.(\d+)$", lambda match: {"alpha": "a", "beta": "b", "rc": "rc"}[match[1]] + match[2], version)
    wheels = list(directory.glob("*.whl"))
    sources = list(directory.glob("*.tar.gz"))
    if len(wheels) != 1 or len(sources) != 1:
        raise ValueError("Missing Python wheel/source distribution")
    with zipfile.ZipFile(wheels[0]) as wheel:
        members = wheel.infolist()
        safe_names([member.filename for member in members])
        if len(members) > 2000 or sum(member.file_size for member in members) > 50 * 1024 * 1024:
            raise ValueError("Python wheel exceeds release limits")
        values = {member.filename: wheel.read(member) for member in members}
        if len(values) != len(members) or any((member.external_attr >> 16) & 0o170000 == 0o120000 for member in members):
            raise ValueError("Python wheel contains duplicate entries or links")
    metadata = [value for name, value in values.items() if name.endswith("/METADATA")]
    if len(metadata) != 1 or "smart_flint/client.py" not in values or "smart_flint/py.typed" not in values:
        raise ValueError("Python wheel lacks metadata, implementation or typing marker")
    headers = BytesParser().parsebytes(metadata[0])
    if headers.get("Name") != "smart-flint" or headers.get("Version") != python_version:
        raise ValueError("Python wheel identity/version mismatch")
    check_license(values, expected_license)
    source_values = read_tar(sources[0])
    check_license(source_values, expected_license)
    source_metadata = [value for name, value in source_values.items() if name.count("/") == 1 and name.endswith("/PKG-INFO")]
    if len(source_metadata) != 1:
        raise ValueError("Python source distribution lacks unique metadata")
    headers = BytesParser().parsebytes(source_metadata[0])
    if headers.get("Name") != "smart-flint" or headers.get("Version") != python_version:
        raise ValueError("Python source identity/version mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--license", required=True, type=Path)
    args = parser.parse_args()
    verify(args.directory, args.version, args.license)
    print("Release SDK archive identities, versions, compiled entry points, license files and safe members verified.")


if __name__ == "__main__":
    main()
