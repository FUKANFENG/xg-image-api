from __future__ import annotations

import argparse
import json
import math
import os
import socket
import statistics
import threading
import time
import uuid
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


DEFAULT_PROMPT = (
    "A single matte blue sphere centered on a clean white background, "
    "soft studio lighting, product photography, no text."
)


@dataclass
class AttemptResult:
    batch: int
    index: int
    ok: bool
    status_code: int
    duration_ms: int
    error_code: str = ""


def _load_auth_key(env_file: Path) -> str:
    value = str(os.getenv("CHATGPT2API_AUTH_KEY") or "").strip()
    if value:
        return value
    if not env_file.exists():
        return ""
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if not line.startswith("CHATGPT2API_AUTH_KEY="):
            continue
        return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _error_code(payload: Any, fallback: str) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("code") or error.get("type") or fallback)
        detail = payload.get("detail")
        if isinstance(detail, dict):
            return str(detail.get("code") or fallback)
    return fallback


def _request_direct_image(
    *,
    base_url: str,
    auth_key: str,
    model: str,
    prompt: str,
    timeout_secs: float,
    batch: int,
    index: int,
    start_gate: threading.Event,
) -> AttemptResult:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/images/generations",
        data=json.dumps({
            "model": model,
            "prompt": f"{prompt} Benchmark batch {batch}, sample {index}.",
            "n": 1,
            "size": "1024x1024",
            "quality": "auto",
            "response_format": "url",
        }).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {auth_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    start_gate.wait()
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_secs) as response:
            payload = json.loads(response.read().decode("utf-8"))
            data = payload.get("data") if isinstance(payload, dict) else None
            ok = response.status == 200 and isinstance(data, list) and bool(data)
            return AttemptResult(
                batch=batch,
                index=index,
                ok=ok,
                status_code=int(response.status),
                duration_ms=int((time.perf_counter() - started) * 1000),
                error_code="" if ok else _error_code(payload, "empty_image_result"),
            )
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeError):
            payload = None
        return AttemptResult(
            batch=batch,
            index=index,
            ok=False,
            status_code=int(exc.code),
            duration_ms=int((time.perf_counter() - started) * 1000),
            error_code=_error_code(payload, f"http_{exc.code}"),
        )
    except (TimeoutError, socket.timeout):
        return AttemptResult(batch, index, False, 0, int((time.perf_counter() - started) * 1000), "client_timeout")
    except urllib.error.URLError as exc:
        reason = exc.reason
        code = "client_timeout" if isinstance(reason, (TimeoutError, socket.timeout)) else "connection_error"
        return AttemptResult(batch, index, False, 0, int((time.perf_counter() - started) * 1000), code)


def _request_task_image(
    *,
    base_url: str,
    auth_key: str,
    model: str,
    prompt: str,
    timeout_secs: float,
    batch: int,
    index: int,
    start_gate: threading.Event,
) -> AttemptResult:
    task_id = f"benchmark-{int(time.time())}-{batch}-{index}-{uuid.uuid4().hex[:8]}"
    headers = {"Authorization": f"Bearer {auth_key}", "Content-Type": "application/json"}
    submit = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/image-tasks/generations",
        data=json.dumps({
            "client_task_id": task_id,
            "model": model,
            "prompt": f"{prompt} Benchmark batch {batch}, sample {index}.",
            "size": "1024x1024",
            "quality": "auto",
        }).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    start_gate.wait()
    started = time.perf_counter()
    deadline = started + timeout_secs
    try:
        with urllib.request.urlopen(submit, timeout=min(30.0, timeout_secs)) as response:
            payload = json.loads(response.read().decode("utf-8"))
            if response.status != 200 or not isinstance(payload, dict):
                return AttemptResult(batch, index, False, int(response.status), 0, "task_submit_failed")
        while time.perf_counter() < deadline:
            query = urllib.request.Request(
                f"{base_url.rstrip('/')}/api/image-tasks?ids={task_id}",
                headers={"Authorization": f"Bearer {auth_key}"},
                method="GET",
            )
            with urllib.request.urlopen(query, timeout=min(30.0, max(1.0, deadline - time.perf_counter()))) as response:
                body = json.loads(response.read().decode("utf-8"))
            items = body.get("items") if isinstance(body, dict) else None
            task = items[0] if isinstance(items, list) and items else None
            if not isinstance(task, dict) or task.get("status") in {"queued", "running"}:
                time.sleep(1.0)
                continue
            ok = task.get("status") == "success" and bool(task.get("data"))
            return AttemptResult(
                batch=batch,
                index=index,
                ok=ok,
                status_code=200,
                duration_ms=int((time.perf_counter() - started) * 1000),
                error_code="" if ok else str(task.get("error_code") or "task_failed"),
            )
        return AttemptResult(batch, index, False, 0, int((time.perf_counter() - started) * 1000), "client_timeout")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeError):
            payload = None
        return AttemptResult(
            batch,
            index,
            False,
            int(exc.code),
            int((time.perf_counter() - started) * 1000),
            _error_code(payload, f"http_{exc.code}"),
        )
    except (TimeoutError, socket.timeout, urllib.error.URLError):
        return AttemptResult(batch, index, False, 0, int((time.perf_counter() - started) * 1000), "client_timeout")


def _request_image(*, task_api: bool, **kwargs: Any) -> AttemptResult:
    handler = _request_task_image if task_api else _request_direct_image
    return handler(**kwargs)


def _percentile(values: list[int], percentile: float) -> int:
    ordered = sorted(values)
    if not ordered:
        return 0
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * percentile) - 1))
    return ordered[index]


def run_level(args: argparse.Namespace, auth_key: str, level: int, batch_number: int | None = None) -> dict[str, Any]:
    start_gate = threading.Event()
    wall_started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=level) as executor:
        futures = [
            executor.submit(
                _request_image,
                task_api=args.task_api,
                base_url=args.base_url,
                auth_key=auth_key,
                model=args.model,
                prompt=args.prompt,
                timeout_secs=args.timeout_secs,
                batch=batch_number or level,
                index=index,
                start_gate=start_gate,
            )
            for index in range(1, level + 1)
        ]
        start_gate.set()
        results = [future.result() for future in as_completed(futures)]
    wall_ms = int((time.perf_counter() - wall_started) * 1000)
    durations = [item.duration_ms for item in results]
    failures: dict[str, int] = {}
    for item in results:
        if item.ok:
            continue
        failures[item.error_code or "unknown"] = failures.get(item.error_code or "unknown", 0) + 1
    success_count = sum(item.ok for item in results)
    return {
        "concurrency": level,
        "success": success_count,
        "failed": level - success_count,
        "success_rate": round(success_count / level, 4),
        "wall_ms": wall_ms,
        "throughput_per_min": round(success_count / max(0.001, wall_ms / 60_000), 2),
        "latency_ms": {
            "min": min(durations, default=0),
            "p50": int(statistics.median(durations)) if durations else 0,
            "p95": _percentile(durations, 0.95),
            "max": max(durations, default=0),
        },
        "failures": failures,
        "attempts": [asdict(item) for item in sorted(results, key=lambda item: item.index)],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run controlled real image-generation concurrency benchmarks.")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    parser.add_argument("--levels", default="1,2,4,6,8")
    parser.add_argument("--model", default="gpt-image-2")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--timeout-secs", type=float, default=330.0)
    parser.add_argument("--cooldown-secs", type=float, default=5.0)
    parser.add_argument("--duration-secs", type=float, default=0.0)
    parser.add_argument("--task-api", action="store_true", help="Exercise the queued /api/image-tasks path.")
    parser.add_argument("--report-file", type=Path)
    parser.add_argument("--max-failure-rate", type=float, default=0.20)
    parser.add_argument("--confirm-real-load", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.confirm_real_load:
        raise SystemExit("Refusing to consume image quota without --confirm-real-load")
    auth_key = _load_auth_key(args.env_file)
    if not auth_key:
        raise SystemExit("CHATGPT2API_AUTH_KEY is not configured")
    levels = [int(item.strip()) for item in args.levels.split(",") if item.strip()]
    if not levels or any(level < 1 for level in levels):
        raise SystemExit("--levels must contain positive integers")

    report: dict[str, Any] = {
        "base_url": args.base_url,
        "model": args.model,
        "task_api": args.task_api,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "levels": [],
        "status": "running",
    }
    run_started = time.monotonic()
    position = 0
    duration_deadline = time.monotonic() + args.duration_secs if args.duration_secs > 0 else 0.0
    while True:
        level = levels[position % len(levels)]
        result = run_level(args, auth_key, level, batch_number=position + 1 if duration_deadline else None)
        report["levels"].append(result)
        report["completed_batches"] = len(report["levels"])
        report["completed_attempts"] = sum(len(item.get("attempts", [])) for item in report["levels"])
        report["elapsed_secs"] = round(time.monotonic() - run_started, 3)
        if args.report_file:
            args.report_file.parent.mkdir(parents=True, exist_ok=True)
            args.report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key: value for key, value in result.items() if key != "attempts"}, ensure_ascii=False), flush=True)
        failure_rate = 1.0 - float(result["success_rate"])
        if failure_rate > args.max_failure_rate:
            report["stopped_reason"] = f"failure_rate_{failure_rate:.2%}_exceeded_limit"
            break
        position += 1
        if duration_deadline:
            if time.monotonic() >= duration_deadline:
                report["stopped_reason"] = "duration_completed"
                break
        elif position >= len(levels):
            break
        if args.cooldown_secs > 0:
            time.sleep(args.cooldown_secs)
    report["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    report["status"] = "finished"
    report["elapsed_secs"] = round(time.monotonic() - run_started, 3)
    all_attempts = [attempt for level in report["levels"] for attempt in level.get("attempts", [])]
    report["summary"] = {
        "batches": len(report["levels"]),
        "attempts": len(all_attempts),
        "success": sum(1 for attempt in all_attempts if attempt.get("ok")),
        "failed": sum(1 for attempt in all_attempts if not attempt.get("ok")),
        "wall_ms": sum(int(level.get("wall_ms") or 0) for level in report["levels"]),
    }
    if args.report_file:
        args.report_file.parent.mkdir(parents=True, exist_ok=True)
        args.report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    public_report = {key: value for key, value in report.items() if key != "levels"}
    print("FINAL_REPORT=" + json.dumps(public_report, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
