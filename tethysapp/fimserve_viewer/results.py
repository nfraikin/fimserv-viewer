"""Storage and naming of generated flood-map results.

Results are published to Django's default file storage, so they live on S3
when the portal configures it and on the local filesystem otherwise. Every
replica sees the same results either way.
"""

import fnmatch
import re
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Optional

from django.core.files import File
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.http import FileResponse


def sanitize_discharge(discharge_val: float) -> str:
    """Discharge value as the token used in result file names."""
    return str(discharge_val).replace(".", "_").replace("-", "m")


def nwm_pattern(huc8: str, date_str: str) -> str:
    """Filename pattern of an NWM result for a date or exact timestamp."""
    if len(date_str) == 10:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        return f"NWM_{date_obj.strftime('%Y%m%d')}*_{huc8}_inundation.tif"
    date_obj = datetime.strptime(date_str, "%Y-%m-%d-%H-%M-%S")
    return f"NWM_{date_obj.strftime('%Y%m%d%H%M%S')}_{huc8}_inundation.tif"


def custom_pattern(huc8: str, discharge_val: float) -> str:
    """Filename pattern of a custom-discharge result."""
    return f"CustomQ_{sanitize_discharge(discharge_val)}_{huc8}_inundation.tif"


_CUSTOM_TIF_RE = re.compile(r"^CustomQ_(?P<token>[0-9_m]+)_(?P<huc8>\d+)_inundation\.tif$")


def custom_token_from_name(filename: str) -> Optional[str]:
    """The sanitized discharge token in a CustomQ result filename, or None.

    Use this rather than re-sanitizing the *requested* discharge when naming a
    download: it reports the discharge the raster on disk was actually
    computed from.
    """
    match = _CUSTOM_TIF_RE.match(Path(filename).name)
    return match.group("token") if match else None


def discharge_from_name(filename: str) -> Optional[float]:
    """The discharge a CustomQ result was computed from, or None.

    Inverse of :func:`sanitize_discharge` - ``m`` back to ``-``, ``_`` back
    to ``.``.
    """
    token = custom_token_from_name(filename)
    if token is None:
        return None
    try:
        return float(token.replace("m", "-").replace("_", "."))
    except ValueError:
        return None


def custom_download_name(huc8: str, key: str, suffix: str = "") -> str:
    """Download filename for a stored custom result.

    Built from the token in the *stored* raster's name, so the filename can
    only ever assert the discharge the pixels were computed from.
    """
    token = custom_token_from_name(Path(key).name)
    if token is None:
        return f"{Path(key).stem}{suffix}.tif"
    return f"{huc8}_customQ{token}{suffix}.tif"


def labels_name_for_tif(tif_name: str) -> str:
    """Streamflow-labels filename co-named with a result tif."""
    return tif_name.replace("_inundation.tif", "_qlabels.geojson")


def nwm_labels_pattern(huc8: str, date_str: str) -> str:
    """Filename pattern of the stored streamflow-labels GeoJSON."""
    return labels_name_for_tif(nwm_pattern(huc8, date_str))


class ResultStorage:
    """Publishes and retrieves result tifs through default storage."""

    prefix = "fimserve_viewer/results"

    def key_for(self, huc8: str, filename: str) -> str:
        """Storage key of one result file."""
        return f"{self.prefix}/{huc8}/{filename}"

    def store(self, map_file: Path, huc8: str) -> str:
        """Publish a generated tif, remove the local copy, and return its key."""
        map_file = Path(map_file)
        key = self.key_for(huc8, map_file.name)
        if default_storage.exists(key):
            default_storage.delete(key)
        with map_file.open("rb") as handle:
            default_storage.save(key, File(handle))
        map_file.unlink()
        return key

    def store_text(self, text: str, huc8: str, filename: str) -> str:
        """Publish a text artifact (e.g. a labels GeoJSON) and return its key."""
        key = self.key_for(huc8, filename)
        if default_storage.exists(key):
            default_storage.delete(key)
        default_storage.save(key, ContentFile(text.encode("utf-8")))
        return key

    def text(self, key: str) -> Optional[str]:
        """Return a stored text artifact, or None if it is absent."""
        if not default_storage.exists(key):
            return None
        with default_storage.open(key, "rb") as handle:
            return handle.read().decode("utf-8")

    def names(self, huc8: str, pattern: str) -> list:
        """Sorted filenames of stored results matching a filename pattern."""
        directory = f"{self.prefix}/{huc8}"
        try:
            stored = default_storage.listdir(directory)[1]
        except (FileNotFoundError, NotADirectoryError, OSError):
            return []
        return sorted(name for name in stored if fnmatch.fnmatch(name, pattern))

    def find(self, huc8: str, pattern: str) -> Optional[str]:
        """Key of the newest stored result matching a filename pattern."""
        matches = self.names(huc8, pattern)
        if not matches:
            return None
        return f"{self.prefix}/{huc8}/{matches[-1]}"

    def find_custom(self, huc8: str, discharge_val: float) -> Optional[str]:
        """Key of the stored custom map for exactly this discharge, else None.

        There is deliberately no ``CustomQ_*`` fallback. Every custom result
        for the HUC8 lives under the same prefix, so a wildcard match returns
        a raster computed from some *other* discharge - which the preview
        would draw, and the download endpoint would hand over under a filename
        asserting the discharge the user asked for (see issue #5).
        """
        return self.find(huc8, custom_pattern(huc8, discharge_val))

    def custom_discharges(self, huc8: str) -> list:
        """Discharges that actually have a stored custom result for this HUC8.

        Drives the 404 message when a requested discharge has no result, so
        the user is told what is available instead of being handed a raster
        computed from some other discharge (see issue #5).
        """
        values = {
            discharge_from_name(name)
            for name in self.names(huc8, f"CustomQ_*_{huc8}_inundation.tif")
        }
        return sorted(v for v in values if v is not None)

    def response(self, key: str, download_name: str = "") -> FileResponse:
        """Stream one stored result tif."""
        handle = default_storage.open(key, "rb")
        if download_name:
            return FileResponse(
                handle, content_type="image/tiff", as_attachment=True, filename=download_name
            )
        return FileResponse(handle, content_type="image/tiff")

    @contextmanager
    def local(self, key: str):
        """Yield a temporary local copy of a stored result for raster work."""
        with default_storage.open(key, "rb") as source:
            with NamedTemporaryFile(suffix=".tif", delete=False) as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    target.write(chunk)
                path = Path(target.name)
        try:
            yield path
        finally:
            path.unlink(missing_ok=True)


results = ResultStorage()
