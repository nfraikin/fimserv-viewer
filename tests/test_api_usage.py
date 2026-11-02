"""Tests for the monthly limit on the APIs whose keys BYU provides.

The counter runs against an in-memory SQLite database, the same way
``test_job_sweep`` exercises the job store.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import api_usage, local_keys  # noqa: E402
from tethysapp.fimserve_viewer.api_usage import CIROH, MAPBOX, UsageLimitReached  # noqa: E402


class LimitTests(unittest.TestCase):
    def setUp(self):
        # A keys file of the test's own, so the real one is never read.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.keys = Path(tmp.name) / "keys.env"
        patcher = mock.patch.dict("os.environ", {local_keys.KEYS_FILE_ENV: str(self.keys)}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_is_500(self):
        self.assertEqual(api_usage.monthly_limit(), 500)

    def test_keys_file_changes_it(self):
        self.keys.write_text("BYU_API_MONTHLY_LIMIT=250\n", encoding="utf-8")
        self.assertEqual(api_usage.monthly_limit(), 250)

    def test_nonsense_falls_back_to_default(self):
        for bad in ("lots", "-1", "2.5"):
            with self.subTest(bad=bad), mock.patch.dict("os.environ", {api_usage.LIMIT_ENV: bad}):
                self.assertEqual(api_usage.monthly_limit(), 500)


class MonthTests(unittest.TestCase):
    def test_month_is_utc(self):
        late_utc = datetime(2026, 11, 30, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(api_usage.current_month(late_utc), "2026-11")

    def test_resets_on_the_first_of_next_month(self):
        self.assertEqual(api_usage.next_reset("2026-11"), date(2026, 12, 1))
        self.assertEqual(api_usage.next_reset("2026-12"), date(2027, 1, 1))

    def test_message_names_byu_the_limit_and_the_reset(self):
        for api in (MAPBOX, CIROH):
            with self.subTest(api=api):
                message = api_usage.limit_message(api, 500, "2026-12")
                self.assertIn("BYU Hydroinformatics", message)
                self.assertIn("500", message)
                self.assertIn("January 1", message)


class UsageCounterTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        # No create_all: the counter makes its own table, as on a database
        # created before the table existed.
        self.counter = api_usage.UsageCounter(sessionmaker(bind=engine))
        patcher = mock.patch.dict("os.environ", {api_usage.LIMIT_ENV: "3"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reserves_up_to_the_limit_then_refuses(self):
        self.assertEqual([self.counter.reserve(CIROH) for _ in range(3)], [1, 2, 3])
        with self.assertRaises(UsageLimitReached) as caught:
            self.counter.reserve(CIROH)
        self.assertEqual(caught.exception.api, CIROH)
        self.assertEqual(self.counter.used(CIROH), 3)

    def test_reservation_is_all_or_nothing(self):
        self.counter.reserve(CIROH, 2)
        with self.assertRaises(UsageLimitReached):
            self.counter.reserve(CIROH, 2)
        self.assertEqual(self.counter.used(CIROH), 2)
        self.counter.reserve(CIROH, 1)

    def test_each_api_has_its_own_count(self):
        self.counter.reserve(CIROH, 3)
        self.counter.reserve(MAPBOX)
        self.assertEqual(self.counter.summary()["used"], {MAPBOX: 1, CIROH: 3})

    def test_a_new_month_starts_over(self):
        self.counter.reserve(CIROH, 3)
        with mock.patch.object(api_usage, "current_month", return_value="2099-01"):
            self.assertEqual(self.counter.reserve(CIROH), 1)

    def test_check_refuses_only_once_used_up(self):
        self.counter.record(MAPBOX, 2)
        self.counter.check(MAPBOX)
        self.counter.record(MAPBOX)
        with self.assertRaisesRegex(UsageLimitReached, "Mapbox"):
            self.counter.check(MAPBOX)

    def test_record_counts_past_the_limit(self):
        # Map loads are reported after they happen, so every one is counted.
        self.assertEqual(self.counter.record(MAPBOX, 5), 5)


if __name__ == "__main__":
    unittest.main()
