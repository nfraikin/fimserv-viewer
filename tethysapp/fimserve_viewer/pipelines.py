"""Flood-map generation pipelines executed by the background job manager.

Each runner receives the job record and a ``progress(status, message)``
callback, performs the full generation, and returns the produced tif path.

Generation is where the expensive raster work belongs. A result is immutable
once produced, so both the COG rewrite and the map preview are done here,
once, rather than on every view.
"""

import json
import logging
from datetime import datetime
from typing import Callable

from . import fim_logic, forecast
from .model import JobKind, JobStatus
from .results import labels_name_for_tif, preview_name_for_tif, results

log = logging.getLogger(__name__)

Progress = Callable[[str, str], None]


def publish_nwm_labels(huc8: str, datetime_str: str, tif_name: str) -> None:
    """Compute and store the streamflow-labels GeoJSON beside a result tif.

    Runs on the generating pod while the local hydrofabric is present, so
    visualization can read the labels from storage on any replica.
    """
    label_date = datetime.strptime(datetime_str, "%Y-%m-%d %H:%M:%S").strftime(
        "%Y-%m-%d-%H-%M-%S"
    )
    labels_json = fim_logic.build_flood_q_labels(huc8, label_date)
    if labels_json:
        results.store_text(labels_json, huc8, labels_name_for_tif(tif_name))


def publish_preview(huc8: str, tif_name: str, map_file) -> None:
    """Render the map preview once and store it beside the result tif.

    Warping to Web Mercator and encoding the PNG is the dominant cost of
    displaying a map. The inputs are fixed once the raster exists, so doing
    it here turns every later view into a small object fetch and keeps the
    memory-hungry warp out of request-serving replicas.
    """
    payload = fim_logic.build_preview_payload(map_file, huc8=huc8)
    results.store_text(json.dumps(payload), huc8, preview_name_for_tif(tif_name))


def finalize_result(huc8: str, map_file, tif_name: str) -> None:
    """Best-effort COG rewrite and preview publication for a fresh result.

    Neither step may cost the caller its map: the raster is the product, and
    both of these are optimizations that the view path can still do itself.
    """
    try:
        fim_logic.to_cog(map_file)
    except Exception:
        log.warning("COG rewrite failed for %s; storing as produced", tif_name, exc_info=True)
    try:
        publish_preview(huc8, tif_name, map_file)
    except Exception:
        log.warning("Preview publish failed for %s; view will render it", tif_name, exc_info=True)


def nwm_job_key(huc8: str, datetime_str: str) -> str:
    return f"{JobKind.NWM}:{huc8}:{datetime_str}"


def custom_job_key(huc8: str, discharge: float) -> str:
    return f"{JobKind.CUSTOM}:{huc8}:{discharge}"


def forecast_job_key(huc8: str, cycle_token: str, valid_token: str) -> str:
    """Includes the cycle, so a newer cycle for the same hour is a new job."""
    return f"{JobKind.FORECAST}:{huc8}:{cycle_token}:{valid_token}"


def run_nwm_pipeline(job: dict, progress: Progress) -> str:
    huc8 = job["huc8"]
    datetime_str = job["params"]["datetime_str"]
    progress(JobStatus.STEP1, "Step 1/3: Downloading HUC8 hydrofabric...")
    fim_logic._run_flood_step1_download_huc8(huc8)
    progress(JobStatus.STEP2, "Step 2/3: Fetching NWM streamflow data...")
    fim_logic._run_flood_step2_nwm_streamflow(huc8, datetime_str)
    progress(JobStatus.STEP3, "Step 3/3: Computing flood inundation...")
    fim_logic._run_flood_step3_hand_inundation(huc8, datetime_str)
    map_file, missing_message = fim_logic._locate_generated_inundation_tif(huc8, datetime_str)
    if map_file is None:
        raise RuntimeError(missing_message)
    tif_name = map_file.name
    publish_nwm_labels(huc8, datetime_str, tif_name)
    finalize_result(huc8, map_file, tif_name)
    return results.store(map_file, huc8)


def run_custom_pipeline(job: dict, progress: Progress) -> str:
    progress(JobStatus.STEP3, "Computing flood inundation for custom discharge...")
    huc8 = job["huc8"]
    map_file = fim_logic.run_custom_discharge_flood_map(huc8, float(job["params"]["discharge"]))
    finalize_result(huc8, map_file, map_file.name)
    return results.store(map_file, huc8)


def publish_forecast_labels(huc8: str, csv_path, tif_name: str) -> None:
    """Store streamflow labels built from the forecast CSV beside the result tif."""
    labels_json = fim_logic.build_q_labels_from_csv(huc8, csv_path)
    if labels_json:
        results.store_text(labels_json, huc8, labels_name_for_tif(tif_name))


def run_forecast_pipeline(job: dict, progress: Progress) -> str:
    huc8 = job["huc8"]
    params = job["params"]
    cycle = forecast.parse_token(params["cycle"])
    valid = forecast.parse_token(params["valid"])
    fhour = forecast.forecast_hour(cycle, valid)
    progress(JobStatus.STEP1, "Step 1/3: Downloading HUC8 hydrofabric...")
    fim_logic._run_flood_step1_download_huc8(huc8)
    progress(
        JobStatus.STEP2,
        f"Step 2/3: Fetching NWM short-range forecast "
        f"(cycle {cycle:%H}z, f{fhour:03d}, valid {valid:%H:%M} UTC)...",
    )
    csv_path = forecast.write_discharge_csv(huc8, cycle, valid)
    # The CSV is only an input to this run (labels are published from it
    # below), and forecasts are generated far more often than retrospective
    # maps, so it is not left behind to accumulate.
    try:
        progress(JobStatus.STEP3, "Step 3/3: Computing flood inundation...")
        map_file = forecast.run_inundation(huc8, csv_path)
        tif_name = map_file.name
        publish_forecast_labels(huc8, csv_path, tif_name)
    finally:
        csv_path.unlink(missing_ok=True)
    finalize_result(huc8, map_file, tif_name)
    return results.store(map_file, huc8)
