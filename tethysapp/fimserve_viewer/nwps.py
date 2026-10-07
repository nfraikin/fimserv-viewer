"""Reach names from NOAA's National Water Prediction Service (NWPS) API.

The NWM reach tiles on the map carry only a reach's ID and stream order, and
the HUC stream networks FIMserv downloads have no names either. NWPS has the
name of each NWM reach (the river's GNIS name), as nwm-map-app showed.

NWPS answers 503 "Data unavailable" for an ID it does not know as well as
when it is struggling, so any failure is just "no name": the name is a label
next to the hydrograph, never worth failing a request over.
"""

import functools
import logging

log = logging.getLogger(__name__)

NWPS_REACH_URL = "https://api.water.noaa.gov/nwps/v1/reaches/{}"
NWPS_TIMEOUT_S = 15


@functools.lru_cache(maxsize=4096)
def _fetch_reach_name(feature_id: int) -> str:
    """The name NWPS gives the reach, '' when it has none. Raises on failure,
    which lru_cache does not remember, so a failed lookup is retried next time."""
    import requests

    resp = requests.get(NWPS_REACH_URL.format(feature_id), timeout=NWPS_TIMEOUT_S)
    resp.raise_for_status()
    return (resp.json().get("name") or "").strip()


def reach_name(feature_id: int):
    """The reach's name, '' when it is unnamed, or None when NWPS can't say."""
    try:
        return _fetch_reach_name(int(feature_id))
    except Exception as exc:  # network, HTTP or JSON error alike
        log.info("No NWPS name for reach %s: %s", feature_id, exc)
        return None
