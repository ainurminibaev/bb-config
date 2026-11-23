#!/usr/bin/env python3
"""Test double for `codex exec --json`. Behaviour is chosen by FAKE_CODEX_MODE:
ok | limit | auth | crash_after_image | crash_before_image | hang. Counts calls in FAKE_CODEX_CALLS."""
import json
import os
import sys
import time
import uuid
from pathlib import Path

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
       b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82")

if sys.argv[1:2] == ["app-server"]:
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get("id") == 2:
            print(json.dumps({"id": 2, "result": {"account": {"type": "chatgpt", "email": os.environ.get("FAKE_CODEX_EMAIL", "same@example.com"), "planType": "pro"}}}), flush=True)
    sys.exit(0)
if sys.argv[1:2] == ["--version"]:
    print("codex-cli 0.0.0-fake"); sys.exit(0)
if sys.argv[1:3] == ["login", "status"]:
    print("Logged in using ChatGPT", file=sys.stderr); sys.exit(0)  # real Codex uses stderr here
if sys.argv[1:3] == ["features", "list"]:
    print("image_generation                         stable             true"); sys.exit(0)
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
time.sleep(float(os.environ.get("FAKE_CODEX_DELAY", "0")))
calls = Path(os.environ["FAKE_CODEX_CALLS"])
calls.write_text(calls.read_text() + json.dumps(sys.argv[1:]) + "\n" if calls.exists() else json.dumps(sys.argv[1:]) + "\n")
tid = str(uuid.uuid4())
print(json.dumps({"type": "thread.started", "thread_id": tid}), flush=True)
if mode == "limit":
    print(json.dumps({"type": "error", "message": "You've hit your usage limit. Try again at 6:40 PM."}), flush=True)
    sys.exit(1)
if mode == "auth":
    print("Error: Not logged in. Run codex login.", file=sys.stderr)
    sys.exit(1)
if mode == "hang":
    time.sleep(60)
if mode == "crash_before_image":
    os._exit(137)
folder = Path(os.environ["CODEX_HOME"]) / "generated_images" / tid
folder.mkdir(parents=True)
(folder / f"exec-{uuid.uuid4()}.png").write_bytes(PNG)
if mode == "crash_after_image":
    os._exit(137)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "DONE"}}), flush=True)
print(json.dumps({"type": "turn.completed"}), flush=True)
