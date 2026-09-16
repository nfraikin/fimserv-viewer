# FIMserve Viewer - Clean-environment runbook

Use this checklist when installing from a **fresh git clone** on a machine that has
never run the app before. It addresses the two most common first-install failures
(Python version mismatch and missing AWS CLI).

## Prerequisites

- Miniforge or conda with **mamba**
- **Git**
- ~5 GB free disk, stable internet
- macOS, Linux, or Windows 10/11

## 1. Create the Tethys environment (Python pin is mandatory)

```bash
mamba create -n tethys-fimserve -c conda-forge \
  "tethys-platform>=4.0" "postgresql" "python>=3.10,<3.13"
conda activate tethys-fimserve
python --version
```

Expected: `Python 3.10.x`, `3.11.x`, or `3.12.x`. **Do not use 3.13.**

## 2. One-time portal database setup

```bash
tethys gen portal_config
tethys db init
tethys db start
tethys db configure
```

## 3. Clone and install the app

```bash
git clone https://github.com/tasfia26/tethysapp-fimserve_viewer.git
cd tethysapp-fimserve_viewer
tethys install -d
```

All runtime dependencies (scientific stack, **awscli**, teehr, and FIMserv
pinned to a git ref) are declared in `pyproject.toml`; Tethys installs the
app with `pip install -e .`, which resolves them. Nothing is installed via
conda. First install downloads several GB (pyspark, jupyter stack); if `/tmp`
is a small tmpfs, run with `TMPDIR=~/.cache/piptmp tethys install -d`.

## 4. Post-install verification

```bash
python --version
aws --version
tethys list | grep fimserve
curl -s http://127.0.0.1:8001/apps/fimserve-viewer/api/health/   # after tethys start
```

If `aws --version` fails:

```bash
python -m pip install awscli    # normally comes in via pyproject.toml
```

## 5. Start portal and smoke-test

```bash
tethys start -p 127.0.0.1:8001
```

Browser: <http://127.0.0.1:8001/apps/fimserve-viewer/>

Test watershed: HUC8 `06010105`, date `2022-04-27`, time `12:00:00` → **Generate Flood Map**.

First run per HUC8: **5-15 minutes** (HAND download from S3). Watch the terminal for
Step 1/2/3 progress messages.

## 6. Confirm Step 1 wrote HAND data

After Step 1 completes, `FIMSERV_ROOT` should contain:

```
<FIMSERV_ROOT>/output/flood_<HUC8>/<HUC8>/branch_ids.csv
<FIMSERV_ROOT>/output/flood_<HUC8>/<HUC8>/hydrotable.csv
```

Default `FIMSERV_ROOT` is **`/var/tmp/fimserve_viewer`** (platform temp dir on
Windows). The portal terminal prints the resolved path at first use.

## Disk space management

A first-time HUC8 download is **~700-900 MB** of hydrofabric; the generated
flood-map tif is only ~2 MB. To keep a small server (e.g. a shared sandbox)
from filling up, the app caps the total hydrofabric footprint:

- `FIMSERVE_CACHE_MAX_GB` (default **3**) - before each new HUC download,
  the least-recently-used HUCs' heavy hydrofabric internals (`branches/`,
  `hydrotable.csv`, ...) are deleted until the total fits the cap. Generated
  tifs and the small sidecar files (boundary/streams gpkg) are always kept,
  so previews/labels/downloads of past maps keep working. An evicted HUC is
  re-downloaded automatically on its next request (`aws s3 sync` fetches
  only the missing files). Set to `0` to disable eviction.
- `FIMSERVE_CACHE_MIN_IDLE_MINUTES` (default **30**) - a HUC is never
  evicted while something is using it. Every HUC with an active job is
  protected outright (any replica), and this setting protects a HUC that was
  used recently but has no job record, such as one driven by the
  synchronous endpoints. Raise it if a generation can take longer than 30
  minutes on your hardware; `0` leaves only the active-job protection.
- `FIMSERV_ROOT` - where all FIMserv data lives. **Optional**: defaults to
  `/var/tmp/fimserve_viewer` (disk-backed, survives reboots, OS may age out
  stale files - fine, everything here is a re-downloadable cache), or the
  platform temp dir on Windows. Export `FIMSERV_ROOT` to point it anywhere
  else (bigger disk, shared storage). Never point it at `/tmp` if that is
  tmpfs - tmpfs is RAM (check with `findmnt /tmp`).

**Budget rule of thumb:** allow `FIMSERVE_CACHE_MAX_GB` + ~1.5 GB headroom
per concurrent first-time generation. With the defaults, ~5 GB free is safe.

Eviction never deletes a hydrofabric that is in use, so the cap can be
exceeded when several generations run at once. The portal log says so
("still N GiB, over its N GiB cap: everything else is in use") along with
which HUCs it considered and which it protected - that line means the cap is
too low for the concurrency, not that eviction is broken.

## External data (no credentials)

| Step | Source | Auth |
|------|--------|------|
| 1 - HAND bundle | `s3://ciroh-owp-hand-fim/...` | Public (`--no-sign-request`) |
| 2 - NWM retrospective | AWS Open Data via **teehr** | Public |

## If install already failed once

1. Remove the broken conda env and recreate with the Python pin (Section 1).
2. Ensure `awscli` is present (`aws --version`).
3. Re-run `tethys install -d` from the repo root.
4. Restart `tethys start` after any change to Python code.

See also **Troubleshooting** in [README.md](README.md).
