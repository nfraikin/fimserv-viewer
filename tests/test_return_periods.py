"""Tests for fetching NWM return periods from the CIROH NWM API.

No network: ``requests.get`` is patched with a canned response shaped like
the API's JSON (a list of one record per reach, flows in m³/s).

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import local_keys, return_periods  # noqa: E402

RECORD = {
    "feature_id": 13463951,
    "return_period_2": 30.5,
    "return_period_5": 48.0,
    "return_period_10": 60.25,
    "return_period_25": 77.0,
    "return_period_50": 90.0,
    "return_period_100": 103.5,
}


class ParseResponseTests(unittest.TestCase):
    def test_sorted_by_years_in_m3s(self):
        out = return_periods.parse_response([dict(reversed(list(RECORD.items())))], "13463951")
        self.assertEqual([rp["years"] for rp in out], [2, 5, 10, 25, 50, 100])
        self.assertEqual(out[0]["value"], 30.5)

    def test_picks_the_requested_reach(self):
        other = dict(RECORD, feature_id=1, return_period_2=999.0)
        out = return_periods.parse_response([other, RECORD], 13463951)
        self.assertEqual(out[0]["value"], 30.5)

    def test_skips_missing_and_unrecognised_fields(self):
        rec = {"feature_id": 7, "return_period_2": None, "return_period_5": 4.0, "notes": "x"}
        self.assertEqual(return_periods.parse_response([rec], "7"), [{"years": 5, "value": 4.0}])

    def test_unknown_reach_raises(self):
        with self.assertRaises(LookupError):
            return_periods.parse_response([], "7")
        with self.assertRaises(LookupError):
            return_periods.parse_response([{"feature_id": 7}], "7")


class ApiKeyTests(unittest.TestCase):
    def setUp(self):
        # A keys file of the test's own, so the real one is never read.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.keys = Path(tmp.name) / "keys.env"
        patcher = mock.patch.dict(
            "os.environ", {local_keys.KEYS_FILE_ENV: str(self.keys)}, clear=True
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_setting_wins_over_environment(self):
        with mock.patch.dict("os.environ", {"CIROH_API_KEY": "env"}):
            self.assertEqual(return_periods.api_key("setting"), "setting")
            self.assertEqual(return_periods.api_key(None), "env")

    def test_keys_file_is_used_when_nothing_else_is_set(self):
        self.keys.write_text("CIROH_API_KEY=from-file\n", encoding="utf-8")
        self.assertEqual(return_periods.api_key(None), "from-file")

    def test_missing_key_is_not_configured(self):
        with self.assertRaisesRegex(return_periods.NotConfigured, "keys.env"):
            return_periods.api_key("  ")


class GetReturnPeriodsTests(unittest.TestCase):
    def setUp(self):
        return_periods._cache.clear()

    def test_sends_key_as_header_and_caches(self):
        resp = mock.Mock()
        resp.json.return_value = [RECORD]
        with mock.patch.object(return_periods.requests, "get", return_value=resp) as get:
            first = return_periods.get_return_periods(13463951, "k")
            second = return_periods.get_return_periods("13463951", "k")
        self.assertEqual(first, second)
        get.assert_called_once()
        self.assertEqual(get.call_args.kwargs["headers"], {"x-api-key": "k"})
        self.assertEqual(get.call_args.kwargs["params"]["comids"], "13463951")

    def test_http_error_is_not_cached(self):
        resp = mock.Mock()
        resp.raise_for_status.side_effect = return_periods.requests.HTTPError("403")
        with mock.patch.object(return_periods.requests, "get", return_value=resp):
            with self.assertRaises(return_periods.requests.HTTPError):
                return_periods.get_return_periods(1, "bad")
        self.assertNotIn("1", return_periods._cache)


if __name__ == "__main__":
    unittest.main()
