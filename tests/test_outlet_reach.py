"""Tests for picking a HUC8's outlet reach, the reach its hydrographs plot.

``feature_IDs.csv`` is not a connected network: many of its reaches flow into
reaches it leaves out. The outlet is found on the full
``nwm_subset_streams.gpkg`` network instead, as the candidate draining the
most upstream stream length.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import fim_logic  # noqa: E402
from test_hydrograph_span import write_streams  # noqa: E402

HUC8 = "07070003"

# A main stem 1 -> 2 -> 3 -> 4 (4 leaves the HUC), joined at 3 by a long
# tributary 10 -> 11, plus a short separate stream 20 draining out on its own.
# Drained length: 1=100, 2=200, 10=250, 11=500, 3=800, 4=900, 20=300.
NETWORK = [
    (1, 2, 100.0),
    (2, 3, 100.0),
    (3, 4, 100.0),
    (4, 0, 100.0),
    (10, 11, 250.0),
    (11, 3, 250.0),
    (20, 0, 300.0),
]


class StreamsTestCase(unittest.TestCase):
    """A temporary FIMserv root, with ``write()`` to give it the stream network."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        patcher = mock.patch.object(fim_logic, "_candidate_fimserv_roots", lambda: [self.root])
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, network=NETWORK):
        write_streams(self.root / "output" / f"flood_{HUC8}" / HUC8, network)


class OutletFeatureIdTests(StreamsTestCase):
    def outlet(self, feature_ids):
        self.write()
        return fim_logic.outlet_feature_id(HUC8, feature_ids)

    def test_most_downstream_reach_of_the_largest_river_wins(self):
        self.assertEqual(self.outlet([1, 2, 3, 4, 10, 11, 20]), 4)

    def test_a_long_short_stream_does_not_beat_the_main_stem(self):
        # 20 is longer than any single main-stem reach, but drains far less.
        self.assertEqual(self.outlet([1, 20]), 20)
        self.assertEqual(self.outlet([3, 20]), 3)

    def test_gaps_in_the_candidates_are_bridged_by_the_full_network(self):
        # 2 and 11 are missing, so 1 and 10 look like exits within the
        # candidates alone; 3 is still the outlet.
        self.assertEqual(self.outlet([1, 3, 10]), 3)

    def test_ids_from_csv_as_numpy_ints_are_accepted(self):
        import numpy as np

        self.assertEqual(self.outlet(list(np.array([1, 4], dtype="int64"))), 4)

    def test_missing_stream_network_is_file_not_found(self):
        with self.assertRaisesRegex(FileNotFoundError, "nwm_subset_streams.gpkg"):
            fim_logic.outlet_feature_id(HUC8, [1])

    def test_no_candidate_in_the_network_is_file_not_found(self):
        with self.assertRaisesRegex(FileNotFoundError, "stream network"):
            self.outlet([999])


class OutletReachFeatureTests(StreamsTestCase):
    """The outlet reach as map GeoJSON; missing data means no marker, not an error."""

    def test_reach_comes_back_in_wgs84_ending_downstream(self):
        from pyproj import Transformer

        self.write()
        feature = fim_logic.outlet_reach_feature(HUC8, 4)
        self.assertEqual(feature["properties"], {"feature_id": 4})
        self.assertEqual(feature["geometry"]["type"], "LineString")
        # write_streams draws the reach at index 3 from (3, 0) to (4, 0) in EPSG:5070.
        lon, lat = Transformer.from_crs(5070, 4326, always_xy=True).transform(4, 0)
        end = feature["geometry"]["coordinates"][-1]
        self.assertAlmostEqual(end[0], lon, places=6)
        self.assertAlmostEqual(end[1], lat, places=6)

    def test_missing_reach_is_none(self):
        self.write()
        self.assertIsNone(fim_logic.outlet_reach_feature(HUC8, 999))

    def test_missing_stream_network_is_none(self):
        self.assertIsNone(fim_logic.outlet_reach_feature(HUC8, 4))


if __name__ == "__main__":
    unittest.main()
