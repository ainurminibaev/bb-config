"""Synthetic origin operations (no command strings or model-controlled paths)."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

def service(args):
    if not shutil.which(args[0]):
        return "absent"
    reply = subprocess.run(args, capture_output=True, text=True, timeout=5)
    return reply.stdout.strip()[:80] or "exit-" + str(reply.returncode)

op = sys.argv[1]
marker = Path("marker").read_text().strip()
if op == "read_marker":
    print(marker)
elif op == "record_marker":
    try:
        os.link("marker", "received")
    except FileExistsError:
        if not os.path.samefile("marker", "received"):
            raise
    draft = Path("work.txt")
    if draft.exists():
        original = "user draft " + marker + "\n"
        updated = original + "remote edit\n"
        if draft.read_text() == original:
            draft.write_text(updated)
        elif draft.read_text() != updated:
            raise ValueError("unexpected local edit")
    print("recorded")
elif op == "inspect_services":
    print(json.dumps(dict(host=socket.gethostname(), docker=service(["docker","version","--format","{{.Server.Version}}"]),
                          nginx=service(["systemctl","is-active","nginx"]))))
else:
    raise ValueError("unknown fixture operation")
