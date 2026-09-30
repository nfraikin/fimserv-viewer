"""NWM short-range forecast discharge for flood mapping (issue #31).

The retrospective path asks FIMserv/teehr for a historical discharge. This
module is the forecast counterpart: it reads the operational NWM short-range
forecast straight from NOAA's public bucket, writes the same
``feature_id,discharge`` CSV that Step 3 consumes, and hands it to the same
``runfim`` call. Steps 1 and 3 are unchanged; only the data source differs.

Layout, verified against the live bucket (no credentials needed):

    s3://noaa-nwm-pds/nwm.{YYYYMMDD}/short_range/
        nwm.t{HH}z.short_range.channel_rt.f{001..018}.conus.nc

Hourly cycles, 18 forecast hours each, ``streamflow`` in m3 s-1 on a
``feature_id`` dimension. A cycle lands roughly 1h45m-2h after its reference
hour, so ``f001`` of the newest cycle is usually already in the past. That is
why every choice here is made by *valid time* and the forecast hour is always
derived from it (``valid - cycle``), never assumed.

All times in this module are naive datetimes in UTC, matching the NWM files.
"""

import logging
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from . import fim_logic

log = logging.getLogger(__name__)

NWM_BUCKET = "noaa-nwm-pds"
SHORT_RANGE_HOURS = 18
# Publication lag is ~2 h. Looking back further lets the app keep working
# (on an older, still partly-future cycle) through a NOAA delivery hiccup.
CYCLE_LOOKBACK_HOURS = 8
# The bucket listing is shared by every HUC and user; one listing a minute
# is plenty given cycles arrive hourly. Staleness is applied per request on
# top of this, so a cached listing can never leak an hour that has passed.
LISTING_TTL_SECONDS = 60

_TOKEN_RE = re.compile(r"^\d{10}$")
_CHANNEL_RE = re.compile(r"nwm\.t(\d{2})z\.short_range\.channel_rt\.f(\d{3})\.conus\.nc$")

# HDF5 (under netCDF4) is not thread-safe, and a job's worker thread can be
# reading a forecast file while a request thread builds a hydrograph.
_NETCDF_LOCK = threading.Lock()


def utcnow() -> datetime:
    """Current time as a naive UTC datetime, the convention used by NWM."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Tokens: cycle and valid hours travel through URLs and filenames as
# YYYYmmddHH. Parsing is strict because tokens end up in storage patterns.
# ---------------------------------------------------------------------------
def to_token(moment: datetime) -> str:
    return moment.strftime("%Y%m%d%H")


def parse_token(token: str) -> datetime:
    """``YYYYmmddHH`` -> datetime. Raises ValueError for anything else."""
    token = str(token)
    if not _TOKEN_RE.match(token):
        raise ValueError(f"Expected an hour token like 2026092914, got {token!r}")
    return datetime.strptime(token, "%Y%m%d%H")


def forecast_hour(cycle: datetime, valid: datetime) -> int:
    """Forecast hour that makes ``cycle`` valid at ``valid``."""
    return int((valid - cycle).total_seconds() // 3600)


def is_stale(valid: datetime, now: Optional[datetime] = None) -> bool:
    """A forecast hour is stale once its valid time is no longer in the future."""
    return valid <= (now or utcnow())


def channel_key(cycle: datetime, fhour: int) -> str:
    """Bucket key of one short-range channel file."""
    return (
        f"{NWM_BUCKET}/nwm.{cycle:%Y%m%d}/short_range/"
        f"nwm.t{cycle:%H}z.short_range.channel_rt.f{fhour:03d}.conus.nc"
    )


def _filesystem():
    import s3fs

    return s3fs.S3FileSystem(anon=True)


# ---------------------------------------------------------------------------
# Finding the newest cycle.
# ---------------------------------------------------------------------------
def published_hours(fs, day: datetime) -> dict:
    """{cycle_hour: set(forecast_hours)} for the channel files present on a day."""
    try:
        names = fs.ls(f"{NWM_BUCKET}/nwm.{day:%Y%m%d}/short_range/", detail=False)
    except FileNotFoundError:
        return {}
    found: dict = {}
    for name in names:
        match = _CHANNEL_RE.search(name)
        if match:
            found.setdefault(int(match.group(1)), set()).add(int(match.group(2)))
    return found


def latest_complete_cycle(now: Optional[datetime] = None, fs=None) -> Optional[datetime]:
    """Newest cycle with all 18 channel files published, else None.

    Files within one cycle land a minute or two apart, so the newest cycle
    can be half-uploaded. Requiring the complete set means a partial cycle
    is simply skipped in favour of the previous one, and every hour offered
    to the user is guaranteed to exist.
    """
    now = now or utcnow()
    fs = fs or _filesystem()
    newest = now.replace(minute=0, second=0, microsecond=0)
    listings: dict = {}
    for back in range(CYCLE_LOOKBACK_HOURS + 1):
        cycle = newest - timedelta(hours=back)
        day = cycle.replace(hour=0)
        if day not in listings:
            listings[day] = published_hours(fs, day)
        if len(listings[day].get(cycle.hour, ())) >= SHORT_RANGE_HOURS:
            return cycle
    return None


_listing_cache = {"at": 0.0, "cycle": None}
_listing_lock = threading.Lock()


def cached_latest_cycle() -> Optional[datetime]:
    """``latest_complete_cycle`` behind a short process-wide cache."""
    with _listing_lock:
        if time.monotonic() - _listing_cache["at"] < LISTING_TTL_SECONDS:
            return _listing_cache["cycle"]
    cycle = latest_complete_cycle()
    with _listing_lock:
        _listing_cache.update(at=time.monotonic(), cycle=cycle)
    return cycle


def upcoming_hours(cycle: datetime, now: Optional[datetime] = None) -> list:
    """The cycle's forecast hours whose valid time is still ahead, in order."""
    now = now or utcnow()
    hours = []
    for fhour in range(1, SHORT_RANGE_HOURS + 1):
        valid = cycle + timedelta(hours=fhour)
        if not is_stale(valid, now):
            hours.append({
                "forecast_hour": fhour,
                "valid_time": valid.isoformat(),
                "valid_token": to_token(valid),
            })
    return hours


def forecast_options(now: Optional[datetime] = None, cycle: Optional[datetime] = None) -> dict:
    """What the forecast page offers: the newest cycle and its unstale hours."""
    now = now or utcnow()
    cycle = cycle or cached_latest_cycle()
    if cycle is None:
        raise LookupError(
            f"No complete NWM short-range cycle found in the last "
            f"{CYCLE_LOOKBACK_HOURS} hours on s3://{NWM_BUCKET}."
        )
    return {
        "cycle_time": cycle.isoformat(),
        "cycle_token": to_token(cycle),
        "now": now.replace(microsecond=0).isoformat(),
        "hours": upcoming_hours(cycle, now),
    }


def validate_forecast_request(cycle_token: str, valid_token: str,
                              now: Optional[datetime] = None) -> tuple:
    """Check a submitted cycle/valid pair; return ``(cycle, valid, fhour)``.

    Raises ValueError with a user-facing message. The page only offers
    unstale hours, but the page can sit open past the top of the hour, so
    the server re-checks rather than trusting what it was sent.
    """
    cycle = parse_token(cycle_token)
    valid = parse_token(valid_token)
    fhour = forecast_hour(cycle, valid)
    if not 1 <= fhour <= SHORT_RANGE_HOURS:
        raise ValueError(
            f"Valid time must be 1-{SHORT_RANGE_HOURS} hours after the cycle "
            f"(got f{fhour:03d})."
        )
    if is_stale(valid, now):
        raise ValueError(
            f"The forecast for {valid:%Y-%m-%d %H:%M} UTC is no longer in the "
            "future. Refresh the forecast hours and pick another."
        )
    return cycle, valid, fhour


def is_published(cycle: datetime, fhour: int, fs=None) -> bool:
    """Whether one forecast hour's channel file exists in the bucket."""
    return (fs or _filesystem()).exists(channel_key(cycle, fhour))


# ---------------------------------------------------------------------------
# Reading discharge.
# ---------------------------------------------------------------------------
def read_streamflow(blob: bytes, feature_ids) -> tuple:
    """Return ``(valid_time, values)`` for ``feature_ids`` from one channel file.

    ``values`` aligns with ``feature_ids``; reaches the file does not carry,
    or carries as the fill value, come back as NaN.
    """
    import netCDF4
    import numpy as np
    import pandas as pd

    with _NETCDF_LOCK:
        with netCDF4.Dataset("inmemory.nc", mode="r", memory=blob) as nc:
            index = pd.Index(np.asarray(nc.variables["feature_id"][:]))
            positions = index.get_indexer(np.asarray(feature_ids, dtype="int64"))
            flow = np.ma.filled(nc.variables["streamflow"][:].astype("float64"), np.nan)
            time_var = nc.variables["time"]
            valid = netCDF4.num2date(
                time_var[:], time_var.units, only_use_cftime_datetimes=False
            )[0]
    values = np.where(positions >= 0, flow[positions], np.nan)
    return datetime(valid.year, valid.month, valid.day, valid.hour), values


def fetch_discharge(cycle: datetime, valid: datetime, feature_ids, fs=None):
    """``feature_id,discharge`` DataFrame for one forecast hour.

    Reaches with no forecast value are dropped rather than zero-filled, the
    same outcome as a reach missing from a retrospective CSV: Step 3 simply
    maps no inundation for them.
    """
    import pandas as pd

    fs = fs or _filesystem()
    fhour = forecast_hour(cycle, valid)
    key = channel_key(cycle, fhour)
    try:
        blob = fs.cat(key)
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"NWM short-range file s3://{key} is not published."
        ) from exc
    file_valid, values = read_streamflow(blob, feature_ids)
    if file_valid != valid:
        raise RuntimeError(
            f"s3://{key} is valid at {file_valid:%Y-%m-%d %H:%M} UTC, "
            f"expected {valid:%Y-%m-%d %H:%M} UTC."
        )
    frame = pd.DataFrame({"feature_id": feature_ids, "discharge": values})
    missing = int(frame["discharge"].isna().sum())
    if missing:
        log.info("%d of %d reaches have no forecast in %s", missing, len(frame), key)
    frame = frame.dropna(subset=["discharge"])
    if frame.empty:
        raise RuntimeError(f"None of this HUC8's reaches have a forecast in s3://{key}.")
    return frame


def fetch_series(cycle: datetime, feature_id: int, fs=None) -> tuple:
    """One reach's discharge for every hour of a cycle: ``(times, values)``.

    An hour with no value for the reach comes back as None. Downloads run in
    parallel (network-bound); parsing is serialized by the netCDF lock. About
    12 MB per hour, ~13 s for the whole cycle.
    """
    import numpy as np

    fs = fs or _filesystem()
    keys = [channel_key(cycle, f) for f in range(1, SHORT_RANGE_HOURS + 1)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        blobs = list(pool.map(fs.cat, keys))
    times, values = [], []
    for blob in blobs:
        valid, flows = read_streamflow(blob, [feature_id])
        times.append(valid.isoformat())
        values.append(float(flows[0]) if np.isfinite(flows[0]) else None)
    return times, values


# ---------------------------------------------------------------------------
# Feature IDs and hydrograph.
# ---------------------------------------------------------------------------
def feature_ids_for_huc(huc8: str) -> list:
    """Unique reach IDs from Step 1's ``feature_IDs.csv``; FileNotFoundError if absent."""
    import pandas as pd

    for flood_dir in fim_logic._candidate_flood_dirs(huc8):
        path = flood_dir / "feature_IDs.csv"
        if path.is_file():
            ids = pd.read_csv(path)["feature_id"].astype("int64")
            return ids.drop_duplicates().tolist()
    raise FileNotFoundError(
        "No feature IDs found. Generate a forecast flood map for this HUC8 first."
    )


_HYDROGRAPH_CACHE_SIZE = 64
_hydrograph_cache: "OrderedDict[tuple, dict]" = OrderedDict()
_hydrograph_lock = threading.Lock()


def build_hydrograph_payload(huc8: str, cycle_token: str) -> dict:
    """Forecast hydrograph for a HUC8 and cycle, as the retrospective one's shape.

    Like the retrospective one, the series is the HUC's outlet reach
    (``feature_id``; see ``fim_logic.outlet_feature_id``), and ``outlet`` is
    that reach as GeoJSON for the map. A cycle never
    changes once complete, so the series is cached in memory per (HUC8,
    cycle); only the first view of each pays for the downloads.
    """
    cycle = parse_token(cycle_token)
    cache_key = (huc8, cycle_token)
    with _hydrograph_lock:
        cached = _hydrograph_cache.get(cache_key)
        if cached is not None:
            _hydrograph_cache.move_to_end(cache_key)
    if cached is None:
        outlet = fim_logic.outlet_feature_id(huc8, feature_ids_for_huc(huc8))
        times, values = fetch_series(cycle, outlet)
        cached = {
            "feature_id": outlet,
            "outlet": fim_logic.outlet_reach_feature(huc8, outlet),
            "times": times,
            "values": values,
        }
        with _hydrograph_lock:
            _hydrograph_cache[cache_key] = cached
            while len(_hydrograph_cache) > _HYDROGRAPH_CACHE_SIZE:
                _hydrograph_cache.popitem(last=False)
    return {
        "status": "success",
        "huc8": huc8,
        "cycle_time": cycle.isoformat(),
        "now": utcnow().replace(microsecond=0).isoformat(),
        **cached,
    }


# ---------------------------------------------------------------------------
# Generation. Step 1 is the shared, verified hydrofabric download; these
# are Steps 2 and 3 for a forecast hour.
# ---------------------------------------------------------------------------
def result_basename(huc8: str, cycle: datetime, valid: datetime) -> str:
    """Shared stem of the discharge CSV and the raster ``runfim`` names after it.

    Both times are needed: two cycles give different forecasts for the same
    valid hour. The ``NWMSR_`` prefix keeps these out of every retrospective
    ``NWM_*`` lookup.
    """
    return f"NWMSR_{to_token(cycle)}_{to_token(valid)}_{huc8}"


def write_discharge_csv(huc8: str, cycle: datetime, valid: datetime) -> Path:
    """Step 2: fetch the forecast hour for the HUC's reaches and write the CSV."""
    fim_logic.mark_huc_in_use(huc8)
    _code_dir, data_dir, _output_dir = fim_logic._load_fimserve()["setup_directories"]()
    frame = fetch_discharge(cycle, valid, feature_ids_for_huc(huc8))
    csv_path = Path(data_dir) / f"{result_basename(huc8, cycle, valid)}.csv"
    frame.to_csv(csv_path, index=False)
    return csv_path


def run_inundation(huc8: str, csv_path: Path) -> Path:
    """Step 3: run HAND inundation on the forecast CSV; return the raster.

    Only the raster named for this CSV counts - never a wildcard match
    (see issue #4) - so a failed run cannot publish some other result.
    """
    fim_logic.mark_huc_in_use(huc8)
    fns = fim_logic._load_fimserve()
    code_dir, _data_dir, output_dir = fns["setup_directories"]()
    fns["runfim"](code_dir, output_dir, huc8, str(csv_path))
    expected = f"{Path(csv_path).stem}_inundation.tif"
    match = fim_logic._find_inundation_file(huc8, expected)
    if match is None:
        raise FileNotFoundError(
            f"No inundation raster was produced for {Path(csv_path).name}. "
            f"Expected {expected}. Check the portal terminal for inundation errors."
        )
    return match

