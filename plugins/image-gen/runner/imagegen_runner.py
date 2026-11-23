#!/usr/bin/env python3
"""Run one image-generation job on this machine through the built-in Codex image_gen tool.

The runner is started by the BB plugin in a host_path terminal. It is stdlib-only and
idempotent per job directory:

  <job-dir>/request.json   written by the plugin (prompt, count, references)
  <job-dir>/attempt.json   written BEFORE Codex starts; holds codex thread id once known
  <job-dir>/outputs/       verified copies of generated images
  <job-dir>/result.json    terminal outcome (completed|failed|limited|auth|unknown|fenced)

Rules that prevent duplicate generations:
  * result.json present  -> never run Codex again, exit with the recorded outcome.
  * attempt.json present -> a previous run may have generated (and spent quota).
    Recover images from $CODEX_HOME/generated_images/<thread_id>; if nothing can be
    proven, record `unknown` and exit. Only --allow-rerun (explicit user retry) runs again.

Exit codes: 0 completed, 2 failed, 3 unknown, 4 fenced, 75 limited, 77 auth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
EXIT = {"completed": 0, "failed": 2, "unknown": 3, "fenced": 4, "limited": 75, "auth": 77}
# Strings seen by the previous image-gen service plus generic rate-limit markers.
LIMIT_RE = re.compile(r"usage limit|hit your .*limit|purchase more credits|upgrade to (plus|pro)|limit reached|"
                      r"rate.?limit|too many requests|\b429\b|quota", re.I)
AUTH_RE = re.compile(r"not logged in|unauthori[sz]ed|\b401\b|login required|codex login", re.I)
RESET_RE = re.compile(r"try again (?:at|in) ([^.\n\"]+)", re.I)


def now_ms() -> int:
    return int(time.time() * 1000)


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def build_prompt(request: dict, ref_count: int) -> str:
    count = int(request.get("count", 1))
    parts = [
        f"Use the built-in image_gen tool to produce exactly {count} image(s).",
        "Do not run shell commands, do not create or copy files, do not draw with code.",
        "Do not use the CLI/API fallback of the imagegen skill.",
    ]
    if ref_count:
        mode = "Edit the first attached image as instructed" if request.get("mode") == "edit" else "Use the attached image(s) as visual references"
        parts.append(f"{mode} ({ref_count} attached); pass them to image_gen as input images.")
    if request.get("size"):
        parts.append(f"Preferred aspect/size: {request['size']}.")
    if request.get("transparent"):
        parts.append("Request a transparent background.")
    parts.append("Image request:\n" + request["prompt"].strip())
    parts.append("When the image(s) are generated, reply with the single word DONE.")
    return "\n".join(parts)


def find_images(thread_id: str | None) -> list[Path]:
    if not thread_id or not re.fullmatch(r"[0-9A-Za-z-]{8,80}", thread_id):
        return []
    folder = codex_home() / "generated_images" / thread_id
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def collect(job: Path, thread_id: str, images: list[Path], keep_originals: bool, extra: dict) -> dict:
    out = job / "outputs"
    out.mkdir(exist_ok=True)
    items = []
    for i, src in enumerate(images, 1):
        target = out / f"image-{i}{src.suffix.lower()}"
        before = sha256(src)
        if not target.exists():
            shutil.copy2(src, target)
        digest = sha256(target)
        if digest != before:
            raise RuntimeError(f"copy verification failed for {src.name}")
        items.append({"path": str(target), "name": target.name, "bytes": target.stat().st_size,
                      "sha256": digest, "codexOriginal": src.name})
    if not keep_originals:
        for src in images:
            src.unlink(missing_ok=True)
        try:
            (codex_home() / "generated_images" / thread_id).rmdir()
        except OSError:
            pass
    request = read_json(job / "request.json") or {}
    result = {
        "status": "completed", "finishedAt": now_ms(), "images": items,
        "provenance": {
            "generator": "codex built-in image_gen", "codexThreadId": thread_id,
            "promptSha256": hashlib.sha256(request.get("prompt", "").encode()).hexdigest(),
            "references": request.get("references", []), "jobId": request.get("jobId"),
            "sourceThreadId": request.get("sourceThreadId"), "host": os.uname().nodename,
            **extra,
        },
    }
    write_json(job / "result.json", result)
    return result


def classify(text: str) -> tuple[str, str | None]:
    if AUTH_RE.search(text):
        return "auth", None
    if LIMIT_RE.search(text):
        m = RESET_RE.search(text)
        return "limited", (m.group(1).strip() if m else None)
    return "failed", None


def lease_valid(path: str | None, token: str | None) -> bool:
    if not path:
        return True
    data = read_json(Path(path))
    return bool(data) and data.get("token") == token and data.get("expiresAt", 0) > now_ms()


def run(args: argparse.Namespace) -> int:
    job = Path(args.job_dir).resolve()
    request = read_json(job / "request.json")
    if not request or not request.get("prompt"):
        print("request.json with prompt is required", file=sys.stderr)
        return EXIT["failed"]

    existing = read_json(job / "result.json")
    if existing and existing.get("status") in ("completed", "failed", "limited", "auth") and not args.allow_rerun:
        print(json.dumps({"reused": True, "status": existing["status"]}))
        return EXIT.get(existing["status"], 2)

    attempt = read_json(job / "attempt.json")
    if attempt and not args.allow_rerun:
        images = find_images(attempt.get("codexThreadId"))
        if images:
            result = collect(job, attempt["codexThreadId"], images, args.keep_originals, {"recovered": True})
            print(json.dumps({"recovered": True, "images": len(result["images"])}))
            return 0
        write_json(job / "result.json", {"status": "unknown", "finishedAt": now_ms(),
                   "error": "A previous attempt started Codex and left no verifiable images; not regenerating automatically."})
        return EXIT["unknown"]

    refs = [str(Path(r).resolve()) for r in request.get("references", [])]
    for r in refs:
        if not Path(r).is_file():
            write_json(job / "result.json", {"status": "failed", "finishedAt": now_ms(), "error": f"reference not found: {r}"})
            return EXIT["failed"]

    attempt = {"startedAt": now_ms(), "pid": os.getpid(), "codexThreadId": None,
               "attemptNo": (attempt or {}).get("attemptNo", 0) + 1}
    write_json(job / "attempt.json", attempt)  # fence: from here a rerun is never automatic

    cmd = [args.codex, "exec", "--json", "--skip-git-repo-check", "--disable", "memories",
           "-s", "workspace-write", "-C", str(job)]
    if args.model:
        cmd += ["-m", args.model]
    for r in refs:
        cmd += ["-i", r]
    cmd += ["--", build_prompt(request, len(refs))]  # `-i` takes many values: `--` keeps the prompt from being read as an image

    log = (job / "codex-events.jsonl").open("a", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=job, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    stderr_chunks: list[str] = []
    t = threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)
    t.start()
    fenced = {"value": False}

    def watchdog() -> None:
        deadline = time.time() + args.timeout
        while proc.poll() is None:
            if time.time() > deadline or not lease_valid(args.lease_file, args.lease_token):
                fenced["value"] = time.time() <= deadline
                os.killpg(proc.pid, signal.SIGTERM)
                return
            time.sleep(2)

    threading.Thread(target=watchdog, daemon=True).start()
    event_text = []
    for line in proc.stdout:
        log.write(line)
        log.flush()
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started" and event.get("thread_id"):
            attempt["codexThreadId"] = event["thread_id"]
            write_json(job / "attempt.json", attempt)
        if event.get("type") in ("error", "turn.failed"):
            event_text.append(json.dumps(event, ensure_ascii=False))
    code = proc.wait()
    t.join(5)
    log.close()

    images = find_images(attempt.get("codexThreadId"))
    if images:  # images that exist are always kept, whatever the exit code
        collect(job, attempt["codexThreadId"], images, args.keep_originals, {"codexExitCode": code})
        return 0
    if fenced["value"]:
        write_json(job / "result.json", {"status": "fenced", "finishedAt": now_ms(),
                   "error": "Executor lease lost; attempt stopped."})
        return EXIT["fenced"]
    text = "".join(stderr_chunks)[-4000:] + "\n" + "\n".join(event_text)[-4000:]
    status, reset = classify(text)
    write_json(job / "result.json", {"status": status, "finishedAt": now_ms(), "codexExitCode": code,
               "resetHint": reset, "error": text.strip()[-1500:] or f"codex exited with {code} and no image"})
    return EXIT[status]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--job-dir", required=True)
    p.add_argument("--codex", default=os.environ.get("IMAGEGEN_CODEX_BIN", "codex"))
    p.add_argument("--model")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--lease-file")
    p.add_argument("--lease-token")
    p.add_argument("--keep-originals", action="store_true")
    p.add_argument("--allow-rerun", action="store_true", help="explicit user retry after unknown outcome")
    return run(p.parse_args())


if __name__ == "__main__":
    sys.exit(main())
