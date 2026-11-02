"""Monthly limits on the APIs whose keys BYU Hydroinformatics provides.

The Mapbox token (basemap and NWM river reaches) and the CIROH NWM API key
(return periods) belong to BYU Hydroinformatics, which shares them with this
app on the condition that each is used at most 500 times a month. Every call
is counted in the app database, so all portal replicas and Dask workers share
one count, and once a month's calls are used up the features that need them
are turned off with a message saying so.

What counts as one call:

- CIROH: one HTTP request to the return-period API. Answers served from the
  in-process cache cost nothing. A HUC8 map takes one request per
  ``return_periods.BATCH_SIZE`` reaches, all reserved before the first is sent.
- Mapbox: one map load, the unit Mapbox bills GL JS by. Each Mapbox map the
  page creates (the basemap and the NWM reaches make one each) reports itself
  to ``api/usage/mapbox-load``. Once the month is used up the home page stops
  handing out the token, so pages already open may finish their own loads but
  new ones get the free basemaps only.

Each API has its own limit, which resets on the 1st of every month (UTC).
``BYU_API_MONTHLY_LIMIT`` (environment or keys file) changes it from 500.
"""

import logging
import threading
from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError

from . import local_keys
from .model import ApiUsage

log = logging.getLogger(__name__)

MAPBOX = "mapbox"
CIROH = "ciroh"
APIS = (MAPBOX, CIROH)

LIMIT_ENV = "BYU_API_MONTHLY_LIMIT"
DEFAULT_LIMIT = 500

# Worded for the person who hit the limit: what is off, whose account it is,
# and when it comes back.
_MESSAGES = {
    MAPBOX: (
        "The Mapbox basemap and NWM river reaches run on a Mapbox account that "
        "BYU Hydroinformatics provides, shared with this app for up to {limit} "
        "map loads a month. This month's map loads have all been used, so the "
        "other basemaps are shown instead until {reset}. Thank you for understanding!"
    ),
    CIROH: (
        "Return-period flows come from the CIROH NWM API through an account that "
        "BYU Hydroinformatics provides, shared with this app for up to {limit} "
        "calls a month. This month's calls have all been used, so return periods "
        "are unavailable until {reset}. Thank you for understanding!"
    ),
}


def current_month(now: Optional[datetime] = None) -> str:
    """The month calls are counted against, as ``YYYY-MM`` (UTC)."""
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")


def next_reset(month: str) -> date:
    """The day ``month``'s count starts over: the 1st of the following month."""
    year, mon = (int(part) for part in month.split("-"))
    return date(year + mon // 12, mon % 12 + 1, 1)


def monthly_limit() -> int:
    """Calls allowed per API per month: ``BYU_API_MONTHLY_LIMIT``, else 500."""
    value = local_keys.get(LIMIT_ENV)
    if value is None:
        return DEFAULT_LIMIT
    try:
        limit = int(value)
    except ValueError:
        limit = -1
    if limit < 0:
        log.warning("Ignoring %s=%r; using %d", LIMIT_ENV, value, DEFAULT_LIMIT)
        return DEFAULT_LIMIT
    return limit


def limit_message(api: str, limit: int, month: str) -> str:
    """The message shown once ``api``'s calls for ``month`` are used up."""
    reset = next_reset(month)
    return _MESSAGES[api].format(limit=limit, reset=f"{reset:%B} {reset.day}")


class UsageLimitReached(RuntimeError):
    """This month's calls to a BYU-provided API are used up."""

    def __init__(self, api: str, limit: int, month: str):
        self.api = api
        self.limit = limit
        self.month = month
        super().__init__(limit_message(api, limit, month))


class UsageCounter:
    """Counts calls per API per month in the ``api_usage`` table."""

    def __init__(self, session_maker=None):
        if session_maker is None:
            from .job_store import app_session_maker

            session_maker = app_session_maker()
        self.session_maker = session_maker
        # The table is newer than some databases, and the store initializer
        # only runs on syncstores, so make sure it exists.
        engine = session_maker.kw.get("bind")
        if engine is not None:
            ApiUsage.__table__.create(bind=engine, checkfirst=True)

    @contextmanager
    def session(self):
        """Yield a session that commits on success and rolls back on error."""
        session = self.session_maker()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def used(self, api: str, month: Optional[str] = None) -> int:
        """Calls to ``api`` so far in ``month`` (this month by default)."""
        with self.session() as session:
            row = session.get(ApiUsage, (api, month or current_month()))
            return row.calls if row else 0

    def check(self, api: str) -> None:
        """Raise UsageLimitReached if this month's calls to ``api`` are used up."""
        month, limit = current_month(), monthly_limit()
        if self.used(api, month) >= limit:
            raise UsageLimitReached(api, limit, month)

    def reserve(self, api: str, calls: int = 1) -> int:
        """Count ``calls`` about to be made, or raise UsageLimitReached if they
        would go past the limit. All or nothing; returns the month's new total.

        The conditional UPDATE is atomic, so concurrent reservations from
        different processes can never push the count past the limit.
        """
        month, limit = current_month(), monthly_limit()
        self._ensure_row(api, month)
        with self.session() as session:
            updated = (
                session.query(ApiUsage)
                .filter(ApiUsage.api == api, ApiUsage.month == month,
                        ApiUsage.calls + calls <= limit)
                .update({ApiUsage.calls: ApiUsage.calls + calls}, synchronize_session=False)
            )
        if updated != 1:
            raise UsageLimitReached(api, limit, month)
        return self.used(api, month)

    def record(self, api: str, calls: int = 1) -> int:
        """Count ``calls`` already made, limit or not; returns the month's new total.

        For Mapbox map loads, which the browser reports after the fact.
        """
        month = current_month()
        self._ensure_row(api, month)
        with self.session() as session:
            session.query(ApiUsage).filter(
                ApiUsage.api == api, ApiUsage.month == month
            ).update({ApiUsage.calls: ApiUsage.calls + calls}, synchronize_session=False)
        return self.used(api, month)

    def summary(self) -> dict:
        """This month's use of every API, for ``api/usage``."""
        month, limit = current_month(), monthly_limit()
        return {
            "month": month,
            "resets_on": next_reset(month).isoformat(),
            "limit": limit,
            "used": {api: self.used(api, month) for api in APIS},
        }

    def _ensure_row(self, api: str, month: str) -> None:
        """Insert the month's zero row if missing; a concurrent insert wins harmlessly."""
        try:
            with self.session() as session:
                if session.get(ApiUsage, (api, month)) is None:
                    session.add(ApiUsage(api=api, month=month, calls=0))
        except IntegrityError:
            pass


_counter: Optional[UsageCounter] = None
_counter_lock = threading.Lock()


def counter() -> UsageCounter:
    """This process's usage counter, created once on first use."""
    global _counter
    if _counter is None:
        with _counter_lock:
            if _counter is None:
                _counter = UsageCounter()
    return _counter
