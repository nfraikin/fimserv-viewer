"""Tests for the COG rewrite and preview-name helpers.

Plain unittest, no Tethys portal or database required::

    python -m pytest tethysapp/fimserve_viewer/tests/test_cog_preview.py
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

try:
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    HAVE_RASTERIO = True
except ImportError:  # pragma: no cover - environment without the geo stack
    HAVE_RASTERIO = False

from tethysapp.fimserve_viewer.fim_logic import to_cog
from tethysapp.fimserve_viewer.results import preview_name_for_tif


class PreviewNamingTests(unittest.TestCase):
    def test_preview_is_co_named_with_its_tif(self):
        self.assertEqual(
            preview_name_for_tif("NWM_20230131000000_06040002_inundation.tif"),
            "NWM_20230131000000_06040002_preview.json",
        )

    def test_custom_discharge_results_are_handled_too(self):
        self.assertEqual(
            preview_name_for_tif("CustomQ_91_5_06040002_inundation.tif"),
            "CustomQ_91_5_06040002_preview.json",
        )

    def test_unrelated_names_are_left_alone(self):
        self.assertEqual(preview_name_for_tif("notes.txt"), "notes.txt")


@unittest.skipUnless(HAVE_RASTERIO, "rasterio/numpy not installed")
class ToCogTests(unittest.TestCase):
    def _write_plain_tif(self, path, size=1024):
        """A plain untiled GeoTIFF with two categorical values, as HAND-FIM emits."""
        data = np.zeros((size, size), dtype="int16")
        data[: size // 2, : size // 2] = 1
        profile = {
            "driver": "GTiff",
            "height": size,
            "width": size,
            "count": 1,
            "dtype": "int16",
            "crs": "EPSG:5070",
            "transform": from_origin(0, 0, 10, 10),
            "nodata": -9999,
        }
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data, 1)
        return data

    def test_rewrite_produces_a_tiled_raster_with_overviews(self):
        with TemporaryDirectory() as tmp:
            tif = Path(tmp) / "x_inundation.tif"
            self._write_plain_tif(tif)
            with rasterio.open(tif) as src:
                self.assertEqual(src.overviews(1), [], "fixture should start without overviews")

            to_cog(tif)

            with rasterio.open(tif) as src:
                self.assertEqual(src.block_shapes[0], (256, 256))
                self.assertTrue(src.overviews(1), "a COG must carry an overview pyramid")

    def test_rewrite_preserves_crs_values_and_nodata(self):
        with TemporaryDirectory() as tmp:
            tif = Path(tmp) / "x_inundation.tif"
            expected = self._write_plain_tif(tif)

            to_cog(tif)

            with rasterio.open(tif) as src:
                self.assertEqual(src.crs.to_epsg(), 5070)
                self.assertEqual(src.nodata, -9999)
                np.testing.assert_array_equal(src.read(1), expected)

    def test_overviews_keep_categorical_values(self):
        """Nearest resampling: overviews must not average flooded and dry."""
        with TemporaryDirectory() as tmp:
            tif = Path(tmp) / "x_inundation.tif"
            self._write_plain_tif(tif)

            to_cog(tif)

            with rasterio.open(tif) as src:
                overview = src.read(1, out_shape=(1, src.height // 4, src.width // 4))
            self.assertTrue(
                set(np.unique(overview)).issubset({0, 1, -9999}),
                "overview introduced values outside the source classes",
            )

    def test_rewrite_is_in_place_and_leaves_no_staging_file(self):
        with TemporaryDirectory() as tmp:
            tif = Path(tmp) / "x_inundation.tif"
            self._write_plain_tif(tif)

            returned = to_cog(tif)

            self.assertEqual(returned, tif)
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["x_inundation.tif"])

    def test_original_survives_a_failed_rewrite(self):
        with TemporaryDirectory() as tmp:
            tif = Path(tmp) / "not-a-raster_inundation.tif"
            tif.write_bytes(b"definitely not a GeoTIFF")

            with self.assertRaises(Exception):
                to_cog(tif)

            self.assertEqual(tif.read_bytes(), b"definitely not a GeoTIFF")
            self.assertEqual([p.name for p in Path(tmp).iterdir()], [tif.name])


if __name__ == "__main__":
    unittest.main()
