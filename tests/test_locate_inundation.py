"""Tests for ``_locate_generated_inundation_tif`` (issue #4).

The lookup must only ever return a raster whose filename carries the
requested event timestamp. A stale raster from another date, or a
custom-discharge raster, must never be substituted - the caller publishes
whatever comes back as the job's result, so a wrong match silently serves
the wrong flood map.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import fim_logic  # noqa: E402

HUC8 = "12090301"
WHEN = "2023-05-10 14:30:00"


class LocateGeneratedInundationTifTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.inundation_dir = Path(self._tmp.name) / "output" / f"flood_{HUC8}" / f"{HUC8}_inundation"
        self.inundation_dir.mkdir(parents=True)
        # Pin the search to our temp dir so the developer's real FIMserv
        # tree (and the repo's own output/) can't influence the result.
        patcher = mock.patch.object(
            fim_logic, "_candidate_inundation_dirs", lambda huc8: [self.inundation_dir]
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def touch(self, name):
        path = self.inundation_dir / name
        path.write_bytes(b"")
        return path

    def test_exact_timestamp_match_is_returned(self):
        expected = self.touch(f"NWM_20230510143000_{HUC8}_inundation.tif")
        match, msg = fim_logic._locate_generated_inundation_tif(HUC8, WHEN)
        self.assertEqual(match, expected)
        self.assertEqual(msg, "")

    def test_seconds_rounded_to_zero_still_matches(self):
        # FIMserv sometimes writes the seconds field as 00.
        expected = self.touch(f"NWM_20230510143000_{HUC8}_inundation.tif")
        match, msg = fim_logic._locate_generated_inundation_tif(HUC8, "2023-05-10 14:30:45")
        self.assertEqual(match, expected)
        self.assertEqual(msg, "")

    def test_stale_raster_from_another_event_is_not_returned(self):
        self.touch(f"NWM_20200101000000_{HUC8}_inundation.tif")
        match, msg = fim_logic._locate_generated_inundation_tif(HUC8, WHEN)
        self.assertIsNone(match)
        self.assertIn(WHEN, msg)
        # The diagnostic should still name what was on disk, for debugging.
        self.assertIn(f"NWM_20200101000000_{HUC8}_inundation.tif", msg)

    def test_custom_discharge_raster_never_satisfies_an_nwm_lookup(self):
        self.touch(f"CustomQ_100_0_{HUC8}_inundation.tif")
        match, msg = fim_logic._locate_generated_inundation_tif(HUC8, WHEN)
        self.assertIsNone(match)
        self.assertIn("CustomQ", msg)

    def test_empty_directory_reports_no_other_rasters(self):
        match, msg = fim_logic._locate_generated_inundation_tif(HUC8, WHEN)
        self.assertIsNone(match)
        self.assertIn("none", msg)


if __name__ == "__main__":
    unittest.main()
