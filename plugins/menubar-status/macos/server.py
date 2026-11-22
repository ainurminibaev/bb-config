#!/usr/bin/env python3
"""Local helper for the bb menu bar (macOS) and notification area (Windows) panel.

Serves the panel page and, from local files the menubar-status plugin keeps
in this folder, the status, account usage and each listed thread's
conversation. Replies and "open in bb" requests go into outbox/, where the
plugin picks them up within a couple of seconds. It never calls bb itself,
holds no credentials, and listens on loopback only; every request must carry
the token created at install time.
"""
import json
import hmac
import os
import re
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("BB_MENUBAR_PORT", "47615"))
THREAD_ID = re.compile(r"^thr_[A-Za-z0-9]{4,40}$")
with open(os.path.join(HERE, "token"), encoding="utf-8") as handle:
    TOKEN = handle.read().strip()


def read_json(*parts):
    try:
        with open(os.path.join(HERE, *parts), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def queue(request):
    """Leaves a request for the plugin; written whole, then renamed into place."""
    outbox = os.path.join(HERE, "outbox")
    os.makedirs(outbox, exist_ok=True)
    name = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    temporary = os.path.join(outbox, f".{name}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(request, handle)
    os.replace(temporary, os.path.join(outbox, f"{name}.json"))


def show_bb():
    """Bring the bb desktop app forward, starting it if needed."""
    if os.name == "nt":
        app = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "bb", "bb.exe")
        if os.path.isfile(app):
            os.startfile(app)
    else:
        subprocess.Popen(["/usr/bin/open", "-a", "bb"])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if not hmac.compare_digest(query.get("t", [""])[0].encode(), TOKEN.encode()):
            self.reply(403, "{}")
            return None
        return url, query

    def do_GET(self):
        checked = self.authorized()
        if not checked:
            return
        url, query = checked
        thread = query.get("thread", [""])[0]
        if url.path == "/":
            with open(os.path.join(HERE, "panel.html"), "rb") as handle:
                self.reply(200, handle.read(), "text/html")
        elif url.path == "/status":
            self.reply(200, json.dumps(read_json("status.json")))
        elif url.path == "/usage":
            self.reply(200, json.dumps(read_json("usage.json") or {"accounts": [], "available": False}))
        elif url.path == "/chat" and THREAD_ID.match(thread):
            chat = read_json("chats", f"{thread}.json")
            self.reply(200 if chat else 404, json.dumps(chat or {"error": "переписка ещё не получена"}))
        elif url.path == "/errors":
            self.reply(200, json.dumps(read_json("errors.json")))
        elif url.path == "/open":
            if THREAD_ID.match(thread):
                queue({"action": "open", "thread": thread})
            show_bb()
            self.reply(200, "{}")
        else:
            self.reply(404, "{}")

    def do_POST(self):
        checked = self.authorized()
        if not checked:
            return
        url, _query = checked
        length = min(int(self.headers.get("Content-Length") or 0), 64_000)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        thread = str(body.get("thread", ""))
        text = str(body.get("text", "")).strip()
        if url.path == "/send" and THREAD_ID.match(thread) and text:
            queue({"action": "send", "thread": thread, "text": text[:20_000], "at": int(time.time() * 1000)})
            self.reply(200, json.dumps({"delivery": "queued"}))
        else:
            self.reply(400, "{}")


class Server(ThreadingHTTPServer):
    # Windows gives a port taken with SO_REUSEADDR to a second process as well and
    # splits the connections between the two: there, one helper per port.
    allow_reuse_address = os.name != "nt"


def leave_with(owner):
    """Windows: ends this helper once the program that started it is gone, however it ended."""
    import ctypes
    import threading

    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x00100000, False, owner)  # SYNCHRONIZE
    if not handle:
        os._exit(0)

    def wait():
        kernel.WaitForSingleObject(ctypes.c_void_p(handle), 0xFFFFFFFF)
        os._exit(0)

    threading.Thread(target=wait, daemon=True).start()


if __name__ == "__main__":
    # server.py [port [process ID of the Windows program that started it]]
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    if len(sys.argv) > 2 and os.name == "nt":
        leave_with(int(sys.argv[2]))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
