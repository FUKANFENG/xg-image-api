from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

ROOT_FILES = (
    ".dockerignore",
    ".env.example",
    ".gitignore",
    ".python-version",
    "CHANGELOG.md",
    "Dockerfile",
    "Dockerfile.local",
    "LICENSE",
    "README.md",
    "SOURCE_PACKAGE_README.md",
    "VERSION",
    "docker-compose.https.yml",
    "docker-compose.lan.yml",
    "docker-compose.local.yml",
    "docker-compose.warp.yml",
    "docker-compose.yml",
    "main.py",
    "pyproject.toml",
    "uv.lock",
)

SOURCE_DIRS = (
    ".github",
    "api",
    "deploy",
    "desktop-launcher",
    "docs",
    "examples",
    "native-package",
    "scripts",
    "sdk",
    "services",
    "test",
    "utils",
    "web",
)

EXCLUDED_DIRS = {
    ".agents",
    ".claude",
    ".codex",
    ".codex-backups",
    ".git",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "data",
    "dist",
    "git_cache",
    "node_modules",
    "obj",
    "out",
    "output",
    "release",
    "release-safe",
    "test_evidence",
    "web_dist",
}

EXCLUDED_FILES = {
    ".coverage",
    ".ds_store",
    ".env",
    ".env.local",
    "config.json",
    "desktop.ini",
    "thumbs.db",
    "tsconfig.tsbuildinfo",
}

EXCLUDED_SUFFIXES = {
    ".7z",
    ".db",
    ".dll",
    ".dmp",
    ".exe",
    ".gz",
    ".log",
    ".pdb",
    ".pyc",
    ".pyd",
    ".pyo",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".tmp",
    ".user",
    ".zip",
}

SENSITIVE_KEY_PATTERN = re.compile(
    r"(?:auth[-_]?key|api[-_]?key|access[-_]?key|secret|password|passwd|passphrase|token|cookie|credential|private[-_]?key)",
    re.IGNORECASE,
)

IDENTITY_KEY_PATTERN = re.compile(
    r"(?:email|username|user_name|display_name|owner_name)",
    re.IGNORECASE,
)

GENERIC_SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(rb"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b"),
)

EMAIL_PATTERN = re.compile(
    rb"(?<!:)\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"
)
WINDOWS_USER_PATH_PATTERN = re.compile(rb"(?i)\b[A-Z]:\\Users\\[^\\\r\n\t\"']+")
UNIX_USER_PATH_PATTERN = re.compile(rb"(?:/Users/|/home/)[^/\s\"']+")
ALLOWED_EMAIL_DOMAINS = {
    "example.com",
    "example.net",
    "example.org",
    "example.test",
    "github.com",
    "gitlab.com",
    "users.noreply.github.com",
}

PUBLIC_NON_SECRET_VALUES = {b"chatgpt2api"}

SecretNeedle = tuple[bytes, frozenset[str]]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_source_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "working-tree"


def should_skip(path: Path, source_root: Path) -> bool:
    relative = path.relative_to(source_root)
    if any(part.lower() in EXCLUDED_DIRS for part in relative.parts[:-1]):
        return True
    name = path.name.lower()
    if name in EXCLUDED_FILES or path.suffix.lower() in EXCLUDED_SUFFIXES:
        return True
    return name.startswith(".env.") and name != ".env.example"


def copy_source_tree(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    for current_root, dir_names, file_names in os.walk(source):
        current = Path(current_root)
        dir_names[:] = sorted(name for name in dir_names if name.lower() not in EXCLUDED_DIRS)
        for file_name in sorted(file_names):
            source_file = current / file_name
            if should_skip(source_file, source):
                continue
            relative = source_file.relative_to(source)
            destination_file = destination / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, destination_file)


def sanitize_config(value: object, path: tuple[str, ...] = ()) -> object:
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for raw_key, nested in value.items():
            key = str(raw_key)
            normalized = key.lower().replace("-", "_")
            if SENSITIVE_KEY_PATTERN.search(normalized):
                if isinstance(nested, bool):
                    result[key] = False
                elif isinstance(nested, (int, float)):
                    result[key] = 0
                elif isinstance(nested, list):
                    result[key] = []
                elif isinstance(nested, dict):
                    result[key] = {}
                else:
                    result[key] = ""
                continue
            result[key] = sanitize_config(nested, (*path, normalized))
        return result
    if isinstance(value, list):
        return [sanitize_config(item, path) for item in value]
    return value


def make_safe_config(source: Path) -> dict[str, object]:
    raw = json.loads(source.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, dict):
        raise ValueError("config.json must contain an object")
    config = sanitize_config(raw)
    assert isinstance(config, dict)
    config["auth-key"] = ""
    config["base_url"] = ""
    config["proxy"] = ""

    proxy_runtime = config.get("proxy_runtime")
    if isinstance(proxy_runtime, dict):
        proxy_runtime["enabled"] = False
        for key in ("proxy_url", "resource_proxy_url"):
            proxy_runtime[key] = ""
        clearance = proxy_runtime.get("clearance")
        if isinstance(clearance, dict):
            clearance["enabled"] = False
            clearance["cf_cookies"] = ""
            clearance["cf_clearance"] = ""

    backup = config.get("backup")
    if isinstance(backup, dict):
        backup["enabled"] = False

    image_storage = config.get("image_storage")
    if isinstance(image_storage, dict):
        image_storage["enabled"] = False
        image_storage["webdav_url"] = ""
        image_storage["webdav_username"] = ""
        image_storage["webdav_password"] = ""
        image_storage["public_base_url"] = ""

    ai_review = config.get("ai_review")
    if isinstance(ai_review, dict):
        ai_review["enabled"] = False
        ai_review["base_url"] = ""

    third_party_apps = config.get("third_party_apps")
    if isinstance(third_party_apps, dict):
        for app in third_party_apps.values():
            if isinstance(app, dict):
                app["enabled"] = False
                if "url" in app:
                    app["url"] = ""
    return config


def collect_secret_needles() -> list[SecretNeedle]:
    values: dict[bytes, frozenset[str]] = {}
    config_source = (ROOT / "services" / "config.py").read_bytes()

    def add_if_secret(candidate: str, *, minimum_length: int = 16) -> None:
        value = candidate.strip()
        if len(value) < minimum_length:
            return
        encoded = value.encode("utf-8")
        if encoded.lower() in PUBLIC_NON_SECRET_VALUES:
            return
        character_groups = sum(
            bool(re.search(pattern, value))
            for pattern in (r"[a-z]", r"[A-Z]", r"\d", r"[^A-Za-z0-9]")
        )
        if value.startswith(("sk-", "ghp_", "github_pat_")) or character_groups >= 1:
            allowed_paths = (
                frozenset({"services/config.py"})
                if len(encoded) <= 12 and encoded in config_source
                else frozenset()
            )
            values[encoded] = allowed_paths

    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            raw_key, raw_value = stripped.split("=", 1)
            value = raw_value.strip().strip('"\'')
            if SENSITIVE_KEY_PATTERN.search(raw_key):
                add_if_secret(value, minimum_length=6)
            elif IDENTITY_KEY_PATTERN.search(raw_key) and "@" in value:
                add_if_secret(value, minimum_length=3)

    config_path = ROOT / "config.json"
    if config_path.exists():
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))

        def walk(item: object, key: str = "") -> None:
            if isinstance(item, dict):
                for nested_key, nested_value in item.items():
                    walk(nested_value, str(nested_key))
            elif isinstance(item, list):
                for nested_value in item:
                    walk(nested_value, key)
            elif isinstance(item, str) and SENSITIVE_KEY_PATTERN.search(key):
                add_if_secret(item, minimum_length=6)

        walk(data)

    for data_file in (ROOT / "data" / "accounts.json", ROOT / "data" / "auth_keys.json"):
        if not data_file.is_file():
            continue
        try:
            data = json.loads(data_file.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue

        def walk_private(item: object, key: str = "") -> None:
            if isinstance(item, dict):
                for nested_key, nested_value in item.items():
                    walk_private(nested_value, str(nested_key))
            elif isinstance(item, list):
                for nested_value in item:
                    walk_private(nested_value, key)
            elif isinstance(item, str):
                if SENSITIVE_KEY_PATTERN.search(key):
                    add_if_secret(item, minimum_length=6)
                elif IDENTITY_KEY_PATTERN.search(key) and "@" in item:
                    add_if_secret(item, minimum_length=3)

        walk_private(data)
    return sorted(values.items(), key=lambda item: item[0])


def is_placeholder_secret(value: bytes) -> bool:
    lowered = value.lower()
    return any(
        marker in lowered
        for marker in (b"xxxxx", b"your_", b"your-", b"replace_with", b"example")
    )


def audit_content(relative: str, content: bytes, secret_needles: list[SecretNeedle]) -> list[str]:
    violations: list[str] = []
    for needle, allowed_paths in secret_needles:
        if needle and needle in content and relative not in allowed_paths:
            violations.append(f"local private value found: {relative}")
            break
    for pattern in GENERIC_SECRET_PATTERNS:
        match = pattern.search(content)
        if match and not is_placeholder_secret(match.group(0)):
            violations.append(f"generic secret pattern found: {relative}")
            break
    for match in EMAIL_PATTERN.finditer(content):
        domain = match.group(1).decode("ascii", errors="ignore").lower()
        if domain not in ALLOWED_EMAIL_DOMAINS and not domain.endswith(".test"):
            violations.append(f"non-placeholder email found: {relative}")
            break
    path_match = WINDOWS_USER_PATH_PATTERN.search(content) or UNIX_USER_PATH_PATTERN.search(content)
    if path_match and b"|" not in path_match.group(0):
        violations.append(f"local user path found: {relative}")
    return violations


def audit_sanitized_config(config_path: Path, relative: str) -> list[str]:
    violations: list[str] = []
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))

    def walk(item: object, path: tuple[str, ...] = ()) -> None:
        if not isinstance(item, dict):
            if isinstance(item, list):
                for index, nested in enumerate(item):
                    walk(nested, (*path, str(index)))
            return
        for raw_key, nested in item.items():
            key = str(raw_key)
            nested_path = (*path, key)
            if SENSITIVE_KEY_PATTERN.search(key):
                safe = nested in ("", False, 0, None) or nested == [] or nested == {}
                if not safe:
                    violations.append(
                        f"sensitive config value is not empty: {relative}:{'.'.join(nested_path)}"
                    )
                continue
            walk(nested, nested_path)

    walk(config)
    if config.get("auth-key"):
        violations.append(f"authentication key is not blank: {relative}")
    if config.get("proxy"):
        violations.append(f"local proxy is not blank: {relative}")
    return violations


def audit_package(package_root: Path, secret_needles: list[SecretNeedle]) -> list[str]:
    violations: list[str] = []
    for path in sorted(item for item in package_root.rglob("*") if item.is_file()):
        relative = path.relative_to(package_root).as_posix()
        lower_parts = {part.lower() for part in Path(relative).parts}
        if lower_parts & EXCLUDED_DIRS and relative != "data/.gitkeep":
            violations.append(f"forbidden directory: {relative}")
        if path.name.lower() in {".env", ".env.local"}:
            violations.append(f"private environment file: {relative}")
        if path.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".log"}:
            violations.append(f"private runtime artifact: {relative}")
        content = path.read_bytes()
        violations.extend(audit_content(relative, content, secret_needles))

    for config_name in ("config.json", "config.example.json"):
        config_path = package_root / config_name
        violations.extend(audit_sanitized_config(config_path, config_name))
    if (package_root / ".env").exists():
        violations.append("private .env file is present")
    return violations


def audit_archive(
    archive_path: Path,
    package_name: str,
    package_root: Path,
    secret_needles: list[SecretNeedle],
) -> list[str]:
    violations: list[str] = []
    expected = {
        path.relative_to(package_root).as_posix(): sha256(path)
        for path in package_root.rglob("*")
        if path.is_file()
    }
    observed: dict[str, str] = {}
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            normalized = info.filename.replace("\\", "/")
            parts = tuple(part for part in normalized.split("/") if part)
            if not parts or parts[0] != package_name or ".." in parts or normalized.startswith("/"):
                violations.append(f"unsafe archive path: {normalized}")
                continue
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                violations.append(f"archive link is not allowed: {normalized}")
                continue
            if info.is_dir():
                continue
            relative = "/".join(parts[1:])
            content = archive.read(info)
            observed[relative] = hashlib.sha256(content).hexdigest()
            violations.extend(audit_content(relative, content, secret_needles))
    if observed != expected:
        violations.append("archive file list or digest does not match the sanitized directory")
    return violations


def verify_manifest(package_root: Path) -> list[str]:
    violations: list[str] = []
    manifest_path = package_root / "SHA256SUMS.txt"
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, separator, relative = line.partition("  ")
        target = package_root / Path(relative)
        if not separator or not target.is_file() or sha256(target) != digest:
            violations.append(f"manifest mismatch: {relative or line}")
    return violations


def write_manifest(package_root: Path) -> None:
    paths = sorted(
        path
        for path in package_root.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS.txt"
    )
    lines = [f"{sha256(path)}  {path.relative_to(package_root).as_posix()}" for path in paths]
    (package_root / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_package(output_root: Path) -> tuple[Path, Path]:
    version = (ROOT / "VERSION").read_text(encoding="utf-8-sig").strip()
    package_date = datetime.now().astimezone().strftime("%Y%m%d")
    package_name = f"XG生图-源码安全分发版-{version}-{package_date}"
    package_root = output_root / package_name
    archive_path = output_root / f"{package_name}.zip"
    checksum_path = output_root / f"{package_name}.zip.sha256"
    for path in (package_root, archive_path, checksum_path):
        if path.exists():
            raise FileExistsError(f"refusing to overwrite existing output: {path}")

    package_root.mkdir(parents=True)
    for file_name in ROOT_FILES:
        source = ROOT / file_name
        if not source.is_file():
            raise FileNotFoundError(f"required source file is missing: {file_name}")
        shutil.copy2(source, package_root / file_name)
    for directory_name in SOURCE_DIRS:
        copy_source_tree(ROOT / directory_name, package_root / directory_name)

    safe_config = make_safe_config(ROOT / "config.json")
    safe_config_text = json.dumps(safe_config, ensure_ascii=False, indent=2) + "\n"
    (package_root / "config.json").write_text(safe_config_text, encoding="utf-8")
    (package_root / "config.example.json").write_text(safe_config_text, encoding="utf-8")
    (package_root / "data").mkdir(exist_ok=True)
    (package_root / "data" / ".gitkeep").write_text("", encoding="utf-8")

    source_files = [path for path in package_root.rglob("*") if path.is_file()]
    package_info = {
        "name": package_name,
        "version": version,
        "type": "source",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_commit": get_source_commit(),
        "source_file_count_before_metadata": len(source_files),
        "contains_local_accounts": False,
        "contains_local_secrets": False,
        "privacy_audit": "PRIVACY_AUDIT.json",
        "excluded": [
            ".git and Codex metadata",
            "local .env and unsanitized config.json",
            "data, logs, images, databases and account exports",
            "node_modules, virtual environments and build outputs",
            "native packages, backups, reports and test evidence",
        ],
    }
    (package_root / "PACKAGE_INFO.json").write_text(
        json.dumps(package_info, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    secret_needles = collect_secret_needles()
    violations = audit_package(package_root, secret_needles)
    if violations:
        raise RuntimeError("package security audit failed:\n" + "\n".join(violations))
    privacy_audit = {
        "status": "passed",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scanned_file_count": len([path for path in package_root.rglob("*") if path.is_file()]),
        "local_private_values_compared": len(secret_needles),
        "violations": 0,
        "checks": [
            "explicit source allowlist",
            "forbidden runtime paths and file types",
            "local environment, config and account value comparison",
            "generic private keys and access tokens",
            "non-placeholder email addresses",
            "local operating-system user paths",
            "recursive sensitive configuration fields",
            "archive path, link, file-list and digest validation",
        ],
    }
    (package_root / "PRIVACY_AUDIT.json").write_text(
        json.dumps(privacy_audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    violations = audit_package(package_root, secret_needles)
    if violations:
        raise RuntimeError("package metadata security audit failed:\n" + "\n".join(violations))
    write_manifest(package_root)

    output_root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in package_root.rglob("*") if item.is_file()):
            archive.write(path, Path(package_name) / path.relative_to(package_root))
    violations = audit_archive(archive_path, package_name, package_root, secret_needles)
    if violations:
        archive_path.unlink(missing_ok=True)
        raise RuntimeError("archive security audit failed:\n" + "\n".join(violations))
    with tempfile.TemporaryDirectory(prefix="xg-source-package-") as temporary:
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(temporary)
        extracted_root = Path(temporary) / package_name
        violations = audit_package(extracted_root, secret_needles)
        violations.extend(verify_manifest(extracted_root))
        if violations:
            archive_path.unlink(missing_ok=True)
            raise RuntimeError("extracted package verification failed:\n" + "\n".join(violations))
    archive_digest = sha256(archive_path)
    checksum_path.write_text(f"{archive_digest}  {archive_path.name}\n", encoding="utf-8")
    return package_root, archive_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a sanitized XG image source package")
    parser.add_argument("--output", type=Path, default=ROOT / "release-safe")
    args = parser.parse_args()
    package_root, archive_path = build_package(args.output.resolve())
    print(f"PACKAGE_ROOT={package_root}")
    print(f"ARCHIVE={archive_path}")
    print(f"ARCHIVE_SHA256={sha256(archive_path)}")
    print(f"ARCHIVE_SIZE={archive_path.stat().st_size}")


if __name__ == "__main__":
    main()
