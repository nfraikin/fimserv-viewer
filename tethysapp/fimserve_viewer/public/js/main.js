// zoomAnimation off: custom flood homography (matrix3d) cannot stay glued to tiles during
// Leaflet's CSS zoom transition; instant zoom keeps geography and overlay in sync.
const map = L.map('map', {
    zoomAnimation: false,
    markerZoomAnimation: false,
}).setView([39.8283, -98.5795], 4);

// Add OpenStreetMap basemap
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

// Create a high z-index pane for flood overlay so it appears above HUC8 polygons
if (!map.getPane('floodOverlayPane')) {
    map.createPane('floodOverlayPane');
    var floodPane = map.getPane('floodOverlayPane');
    floodPane.style.zIndex = 650;
}
if (!map.getPane('floodLabelsPane')) {
    map.createPane('floodLabelsPane');
    const fp = map.getPane('floodLabelsPane');
    /* Well above flood overlay (650) and default marker/tooltip panes so numbers sit on the blue flood. */
    fp.style.zIndex = 820;
    fp.style.overflow = 'visible';
}
if (!map.getPane('hydroOutletPane')) {
    map.createPane('hydroOutletPane');
    /* Above the flood raster (650) so the reach shows on top of the blue, below
       the discharge labels (820) so it never hides a number. */
    map.getPane('hydroOutletPane').style.zIndex = 700;
}

/**
 * Solve 8×8 linear system (partial pivot). Returns null if singular.
 */
function floodSolveLinear8(A, b) {
    var n = 8;
    var M = [];
    for (var i = 0; i < n; i++) {
        M[i] = A[i].slice();
        M[i][n] = b[i];
    }
    for (var col = 0; col < n; col++) {
        var piv = col;
        var best = Math.abs(M[col][col]);
        for (var r = col + 1; r < n; r++) {
            var v = Math.abs(M[r][col]);
            if (v > best) {
                best = v;
                piv = r;
            }
        }
        if (best < 1e-12) return null;
        if (piv !== col) {
            var tmp = M[col];
            M[col] = M[piv];
            M[piv] = tmp;
        }
        var div = M[col][col];
        for (var j = col; j <= n; j++) M[col][j] /= div;
        for (var r2 = 0; r2 < n; r2++) {
            if (r2 === col) continue;
            var f = M[r2][col];
            if (Math.abs(f) < 1e-15) continue;
            for (var j2 = col; j2 <= n; j2++) {
                M[r2][j2] -= f * M[col][j2];
            }
        }
    }
    var x = [];
    for (var i = 0; i < n; i++) x[i] = M[i][n];
    return x;
}

/**
 * Homography (h33=1) mapping image (u,v) to layer px (X,Y). Four point pairs.
 */
function floodHomographyFrom4Corners(uv4, xy4) {
    var A = [];
    var bv = [];
    for (var k = 0; k < 4; k++) {
        var u = uv4[k][0];
        var v = uv4[k][1];
        var X = xy4[k][0];
        var Y = xy4[k][1];
        A.push([u, v, 1, 0, 0, 0, -u * X, -v * X]);
        bv.push(X);
        A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y]);
        bv.push(Y);
    }
    var sol = floodSolveLinear8(A, bv);
    if (!sol) return null;
    return {
        h11: sol[0], h12: sol[1], h13: sol[2],
        h21: sol[3], h22: sol[4], h23: sol[5],
        h31: sol[6], h32: sol[7], h33: 1,
    };
}

/**
 * PNG warped to EPSG:3857 + rasterio affine. Corners go through CRS → lat/lng →
 * layer px, which is a general quad on screen — CSS matrix() is only affine
 * (parallelogram) and badly skews flood vs OSM. Use 4-point homography (matrix3d).
 */
var FloodMercatorImageLayer = L.Layer.extend({
    options: { opacity: 1, pane: 'overlayPane', className: '' },
    initialize: function (src, merc, opts) {
        L.setOptions(this, L.extend({}, this.options, opts));
        this._src = src;
        this._merc = merc;
        this._iw = merc.w;
        this._ih = merc.h;
    },
    onAdd: function (map) {
        this._map = map;
        var p = map.getPane(this.options.pane);
        this._img = L.DomUtil.create('img', this.options.className || '');
        this._img.src = this._src;
        this._img.style.position = 'absolute';
        this._img.style.pointerEvents = 'none';
        if (this.options.opacity != null) {
            this._img.style.opacity = String(this.options.opacity);
        }
        p.appendChild(this._img);
        map.on('viewreset zoom zoomend move moveend', this._upd, this);
        if (this._img.complete) {
            this._upd();
        } else {
            this._img.onload = L.bind(this._upd, this);
        }
    },
    onRemove: function (map) {
        map.off('viewreset zoom zoomend move moveend', this._upd, this);
        if (this._img) {
            L.DomUtil.remove(this._img);
            this._img = null;
        }
    },
    _mxy: function (col, row) {
        var m = this._merc;
        return [m.a * col + m.b * row + m.c, m.d * col + m.e * row + m.f];
    },
    _upd: function () {
        this._applyHomography();
    },
    _applyHomography: function () {
        var map = this._map;
        var img = this._img;
        if (!map || !img) return;
        var w = this._iw;
        var h = this._ih;
        if (!w || !h) return;
        if (!img.naturalWidth) return;
        img.style.width = w + 'px';
        img.style.height = h + 'px';
        var crs = map.options.crs;
        var self = this;
        function lp(col, row) {
            var xy = self._mxy(col, row);
            var ll = crs.unproject(L.point(xy[0], xy[1]));
            return map.latLngToLayerPoint(ll);
        }
        var p00 = lp(0, 0);
        var p10 = lp(w, 0);
        var p11 = lp(w, h);
        var p01 = lp(0, h);
        var uv = [[0, 0], [w, 0], [w, h], [0, h]];
        var xy = [[p00.x, p00.y], [p10.x, p10.y], [p11.x, p11.y], [p01.x, p01.y]];
        var H = floodHomographyFrom4Corners(uv, xy);
        L.DomUtil.setPosition(img, L.point(0, 0));
        img.style.transformOrigin = '0 0';
        if (H) {
            /* MDN column-major; maps (u,v,0,1) so x' = h11*u+h12*v+h13, w' = h31*u+h32*v+h33 */
            var t = 'matrix3d(' + [
                H.h11, H.h21, 0, H.h31,
                H.h12, H.h22, 0, H.h32,
                0, 0, 1, 0,
                H.h13, H.h23, 0, H.h33,
            ].join(',') + ')';
            img.style.transform = t;
        } else {
            /* Degenerate quad: fall back to affine from three corners */
            var a = (p10.x - p00.x) / w;
            var b = (p10.y - p00.y) / w;
            var c0 = (p01.x - p00.x) / h;
            var d0 = (p01.y - p00.y) / h;
            L.DomUtil.setPosition(img, p00);
            img.style.transform = 'matrix(' + [a, b, c0, d0, 0, 0].join(',') + ')';
        }
    },
});

// Store the GeoJSON layer
let huc8Layer = null;
let fimCoveredSet = null;

function isHuc8Covered(properties) {
    if (!fimCoveredSet) return true;
    return fimCoveredSet.has(getHUC8(properties));
}
// Flood map overlay (TIF preview on map)
let floodOverlayLayer = null;
let floodQLabelLayer = null;
let showFloodDischargeLabels = true;
/** When true, map discharge labels use ft³/s (cfs) converted from NWM m³/s. */
let showFloodDischargeInFt3s = false;
/** Last GeoJSON from /api/flood-q-labels so unit toggles can refresh labels without refetching. */
let lastFloodQLabelGeoJson = null;
/** Bumped when switching HUC, clearing flood, or starting a new Show-on-map — ignores stale async responses. */
let floodUIMapRequestSeq = 0;
let lastSidebarHuc8 = null;
/** Whether the watershed in the sidebar has HAND-FIM coverage (tabs need it after render). */
let lastSidebarCovered = false;
/** Which flood product produced the overlay on the map ('retro' | 'forecast'), or null. */
let floodOverlayMode = null;

/** Sidebar page: 'retro' (NWM retrospective) or 'forecast' (NWM short-range, issue #31).
 *  Remembered per browser so a forecast user isn't sent back to the archive every visit. */
const SIDEBAR_MODE_KEY = 'fimserve_viewer.sidebarMode';
let sidebarMode = (function () {
    try {
        return localStorage.getItem(SIDEBAR_MODE_KEY) === 'forecast' ? 'forecast' : 'retro';
    } catch (e) {
        return 'retro';   // storage blocked (private window, previews)
    }
})();

(function bindFloodLabelsToggle() {
    const cb = document.getElementById('flood-labels-toggle');
    if (!cb) return;
    cb.addEventListener('change', function () {
        showFloodDischargeLabels = cb.checked;
        syncFloodDischargeLabelsVisibility();
    });
})();

(function bindFloodUnitsCfsToggle() {
    const cb = document.getElementById('flood-units-cfs-toggle');
    if (!cb) return;
    cb.addEventListener('change', function () {
        showFloodDischargeInFt3s = cb.checked;
        updateFloodLegendDischargeBlurb();
        reapplyFloodQLabelMarkersFromCache();
        syncHydrographUnitButtons();
        rerenderHydrographs();
    });
})();

function syncFloodDischargeLabelsVisibility() {
    if (!floodQLabelLayer) return;
    if (showFloodDischargeLabels) {
        if (!map.hasLayer(floodQLabelLayer)) {
            floodQLabelLayer.addTo(map);
            if (typeof floodQLabelLayer.bringToFront === 'function') {
                floodQLabelLayer.bringToFront();
            }
        }
    } else if (map.hasLayer(floodQLabelLayer)) {
        map.removeLayer(floodQLabelLayer);
    }
}

// Function to format numbers
function formatNumber(num) {
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Function to display HUC8 details in sidebar
const NWM_MIN_DATE = '1979-02-01';
const NWM_MAX_DATE = '2023-01-31';

function nwmDateRangeError(date) {
    if (date >= NWM_MIN_DATE && date <= NWM_MAX_DATE) return '';
    return `Date must be between ${NWM_MIN_DATE} and ${NWM_MAX_DATE} (NWM retrospective coverage).`;
}

function displayHUC8Details(properties) {
    const sidebar = document.getElementById('sidebar');
    const content = document.getElementById('sidebar-content');
    const huc8Code = getHUC8(properties);
    const defaultDate = NWM_MAX_DATE;

    if (lastSidebarHuc8 != null && huc8Code !== lastSidebarHuc8) {
        clearFloodLayer();
    }
    lastSidebarHuc8 = huc8Code;
    clearHydrograph();
    forecastState.huc8 = null;   // the forecast page is rebuilt below, so its options are too

    sidebar.classList.add('open');

    // Tethys-served partner-logo URLs are injected from home.html into window.APP_STATIC.
    const APP_STATIC = (typeof window !== 'undefined' && window.APP_STATIC) ? window.APP_STATIC : {};
    const byuLogoUrl = APP_STATIC.byuLogo || '';
    const cirohLogoUrl = APP_STATIC.cirohLogo || '';
    const tgfLogoUrl = APP_STATIC.tgfLogo || '';

    const covered = isHuc8Covered(properties);
    lastSidebarCovered = covered;
    const noCoverageSection = `
            <div style="padding: 15px; background: #fdf0ed; border: 1px solid #f5c6b8; border-radius: 8px; margin-top: 10px;">
                <strong style="color: #c0392b;">No FIM coverage</strong>
                <p style="font-size: 12px; color: #7f8c8d; margin-top: 6px;">HAND-FIM data is not available for this HUC8, so a flood map cannot be generated here. Coverage is limited to the CONUS watersheds in the OWP HAND-FIM dataset.</p>
            </div>`;
    const generateSection = covered ? `
            <div style="padding: 15px; background: #f8f9fa; border-radius: 8px; margin-top: 10px;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 600; color: #555;">Date:</label>
                    <input type="date" id="flood-date-input" value="${defaultDate}" min="${NWM_MIN_DATE}" max="${NWM_MAX_DATE}" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;" />
                    <p style="font-size: 11px; color: #7f8c8d; margin-top: 4px;">NWM retrospective data: Feb 1979 &ndash; Jan 2023.</p>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 600; color: #555;">Time (HH:MM:SS):</label>
                    <input type="time" id="flood-time-input" step="1" value="00:00:00" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;" />
                    <p style="font-size: 11px; color: #7f8c8d; margin-top: 4px;">Model hour for the map. Note: 12:00:00 AM = midnight (00:00).</p>
                </div>
                <button id="generate-flood-map-btn" onclick="generateFloodMap('${huc8Code}')" style="width: 100%; padding: 12px; background: #27ae60; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s;">
                    Generate Flood Map
                </button>
                <button id="download-processed-btn" onclick="downloadProcessedFloodMap('${huc8Code}')" style="width: 100%; padding: 10px; background: #2980b9; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 10px; transition: background 0.2s;">
                    Download processed (reclassified)
                </button>
                <p style="font-size: 11px; color: #7f8c8d; margin-top: 6px;">Reclassifies: flooded &rarr; 1, no flood &rarr; 0.</p>
                <button id="show-on-map-nwm-btn" onclick="showFloodMapOnMapNwm('${huc8Code}')" style="width: 100%; padding: 10px; background: #3498db; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 10px; transition: background 0.2s;">Show on map</button>
                <div id="flood-map-status" style="margin-top: 10px; font-size: 12px; color: #7f8c8d;"></div>
            </div>` : noCoverageSection;

    // Sits beneath the generate controls. The endpoint needs feature_IDs.csv from a
    // completed run, so before one exists this explains that rather than going blank.
    const hydrographSection = covered ? `
        <div class="info-section">
            <h3>Hydrograph</h3>
            <div class="hydrograph-controls">
                <label class="hydrograph-ctl">Span
                    <select id="hydrograph-window" onchange="setHydrographWindow(this.value, '${huc8Code}')">
                        <option value="1"${hydroWindowDays === 1 ? ' selected' : ''}>&plusmn; 1 day</option>
                        <option value="3"${hydroWindowDays === 3 ? ' selected' : ''}>&plusmn; 3 days</option>
                        <option value="7"${hydroWindowDays === 7 ? ' selected' : ''}>&plusmn; 7 days</option>
                        <option value="14"${hydroWindowDays === 14 ? ' selected' : ''}>&plusmn; 14 days</option>
                        <option value="30"${hydroWindowDays === 30 ? ' selected' : ''}>&plusmn; 30 days</option>
                    </select>
                </label>
                <div class="hydrograph-units" role="group" aria-label="Discharge units">
                    <button type="button" id="hydro-unit-m3s" data-unit="m3s" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? '' : ' is-active'}" onclick="setHydrographUnits(false)">m&sup3;/s</button>
                    <button type="button" id="hydro-unit-cfs" data-unit="cfs" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? ' is-active' : ''}" onclick="setHydrographUnits(true)">ft&sup3;/s</button>
                </div>
            </div>
            <div id="hydrograph-panel" class="hydrograph-panel">
                <p class="hydrograph-note">Generate a flood map for this watershed first &mdash; the discharge series is read at the watershed's outlet reach, found from that run's stream network.</p>
            </div>
            <button id="hydrograph-load-btn" class="hydrograph-btn" onclick="loadHydrograph('${huc8Code}')">Show hydrograph</button>
        </div>` : '';

    content.innerHTML = `
        <div class="huc8-code">${getHUC8(properties)}</div>
        
        <div class="info-section">
            <h3>Basic Information</h3>
            <div class="info-item">
                <span class="info-label">Name:</span>
                <span class="info-value">${properties.name || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">States:</span>
                <span class="info-value">${properties.states || 'N/A'}</span>
            </div>
        </div>
        
        <div class="info-section">
            <h3>Area Information</h3>
            <div class="info-item">
                <span class="info-label">Area (km²):</span>
                <span class="info-value">${formatNumber(properties.areasqkm)}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Area (acres):</span>
                <span class="info-value">${formatNumber(properties.areaacres)}</span>
            </div>
        </div>
        
        <div class="info-section">
            <h3>Metadata</h3>
            <div class="info-item">
                <span class="info-label">Load Date:</span>
                <span class="info-value">${properties.loaddate ? new Date(properties.loaddate).toLocaleDateString() : 'N/A'}</span>
            </div>
        </div>
        
        <div class="mode-page" data-mode-page="retro"${sidebarMode === 'retro' ? '' : ' hidden'}>
            <div class="info-section">
                <h3>Generate Flood Map with NWM Data</h3>
                ${generateSection}
            </div>

            ${hydrographSection}
        </div>

        <div class="mode-page" data-mode-page="forecast"${sidebarMode === 'forecast' ? '' : ' hidden'}>
            ${covered
                ? forecastSectionHtml(huc8Code) + forecastHydrographSectionHtml(huc8Code)
                : `<div class="info-section"><h3>Forecast Flood Map</h3>${noCoverageSection}</div>`}
        </div>

        <div class="info-section">
            <div class="sidebar-attribution" aria-label="Partner organizations">
                <div class="sidebar-attribution-title">Authorization &amp; partners</div>
                <p class="sidebar-attribution-sub">This application is developed under the authorization of and in partnership with the following organizations.</p>
                <div class="sidebar-attribution-logos partners-panel">
                    <div class="partners-grid-2">
                        <div class="partners-cell" role="img" aria-label="Brigham Young University" title="Brigham Young University" style="background-image:url('${byuLogoUrl}')"></div>
                        <div class="partners-cell" role="img" aria-label="CIROH — Cooperative Institute for Research to Operations in Hydrology" title="CIROH" style="background-image:url('${cirohLogoUrl}')"></div>
                    </div>
                    <div class="partners-wide" role="img" aria-label="Tethys Geoscience Foundation" title="Tethys Geoscience Foundation" style="background-image:url('${tgfLogoUrl}')"></div>
                </div>
            </div>
        </div>
    `;
    if (covered) {
        reattachActiveFloodJob(huc8Code);
        if (sidebarMode === 'forecast') loadForecastOptions(huc8Code);
    }
}

// Function to close sidebar
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
}

// Function to get HUC8 code (handle both uppercase and lowercase)
function getHUC8(properties) {
    return String(properties?.HUC8 || properties?.huc8 || 'N/A');
}
// Get bounds for a HUC8 by code (ensures zoom stays within selected watershed)
function getBoundsForHUC8(huc8Code) {
    if (!huc8Layer) return null;
    const code = String(huc8Code);
    let found = null;
    huc8Layer.eachLayer(function(layer) {
        if (layer.feature && getHUC8(layer.feature.properties) === code) found = layer;
    });
    return found ? found.getBounds() : null;
}

// Function to create popup content
function createPopupContent(properties) {
    return `
        <div class="popup-title">HUC8: ${getHUC8(properties)}</div>
        <div class="popup-info"><strong>Name:</strong> ${properties.name || 'N/A'}</div>
        <div class="popup-info"><strong>States:</strong> ${properties.states || 'N/A'}</div>
        <div class="popup-info"><strong>Area:</strong> ${formatNumber(properties.areasqkm)} km²</div>
        <div class="popup-click popup-full-details" style="cursor: pointer; text-decoration: underline;" onclick="if(window._lastClickedHUC8){displayHUC8Details(window._lastClickedHUC8);}">Click for full details →</div>
    `;
}

// Function to style HUC8 polygons
function styleHUC8(feature) {
    if (!isHuc8Covered(feature.properties)) {
        return {
            fillColor: '#95a5a6',
            fillOpacity: 0.2,
            color: '#7f8c8d',
            weight: 1,
            opacity: 0.4
        };
    }
    return {
        fillColor: '#3498db',
        fillOpacity: 0.4,
        color: '#2980b9',
        weight: 2,
        opacity: 0.8
    };
}

// Track the currently selected HUC8 layer (stays highlighted until another is clicked)
let selectedLayer = null;
// Track last hovered layer so we can clear it when entering another (mouseout doesn't always fire)
let lastHoveredLayer = null;
const selectedStyle = {
    fillColor: '#e74c3c',
    fillOpacity: 0.12,
    color: '#c0392b',
    weight: 2,
    opacity: 0.7
};

// Function to highlight on hover (only for non-selected layers)
function highlightFeature(e) {
    const layer = e.target;
    if (layer === selectedLayer) return;  // Keep selected style
    // Clear any previously hovered layer first (fixes stuck highlights when mouseout doesn't fire)
    if (lastHoveredLayer && lastHoveredLayer !== selectedLayer) {
        huc8Layer.resetStyle(lastHoveredLayer);
    }
    lastHoveredLayer = layer;
    layer.setStyle({
        fillColor: '#e74c3c',
        fillOpacity: 0.12,
        color: '#c0392b',
        weight: 2,
        opacity: 0.7
    });
    layer.bringToFront();
}

// Function to reset highlight on mouseout
function resetHighlight(e) {
    const layer = e.target;
    if (layer === selectedLayer) {
        layer.setStyle(selectedStyle);  // Keep selected highlight
    } else {
        huc8Layer.resetStyle(layer);
    }
    if (lastHoveredLayer === layer) {
        lastHoveredLayer = null;
    }
}

// Function to handle click - select this HUC8 and keep it highlighted
function selectFeature(layer) {
    // Reset ALL layers to default first so only one stays highlighted
    huc8Layer.eachLayer(function(l) {
        huc8Layer.resetStyle(l);
    });
    selectedLayer = layer;
    layer.setStyle(selectedStyle);
    layer.bringToFront();
}

// Function to handle click
function onEachFeature(feature, layer) {
    // Add popup
    layer.bindPopup(createPopupContent(feature.properties));
    
    // Add hover and click effects
    layer.on({
        mouseover: highlightFeature,
        mouseout: resetHighlight,
        click: function(e) {
            L.DomEvent.stopPropagation(e);
            selectFeature(e.target);
            window._lastClickedHUC8 = feature.properties;
            displayHUC8Details(feature.properties);
            map.fitBounds(e.target.getBounds());
        }
    });
}

// Show loading message
const sidebarContent = document.getElementById('sidebar-content');
sidebarContent.innerHTML = `
    <div class="loading">
        <div class="loading-spinner"></div>
        <p><strong>Loading HUC8 data...</strong></p>
        <p style="font-size: 12px; color: #7f8c8d;">Loading 2,456 watersheds (57MB)</p>
        <p style="font-size: 11px; color: #95a5a6; margin-top: 10px;">Please wait, this may take 10-30 seconds</p>
    </div>
`;

// In Tethys, the JS, controllers, and templates are all served from the same
// origin. Use plain relative URLs — they resolve against the current page
// (`/apps/fimserve-viewer/`) into `/apps/fimserve-viewer/api/...`.
// No more API_BASE_URL / port-probing logic from the Flask deployment.
const APP_STATIC = (typeof window !== 'undefined' && window.APP_STATIC) ? window.APP_STATIC : {};
const HUC8_TOPOJSON_URL = APP_STATIC.huc8TopoJsonUrl || './api/all-huc8-topojson/';
const huc8Renderer = L.canvas({ padding: 0.5 });

function decodeHuc8Topology(topology) {
    return topojson.feature(topology, Object.values(topology.objects)[0]);
}

console.log('Starting to load HUC8 data...');
const FIM_COVERAGE_URL = APP_STATIC.fimCoverageUrl || './api/fim-coverage/';
fetch(FIM_COVERAGE_URL)
    .then(response => (response.ok ? response.json() : null))
    .then(coverage => {
        if (coverage && Array.isArray(coverage.hucs)) {
            fimCoveredSet = new Set(coverage.hucs.map(String));
            console.log(`FIM coverage loaded: ${fimCoveredSet.size} HUC8s`);
        }
    })
    .catch(() => console.warn('FIM coverage unavailable; treating all HUC8s as generatable'))
    .then(() => fetch(HUC8_TOPOJSON_URL))
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(decodeHuc8Topology)
    .then(data => {
        console.log(`HUC8 topology decoded. Features: ${data.features.length}`);

        huc8Layer = L.geoJSON(data, {
            style: styleHUC8,
            onEachFeature: onEachFeature,
            renderer: huc8Renderer
        }).addTo(map);
        
        console.log('Layer added to map, fitting bounds...');
        
        // Fit map to show all HUC8 polygons
        map.fitBounds(huc8Layer.getBounds());
        
        console.log(`✓ Successfully loaded ${data.features.length} HUC8 watersheds`);
        
        // When mouse leaves the map, clear any stuck hover highlights
        map.getContainer().addEventListener('mouseleave', function() {
            if (lastHoveredLayer && lastHoveredLayer !== selectedLayer) {
                huc8Layer.resetStyle(lastHoveredLayer);
                lastHoveredLayer = null;
            }
        });
        
        // Update sidebar with success message
        sidebarContent.innerHTML = `
            <div class="no-selection">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                <p><strong>${data.features.length} HUC8 watersheds loaded!</strong></p>
                <p style="font-size: 14px;">Click on any watershed to view details</p>
            </div>
        `;
    })
    .catch(error => {
        console.error('Error loading HUC8 data:', error);
        sidebarContent.innerHTML = `
            <div class="loading">
                <p style="color: #e74c3c;">Error loading HUC8 data</p>
                <p style="font-size: 12px;">${error.message}</p>
                <p style="font-size: 12px; margin-top: 10px;">Check browser console (F12) for details</p>
            </div>
        `;
    });

// Close sidebar when clicking outside (on map)
map.on('click', function() {
    // Small delay to allow click events on polygons to fire first
    setTimeout(() => {
        // Only close if no polygon was clicked
        if (!document.querySelector('.leaflet-popup')) {
            closeSidebar();
        }
    }, 100);
});

// Function to download processed (reclassified) flood map
async function downloadProcessedFloodMap(huc8) {
    const dateInput = document.getElementById('flood-date-input');
    const statusDiv = document.getElementById('flood-map-status');
    const date = dateInput ? dateInput.value : '';
    if (!date) {
        statusDiv.innerHTML = '<span style="color: #e74c3c;">Please select a date first</span>';
        return;
    }
    const dateStr = date;  // YYYY-MM-DD
    const url = './api/get-flood-map/' + encodeURIComponent(huc8) + '/' + dateStr + '/?reclass=1';
    await downloadReclassified(url, huc8 + '_' + dateStr + '_reclassified.tif', 'retro');
}

/** Fetch a reclassified tif and hand it to the browser, reporting on that page's status line. */
async function downloadReclassified(url, filename, mode) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const err = await response.json().catch(() => ({ message: response.statusText }));
            setFloodStatus('<span style="color: #e74c3c;">' + escapeHtml(err.message || 'Download failed') + '</span>', mode);
            return;
        }
        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        setFloodStatus('<span style="color: #27ae60;">✓ Processed map downloaded</span>', mode);
    } catch (error) {
        setFloodStatus('<span style="color: #e74c3c;">Error: ' + escapeHtml(error.message) + '</span>', mode);
    }
}

async function showFloodMapOnMapNwm(huc8) {
    const dateInput = document.getElementById('flood-date-input');
    const timeInput = document.getElementById('flood-time-input');
    const statusDiv = document.getElementById('flood-map-status');
    const date = dateInput ? dateInput.value : '';
    const time = timeInput ? (timeInput.value || '00:00:00') : '00:00:00';
    if (!date) {
        if (statusDiv) statusDiv.innerHTML = '<span style="color: #e74c3c;">Select a date first</span>';
        return;
    }
    const mySeq = ++floodUIMapRequestSeq;
    const dateStr = time === '00:00:00' ? date : date + '-' + time.replace(/:/g, '-');
    if (statusDiv) statusDiv.innerHTML = '<span style="color: #3498db;">Loading preview...</span>';
    try {
        const r = await fetch('./api/flood-map-preview/nwm/' + encodeURIComponent(huc8) + '/' + encodeURIComponent(dateStr) + '/');
        if (mySeq !== floodUIMapRequestSeq) return;
        const data = await r.json();
        if (mySeq !== floodUIMapRequestSeq) return;
        if (data.status !== 'success') {
            if (statusDiv && mySeq === floodUIMapRequestSeq) {
                statusDiv.innerHTML = '<span style="color: #e74c3c;">' + (data.message || 'Not found') + '</span>';
            }
            return;
        }
        if (mySeq !== floodUIMapRequestSeq) return;
        drawFloodPreview(huc8, data, 'retro', '');
        if (statusDiv && mySeq === floodUIMapRequestSeq) {
            statusDiv.innerHTML = '<span style="color: #27ae60;">✓ Flood map shown on map</span> <a href="#" onclick="clearFloodLayer(); document.getElementById(\'flood-map-status\').innerHTML=\'\'; return false;" style="font-size: 11px; margin-left: 6px;">Clear</a>';
        }
        await loadFloodQLabelsNwm(huc8, dateStr, mySeq);
    } catch (e) {
        if (statusDiv && mySeq === floodUIMapRequestSeq) {
            statusDiv.innerHTML = '<span style="color: #e74c3c;">Error: ' + e.message + '</span>';
        }
    }
}

/** Put a preview payload on the map and remember which product it came from. */
function drawFloodPreview(huc8, data, mode, legendSource) {
    if (floodOverlayLayer) map.removeLayer(floodOverlayLayer);
    var merc = data.mercator;
    if (merc && merc.w && merc.h && typeof merc.a === 'number') {
        floodOverlayLayer = new FloodMercatorImageLayer(data.image, merc, {
            opacity: 1,
            pane: 'floodOverlayPane',
            className: 'flood-raster-crisp leaflet-image-layer',
        }).addTo(map);
    } else {
        floodOverlayLayer = L.imageOverlay(data.image, data.bounds, {
            opacity: 1,
            pane: 'floodOverlayPane',
            className: 'flood-raster-crisp',
        }).addTo(map);
    }
    floodOverlayMode = mode;
    const hucBounds = getBoundsForHUC8(huc8);
    if (hucBounds) map.fitBounds(hucBounds, { maxZoom: 14, padding: [30, 30] });
    showFloodLegend(legendSource);
}

/** `source` captions what the overlay shows; forecasts must say so on the map itself. */
function showFloodLegend(source) {
    const el = document.getElementById('flood-legend');
    if (el) el.style.display = 'block';
    const src = document.getElementById('flood-legend-source');
    if (src) {
        src.textContent = source || '';
        src.hidden = !source;
    }
    const cb = document.getElementById('flood-labels-toggle');
    if (cb) cb.checked = showFloodDischargeLabels;
    const cfs = document.getElementById('flood-units-cfs-toggle');
    if (cfs) cfs.checked = showFloodDischargeInFt3s;
    updateFloodLegendDischargeBlurb();
}
function hideFloodLegend() {
    const el = document.getElementById('flood-legend');
    if (el) el.style.display = 'none';
}

function clearFloodQLabelLayer(opts) {
    var preserveGj = opts && opts.preserveGeoJson;
    if (floodQLabelLayer) {
        if (map.hasLayer(floodQLabelLayer)) {
            map.removeLayer(floodQLabelLayer);
        }
        floodQLabelLayer = null;
    }
    if (!preserveGj) {
        lastFloodQLabelGeoJson = null;
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** NWM uses m³/s; 1 m³/s = 35.314666721488 ft³/s (cfs). */
const M3S_TO_FT3S = 35.314666721488;
const MIN_DISCHARGE_LABEL_M3S = 0.5;
/** If |Q₁−Q₂| ≤ this (m³/s) and points are nearby, only the higher Q is labeled. */
const Q_CLOSE_RANGE_M3S = 0.5;
/** "Nearby" for grouping similar discharges (km). */
const DEDUP_Q_CLUSTER_MAX_KM = 2.5;

function dischargeLabelFromProps(p) {
    if (p.label && !showFloodDischargeInFt3s) {
        return p.label;
    }
    if (p.discharge_m3s == null) {
        return p.label ? String(p.label) : '—';
    }
    const x = Number(p.discharge_m3s);
    if (!Number.isFinite(x)) return '—';
    const v = showFloodDischargeInFt3s ? x * M3S_TO_FT3S : x;
    if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) {
        return String(parseFloat(v.toPrecision(3)));
    }
    return v.toFixed(2).replace(/\.?0+$/, '');
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
}

function filterFloodQLabelFeatures(gj) {
    if (!gj || !Array.isArray(gj.features)) return gj;
    gj.features = gj.features.filter(function (f) {
        const q = f.properties && f.properties.discharge_m3s;
        const n = q == null ? NaN : Number(q);
        return Number.isFinite(n) && n >= MIN_DISCHARGE_LABEL_M3S;
    });
    return gj;
}

/**
 * Within DEDUP_Q_CLUSTER_MAX_KM, if two discharges differ by at most Q_CLOSE_RANGE_M3S,
 * keep only the higher Q (e.g. 60.95 vs 60.57 → 60.95). Process highest Q first.
 */
function dedupeFloodQLabelFeaturesByProximity(gj) {
    if (!gj || !Array.isArray(gj.features)) return gj;
    const items = [];
    for (let i = 0; i < gj.features.length; i++) {
        const f = gj.features[i];
        const geom = f.geometry;
        if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) continue;
        const lon = geom.coordinates[0];
        const lat = geom.coordinates[1];
        const q = f.properties && f.properties.discharge_m3s;
        const n = q == null ? NaN : Number(q);
        if (!Number.isFinite(n)) continue;
        items.push({ feature: f, lat: lat, lon: lon, q: n });
    }
    items.sort(function (a, b) { return b.q - a.q; });
    const kept = [];
    const out = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let skip = false;
        for (let k = 0; k < kept.length; k++) {
            const o = kept[k];
            if (haversineKm(it.lat, it.lon, o.lat, o.lon) > DEDUP_Q_CLUSTER_MAX_KM) continue;
            if (Math.abs(it.q - o.q) <= Q_CLOSE_RANGE_M3S) {
                skip = true;
                break;
            }
        }
        if (skip) continue;
        kept.push({ lat: it.lat, lon: it.lon, q: it.q });
        out.push(it.feature);
    }
    gj.features = out;
    return gj;
}

function updateFloodLegendDischargeBlurb() {
    const el = document.getElementById('flood-legend-discharge-blurb');
    if (!el) return;
    if (showFloodDischargeInFt3s) {
        const thr = (MIN_DISCHARGE_LABEL_M3S * M3S_TO_FT3S).toFixed(0);
        const band = (Q_CLOSE_RANGE_M3S * M3S_TO_FT3S).toFixed(0);
        el.textContent = 'Discharge in ft³/s (cfs), converted from NWM m³/s. Values ≥ ' + thr + ' cfs shown. Nearby labels within ~' + band + ' cfs of each other show the higher value only.';
    } else {
        el.textContent = 'Discharge in m³/s (≥0.5). Nearby labels within 0.5 m³/s of each other show the higher value only.';
    }
}

/**
 * Leaflet divIcon needs real iconSize + centered iconAnchor; a 1×1px icon
 * with CSS translate leaves the white box misaligned from the map anchor.
 */
function dischargeDivIconForLabel(labelText) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;z-index:-1;';
    const inner = document.createElement('div');
    inner.className = 'flood-streamflow-marker-inner';
    inner.textContent = labelText;
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    const r = inner.getBoundingClientRect();
    const w = Math.max(8, Math.ceil(r.width));
    const h = Math.max(8, Math.ceil(r.height));
    document.body.removeChild(wrap);
    return L.divIcon({
        className: 'flood-streamflow-marker',
        html: '<div class="flood-streamflow-marker-inner">' + escapeHtml(labelText) + '</div>',
        iconSize: [w, h],
        iconAnchor: [Math.round(w / 2), Math.round(h / 2)]
    });
}

function attachFloodQLabelLayerFromGeoJson(gj) {
    floodQLabelLayer = L.geoJSON(gj, {
        pane: 'floodLabelsPane',
        interactive: false,
        pointToLayer: function (feature, latlng) {
            const p = feature.properties || {};
            const label = dischargeLabelFromProps(p);
            return L.marker(latlng, {
                pane: 'floodLabelsPane',
                interactive: false,
                zIndexOffset: 5000,
                icon: dischargeDivIconForLabel(label)
            });
        }
    });
}

function reapplyFloodQLabelMarkersFromCache() {
    if (!lastFloodQLabelGeoJson || !lastFloodQLabelGeoJson.features || !lastFloodQLabelGeoJson.features.length) {
        return;
    }
    clearFloodQLabelLayer({ preserveGeoJson: true });
    attachFloodQLabelLayerFromGeoJson(lastFloodQLabelGeoJson);
    syncFloodDischargeLabelsVisibility();
}

function loadFloodQLabelsNwm(huc8, dateStr, expectSeq) {
    return loadFloodQLabels(
        './api/flood-q-labels/nwm/' + encodeURIComponent(huc8) + '/' + encodeURIComponent(dateStr) + '/',
        expectSeq
    );
}

async function loadFloodQLabels(url, expectSeq) {
    clearFloodQLabelLayer();
    try {
        const r = await fetch(url);
        if (expectSeq != null && expectSeq !== floodUIMapRequestSeq) return;
        if (!r.ok) {
            console.warn('flood-q-labels HTTP', r.status, '— check API is running and matches flood preview port');
            return;
        }
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('json') && !ct.includes('geo')) {
            console.warn('flood-q-labels unexpected content-type:', ct);
            return;
        }
        let gj = await r.json();
        if (expectSeq != null && expectSeq !== floodUIMapRequestSeq) return;
        gj = filterFloodQLabelFeatures(gj);
        gj = dedupeFloodQLabelFeaturesByProximity(gj);
        if (!gj || gj.type !== 'FeatureCollection' || !gj.features || !gj.features.length) {
            console.warn('No streamflow labels: raster HydroIDs may not match the NWM CSV, or nwm_subset_streams.gpkg is missing under the HAND download. API returned 0 features.');
            return;
        }
        if (expectSeq != null && expectSeq !== floodUIMapRequestSeq) return;
        lastFloodQLabelGeoJson = gj;
        attachFloodQLabelLayerFromGeoJson(gj);
        if (expectSeq != null && expectSeq !== floodUIMapRequestSeq) return;
        if (showFloodDischargeLabels) {
            floodQLabelLayer.addTo(map);
            if (typeof floodQLabelLayer.bringToFront === 'function') {
                floodQLabelLayer.bringToFront();
            }
        }
    } catch (e) {
        console.warn('Flood streamflow labels:', e);
    }
}

// =============================================================================
// Hydrograph panels (issue #25; forecast variant, issue #31)
// -----------------------------------------------------------------------------
// Discharge time series for the selected watershed, drawn as inline SVG so the
// app keeps its no-build-step, no-chart-library footing. Two panels share this
// code, each with its own state object:
//   * retrospective (hydroRetro) - a +/-N-day NWM retrospective series.
//     Clicking the plot writes the chosen hour back into the date/time inputs,
//     which is what makes the time input purposeful instead of arbitrary.
//     Backed by GET api/get-hydrograph/{huc8}/{date_str}.
//   * forecast (hydroForecast) - the 18 hours of one NWM short-range cycle.
//     Hours already past are shaded and cannot be selected; clicking picks the
//     forecast hour. Backed by GET api/forecast/hydrograph/{huc8}/{cycle}.
// =============================================================================

/** Plot geometry in viewBox units. PAD_B is deeper than the rest: the x-axis carries time labels. */
const HYDRO_W = 420, HYDRO_H = 180, HYDRO_PAD = 34, HYDRO_PAD_B = 40;
const HYDRO_PLOT_W = HYDRO_W - HYDRO_PAD * 2;
const HYDRO_PLOT_H = HYDRO_H - HYDRO_PAD - HYDRO_PAD_B;

/** Half-width of the fetched span, in days. #40 found ±1 (and even ±7 on one
 *  watershed) can clip the real peak at the window edge, while the teehr fetch
 *  is dominated by per-request overhead — a 30x wider window cost only ~46%
 *  more time. ±14 gives real events room to show their full shape without
 *  waiting for a full ±30 fetch by default. Persists across watersheds so it
 *  reads as a preference rather than a per-click setting. */
let hydroWindowDays = 14;

/* Per-panel state. `data` is the plotted {times, values} (values in m³/s), or null.
 * `selTime` is the selected moment as an ISO string: the TIMESTAMP is the source of
 * truth, not its array index — index 32 is a different hour in a 49-point series
 * than a 337-point one. `seq` is bumped per request so a slow response for an old
 * watershed can't overwrite a newer one. */
const hydroRetro = {
    data: null, selTime: null, seq: 0,
    panelId: 'hydrograph-panel', svgId: 'hydrograph-svg',
    firstSelectable: function () { return 0; },
    onSelect: applyHydrographSelectionToInputs,
    note: retroHydrographNote,
};
const hydroForecast = {
    data: null, selTime: null, seq: 0, cycleToken: null, cycleTime: null,
    panelId: 'fc-hydrograph-panel', svgId: 'fc-hydrograph-svg',
    markSamples: true,
    firstSelectable: forecastFirstUpcomingIndex,
    onSelect: applyForecastHydrographSelection,
    note: forecastHydrographNote,
};

/** Reflect the current unit in every two-button toggle (one per panel). */
function syncHydrographUnitButtons() {
    document.querySelectorAll('.hydrograph-unit-btn[data-unit]').forEach(function (btn) {
        btn.classList.toggle('is-active', (btn.dataset.unit === 'cfs') === showFloodDischargeInFt3s);
    });
}

/** Redraw whichever panels hold a series. Units are display-only, so no refetch. */
function rerenderHydrographs() {
    if (hydroRetro.data) renderHydrograph(hydroRetro);
    if (hydroForecast.data) renderHydrograph(hydroForecast);
}

/** Units are shared with the map discharge labels, so flip both and keep the
 *  legend checkbox in step — two controls disagreeing would be worse than one. */
function setHydrographUnits(useCfs) {
    showFloodDischargeInFt3s = !!useCfs;
    const cb = document.getElementById('flood-units-cfs-toggle');
    if (cb) cb.checked = showFloodDischargeInFt3s;
    updateFloodLegendDischargeBlurb();
    reapplyFloodQLabelMarkersFromCache();
    syncHydrographUnitButtons();
    rerenderHydrographs();
}

/** Changing the span needs a new fetch — the window is applied server-side. */
function setHydrographWindow(days, huc8) {
    const n = parseInt(days, 10);
    hydroWindowDays = Math.max(1, Math.min(30, isNaN(n) ? 14 : n));
    if (hydroRetro.data) loadHydrograph(huc8);
}

function hydroScaleX(i, n) {
    if (n < 2) return HYDRO_PAD + HYDRO_PLOT_W / 2;
    return HYDRO_PAD + (i / (n - 1)) * HYDRO_PLOT_W;
}

function hydroScaleY(v, min, max) {
    // SVG y grows DOWNWARD, so the fraction is inverted to put max at the top.
    // min/max come from the data itself: these series vary by only a few percent,
    // and a zero baseline would flatten every one of them into a straight line.
    if (max === min) return HYDRO_PAD + HYDRO_PLOT_H / 2;
    return HYDRO_PAD + (1 - (v - min) / (max - min)) * HYDRO_PLOT_H;
}

/** Inverse of hydroScaleX: a pixel position back to the nearest sample index. */
function hydroIndexFromX(px, n) {
    if (n < 2) return 0;
    const i = Math.round(((px - HYDRO_PAD) / HYDRO_PLOT_W) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
}

/** Screen pixels -> viewBox units. The SVG is width:100%, so the two are not the
 *  same; evt.offsetX would be right at one sidebar width and wrong at every other. */
function hydroViewBoxX(evt, svg) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse()).x;
}

/* Read the clock straight off the ISO string instead of via Date(). NWM timestamps
 * arrive without a timezone, and Date() would read them as local time and shift every
 * label by the UTC offset — the same class of bug as #1. */
function hydroHour(ts) { return Number(String(ts).slice(11, 13)); }
function hydroMinute(ts) { return String(ts).slice(14, 16); }

/** Smallest interval a person actually thinks in that yields at most ~6 labels. */
function hydroTickStepHours(spanHours) {
    const steps = [1, 2, 3, 6, 12, 24, 48, 72, 168];
    for (let k = 0; k < steps.length; k++) {
        if (spanHours / steps[k] <= 6) return steps[k];
    }
    return 336;
}

function hydroChooseTicks(times) {
    const span = (Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 3.6e6;
    const step = hydroTickStepHours(span);
    const out = [];
    let dayCount = null;
    for (let i = 0; i < times.length; i++) {
        const ts = times[i];
        if (hydroMinute(ts) !== '00') continue;
        if (step < 24) {
            if (hydroHour(ts) % step === 0) out.push(i);
        } else {
            if (hydroHour(ts) !== 0) continue;
            dayCount = (dayCount === null) ? 0 : dayCount + 1;
            if (dayCount % (step / 24) === 0) out.push(i);
        }
    }
    return out;
}

/** Midnight ticks show the date; every other tick shows the clock time. */
function hydroTickLabel(ts) {
    return hydroHour(ts) === 0 ? String(ts).slice(5, 10) : String(ts).slice(11, 16);
}

/** "2022-04-27T12:00:00" -> ["2022-04-27", "12:00:00"] for the two form inputs. */
function hydroSplitTimestamp(ts) {
    const parts = String(ts).split('T');
    return [parts[0], (parts[1] || '00:00:00').slice(0, 8)];
}

/** Nearest sample to a given moment — lets the selection survive a data change. */
function hydroIndexForTime(times, ts) {
    if (!ts) return 0;
    const target = Date.parse(ts);
    let best = 0, bestGap = Infinity;
    for (let i = 0; i < times.length; i++) {
        const gap = Math.abs(Date.parse(times[i]) - target);
        if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
}

/* The chart follows the same cfs/m³/s toggle as the map discharge labels. */
function hydroDisplayValue(v) {
    return showFloodDischargeInFt3s ? v * M3S_TO_FT3S : v;
}
function hydroUnitLabel() {
    return showFloodDischargeInFt3s ? 'ft³/s' : 'm³/s';
}

/** Keep an index inside the panel's selectable range (the forecast's past hours are not). */
function hydroClampIndex(ctx, i) {
    const n = ctx.data.times.length;
    const lo = Math.min(ctx.firstSelectable(), n - 1);
    return Math.max(lo, Math.min(n - 1, i));
}

function buildHydrographSvg(ctx, selIdx) {
    const times = ctx.data.times;
    const n = times.length;
    const values = [];
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
        const v = hydroDisplayValue(ctx.data.values[i]);
        values.push(v);
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const baseY = HYDRO_PAD + HYDRO_PLOT_H;
    const unit = hydroUnitLabel();

    let pts = '';
    for (let i = 0; i < n; i++) {
        pts += hydroScaleX(i, n).toFixed(1) + ',' + hydroScaleY(values[i], min, max).toFixed(1) + ' ';
    }

    // Samples that can't be selected sit under a shaded band: in the forecast
    // panel, the hours whose valid time has already passed.
    const firstSel = Math.min(ctx.firstSelectable(), n);
    let past = '';
    if (firstSel > 0) {
        const edge = firstSel >= n
            ? HYDRO_PAD + HYDRO_PLOT_W
            : (hydroScaleX(firstSel - 1, n) + hydroScaleX(firstSel, n)) / 2;
        past = '<rect x="' + HYDRO_PAD + '" y="' + HYDRO_PAD + '" width="' + (edge - HYDRO_PAD).toFixed(1)
             + '" height="' + HYDRO_PLOT_H + '" fill="#eceff1"/>'
             + '<text x="' + (HYDRO_PAD + 3) + '" y="' + (baseY - 4) + '" font-size="9" fill="#95a5a6">past</text>';
    }

    let ticks = '';
    const tickIdx = hydroChooseTicks(times);
    for (let k = 0; k < tickIdx.length; k++) {
        const x = hydroScaleX(tickIdx[k], n).toFixed(1);
        ticks += '<line x1="' + x + '" y1="' + HYDRO_PAD + '" x2="' + x + '" y2="' + baseY + '" stroke="#f0f0f0"/>'
              +  '<line x1="' + x + '" y1="' + baseY + '" x2="' + x + '" y2="' + (baseY + 4) + '" stroke="#bbb"/>'
              +  '<text x="' + x + '" y="' + (baseY + 16) + '" font-size="9" fill="#666" text-anchor="middle">'
              +  escapeHtml(hydroTickLabel(times[tickIdx[k]])) + '</text>';
    }

    // A handful of discrete hours (the forecast's 18) get a dot each, so it's
    // clear which moments can be picked.
    let dots = '';
    if (ctx.markSamples) {
        for (let i = firstSel; i < n; i++) {
            dots += '<circle cx="' + hydroScaleX(i, n).toFixed(1) + '" cy="' + hydroScaleY(values[i], min, max).toFixed(1)
                 +  '" r="2.2" fill="#2980b9"/>';
        }
    }

    const mx = hydroScaleX(selIdx, n);
    const my = hydroScaleY(values[selIdx], min, max);
    const split = hydroSplitTimestamp(times[selIdx]);
    const anchor = mx > HYDRO_W * 0.6 ? 'end' : 'start';
    const labelX = (anchor === 'end' ? mx - 6 : mx + 6).toFixed(1);

    return '<svg id="' + ctx.svgId + '" viewBox="0 0 ' + HYDRO_W + ' ' + HYDRO_H + '"'
        + ' tabindex="0" role="slider" aria-label="Selected hour on the discharge time series"'
        + ' aria-valuemin="' + Math.min(firstSel, n - 1) + '" aria-valuemax="' + (n - 1) + '" aria-valuenow="' + selIdx + '"'
        + ' aria-valuetext="' + escapeHtml(split[0] + ' ' + split[1] + ', ' + values[selIdx].toFixed(2) + ' ' + unit) + '">'
        + past
        + ticks
        + '<line x1="' + HYDRO_PAD + '" y1="' + baseY + '" x2="' + (HYDRO_PAD + HYDRO_PLOT_W) + '" y2="' + baseY + '" stroke="#ccc"/>'
        + '<line x1="' + HYDRO_PAD + '" y1="' + HYDRO_PAD + '" x2="' + HYDRO_PAD + '" y2="' + baseY + '" stroke="#ccc"/>'
        + '<polyline points="' + pts.trim() + '" fill="none" stroke="#2980b9" stroke-width="2"/>'
        + dots
        + '<line x1="' + mx.toFixed(1) + '" y1="' + HYDRO_PAD + '" x2="' + mx.toFixed(1) + '" y2="' + baseY + '" stroke="#e67e22" stroke-width="1" stroke-dasharray="3 2"/>'
        + '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="4" fill="#e67e22" stroke="#fff" stroke-width="1.5"/>'
        + '<text x="' + labelX + '" y="' + (HYDRO_PAD + 11) + '" font-size="10" fill="#e67e22" text-anchor="' + anchor + '">' + escapeHtml(split[0] + ' ' + split[1]) + '</text>'
        + '<text x="' + labelX + '" y="' + (HYDRO_PAD + 23) + '" font-size="10" fill="#e67e22" text-anchor="' + anchor + '">' + escapeHtml(values[selIdx].toFixed(2) + ' ' + unit) + '</text>'
        + '<text x="' + (HYDRO_PAD - 4) + '" y="' + (HYDRO_PAD + 3) + '" font-size="9" fill="#666" text-anchor="end">' + escapeHtml(max.toFixed(2)) + '</text>'
        + '<text x="' + (HYDRO_PAD - 4) + '" y="' + (baseY + 3) + '" font-size="9" fill="#666" text-anchor="end">' + escapeHtml(min.toFixed(2)) + '</text>'
        + '<text x="2" y="' + (HYDRO_PAD - 10) + '" font-size="9" fill="#888">' + unit + '</text>'
        + '</svg>';
}

function applyHydrographSelectionToInputs(ctx) {
    if (!ctx.selTime) return;
    const split = hydroSplitTimestamp(ctx.selTime);
    const dateInput = document.getElementById('flood-date-input');
    const timeInput = document.getElementById('flood-time-input');
    if (dateInput) dateInput.value = split[0];
    if (timeInput) timeInput.value = split[1];
}

/** Move the selection by whole samples. Arrow keys are the only way to land on an
 *  exact hour once the span is wide enough that samples sit under a pixel apart. */
function stepHydrographSelection(ctx, delta) {
    if (!ctx.data) return;
    const times = ctx.data.times;
    const idx = hydroIndexForTime(times, ctx.selTime);
    const next = hydroClampIndex(ctx, idx + delta);
    if (next === idx) return;
    ctx.selTime = times[next];
    ctx.onSelect(ctx);
    renderHydrograph(ctx);
}

function handleHydrographKey(ctx, evt) {
    if (!ctx.data) return;
    const big = 24;                       // a day's worth of hourly samples
    let delta = null, jumpTo = null;
    switch (evt.key) {
        case 'ArrowLeft':  delta = evt.shiftKey ? -big : -1; break;
        case 'ArrowRight': delta = evt.shiftKey ?  big :  1; break;
        case 'PageDown':   delta = -big; break;
        case 'PageUp':     delta =  big; break;
        case 'Home':       jumpTo = 0; break;
        case 'End':        jumpTo = ctx.data.times.length - 1; break;
        default: return;
    }
    evt.preventDefault();                 // stop the sidebar scrolling instead
    if (jumpTo !== null) {
        ctx.selTime = ctx.data.times[hydroClampIndex(ctx, jumpTo)];
        ctx.onSelect(ctx);
        renderHydrograph(ctx);
    } else {
        stepHydrographSelection(ctx, delta);
    }
}

/** Where a panel's series comes from, e.g. "at the watershed outlet (NWM reach
 *  123)": the HUC's outlet (the reach draining the most of its stream network),
 *  or, when the river leaves through a reservoir, the reach entering it. The ID
 *  pans the map to the outlet marker when there is one. */
function outletReachLabel(ctx) {
    const fid = ctx.data && ctx.data.featureId;
    const where = hydroOutletEntersReservoir
        ? 'where the river enters a reservoir' : 'at the watershed outlet';
    if (fid == null) return where;
    const reach = 'NWM reach ' + escapeHtml(String(fid));
    return where + ' (' + (hydroOutletLatLng
        ? '<button type="button" class="hydrograph-outlet-link" onclick="panToHydrographOutlet()"'
            + ' title="Show the reach on the map">' + reach + '</button>'
        : reach) + ')';
}

/** Why a reservoir case stops short of the outlet; '' otherwise. Ends in a space. */
function outletReservoirNote() {
    return hydroOutletEntersReservoir
        ? 'NWM has no flow inside reservoirs, so this is the reach closest to the watershed outlet that has one. '
        : '';
}

function retroHydrographNote(times) {
    // Near either end of the record the server trims the window, so it is
    // lopsided; say why rather than leave the reader to wonder.
    const trimmed = hydroRetro.data && hydroRetro.data.clipped
        ? ', trimmed where the NWM retrospective record ends' : '';
    return 'Discharge ' + outletReachLabel(hydroRetro) + ': '
        + times.length + ' hourly samples, '
        + escapeHtml(String(times[0]).slice(0, 10)) + ' to '
        + escapeHtml(String(times[times.length - 1]).slice(0, 10))
        + ' (±' + hydroWindowDays + (hydroWindowDays === 1 ? ' day' : ' days') + trimmed
        + '). ' + outletReservoirNote() + 'Click the plot to set the date and time, then use ← → to step hour by hour '
        + '(hold Shift for a day, Home/End for the ends).';
}

function renderHydrograph(ctx) {
    const panel = document.getElementById(ctx.panelId);
    if (!panel) return;
    if (!ctx.data || !ctx.data.times || ctx.data.times.length < 2) {
        panel.innerHTML = '<p class="hydrograph-note">Not enough data to plot a series.</p>';
        return;
    }
    const times = ctx.data.times;
    const selIdx = hydroClampIndex(ctx, hydroIndexForTime(times, ctx.selTime));
    ctx.selTime = times[selIdx];

    // Redrawing replaces the SVG node, so focus would be lost on every keypress.
    const prevSvg = document.getElementById(ctx.svgId);
    const hadFocus = !!prevSvg && document.activeElement === prevSvg;

    panel.innerHTML = buildHydrographSvg(ctx, selIdx)
        + '<p class="hydrograph-note">' + ctx.note(times) + '</p>';

    const svg = document.getElementById(ctx.svgId);
    if (!svg) return;
    svg.addEventListener('click', function (evt) {
        if (!ctx.data) return;
        const idx = hydroClampIndex(ctx, hydroIndexFromX(hydroViewBoxX(evt, svg), ctx.data.times.length));
        ctx.selTime = ctx.data.times[idx];
        ctx.onSelect(ctx);
        svg.focus({ preventScroll: true });   // so the arrow keys work straight after a click
        renderHydrograph(ctx);
    });
    svg.addEventListener('keydown', function (evt) { handleHydrographKey(ctx, evt); });
    if (hadFocus) svg.focus({ preventScroll: true });
}

/** Drop any plotted series — called when the sidebar switches watershed. */
function clearHydrograph() {
    [hydroRetro, hydroForecast].forEach(function (ctx) {
        ctx.seq++;
        ctx.data = null;
        ctx.selTime = null;
    });
    clearHydrographOutlet();
}

// -----------------------------------------------------------------------------
// Outlet reach on the map: the reach both hydrographs plot, highlighted, with a
// marker where it leaves the watershed (or enters a reservoir). Both panels
// share it, since a watershed has one outlet.
// -----------------------------------------------------------------------------
const HYDRO_OUTLET_COLOR = '#e67e22';   // orange: apart from the blue flood and labels
let hydroOutletLayer = null;
let hydroOutletFeatureId = null;
let hydroOutletLatLng = null;
/** True when the river leaves through a reservoir and the reach stops short of it. */
let hydroOutletEntersReservoir = false;

/** Draw the outlet reach from a hydrograph response's `outlet` Feature. */
function showHydrographOutlet(feature) {
    if (!feature || !feature.geometry || !feature.properties || !feature.properties.marker) return;
    const fid = feature.properties.feature_id;
    if (hydroOutletLayer && fid === hydroOutletFeatureId) return;
    clearHydrographOutlet();
    const props = feature.properties || {};
    hydroOutletEntersReservoir = !!props.enters_reservoir;
    const label = (hydroOutletEntersReservoir ? 'Hydrograph reach, entering a reservoir' : 'Hydrograph outlet')
        + '<br>NWM reach ' + escapeHtml(String(fid));
    const reach = L.geoJSON(feature, {
        pane: 'hydroOutletPane',
        interactive: false,
        style: { color: HYDRO_OUTLET_COLOR, weight: 6, opacity: 0.9 },
    });
    // The server places the marker where the reach leaves the watershed; the
    // reach itself often runs on past the boundary.
    hydroOutletLatLng = [props.marker[1], props.marker[0]];
    const marker = L.circleMarker(hydroOutletLatLng, {
        pane: 'hydroOutletPane',
        radius: 8,
        color: '#fff',
        weight: 2,
        fillColor: HYDRO_OUTLET_COLOR,
        fillOpacity: 1,
    }).bindTooltip(label, { pane: 'hydroOutletPane', direction: 'top', offset: [0, -8] });
    hydroOutletLayer = L.layerGroup([reach, marker]).addTo(map);
    hydroOutletFeatureId = fid;
}

function clearHydrographOutlet() {
    if (hydroOutletLayer) map.removeLayer(hydroOutletLayer);
    hydroOutletLayer = null;
    hydroOutletFeatureId = null;
    hydroOutletLatLng = null;
    hydroOutletEntersReservoir = false;
}

/** Bring the outlet into view; it can sit at the watershed's far edge. The open
 *  sidebar covers the right of the map, so centre the outlet in what is left. */
function panToHydrographOutlet() {
    if (!hydroOutletLatLng) return;
    map.setView(hydroOutletLatLng, Math.max(map.getZoom(), 12), { animate: false });
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !sidebar.classList.contains('open')) return;
    const mapBox = map.getContainer().getBoundingClientRect();
    const covered = Math.max(0, mapBox.right - sidebar.getBoundingClientRect().left);
    // A sidebar covering nearly all of the map (a phone) leaves nowhere better.
    if (covered > 0 && covered < mapBox.width * 0.8) {
        map.panBy([covered / 2, 0], { animate: false });
    }
}

async function loadHydrograph(huc8) {
    const ctx = hydroRetro;
    const panel = document.getElementById(ctx.panelId);
    if (!panel) return;
    const btn = document.getElementById('hydrograph-load-btn');
    const dateInput = document.getElementById('flood-date-input');
    const timeInput = document.getElementById('flood-time-input');
    const date = dateInput ? dateInput.value : '';
    const time = timeInput ? (timeInput.value || '00:00:00') : '00:00:00';

    if (!date) {
        panel.innerHTML = '<p class="hydrograph-note hydrograph-error">Pick a date first.</p>';
        return;
    }

    const dateStr = date + '-' + time.replace(/:/g, '-');
    const mySeq = ++ctx.seq;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    panel.innerHTML = '<p class="hydrograph-note">Fetching NWM streamflow — this usually takes about 15 seconds.</p>';

    try {
        const r = await fetch('./api/get-hydrograph/' + encodeURIComponent(huc8) + '/'
            + encodeURIComponent(dateStr) + '/?days=' + encodeURIComponent(hydroWindowDays));
        if (mySeq !== ctx.seq) return;
        const data = await r.json();
        if (mySeq !== ctx.seq) return;

        if (!r.ok || data.status !== 'success' || !data.times || !data.times.length) {
            // The endpoint raises FileNotFoundError before a watershed has been
            // generated, because it needs that run's feature_IDs.csv.
            panel.innerHTML = '<p class="hydrograph-note hydrograph-error">'
                + escapeHtml(data.message || 'No streamflow data available for this watershed and date.')
                + '</p>';
            return;
        }

        ctx.data = { times: data.times, values: data.values, clipped: !!data.clipped, featureId: data.feature_id };
        showHydrographOutlet(data.outlet);
        // The API echoes the requested moment as "YYYY-MM-DD HH:MM:SS"; the series
        // uses ISO "T" form, so normalise before matching it to a sample.
        ctx.selTime = data.datetime ? String(data.datetime).replace(' ', 'T') : data.times[0];
        renderHydrograph(ctx);
    } catch (e) {
        if (mySeq !== ctx.seq) return;
        panel.innerHTML = '<p class="hydrograph-note hydrograph-error">Could not load the hydrograph: '
            + escapeHtml(e.message) + '</p>';
    } finally {
        if (btn && mySeq === ctx.seq) { btn.disabled = false; btn.textContent = 'Show hydrograph'; }
    }
}

function clearFloodLayer() {
    floodUIMapRequestSeq++;
    floodOverlayMode = null;
    if (floodOverlayLayer) { map.removeLayer(floodOverlayLayer); floodOverlayLayer = null; }
    clearFloodQLabelLayer();
    hideFloodLegend();
}

var currentFloodGenerateAbort = null;

function floodGenerateOverlayShow(message) {
    var overlay = document.getElementById('flood-generate-overlay');
    var msgEl = document.getElementById('flood-generate-modal-msg');
    if (msgEl) {
        msgEl.textContent = message || '';
    }
    if (overlay) {
        overlay.classList.add('flood-generate-overlay--visible');
        overlay.setAttribute('aria-hidden', 'false');
    }
}

function floodGenerateOverlayHide() {
    var overlay = document.getElementById('flood-generate-overlay');
    if (overlay) {
        overlay.classList.remove('flood-generate-overlay--visible');
        overlay.setAttribute('aria-hidden', 'true');
    }
}

function cancelFloodGenerateFromOverlay() {
    floodGenerateOverlayHide();
    if (currentFloodGenerateAbort) {
        try {
            currentFloodGenerateAbort.abort();
        } catch (e) { /* noop */ }
    }
}

(function wireFloodGenerateCancel() {
    var cancelText = document.getElementById('flood-generate-cancel-text');
    if (cancelText) {
        cancelText.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            cancelFloodGenerateFromOverlay();
        });
    }
})();

function floodSuccessEscapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function floodSuccessModalEscapeHandler(e) {
    if (e.key === 'Escape') {
        hideFloodSuccessModal();
    }
}

function hideFloodSuccessModal() {
    var el = document.getElementById('flood-success-overlay');
    if (el) {
        el.classList.remove('flood-success-overlay--visible');
        el.setAttribute('aria-hidden', 'true');
    }
    document.removeEventListener('keydown', floodSuccessModalEscapeHandler);
}

function showFloodSuccessModal(huc8, result) {
    var overlay = document.getElementById('flood-success-overlay');
    var detailDiv = document.getElementById('flood-success-detail');
    if (!overlay || !detailDiv) return;
    var lines = [];
    if (huc8) lines.push('<strong>HUC8:</strong> ' + floodSuccessEscapeHtml(huc8));
    var isForecast = !!(result && result.forecast);
    if (isForecast) {
        lines.push('<strong>Forecast valid:</strong> ' + floodSuccessEscapeHtml(result.valid));
        lines.push('<strong>NWM cycle:</strong> ' + floodSuccessEscapeHtml(result.cycle));
    } else if (result && result.datetime) {
        lines.push('<strong>When:</strong> ' + floodSuccessEscapeHtml(String(result.datetime)));
    }
    var tagline = document.getElementById('flood-success-tagline');
    if (tagline) {
        if (!tagline.dataset.retroText) tagline.dataset.retroText = tagline.textContent;
        tagline.textContent = isForecast
            ? 'The NWM short-range forecast met HAND - this map is a forecast, not an observation.'
            : tagline.dataset.retroText;
    }
    detailDiv.innerHTML = lines.length ? lines.join('<br>') : 'Generation completed.';
    overlay.classList.add('flood-success-overlay--visible');
    overlay.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', floodSuccessModalEscapeHandler);
    var ok = document.getElementById('flood-success-ok');
    if (ok) {
        setTimeout(function () { ok.focus(); }, 50);
    }
}

(function wireFloodSuccessModal() {
    var overlay = document.getElementById('flood-success-overlay');
    if (!overlay) return;
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
            hideFloodSuccessModal();
        }
    });
    var closeBtn = document.getElementById('flood-success-close');
    var okBtn = document.getElementById('flood-success-ok');
    if (closeBtn) closeBtn.addEventListener('click', hideFloodSuccessModal);
    if (okBtn) okBtn.addEventListener('click', hideFloodSuccessModal);
})();

const FLOOD_JOB_POLL_MS = 4000;
const FLOOD_JOB_TERMINAL_STATUSES = ['success', 'error', 'interrupted'];
// Generation pins the serving pod (heavy in-process compute), so status polls
// can transiently hit 502/503/504 or an HTML gateway page. Tolerate a run of
// those before giving up — the job keeps running server-side regardless.
const FLOOD_JOB_MAX_POLL_FAILURES = 15;

/** Where each kind of job reports: its own page's status line and generate button. */
const FLOOD_MODE_UI = {
    retro: { statusId: 'flood-map-status', buttonId: 'generate-flood-map-btn', buttonLabel: 'Generate Flood Map' },
    forecast: { statusId: 'fc-flood-map-status', buttonId: 'fc-generate-btn', buttonLabel: 'Generate Forecast Flood Map' },
};

function floodJobMode(job) {
    return job && job.kind === 'forecast' ? 'forecast' : 'retro';
}

function setFloodStatus(html, mode) {
    const statusDiv = document.getElementById(FLOOD_MODE_UI[mode || 'retro'].statusId);
    if (statusDiv) statusDiv.innerHTML = html;
}

function setGenerateButtonBusy(busy, mode) {
    const ui = FLOOD_MODE_UI[mode || 'retro'];
    const btn = document.getElementById(ui.buttonId);
    if (!btn) return;
    btn.dataset.busy = busy ? '1' : '';
    btn.textContent = busy ? 'Generating…' : ui.buttonLabel;
    // The forecast button also needs an hour to generate for.
    btn.disabled = busy || (mode === 'forecast' && !selectedForecastHour());
}

function floodJobSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function fetchJobJson(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch (networkErr) {
        const e = new Error('Network error contacting the API server.');
        e.retryable = true;
        throw e;
    }
    let result = null;
    let parseErr = null;
    try {
        result = await response.json();
    } catch (err) {
        parseErr = err;
    }
    if (!response.ok) {
        // 5xx (502/503/504) come from the gateway when the pod is busy or
        // restarting — transient, so callers may retry.
        const e = new Error((result && result.message) || response.statusText || ('HTTP ' + response.status));
        e.retryable = response.status >= 500;
        throw e;
    }
    if (parseErr || !result || result.status !== 'success') {
        // A non-JSON body (an HTML error page) means a gateway hiccup, not an
        // app-level failure — treat the parse case as transient.
        const e = new Error((result && result.message) || 'Invalid response from API server.');
        e.retryable = !!parseErr;
        throw e;
    }
    return result;
}

function floodJobResultSummary(job) {
    const params = job.params || {};
    const summary = { file_name: job.result_file ? job.result_file.split('/').pop() : '' };
    if (floodJobMode(job) === 'forecast') {
        summary.forecast = true;
        summary.valid = params.valid ? formatUtcHour(isoFromToken(params.valid)) : '';
        summary.cycle = params.cycle
            ? formatUtcHour(isoFromToken(params.cycle)) + (params.forecast_hour ? ' (' + forecastHourCode(params.forecast_hour) + ')' : '')
            : '';
    } else {
        summary.datetime = params.datetime_str || '';
    }
    return summary;
}

async function submitFloodJob(url, payload) {
    const result = await fetchJobJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return result.job;
}

async function pollFloodJob(jobId, abortController) {
    let failures = 0;
    while (true) {
        if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        let result;
        try {
            result = await fetchJobJson('./api/jobs/status/' + encodeURIComponent(jobId) + '/');
        } catch (error) {
            // Don't abort the watch on a transient gateway error — the job is
            // still running server-side. Retry until the pod recovers.
            if (error && error.retryable && failures < FLOOD_JOB_MAX_POLL_FAILURES) {
                failures += 1;
                floodGenerateOverlayShow('Generating flood map… (server busy, retrying)');
                await floodJobSleep(FLOOD_JOB_POLL_MS);
                continue;
            }
            throw error;
        }
        failures = 0;
        if (FLOOD_JOB_TERMINAL_STATUSES.includes(result.job.status)) return result.job;
        floodGenerateOverlayShow(result.job.message || 'Generating flood map…');
        await floodJobSleep(FLOOD_JOB_POLL_MS);
    }
}

function finishFloodJob(huc8, job) {
    const mode = floodJobMode(job);
    floodGenerateOverlayHide();
    if (job.status !== 'success') {
        setFloodStatus(`<span style="color: #e74c3c;">Error: ${job.message || job.status}</span>`, mode);
        return;
    }
    const summary = floodJobResultSummary(job);
    const fileLine = summary.file_name ? `<br><span style="font-size: 11px;">File: ${summary.file_name}</span>` : '';
    setFloodStatus(`<span style="color: #27ae60;">✓ Flood map generated successfully!</span>${fileLine}`, mode);
    if (mode === 'forecast') {
        if (huc8 === lastSidebarHuc8) loadForecastHydrograph(huc8, (job.params || {}).cycle);
    } else {
        loadHydrograph(huc8);
    }
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            showFloodSuccessModal(huc8, summary);
        });
    });
}

async function watchFloodJob(huc8, job) {
    const mode = floodJobMode(job);
    const abortController = new AbortController();
    currentFloodGenerateAbort = abortController;
    setGenerateButtonBusy(true, mode);
    floodGenerateOverlayShow(job.message || 'Generating flood map…');
    try {
        finishFloodJob(huc8, await pollFloodJob(job.job_id, abortController));
    } catch (error) {
        floodGenerateOverlayHide();
        if (error && error.name === 'AbortError') {
            setFloodStatus('<span style="color: #64748b;">Stopped watching — the generation keeps running on the server.</span>', mode);
        } else {
            console.error('Error watching flood job:', error);
            setFloodStatus(`<span style="color: #e74c3c;">Error: ${error.message}</span>`, mode);
        }
    } finally {
        currentFloodGenerateAbort = null;
        setGenerateButtonBusy(false, mode);
    }
}

async function generateFloodMap(huc8) {
    const date = document.getElementById('flood-date-input').value;
    const time = document.getElementById('flood-time-input').value || '00:00:00';
    if (!date) {
        setFloodStatus('<span style="color: #e74c3c;">Please select a date</span>');
        return;
    }
    const rangeError = nwmDateRangeError(date);
    if (rangeError) {
        setFloodStatus(`<span style="color: #e74c3c;">${rangeError}</span>`);
        return;
    }
    setFloodStatus(`<span style="color: #3498db;">Generating flood map for ${date} ${time}…</span>`);
    try {
        const job = await submitFloodJob('./api/jobs/generate-flood-map/', { huc8: huc8, date: date, time: time });
        await watchFloodJob(huc8, job);
    } catch (error) {
        floodGenerateOverlayHide();
        setFloodStatus(`<span style="color: #e74c3c;">Error: ${error.message}</span>`);
    }
}

async function reattachActiveFloodJob(huc8) {
    if (currentFloodGenerateAbort) return;
    try {
        const result = await fetchJobJson('./api/jobs/active/?huc8=' + encodeURIComponent(huc8));
        if (result.job) {
            setFloodStatus('<span style="color: #3498db;">A generation for this watershed is already running…</span>', floodJobMode(result.job));
            await watchFloodJob(huc8, result.job);
        }
    } catch (error) {
        console.error('Could not check for an active job:', error);
    }
}

// =============================================================================
// Forecast page (issue #31)
// -----------------------------------------------------------------------------
// The second sidebar page maps the NWM short-range forecast instead of the
// retrospective record. Its input is different: no date picker, just the
// newest published cycle and a choice among that cycle's forecast hours whose
// valid time is still ahead. Hours are named by valid time in UTC throughout;
// the forecast hour ("f003") is secondary detail. The server re-checks
// staleness on submit, since this page can sit open past the top of the hour.
// Backed by GET api/forecast/options and POST api/jobs/generate-flood-map-forecast.
// =============================================================================

/** `options` is the last api/forecast/options payload; `huc8` is the watershed it
 *  was loaded for (null once the page is rebuilt); `seq` drops stale responses. */
const forecastState = { options: null, huc8: null, seq: 0 };

/* NWM times arrive as naive UTC ISO strings. Parse them as UTC explicitly —
 * Date() would read them as local time and shift every hour by the offset. */
function utcDate(iso) {
    return new Date(String(iso).replace(' ', 'T') + 'Z');
}

/** "2026-09-29T17:00:00" -> "2026092917", the hour token the API uses. */
function tokenFromIso(iso) {
    return String(iso).slice(0, 13).replace(/[-T]/g, '');
}

/** "2026092917" -> "2026-09-29T17:00:00". */
function isoFromToken(token) {
    const t = String(token);
    return t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) + 'T' + t.slice(8, 10) + ':00:00';
}

function forecastHourCode(fhour) {
    return 'f' + String(fhour).padStart(3, '0');
}

/** "Tue, Sep 29, 17:00 UTC" */
function formatUtcHour(iso) {
    return utcDate(iso).toLocaleString('en-US', {
        timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }) + ' UTC';
}

/** The same moment on the viewer's clock, e.g. "Tue, Sep 29, 11:00 AM MDT". */
function formatLocalHour(iso) {
    return utcDate(iso).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
}

/** One dropdown option in plain words:
 *  "17:00 UTC (11:00 AM your time), in 1 hour · f003".
 *  The 18 hours run past midnight, so a local time on a later day says so. */
function forecastOptionLabel(hour) {
    const d = utcDate(hour.valid_time);
    const utc = String(d.getUTCHours()).padStart(2, '0') + ':00 UTC';
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        + (days === 1 ? ' tomorrow' : days > 1 ? ' ' + d.toLocaleDateString(undefined, { weekday: 'short' }) : '');
    return utc + ' (' + clock + ' your time), ' + formatLeadTime(hour.valid_time)
        + ' · ' + forecastHourCode(hour.forecast_hour);
}

function formatLeadTime(iso) {
    const minutes = Math.round((utcDate(iso).getTime() - Date.now()) / 60000);
    if (minutes < 60) {
        const m = Math.max(1, minutes);
        return 'in ' + m + (m === 1 ? ' minute' : ' minutes');
    }
    const h = Math.round(minutes / 60);
    return 'in ' + h + (h === 1 ? ' hour' : ' hours');
}

function isForecastHourStale(iso) {
    return utcDate(iso).getTime() <= Date.now();
}

// ---- Tabs -------------------------------------------------------------------

function syncModeTabs() {
    document.querySelectorAll('.mode-tab').forEach(function (tab) {
        const on = tab.dataset.mode === sidebarMode;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
    });
}

function setSidebarMode(mode) {
    if (mode !== 'retro' && mode !== 'forecast') return;
    const changed = mode !== sidebarMode;
    sidebarMode = mode;
    try {
        localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    } catch (e) { /* storage blocked; the choice just won't persist */ }
    syncModeTabs();
    document.querySelectorAll('[data-mode-page]').forEach(function (page) {
        page.hidden = page.dataset.modePage !== mode;
    });
    if (!changed) return;
    // A retrospective map left on screen under the Forecast tab (or the reverse)
    // would read as the other product, so switching pages takes it down.
    if (floodOverlayMode && floodOverlayMode !== mode) {
        const shownBy = floodOverlayMode;
        clearFloodLayer();
        setFloodStatus('', shownBy);
    }
    if (mode === 'forecast' && lastSidebarHuc8 && lastSidebarCovered) {
        if (forecastState.huc8 !== lastSidebarHuc8) loadForecastOptions(lastSidebarHuc8);
        else pruneStaleForecastOptions();
    }
}

(function wireModeTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.mode-tab'));
    tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { setSidebarMode(tab.dataset.mode); });
        // Arrow keys move between tabs, per the ARIA tabs pattern.
        tab.addEventListener('keydown', function (evt) {
            if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
            evt.preventDefault();
            const next = tabs[(i + (evt.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            setSidebarMode(next.dataset.mode);
            next.focus();
        });
    });
    syncModeTabs();
})();

// ---- Sections ---------------------------------------------------------------

function forecastSectionHtml(huc8) {
    return `
        <div class="info-section">
            <h3>Forecast Flood Map <span class="forecast-badge">Forecast</span></h3>
            <div class="forecast-panel">
                <div id="fc-cycle" class="forecast-cycle">Looking up the latest NWM short-range cycle&hellip;</div>
                <label class="forecast-label" for="fc-hour-select">Forecast hour (valid time, UTC):</label>
                <select id="fc-hour-select" class="forecast-select" disabled onfocus="pruneStaleForecastOptions()" onchange="onForecastHourChange()"></select>
                <p id="fc-hour-local" class="forecast-hint"></p>
                <p class="forecast-hint">Only hours still ahead are offered. The model runs every hour and publishes about 2 hours after each cycle. <a href="#" onclick="loadForecastOptions('${huc8}'); return false;">Refresh</a></p>
                <p id="fc-warm-note" class="forecast-hint forecast-warn" hidden>This watershed's HAND data isn't cached yet, so the first run downloads it before mapping (about 5&ndash;15 minutes).</p>
                <button id="fc-generate-btn" class="forecast-btn forecast-btn--generate" onclick="generateForecastFloodMap('${huc8}')" disabled>Generate Forecast Flood Map</button>
                <button id="fc-download-btn" class="forecast-btn forecast-btn--download" onclick="downloadProcessedForecastMap('${huc8}')" disabled>Download processed (reclassified)</button>
                <p class="forecast-hint">Reclassifies: flooded &rarr; 1, no flood &rarr; 0.</p>
                <button id="fc-show-btn" class="forecast-btn forecast-btn--show" onclick="showFloodMapOnMapForecast('${huc8}')" disabled>Show on map</button>
                <div id="fc-flood-map-status" class="forecast-status"></div>
            </div>
        </div>`;
}

function forecastHydrographSectionHtml(huc8) {
    return `
        <div class="info-section">
            <h3>Forecast Hydrograph</h3>
            <div class="hydrograph-controls">
                <span class="hydrograph-ctl">18 hourly forecast values, UTC</span>
                <div class="hydrograph-units" role="group" aria-label="Discharge units">
                    <button type="button" data-unit="m3s" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? '' : ' is-active'}" onclick="setHydrographUnits(false)">m&sup3;/s</button>
                    <button type="button" data-unit="cfs" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? ' is-active' : ''}" onclick="setHydrographUnits(true)">ft&sup3;/s</button>
                </div>
            </div>
            <div id="fc-hydrograph-panel" class="hydrograph-panel">
                <p class="hydrograph-note">Generate a flood map for this watershed first (forecast or retrospective) &mdash; the series is read at the watershed's outlet reach, found from that run's stream network.</p>
            </div>
            <button id="fc-hydrograph-load-btn" class="hydrograph-btn" onclick="loadForecastHydrograph('${huc8}')">Show forecast hydrograph</button>
        </div>`;
}

// ---- Cycle and hour options -------------------------------------------------

function setForecastControlsEnabled(enabled) {
    ['fc-hour-select', 'fc-download-btn', 'fc-show-btn'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
    const gen = document.getElementById('fc-generate-btn');
    if (gen && gen.dataset.busy !== '1') gen.disabled = !enabled;
}

async function loadForecastOptions(huc8) {
    const mySeq = ++forecastState.seq;
    const cycleEl = document.getElementById('fc-cycle');
    if (cycleEl) cycleEl.textContent = 'Looking up the latest NWM short-range cycle…';
    setForecastControlsEnabled(false);
    try {
        const r = await fetch('./api/forecast/options/?huc8=' + encodeURIComponent(huc8));
        const data = await r.json().catch(function () { return {}; });
        if (mySeq !== forecastState.seq || huc8 !== lastSidebarHuc8) return;
        if (!r.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + r.status));
        forecastState.options = data;
        forecastState.huc8 = huc8;
        renderForecastOptions();
    } catch (e) {
        if (mySeq !== forecastState.seq) return;
        forecastState.options = null;
        const el = document.getElementById('fc-cycle');
        if (el) el.innerHTML = '<span class="hydrograph-error">Could not load forecast hours: ' + escapeHtml(e.message) + '</span>';
    }
}

function renderForecastOptions() {
    const opts = forecastState.options;
    const select = document.getElementById('fc-hour-select');
    const cycleEl = document.getElementById('fc-cycle');
    if (!opts || !select || !cycleEl) return;
    const previous = select.value;
    cycleEl.innerHTML = 'Latest NWM short-range cycle: <strong>' + escapeHtml(formatUtcHour(opts.cycle_time))
        + '</strong> (t' + escapeHtml(String(opts.cycle_time).slice(11, 13)) + 'z)';
    select.innerHTML = opts.hours.map(function (h) {
        return '<option value="' + escapeHtml(h.valid_token) + '">'
            + escapeHtml(forecastOptionLabel(h))
            + '</option>';
    }).join('');
    if (previous && opts.hours.some(function (h) { return h.valid_token === previous; })) {
        select.value = previous;
    }
    const warm = document.getElementById('fc-warm-note');
    if (warm) warm.hidden = opts.hydrofabric_cached !== false;
    const hasHours = opts.hours.length > 0;
    setForecastControlsEnabled(hasHours);
    if (!hasHours) {
        cycleEl.innerHTML += '<br><span class="forecast-warn">Every hour of this cycle has passed. '
            + 'The next cycle usually lands within the hour &mdash; try Refresh shortly.</span>';
    }
    onForecastHourChange();
}

/** The chosen hour with its cycle, or null. */
function selectedForecastHour() {
    const opts = forecastState.options;
    const select = document.getElementById('fc-hour-select');
    if (!opts || !select || !select.value) return null;
    const hour = opts.hours.find(function (h) { return h.valid_token === select.value; });
    if (!hour) return null;
    return {
        cycle_token: opts.cycle_token,
        cycle_time: opts.cycle_time,
        valid_token: hour.valid_token,
        valid_time: hour.valid_time,
        forecast_hour: hour.forecast_hour,
    };
}

/** Drop hours whose valid time has passed since the options were loaded.
 *  Returns false when nothing is left (a fresh listing is then requested). */
function pruneStaleForecastOptions() {
    const opts = forecastState.options;
    if (!opts) return false;
    const before = opts.hours.length;
    opts.hours = opts.hours.filter(function (h) { return !isForecastHourStale(h.valid_time); });
    if (opts.hours.length !== before) renderForecastOptions();
    if (!opts.hours.length) {
        if (forecastState.huc8) loadForecastOptions(forecastState.huc8);
        return false;
    }
    return true;
}

/** Full date for the chosen hour, which the shorter option text leaves out. */
function forecastHourHint(iso) {
    return 'Selected: ' + formatUtcHour(iso) + ' = ' + formatLocalHour(iso) + '.';
}

function onForecastHourChange() {
    const sel = selectedForecastHour();
    const hint = document.getElementById('fc-hour-local');
    if (hint) hint.textContent = sel ? forecastHourHint(sel.valid_time) : '';
    if (sel && hydroForecast.data && hydroForecast.cycleToken === sel.cycle_token) {
        hydroForecast.selTime = sel.valid_time;
        renderHydrograph(hydroForecast);
    }
}

// Lead times ("in 40 min") age and hours go stale while the page sits open.
setInterval(function () {
    if (sidebarMode !== 'forecast' || !forecastState.options) return;
    const select = document.getElementById('fc-hour-select');
    if (select && document.activeElement === select) return;   // don't rebuild an open dropdown
    if (pruneStaleForecastOptions()) renderForecastOptions();
    if (hydroForecast.data) renderHydrograph(hydroForecast);
}, 60000);

// ---- Actions ----------------------------------------------------------------

function forecastResultPath(huc8, sel) {
    return encodeURIComponent(huc8) + '/' + sel.cycle_token + '/' + sel.valid_token + '/';
}

async function generateForecastFloodMap(huc8) {
    pruneStaleForecastOptions();
    const sel = selectedForecastHour();
    if (!sel) {
        setFloodStatus('<span style="color: #e74c3c;">Pick a forecast hour first.</span>', 'forecast');
        return;
    }
    setFloodStatus('<span style="color: #3498db;">Generating forecast flood map for '
        + escapeHtml(formatUtcHour(sel.valid_time)) + '…</span>', 'forecast');
    try {
        const job = await submitFloodJob('./api/jobs/generate-flood-map-forecast/', {
            huc8: huc8, cycle: sel.cycle_token, valid: sel.valid_token,
        });
        await watchFloodJob(huc8, job);
    } catch (error) {
        floodGenerateOverlayHide();
        setFloodStatus('<span style="color: #e74c3c;">Error: ' + escapeHtml(error.message) + '</span>', 'forecast');
        // The hour passed or the listing moved on between loading and submitting.
        if (/no longer in the future|not published/.test(error.message)) loadForecastOptions(huc8);
    }
}

async function showFloodMapOnMapForecast(huc8) {
    const sel = selectedForecastHour();
    if (!sel) {
        setFloodStatus('<span style="color: #e74c3c;">Pick a forecast hour first.</span>', 'forecast');
        return;
    }
    const mySeq = ++floodUIMapRequestSeq;
    const path = forecastResultPath(huc8, sel);
    setFloodStatus('<span style="color: #3498db;">Loading preview...</span>', 'forecast');
    try {
        const r = await fetch('./api/flood-map-preview/forecast/' + path);
        if (mySeq !== floodUIMapRequestSeq) return;
        const data = await r.json();
        if (mySeq !== floodUIMapRequestSeq) return;
        if (data.status !== 'success') {
            setFloodStatus('<span style="color: #e74c3c;">' + escapeHtml(data.message || 'Not found') + '</span>', 'forecast');
            return;
        }
        drawFloodPreview(huc8, data, 'forecast',
            'NWM short-range forecast valid ' + formatUtcHour(sel.valid_time)
            + ' (t' + String(sel.cycle_time).slice(11, 13) + 'z cycle, ' + forecastHourCode(sel.forecast_hour)
            + '). A forecast, not an observation.');
        setFloodStatus('<span style="color: #27ae60;">✓ Forecast flood map shown on map</span> '
            + '<a href="#" onclick="clearFloodLayer(); setFloodStatus(\'\', \'forecast\'); return false;" style="font-size: 11px; margin-left: 6px;">Clear</a>', 'forecast');
        await loadFloodQLabels('./api/flood-q-labels/forecast/' + path, mySeq);
    } catch (e) {
        if (mySeq === floodUIMapRequestSeq) {
            setFloodStatus('<span style="color: #e74c3c;">Error: ' + escapeHtml(e.message) + '</span>', 'forecast');
        }
    }
}

async function downloadProcessedForecastMap(huc8) {
    const sel = selectedForecastHour();
    if (!sel) {
        setFloodStatus('<span style="color: #e74c3c;">Pick a forecast hour first.</span>', 'forecast');
        return;
    }
    await downloadReclassified(
        './api/get-flood-map-forecast/' + forecastResultPath(huc8, sel) + '?reclass=1',
        huc8 + '_NWMSR_' + sel.cycle_token + '_' + sel.valid_token + '_reclassified.tif',
        'forecast'
    );
}

// ---- Forecast hydrograph ----------------------------------------------------

/** Index of the first hour still ahead (the plot shades and skips the rest). */
function forecastFirstUpcomingIndex() {
    const times = hydroForecast.data ? hydroForecast.data.times : [];
    for (let i = 0; i < times.length; i++) {
        if (!isForecastHourStale(times[i])) return i;
    }
    return times.length;
}

/** Clicking the plot picks that hour in the dropdown, when it is still offered. */
function applyForecastHydrographSelection(ctx) {
    const select = document.getElementById('fc-hour-select');
    if (!select || !ctx.selTime || hydroForecast.cycleToken !== (forecastState.options || {}).cycle_token) return;
    const token = tokenFromIso(ctx.selTime);
    if (Array.prototype.some.call(select.options, function (o) { return o.value === token; })) {
        select.value = token;
        const hint = document.getElementById('fc-hour-local');
        if (hint) hint.textContent = forecastHourHint(ctx.selTime);
    }
}

function forecastHydrographNote(times) {
    return 'Discharge ' + outletReachLabel(hydroForecast) + ' for the ' + escapeHtml(formatUtcHour(hydroForecast.cycleTime))
        + ' cycle, ' + escapeHtml(formatUtcHour(times[0])) + ' to ' + escapeHtml(formatUtcHour(times[times.length - 1]))
        + '. ' + outletReservoirNote() + 'Shaded hours have already passed. Click an hour still ahead to choose it, then use ← → to step.';
}

async function loadForecastHydrograph(huc8, cycleToken) {
    const ctx = hydroForecast;
    const panel = document.getElementById(ctx.panelId);
    if (!panel) return;
    const cycle = cycleToken || (forecastState.options && forecastState.options.cycle_token);
    if (!cycle) {
        panel.innerHTML = '<p class="hydrograph-note hydrograph-error">Forecast hours are still loading &mdash; try again in a moment.</p>';
        return;
    }
    const btn = document.getElementById('fc-hydrograph-load-btn');
    const mySeq = ++ctx.seq;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    panel.innerHTML = '<p class="hydrograph-note">Fetching all 18 forecast hours from NOAA — about 15 seconds the first time.</p>';
    try {
        const r = await fetch('./api/forecast/hydrograph/' + encodeURIComponent(huc8) + '/' + encodeURIComponent(cycle) + '/');
        if (mySeq !== ctx.seq) return;
        const data = await r.json();
        if (mySeq !== ctx.seq) return;
        if (!r.ok || data.status !== 'success' || !data.times || !data.times.length) {
            panel.innerHTML = '<p class="hydrograph-note hydrograph-error">'
                + escapeHtml(data.message || 'No forecast data available for this watershed.') + '</p>';
            return;
        }
        // An hour where no reach has a forecast comes back null; leave it out of the line.
        const times = [], values = [];
        data.times.forEach(function (t, i) {
            if (data.values[i] != null) { times.push(t); values.push(data.values[i]); }
        });
        ctx.data = { times: times, values: values, featureId: data.feature_id };
        showHydrographOutlet(data.outlet);
        ctx.cycleToken = cycle;
        ctx.cycleTime = data.cycle_time;
        const sel = selectedForecastHour();
        ctx.selTime = sel && sel.cycle_token === cycle ? sel.valid_time : null;
        renderHydrograph(ctx);
    } catch (e) {
        if (mySeq !== ctx.seq) return;
        panel.innerHTML = '<p class="hydrograph-note hydrograph-error">Could not load the forecast hydrograph: '
            + escapeHtml(e.message) + '</p>';
    } finally {
        if (btn && mySeq === ctx.seq) { btn.disabled = false; btn.textContent = 'Show forecast hydrograph'; }
    }
}
