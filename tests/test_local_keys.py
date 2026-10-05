"""Tests for reading API keys from the keys file outside the repo.

No real keys: each test writes its own file in a temporary directory.

Run with:  python -m unittest discover -s tests
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import local_keys  # noqa: E402


class ReadKeysTests(unittest.TestCase):
    def write(self, text):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "keys.env"
        path.write_text(text, encoding="utf-8")
        return path

    def test_name_value_lines_are_read(self):
        path = self.write("MAPBOX_TOKEN=pk.abc\nCIROH_API_KEY=xyz\n")
        self.assertEqual(local_keys.read_keys(path), {"MAPBOX_TOKEN": "pk.abc", "CIROH_API_KEY": "xyz"})

    def test_comments_blanks_spaces_and_quotes_are_tolerated(self):
        path = self.write("# my keys\n\n  MAPBOX_TOKEN = \"pk.abc\"  \nnot a key line\n")
        self.assertEqual(local_keys.read_keys(path), {"MAPBOX_TOKEN": "pk.abc"})

    def test_value_may_contain_equals_signs(self):
        path = self.write("TOKEN=a=b==\n")
        self.assertEqual(local_keys.read_keys(path), {"TOKEN": "a=b=="})

    def test_missing_file_is_no_keys(self):
        self.assertEqual(local_keys.read_keys(Path(tempfile.gettempdir()) / "no-such-keys.env"), {})


class GetTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "keys.env"
        self.path.write_text("MAPBOX_TOKEN=from-file\n", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {local_keys.KEYS_FILE_ENV: str(self.path)})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("MAPBOX_TOKEN", None)

    def test_file_is_used_when_nothing_else_is_set(self):
        self.assertEqual(local_keys.get("MAPBOX_TOKEN"), "from-file")

    def test_environment_wins_over_the_file(self):
        with mock.patch.dict(os.environ, {"MAPBOX_TOKEN": "from-env"}):
            self.assertEqual(local_keys.get("MAPBOX_TOKEN"), "from-env")

    def test_app_setting_wins_over_both(self):
        with mock.patch.dict(os.environ, {"MAPBOX_TOKEN": "from-env"}):
            self.assertEqual(local_keys.get("MAPBOX_TOKEN", "from-setting"), "from-setting")

    def test_unset_key_is_none(self):
        self.assertIsNone(local_keys.get("NOT_A_KEY"))

    def test_an_edited_file_takes_effect_without_a_restart(self):
        self.path.write_text("MAPBOX_TOKEN=edited\n", encoding="utf-8")
        self.assertEqual(local_keys.get("MAPBOX_TOKEN"), "edited")


if __name__ == "__main__":
    unittest.main()
