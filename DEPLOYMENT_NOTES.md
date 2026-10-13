# FIMserv Viewer - Deployment notes (fresh clone)

**Repository:** https://github.com/tasfia26/tethysapp-fimserve_viewer  
**Date:** July 2026  
**Audience:** Testers installing from a clean git clone (e.g. after initial deployment feedback)

---

## Summary

Thank you for testing the app from a fresh clone. Two issues were identified during that test:

1. **Python 3.13 conflict** - the README did not pin Python when creating the Tethys conda environment, but `install.yml` requires `python>=3.10,<3.13`. Installing with Python 3.13 caused `tethys install -d` to fail when conda tried to downgrade Python mid-install.

2. **Missing AWS CLI** - Step 1 (HAND data download) runs `aws s3 sync` against the public CIROH S3 bucket. Without the **AWS CLI** on `PATH`, Step 1 failed with `aws: not found`, so `branch_ids.csv` was never created and Step 3 produced no inundation output.

Both issues are addressed in commits **`52e9076`** and **`254a8a8`** on the `main` branch.

---

## What we changed in the repository

| File | Change |
|------|--------|
| **`install.yml`** | Added **`awscli`** to the conda package list so `tethys install -d` installs the AWS CLI automatically. (Step 1 needs `aws s3 sync`; no AWS account required - bucket is public.) |
| **`README.md`** | Updated **`mamba create`** commands to pin **`python>=3.10,<3.13`**. Added prerequisites, post-install checks (`python --version`, `aws --version`), and a **Troubleshooting** section for Python 3.13 and missing AWS CLI. |
| **`RUNBOOK.md`** | **New file** - step-by-step clean-machine checklist (environment creation → install → verification → smoke test). |
| **`README.md`** (intro) | Link to **RUNBOOK.md** for fresh deployments. |

**Unchanged (for clarity):**

- Flood-mapping logic (`fim_logic.py`, `controllers.py`) - no science changes.
- FIMserv is still pinned to the same GitHub commit (now via `pyproject.toml` instead of `post_install.py`).
- Public data access - still no AWS credentials needed for HAND or NWM retrospective data.

---

## What you need to do (if you already tried an install)

Follow these steps on a **clean or recreated** conda environment. Do **not** reuse an environment that was created with Python 3.13.

### Step 1 - Pull the latest code

```bash
cd tethysapp-fimserve_viewer
git pull origin main
```

Confirm you are on commit **`254a8a8`** or later (`git log -1 --oneline`).

### Step 2 - Remove the old conda environment (recommended)

```bash
conda deactivate
conda env remove -n tethys-fimserve
```

Use your actual env name if different (e.g. `tethys`).

### Step 3 - Create a new environment with a supported Python

```bash
mamba create -n tethys-fimserve -c conda-forge \
  "tethys-platform>=4.0" "postgresql" "python>=3.10,<3.13"

conda activate tethys-fimserve
python --version
```

**Expected:** `Python 3.10.x`, `3.11.x`, or `3.12.x`.  
**Not acceptable:** `Python 3.13.x`.

### Step 4 - Portal database setup (first time only on this machine)

If you have **not** already configured Tethys on this machine:

```bash
tethys gen portal_config
tethys db init
tethys db start
tethys db configure
```

### Step 5 - Install the app

From the repository root:

```bash
cd tethysapp-fimserve_viewer
tethys install -d
```

This pip-installs the dependencies declared in `pyproject.toml` (including **awscli** and FIMserv at a pinned git ref) and registers the app.

### Step 6 - Verify before testing the UI

```bash
python --version    # 3.10-3.12
aws --version       # AWS CLI must respond
tethys list         # should list fimserve_viewer
```

If `aws --version` fails:

```bash
conda install -c conda-forge awscli
```

### Step 7 - Start the portal

```bash
tethys start -p 127.0.0.1:8001
```

Open in a browser:

**http://127.0.0.1:8001/apps/fimserve-viewer/**

Optional health check (with server running):

```bash
curl http://127.0.0.1:8001/apps/fimserve-viewer/api/health/
```

Expected: `{"status": "ok", ...}`

### Step 8 - Smoke test flood map generation

1. Click HUC8 **`06010105`** (or any watershed).
2. Date: **`2022-04-27`**, Time: **`12:00:00`**.
3. Click **Generate Flood Map**.

**Timing:** The **first** run for a given HUC8 often takes **5-15 minutes** (HAND download from S3). Later runs for the same HUC8 are much faster.

**After Step 1 succeeds**, these files should exist under `FIMSERV_ROOT`:

```
<FIMSERV_ROOT>/output/flood_<HUC8>/<HUC8>/branch_ids.csv
<FIMSERV_ROOT>/output/flood_<HUC8>/<HUC8>/hydrotable.csv
```

Default `FIMSERV_ROOT` is `/var/tmp/fimserve_viewer` (platform temp dir on
Windows); override it with the `FIMSERV_ROOT` env var. The portal terminal
prints the resolved path at first use.

---

## External dependencies (no secrets required)

| Pipeline step | Data source | Authentication |
|---------------|-------------|----------------|
| Step 1 - HAND bundle | `s3://ciroh-owp-hand-fim/...` | None (public, `--no-sign-request`) |
| Step 2 - NWM streamflow | NOAA NWM retrospective via **teehr** | None (public AWS Open Data) |

---

## If something still fails

Please capture and share:

1. Output of `python --version` and `aws --version`
2. Output of `git log -1 --oneline`
3. Terminal output from **Step 1** when clicking Generate Flood Map (especially any `aws` or S3 errors)
4. OS (macOS / Linux / Windows) and conda env name

Additional detail: **RUNBOOK.md** and **README.md → Troubleshooting** in the repository.

---

## Contact

For deployment issues on this repository, open a GitHub issue or contact the repository maintainer.
