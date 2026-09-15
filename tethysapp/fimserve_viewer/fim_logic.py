"""
fim_logic.py - Pure helper functions for the FIMserve Viewer Tethys app.

This module is the direct counterpart of helper code that used to live in the
Flask `server.py`. Every function here is web-framework-agnostic; the
`controllers.py` module wraps these with `@controller`s and Django responses.

Notable differences from the Flask original:
  * `FIMSERV_ROOT` defaults to a disk-backed temp dir
    (`/var/tmp/fimserve_viewer` where available, else the platform temp
    dir) and can be overridden with the FIMSERV_ROOT env var. The sibling
    `FIMserv/` checkout the Flask app relied on no longer exists once
    FIMserv is installed as a normal pip package.
  * `_get_huc8_boundary_for_mask` reads its fallback geojson from the app
    package's `resources/` directory instead of `<server.py>/data/`.
  * `_parse_generate_flood_json_body` takes a parsed JSON dict instead of
    reading Flask's `request` directly.
  * `_empty_feature_collection` returns a plain dict; the controller wraps it.
  * The `_fimserve_working_directory` context manager and every `os.chdir`
    call tied to the sibling FIMserv checkout are gone. Upstream FIMserv
    resolves its tree from `os.getcwd()`, so `_load_fimserve` replaces
    `fimserve.datadownload.setup_directories` with a version pinned to
    `FIMSERV_ROOT` - no cwd manipulation is needed.
  * Hydrofabric disk usage is capped: `enforce_cache_budget` (implemented
    in `manage_cache.py`) evicts the least-recently-used HUC's heavy
    hydrofabric (~700-900 MB each) before a new download when the total
    exceeds `FIMSERVE_CACHE_MAX_GB` (default 3).
"""

import base64
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

# ---------------------------------------------------------------------------
# FIMserv imports.
#
# IMPORTANT: We import FIMserv lazily so this module is safe to import even
# when the `fimserve` package is not yet installed. Tethys imports the app's
# controllers (and therefore this module) during `tethys install -d` *before*
# the install.yml `post:` hook gets a chance to install FIMserv. If we
# imported FIMserv eagerly here, the very first install would fail with
# `ModuleNotFoundError: No module named 'fimserve'` and the app would never
# register.
#
# Each public name (DownloadHUC8, getNWMretrospectivedata, runOWPHANDFIM,
# runfim) is exposed as a thin wrapper that performs the real import on
# first call. If FIMserv is genuinely missing at call-time, the wrapper
# raises a clear RuntimeError pointing the operator at post_install.py.
# ---------------------------------------------------------------------------
def _patched_setup_directories():
    """Replacement for ``fimserve.datadownload.setup_directories``.

    Upstream resolves the working tree from ``os.getcwd()``, i.e. wherever
    the operator happened to start the portal. Pin it to ``FIMSERV_ROOT``
    instead so downloads, outputs, and cache eviction all operate on the
    same tree.
    """
    parent_dir = _ensure_fimserv_root_env()
    code_dir = os.path.join(parent_dir, "code", "inundation-mapping")
    data_dir = os.path.join(parent_dir, "data", "inputs")
    output_dir = os.path.join(parent_dir, "output")
    for d in (code_dir, data_dir, output_dir):
        os.makedirs(d, exist_ok=True)
    return code_dir, data_dir, output_dir


def _patched_format_datetime64(s):
    """Replacement for ``teehr.models.pandera_dataframe_schemas.format_datetime64``.

    This is the fix for the "Can only use .dt accessor with datetimelike
    values" error that made every NWM flood-map job fail in Step 2.

    What goes wrong upstream (teehr 0.5.0, which FIMserv pins):
      * ``teehr.fetching.nwm.retrospective_points.da_to_df`` fills the
        ``reference_time`` column with ``np.nan``, so that column is a plain
        float column, not a datetime column.
      * Before writing the parquet file, teehr validates the DataFrame with a
        pandera schema whose ``reference_time`` column has this function as a
        "parser". The original function runs ``s.dt.tz_localize(None)``
        straight away.
      * Newer pandera releases run a column's parsers *before* converting the
        column to its declared dtype. So the parser receives the float column,
        and ``.dt`` (which only exists for datetime columns) raises.

    The fix, matching what teehr itself later did upstream: if the Series is
    not already a datetime Series, convert it with ``pd.to_datetime`` first.
    An all-NaN column simply becomes all-NaT (datetime "missing").
    """
    import pandas as pd

    if not pd.api.types.is_datetime64_any_dtype(s):
        s = pd.to_datetime(s, utc=True)
    s = s.dt.tz_localize(None)
    return s.astype("datetime64[ms]")


def _patch_teehr():
    """Install ``_patched_format_datetime64`` into teehr (safe to call repeatedly).

    teehr's schema functions look ``format_datetime64`` up by name each time a
    schema is built, so rebinding the module attribute is enough. This must run
    before any teehr fetch: FIMserv's Step 2 and the hydrograph endpoint both
    fetch through teehr.
    """
    import teehr.models.pandera_dataframe_schemas as _schemas  # type: ignore

    _schemas.format_datetime64 = _patched_format_datetime64


def _load_fimserve():
    """Import FIMserv submodules on demand.

    Returns a dict mapping public name -> callable. Raises RuntimeError with
    actionable installation instructions if the package is unavailable.
    Also pins FIMserv's directory resolution to FIMSERV_ROOT (see
    `_patched_setup_directories`).
    """
    # fimserve/__init__.py runs setup_directories() at import time (via
    # fimevaluation/fims_setup.py), which creates code/, data/, output/ in
    # the *current working directory*. Under a web server the cwd can be
    # somewhere read-only (e.g. site-packages), so chdir into FIMSERV_ROOT
    # for the duration of the import to make those directories land where
    # every other part of this app expects them.
    root = _ensure_fimserv_root_env()
    prev_cwd = os.getcwd()
    try:
        os.chdir(root)
        import fimserve.datadownload as _datadownload  # type: ignore
        import fimserve.runFIM as _runFIM  # type: ignore
        from fimserve.datadownload import DownloadHUC8  # type: ignore
        from fimserve.streamflowdata.nwmretrospective import (  # type: ignore
            getNWMretrospectivedata,
        )
        from fimserve.runFIM import runOWPHANDFIM, runfim  # type: ignore

        # Fix the `.dt` accessor crash inside teehr's parquet validation.
        # See _patched_format_datetime64 for the full explanation.
        _patch_teehr()
    except Exception as exc:  # pragma: no cover - missing-dep path
        raise RuntimeError(
            "FIMserv is not available. Install the app's dependencies "
            "(declared in pyproject.toml, including FIMserv at a pinned git "
            "ref) with:\n"
            "    python -m pip install -e .   # from the repository root"
        ) from exc
    finally:
        try:
            os.chdir(prev_cwd)
        except OSError:
            pass

    # Sixteen fimserve modules bind `setup_directories` by name at import
    # time (`from ..datadownload import setup_directories`), so patching
    # the source module alone is not enough: sweep every loaded fimserve
    # module and replace the binding wherever it exists.
    import sys as _sys

    for _name, _mod in list(_sys.modules.items()):
        if (
            _name.startswith("fimserve")
            and _mod is not None
            and getattr(_mod, "setup_directories", None) is not None
        ):
            _mod.setup_directories = _patched_setup_directories

    return {
        "DownloadHUC8": DownloadHUC8,
        "getNWMretrospectivedata": getNWMretrospectivedata,
        "runOWPHANDFIM": runOWPHANDFIM,
        "runfim": runfim,
        "setup_directories": _patched_setup_directories,
    }


def _fimserve_proxy(name):
    """Return a callable proxy that imports FIMserv on first invocation.

    The proxy ALSO ensures the FIMSERV_ROOT environment variable is exported
    before the underlying FIMserv function runs. FIMserv's
    `setup_directories()` reads this env var to decide where to put `code/`,
    `data/`, and `output/`. If we don't set it, FIMserv falls back to
    `os.getcwd()` (whatever directory the operator started Tethys from),
    which means FIMserv writes the .tif somewhere that
    `_fimserv_inundation_dir()` then can't find.
    """

    def _proxy(*args, **kwargs):
        _ensure_fimserv_root_env()
        return _load_fimserve()[name](*args, **kwargs)

    _proxy.__name__ = name
    _proxy.__qualname__ = name
    return _proxy


DownloadHUC8 = _fimserve_proxy("DownloadHUC8")
getNWMretrospectivedata = _fimserve_proxy("getNWMretrospectivedata")
runOWPHANDFIM = _fimserve_proxy("runOWPHANDFIM")
runfim = _fimserve_proxy("runfim")


# ---------------------------------------------------------------------------
# FIMSERV_ROOT - where FIMserv downloads, computes, and writes outputs.
#
# Operators can point this anywhere by exporting FIMSERV_ROOT before
# starting the portal (e.g. shared storage or a bigger disk). When unset,
# the app picks a disposable disk-backed temp location on its own:
# /var/tmp/fimserve_viewer where available (unlike /tmp, /var/tmp is never
# RAM-backed tmpfs), otherwise the platform temp dir (Windows). Everything
# in it is a re-downloadable cache bounded by FIMSERVE_CACHE_MAX_GB, so
# nothing of value is lost if the OS ages it out.
# ---------------------------------------------------------------------------
def _default_fimserv_root() -> Path:
    var_tmp = Path("/var/tmp")
    base = var_tmp if var_tmp.is_dir() else Path(tempfile.gettempdir())
    return base / "fimserve_viewer"


def _ensure_fimserv_root_env() -> str:
    """Make sure ``FIMSERV_ROOT`` is exported in the process environment.

    Resolution order:
      1. FIMSERV_ROOT from the environment (operator override).
      2. A disk-backed temp default (see `_default_fimserv_root`).

    The chosen path is created, exported into ``os.environ["FIMSERV_ROOT"]``,
    and logged so operators can see exactly where FIMserv will write.
    """
    existing = os.environ.get("FIMSERV_ROOT")
    if existing:
        resolved = str(Path(existing).expanduser().resolve())
        print(f"[fimserve_viewer] FIMSERV_ROOT (from env): {resolved}", flush=True)
    else:
        resolved = str(_default_fimserv_root().resolve())
        print(f"[fimserve_viewer] FIMSERV_ROOT (temp default): {resolved}", flush=True)

    Path(resolved).mkdir(parents=True, exist_ok=True)
    os.environ["FIMSERV_ROOT"] = resolved
    return resolved


# ---------------------------------------------------------------------------
# Path helpers - identical to the Flask original.
# ---------------------------------------------------------------------------
def _fimserv_root() -> Path:
    """Resolve the FIMserv root directory (where output/ and data/ live)."""
    return Path(_ensure_fimserv_root_env()).expanduser().resolve()


def _fimserv_output_root() -> Path:
    o = os.environ.get("FIMSERV_OUTPUT_DIR")
    if o:
        return Path(o).expanduser().resolve()
    return (_fimserv_root() / "output").resolve()


def _fimserv_data_inputs_dir() -> Path:
    d = os.environ.get("FIMSERV_DATA_INPUTS_DIR")
    if d:
        return Path(d).expanduser().resolve()
    return (_fimserv_root() / "data" / "inputs").resolve()


def _fimserv_inundation_dir(huc8: str) -> Path:
    return _fimserv_output_root() / f"flood_{huc8}" / f"{huc8}_inundation"


def _candidate_fimserv_roots() -> list[Path]:
    """Return all roots where FIMserv might have written its tree.

    FIMserv's `setup_directories()` is supposed to honour the FIMSERV_ROOT env
    var, but in some configurations (when fimserve is invoked in-process from a
    web request) it falls back to ``os.getcwd()`` instead. To make the viewer
    robust to that, we search several plausible roots:

      1. The configured FIMSERV_ROOT (disk-backed temp dir by default).
      2. The portal's current working directory.
      3. The outer repo directory (``tethysapp-fimserve_viewer/``), because
         ``tethys start`` is typically launched from there.
    """
    roots: list[Path] = [_fimserv_root()]
    cwd = Path(os.getcwd()).resolve()
    if cwd not in roots:
        roots.append(cwd)
    repo_outer = Path(__file__).resolve().parents[2]
    if repo_outer not in roots:
        roots.append(repo_outer)
    return roots


def _candidate_inundation_dirs(huc8: str) -> list[Path]:
    """Per-HUC ``output/flood_<huc>/<huc>_inundation/`` dirs across all roots."""
    return [
        r / "output" / f"flood_{huc8}" / f"{huc8}_inundation"
        for r in _candidate_fimserv_roots()
    ]


def _candidate_data_inputs_dirs() -> list[Path]:
    """``data/inputs/`` dirs across all candidate FIMserv roots.

    Honours the legacy ``FIMSERV_DATA_INPUTS`` override if set.
    """
    override = os.environ.get("FIMSERV_DATA_INPUTS")
    if override:
        return [Path(override).expanduser().resolve()]
    return [r / "data" / "inputs" for r in _candidate_fimserv_roots()]


def _find_inundation_file(huc8: str, pattern: str) -> Optional[Path]:
    """Find the newest .tif matching ``pattern`` across all candidate dirs.

    Returns None if nothing matches anywhere.
    """
    all_matches: list[Path] = []
    for d in _candidate_inundation_dirs(huc8):
        if d.exists():
            all_matches.extend(d.glob(pattern))
    if not all_matches:
        return None
    all_matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return all_matches[0]


def _candidate_huc_dirs(huc8: str) -> list[Path]:
    """Return candidate FIMserv ``output/flood_<huc>/<huc>/`` dirs.

    These hold per-HUC artifacts like ``wbd.gpkg`` and
    ``nwm_subset_streams.gpkg``.
    """
    return [
        r / "output" / f"flood_{huc8}" / huc8
        for r in _candidate_fimserv_roots()
    ]


def _find_huc_file(huc8: str, relative: str) -> Optional[Path]:
    """Find a per-HUC file (e.g. ``wbd.gpkg``) across candidate roots."""
    for d in _candidate_huc_dirs(huc8):
        p = d / relative
        if p.exists():
            return p
    return None


# ---------------------------------------------------------------------------
# Static HUC8 boundary file (bundled inside the app package).
# ---------------------------------------------------------------------------
_APP_PACKAGE_DIR = Path(__file__).resolve().parent
_HUC8_GEOJSON_PATH = _APP_PACKAGE_DIR / "resources" / "all_huc8.geojson"
_HUC8_GDF_CACHE = None


# ---------------------------------------------------------------------------
# NWM CSV / streams helpers - copied verbatim from server.py.
# ---------------------------------------------------------------------------
def _pick_nwm_discharge_csv(
    data_dir: Path, huc8: str, day_key: str, full_key: str | None
) -> Path | None:
    """Match NWM_*_{huc8}.csv naming from fimserve nwmretrospective."""
    if not data_dir.is_dir():
        return None
    rx = re.compile(rf"^NWM_(\d+)_{re.escape(huc8)}\.csv$")
    matches: list[tuple[str, Path]] = []
    for p in data_dir.iterdir():
        if not p.is_file():
            continue
        m = rx.match(p.name)
        if m:
            matches.append((m.group(1), p))
    if not matches:
        return None
    if full_key:
        for slug, p in matches:
            if slug == full_key:
                return p
        candidates = [(s, p) for s, p in matches if s.startswith(day_key)]
        if not candidates:
            return None
        candidates.sort(
            key=lambda sp: (abs(len(sp[0]) - len(full_key)), -sp[1].stat().st_mtime)
        )
        return candidates[0][1]
    for slug, p in matches:
        if slug == day_key:
            return p
    candidates = [(s, p) for s, p in matches if s.startswith(day_key)]
    if not candidates:
        return None
    candidates.sort(key=lambda sp: (len(sp[0]), -sp[1].stat().st_mtime))
    return candidates[0][1]


def _nwm_streams_fid_column(gdf) -> str | None:
    for c in ("feature_id", "Feature_ID", "FEATURE_ID", "ID", "id"):
        if c in gdf.columns:
            return c
    return None


def _line_midpoint_for_label(geom):
    """Shapely geometry -> Point for map label (mid-reach)."""
    if geom is None or geom.is_empty:
        return None
    gt = geom.geom_type
    if gt == "LineString":
        return geom.interpolate(0.5, normalized=True)
    if gt == "MultiLineString":
        longest = max(geom.geoms, key=lambda g: g.length)
        return longest.interpolate(0.5, normalized=True)
    return geom.representative_point()


# ---------------------------------------------------------------------------
# Request-body parser - takes a dict instead of reading Flask's request.
# ---------------------------------------------------------------------------
NWM_RETROSPECTIVE_START = datetime(1979, 2, 1)
NWM_RETROSPECTIVE_END = datetime(2023, 2, 1)


def validate_nwm_datetime(parsed: datetime) -> None:
    """Raise ValueError when the datetime is outside NWM v3.0 retrospective coverage."""
    if not (NWM_RETROSPECTIVE_START <= parsed < NWM_RETROSPECTIVE_END):
        raise ValueError(
            "Date must be between 1979-02-01 and 2023-01-31 "
            "(NWM v3.0 retrospective coverage)."
        )


def _parse_generate_flood_json_body(data: dict) -> Tuple[str, str]:
    """Given a POST JSON body dict, return (huc8, 'YYYY-MM-DD HH:MM:SS')."""
    huc8 = data.get("huc8")
    date_str = data.get("date")
    time_str = data.get("time", "00:00:00")
    if not huc8 or not date_str:
        raise ValueError("Missing required parameters: huc8 and date")
    if time_str and len(str(time_str)) == 5 and str(time_str).count(":") == 1:
        time_str = str(time_str) + ":00"
    if not time_str or str(time_str).strip() == "":
        time_str = "00:00:00"
    datetime_str = f"{date_str} {time_str}"
    try:
        parsed = datetime.strptime(datetime_str, "%Y-%m-%d %H:%M:%S")
    except ValueError as e:
        raise ValueError(f"Invalid date or time: {e}") from e
    validate_nwm_datetime(parsed)
    return str(huc8), datetime_str


# ---------------------------------------------------------------------------
# Hydrofabric cache management lives in manage_cache.py; re-exported here so
# callers (and tests) can keep using fim_logic.enforce_cache_budget.
# ---------------------------------------------------------------------------
from .manage_cache import (  # noqa: E402  (needs _candidate_fimserv_roots above)
    enforce_cache_budget,
    prune_huc_hydrofabric,
)


# ---------------------------------------------------------------------------
# Three flood-generation steps. No cwd manipulation: `_load_fimserve` pins
# FIMserv's setup_directories to FIMSERV_ROOT.
# ---------------------------------------------------------------------------
def _run_flood_step1_download_huc8(huc8: str) -> None:
    enforce_cache_budget(protect_huc=huc8)
    try:
        DownloadHUC8(huc8, version="4.8")
    except Exception as e:
        print(f"Warning: HUC8 download issue (may already exist): {e}")


def _run_flood_step2_nwm_streamflow(huc8: str, datetime_str: str) -> None:
    getNWMretrospectivedata(huc_event_dict={huc8: [datetime_str]})


def _run_flood_step3_hand_inundation(huc8: str, datetime_str: Optional[str] = None) -> None:
    """Run HAND inundation for one event.

    When `datetime_str` is given, run only the discharge CSV matching that
    event. Upstream `runOWPHANDFIM` globs *every* NWM_*_{huc}.csv ever
    downloaded and re-runs inundation for each, so without this each request
    silently regenerates all past events for the HUC too.
    """
    if datetime_str:
        date_obj = datetime.strptime(datetime_str, "%Y-%m-%d %H:%M:%S")
        day_key = date_obj.strftime("%Y%m%d")
        full_key = date_obj.strftime("%Y%m%d%H%M%S")
        for data_dir in _candidate_data_inputs_dirs():
            csv_path = _pick_nwm_discharge_csv(data_dir, huc8, day_key, full_key)
            if csv_path is not None:
                fns = _load_fimserve()
                code_dir, _data_dir, output_dir = fns["setup_directories"]()
                fns["runfim"](code_dir, output_dir, huc8, str(csv_path))
                return
        print(
            f"[fimserve_viewer] No discharge CSV matched {datetime_str} for "
            f"HUC {huc8}; falling back to runOWPHANDFIM",
            flush=True,
        )
    runOWPHANDFIM(huc8)


def _locate_generated_inundation_tif(
    huc8: str, datetime_str: str
) -> Tuple[Optional[Path], str]:
    """Return (path, '') on success, or (None, diagnostic_message).

    Searches every candidate dir for an exact-timestamp match first, then
    falls back to any ``*_inundation.tif`` in those dirs.
    """
    date_obj = datetime.strptime(datetime_str, "%Y-%m-%d %H:%M:%S")
    date_formatted = date_obj.strftime("%Y%m%d%H%M%S")
    date_formatted_alt = date_obj.strftime("%Y%m%d%H%M00")

    for pattern in (
        f"NWM_{date_formatted}_{huc8}_inundation.tif",
        f"NWM_{date_formatted_alt}_{huc8}_inundation.tif",
        "*_inundation.tif",
    ):
        match = _find_inundation_file(huc8, pattern)
        if match is not None:
            print(f"[fimserve_viewer] Found inundation tif at {match}", flush=True)
            return match, ""

    searched = [str(d) for d in _candidate_inundation_dirs(huc8)]
    data_inputs = _fimserv_data_inputs_dir()
    csvs = list(data_inputs.glob(f"*{huc8}*.csv")) if data_inputs.exists() else []
    msg = (
        f"Flood map generated but file not found. Searched: {searched}. "
        f"Discharge CSVs for {huc8}: {[c.name for c in csvs] or 'none'}. "
        "Check the terminal where the portal runs for inundation errors."
    )
    return None, msg


# ---------------------------------------------------------------------------
# Reclassification helpers - copied verbatim from server.py.
# ---------------------------------------------------------------------------
def _reclassify_by_table(tif_path, out_path, reclass_table, output_nodata=-9999.0):
    """
    Reclassify raster by table (matches QGIS "Reclassify by table" tool).
    - Range boundaries: min < value <= max (QGIS default)
    - Output NoData: -9999 for values that match no range
    - Output data type: Float32
    """
    import numpy as np
    import rasterio

    with rasterio.open(tif_path) as src:
        data = src.read(1)
        input_nodata = src.nodata if src.nodata is not None else -9999

        out_data = np.full(data.shape, output_nodata, dtype=np.float32)

        nodata_mask = (data == input_nodata) | np.isnan(data)
        out_data[nodata_mask] = output_nodata

        for min_val, max_val, new_val in reclass_table:
            mask = (data > min_val) & (data <= max_val) & ~nodata_mask
            out_data[mask] = new_val

        profile = src.profile.copy()
        profile.update(dtype=rasterio.float32, nodata=output_nodata)

        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(out_data.astype(np.float32), 1)


# Default reclass table: FIM inundation rasters use HydroID encoding:
#   positive HydroID = flooded, negative HydroID = not flooded, nodata = outside domain
DEFAULT_RECLASS_TABLE = [
    (-999999999, 0, 0),       # No flood (zero or negative) -> 0
    (0, 2147483647, 1),       # Any positive (flooded) -> 1
]


# ---------------------------------------------------------------------------
# HUC8 boundary lookup - fallback path now points at the bundled
# resources/all_huc8.geojson instead of <server.py>/data/all_huc8.geojson.
# ---------------------------------------------------------------------------
def _get_huc8_boundary_for_mask(huc8_code):
    """
    Get HUC8 boundary for masking flood overlay. Tries (in order):
    1. FIM wbd.gpkg            - exact boundary used by inundation model
    2. FIM nwm_catchments dissolved - catchment domain (when wbd missing)
    3. Bundled all_huc8.geojson - WBD boundary
    Returns gdf in raster CRS, or None.
    """
    import geopandas as gpd

    code = str(huc8_code)

    wbd_path = _find_huc_file(code, "wbd.gpkg")
    if wbd_path is not None:
        try:
            return gpd.read_file(wbd_path)
        except Exception:
            pass

    catch_path = _find_huc_file(code, "nwm_catchments_proj_subset.gpkg")
    if catch_path is not None:
        try:
            catch = gpd.read_file(catch_path)
            return catch.dissolve()
        except Exception:
            pass

    global _HUC8_GDF_CACHE
    if not _HUC8_GEOJSON_PATH.exists():
        return None
    if _HUC8_GDF_CACHE is None:
        _HUC8_GDF_CACHE = gpd.read_file(_HUC8_GEOJSON_PATH)
    col = "huc8" if "huc8" in _HUC8_GDF_CACHE.columns else "HUC8"
    match = _HUC8_GDF_CACHE[_HUC8_GDF_CACHE[col].astype(str) == code]
    if match.empty:
        return None
    return gpd.GeoDataFrame([1], geometry=[match.iloc[0].geometry], crs="EPSG:4326")


def _huc8_reference_bounds_wgs84(huc8_code: str):
    """HUC8 bounding box in WGS84 (west, south, east, north), or None."""
    gdf = _get_huc8_boundary_for_mask(huc8_code)
    if gdf is None or gdf.empty:
        return None
    try:
        g = gdf.to_crs("EPSG:4326")
        w, s, e, n = g.total_bounds
        return (float(w), float(s), float(e), float(n))
    except Exception:
        return None


def _iou_wgs84_boxes(a, b):
    """Intersection-over-union for two (west, south, east, north) boxes."""
    a_w, a_s, a_e, a_n = a
    b_w, b_s, b_e, b_n = b
    ix_w = max(a_w, b_w)
    ix_e = min(a_e, b_e)
    ix_s = max(a_s, b_s)
    ix_n = min(a_n, b_n)
    if ix_w >= ix_e or ix_s >= ix_n:
        return 0.0
    inter = (ix_e - ix_w) * (ix_n - ix_s)
    area_a = max(0.0, a_e - a_w) * max(0.0, a_n - a_s)
    area_b = max(0.0, b_e - b_w) * max(0.0, b_n - b_s)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _tight_wgs84_bounds_from_flood_mask_mercator(mask_bool, transform_3857):
    """WGS84 envelope of flooded pixels; raster grid is EPSG:3857."""
    import numpy as np
    from pyproj import Transformer

    ys, xs = np.where(mask_bool)
    if len(xs) == 0:
        return None
    c0, c1 = int(xs.min()), int(xs.max())
    r0, r1 = int(ys.min()), int(ys.max())
    corners = [
        (c0, r0),
        (c1 + 1, r0),
        (c1 + 1, r1 + 1),
        (c0, r1 + 1),
    ]
    mxv, myv = [], []
    for c, r in corners:
        mx, my = transform_3857 * (c, r)
        mxv.append(float(mx))
        myv.append(float(my))
    tr = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    return tr.transform_bounds(
        min(mxv), min(myv), max(mxv), max(myv), densify_pts=21
    )


def _huc8_mask_for_raster_crs(huc8_code, src_crs, transform, shape):
    """Pixel mask True inside HUC8 boundary, in native raster grid."""
    from rasterio.features import geometry_mask

    gdf = _get_huc8_boundary_for_mask(huc8_code)
    if gdf is None:
        return None
    try:
        if gdf.crs != src_crs:
            gdf = gdf.to_crs(src_crs)
        shapes = []
        for geom in gdf.geometry:
            if geom is None or geom.is_empty:
                continue
            if geom.geom_type == "MultiPolygon":
                shapes.extend(geom.geoms)
            else:
                shapes.append(geom)
        if not shapes:
            return None
        return ~geometry_mask(shapes, out_shape=shape, transform=transform, invert=False)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Main preview generator - copied verbatim from server.py.
# ---------------------------------------------------------------------------
def _tif_to_preview_png(tif_path, huc8=None):
    """
    Convert flood TIF to PNG for Leaflet over OSM (Web Mercator).

    The PNG is warped to EPSG:3857 with a rasterio affine (a..f). The client
    uses that affine so each pixel column/row maps through Mercator like map
    tiles. Plain L.imageOverlay(latLng bounds) linearly stretches in screen
    space and misaligns rivers vs the basemap at mid-latitudes.

    Returns dict with png_b64, bounds (WGS84 [[south,west],[north,east]]),
    mercator (a,b,c,d,e,f,w,h).
    """
    import io

    import numpy as np
    import rasterio
    from PIL import Image
    from pyproj import Transformer
    from rasterio.crs import CRS
    from rasterio.transform import array_bounds
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    os.environ.setdefault("CHECK_WITH_INVERT_PROJ", "YES")

    dst_crs_merc = CRS.from_epsg(3857)
    merc_to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    max_side = 5120

    def _warp_once(src_crs_try, flooded_bool):
        base_tf, base_w, base_h = calculate_default_transform(
            src_crs_try, dst_crs_merc, src.width, src.height, *src.bounds
        )
        if max(base_w, base_h) > max_side:
            dst_w = max(1, int(round(base_w * max_side / max(base_w, base_h))))
            dst_h = max(1, int(round(base_h * max_side / max(base_w, base_h))))
            dst_transform, dst_width, dst_height = calculate_default_transform(
                src_crs_try,
                dst_crs_merc,
                src.width,
                src.height,
                *src.bounds,
                dst_width=dst_w,
                dst_height=dst_h,
            )
        else:
            dst_transform, dst_width, dst_height = base_tf, base_w, base_h

        dst_flood = np.zeros((dst_height, dst_width), dtype=np.uint8)
        reproject(
            source=flooded_bool.astype(np.uint8),
            destination=dst_flood,
            src_transform=src.transform,
            src_crs=src_crs_try,
            dst_transform=dst_transform,
            dst_crs=dst_crs_merc,
            resampling=Resampling.nearest,
        )
        rgba = np.zeros((dst_height, dst_width, 4), dtype=np.uint8)
        on = dst_flood > 0
        rgba[on, :] = [30, 136, 229, 255]
        rgba[~on, 3] = 0
        wb, sb, eb, nb = array_bounds(dst_height, dst_width, dst_transform)
        west, south, east, north = merc_to_ll.transform_bounds(
            wb, sb, eb, nb, densify_pts=21
        )
        tight = _tight_wgs84_bounds_from_flood_mask_mercator(on, dst_transform)
        return (
            rgba,
            dst_transform,
            dst_width,
            dst_height,
            west,
            south,
            east,
            north,
            int(on.sum()),
            tight,
        )

    with rasterio.open(str(tif_path)) as src:
        data = src.read(1)
        input_nodata = src.nodata if src.nodata is not None else -9999
        output_nodata = -9999.0

        reclass = np.full(data.shape, output_nodata, dtype=np.float32)
        nodata_mask = (data == input_nodata) | np.isnan(data)
        reclass[nodata_mask] = output_nodata
        for min_val, max_val, new_val in DEFAULT_RECLASS_TABLE:
            m = (data > min_val) & (data <= max_val) & ~nodata_mask
            reclass[m] = new_val

        flooded_base = reclass == 1
        ref_ll = _huc8_reference_bounds_wgs84(huc8) if huc8 else None

        seen_epsg = set()
        crs_attempts = []

        def _add_crs(c):
            if c is None or not c.is_valid:
                return
            key = c.to_string()
            if key in seen_epsg:
                return
            seen_epsg.add(key)
            crs_attempts.append(c)

        if src.crs is not None and src.crs.is_valid:
            crs_attempts = [src.crs]
        else:
            for code in (6350, 5070, 32617, 32618, 26917, 26918):
                try:
                    _add_crs(CRS.from_epsg(code))
                except Exception:
                    pass
            if not crs_attempts:
                _add_crs(CRS.from_epsg(5070))
            print(
                f"Note: raster CRS missing/invalid; trying {len(crs_attempts)} "
                f"CRS for preview: {tif_path}"
            )

        attempts = []
        for cand in crs_attempts:
            huc8_mask = None
            if huc8:
                huc8_mask = _huc8_mask_for_raster_crs(
                    huc8, cand, src.transform, data.shape
                )
            flooded = flooded_base.copy()
            if huc8_mask is not None:
                flooded = flooded & huc8_mask
            try:
                rgba, dst_tf, dw, dh, w, s, e, n, npx, tight = _warp_once(cand, flooded)
            except Exception as ex:
                print(f"  Preview warp skip CRS {cand}: {ex}")
                continue

            if ref_ll is not None and len(crs_attempts) > 1:
                iou_full = _iou_wgs84_boxes(ref_ll, (w, s, e, n))
                iou_tight = (
                    _iou_wgs84_boxes(ref_ll, tight) if tight is not None else 0.0
                )
                key = (iou_tight, iou_full, npx)
            else:
                iou_full = 1.0
                iou_tight = 1.0
                key = (1.0, 1.0, npx)

            attempts.append(
                (key, iou_tight, iou_full, rgba, dst_tf, dw, dh, w, s, e, n, npx, cand)
            )

        if not attempts:
            raise RuntimeError(
                "Could not warp flood preview to Web Mercator. "
                "Check GeoTIFF georeferencing."
            )

        if ref_ll is not None and len(crs_attempts) > 1:
            decent = [a for a in attempts if a[1] >= 0.02 or a[2] >= 0.05]
            pool = decent if decent else attempts
        else:
            pool = attempts

        (
            _key,
            iou_tight,
            iou_full,
            rgba,
            dst_tf,
            dw,
            dh,
            west,
            south,
            east,
            north,
            npx,
            used,
        ) = max(pool, key=lambda a: a[0])
        if len(crs_attempts) > 1:
            print(
                f"  Flood preview using CRS {used} "
                f"(flood∩HUC IoU≈{iou_tight:.3f}, "
                f"full∩HUC IoU≈{iou_full:.3f}, flood_px={npx})"
            )

        img = Image.fromarray(rgba)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        leaflet_bounds = [[south, west], [north, east]]
        mercator = {
            "a": float(dst_tf.a),
            "b": float(dst_tf.b),
            "c": float(dst_tf.c),
            "d": float(dst_tf.d),
            "e": float(dst_tf.e),
            "f": float(dst_tf.f),
            "w": int(dw),
            "h": int(dh),
        }

    return {
        "png_b64": png_b64,
        "bounds": leaflet_bounds,
        "mercator": mercator,
    }


# ---------------------------------------------------------------------------
# GeoJSON helpers.
# ---------------------------------------------------------------------------
def _empty_feature_collection() -> dict:
    """Empty GeoJSON FeatureCollection. The controller wraps this in HttpResponse."""
    return {"type": "FeatureCollection", "features": []}


def build_flood_q_labels(huc8: str, date_str: str) -> Optional[str]:
    """
    Compute the Q-label GeoJSON for a HUC8 + date_str.

    Returns a JSON string (already serialized) or None if data isn't ready
    (in which case the controller emits an empty FeatureCollection).

    Args:
        huc8: HUC8 code as a string.
        date_str: Either 'YYYY-MM-DD' or 'YYYY-MM-DD-HH-MM-SS'.
    """
    import geopandas as gpd
    import pandas as pd

    if len(date_str) == 10:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        full_key = None
    else:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d-%H-%M-%S")
        full_key = date_obj.strftime("%Y%m%d%H%M%S")
    day_key = date_obj.strftime("%Y%m%d")

    csv_path: Optional[Path] = None
    for data_dir in _candidate_data_inputs_dirs():
        csv_path = _pick_nwm_discharge_csv(data_dir, huc8, day_key, full_key)
        if csv_path is not None:
            break
    if csv_path is None:
        return None

    q_df = pd.read_csv(csv_path)
    if "discharge" not in q_df.columns and "value" in q_df.columns:
        q_df = q_df.rename(columns={"value": "discharge"})
    if "feature_id" not in q_df.columns or "discharge" not in q_df.columns:
        return None

    q_df = q_df.copy()
    q_df["feature_id"] = pd.to_numeric(q_df["feature_id"], errors="coerce")
    q_df = q_df.dropna(subset=["feature_id", "discharge"])
    q_df["feature_id"] = q_df["feature_id"].astype(int)

    streams_path = _find_huc_file(huc8, "nwm_subset_streams.gpkg")
    if streams_path is None:
        return None

    streams = gpd.read_file(streams_path)
    fid_col = _nwm_streams_fid_column(streams)
    if fid_col is None:
        return None

    streams = streams.copy()
    streams[fid_col] = pd.to_numeric(streams[fid_col], errors="coerce")
    streams = streams.dropna(subset=[fid_col])
    streams[fid_col] = streams[fid_col].astype(int)

    merged = streams.merge(
        q_df[["feature_id", "discharge"]],
        left_on=fid_col,
        right_on="feature_id",
        how="inner",
    )
    if merged.empty:
        return None

    import math

    rows = []
    for _, row in merged.iterrows():
        pt = _line_midpoint_for_label(row.geometry)
        if pt is None:
            continue
        try:
            qv = float(row["discharge"])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(qv):  # NaN or +/-Infinity
            continue
        rows.append(
            {
                "feature_id": int(row["feature_id"]),
                "discharge_m3s": qv,
                "geometry": pt,
            }
        )

    if not rows:
        return None

    out = gpd.GeoDataFrame(rows, crs=merged.crs)
    out_wgs = out.to_crs(4326)

    # Reprojection or degenerate input geometries can produce points with
    # +/-Infinity or NaN coordinates. The Python `json` module happily emits
    # those as the literal token `Infinity`, but standard JSON forbids them
    # (browsers' JSON.parse will throw). Filter such rows out before
    # serialising.
    def _coords_finite(pt) -> bool:
        try:
            return math.isfinite(pt.x) and math.isfinite(pt.y)
        except Exception:
            return False

    out_wgs = out_wgs[out_wgs.geometry.apply(_coords_finite)]
    if out_wgs.empty:
        return None

    return out_wgs.to_json()


# ---------------------------------------------------------------------------
# Custom-discharge generation (used by /api/generate-flood-map-custom).
# ---------------------------------------------------------------------------
def run_custom_discharge_flood_map(huc8: str, discharge_val: float) -> Path:
    """
    Apply a single user-supplied discharge value to every reach in a HUC8 and
    run FIMserv to produce a custom-Q inundation TIF.

    Returns the output Path. Raises FileNotFoundError / RuntimeError on failure.
    """
    import pandas as pd

    _ensure_fimserv_root_env()

    # Raises RuntimeError with install instructions if FIMserv is missing,
    # and pins setup_directories to FIMSERV_ROOT.
    fns = _load_fimserve()
    code_dir, data_dir, output_dir = fns["setup_directories"]()

    huc_dir = Path(output_dir) / f"flood_{huc8}"
    feature_ids_path = huc_dir / "feature_IDs.csv"

    # branches/ is deleted by cache eviction while feature_IDs.csv is kept,
    # so check both before deciding the HUC data is ready to run.
    hydrofabric_ready = (huc_dir / huc8 / "branches").is_dir()

    if not feature_ids_path.exists() or not hydrofabric_ready:
        enforce_cache_budget(protect_huc=huc8)
        DownloadHUC8(huc8, version="4.8")
        if not feature_ids_path.exists():
            raise FileNotFoundError(
                f"feature_IDs.csv not found after download. HUC8 {huc8} may not be supported."
            )

    fid_df = pd.read_csv(feature_ids_path)
    feature_ids = fid_df["feature_id"].astype(int).tolist()

    discharge_sanitized = str(discharge_val).replace(".", "_").replace("-", "m")
    csv_name = f"CustomQ_{discharge_sanitized}_{huc8}.csv"
    csv_path = Path(data_dir) / csv_name

    discharge_df = pd.DataFrame({"feature_id": feature_ids, "discharge": discharge_val})
    discharge_df.to_csv(csv_path, index=False)
    print(f"Created custom discharge CSV: {csv_path}")

    runfim(code_dir, output_dir, huc8, str(csv_path))

    output_subdir = Path(output_dir) / f"flood_{huc8}" / f"{huc8}_inundation"
    expected_basename = f"CustomQ_{discharge_sanitized}_{huc8}_inundation.tif"
    map_file = output_subdir / expected_basename

    if not map_file.exists():
        matches = list(output_subdir.glob(f"CustomQ_*_{huc8}_inundation.tif"))
        map_file = matches[0] if matches else None  # type: ignore[assignment]

    if not map_file or not map_file.exists():
        raise FileNotFoundError(
            f"Flood map not found at {output_subdir}. "
            "Check the portal terminal for inundation errors."
        )

    return map_file


# ---------------------------------------------------------------------------
# Hydrograph helper (used by /api/get-hydrograph).
# ---------------------------------------------------------------------------
def build_hydrograph_payload(huc8: str, date_str: str) -> dict:
    """
    Build {status, times, values, huc8, datetime} for the hydrograph plot.

    Raises ValueError on bad date, FileNotFoundError when feature IDs are
    missing, RuntimeError when teehr fails.
    """
    import pandas as pd

    if len(date_str) == 10:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        time_str = "00:00:00"
    else:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d-%H-%M-%S")
        time_str = date_obj.strftime("%H:%M:%S")
        date_str = date_obj.strftime("%Y-%m-%d")

    datetime_str = f"{date_str} {time_str}"
    time_obj = pd.to_datetime(datetime_str)

    lag_date = (time_obj - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    lead_date = (time_obj + pd.Timedelta(days=1)).strftime("%Y-%m-%d")

    feature_ids = None
    csv_pattern = f"NWM_*_{huc8}.csv"
    HUC_dir: Optional[Path] = None
    for data_dir in _candidate_data_inputs_dirs():
        if not data_dir.exists():
            continue
        for f in data_dir.glob(csv_pattern):
            df = pd.read_csv(f)
            if "feature_id" in df.columns:
                feature_ids = df["feature_id"].astype(int).tolist()
                HUC_dir = data_dir.parent.parent / "output" / f"flood_{huc8}"
                break
        if feature_ids:
            break

    if not feature_ids:
        for root in _candidate_fimserv_roots():
            cand = root / "output" / f"flood_{huc8}" / "feature_IDs.csv"
            if cand.exists():
                fid_df = pd.read_csv(cand)
                feature_ids = fid_df["feature_id"].astype(int).tolist()
                HUC_dir = cand.parent
                break

    if not feature_ids or HUC_dir is None:
        raise FileNotFoundError(
            "No feature IDs found. Generate a flood map first for this HUC8 and date."
        )

    import teehr.fetching.nwm.retrospective_points as nwm_retro

    _patch_teehr()  # same `.dt` accessor fix as flood-map Step 2

    retro_dir = HUC_dir / "discharge" / "nwm30_retrospective"
    retro_dir.mkdir(parents=True, exist_ok=True)

    nwm_retro.nwm_retro_to_parquet(
        nwm_version="nwm30",
        variable_name="streamflow",
        start_date=lag_date,
        end_date=lead_date,
        location_ids=feature_ids,
        output_parquet_dir=str(retro_dir),
    )

    parquet_file = (
        retro_dir / f"{lag_date.replace('-', '')}_{lead_date.replace('-', '')}.parquet"
    )
    if not parquet_file.exists():
        raise RuntimeError("Could not fetch NWM retrospective data.")

    df = pd.read_parquet(parquet_file)
    df["value_time"] = pd.to_datetime(df["value_time"])
    location_ids_str = [f"nwm30-{int(fid)}" for fid in feature_ids]
    df_huc = df[df["location_id"].isin(location_ids_str)]

    if df_huc.empty:
        raise FileNotFoundError("No streamflow data for this HUC8.")

    hydro = df_huc.groupby("value_time")["value"].mean().reset_index()
    hydro = hydro.sort_values("value_time")

    times = [t.isoformat() for t in hydro["value_time"]]
    values = hydro["value"].tolist()

    return {
        "status": "success",
        "times": times,
        "values": values,
        "huc8": huc8,
        "datetime": datetime_str,
    }


# ---------------------------------------------------------------------------
# Reclassify helper for download endpoints.
# ---------------------------------------------------------------------------
def reclassify_temp_copy(map_file: Path) -> Path:
    """
    Apply the default reclass table to `map_file`, write the result to a
    temporary file, and return its Path. Caller is responsible for deleting.
    """
    fd, tmp_path = tempfile.mkstemp(suffix=".tif")
    os.close(fd)
    try:
        _reclassify_by_table(str(map_file), tmp_path, DEFAULT_RECLASS_TABLE)
    except Exception:
        # Clean up if reclassification fails
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return Path(tmp_path)


__all__ = [
    "DownloadHUC8",
    "getNWMretrospectivedata",
    "runOWPHANDFIM",
    "runfim",
    "_fimserv_output_root",
    "_fimserv_data_inputs_dir",
    "_fimserv_inundation_dir",
    "_pick_nwm_discharge_csv",
    "_nwm_streams_fid_column",
    "_line_midpoint_for_label",
    "_parse_generate_flood_json_body",
    "enforce_cache_budget",
    "prune_huc_hydrofabric",
    "_run_flood_step1_download_huc8",
    "_run_flood_step2_nwm_streamflow",
    "_run_flood_step3_hand_inundation",
    "_locate_generated_inundation_tif",
    "_reclassify_by_table",
    "DEFAULT_RECLASS_TABLE",
    "_get_huc8_boundary_for_mask",
    "_tif_to_preview_png",
    "_empty_feature_collection",
    "build_flood_q_labels",
    "run_custom_discharge_flood_map",
    "build_hydrograph_payload",
    "reclassify_temp_copy",
]
