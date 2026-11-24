"""Bring one plugin installed from Git to at least the given version."""
import argparse
import json
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["applicable", "check", "apply"])
parser.add_argument("plugin")
parser.add_argument("version")
args = parser.parse_args()


def installed():
    plugins = json.loads(subprocess.check_output(["bb", "plugin", "list", "--json"]))["plugins"]
    return next((p for p in plugins if p["id"] == args.plugin), {})


def number(version):
    return tuple(int(part) for part in version.split("-")[0].split("."))


plugin = installed()
applicable = plugin.get("source", "").startswith("git:") and plugin.get("enabled")
if args.action == "applicable":
    raise SystemExit(0 if applicable else 1)
if not applicable:
    raise SystemExit(args.plugin + " requires an enabled Git installation")


def ready(plugin):
    return number(plugin["version"]) >= number(args.version) and plugin.get("status") == "running"


if ready(plugin):
    raise SystemExit(0)
if args.action == "check":
    raise SystemExit(1)
subprocess.run(["bb", "plugin", "update", args.plugin, "--yes"], check=True)
raise SystemExit(0 if ready(installed()) else args.plugin + " did not reach " + args.version)
