"""Regression tests for the teehr datetime64 pandera-parser backport.

teehr <= 0.6.x's ``format_datetime64`` calls ``s.dt.tz_localize(None)`` directly,
which raises ``Can only use .dt accessor with datetimelike values`` on the
all-null ``reference_time`` column the fetching code seeds (a float column),
breaking every NWM retrospective fetch and so every flood-map generation.
``fim_logic._patched_format_datetime64`` backports teehr 0.7.0's coercion. These
tests need only pandas, so they run standalone and under ``tethys manage test``.
"""

import unittest

import numpy as np
import pandas as pd

from tethysapp.fimserve_viewer.fim_logic import _patched_format_datetime64


class TeehrDatetimeParserTest(unittest.TestCase):
    def test_all_null_reference_time_column_is_coerced_not_raised(self):
        s = pd.Series([np.nan, np.nan, np.nan])
        with self.assertRaises(AttributeError):
            s.dt.tz_localize(None)  # the unpatched teehr behaviour
        out = _patched_format_datetime64(s)
        self.assertEqual(str(out.dtype), "datetime64[ms]")
        self.assertTrue(out.isna().all())

    def test_naive_datetime_passes_through(self):
        s = pd.to_datetime(pd.Series(["2023-01-20 00:00:00", "2023-01-20 01:00:00"]))
        out = _patched_format_datetime64(s)
        self.assertEqual(str(out.dtype), "datetime64[ms]")
        self.assertEqual(list(out.astype("datetime64[ns]")), list(s))

    def test_tz_aware_datetime_is_stripped_to_utc_wall_time(self):
        s = pd.to_datetime(pd.Series(["2023-01-20T06:30:00+00:00"]), utc=True)
        out = _patched_format_datetime64(s)
        self.assertEqual(str(out.dtype), "datetime64[ms]")
        self.assertIsNone(out.dt.tz)
        self.assertEqual(out.iloc[0], pd.Timestamp("2023-01-20 06:30:00"))


if __name__ == "__main__":
    unittest.main()
