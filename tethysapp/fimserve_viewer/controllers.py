"""
controllers.py — Tethys controllers for the FIMserve Viewer.

These are direct ports of the Flask routes in the original `server.py`. Each
controller is a thin wrapper that:

  1. Gates the HTTP method (Tethys's @controller decorator has no `methods` kwarg).
  2. Parses the request body / query params.
  3. Delegates the heavy lifting to a helper in `fim_logic.py`.
  4. Wraps the result in the appropriate Django response type.

URL prefix: every URL below is automatically prefixed with
`/apps/fimserve-viewer/` by Tethys (controlled by `app.py`'s `root_url`).
"""

import json
import os
import traceback
from pathlib import Path

from django.http import (
    FileResponse,
    HttpResponse,
    HttpResponseNotAllowed,
    JsonResponse,
)
from django.views.decorators.csrf import csrf_exempt
from tethys_sdk.routing import controller

from . import fim_logic
from .app import App
from .results import (
    custom_download_name,
    labels_name_for_tif,
    nwm_pattern,
    results,
)


def find_custom_map_key(huc8, discharge_val):
    """Key of the stored custom map for exactly this discharge, else None."""
    return results.find_custom(huc8, discharge_val)


def no_custom_map_response(huc8, discharge_str):
    """404 for a custom discharge with no result, naming what is available."""
    available = results.custom_discharges(huc8)
    listed = ", ".join(f"{v:g}" for v in available) if available else "none"
    return JsonResponse(
        {
            "status": "error",
            "message": (
                f"No custom flood map found for HUC8 {huc8} with discharge "
                f"{discharge_str}. Available discharges for this HUC8: {listed}."
            ),
            "available_discharges": available,
        },
        status=404,
    )


def reclassified_response(key, download_name):
    """Stream a stored tif reclassified to 0/1."""
    with results.local(key) as map_file:
        tmp_path = fim_logic.reclassify_temp_copy(map_file)
    tmp_handle = open(tmp_path, "rb")
    os.unlink(tmp_path)
    return FileResponse(
        tmp_handle,
        content_type="image/tiff",
        as_attachment=True,
        filename=download_name,
    )


# =============================================================================
# Home page
# =============================================================================
@controller
def home(request):
    """
    Render the Leaflet UI (templates/fimserve_viewer/home.html).

    Tethys' App.render() prepends the app package name automatically — pass
    'home.html', NOT 'fimserve_viewer/home.html'.
    """
    return App.render(request, "home.html", {})


# =============================================================================
# /api/all-huc8-geojson  (serves the bundled HUC8 polygons GeoJSON to the browser)
#
# The Flask app served `data/all_huc8.geojson` as a static file directly from
# the `website/` directory. In the Tethys port the file lives under the app
# package's `resources/` directory (where Python also reads it from for the
# server-side HUC8 boundary fallback). A small controller exposes that single
# file to the browser so we don't need to duplicate the 57 MB GeoJSON into
# `public/data/`.
# =============================================================================
def bundled_resource_response(filename, content_type):
    """Serve a file from the app package's resources/ with long-lived caching."""
    resource_path = Path(__file__).resolve().parent / "resources" / filename
    if not resource_path.is_file():
        return JsonResponse(
            {
                "status": "error",
                "message": f"{filename} is missing from app resources/.",
            },
            status=500,
        )
    response = FileResponse(open(resource_path, "rb"), content_type=content_type)
    response["Cache-Control"] = "public, max-age=86400, immutable"
    return response


@controller(url="api/all-huc8-geojson")
@csrf_exempt
def all_huc8_geojson(request):
    """Serve the full-resolution HUC8 polygons GeoJSON."""
    return bundled_resource_response("all_huc8.geojson", "application/geo+json")


@controller(url="api/all-huc8-topojson")
@csrf_exempt
def all_huc8_topojson(request):
    """Serve the simplified HUC8 topology used by the Leaflet map."""
    return bundled_resource_response("all_huc8.topojson", "application/json")


@controller(url="api/fim-coverage")
@csrf_exempt
def fim_coverage(request):
    """Serve the set of HUC8s that have HAND-FIM data available."""
    return bundled_resource_response("fim_coverage.json", "application/json")


# =============================================================================
# /api/health
# =============================================================================
@controller(url="api/health")
@csrf_exempt
def health(request):
    """Health check. The fact that this controller responds at all proves
    FIMserv was importable at module load (otherwise fim_logic would have
    failed to import and the whole app would have failed to load)."""
    return JsonResponse(
        {
            "status": "ok",
            "fimserv_available": True,
        }
    )


# =============================================================================
# /api/generate-flood-map  (full pipeline, single POST)
# =============================================================================
@controller(url="api/generate-flood-map")
@csrf_exempt
def generate_flood_map(request):
    """Run the full download → streamflow → inundation pipeline."""
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse(
            {"status": "error", "message": "Invalid JSON body"}, status=400
        )

    try:
        huc8, datetime_str = fim_logic._parse_generate_flood_json_body(body)
    except ValueError as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=400)

    try:
        print(f"Generating flood map for HUC8: {huc8}, DateTime: {datetime_str}")
        print("Step 1: Downloading HUC8 data...")
        fim_logic._run_flood_step1_download_huc8(huc8)
        print("Step 2: Getting NWM streamflow data...")
        fim_logic._run_flood_step2_nwm_streamflow(huc8, datetime_str)
        print("Step 3: Generating flood inundation map...")
        fim_logic._run_flood_step3_hand_inundation(huc8, datetime_str)

        map_file, miss_msg = fim_logic._locate_generated_inundation_tif(
            huc8, datetime_str
        )
        if map_file is None:
            return JsonResponse(
                {"status": "error", "message": miss_msg}, status=500
            )

        key = results.store(map_file, huc8)
        return JsonResponse(
            {
                "status": "success",
                "message": "Flood inundation map generated successfully",
                "huc8": huc8,
                "datetime": datetime_str,
                "file_path": key,
                "file_name": Path(key).name,
            }
        )
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse(
            {"status": "error", "message": f"Error generating flood map: {exc}"},
            status=500,
        )


# =============================================================================
# /api/generate-flood-map/step/{1|2|3}
# =============================================================================
@controller(url="api/generate-flood-map/step/{step}", regex=r"\d+")
@csrf_exempt
def generate_flood_map_step(request, step):
    """Run one phase of the pipeline (1: download, 2: NWM streamflow, 3: HAND)."""
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])

    try:
        step = int(step)
    except ValueError:
        return JsonResponse(
            {"status": "error", "message": "step must be an integer"}, status=400
        )
    if step not in (1, 2, 3):
        return JsonResponse(
            {"status": "error", "message": "step must be 1, 2, or 3"}, status=400
        )

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse(
            {"status": "error", "message": "Invalid JSON body"}, status=400
        )

    try:
        huc8, datetime_str = fim_logic._parse_generate_flood_json_body(body)
    except ValueError as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=400)

    try:
        if step == 1:
            print("Step 1: Downloading HUC8 data...")
            fim_logic._run_flood_step1_download_huc8(huc8)
            return JsonResponse(
                {"status": "success", "step": 1, "message": "HUC8 data downloaded."}
            )
        if step == 2:
            print("Step 2: Getting NWM streamflow data...")
            fim_logic._run_flood_step2_nwm_streamflow(huc8, datetime_str)
            return JsonResponse(
                {
                    "status": "success",
                    "step": 2,
                    "message": "NWM streamflow data retrieved.",
                }
            )
        # step == 3
        print("Step 3: Generating flood inundation map...")
        fim_logic._run_flood_step3_hand_inundation(huc8, datetime_str)
        map_file, miss_msg = fim_logic._locate_generated_inundation_tif(
            huc8, datetime_str
        )
        if map_file is None:
            return JsonResponse(
                {"status": "error", "message": miss_msg}, status=500
            )
        key = results.store(map_file, huc8)
        return JsonResponse(
            {
                "status": "success",
                "step": 3,
                "message": "Flood inundation map generated successfully",
                "huc8": huc8,
                "datetime": datetime_str,
                "file_path": key,
                "file_name": Path(key).name,
            }
        )
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse(
            {"status": "error", "message": f"Error in step {step}: {exc}"},
            status=500,
        )


# =============================================================================
# /api/generate-flood-map-custom
# =============================================================================
@controller(url="api/generate-flood-map-custom")
@csrf_exempt
def generate_flood_map_custom(request):
    """Generate flood map using a single user-supplied discharge value (m³/s)."""
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])

    try:
        data = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse(
            {"status": "error", "message": "Invalid JSON body"}, status=400
        )

    huc8 = data.get("huc8")
    discharge_val = data.get("discharge")

    if not huc8:
        return JsonResponse(
            {"status": "error", "message": "Missing huc8"}, status=400
        )
    try:
        discharge_val = float(discharge_val)
    except (TypeError, ValueError):
        return JsonResponse(
            {"status": "error", "message": "discharge must be a number (m³/s)"},
            status=400,
        )
    if discharge_val < 0:
        return JsonResponse(
            {"status": "error", "message": "discharge must be non-negative"},
            status=400,
        )

    print(
        f"Generating custom discharge flood map for HUC8: {huc8}, "
        f"discharge: {discharge_val} m³/s"
    )

    try:
        map_file = fim_logic.run_custom_discharge_flood_map(huc8, discharge_val)
        key = results.store(map_file, huc8)
        return JsonResponse(
            {
                "status": "success",
                "message": "Custom discharge flood map generated successfully",
                "huc8": huc8,
                "discharge": discharge_val,
                "file_path": key,
                "file_name": Path(key).name,
            }
        )
    except FileNotFoundError as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)


# =============================================================================
# /api/flood-map-preview/nwm/{huc8}/{date_str}
# =============================================================================
@controller(url="api/flood-map-preview/nwm/{huc8}/{date_str}")
@csrf_exempt
def flood_map_preview_nwm(request, huc8, date_str):
    """Return PNG preview + bounds for an NWM flood map (for Leaflet display)."""
    try:
        key = results.find(huc8, nwm_pattern(huc8, date_str))
        if key is None:
            return JsonResponse(
                {
                    "status": "error",
                    "message": f"No flood map found for HUC8 {huc8} on {date_str}",
                },
                status=404,
            )

        with results.local(key) as map_file:
            out = fim_logic._tif_to_preview_png(map_file, huc8=huc8)
        return JsonResponse(
            {
                "status": "success",
                "image": f"data:image/png;base64,{out['png_b64']}",
                "bounds": out["bounds"],
                "mercator": out["mercator"],
            }
        )
    except Exception as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )


# =============================================================================
# /api/flood-q-labels/nwm/{huc8}/{date_str}
# =============================================================================
@controller(url="api/flood-q-labels/nwm/{huc8}/{date_str}")
@csrf_exempt
def flood_q_labels_nwm(request, huc8, date_str):
    """GeoJSON points with discharge_m3s for each NWM reach (map labels).

    Prefers the labels artifact stored beside the result at generation time
    (readable from any replica); falls back to computing from local files.
    """
    try:
        geojson_str = stored_nwm_labels(huc8, date_str)
        if geojson_str is None:
            geojson_str = fim_logic.build_flood_q_labels(huc8, date_str)
        if geojson_str is None:
            return HttpResponse(
                json.dumps(fim_logic._empty_feature_collection()),
                content_type="application/geo+json",
            )
        return HttpResponse(geojson_str, content_type="application/geo+json")
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )


def stored_nwm_labels(huc8, date_str):
    """Return the stored labels GeoJSON for a HUC8 + date, or None."""
    tif_key = results.find(huc8, nwm_pattern(huc8, date_str))
    if tif_key is None:
        return None
    return results.text(labels_name_for_tif(tif_key))


# =============================================================================
# /api/flood-map-preview/custom/{huc8}/{discharge_str}
# =============================================================================
@controller(url="api/flood-map-preview/custom/{huc8}/{discharge_str}")
@csrf_exempt
def flood_map_preview_custom(request, huc8, discharge_str):
    """Return PNG preview + bounds for a custom-discharge flood map."""
    try:
        discharge_val = float(discharge_str)
        key = find_custom_map_key(huc8, discharge_val)
        if key is None:
            return no_custom_map_response(huc8, discharge_str)

        with results.local(key) as map_file:
            out = fim_logic._tif_to_preview_png(map_file, huc8=huc8)
        return JsonResponse(
            {
                "status": "success",
                "image": f"data:image/png;base64,{out['png_b64']}",
                "bounds": out["bounds"],
                "mercator": out["mercator"],
            }
        )
    except Exception as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )


# =============================================================================
# /api/get-flood-map/{huc8}/{date_str}  (?reclass=1)
# =============================================================================
@controller(url="api/get-flood-map/{huc8}/{date_str}")
@csrf_exempt
def get_flood_map(request, huc8, date_str):
    """Download a generated NWM flood map .tif (optionally reclassified to 0/1)."""
    do_reclass = request.GET.get("reclass", "0") == "1"

    try:
        key = results.find(huc8, nwm_pattern(huc8, date_str))
        if key is None:
            return JsonResponse(
                {
                    "status": "error",
                    "message": f"No flood map found for HUC8 {huc8} on {date_str}",
                },
                status=404,
            )

        if do_reclass:
            return reclassified_response(key, f"{Path(key).stem}_reclassified.tif")
        return results.response(key)
    except Exception as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )


# =============================================================================
# /api/get-flood-map-custom/{huc8}/{discharge_str}  (?reclass=1)
# =============================================================================
@controller(url="api/get-flood-map-custom/{huc8}/{discharge_str}")
@csrf_exempt
def get_flood_map_custom(request, huc8, discharge_str):
    """Download a custom-discharge flood map .tif (optionally reclassified)."""
    do_reclass = request.GET.get("reclass", "0") == "1"

    try:
        discharge_val = float(discharge_str)
    except ValueError:
        return JsonResponse(
            {"status": "error", "message": "Invalid discharge value"}, status=400
        )

    try:
        key = find_custom_map_key(huc8, discharge_val)
        if key is None:
            return no_custom_map_response(huc8, discharge_str)

        # The download is named after the discharge the stored raster was
        # computed from, not the one that was requested, so the filename can
        # never assert a discharge the pixels did not come from.
        if do_reclass:
            return reclassified_response(
                key, custom_download_name(huc8, key, "_reclassified")
            )
        return results.response(key, download_name=custom_download_name(huc8, key))
    except Exception as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )


# =============================================================================
# /api/get-hydrograph/{huc8}/{date_str}
# =============================================================================
@controller(url="api/get-hydrograph/{huc8}/{date_str}")
@csrf_exempt
def get_hydrograph(request, huc8, date_str):
    """Return hydrograph (times, values) for the given HUC8 + date."""
    try:
        payload = fim_logic.build_hydrograph_payload(huc8, date_str)
        return JsonResponse(payload)
    except FileNotFoundError as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=404
        )
    except RuntimeError as exc:
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse(
            {"status": "error", "message": str(exc)}, status=500
        )
