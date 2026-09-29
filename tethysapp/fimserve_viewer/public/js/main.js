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
        if (hydroData) renderHydrograph();
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
        floodUIMapRequestSeq++;
        if (floodOverlayLayer) {
            map.removeLayer(floodOverlayLayer);
            floodOverlayLayer = null;
        }
        clearFloodQLabelLayer();
        hideFloodLegend();
    }
    lastSidebarHuc8 = huc8Code;
    clearHydrograph();

    sidebar.classList.add('open');

    // Tethys-served partner-logo URLs are injected from home.html into window.APP_STATIC.
    const APP_STATIC = (typeof window !== 'undefined' && window.APP_STATIC) ? window.APP_STATIC : {};
    const byuLogoUrl = APP_STATIC.byuLogo || '';
    const cirohLogoUrl = APP_STATIC.cirohLogo || '';
    const tgfLogoUrl = APP_STATIC.tgfLogo || '';

    const covered = isHuc8Covered(properties);
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
            </div>` : `
            <div style="padding: 15px; background: #fdf0ed; border: 1px solid #f5c6b8; border-radius: 8px; margin-top: 10px;">
                <strong style="color: #c0392b;">No FIM coverage</strong>
                <p style="font-size: 12px; color: #7f8c8d; margin-top: 6px;">HAND-FIM data is not available for this HUC8, so a flood map cannot be generated here. Coverage is limited to the CONUS watersheds in the OWP HAND-FIM dataset.</p>
            </div>`;

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
                    <button type="button" id="hydro-unit-m3s" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? '' : ' is-active'}" onclick="setHydrographUnits(false)">m&sup3;/s</button>
                    <button type="button" id="hydro-unit-cfs" class="hydrograph-unit-btn${showFloodDischargeInFt3s ? ' is-active' : ''}" onclick="setHydrographUnits(true)">ft&sup3;/s</button>
                </div>
            </div>
            <div id="hydrograph-panel" class="hydrograph-panel">
                <p class="hydrograph-note">Generate a flood map for this watershed first &mdash; the discharge series is built from that run's river reaches.</p>
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
        
        <div class="info-section">
            <h3>Generate Flood Map with NWM Data</h3>
            ${generateSection}
        </div>

        ${hydrographSection}

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
    if (covered) reattachActiveFloodJob(huc8Code);
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
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const err = await response.json().catch(() => ({ message: response.statusText }));
            statusDiv.innerHTML = '<span style="color: #e74c3c;">' + (err.message || 'Download failed') + '</span>';
            return;
        }
        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = huc8 + '_' + dateStr + '_reclassified.tif';
        a.click();
        URL.revokeObjectURL(a.href);
        statusDiv.innerHTML = '<span style="color: #27ae60;">✓ Processed map downloaded</span>';
    } catch (error) {
        statusDiv.innerHTML = '<span style="color: #e74c3c;">Error: ' + error.message + '</span>';
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
        const hucBounds = getBoundsForHUC8(huc8);
        if (hucBounds) map.fitBounds(hucBounds, { maxZoom: 14, padding: [30, 30] });
        showFloodLegend();
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

function showFloodLegend() {
    const el = document.getElementById('flood-legend');
    if (el) el.style.display = 'block';
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

async function loadFloodQLabelsNwm(huc8, dateStr, expectSeq) {
    clearFloodQLabelLayer();
    try {
        const r = await fetch('./api/flood-q-labels/nwm/' + encodeURIComponent(huc8) + '/' + encodeURIComponent(dateStr) + '/');
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
// Hydrograph panel (issue #25)
// -----------------------------------------------------------------------------
// Discharge time series for the selected watershed, drawn as inline SVG so the
// app keeps its no-build-step, no-chart-library footing. Clicking the plot
// writes the chosen hour back into the date/time inputs, which is what makes
// the time input purposeful instead of arbitrary.
// Backed by GET api/get-hydrograph/{huc8}/{date_str}.
// =============================================================================

/** Plot geometry in viewBox units. PAD_B is deeper than the rest: the x-axis carries time labels. */
const HYDRO_W = 420, HYDRO_H = 180, HYDRO_PAD = 34, HYDRO_PAD_B = 40;
const HYDRO_PLOT_W = HYDRO_W - HYDRO_PAD * 2;
const HYDRO_PLOT_H = HYDRO_H - HYDRO_PAD - HYDRO_PAD_B;

/** Series currently plotted: {times, values} with values in m³/s, or null. */
let hydroData = null;
/** Selected moment as an ISO string. The TIMESTAMP is the source of truth, not its
 *  array index — index 32 is a different hour in a 49-point series than a 337-point one. */
let hydroSelTime = null;
/** Bumped per request so a slow response for an old watershed can't overwrite a newer one. */
let hydroRequestSeq = 0;
/** Half-width of the fetched span, in days. #40 found ±1 (and even ±7 on one
 *  watershed) can clip the real peak at the window edge, while the teehr fetch
 *  is dominated by per-request overhead — a 30x wider window cost only ~46%
 *  more time. ±14 gives real events room to show their full shape without
 *  waiting for a full ±30 fetch by default. Persists across watersheds so it
 *  reads as a preference rather than a per-click setting. */
let hydroWindowDays = 14;

/** Reflect the current unit in the two-button toggle. */
function syncHydrographUnitButtons() {
    const m3 = document.getElementById('hydro-unit-m3s');
    const cfs = document.getElementById('hydro-unit-cfs');
    if (m3) m3.classList.toggle('is-active', !showFloodDischargeInFt3s);
    if (cfs) cfs.classList.toggle('is-active', showFloodDischargeInFt3s);
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
    if (hydroData) renderHydrograph();   // redraw only; no refetch, units are display-only
}

/** Changing the span needs a new fetch — the window is applied server-side. */
function setHydrographWindow(days, huc8) {
    const n = parseInt(days, 10);
    hydroWindowDays = Math.max(1, Math.min(30, isNaN(n) ? 14 : n));
    if (hydroData) loadHydrograph(huc8);
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

function buildHydrographSvg(selIdx) {
    const times = hydroData.times;
    const n = times.length;
    const values = [];
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
        const v = hydroDisplayValue(hydroData.values[i]);
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

    let ticks = '';
    const tickIdx = hydroChooseTicks(times);
    for (let k = 0; k < tickIdx.length; k++) {
        const x = hydroScaleX(tickIdx[k], n).toFixed(1);
        ticks += '<line x1="' + x + '" y1="' + HYDRO_PAD + '" x2="' + x + '" y2="' + baseY + '" stroke="#f0f0f0"/>'
              +  '<line x1="' + x + '" y1="' + baseY + '" x2="' + x + '" y2="' + (baseY + 4) + '" stroke="#bbb"/>'
              +  '<text x="' + x + '" y="' + (baseY + 16) + '" font-size="9" fill="#666" text-anchor="middle">'
              +  escapeHtml(hydroTickLabel(times[tickIdx[k]])) + '</text>';
    }

    const mx = hydroScaleX(selIdx, n);
    const my = hydroScaleY(values[selIdx], min, max);
    const split = hydroSplitTimestamp(times[selIdx]);
    const anchor = mx > HYDRO_W * 0.6 ? 'end' : 'start';
    const labelX = (anchor === 'end' ? mx - 6 : mx + 6).toFixed(1);

    return '<svg id="hydrograph-svg" viewBox="0 0 ' + HYDRO_W + ' ' + HYDRO_H + '"'
        + ' tabindex="0" role="slider" aria-label="Selected hour on the discharge time series"'
        + ' aria-valuemin="0" aria-valuemax="' + (n - 1) + '" aria-valuenow="' + selIdx + '"'
        + ' aria-valuetext="' + escapeHtml(split[0] + ' ' + split[1] + ', ' + values[selIdx].toFixed(2) + ' ' + unit) + '">'
        + ticks
        + '<line x1="' + HYDRO_PAD + '" y1="' + baseY + '" x2="' + (HYDRO_PAD + HYDRO_PLOT_W) + '" y2="' + baseY + '" stroke="#ccc"/>'
        + '<line x1="' + HYDRO_PAD + '" y1="' + HYDRO_PAD + '" x2="' + HYDRO_PAD + '" y2="' + baseY + '" stroke="#ccc"/>'
        + '<polyline points="' + pts.trim() + '" fill="none" stroke="#2980b9" stroke-width="2"/>'
        + '<line x1="' + mx.toFixed(1) + '" y1="' + HYDRO_PAD + '" x2="' + mx.toFixed(1) + '" y2="' + baseY + '" stroke="#e67e22" stroke-width="1" stroke-dasharray="3 2"/>'
        + '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="4" fill="#e67e22" stroke="#fff" stroke-width="1.5"/>'
        + '<text x="' + labelX + '" y="' + (HYDRO_PAD + 11) + '" font-size="10" fill="#e67e22" text-anchor="' + anchor + '">' + escapeHtml(split[0] + ' ' + split[1]) + '</text>'
        + '<text x="' + labelX + '" y="' + (HYDRO_PAD + 23) + '" font-size="10" fill="#e67e22" text-anchor="' + anchor + '">' + escapeHtml(values[selIdx].toFixed(2) + ' ' + unit) + '</text>'
        + '<text x="' + (HYDRO_PAD - 4) + '" y="' + (HYDRO_PAD + 3) + '" font-size="9" fill="#666" text-anchor="end">' + escapeHtml(max.toFixed(2)) + '</text>'
        + '<text x="' + (HYDRO_PAD - 4) + '" y="' + (baseY + 3) + '" font-size="9" fill="#666" text-anchor="end">' + escapeHtml(min.toFixed(2)) + '</text>'
        + '<text x="2" y="' + (HYDRO_PAD - 10) + '" font-size="9" fill="#888">' + unit + '</text>'
        + '</svg>';
}

function applyHydrographSelectionToInputs() {
    if (!hydroSelTime) return;
    const split = hydroSplitTimestamp(hydroSelTime);
    const dateInput = document.getElementById('flood-date-input');
    const timeInput = document.getElementById('flood-time-input');
    if (dateInput) dateInput.value = split[0];
    if (timeInput) timeInput.value = split[1];
}

/** Move the selection by whole samples. Arrow keys are the only way to land on an
 *  exact hour once the span is wide enough that samples sit under a pixel apart. */
function stepHydrographSelection(delta) {
    if (!hydroData) return;
    const times = hydroData.times;
    const idx = hydroIndexForTime(times, hydroSelTime);
    const next = Math.max(0, Math.min(times.length - 1, idx + delta));
    if (next === idx) return;
    hydroSelTime = times[next];
    applyHydrographSelectionToInputs();
    renderHydrograph();
}

function handleHydrographKey(evt) {
    if (!hydroData) return;
    const big = 24;                       // a day's worth of hourly samples
    let delta = null, jumpTo = null;
    switch (evt.key) {
        case 'ArrowLeft':  delta = evt.shiftKey ? -big : -1; break;
        case 'ArrowRight': delta = evt.shiftKey ?  big :  1; break;
        case 'PageDown':   delta = -big; break;
        case 'PageUp':     delta =  big; break;
        case 'Home':       jumpTo = 0; break;
        case 'End':        jumpTo = hydroData.times.length - 1; break;
        default: return;
    }
    evt.preventDefault();                 // stop the sidebar scrolling instead
    if (jumpTo !== null) {
        hydroSelTime = hydroData.times[jumpTo];
        applyHydrographSelectionToInputs();
        renderHydrograph();
    } else {
        stepHydrographSelection(delta);
    }
}

function renderHydrograph() {
    const panel = document.getElementById('hydrograph-panel');
    if (!panel) return;
    if (!hydroData || !hydroData.times || hydroData.times.length < 2) {
        panel.innerHTML = '<p class="hydrograph-note">Not enough data to plot a series.</p>';
        return;
    }
    const times = hydroData.times;
    const selIdx = hydroIndexForTime(times, hydroSelTime);
    hydroSelTime = times[selIdx];

    // Redrawing replaces the SVG node, so focus would be lost on every keypress.
    const prevSvg = document.getElementById('hydrograph-svg');
    const hadFocus = !!prevSvg && document.activeElement === prevSvg;

    panel.innerHTML = buildHydrographSvg(selIdx)
        + '<p class="hydrograph-note">' + times.length + ' hourly samples, '
        + escapeHtml(String(times[0]).slice(0, 10)) + ' to '
        + escapeHtml(String(times[times.length - 1]).slice(0, 10))
        + ' (\u00b1' + hydroWindowDays + (hydroWindowDays === 1 ? ' day' : ' days')
        + '). Click the plot to set the date and time, then use \u2190 \u2192 to step hour by hour '
        + '(hold Shift for a day, Home/End for the ends).</p>';

    const svg = document.getElementById('hydrograph-svg');
    if (!svg) return;
    svg.addEventListener('click', function (evt) {
        if (!hydroData) return;
        const idx = hydroIndexFromX(hydroViewBoxX(evt, svg), hydroData.times.length);
        hydroSelTime = hydroData.times[idx];
        applyHydrographSelectionToInputs();
        svg.focus({ preventScroll: true });   // so the arrow keys work straight after a click
        renderHydrograph();
    });
    svg.addEventListener('keydown', handleHydrographKey);
    if (hadFocus) svg.focus({ preventScroll: true });
}

/** Drop any plotted series — called when the sidebar switches watershed. */
function clearHydrograph() {
    hydroRequestSeq++;
    hydroData = null;
    hydroSelTime = null;
}

async function loadHydrograph(huc8) {
    const panel = document.getElementById('hydrograph-panel');
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
    const mySeq = ++hydroRequestSeq;
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    panel.innerHTML = '<p class="hydrograph-note">Fetching NWM streamflow — this usually takes about 15 seconds.</p>';

    try {
        const r = await fetch('./api/get-hydrograph/' + encodeURIComponent(huc8) + '/'
            + encodeURIComponent(dateStr) + '/?days=' + encodeURIComponent(hydroWindowDays));
        if (mySeq !== hydroRequestSeq) return;
        const data = await r.json();
        if (mySeq !== hydroRequestSeq) return;

        if (!r.ok || data.status !== 'success' || !data.times || !data.times.length) {
            // The endpoint raises FileNotFoundError before a watershed has been
            // generated, because it needs that run's feature_IDs.csv.
            panel.innerHTML = '<p class="hydrograph-note hydrograph-error">'
                + escapeHtml(data.message || 'No streamflow data available for this watershed and date.')
                + '</p>';
            return;
        }

        hydroData = { times: data.times, values: data.values };
        // The API echoes the requested moment as "YYYY-MM-DD HH:MM:SS"; the series
        // uses ISO "T" form, so normalise before matching it to a sample.
        hydroSelTime = data.datetime ? String(data.datetime).replace(' ', 'T') : data.times[0];
        renderHydrograph();
    } catch (e) {
        if (mySeq !== hydroRequestSeq) return;
        panel.innerHTML = '<p class="hydrograph-note hydrograph-error">Could not load the hydrograph: '
            + escapeHtml(e.message) + '</p>';
    } finally {
        if (btn && mySeq === hydroRequestSeq) { btn.disabled = false; btn.textContent = 'Show hydrograph'; }
    }
}

function clearFloodLayer() {
    floodUIMapRequestSeq++;
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
    if (result && result.datetime) {
        lines.push('<strong>When:</strong> ' + floodSuccessEscapeHtml(String(result.datetime)));
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

function setFloodStatus(html) {
    const statusDiv = document.getElementById('flood-map-status');
    if (statusDiv) statusDiv.innerHTML = html;
}

function setGenerateButtonBusy(busy) {
    const btn = document.getElementById('generate-flood-map-btn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Generating…' : 'Generate Flood Map';
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
    return {
        file_name: job.result_file ? job.result_file.split('/').pop() : '',
        datetime: job.params ? job.params.datetime_str : '',
    };
}

async function submitFloodJob(payload) {
    const result = await fetchJobJson('./api/jobs/generate-flood-map/', {
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
    floodGenerateOverlayHide();
    if (job.status !== 'success') {
        setFloodStatus(`<span style="color: #e74c3c;">Error: ${job.message || job.status}</span>`);
        return;
    }
    const summary = floodJobResultSummary(job);
    const fileLine = summary.file_name ? `<br><span style="font-size: 11px;">File: ${summary.file_name}</span>` : '';
    setFloodStatus(`<span style="color: #27ae60;">✓ Flood map generated successfully!</span>${fileLine}`);
    loadHydrograph(huc8);
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            showFloodSuccessModal(huc8, summary);
        });
    });
}

async function watchFloodJob(huc8, job) {
    const abortController = new AbortController();
    currentFloodGenerateAbort = abortController;
    setGenerateButtonBusy(true);
    floodGenerateOverlayShow(job.message || 'Generating flood map…');
    try {
        finishFloodJob(huc8, await pollFloodJob(job.job_id, abortController));
    } catch (error) {
        floodGenerateOverlayHide();
        if (error && error.name === 'AbortError') {
            setFloodStatus('<span style="color: #64748b;">Stopped watching — the generation keeps running on the server.</span>');
        } else {
            console.error('Error watching flood job:', error);
            setFloodStatus(`<span style="color: #e74c3c;">Error: ${error.message}</span>`);
        }
    } finally {
        currentFloodGenerateAbort = null;
        setGenerateButtonBusy(false);
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
        const job = await submitFloodJob({ huc8: huc8, date: date, time: time });
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
            setFloodStatus('<span style="color: #3498db;">A generation for this watershed is already running…</span>');
            await watchFloodJob(huc8, result.job);
        }
    } catch (error) {
        console.error('Could not check for an active job:', error);
    }
}
