"""Tests for hydrofabric cache eviction (issue #6).

`enforce_cache_budget` used to protect exactly one HUC - the one the calling
request was about - so a second job, a second worker process, or a second
replica could delete `branches/` out from under a job that was mid-run.
Eviction now protects every HUC with an active job, plus any HUC used
recently enough to still be in flight, and serializes itself with a lock.

Run with:  python -m unittest discover -s tests
"""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import manage_cache  # noqa: E402

MIB = 1024 * 1024


class CacheEvictionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        # Pin every path the module touches to our temp root, so a
        # developer's real FIMserv tree is never a candidate for deletion.
        self.patch(manage_cache, "_candidate_roots", lambda: [self.root])
        # No Tethys app here: default to "no active jobs" and let each test
        # say otherwise, rather than exercising the database fallback.
        self.active_jobs = self.patch(manage_cache, "_hucs_with_active_jobs")
        self.active_jobs.return_value = set()

        # Half a MiB: one 1 MiB HUC is already over the cap.
        self.env("FIMSERVE_CACHE_MAX_GB", "0.0005")
        self.env("FIMSERVE_CACHE_MIN_IDLE_MINUTES", "30")

    def patch(self, target, attr, new=None):
        patcher = (
            mock.patch.object(target, attr, new)
            if new is not None
            else mock.patch.object(target, attr)
        )
        started = patcher.start()
        self.addCleanup(patcher.stop)
        return started

    def env(self, name, value):
        patcher = mock.patch.dict(os.environ, {name: value})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_huc(self, huc8, mib=1, idle_minutes=120):
        """Create one HUC's hydrofabric, last used `idle_minutes` ago."""
        flood_dir = self.root / "output" / f"flood_{huc8}"
        huc_dir = flood_dir / huc8
        (huc_dir / "branches" / "0").mkdir(parents=True)
        (huc_dir / "branches" / "0" / "rem_zeroed_masked_0.tif").write_bytes(
            b"\0" * (mib * MIB)
        )
        (huc_dir / "branch_ids.csv").write_text("branch_id\n0\n")
        (huc_dir / "hydrotable.csv").write_text("HydroID,stage,discharge_cms\n")
        (flood_dir / "feature_IDs.csv").write_text("feature_id\n5781221\n")
        self.set_idle(huc8, idle_minutes)
        return flood_dir

    def set_idle(self, huc8, idle_minutes):
        """Backdate every mtime eviction looks at for this HUC."""
        flood_dir = self.root / "output" / f"flood_{huc8}"
        when = time.time() - idle_minutes * 60
        for path in list(flood_dir.iterdir()) + [flood_dir]:
            os.utime(path, (when, when))

    def has_hydrofabric(self, huc8):
        return (self.root / "output" / f"flood_{huc8}" / huc8 / "branches").is_dir()


class EvictionProtectsRunningWorkTests(CacheEvictionTests):
    def test_evicts_the_least_recently_used_idle_huc(self):
        self.env("FIMSERVE_CACHE_MAX_GB", "0.0015")  # ~1.5 MiB: one HUC fits
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=120)

        manage_cache.enforce_cache_budget(protect_huc="05120201")

        self.assertFalse(self.has_hydrofabric("12090301"))
        self.assertTrue(self.has_hydrofabric("11010004"))

    def test_huc_with_an_active_job_in_another_process_survives(self):
        # The issue's race: job A is mid-Step 3 on the LRU HUC when job B
        # starts and finds the cache over budget.
        self.env("FIMSERVE_CACHE_MAX_GB", "0.0015")  # ~1.5 MiB: one HUC fits
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=120)
        self.active_jobs.return_value = {"12090301"}

        manage_cache.enforce_cache_budget(protect_huc="05120201")

        # The running job keeps its hydrofabric even though it is the
        # least-recently-used HUC; eviction takes the next candidate.
        self.assertTrue(self.has_hydrofabric("12090301"))
        self.assertFalse(self.has_hydrofabric("11010004"))

    def test_recently_used_huc_survives_without_a_job_record(self):
        # The synchronous endpoints bypass the job manager entirely, so
        # their HUC is only protected by its in-use marker.
        self.write_huc("12090301", idle_minutes=600)
        manage_cache.mark_huc_in_use("12090301")

        manage_cache.enforce_cache_budget(protect_huc="05120201")

        self.assertTrue(self.has_hydrofabric("12090301"))

    def test_marker_keeps_a_huc_whose_tree_is_only_being_read(self):
        # Step 3 reads branches/ for many minutes without writing under
        # flood_<huc8>/, so mtimes alone would call this HUC idle.
        flood_dir = self.write_huc("12090301", idle_minutes=600)
        manage_cache.mark_huc_in_use("12090301")
        marker = flood_dir / manage_cache._IN_USE_MARKER
        self.assertTrue(marker.is_file())

        manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))

    def test_protect_huc_is_still_honoured(self):
        self.write_huc("12090301", idle_minutes=600)

        manage_cache.enforce_cache_budget(protect_huc="12090301")

        self.assertTrue(self.has_hydrofabric("12090301"))

    def test_protect_huc_accepts_a_non_string_huc(self):
        self.write_huc("12090301", idle_minutes=600)

        manage_cache.enforce_cache_budget(protect_huc=12090301)

        self.assertTrue(self.has_hydrofabric("12090301"))

    def test_nothing_is_evicted_when_every_huc_is_in_use(self):
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=600)
        self.active_jobs.return_value = {"12090301", "11010004"}

        manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))
        self.assertTrue(self.has_hydrofabric("11010004"))

    def test_eviction_stops_once_the_cache_fits(self):
        self.env("FIMSERVE_CACHE_MAX_GB", "0.0015")  # ~1.5 MiB: one HUC fits
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=300)

        manage_cache.enforce_cache_budget()

        self.assertFalse(self.has_hydrofabric("12090301"))
        self.assertTrue(self.has_hydrofabric("11010004"))

    def test_unreadable_job_database_falls_back_to_markers(self):
        # _hucs_with_active_jobs returns None when jobs_db can't be read;
        # that must not read as "no HUC is active".
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=300)
        self.active_jobs.return_value = None
        manage_cache.mark_huc_in_use("12090301")

        manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))
        self.assertFalse(self.has_hydrofabric("11010004"))

    def test_nothing_is_evicted_while_under_the_cap(self):
        self.env("FIMSERVE_CACHE_MAX_GB", "10")
        self.write_huc("12090301", idle_minutes=600)

        manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))
        # The job database isn't even consulted when there is nothing to do.
        self.active_jobs.assert_not_called()

    def test_zero_cap_disables_eviction(self):
        self.env("FIMSERVE_CACHE_MAX_GB", "0")
        self.write_huc("12090301", idle_minutes=600)

        manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))


class EvictionLogTests(CacheEvictionTests):
    def test_log_names_the_hucs_considered_and_protected(self):
        self.write_huc("12090301", idle_minutes=600)
        self.write_huc("11010004", idle_minutes=300)
        self.active_jobs.return_value = {"12090301"}

        with mock.patch.object(manage_cache, "_log") as log:
            manage_cache.enforce_cache_budget(protect_huc="11010004")

        summary = next(
            line for line in (call.args[0] for call in log.call_args_list)
            if "considered" in line
        )
        # Least-recently-used first, and each protected HUC says why.
        self.assertIn("considered (least recently used first): 12090301, 11010004", summary)
        self.assertIn("12090301 (active job)", summary)
        self.assertIn("11010004 (requested by this call)", summary)


class EvictionLockTests(CacheEvictionTests):
    def test_a_second_process_skips_eviction_while_one_is_running(self):
        self.write_huc("12090301", idle_minutes=600)

        # Hold the lock the way a peer process would, then try to evict.
        # flock is held per open file description, so a second acquisition
        # conflicts even from this same process.
        with manage_cache._eviction_lock() as held:
            self.assertTrue(held)
            manage_cache.enforce_cache_budget()

        self.assertTrue(self.has_hydrofabric("12090301"))

    def test_eviction_runs_again_once_the_lock_is_free(self):
        self.write_huc("12090301", idle_minutes=600)

        with manage_cache._eviction_lock() as held:
            self.assertTrue(held)
        manage_cache.enforce_cache_budget()

        self.assertFalse(self.has_hydrofabric("12090301"))


if __name__ == "__main__":
    unittest.main()
