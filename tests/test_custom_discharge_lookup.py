"""Tests for the custom-discharge result lookup (issue #5).

A request for discharge X must never be answered with a raster computed
from discharge Y: the preview would draw it, and the download endpoint
would hand it over under a filename asserting X.

The lookup itself lives in ``results.py`` so it can be tested without
booting a Tethys portal; ``controllers.find_custom_map_key`` and the two
endpoints are one-line wrappers over the functions exercised here.

Needs Django (the tethys-fimserve env); skipped otherwise. Run with:
    ~/miniconda3/envs/tethys-fimserve/bin/python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import django
    from django.conf import settings

    if not settings.configured:
        _MEDIA = tempfile.mkdtemp(prefix="fimserve-test-media-")
        settings.configure(
            DEBUG=False,
            MEDIA_ROOT=_MEDIA,
            MEDIA_URL="/media/",
            DEFAULT_FILE_STORAGE="django.core.files.storage.FileSystemStorage",
            INSTALLED_APPS=[],
            DATABASES={},
            USE_TZ=True,
        )
        django.setup()
    from django.core.files.base import ContentFile
    from django.core.files.storage import default_storage

    from tethysapp.fimserve_viewer import results as results_mod

    DJANGO_OK = True
except Exception as exc:  # pragma: no cover - env without Django
    DJANGO_OK = False
    SKIP_REASON = f"Django unavailable: {exc}"

HUC8 = "12090301"


@unittest.skipUnless(DJANGO_OK, "requires Django" if DJANGO_OK else "")
class CustomResultNamingTests(unittest.TestCase):
    """Round-tripping a discharge through a result filename."""

    def test_token_and_value_are_recovered_from_a_name(self):
        name = f"CustomQ_500_0_{HUC8}_inundation.tif"
        self.assertEqual(results_mod.custom_token_from_name(name), "500_0")
        self.assertEqual(results_mod.discharge_from_name(name), 500.0)

    def test_negative_discharge_round_trips(self):
        token = results_mod.sanitize_discharge(-12.5)
        name = f"CustomQ_{token}_{HUC8}_inundation.tif"
        self.assertEqual(results_mod.discharge_from_name(name), -12.5)

    def test_nwm_names_are_not_mistaken_for_custom_ones(self):
        name = f"NWM_20230510143000_{HUC8}_inundation.tif"
        self.assertIsNone(results_mod.custom_token_from_name(name))
        self.assertIsNone(results_mod.discharge_from_name(name))


@unittest.skipUnless(DJANGO_OK, "requires Django" if DJANGO_OK else "")
class CustomMapLookupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        # Point storage at a fresh dir per test.
        default_storage.location = self._tmp.name
        self.results = results_mod.ResultStorage()

    def store(self, filename):
        key = self.results.key_for(HUC8, filename)
        default_storage.save(key, ContentFile(b""))
        return key

    def find(self, discharge_val):
        """Exactly what controllers.find_custom_map_key delegates to."""
        return self.results.find_custom(HUC8, discharge_val)

    def test_exact_discharge_is_found(self):
        key = self.store(f"CustomQ_40_0_{HUC8}_inundation.tif")
        self.assertEqual(self.find(40.0), key)

    def test_other_discharge_is_never_substituted(self):
        self.store(f"CustomQ_40_0_{HUC8}_inundation.tif")
        # 500 was never computed; the 40 raster must not answer for it.
        self.assertIsNone(self.find(500.0))

    def test_nwm_result_never_answers_a_custom_lookup(self):
        self.store(f"NWM_20230510143000_{HUC8}_inundation.tif")
        self.assertIsNone(self.find(500.0))

    def test_available_discharges_are_listed_for_the_404(self):
        self.store(f"CustomQ_40_0_{HUC8}_inundation.tif")
        self.store(f"CustomQ_100_{HUC8}_inundation.tif")
        self.store(f"NWM_20230510143000_{HUC8}_inundation.tif")
        self.assertEqual(self.results.custom_discharges(HUC8), [40.0, 100.0])

    def test_available_discharges_is_empty_for_an_unknown_huc(self):
        self.assertEqual(self.results.custom_discharges("00000000"), [])

    def test_download_name_comes_from_the_stored_raster(self):
        # The endpoint names the file from the key it actually found, so the
        # name can only ever assert the discharge on disk.
        key = self.store(f"CustomQ_40_0_{HUC8}_inundation.tif")
        self.assertEqual(
            results_mod.custom_download_name(HUC8, key), f"{HUC8}_customQ40_0.tif"
        )
        self.assertEqual(
            results_mod.custom_download_name(HUC8, key, "_reclassified"),
            f"{HUC8}_customQ40_0_reclassified.tif",
        )


if __name__ == "__main__":
    unittest.main()
