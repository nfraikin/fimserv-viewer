"""Synthetic per-HUC hydrofabric files for tests.

Writes the two files the outlet logic reads, in EPSG:5070 like FIMserv's:
``nwm_subset_streams.gpkg`` (reaches with ``ID``, ``to``, ``Length``,
``Lake``; lines drawn upstream to downstream, as NWM's are) and ``wbd.gpkg``
(the HUC boundary). Without a ``wbd.gpkg`` the app falls back to the bundled
all-HUC8 GeoJSON, whose real boundaries would not contain these lines.
"""

NO_LAKE = -9999


def write_hydrofabric(huc_dir, reaches, huc_box=None):
    """Write the streams and boundary into ``huc_dir``.

    ``reaches`` holds ``(ID, to, coords)`` or ``(ID, to, coords, lake)``
    tuples; ``Length`` is the line's length. ``huc_box`` is the boundary as
    ``(minx, miny, maxx, maxy)``; by default it encloses every reach.
    """
    import geopandas as gpd
    from shapely.geometry import LineString, box

    huc_dir.mkdir(parents=True, exist_ok=True)
    lines = [LineString(r[2]) for r in reaches]
    streams = gpd.GeoDataFrame(
        {
            "ID": [r[0] for r in reaches],
            "to": [r[1] for r in reaches],
            "Length": [line.length for line in lines],
            "Lake": [r[3] if len(r) > 3 else NO_LAKE for r in reaches],
        },
        geometry=lines,
        crs=5070,
    )
    streams.to_file(huc_dir / "nwm_subset_streams.gpkg", driver="GPKG")
    if huc_box is None:
        huc_box = tuple(streams.total_bounds + [-1, -1, 1, 1])
    gpd.GeoDataFrame(geometry=[box(*huc_box)], crs=5070).to_file(
        huc_dir / "wbd.gpkg", driver="GPKG"
    )
