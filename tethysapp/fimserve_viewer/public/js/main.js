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
