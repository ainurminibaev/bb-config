"""Apply the Machine Tabs role-order update to an existing Git installation."""
import argparse
import json
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["applicable", "check", "apply"])
action = parser.parse_args().action
plugins = json.loads(subprocess.check_output(["bb", "plugin", "list", "--json"]))["plugins"]
plugin = next((p for p in plugins if p["id"] == "machine-tabs"), {})
applicable = plugin.get("source", "").startswith("git:") and plugin.get("enabled")
if action == "applicable":
    raise SystemExit(0 if applicable else 1)
if not applicable:
    raise SystemExit("Machine Tabs requires an enabled Git installation")
version = tuple(map(int, plugin["version"].split(".")))
if version >= (0, 2, 19) and plugin.get("status") == "running":
    raise SystemExit(0)
if action == "check":
    raise SystemExit(1)
subprocess.run(["bb", "plugin", "update", "machine-tabs", "--yes"], check=True)
