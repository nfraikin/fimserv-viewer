"""
manage_cache.py - Hydrofabric disk-cache management for the FIMserve Viewer.

A first-time HUC8 download is ~700-900 MB, almost all of it hydrofabric
internals (branches/, hydrotable.csv, ...) that are only needed while the
inundation step runs. The generated tif is ~2 MB. To keep a small server
from filling up, we cap the total hydrofabric footprint: before each new
download, the least-recently-used HUCs' heavy internals are deleted until
the total fits FIMSERVE_CACHE_MAX_GB. Small sidecar files that other
endpoints read afterwards (boundary/streams gpkg, branch_ids.csv) and the
inundation tifs are always kept. `aws s3 sync` in DownloadHUC8 re-fetches
only missing files, so an evicted HUC self-heals on its next request.

Eviction deletes data other work may be in the middle of reading, so three
things keep it off a hydrofabric that is in use (issue #6):

  * Every HUC8 with an active job in ``jobs_db`` is protected, whichever
    replica or worker process that job belongs to - not just the HUC the
    calling request is about.
  * Each pipeline step calls `mark_huc_in_use`, and a HUC used within
    FIMSERVE_CACHE_MIN_IDLE_MINUTES is protected. This is the backstop for
    work that has no job record, such as the synchronous endpoints in
    controllers.py.
  * Eviction itself runs under a lock file, so two processes sharing a
    FIMSERV_ROOT cannot prune against each other's stale size totals.

Staying over the cap is the safe failure: the disk fills up, but no running
job loses its hydrofabric. When everything is protected, eviction logs that
it freed nothing rather than evicting anyway.
"""

import os
import shutil
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

_HYDROFABRIC_KEEP_FILES = {
    "wbd.gpkg",                        # HUC boundary (preview masking)
    "nwm_subset_streams.gpkg",         # streams (Q-label endpoint)
    "nwm_catchments_proj_subset.gpkg", # boundary fallback (preview masking)
    "branch_ids.csv",
}

# Written in output/flood_<huc8>/ by mark_huc_in_use. Its mtime is when the
# HUC was last used, which is more truthful than the mtimes of the tree
# itself: a long Step 3 mostly *reads* branches/, so nothing under
# flood_<huc8>/ would be touched for the whole run.
_IN_USE_MARKER = ".fimserve_in_use"

_EVICTION_LOCK_FILE = ".fimserve-eviction.lock"

_DEFAULT_MIN_IDLE_MINUTES = 30.0


def _candidate_roots() -> list:
    # Imported lazily: fim_logic imports this module at load time, so a
    # module-level import here would be circular.
    from .fim_logic import _candidate_fimserv_roots

    return _candidate_fimserv_roots()


def _log(message: str) -> None:
    print(f"[fimserve_viewer] {message}", flush=True)


def _cache_max_bytes() -> int:
    """FIMSERVE_CACHE_MAX_GB as bytes. <= 0 (or unparsable) disables eviction."""
    raw = os.environ.get("FIMSERVE_CACHE_MAX_GB", "3")
    try:
        gb = float(raw)
    except ValueError:
        _log(f"Ignoring unparsable FIMSERVE_CACHE_MAX_GB={raw!r}")
        return 0
    return int(gb * 1024**3) if gb > 0 else 0


def _min_idle_seconds() -> float:
    """How long a HUC must have gone unused before it may be evicted."""
    raw = os.environ.get("FIMSERVE_CACHE_MIN_IDLE_MINUTES", str(_DEFAULT_MIN_IDLE_MINUTES))
    try:
        minutes = float(raw)
    except ValueError:
        _log(f"Ignoring unparsable FIMSERVE_CACHE_MIN_IDLE_MINUTES={raw!r}")
        minutes = _DEFAULT_MIN_IDLE_MINUTES
    return max(minutes, 0.0) * 60.0


def _tree_size_bytes(path: Path) -> int:
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def mark_huc_in_use(huc8: str) -> None:
    """Record that this HUC8's hydrofabric is being used right now.

    Called at the start of every pipeline step. Eviction reads the marker's
    mtime, so work that holds no job record - the synchronous endpoints in
    controllers.py, or a job whose replica died mid-run - still keeps its
    hydrofabric for FIMSERVE_CACHE_MIN_IDLE_MINUTES.
    """
    for root in _candidate_roots():
        flood_dir = root / "output" / f"flood_{huc8}"
        if not flood_dir.is_dir():
            continue
        try:
            (flood_dir / _IN_USE_MARKER).touch()
        except OSError as exc:
            _log(f"Could not mark HUC {huc8} in use under {flood_dir}: {exc}")


@contextmanager
def _eviction_lock():
    """Hold the cross-process eviction lock, yielding whether we got it.

    Two processes evicting at once both measure the cache before either has
    deleted anything, so both prune - between them they can empty the cache.
    The lock is non-blocking on purpose: this runs in a web worker, and a
    skipped eviction only means the cache stays over its cap until the next
    download, whereas waiting on a peer's rmtree would stall a request.

    Without fcntl (Windows) or a writable root, eviction proceeds unlocked:
    the protections above still hold, and single-process installs - the ones
    likely to be on Windows - have nothing to race with.
    """
    try:
        import fcntl
    except ImportError:
        yield True
        return

    lock_path = _candidate_roots()[0] / "output" / _EVICTION_LOCK_FILE
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("w")
    except OSError as exc:
        _log(f"Could not open eviction lock {lock_path} ({exc}); evicting unlocked")
        yield True
        return

    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def _hucs_with_active_jobs() -> Optional[set]:
    """HUC8s that a job is working on in any replica, or None if unknown.

    None (the job database is unreachable, or we are running outside the
    Tethys app) is not the same as "none active": the caller falls back to
    the in-use markers instead of assuming every HUC is idle.
    """
    try:
        from .job_store import JobStore
        from .jobs import STALE_TIMEOUT_SECONDS

        store = JobStore()
        # Jobs whose replica died stop counting as active, so a crash can't
        # pin a HUC in the cache forever.
        store.mark_stale_interrupted(STALE_TIMEOUT_SECONDS)
        return store.active_huc8s()
    except Exception as exc:
        _log(
            f"Could not read active jobs ({type(exc).__name__}: {exc}); "
            f"falling back to in-use markers to decide what is evictable"
        )
        return None


def prune_huc_hydrofabric(huc8: str) -> int:
    """Delete one HUC8's heavy hydrofabric internals; keep the small sidecars.

    Sweeps every candidate root (pre-patch FIMserv runs may have written to
    the portal cwd). Returns bytes freed.

    Callers are responsible for knowing the HUC is idle: this is the
    unconditional delete that `enforce_cache_budget` guards.
    """
    freed = 0
    for root in _candidate_roots():
        huc_dir = root / "output" / f"flood_{huc8}" / huc8
        if not huc_dir.is_dir():
            continue
        for child in huc_dir.iterdir():
            if child.name in _HYDROFABRIC_KEEP_FILES:
                continue
            size = _tree_size_bytes(child)
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            except OSError as exc:
                _log(f"Could not prune {child}: {exc}")
                continue
            freed += size
    if freed:
        _log(
            f"Pruned hydrofabric for HUC {huc8}: freed {freed / 1024**2:.0f} MiB"
        )
    return freed


def _hydrofabric_stats() -> dict:
    """Per-HUC8 evictable bytes and last-used time, summed across all roots."""
    stats: dict = {}
    for root in _candidate_roots():
        out_dir = root / "output"
        if not out_dir.is_dir():
            continue
        for flood_dir in out_dir.glob("flood_*"):
            huc8 = flood_dir.name[len("flood_"):]
            huc_dir = flood_dir / huc8
            if not huc8.isdigit() or not huc_dir.is_dir():
                continue
            heavy = sum(
                _tree_size_bytes(c)
                for c in huc_dir.iterdir()
                if c.name not in _HYDROFABRIC_KEEP_FILES
            )
            recency = flood_dir.stat().st_mtime
            # Immediate children only - the in-use marker and the per-run
            # artifacts live here, and walking branches/ would cost a full
            # stat of the tree we are only sizing.
            for sub in flood_dir.iterdir():
                try:
                    recency = max(recency, sub.stat().st_mtime)
                except OSError:
                    pass
            entry = stats.setdefault(huc8, {"bytes": 0, "recency": 0.0})
            entry["bytes"] += heavy
            entry["recency"] = max(entry["recency"], recency)
    return stats


def _protection_reasons(stats: dict, protect_huc: Optional[str]) -> dict:
    """Map each HUC8 that must not be evicted to why, for the eviction log."""
    reasons: dict = {}
    if protect_huc is not None:
        reasons[str(protect_huc)] = "requested by this call"

    active = _hucs_with_active_jobs()
    for huc8 in active or ():
        reasons.setdefault(str(huc8), "active job")

    min_idle = _min_idle_seconds()
    now = time.time()
    for huc8, entry in stats.items():
        idle = now - entry["recency"]
        if idle < min_idle:
            reasons.setdefault(huc8, f"used {idle / 60:.0f} min ago")
    return reasons


def enforce_cache_budget(protect_huc: Optional[str] = None) -> None:
    """Evict least-recently-used HUC hydrofabric until under the cache cap.

    Call before starting a new HUC download so the ~1 GB it needs fits the
    budget. `protect_huc` (the HUC about to be used) is never evicted, and
    neither is any HUC another job or request is using - see the module
    docstring. Nothing is evicted when the cache is already under its cap.
    """
    cap = _cache_max_bytes()
    if cap <= 0:
        return

    with _eviction_lock() as acquired:
        if not acquired:
            _log(
                "Another process is already evicting hydrofabric; skipping "
                "this pass (the next download re-checks the cap)"
            )
            return
        _evict_until_under_cap(cap, protect_huc)


def _evict_until_under_cap(cap: int, protect_huc: Optional[str]) -> None:
    """Prune idle HUCs, least-recently-used first, until the cache fits `cap`."""
    stats = _hydrofabric_stats()
    total = sum(e["bytes"] for e in stats.values())
    if total <= cap:
        return

    order = [huc8 for huc8, _ in sorted(stats.items(), key=lambda kv: kv[1]["recency"])]
    reasons = _protection_reasons(stats, protect_huc)
    protected = [h for h in order if h in reasons]
    _log(
        f"Hydrofabric cache {total / 1024**3:.1f} GiB over {cap / 1024**3:.1f} GiB "
        f"cap; considered (least recently used first): {', '.join(order)}; "
        f"protected: "
        + (", ".join(f"{h} ({reasons[h]})" for h in protected) or "none")
    )

    for huc8 in order:
        if huc8 in reasons:
            continue
        total -= prune_huc_hydrofabric(huc8)
        if total <= cap:
            return

    _log(
        f"Hydrofabric cache is still {total / 1024**3:.1f} GiB, over its "
        f"{cap / 1024**3:.1f} GiB cap: everything else is in use. Raise "
        f"FIMSERVE_CACHE_MAX_GB or give the portal more disk."
    )


__all__ = [
    "enforce_cache_budget",
    "mark_huc_in_use",
    "prune_huc_hydrofabric",
]
