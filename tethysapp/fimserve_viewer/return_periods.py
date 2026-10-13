"""NWM return-period flows for one reach, from the CIROH NWM API.

The hydrograph panels can draw these as reference lines (the 2- to 100-year
flows), so a series reads against what counts as a flood at that reach. The
approach follows the Tethys Summit 2026 "Will It Flood?" flood-warning
notebook (Hover, Ames, Pathak).

The API needs a key (``x-api-key``), so the browser never calls it directly:
the key stays on the server, as the app's ``ciroh_api_key`` setting, the
``CIROH_API_KEY`` environment variable, or a ``CIROH_API_KEY=`` line in the
keys file outside the repo (see ``local_keys``).

Docs: https://nwm-api.ciroh.org/docs
"""

import threading
from collections import OrderedDict

import requests

from . import local_keys

API_URL = "https://nwm-api.ciroh.org/return-period"
API_KEY_ENV = "CIROH_API_KEY"
TIMEOUT_S = 45

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
