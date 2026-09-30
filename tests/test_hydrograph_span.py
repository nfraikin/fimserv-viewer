"""Tests for the retrospective hydrograph's fetch span and reach.

The span around the selected moment must stay inside the NWM v3.0
retrospective record: teehr rejects the whole request if either end falls
outside it, which made the hydrograph fail on the app's own default date
(2023-01-31, the record's last day). The series is the HUC's outlet reach,
not an average over every reach.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tethysapp.fimserve_viewer import fim_logic  # noqa: E402
from hydrofabric import write_hydrofabric  # noqa: E402

FIRST = fim_logic.NWM_RETRO_FIRST_HOUR
LAST = fim_logic.NWM_RETRO_LAST_HOUR


def hourly_rows(hours, location_ids, value):
    """teehr's long-format rows: one per hour per reach."""
    import pandas as pd

    return pd.DataFrame(
        [(t, f"nwm30-{fid}", value) for t in hours for fid in location_ids],
        columns=["value_time", "location_id", "value"],
    )


class FetchSpanTests(unittest.TestCase):
    def test_mid_record_span_is_untouched(self):
        start, end, clipped = fim_logic.hydrograph_fetch_span(datetime(2022, 4, 27, 12), 14)
        self.assertEqual((start, end, clipped), (datetime(2022, 4, 13), datetime(2022, 5, 11), False))

    def test_default_date_is_trimmed_at_the_end_of_the_record(self):
        start, end, clipped = fim_logic.hydrograph_fetch_span(datetime(2023, 1, 31), 14)
        self.assertEqual((start, end, clipped), (datetime(2023, 1, 17), LAST, True))

    def test_trim_applies_to_a_one_day_span_too(self):
        _start, end, clipped = fim_logic.hydrograph_fetch_span(datetime(2023, 1, 31, 12), 1)
        self.assertEqual((end, clipped), (LAST, True))

    def test_start_is_trimmed_to_the_first_hour_not_midnight(self):
        # teehr's record starts at 01:00; midnight on 1979-02-01 is rejected.
        start, end, clipped = fim_logic.hydrograph_fetch_span(datetime(1979, 2, 3), 14)
        self.assertEqual((start, end, clipped), (FIRST, datetime(1979, 2, 17), True))

    def test_span_never_leaves_the_record_for_any_window(self):
        for moment in (datetime(1979, 2, 1), datetime(2023, 1, 31, 23)):
            for days in (1, 3, 7, 14, 30):
                start, end, _ = fim_logic.hydrograph_fetch_span(moment, days)
                self.assertGreaterEqual(start, FIRST, (moment, days))
                self.assertLessEqual(end, LAST, (moment, days))
                self.assertLess(start, end, (moment, days))


class ParquetNameTests(unittest.TestCase):
    def test_matches_teehr_naming_for_a_multi_day_span(self):
        self.assertEqual(
            fim_logic.retro_parquet_name(datetime(2023, 1, 17), LAST),
            "20230117_20230131.parquet",
        )

    def test_single_day_uses_one_date(self):
        self.assertEqual(
            fim_logic.retro_parquet_name(datetime(2023, 1, 31, 1), LAST), "20230131.parquet"
        )


class BuildPayloadTests(unittest.TestCase):
    """Runs the real payload builder with teehr's network fetch replaced."""

    HUC8 = "07070003"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        flood_dir = root / "output" / f"flood_{self.HUC8}"
        flood_dir.mkdir(parents=True)
        (flood_dir / "feature_IDs.csv").write_text("feature_id\n101\n202\n")
        self.retro_dir = flood_dir / "discharge" / "nwm30_retrospective"
        # 101 flows into 202, which leaves the HUC: 202 is the outlet.
        write_hydrofabric(
            flood_dir / self.HUC8,
            [(101, 202, [(0, 0), (1000, 0)]), (202, 0, [(1000, 0), (2000, 0)])],
        )
        for target, value in (
            ("_candidate_data_inputs_dirs", lambda: []),
            ("_candidate_fimserv_roots", lambda: [root]),
        ):
            patcher = mock.patch.object(fim_logic, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.calls = []
        self.location_ids = []

    def fake_fetch(self, nwm_version, variable_name, start_date, end_date,
                   location_ids, output_parquet_dir, **_):
        """Mimic teehr: enforce its bounds, write hourly rows, name the file its way."""
        import pandas as pd
        import teehr.fetching.nwm.retrospective_points as nwm_retro
        import xarray as xr

        start, end = pd.Timestamp(start_date), pd.Timestamp(end_date)
        self.calls.append((start, end))
        self.location_ids.append(list(location_ids))
        nwm_retro.validate_retrospective_start_end_date(nwm_version, start, end)
        hours = pd.date_range(start, end, freq="h")
        name = nwm_retro.format_grouped_filename(xr.DataArray(hours, dims="time", coords={"time": hours}))
        path = Path(output_parquet_dir) / name
        if path.exists():  # teehr's overwrite_output=False default
            return
        hourly_rows(hours, location_ids, 1.0).to_parquet(path)

    def build(self, date_str, days=14):
        with mock.patch(
            "teehr.fetching.nwm.retrospective_points.nwm_retro_to_parquet", self.fake_fetch
        ):
            return fim_logic.build_hydrograph_payload(self.HUC8, date_str, window_days=days)

    def test_default_date_returns_a_trimmed_series(self):
        payload = self.build("2023-01-31-00-00-00")
        self.assertEqual(payload["status"], "success")
        self.assertTrue(payload["clipped"])
        self.assertEqual(self.calls, [(datetime(2023, 1, 17), LAST)])
        self.assertEqual(payload["times"][0], "2023-01-17T00:00:00")
        self.assertEqual(payload["times"][-1], "2023-01-31T23:00:00")

    def test_first_days_of_the_record_return_a_trimmed_series(self):
        payload = self.build("1979-02-01-00-00-00", days=3)
        self.assertTrue(payload["clipped"])
        self.assertEqual(payload["times"][0], "1979-02-01T01:00:00")

    def test_mid_record_date_is_not_flagged(self):
        payload = self.build("2022-04-27-12-00-00")
        self.assertFalse(payload["clipped"])
        self.assertEqual(len(payload["times"]), 28 * 24 + 1)

    def test_series_is_fetched_for_the_outlet_reach_only(self):
        payload = self.build("2022-04-27-12-00-00")
        self.assertEqual(payload["feature_id"], 202)
        self.assertEqual(self.location_ids, [[202]])
        self.assertEqual(payload["outlet"]["properties"]["feature_id"], 202)

    def test_all_reach_parquet_from_before_the_change_yields_the_outlet_alone(self):
        # teehr keeps the file on disk, so the outlet must be picked out of it
        # rather than every reach in it averaged.
        import pandas as pd

        start, end, _ = fim_logic.hydrograph_fetch_span(datetime(2022, 4, 27), 14)
        hours = pd.date_range(start, end, freq="h")
        self.retro_dir.mkdir(parents=True)
        pd.concat([hourly_rows(hours, [101], 50.0), hourly_rows(hours, [202], 5.0)]).to_parquet(
            self.retro_dir / fim_logic.retro_parquet_name(start, end)
        )
        payload = self.build("2022-04-27-12-00-00")
        self.assertEqual(len(payload["times"]), len(hours))
        self.assertEqual(set(payload["values"]), {5.0})

    def test_date_outside_the_record_is_a_value_error(self):
        with self.assertRaisesRegex(ValueError, "NWM v3.0 retrospective coverage"):
            self.build("2023-02-01-00-00-00")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
