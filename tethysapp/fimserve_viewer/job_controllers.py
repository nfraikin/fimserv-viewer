"""HTTP endpoints for background flood-map generation jobs.

Submission endpoints return immediately with a job id; the UI polls the
status endpoint and can rediscover an in-flight job for a HUC after a
page refresh.
"""

import json
from typing import Optional, Tuple

from django.http import HttpRequest, HttpResponse, HttpResponseNotAllowed, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from tethys_sdk.routing import controller

from . import forecast, pipelines
from .fim_logic import _parse_generate_flood_json_body
from .jobs import get_job_manager
from .model import JobKind


def json_body(request: HttpRequest) -> dict:
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid JSON body") from exc


def error_response(message: str, status: int = 400) -> JsonResponse:
    return JsonResponse({"status": "error", "message": message}, status=status)


def job_payload(job: dict) -> dict:
    payload = dict(job)
    payload["job_id"] = payload.pop("id")
    return payload


def job_response(job: dict, created: bool) -> JsonResponse:
    return JsonResponse(
        {"status": "success", "created": created, "job": job_payload(job)},
        status=202 if created else 200,
    )


def parse_custom_discharge_body(data: dict) -> Tuple[str, float]:
    """Return (huc8, discharge) from a POST body, raising ValueError when invalid."""
    huc8 = data.get("huc8")
    if not huc8:
        raise ValueError("Missing huc8")
    try:
        discharge = float(data.get("discharge"))
    except (TypeError, ValueError) as exc:
        raise ValueError("discharge must be a number (m³/s)") from exc
    if discharge < 0:
        raise ValueError("discharge must be non-negative")
    return str(huc8), discharge


def parse_forecast_body(data: dict) -> Tuple[str, str, str]:
    """Return (huc8, cycle_token, valid_token) from a POST body, raising ValueError when invalid.

    The request names a cycle and a *valid* hour; the forecast hour is
    derived from the two, never sent, so it cannot disagree with them.
    """
    huc8 = str(data.get("huc8") or "")
    if not huc8.isdigit() or len(huc8) != 8:
        raise ValueError("huc8 must be an 8-digit code")
    cycle_token = str(data.get("cycle") or "")
    valid_token = str(data.get("valid") or "")
    forecast.validate_forecast_request(cycle_token, valid_token)
    return huc8, cycle_token, valid_token


def require_post(request: HttpRequest) -> Optional[HttpResponse]:
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    return None


@controller(url="api/jobs/generate-flood-map")
@csrf_exempt
def submit_nwm_job(request):
    """Queue the NWM download/streamflow/inundation pipeline for a HUC8 and date."""
    not_post = require_post(request)
    if not_post is not None:
        return not_post
    try:
        huc8, datetime_str = _parse_generate_flood_json_body(json_body(request))
    except ValueError as exc:
        return error_response(str(exc))
    job, created = get_job_manager().submit(
        kind=JobKind.NWM,
        huc8=huc8,
        key=pipelines.nwm_job_key(huc8, datetime_str),
        params={"datetime_str": datetime_str},
        runner=pipelines.run_nwm_pipeline,
    )
    return job_response(job, created)


@controller(url="api/jobs/generate-flood-map-custom")
@csrf_exempt
def submit_custom_job(request):
    """Queue a custom-discharge inundation run for a HUC8."""
    not_post = require_post(request)
    if not_post is not None:
        return not_post
    try:
        huc8, discharge = parse_custom_discharge_body(json_body(request))
    except ValueError as exc:
        return error_response(str(exc))
    job, created = get_job_manager().submit(
        kind=JobKind.CUSTOM,
        huc8=huc8,
        key=pipelines.custom_job_key(huc8, discharge),
        params={"discharge": discharge},
        runner=pipelines.run_custom_pipeline,
    )
    return job_response(job, created)


@controller(url="api/jobs/generate-flood-map-forecast")
@csrf_exempt
def submit_forecast_job(request):
    """Queue a flood map for one NWM short-range forecast hour of a HUC8."""
    not_post = require_post(request)
    if not_post is not None:
        return not_post
    try:
        huc8, cycle_token, valid_token = parse_forecast_body(json_body(request))
    except ValueError as exc:
        return error_response(str(exc))
    cycle = forecast.parse_token(cycle_token)
    fhour = forecast.forecast_hour(cycle, forecast.parse_token(valid_token))
    try:
        published = forecast.is_published(cycle, fhour)
    except Exception as exc:
        return error_response(f"Could not reach the NWM forecast bucket: {exc}", status=502)
    if not published:
        return error_response(
            f"Cycle {cycle:%Y-%m-%d %H}z f{fhour:03d} is not published. "
            "Refresh the forecast hours and try again."
        )
    job, created = get_job_manager().submit(
        kind=JobKind.FORECAST,
        huc8=huc8,
        key=pipelines.forecast_job_key(huc8, cycle_token, valid_token),
        params={"cycle": cycle_token, "valid": valid_token, "forecast_hour": fhour},
        runner=pipelines.run_forecast_pipeline,
    )
    return job_response(job, created)


@controller(url="api/jobs/active")
@csrf_exempt
def active_job(request):
    """Return the active job for a HUC8 (?huc8=...), or job: null when idle."""
    huc8 = request.GET.get("huc8")
    if not huc8:
        return error_response("Missing huc8 query parameter")
    job = get_job_manager().active_for_huc(huc8)
    return JsonResponse({"status": "success", "job": job_payload(job) if job else None})


@controller(url="api/jobs/status/{job_id}")
@csrf_exempt
def job_status(request, job_id):
    """Return the current state of one job."""
    job = get_job_manager().get(job_id)
    if job is None:
        return error_response(f"No job found with id {job_id}", status=404)
    return JsonResponse({"status": "success", "job": job_payload(job)})
