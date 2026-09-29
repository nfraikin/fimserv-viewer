"""Tests for picking a HUC8's outlet reach, the reach its hydrographs plot.

``feature_IDs.csv`` is not a connected network: many of its reaches flow into
reaches it leaves out. The outlet is found on the full
``nwm_subset_streams.gpkg`` network instead, as the candidate draining the
most upstream stream length, skipping reaches NWM has no flow for (inside a
reservoir) and reaches that start outside the HUC.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tethysapp.fimserve_viewer import fim_logic  # noqa: E402
from hydrofabric import write_hydrofabric  # noqa: E402

HUC8 = "07070003"
LAKE = 77

# The HUC is the box x in [-50, 350], y in [-350, 350] (metres, EPSG:5070).
# A main stem 1 -> 2 -> 3 -> 4 runs east along y = 0, and 4 crosses out of
# the HUC at x = 350 into 5, a buffer reach wholly outside. A long tributary
# 10 -> 11 joins at 3, and a short separate stream 20 runs south.
# Drained length: 1=100, 2=200, 10=200, 11=300, 3=600, 4=700, 5=800, 20=250.
HUC_BOX = (-50, -350, 350, 350)
# A reservoir on the main stem from 3 on, across the HUC's edge.
THROUGH_EDGE = {3: LAKE, 4: LAKE, 5: LAKE}


def network(lakes=None):
    """The reaches above, with ``lakes`` mapping reach ID to a Lake ID."""
    lakes = lakes or {}
    reaches = [
        (1, 2, [(0, 0), (100, 0)]),
        (2, 3, [(100, 0), (200, 0)]),
        (3, 4, [(200, 0), (300, 0)]),
        (4, 5, [(300, 0), (400, 0)]),
        (5, 0, [(400, 0), (500, 0)]),
        (10, 11, [(200, 300), (200, 100)]),
        (11, 3, [(200, 100), (200, 0)]),
        (20, 0, [(0, -50), (0, -300)]),
    ]
    return [r + (lakes[r[0]],) if r[0] in lakes else r for r in reaches]


class StreamsTestCase(unittest.TestCase):
    """A temporary FIMserv root, with ``write()`` to give it a hydrofabric."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        patcher = mock.patch.object(fim_logic, "_candidate_fimserv_roots", lambda: [self.root])
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, lakes=None):
        write_hydrofabric(
            self.root / "output" / f"flood_{HUC8}" / HUC8, network(lakes), HUC_BOX
        )


class OutletFeatureIdTests(StreamsTestCase):
    def outlet(self, feature_ids, lakes=None):
        self.write(lakes)
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

    def test_buffer_reach_starting_outside_the_huc_is_passed_over(self):
        # 5 drains the most, but it lies downstream of the HUC's real outlet.
        self.assertEqual(self.outlet([3, 4, 5]), 4)

    def test_reaches_inside_a_reservoir_are_passed_over(self):
        # The reservoir reaches past the HUC's edge, so NWM has no flow for 3
        # or 4, and the largest river entering it wins: the tributary's 11
        # (300) over the main stem's 2 (200).
        self.assertEqual(self.outlet([1, 2, 3, 4, 11], lakes=THROUGH_EDGE), 11)
        self.assertEqual(self.outlet([1, 2, 3, 4], lakes=THROUGH_EDGE), 2)

    def test_a_reservoirs_outflow_reach_is_kept(self):
        # 3 drains the lake into 4, outside it, so NWM reports its flow.
        self.assertEqual(self.outlet([2, 3], lakes={2: LAKE, 3: LAKE}), 3)

    def test_ids_from_csv_as_numpy_ints_are_accepted(self):
        import numpy as np

        self.assertEqual(self.outlet(list(np.array([1, 4], dtype="int64"))), 4)

    def test_missing_stream_network_is_file_not_found(self):
        with self.assertRaisesRegex(FileNotFoundError, "nwm_subset_streams.gpkg"):
            fim_logic.outlet_feature_id(HUC8, [1])

    def test_no_candidate_in_the_network_is_file_not_found(self):
        with self.assertRaisesRegex(FileNotFoundError, "stream network"):
            self.outlet([999])

    def test_no_candidate_with_flow_is_file_not_found(self):
        with self.assertRaisesRegex(FileNotFoundError, "NWM streamflow"):
            self.outlet([3, 4], lakes=THROUGH_EDGE)


class OutletReachFeatureTests(StreamsTestCase):
    """The outlet reach as map GeoJSON; missing data means no marker, not an error."""

    def lonlat(self, x, y):
        from pyproj import Transformer

        return Transformer.from_crs(5070, 4326, always_xy=True).transform(x, y)

    def assertMarkerAt(self, feature, x, y):
        lon, lat = self.lonlat(x, y)
        self.assertAlmostEqual(feature["properties"]["marker"][0], lon, places=6)
        self.assertAlmostEqual(feature["properties"]["marker"][1], lat, places=6)

    def test_marker_sits_where_the_reach_leaves_the_huc(self):
        # 4 runs from x=300 to x=400; the HUC ends at x=350.
        self.write()
        feature = fim_logic.outlet_reach_feature(HUC8, 4)
        self.assertEqual(feature["properties"]["feature_id"], 4)
        self.assertFalse(feature["properties"]["enters_reservoir"])
        self.assertEqual(feature["geometry"]["type"], "LineString")
        end = feature["geometry"]["coordinates"][-1]
        self.assertAlmostEqual(end[0], self.lonlat(400, 0)[0], places=6)
        self.assertMarkerAt(feature, 350, 0)

    def test_marker_sits_at_the_downstream_end_of_a_reach_inside(self):
        self.write()
        self.assertMarkerAt(fim_logic.outlet_reach_feature(HUC8, 3), 300, 0)

    def test_reach_flowing_into_a_reservoir_is_flagged(self):
        self.write(lakes=THROUGH_EDGE)
        self.assertTrue(fim_logic.outlet_reach_feature(HUC8, 11)["properties"]["enters_reservoir"])
        # 20 runs straight out of the network, past no reservoir.
        self.assertFalse(fim_logic.outlet_reach_feature(HUC8, 20)["properties"]["enters_reservoir"])

    def test_reservoir_outside_the_huc_is_not_flagged(self):
        self.write(lakes={5: LAKE})
        self.assertFalse(fim_logic.outlet_reach_feature(HUC8, 4)["properties"]["enters_reservoir"])

    def test_missing_reach_is_none(self):
        self.write()
        self.assertIsNone(fim_logic.outlet_reach_feature(HUC8, 999))

    def test_missing_stream_network_is_none(self):
        self.assertIsNone(fim_logic.outlet_reach_feature(HUC8, 4))


if __name__ == "__main__":
    unittest.main()
