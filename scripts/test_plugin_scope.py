import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import snapshot
import restore
import plugin_scope
from plugin_scope import externally_managed, homes, outside, unknown

class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "config/plugins").mkdir(parents=True)
        self.write("externally-managed-plugins", ["telegram-projects"])
        self.write("plugins", [])
        self.write("appearance", {"customCss": ""})
    def write(self, name, value):
        (self.root / "config" / (name + ".json")).write_text(json.dumps(value))
    def test_restore_ignores_stale_manifest_and_settings(self):
        self.write("plugins", [{"id": "telegram-projects", "source": "git:https://example.test/fork", "enabled": True}, {"id": "other", "source": "builtin:other", "enabled": True}])
        self.write("plugins/telegram-projects", {"owner": "private-value"})
        self.write("appearance", {"customCss": ""})
        for install in (False, True):
            commands = restore.plan(install, root=self.root, installed=set())
            self.assertFalse(any("telegram-projects" in cmd or "private-value" in cmd for cmd in commands))
            if install:
                self.assertIn(["bb", "plugin", "enable", "other"], commands)
    def test_snapshot_never_reads_excluded_plugin_settings(self):
        responses = {("plugin", "list"): {"plugins": [{"id": "telegram-projects", "enabled": True, "hasSettings": True}]}, ("settings", "show"): {"generalSettings": {}, "experiments": {}, "appearance": {"themeId": "default", "customCss": None, "faviconColor": None}, "keybindingOverrides": {}}, ("settings", "ui", "list"): {"preferences": {}}, ("settings", "ai-services"): {"selections": {}}}
        with patch.object(snapshot, "ROOT", self.root), patch.object(snapshot, "bb", side_effect=lambda *args: responses[args]):
            values, plugins = snapshot.collect()
        self.assertEqual(plugins, [])
        self.assertEqual(values["plugins"], [])
        self.assertNotIn("plugins/telegram-projects", values)
    def test_missing_policy_preserves_default_scope(self):
        (self.root / "config/externally-managed-plugins.json").unlink()
        self.assertEqual(externally_managed(self.root), set())
    def test_invalid_policy_fails_closed(self):
        self.write("externally-managed-plugins", "telegram-projects")
        with self.assertRaises(ValueError): externally_managed(self.root)

    def test_homes_override_legacy_and_private_wins(self):
        self.write("plugin-homes", {"telegram-projects": {"home": "bb-config"},
                                    "x": {"home": "ignore"}})
        self.assertEqual(outside(self.root), {"x"})
        (self.root / ".local/config").mkdir(parents=True)
        (self.root / ".local/config/plugin-homes.json").write_text(json.dumps({"x": {"home": "bb-config"}}))
        self.assertEqual(outside(self.root), set())
        self.assertEqual(homes(self.root)["telegram-projects"]["home"], "bb-config")
    def test_legacy_list_means_ignore(self):
        self.assertEqual(homes(self.root)["telegram-projects"]["home"], "ignore")
    def test_invalid_homes_fail_closed(self):
        for bad in ({"x": {"home": "elsewhere"}}, {"x": {"home": "project", "project": "p"}},
                    {"x": {"home": "project", "project": "p", "install": "bash ../evil.sh"}}, ["x"]):
            self.write("plugin-homes", bad)
            with self.assertRaises(ValueError): homes(self.root)
    def test_unknown_excludes_recorded_and_manifest(self):
        self.write("plugins", [{"id": "kept", "source": "builtin:kept", "enabled": True}])
        self.write("plugin-homes", {"proj": PROJECT})
        self.assertEqual(unknown(["kept", "proj", "telegram-projects", "new"], self.root), ["new"])
    def test_restore_installs_project_plugin_from_project(self):
        checkout = self.root / "work/demo"
        (checkout / "tools/bb-plugins").mkdir(parents=True)
        self.write("plugins", [{"id": "proj", "source": "path:plugins/proj", "enabled": True}])
        self.write("plugin-homes", {"proj": PROJECT})
        self.write("plugins/proj", {"secret": "private-value"})
        notes = []
        commands = restore.plan(True, root=self.root, installed=set(), notes=notes,
                                find_roots=lambda name: [checkout] if name == "demo" else [])
        project = [c for c in commands if getattr(c, "cwd", None)]
        self.assertEqual(project, [["bash", "tools/bb-plugins/install.sh", "--yes", "proj"]])
        self.assertEqual(project[0].cwd, str(checkout))
        self.assertFalse(any("plugins/proj" in " ".join(c) or "private-value" in " ".join(c) for c in commands))
        self.assertNotIn(["bb", "plugin", "enable", "proj"], commands)
        self.assertEqual(notes, [])
        again = restore.plan(True, root=self.root, installed={"proj"}, find_roots=lambda n: [checkout])
        self.assertFalse(any(getattr(c, "cwd", None) for c in again))
    def test_restore_skips_project_plugin_without_checkout(self):
        self.write("plugin-homes", {"proj": PROJECT})
        notes = []
        commands = restore.plan(True, root=self.root, installed=set(), notes=notes, find_roots=lambda name: [])
        self.assertFalse(any(getattr(c, "cwd", None) for c in commands))
        self.assertEqual(len(notes), 1)
        self.assertIn("demo", notes[0])
        self.assertIn("install.sh", notes[0])
    def test_cli_set_records_answer(self):
        with patch.object(plugin_scope, "ROOT", self.root), patch("builtins.print"):
            plugin_scope.main(["set", "proj", "project", "--project", "demo", "--install", PROJECT["install"]])
            plugin_scope.main(["set", "other", "ignore", "--private"])
        self.assertEqual(homes(self.root)["proj"]["project"], "demo")
        self.assertEqual(homes(self.root)["other"]["home"], "ignore")
        self.assertTrue((self.root / ".local/config/plugin-homes.json").exists())
    def test_repository_homes_are_valid(self):
        repo = Path(__file__).resolve().parents[1]
        data = homes(repo)
        self.assertEqual(data["marusya-worktree"]["home"], "project")

PROJECT = {"home": "project", "project": "demo", "source": "tools/bb-plugins",
           "install": "bash tools/bb-plugins/install.sh --yes proj"}

if __name__ == "__main__": unittest.main()
