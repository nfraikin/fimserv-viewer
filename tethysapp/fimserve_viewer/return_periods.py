"""NWM return-period flows, from the CIROH NWM API.

The hydrograph panels can draw these as reference lines (the 2- to 100-year
flows), so a series reads against what counts as a flood at that reach. The
approach follows the Tethys Summit 2026 "Will It Flood?" flood-warning
notebook (Hover, Ames, Pathak).

The Return Period page maps them too: every reach of a HUC8 at its own
N-year flow, written as the same ``feature_id,discharge`` CSV that Step 3
consumes for the retrospective and forecast maps.

The API needs a key (``x-api-key``), so the browser never calls it directly:
the key stays on the server, as the app's ``ciroh_api_key`` setting, the
``CIROH_API_KEY`` environment variable, or a ``CIROH_API_KEY=`` line in the
keys file outside the repo (see ``local_keys``).

Docs: https://nwm-api.ciroh.org/docs
"""

import logging
import threading
from collections import OrderedDict
from pathlib import Path

import requests

from . import local_keys

log = logging.getLogger(__name__)

API_URL = "https://nwm-api.ciroh.org/return-period"
API_KEY_ENV = "CIROH_API_KEY"
TIMEOUT_S = 45

# The six return periods the API serves (its docs: "2, 5, 10, 25, 50, and
# 100"). The Return Period page offers exactly these.
RETURN_PERIOD_YEARS = (2, 5, 10, 25, 50, 100)

# Reaches per request when fetching a whole HUC8. The comids go in the query
# string: 1,000 (about 10 KB of URL) worked against the live API and a full
# HUC8 of 2,225 was rejected outright, so 500 leaves room either way.
BATCH_SIZE = 500

# Return periods are a fixed statistic of the retrospective record, so a
# reach's answer never changes; cache them for the life of the process.
_CACHE_SIZE = 256
_cache: "OrderedDict[str, list]" = OrderedDict()
_lock = threading.Lock()


class NotConfigured(LookupError):
    """No CIROH API key is set, so return periods cannot be fetched."""


def api_key(setting_value=None):
    """The configured key: the app setting, then the environment, then the keys file."""
    key = local_keys.get(API_KEY_ENV, setting_value)
    if not key:
        raise NotConfigured(
            f"Return periods need a CIROH NWM API key. Add {API_KEY_ENV}=... to "
            f"{local_keys.keys_file()}, or set the app's ciroh_api_key setting."
        )
    return key


def configured_api_key():
    """``api_key`` with the app's ``ciroh_api_key`` setting, when Tethys has one.

    Imported lazily so this module (and its tests) load without Tethys.
    """
    try:
        from .app import App

        setting = App.get_custom_setting("ciroh_api_key")
    except Exception:  # Tethys absent, or the setting not yet synced
        setting = None
    return api_key(setting)


def validate_years(years):
    """``years`` as an int, if it is one of ``RETURN_PERIOD_YEARS``; else ValueError."""
    try:
        value = int(str(years))
    except (TypeError, ValueError):
        value = None
    if value not in RETURN_PERIOD_YEARS:
        offered = ", ".join(str(y) for y in RETURN_PERIOD_YEARS)
        raise ValueError(f"Return period must be one of {offered} years.")
    return value


def parse_response(payload, feature_id):
    """``[{"years": 2, "value": m3s}, ...]`` sorted by years, from the API's JSON.

    The JSON is a list of one record per requested reach, e.g.
    ``{"feature_id": 123, "return_period_2": 41.2, ...}``, in m³/s. Fields
    whose name doesn't end in a year count, or whose value is missing, are
    skipped rather than failing the whole response.
    """
    records = payload if isinstance(payload, list) else [payload]
    record = None
    for rec in records:
        if isinstance(rec, dict) and str(rec.get("feature_id")) == str(feature_id):
            record = rec
            break
    if record is None:
        raise LookupError(f"No return periods for NWM reach {feature_id}.")

    out = []
    for key, value in record.items():
        if key == "feature_id" or value is None:
            continue
        years = key.rsplit("_", 1)[-1]
        if not years.isdigit():
            continue
        try:
            out.append({"years": int(years), "value": float(value)})
        except (TypeError, ValueError):
            continue
    if not out:
        raise LookupError(f"No return periods for NWM reach {feature_id}.")
    out.sort(key=lambda rp: rp["years"])
    return out


def get_return_periods(feature_id, key):
    """Return periods for one NWM reach (m³/s), cached per reach."""
    feature_id = str(feature_id)
    with _lock:
        cached = _cache.get(feature_id)
        if cached is not None:
            _cache.move_to_end(feature_id)
            return cached

    resp = requests.get(
        API_URL,
        params={"comids": feature_id, "output_format": "json"},
        headers={"x-api-key": key},
        timeout=TIMEOUT_S,
    )
    resp.raise_for_status()
    periods = parse_response(resp.json(), feature_id)

    with _lock:
        _cache[feature_id] = periods
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return periods


# ---------------------------------------------------------------------------
# A whole HUC8 at one return period, for the Return Period page's flood map.
# ---------------------------------------------------------------------------
def fetch_period_flows(feature_ids, years, key):
    """``{feature_id: m³/s}`` for every reach's ``years``-year flow.

    Asks for just that one period, ``BATCH_SIZE`` reaches per request.
    Reaches the API has no value for are left out: those inside a reservoir
    (NWM routes the lake as a whole, so they have no flow of their own, the
    same reaches the hydrographs skip) and any the API doesn't know.
    """
    field = f"return_period_{years}"
    ids = list(dict.fromkeys(int(fid) for fid in feature_ids))
    flows = {}
    for start in range(0, len(ids), BATCH_SIZE):
        batch = ids[start:start + BATCH_SIZE]
        resp = requests.get(
            API_URL,
            params={
                "comids": ",".join(str(fid) for fid in batch),
                "return_periods": str(years),
                "output_format": "json",
            },
            headers={"x-api-key": key},
            timeout=TIMEOUT_S,
        )
        resp.raise_for_status()
        payload = resp.json()
        for rec in payload if isinstance(payload, list) else [payload]:
            if not isinstance(rec, dict):
                continue
            try:
                fid, value = int(rec["feature_id"]), float(rec[field])
            except (KeyError, TypeError, ValueError):
                continue
            if value >= 0:
                flows[fid] = value
    return flows


def result_basename(huc8, years):
    """Shared stem of the discharge CSV and the raster ``runfim`` names after it.

    The ``NWMRP_`` prefix keeps these out of every retrospective ``NWM_*``
    and forecast ``NWMSR_*`` lookup.
    """
    return f"NWMRP_{years}yr_{huc8}"


def write_discharge_csv(huc8, years, key):
    """Step 2: every reach of the HUC8 at its ``years``-year flow, as a CSV.

    Each reach floods at its own N-year flow, not one discharge for the
    whole watershed, so the map shows what an N-year event looks like on
    every stream at once. Returns the CSV's path.
    """
    import pandas as pd

    from . import fim_logic, forecast

    fim_logic.mark_huc_in_use(huc8)
    _code_dir, data_dir, _output_dir = fim_logic._load_fimserve()["setup_directories"]()
    feature_ids = forecast.feature_ids_for_huc(huc8)
    flows = fetch_period_flows(feature_ids, years, key)
    if not flows:
        raise RuntimeError(
            f"The CIROH NWM API has no {years}-year flows for HUC8 {huc8}'s reaches."
        )
    missing = len(set(feature_ids)) - len(flows)
    if missing:
        log.info("%d of %d reaches in %s have no %d-year flow", missing,
                 len(set(feature_ids)), huc8, years)
    frame = pd.DataFrame({"feature_id": list(flows), "discharge": list(flows.values())})
    csv_path = Path(data_dir) / f"{result_basename(huc8, years)}.csv"
    frame.to_csv(csv_path, index=False)
    return csv_path
