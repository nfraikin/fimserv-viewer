"""Tests for ``_run_flood_step1_download_huc8`` (issue #3).

Step 1 used to downgrade every download exception to a ``print``, so a
genuinely failed download (no ``aws`` on PATH, no network, a HUC with no
HAND coverage) let the pipeline march into Steps 2 and 3 and die far from
the real cause. Step 1 now decides on the artifacts it finds on disk, not
on whether the download call raised.

Run with:  python -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tethysapp.fimserve_viewer import fim_logic  # noqa: E402

HUC8 = "12090301"


class Step1DownloadVerificationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.flood_dir = self.root / "output" / f"flood_{HUC8}"
        self.addCleanup(self._tmp.cleanup)

        # Pin the artifact search to our temp root so the developer's real
        # FIMserv tree (and the repo's own output/) can't influence it.
        self.patch(fim_logic, "_candidate_fimserv_roots", lambda: [self.root])
        # Eviction touches the real disk; Step 1's contract with it is just
        # "called before the download", asserted in its own test below.
        self.patch(fim_logic, "enforce_cache_budget", mock.Mock())

    def patch(self, target, attr, new=None):
        patcher = (
            mock.patch.object(target, attr, new)
            if new is not None
            else mock.patch.object(target, attr)
        )
        started = patcher.start()
        self.addCleanup(patcher.stop)
        return started

    def write_full_hydrofabric(self):
        """Create everything a successful Step 1 leaves behind."""
        huc_dir = self.flood_dir / HUC8
        (huc_dir / "branches" / "0").mkdir(parents=True)
        (huc_dir / "branches" / "0" / "rem_zeroed_masked_0.tif").write_bytes(b"")
        (huc_dir / "branch_ids.csv").write_text("branch_id\n0\n")
        (huc_dir / "hydrotable.csv").write_text("HydroID,stage,discharge_cms\n")
        (self.flood_dir / "feature_IDs.csv").write_text("feature_id\n5781221\n")

    def run_step1(self, download):
        self.patch(fim_logic, "DownloadHUC8", download)
        return fim_logic._run_flood_step1_download_huc8(HUC8)

    # -- success ---------------------------------------------------------
    def test_successful_download_returns(self):
        def download(huc8, version=None):
            self.write_full_hydrofabric()

        self.assertIsNone(self.run_step1(download))

    def test_already_downloaded_huc_survives_a_benign_exception(self):
        # Re-running for a HUC that is already on disk: `aws s3 sync` may
        # complain, but nothing is actually wrong.
        self.write_full_hydrofabric()

        def download(huc8, version=None):
            raise RuntimeError("An error occurred (404) ... sync target exists")

        self.assertIsNone(self.run_step1(download))

    def test_cache_budget_is_enforced_before_downloading(self):
        calls = []
        fim_logic.enforce_cache_budget.side_effect = lambda **kw: calls.append(kw)

        def download(huc8, version=None):
            calls.append("download")
            self.write_full_hydrofabric()

        self.run_step1(download)
        self.assertEqual(calls, [{"protect_huc": HUC8}, "download"])

    # -- failure ---------------------------------------------------------
    def test_failed_download_raises_and_names_the_missing_artifact(self):
        def download(huc8, version=None):
            raise FileNotFoundError("[Errno 2] No such file or directory: 'aws'")

        with self.assertRaises(RuntimeError) as ctx:
            self.run_step1(download)
        message = str(ctx.exception)
        self.assertIn("branch_ids.csv", message)
        self.assertIn(f"HUC8 {HUC8}", message)
        self.assertIn("aws", message)
        # The original exception stays attached for the job's error_detail.
        self.assertIsInstance(ctx.exception.__cause__, FileNotFoundError)

    def test_silent_download_that_wrote_nothing_still_fails(self):
        # `aws` missing from PATH: FIMserv prints its own warning and
        # returns normally, having downloaded nothing.
        with self.assertRaises(RuntimeError) as ctx:
            self.run_step1(lambda huc8, version=None: None)
        self.assertIn("feature_IDs.csv", str(ctx.exception))

    def test_partial_download_fails_and_names_only_what_is_missing(self):
        def download(huc8, version=None):
            self.write_full_hydrofabric()
            (self.flood_dir / HUC8 / "hydrotable.csv").unlink()

        with self.assertRaises(RuntimeError) as ctx:
            self.run_step1(download)
        message = str(ctx.exception)
        self.assertIn("hydrotable.csv", message)
        self.assertNotIn("branch_ids.csv", message)

    def test_empty_branches_directory_counts_as_missing(self):
        def download(huc8, version=None):
            self.write_full_hydrofabric()
            for f in (self.flood_dir / HUC8 / "branches" / "0").iterdir():
                f.unlink()
            (self.flood_dir / HUC8 / "branches" / "0").rmdir()

        with self.assertRaises(RuntimeError) as ctx:
            self.run_step1(download)
        self.assertIn("branches", str(ctx.exception))

    # -- multiple roots --------------------------------------------------
    def test_hydrofabric_in_a_non_default_root_is_accepted(self):
        # FIMserv sometimes ignores FIMSERV_ROOT and writes under the
        # portal's cwd instead, so every candidate root is searched.
        other = Path(self._tmp.name) / "cwd-root"
        self.patch(fim_logic, "_candidate_fimserv_roots", lambda: [self.root, other])
        self.flood_dir = other / "output" / f"flood_{HUC8}"

        def download(huc8, version=None):
            self.write_full_hydrofabric()

        self.assertIsNone(self.run_step1(download))

    def test_artifacts_split_across_roots_do_not_count_as_complete(self):
        other = Path(self._tmp.name) / "cwd-root"
        self.patch(fim_logic, "_candidate_fimserv_roots", lambda: [self.root, other])
        self.write_full_hydrofabric()
        (self.flood_dir / HUC8 / "hydrotable.csv").unlink()
        (other / "output" / f"flood_{HUC8}" / HUC8).mkdir(parents=True)
        (other / "output" / f"flood_{HUC8}" / HUC8 / "hydrotable.csv").write_text("x\n")

        with self.assertRaises(RuntimeError):
            self.run_step1(lambda huc8, version=None: None)


if __name__ == "__main__":
    unittest.main()
