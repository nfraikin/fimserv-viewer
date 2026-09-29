"""Tests for the NWM short-range forecast path (issue #31).

Covers the rules the forecast page depends on: hours are chosen by valid
time, stale hours are never offered or accepted, a half-uploaded cycle
falls back to the previous one, and reading a channel file matches the
real encoding (int32 * 0.01 scale, -999900 fill).

No network: the bucket is a fake filesystem and the channel file is built
in memory with the same structure as the published ones.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import forecast  # noqa: E402

CYCLE = datetime(2026, 9, 29, 14)


def channel_blob(valid, feature_ids, flows):
    """Bytes of a minimal NWM channel_rt file, encoded like the real ones."""
    import netCDF4

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "channel.nc"
        with netCDF4.Dataset(path, "w") as nc:
            nc.createDimension("feature_id", len(feature_ids))
            nc.createDimension("time", 1)
            fid = nc.createVariable("feature_id", "i8", ("feature_id",))
            fid[:] = feature_ids
            t = nc.createVariable("time", "i4", ("time",))
            t.units = "minutes since 1970-01-01 00:00:00 UTC"
            t[:] = [int((valid - datetime(1970, 1, 1)).total_seconds() // 60)]
            q = nc.createVariable(
                "streamflow", "i4", ("feature_id",), fill_value=np.int32(-999900)
            )
            q.scale_factor = np.float32(0.01)
            q.add_offset = np.float32(0.0)
            q.units = "m3 s-1"
            flows = np.asarray(flows, dtype="float64")
            q[:] = np.ma.array(np.nan_to_num(flows), mask=np.isnan(flows))
        return path.read_bytes()


class FakeFS:
    """Stands in for s3fs: a dict of key -> bytes plus directory listings."""

    def __init__(self, files=None):
        self.files = dict(files or {})

    def ls(self, prefix, detail=False):
        names = [k for k in self.files if k.startswith(prefix)]
        if not names:
            raise FileNotFoundError(prefix)
        return names

    def cat(self, key):
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    def exists(self, key):
        return key in self.files


def publish_cycle(fs, cycle, hours=range(1, 19), blob=b""):
    for f in hours:
        fs.files[forecast.channel_key(cycle, f)] = blob


class TokenTests(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(forecast.to_token(CYCLE), "2026092914")
        self.assertEqual(forecast.parse_token("2026092914"), CYCLE)

    def test_rejects_anything_but_ten_digits(self):
        # Tokens become storage filename patterns, so a "*" must never pass.
        for bad in ("2026092914*", "*", "202609291", "20260929140", "2026-09-29", ""):
            with self.assertRaises(ValueError, msg=bad):
                forecast.parse_token(bad)

    def test_channel_key_matches_bucket_layout(self):
        self.assertEqual(
            forecast.channel_key(CYCLE, 3),
            "noaa-nwm-pds/nwm.20260929/short_range/"
            "nwm.t14z.short_range.channel_rt.f003.conus.nc",
        )


class UpcomingHoursTests(unittest.TestCase):
    def test_only_future_valid_times_are_offered(self):
        # 16:20 with a 14z cycle: f001 (15:00) and f002 (16:00) have passed.
        hours = forecast.upcoming_hours(CYCLE, now=datetime(2026, 9, 29, 16, 20))
        self.assertEqual(hours[0]["forecast_hour"], 3)
        self.assertEqual(hours[0]["valid_token"], "2026092917")
        self.assertEqual(hours[-1]["forecast_hour"], 18)
        self.assertEqual(len(hours), 16)

    def test_hour_is_stale_at_its_valid_time(self):
        hours = forecast.upcoming_hours(CYCLE, now=datetime(2026, 9, 29, 17, 0))
        self.assertEqual(hours[0]["valid_token"], "2026092918")

    def test_fully_stale_cycle_offers_nothing(self):
        self.assertEqual(forecast.upcoming_hours(CYCLE, now=datetime(2026, 9, 30, 9)), [])


class LatestCycleTests(unittest.TestCase):
    def test_newest_complete_cycle_wins(self):
        fs = FakeFS()
        publish_cycle(fs, datetime(2026, 9, 29, 13))
        publish_cycle(fs, datetime(2026, 9, 29, 14))
        self.assertEqual(
            forecast.latest_complete_cycle(datetime(2026, 9, 29, 16, 5), fs),
            datetime(2026, 9, 29, 14),
        )

    def test_partially_uploaded_cycle_falls_back_to_previous(self):
        fs = FakeFS()
        publish_cycle(fs, datetime(2026, 9, 29, 13))
        publish_cycle(fs, datetime(2026, 9, 29, 14), hours=range(1, 10))
        self.assertEqual(
            forecast.latest_complete_cycle(datetime(2026, 9, 29, 16, 5), fs),
            datetime(2026, 9, 29, 13),
        )

    def test_cycle_on_previous_utc_day_is_found(self):
        fs = FakeFS()
        publish_cycle(fs, datetime(2026, 9, 28, 23))
        self.assertEqual(
            forecast.latest_complete_cycle(datetime(2026, 9, 29, 1, 30), fs),
            datetime(2026, 9, 28, 23),
        )

    def test_nothing_published_returns_none(self):
        self.assertIsNone(forecast.latest_complete_cycle(datetime(2026, 9, 29, 16), FakeFS()))

    def test_options_without_a_cycle_raise(self):
        with mock.patch.object(forecast, "cached_latest_cycle", lambda: None):
            with self.assertRaises(LookupError):
                forecast.forecast_options(now=datetime(2026, 9, 29, 16))


class ValidateRequestTests(unittest.TestCase):
    NOW = datetime(2026, 9, 29, 16, 20)

    def test_forecast_hour_is_derived_from_valid_time(self):
        cycle, valid, fhour = forecast.validate_forecast_request(
            "2026092914", "2026092917", now=self.NOW
        )
        self.assertEqual((cycle, valid, fhour), (CYCLE, datetime(2026, 9, 29, 17), 3))

    def test_stale_hour_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no longer in the future"):
            forecast.validate_forecast_request("2026092914", "2026092916", now=self.NOW)

    def test_valid_time_outside_the_cycle_is_rejected(self):
        for valid in ("2026092914", "2026093009"):  # f000 and f019
            with self.assertRaisesRegex(ValueError, "1-18 hours", msg=valid):
                forecast.validate_forecast_request("2026092914", valid, now=self.NOW)


class ReadStreamflowTests(unittest.TestCase):
    VALID = datetime(2026, 9, 29, 17)

    def test_values_align_with_requested_ids_and_fill_is_nan(self):
        blob = channel_blob(self.VALID, [101, 202, 303], [1.25, np.nan, 40.5])
        valid, values = forecast.read_streamflow(blob, [303, 202, 999, 101])
        self.assertEqual(valid, self.VALID)
        np.testing.assert_allclose(values, [40.5, np.nan, np.nan, 1.25])

    def test_fetch_drops_reaches_without_a_forecast(self):
        blob = channel_blob(self.VALID, [101, 202, 303], [1.25, np.nan, 40.5])
        fs = FakeFS({forecast.channel_key(CYCLE, 3): blob})
        frame = forecast.fetch_discharge(CYCLE, self.VALID, [101, 202, 303, 999], fs)
        self.assertEqual(list(frame.columns), ["feature_id", "discharge"])
        self.assertEqual(frame["feature_id"].tolist(), [101, 303])
        np.testing.assert_allclose(frame["discharge"], [1.25, 40.5])

    def test_file_valid_at_a_different_hour_is_refused(self):
        # A mislabelled object must not produce a map captioned with the wrong hour.
        blob = channel_blob(datetime(2026, 9, 29, 18), [101], [1.0])
        fs = FakeFS({forecast.channel_key(CYCLE, 3): blob})
        with self.assertRaisesRegex(RuntimeError, "expected 2026-09-29 17:00"):
            forecast.fetch_discharge(CYCLE, self.VALID, [101], fs)

    def test_missing_file_is_reported(self):
        with self.assertRaisesRegex(FileNotFoundError, "not published"):
            forecast.fetch_discharge(CYCLE, self.VALID, [101], FakeFS())

    def test_no_reach_with_a_forecast_is_an_error(self):
        blob = channel_blob(self.VALID, [101], [np.nan])
        fs = FakeFS({forecast.channel_key(CYCLE, 3): blob})
        with self.assertRaisesRegex(RuntimeError, "None of this HUC8's reaches"):
            forecast.fetch_discharge(CYCLE, self.VALID, [101], fs)


class NamingTests(unittest.TestCase):
    def test_result_name_carries_cycle_and_valid_time(self):
        self.assertEqual(
            forecast.result_basename("07070003", CYCLE, datetime(2026, 9, 29, 17)),
            "NWMSR_2026092914_2026092917_07070003",
        )

    def test_forecast_names_never_match_retrospective_lookups(self):
        import fnmatch
        import re

        tif = "NWMSR_2026092914_2026092917_07070003_inundation.tif"
        csv = "NWMSR_2026092914_2026092917_07070003.csv"
        # results.nwm_pattern (date-only form) and the Step 3 / labels CSV picker.
        self.assertFalse(fnmatch.fnmatch(tif, "NWM_20260929*_07070003_inundation.tif"))
        self.assertIsNone(re.match(r"^NWM_(\d+)_07070003\.csv$", csv))
        self.assertFalse(fnmatch.fnmatch(csv, "NWM_*_07070003.csv"))


if __name__ == "__main__":
    unittest.main()
