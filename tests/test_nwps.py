"""Tests for reach names from NOAA NWPS (the clicked-reach popup).

No network: requests.get is replaced.

Run with:  python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import nwps  # noqa: E402


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._body


class ReachNameTests(unittest.TestCase):
    def setUp(self):
        nwps._fetch_reach_name.cache_clear()
        self.addCleanup(nwps._fetch_reach_name.cache_clear)
        self.urls = []

    def lookup(self, *responses):
        responses = list(responses)

        def fake_get(url, timeout):
            self.urls.append(url)
            return responses.pop(0)

        with mock.patch("requests.get", fake_get):
            return nwps.reach_name(10376192)

    def test_name_comes_from_nwps(self):
        self.assertEqual(self.lookup(FakeResponse(200, {"name": " Provo River "})), "Provo River")
        self.assertEqual(self.urls, ["https://api.water.noaa.gov/nwps/v1/reaches/10376192"])

    def test_unnamed_reach_is_empty_not_unknown(self):
        self.assertEqual(self.lookup(FakeResponse(200, {"name": None})), "")

    def test_failure_is_unknown_and_retried_next_time(self):
        # NWPS answers 503 "Data unavailable" for unknown IDs and outages alike.
        self.assertIsNone(self.lookup(FakeResponse(503, {"code": 14})))
        self.assertEqual(self.lookup(FakeResponse(200, {"name": "Provo River"})), "Provo River")

    def test_a_found_name_is_not_fetched_twice(self):
        self.lookup(FakeResponse(200, {"name": "Provo River"}))
        self.assertEqual(self.lookup(), "Provo River")
        self.assertEqual(len(self.urls), 1)


if __name__ == "__main__":
    unittest.main()
