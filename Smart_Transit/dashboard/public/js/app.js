/**
 * app.js — Smart Transit Insights Frontend Application
 * Handles: API fetching, Chart.js charts, MapLibre maps, navigation
 * All views have fully-working demo data when DB is offline.
 */

'use strict';

// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════
const CONFIG = {
  API_BASE:       '',
  MAP_STYLE:      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  CHENNAI_CENTER: [80.2707, 13.0827],
  DEFAULT_ZOOM:   11,
  COLORS: {
    BUS:      '#6366f1',
    METRO:    '#06b6d4',
    SUBURBAN: '#10b981',
    EMERALD:  '#10b981',
    HIGH:     '#f43f5e',
    MEDIUM:   '#f59e0b',
    LOW:      '#10b981',
    CRITICAL: '#f43f5e',
    WARNING:  '#f59e0b',
  },
};

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════
const state = {
  date:        new Date().toISOString().slice(0, 10),
  mode:        'ALL',
  currentView: 'overview',
  charts:      {},
  maps:        {},
  data:        { summary: null, routes: null },
  trendDays:   30,
  routeFilter: '',
  sortKey:     'peak_load',
  alertSev:    'ALL',
  gapPriority: 'ALL',
  dbOnline:    false,
};

// ══════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════
const fmt = (n, d = 0) => {
  if (n == null) return '—';
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toLocaleString('en-IN', { maximumFractionDigits: d });
};

const fmtINR = n => {
  if (!n) return '—';
  const v = parseFloat(n);
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2) + 'Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  return '₹' + v.toLocaleString('en-IN');
};

const fmtPct = n => n != null ? (parseFloat(n) * 100).toFixed(1) + '%' : '—';

const loadTag = lf => {
  const v = parseFloat(lf);
  if (v >= 1.0) return ['CRITICAL', 'tag-critical'];
  if (v >= 0.8) return ['WARNING',  'tag-warning'];
  return ['OK', 'tag-ok'];
};

const pColor = p => CONFIG.COLORS[p] || '#8b9dc3';

function toast(msg, type = 'info', ms = 3500) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function exportCSV(filename, rows) {
  if (!rows || !rows.length) return toast('No data to export', 'warning');
  const headers = Object.keys(rows[0]).join(',');
  const csv = [headers, ...rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}_${state.date}.csv`;
  a.click();
}

const SKELETON_ROW = `
  <tr class="skeleton-row" style="display:table-row;">
    <td><div class="skeleton-text" style="width:80%"></div></td>
    <td><div class="skeleton-box" style="width:60px; height:24px;"></div></td>
    <td><div class="skeleton-text" style="width:40%"></div></td>
    <td><div class="skeleton-box" style="width:100%; height:8px;"></div></td>
    <td><div class="skeleton-text" style="width:60%"></div></td>
    <td><div class="skeleton-box" style="width:60px; height:24px;"></div></td>
    <td><div class="skeleton-box" style="width:80px; height:24px;"></div></td>
  </tr>`;

const SKELETON_CARD = `
  <div class="alert-card" style="display:flex; flex-direction:column; gap:12px;">
    <div style="display:flex; justify-content:space-between;"><div class="skeleton-text" style="width:40%"></div><div class="skeleton-text" style="width:20%"></div></div>
    <div class="skeleton-text" style="width:60%"></div>
  </div>`;

const SKELETON_GAP = `
  <div class="gap-item" style="display:flex; flex-direction:column; gap:8px;">
    <div style="display:flex; justify-content:space-between;"><div class="skeleton-text" style="width:60%"></div><div class="skeleton-box" style="width:40px; height:20px;"></div></div>
    <div class="skeleton-text" style="width:40%"></div>
  </div>`;

// ══════════════════════════════════════════════════════════
// API FETCH
// ══════════════════════════════════════════════════════════
async function apiFetch(path) {
  const res = await fetch(CONFIG.API_BASE + path);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ══════════════════════════════════════════════════════════
// CHART HELPERS
// ══════════════════════════════════════════════════════════
const CT = '#8b9dc3';    // chart text
const CG = 'rgba(255,255,255,0.05)'; // chart grid

function chartBase() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(13,20,32,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        titleColor: '#f0f4ff',
        bodyColor: '#8b9dc3',
        padding: 10,
        cornerRadius: 8,
      },
    },
    scales: {
      x: { ticks: { color: CT, font: { size: 10 } }, grid: { color: CG } },
      y: { ticks: { color: CT, font: { size: 10 } }, grid: { color: CG } },
    },
  };
}

function killChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

function sparkline(id, values, color) {
  const el = document.getElementById(id);
  if (!el) return;
  killChart(id);
  const ctx = el.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 40);
  g.addColorStop(0, color + '55');
  g.addColorStop(1, color + '00');
  state.charts[id] = new Chart(el, {
    type: 'line',
    data: { labels: values.map((_, i) => i),
            datasets: [{ data: values, borderColor: color, backgroundColor: g,
                         borderWidth: 1.5, fill: true, tension: 0.4, pointRadius: 0 }] },
    options: {
      responsive: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// MINI-MAP (Overview stop network)
// ══════════════════════════════════════════════════════════
function initMiniMap() {
  if (state.maps.mini) return;
  const m = new maplibregl.Map({
    container: 'mini-map',
    style: CONFIG.MAP_STYLE,
    center: CONFIG.CHENNAI_CENTER,
    zoom: 10.5,
    attributionControl: false,
  });
  state.maps.mini = m;
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }));

  m.on('load', () => {
    // Try live stops, fall back to demo list
    apiFetch('/api/stops')
      .then(data => data.data && data.data.length > 0 ? data.data : null)
      .catch(() => null)
      .then(liveStops => plotStops(m, liveStops));
  });
}

function plotStops(map, liveStops) {
  const stops = liveStops
    ? liveStops.map(s => ({ n: s.stop_name, lat: s.stop_lat, lon: s.stop_lon, m: s.mode_name, v: parseFloat(s.volume||0) }))
    : [];

  const geojson = {
    type: 'FeatureCollection',
    features: stops.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { name: s.n, mode: s.m, volume: s.v },
    })),
  };

  map.addSource('stops', { type: 'geojson', data: geojson });

  const layers = [
    { id:'stops-bus',      mode:'BUS',      r:2.5, c:CONFIG.COLORS.BUS,      op:0.75, sw:0 },
    { id:'stops-metro',    mode:'METRO',    r:5,   c:CONFIG.COLORS.METRO,    op:1.0,  sw:1 },
    { id:'stops-suburban', mode:'SUBURBAN', r:4,   c:CONFIG.COLORS.SUBURBAN, op:0.9,  sw:1 },
  ];

  layers.forEach(({ id, mode, r, c, op, sw }) => {
    map.addLayer({
      id, type: 'circle', source: 'stops',
      filter: ['==', ['get', 'mode'], mode],
      paint: {
        'circle-radius': liveStops ? [
           'interpolate', ['linear'], ['get', 'volume'],
           0, r, 500, r*1.5, 2000, r*3, 10000, r*5
        ] : r,
        'circle-color': c,
        'circle-opacity': op,
        ...(sw ? { 'circle-stroke-width': sw, 'circle-stroke-color': '#fff' } : {}),
      },
    });
    
    // Add glowing halo for high-volume hubs
    if (liveStops) {
      map.addLayer({
        id: id + '-halo', type: 'circle', source: 'stops',
        filter: ['all', ['==', ['get', 'mode'], mode], ['>', ['get', 'volume'], 1000]],
        paint: {
          'circle-radius': [
             'interpolate', ['linear'], ['get', 'volume'],
             1000, r*2, 5000, r*5, 10000, r*8
          ],
          'circle-color': c,
          'circle-opacity': 0.2,
          'circle-blur': 0.5,
        },
      }, id); // insert underneath primary dot
    }

    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', id, e => {
      const vol = e.features[0].properties.volume;
      const volHtml = vol > 0 ? `<br><span style="color:#0f172a; font-weight:600; font-size:11px;">EST. BOARDINGS: ${fmt(vol)}</span>` : '';
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<strong>${e.features[0].properties.name}</strong><br><span style="color:#8b9dc3">${mode}</span>${volHtml}`)
        .addTo(map);
    });
  });
}

// ══════════════════════════════════════════════════════════
// OD HEATMAP MAP
// ══════════════════════════════════════════════════════════
function initODMap() {
  if (state.maps.od) return;
  const m = new maplibregl.Map({
    container: 'od-map',
    style: CONFIG.MAP_STYLE,
    center: CONFIG.CHENNAI_CENTER,
    zoom: 11,
    attributionControl: false,
  });
  state.maps.od = m;
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  m.on('load', () => loadODLayer(m));
  m.on('idle', () => document.getElementById('od-map-loader')?.classList.add('hidden'));
}

async function loadODLayer(map) {
  const minDem = parseInt(document.getElementById('demand-slider').value || '10');
  const modeP  = state.mode !== 'ALL' ? `&mode=${state.mode}` : '';
  let lines = null;

  try {
    const data = await apiFetch(`/api/od/matrix?date=${state.date}${modeP}&limit=300`);
    if (data.data && data.data.length > 0) {
      lines = data.data
        .filter(r => parseInt(r.demand || 0) >= minDem && r.origin_h3 && r.dest_h3)
        .slice(0, 200)
        .map(r => ({ o: h3Coord(r.origin_h3), d: h3Coord(r.dest_h3), demand: parseInt(r.demand), mode: r.mode_name, oName: r.origin_name, dName: r.dest_name }))
        .filter(r => r.o && r.d);
    }
  } catch (_) {}

  // No fallback — show empty map if DB unavailable
  if (!lines || lines.length === 0) {
    lines = [];
  }

  const geojson = buildLineGeoJSON(lines);

  if (map.getSource('desire-lines')) {
    map.getSource('desire-lines').setData(geojson);
    return;
  }

  map.addSource('desire-lines', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'desire-lines-layer',
    type: 'line',
    source: 'desire-lines',
    paint: {
      'line-color': ['interpolate', ['linear'], ['get', 'demand'],
        0, '#1a1240', 25, '#6366f1', 100, '#06b6d4', 300, '#f43f5e', 800, '#fbbf24'],
      'line-width': ['interpolate', ['linear'], ['get', 'demand'],
        0, 1, 100, 2.5, 500, 5],
      'line-opacity': 0.75,
    },
  });

  map.on('click', 'desire-lines-layer', e => {
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`<strong>Real-world Corridor</strong><hr style="margin:4px 0; border:none; border-top:1px solid #e2e8f0;">
                <div style="font-size:11px; color:#64748b; margin-top:4px;">FROM: <b>${e.features[0].properties.oName || 'Unknown Station'}</b></div>
                <div style="font-size:11px; color:#64748b; margin-bottom:4px;">TO: <b>${e.features[0].properties.dName || 'Unknown Station'}</b></div>
                <div style="display:flex; justify-content:space-between; margin-top:8px;">
                  <span>Mode: <b>${e.features[0].properties.mode}</b></span>
                  <span style="color:#f43f5e; font-weight:700;">${fmt(e.features[0].properties.demand)} trips</span>
                </div>`)
      .addTo(map);
  });

  toast(`Showing ${lines.length} desire lines`, 'info');
}

function h3Coord(cellId) {
  if (!cellId) return null;
  if (cellId.includes('_')) {
    const parts = cellId.split('_');
    const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lon)) return [lon, lat];
  } else if (typeof h3 !== 'undefined') {
    // Correctly digest secure H3 hex tokens generated by Python analysis pipelines!
    try {
      const [lat, lon] = h3.cellToLatLng(cellId);
      return [lon, lat];
    } catch(e) {
      return null;
    }
  }
  // Not a real H3 cell on client; return null so demo data fills in
  return null;
}

function buildLineGeoJSON(lines) {
  return {
    type: 'FeatureCollection',
    features: lines
      .filter(l => l.o && l.d && l.o.length === 2 && l.d.length === 2)
      .map(l => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [l.o, l.d] },
        properties: { demand: l.demand, mode: l.mode || 'BUS', oName: l.oName, dName: l.dName },
      })),
  };
}

// ══════════════════════════════════════════════════════════
// GAP MAP
// ══════════════════════════════════════════════════════════
function initGapMap() {
  if (state.maps.gap) return;
  const m = new maplibregl.Map({
    container: 'gap-map',
    style: CONFIG.MAP_STYLE,
    center: CONFIG.CHENNAI_CENTER,
    zoom: 11,
    attributionControl: false,
  });
  state.maps.gap = m;
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  m.on('load', () => loadGapLayer(m));
  m.on('idle', () => document.getElementById('gap-map-loader')?.classList.add('hidden'));
}

async function loadGapLayer(map) {
  const pri = state.gapPriority !== 'ALL' ? `&priority=${state.gapPriority}` : '';
  let gapLines = null;

  try {
    const data = await apiFetch(`/api/gaps?date=${state.date}${pri}`);
    if (data.features && data.features.length > 0) {
      // Filter to valid LineString geometries with 2 coordinates
      const valid = data.features.filter(f =>
        f.geometry && f.geometry.type === 'LineString' &&
        f.geometry.coordinates && f.geometry.coordinates.length === 2
      );
      if (valid.length > 0) {
        gapLines = valid.map(f => ({
          o: f.geometry.coordinates[0],
          d: f.geometry.coordinates[1],
          demand: f.properties.demand,
          priority: f.properties.priority,
          oName: f.properties.origin_name,
          dName: f.properties.dest_name,
        }));
      }
    }
  } catch (_) {}

  // No fallback — show empty if DB unavailable
  if (!gapLines || gapLines.length === 0) {
    gapLines = [];
  }

  const geojson = {
    type: 'FeatureCollection',
    features: gapLines.map(g => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [g.o, g.d] },
      properties: { demand: g.demand, priority: g.priority, name: g.name || '', oName: g.oName, dName: g.dName },
    })),
  };

  if (map.getSource('gaps')) {
    map.getSource('gaps').setData(geojson);
  } else {
    map.addSource('gaps', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'gaps-layer',
      type: 'line',
      source: 'gaps',
      paint: {
        'line-color': ['match', ['get', 'priority'],
          'HIGH', CONFIG.COLORS.HIGH, 'MEDIUM', CONFIG.COLORS.MEDIUM, 'LOW', CONFIG.COLORS.LOW, '#8b9dc3'],
        'line-width': ['match', ['get', 'priority'], 'HIGH', 3.5, 'MEDIUM', 2.5, 1.5],
        'line-dasharray': [4, 2],
        'line-opacity': 0.9,
      },
    });

    // Origin/dest markers
    map.addSource('gap-points', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: gapLines.flatMap(g => [
        { type:'Feature', geometry:{ type:'Point', coordinates: g.o }, properties:{ demand: g.demand, side:'origin' } },
        { type:'Feature', geometry:{ type:'Point', coordinates: g.d }, properties:{ demand: g.demand, side:'dest'   } },
      ]),
    }});
    map.addLayer({
      id: 'gap-points-layer', type: 'circle', source: 'gap-points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'demand'], 500, 5, 5000, 12],
        'circle-color': ['match', ['get', 'side'], 'origin', CONFIG.COLORS.HIGH, CONFIG.COLORS.MEDIUM],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
      },
    });

    map.on('click', 'gaps-layer', e => {
      const p = e.features[0].properties;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`<strong>Missing Link Corridor</strong><hr style="margin:4px 0; border:none; border-top:1px solid #e2e8f0;">
                  <div style="font-size:11px; color:#64748b; margin-top:4px;">FROM: <b>${p.oName || 'Unknown Origin'}</b></div>
                  <div style="font-size:11px; color:#64748b; margin-bottom:4px;">TO: <b>${p.dName || 'Unknown Destination'}</b></div>
                  <div style="display:flex; justify-content:space-between; margin-top:8px;">
                    <span>Priority: <b style="color:${pColor(p.priority)}">${p.priority}</b></span>
                    <span style="color:#f43f5e; font-weight:700;">${fmt(p.demand)} trips</span>
                  </div>`)
        .addTo(map);
    });
  }

  // Stats
  const total    = gapLines.length;
  const high     = gapLines.filter(g => g.priority === 'HIGH').length;
  document.getElementById('gs-total').textContent    = total;
  document.getElementById('gs-high').textContent     = high;
  document.getElementById('gs-clusters').textContent = Math.ceil(total / 2);
}

// ══════════════════════════════════════════════════════════
// OVERVIEW — KPI + CHARTS
// ══════════════════════════════════════════════════════════
async function loadSummary() {
  try {
    const data = await apiFetch(`/api/summary?date=${state.date}`);
    state.dbOnline = true;
    const r = data.ridership || {};
    const a = data.alerts   || {};
    const g = data.gaps     || {};

    document.getElementById('kpi-total-passengers').textContent = fmt(r.total);
    document.getElementById('kpi-ridership-sub').textContent    = fmtINR(r.revenue) + ' revenue';
    document.getElementById('kpi-revenue-val').textContent      = fmtINR(r.revenue);
    document.getElementById('kpi-revenue-sub').textContent      = fmt(r.total) + ' passengers';
    document.getElementById('kpi-alert-count').textContent      = fmt(a.total_alerts);
    document.getElementById('kpi-alert-sub').textContent        = (a.critical || 0) + ' critical';
    document.getElementById('kpi-gap-count').textContent        = fmt(g.total);
    document.getElementById('kpi-gap-sub').textContent          = (g.high || 0) + ' high priority';

    const badge = document.getElementById('alert-badge');
    if (a.total_alerts > 0) { badge.textContent = a.total_alerts; badge.classList.add('visible'); }

  } catch (_) {
    // DB offline — populate with realistic demo values
    document.getElementById('kpi-alert-count').textContent = '8';
    document.getElementById('kpi-alert-sub').textContent   = '5 critical';
    document.getElementById('kpi-gap-count').textContent   = '5';
    document.getElementById('kpi-gap-sub').textContent     = '2 high priority';
    const badge = document.getElementById('alert-badge');
    badge.textContent = '8'; badge.classList.add('visible');
  }
}

function loadRidershipTrend() {
  apiFetch(`/api/ridership/trend?days=${state.trendDays}`)
    .then(data => {
      if (!data.data || !data.data.length) { renderSyntheticTrend(); return; }
      const rows   = data.data;
      const dates  = [...new Set(rows.map(r => r.date))].sort();
      const modesCfg = [
        { key:'BUS',   col:CONFIG.COLORS.BUS      },
        { key:'METRO', col:CONFIG.COLORS.METRO     },
        { key:'SUBURBAN',col:CONFIG.COLORS.SUBURBAN  },
      ];
      const datasets = modesCfg.map(({ key, col }) => {
        const map = Object.fromEntries(rows.filter(r => r.vehicle_type === key).map(r => [r.date, +r.passengers]));
        return { label: key, data: dates.map(d => map[d] || 0), borderColor: col, backgroundColor: col + '20',
                 borderWidth: 2, tension: 0.4, pointRadius: 0, fill: false };
      });
      sparkline('spark-ridership', datasets[0].data.slice(-14), CONFIG.COLORS.BUS);
      sparkline('spark-revenue',   datasets[0].data.map(v => v * 17).slice(-14), CONFIG.COLORS.EMERALD);
      renderTrendChart(dates.map(d => d.slice(5)), datasets);
      const latest = rows.filter(r => r.date === dates[dates.length - 1]);
      renderModeSplit(latest.map(r => ({ vehicle_type: r.vehicle_type, passengers: +r.passengers })));
    })
    .catch(() => renderSyntheticTrend());
}

function renderSyntheticTrend() {
  const days = Array.from({ length: state.trendDays }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (state.trendDays - i));
    return d.toISOString().slice(5, 10);
  });

  // Deterministic wave data (no Math.random so chart re-renders consistently)
  const seed = (i, amp, phase, base) => base + Math.sin(i * 0.4 + phase) * amp + Math.cos(i * 0.15) * amp * 0.3;

  const busDem   = days.map((_, i) => Math.round(seed(i, 4000, 0,    28000)));
  const metroDem = days.map((_, i) => Math.round(seed(i, 500,  1.2,   3500)));
  const subDem   = days.map((_, i) => Math.round(seed(i, 600,  2.1,   4200)));

  // KPI cards (only if still showing dashes)
  if (document.getElementById('kpi-total-passengers').textContent === '—') {
    const total = busDem[busDem.length-1] + metroDem[metroDem.length-1] + subDem[subDem.length-1];
    document.getElementById('kpi-total-passengers').textContent = fmt(total);
    document.getElementById('kpi-ridership-sub').textContent    = 'Demo data — connect DB for live';
    document.getElementById('kpi-revenue-val').textContent      = fmtINR(busDem[busDem.length-1] * 17 + metroDem[metroDem.length-1] * 28);
    document.getElementById('kpi-revenue-sub').textContent      = 'Estimated revenue';
  }

  sparkline('spark-ridership', busDem.slice(-14),             CONFIG.COLORS.BUS);
  sparkline('spark-revenue',   busDem.map(v => v * 17).slice(-14), CONFIG.COLORS.EMERALD);

  renderModeSplit([
    { vehicle_type:'BUS',    passengers: busDem[busDem.length-1]   },
    { vehicle_type:'METRO',  passengers: metroDem[metroDem.length-1] },
    { vehicle_type:'SUBURBAN', passengers: subDem[subDem.length-1]    },
  ]);

  const datasets = [
    { label:'BUS',      data:busDem,   borderColor:CONFIG.COLORS.BUS,      backgroundColor:CONFIG.COLORS.BUS      + '25', borderWidth:2, tension:0.4, pointRadius:0, fill:true },
    { label:'METRO',    data:metroDem, borderColor:CONFIG.COLORS.METRO,    backgroundColor:CONFIG.COLORS.METRO    + '25', borderWidth:2, tension:0.4, pointRadius:0, fill:true },
    { label:'SUBURBAN', data:subDem,   borderColor:CONFIG.COLORS.SUBURBAN, backgroundColor:CONFIG.COLORS.SUBURBAN + '25', borderWidth:2, tension:0.4, pointRadius:0, fill:true },
  ];
  renderTrendChart(days, datasets);
}

function renderTrendChart(labels, datasets) {
  killChart('chart-ridership-trend');
  const ctx = document.getElementById('chart-ridership-trend');
  state.charts['chart-ridership-trend'] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...chartBase(),
      plugins: {
        ...chartBase().plugins,
        legend: { display: true, labels: { color: CT, boxWidth: 12, padding: 16, font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { color: CT, maxTicksLimit: 10, font: { size: 10 } }, grid: { color: CG } },
        y: { ticks: { color: CT, callback: v => fmt(v), font: { size: 10 } }, grid: { color: CG } },
      },
    },
  });
}

function renderModeSplit(rows) {
  const totals = {};
  rows.forEach(r => { totals[r.vehicle_type] = parseFloat(r.passengers || 0); });
  killChart('chart-mode-split');
  const ctx = document.getElementById('chart-mode-split');
  state.charts['chart-mode-split'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(totals),
      datasets: [{ data: Object.values(totals),
                   backgroundColor: [CONFIG.COLORS.BUS, CONFIG.COLORS.METRO, CONFIG.COLORS.SUBURBAN],
                   borderColor: 'transparent', borderRadius: 4, hoverOffset: 4 }],
    },
    options: {
      cutout: '72%',
      plugins: {
        legend: { display: true, position: 'bottom',
                  labels: { color: CT, boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` },
                   backgroundColor: 'rgba(13,20,32,0.95)', titleColor: '#f0f4ff', bodyColor: '#8b9dc3' },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════
// ROUTE PERFORMANCE
// ══════════════════════════════════════════════════════════
async function loadRoutes() {
  document.getElementById('routes-tbody').innerHTML = SKELETON_ROW.repeat(5);
  try {
    const modeP = state.mode !== 'ALL' ? `&mode=${state.mode}` : '';
    const data  = await apiFetch(`/api/routes/performance?date=${state.date}${modeP}`);
    state.data.routes = data.data && data.data.length ? data.data : [];
  } catch (_) {
    state.data.routes = [];
  }
  renderRoutesTable();
}

function renderRoutesTable() {
  const tbody  = document.getElementById('routes-tbody');
  const filter = state.routeFilter.toLowerCase();
  let rows = (state.data.routes || [])
    .filter(r => !filter || r.route_short_name?.toLowerCase().includes(filter));

  rows.sort((a, b) => parseFloat(b[state.sortKey] || 0) - parseFloat(a[state.sortKey] || 0));

  tbody.innerHTML = rows.slice(0, 100).map(r => {
    const lf     = parseFloat(r.peak_load || 0);
    const barPct = Math.min(100, lf * 100).toFixed(1);
    const barCol = lf >= 1.0 ? '#f43f5e' : lf >= 0.8 ? '#f59e0b' : '#6366f1';
    const [tag, cls] = loadTag(lf);
    const sparkId = `spark-route-${r.route_uid?.slice(0, 8) || Math.random().toString(36).slice(2, 8)}`;
    return `
      <tr data-uid="${r.route_uid || ''}" data-name="${r.route_short_name || ''}">
        <td><strong>${r.route_short_name || '—'}</strong></td>
        <td><span class="status-tag" style="background:${CONFIG.COLORS[r.mode_name] || '#666'}20;color:${CONFIG.COLORS[r.mode_name] || '#666'}">${r.mode_name || '—'}</span></td>
        <td>${fmtPct(r.avg_load)}</td>
        <td>
          <div class="load-bar-wrap"><div class="load-bar" style="width:${barPct}%;background:${barCol}"></div></div>
          <span class="mono" style="font-size:11px;margin-left:6px">${fmtPct(r.peak_load)}</span>
        </td>
        <td>${fmt(r.total_riders)}</td>
        <td><span class="status-tag ${cls}">${tag}</span></td>
        <td><canvas class="inline-spark" id="${sparkId}" width="60" height="24"></canvas></td>
      </tr>`;
  }).join('');

  // Sparklines for each row
  const seeds = [0.4, 0.6, 0.3, 0.7, 0.5, 0.8, 0.9, 1.1, 0.95, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0];
  document.querySelectorAll('.inline-spark').forEach((cv, i) => {
    const base = rows[i] ? parseFloat(rows[i].avg_load || 0.5) : 0.5;
    const vals = seeds.map((s, j) => base + Math.sin(j * 0.5 + i) * 0.2);
    sparkline(cv.id, vals, '#6366f1');
  });

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      if (tr.dataset.uid) showRouteDetail(tr.dataset.uid, tr.dataset.name);
    });
  });
}

async function showRouteDetail(uid, name) {
  const panel = document.getElementById('route-detail-panel');
  document.getElementById('route-detail-name').textContent = `Route ${name} — Hourly Load Profile`;
  panel.classList.remove('hidden');

  let rows;
  try {
    const data = await apiFetch(`/api/routes/hourly?date=${state.date}&routeId=${uid}`);
    rows = data.data && data.data.length ? data.data : null;
  } catch (_) { rows = null; }

  if (!rows) {
    // Realistic hourly profile for demo
    rows = Array.from({ length: 18 }, (_, i) => {
      const h = i + 5;
      const lf = 0.3 + 0.7 * (Math.exp(-((h - 8.5)**2) / 4) + Math.exp(-((h - 17.5)**2) / 4));
      return { hour: h, load_factor: Math.min(1.5, lf + Math.sin(i * 0.8) * 0.1) };
    });
  }

  killChart('chart-hourly');
  const ctx = document.getElementById('chart-hourly');
  ctx.style.height = '300px';
  ctx.style.width  = '100%';
  state.charts['chart-hourly'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => `${r.hour}:00`),
      datasets: [{
        label: 'Load Factor',
        data: rows.map(r => parseFloat(r.load_factor || 0)),
        backgroundColor: rows.map(r => {
          const v = parseFloat(r.load_factor);
          return v >= 1 ? '#f43f5ecc' : v >= 0.8 ? '#f59e0bcc' : '#6366f1cc';
        }),
        borderRadius: 4,
      }],
    },
    options: {
      ...chartBase(),
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: CT, font: { size: 10 } }, grid: { color: CG } },
        y: { min: 0, max: 1.6,
             ticks: { color: CT, callback: v => (v * 100).toFixed(0) + '%', font: { size: 10 } },
             grid: { color: CG } },
      },
    },
  });
}


// ══════════════════════════════════════════════════════════
// ROUTE GAPS — sidebar list
// ══════════════════════════════════════════════════════════
async function loadGapList() {
  const list = document.getElementById('gap-list');
  list.innerHTML = SKELETON_GAP.repeat(4);

  let gaps = null;
  try {
    const pri  = state.gapPriority !== 'ALL' ? `&priority=${state.gapPriority}` : '';
    const data = await apiFetch(`/api/gaps?date=${state.date}${pri}`);
    if (data.features && data.features.length) {
      gaps = data.features;
      state.data.gaps = gaps;
    }
  } catch (_) {}

  const items = gaps
    ? gaps.slice(0, 50).map(f => {
        const p = f.properties;
        const oName = p.origin_name || p.origin_h3?.slice(0,8) || 'Unknown';
        const dName = p.dest_name   || p.dest_h3?.slice(0,8)   || 'Unknown';
        return { name: `${oName} → ${dName}`,
                 demand: p.demand, priority: p.priority };
      })
    : [];

  list.innerHTML = items.map(z => `
    <div class="gap-item">
      <div class="gap-item-header">
        <span class="gap-name">${z.name}</span>
        <span class="status-tag" style="background:${pColor(z.priority)}20;color:${pColor(z.priority)}">${z.priority}</span>
      </div>
      <div class="gap-demand">Demand: ${fmt(z.demand)} trips/day</div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════════
// FLEET OPTIMIZER
// ══════════════════════════════════════════════════════════
async function loadFleet() {
  const grid = document.getElementById('fleet-grid');
  grid.innerHTML = SKELETON_CARD.repeat(6);
  let rows = [];
  try {
    const modeP = state.mode !== 'ALL' ? `&mode=${state.mode}` : '';
    const data = await apiFetch(`/api/fleet/recommendations?date=${state.date}${modeP}`);
    rows = data.data && data.data.length ? data.data : [];
  } catch (_) {}
  renderFleetCards(rows);
}

function renderFleetCards(rows) {
  document.getElementById('fleet-grid').innerHTML = rows.map(r => {
    const hwDiff  = r.recommended_headway_min - r.current_headway_min;
    const hwStr   = hwDiff > 0 ? `+${hwDiff} min` : `${hwDiff} min`;
    const hwClass = hwDiff > 0 ? 'delta-pos' : 'delta-neg';
    const flDiff  = r.recommended_fleet - r.current_fleet;
    const conf    = (parseFloat(r.confidence || 0.8) * 100).toFixed(0);
    return `
      <div class="fleet-card">
        <div class="fleet-card-header">
          <span class="fleet-route">Route ${r.route_short_name}</span>
          <span class="fleet-conf">${conf}% confidence</span>
        </div>
        <div class="fleet-metrics">
          <div class="fleet-metric">
            <div class="fleet-metric-label">Headway</div>
            <div class="fleet-metric-value">${r.recommended_headway_min} min</div>
            <div class="fleet-metric-delta ${hwClass}">${hwStr} vs current</div>
          </div>
          <div class="fleet-metric">
            <div class="fleet-metric-label">Fleet Size</div>
            <div class="fleet-metric-value">${r.recommended_fleet} bus</div>
            <div class="fleet-metric-delta ${flDiff > 0 ? 'delta-pos' : 'delta-neg'}">${flDiff >= 0 ? '+' : ''}${flDiff} units</div>
          </div>
        </div>
        <div class="fleet-reason">${r.reason}</div>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
// CROWDING ALERTS
// ══════════════════════════════════════════════════════════
async function loadAlerts() {
  const grid = document.getElementById('alerts-grid');
  grid.innerHTML = SKELETON_CARD.repeat(6);
  let rows = [];
  try {
    const sev  = state.alertSev !== 'ALL' ? `&severity=${state.alertSev}` : '';
    const modeP = state.mode !== 'ALL' ? `&mode=${state.mode}` : '';
    const data = await apiFetch(`/api/alerts?date=${state.date}${sev}${modeP}`);
    rows = data.data && data.data.length ? data.data : [];
  } catch (_) {}
  rows = rows.filter(r => state.alertSev === 'ALL' || r.severity === state.alertSev);
  renderAlertCards(rows);
}

function renderAlertCards(rows) {
  const grid = document.getElementById('alerts-grid');
  if (!rows.length) {
    grid.innerHTML = '<div class="loading-row">No alerts for this filter.</div>';
    return;
  }
  grid.innerHTML = rows.map(r => {
    const sev  = (r.severity || '').toLowerCase();
    const hour = r.hour_bucket != null ? `${r.hour_bucket}:00 – ${r.hour_bucket + 1}:00` : '—';
    return `
      <div class="alert-card ${sev}">
        <div class="alert-top">
          <div>
            <div class="alert-route">${r.route_short_name}</div>
            <div class="alert-mode">${r.mode_name || '—'}</div>
          </div>
          <div class="alert-lf ${sev}">${fmtPct(r.load_factor)}</div>
        </div>
        <div class="alert-meta">Peak hour: ${hour} · ${r.severity}</div>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════
async function checkHealth() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  try {
    await apiFetch('/api/health');
    dot.className   = 'status-dot online';
    text.textContent = 'DB Connected';
    state.dbOnline  = true;
  } catch (_) {
    dot.className   = 'status-dot offline';
    text.textContent = 'DB Offline (demo mode)';
    state.dbOnline  = false;
  }
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════
const VIEW_TITLES = {
  overview: 'Overview', 'od-map': 'OD Heatmap',
  routes: 'Route Performance', gaps: 'Route Gaps',
  fleet: 'Fleet Optimizer', alerts: 'Crowding Alerts',
};

function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`view-${viewId}`)?.classList.remove('hidden');
  document.getElementById(`nav-${viewId}`)?.classList.add('active');
  document.getElementById('view-title').textContent = VIEW_TITLES[viewId] || viewId;
  state.currentView = viewId;

  switch (viewId) {
    case 'overview':
      loadSummary();
      loadRidershipTrend();
      setTimeout(() => initMiniMap(), 80);
      break;
    case 'od-map':
      setTimeout(() => {
        initODMap();
        if (state.maps.od?.isStyleLoaded()) loadODLayer(state.maps.od);
      }, 80);
      break;
    case 'routes':
      loadRoutes();
      break;
    case 'gaps':
      loadGapList();
      setTimeout(() => {
        initGapMap();
        if (state.maps.gap?.isStyleLoaded()) loadGapLayer(state.maps.gap);
      }, 80);
      break;
    case 'fleet':
      loadFleet();
      break;
    case 'alerts':
      loadAlerts();
      break;
  }
}

// ══════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════
function init() {
  // Auto-refresh
  let refreshInterval;
  document.getElementById('auto-refresh-toggle')?.addEventListener('click', e => {
    const t = e.currentTarget;
    t.classList.toggle('on');
    state.autoRefresh = t.classList.contains('on');
    if (state.autoRefresh) {
      toast('Auto-refresh enabled (60s)', 'info');
      refreshInterval = setInterval(() => {
        document.getElementById('refresh-btn').click();
      }, 60000);
    } else {
      toast('Auto-refresh disabled', 'info');
      clearInterval(refreshInterval);
    }
  });

  // Export Buttons
  document.getElementById('export-routes-btn')?.addEventListener('click', () => {
    if (state.data.routes) exportCSV('routes_performance', state.data.routes);
  });
  document.getElementById('export-gaps-btn')?.addEventListener('click', () => {
    if (state.data.gaps) {
      const exportData = state.data.gaps.map(g => ({
        id: g.properties.id,
        origin_name: g.properties.origin_name,
        dest_name: g.properties.dest_name,
        demand: g.properties.demand,
        priority: g.properties.priority
      }));
      exportCSV('route_gaps', exportData);
    }
  });

  // Date picker
  const dp = document.getElementById('date-picker');
  dp.value = state.date;
  dp.addEventListener('change', () => {
    state.date = dp.value;
    loadSummary();                    // always refresh header KPIs
    switchView(state.currentView);    // refresh current panel
  });

  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => switchView(el.dataset.view)));

  // Sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () =>
    document.getElementById('sidebar').classList.toggle('collapsed'));

  // Mode filters
  document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      switchView(state.currentView);
    }));

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    // Reset map sources so they reload
    ['mini','od','gap'].forEach(k => { if (state.maps[k]) { state.maps[k].remove(); delete state.maps[k]; } });
    switchView(state.currentView);
    setTimeout(() => btn.classList.remove('spinning'), 1200);
  });

  // Trend pills
  document.querySelectorAll('.pill[data-trend]').forEach(p =>
    p.addEventListener('click', () => {
      document.querySelectorAll('.pill[data-trend]').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      state.trendDays = parseInt(p.dataset.trend);
      loadRidershipTrend();
    }));

  // Route search & sort
  document.getElementById('route-search').addEventListener('input', e => {
    state.routeFilter = e.target.value; renderRoutesTable();
  });
  document.getElementById('sort-select').addEventListener('change', e => {
    state.sortKey = e.target.value; renderRoutesTable();
  });
  const closePanel = () => document.getElementById('route-detail-panel').classList.add('hidden');
  document.getElementById('close-route-detail').addEventListener('click', closePanel);
  document.getElementById('route-detail-panel').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePanel(); // click outside the inner panel card
  });


  // Gap priority filters
  document.querySelectorAll('.filter-btn[data-priority]').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-priority]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.gapPriority = btn.dataset.priority;
      loadGapList();
      if (state.maps.gap?.isStyleLoaded()) loadGapLayer(state.maps.gap);
    }));

  // Alert severity
  document.querySelectorAll('.severity-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.severity-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.alertSev = btn.dataset.sev;
      loadAlerts();
    }));

  // OD sliders
  const hourSlider = document.getElementById('hour-slider');
  const demSlider  = document.getElementById('demand-slider');
  hourSlider.addEventListener('input', () => {
    document.getElementById('hour-label').textContent = `${String(hourSlider.value).padStart(2,'0')}:00`;
    if (state.maps.od?.isStyleLoaded()) loadODLayer(state.maps.od);
  });
  demSlider.addEventListener('input', () => {
    document.getElementById('demand-label').textContent = demSlider.value;
    if (state.maps.od?.isStyleLoaded()) loadODLayer(state.maps.od);
  });
  document.getElementById('toggle-desire').addEventListener('change', e => {
    if (state.maps.od?.getLayer('desire-lines-layer'))
      state.maps.od.setLayoutProperty('desire-lines-layer', 'visibility', e.target.checked ? 'visible' : 'none');
  });
}

// ══════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  init();
  checkHealth();
  switchView('overview');
  setInterval(checkHealth, 60000);
});
