"""Plugins installed independently are outside bb-config management."""
import json

RETIRED_PLUGINS = {"tokenomics"}

def externally_managed(root):
    path = root / "config/externally-managed-plugins.json"
    if not path.exists():
        return set()
    data = json.loads(path.read_text())
    if not isinstance(data, list) or any(not isinstance(x, str) or not x for x in data):
        raise ValueError("externally-managed-plugins.json must contain plugin IDs")
    return set(data)
