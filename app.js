// Rabat Transit 3D - Real-time Transit Visualization
const OTP_ENDPOINT = 'https://rrm.transitloop.net/otp/routers/default/index/graphql';
const DATA_SNAPSHOT = {
    routes: 'data/routes.json',
    stops: 'data/stops.json',
    trips: 'data/trips.json',
    sun: 'data/sun.json'
};

const RABAT_CENTER = [-6.8498, 34.0209];
const INITIAL_ZOOM = 14;
const INITIAL_PITCH = 60;
const INITIAL_BEARING = -20;

const ROUTE_COLORS = {
    tram: '#e91e63',
    bus: '#2196f3',
    train: '#ff9800',
    default: '#9e9e9e'
};

let map;
let routes = [];
let stops = [];
let patterns = [];
let trips = [];
let vehicles = [];
let simulationTime = 0;
let isPlaying = false;
let simulationSpeed = 1;
let visibleTypes = { tram: true, bus: true, train: true };
let animationFrameId = null;
let lastFrameTs = 0;
let lastVehicleUpdateTs = 0;
let followWallClock = true;
let mapTheme = 'day';
let themePreference = 'auto';
let sunTimes = { sunriseSec: 6 * 3600, sunsetSec: 19 * 3600, dateStr: '', source: 'fallback' };
let themeSwitchTimer = null;
let interactionsReady = false;

const MAP_STYLE = 'mapbox://styles/mapbox/standard';

const SUN_API_URL = 'https://api.sunrise-sunset.org/v2';
const RABAT_TZ = 'Africa/Casablanca';
const THEME_STORAGE_KEY = 'rabat-transit-theme';

function resolveMapboxToken() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('token');
    if (fromQuery && fromQuery.trim()) return fromQuery.trim();

    const fromEnv = window.MAPBOX_ACCESS_TOKEN;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

    return '';
}

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dateToSecondsSinceMidnight(date) {
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function formatClock(seconds) {
    const hours = Math.floor(seconds / 3600) % 24;
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function computeApproximateSunTimes(lat, lon, date) {
    const radians = Math.PI / 180;
    const start = Date.UTC(date.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);

    const eventUtcHours = (sunrise) => {
        const lngHour = lon / 15;
        const t = dayOfYear + ((sunrise ? 6 : 18) - lngHour) / 24;
        const M = (0.9856 * t) - 3.289;
        let L = M + (1.916 * Math.sin(M * radians)) + (0.020 * Math.sin(2 * M * radians)) + 282.634;
        L = (L + 360) % 360;
        let RA = Math.atan(0.91764 * Math.tan(L * radians)) / radians;
        RA = (RA + 360) % 360;
        RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
        RA /= 15;
        const sinDec = 0.39782 * Math.sin(L * radians);
        const cosDec = Math.cos(Math.asin(sinDec));
        const cosH = (Math.cos(90.833 * radians) - (sinDec * Math.sin(lat * radians))) /
            (cosDec * Math.cos(lat * radians));
        if (cosH > 1 || cosH < -1) return null;
        const H = (sunrise ? 360 - Math.acos(cosH) / radians : Math.acos(cosH) / radians) / 15;
        const T = H + RA - (0.06571 * t) - 6.622;
        let UT = T - lngHour;
        UT = ((UT % 24) + 24) % 24;
        const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0));
        utc.setUTCMilliseconds(UT * 3600000);
        return utc;
    };

    const sunrise = eventUtcHours(true);
    const sunset = eventUtcHours(false);
    if (!sunrise || !sunset) {
        return { sunriseSec: 6 * 3600, sunsetSec: 19 * 3600, source: 'fallback' };
    }
    return {
        sunriseSec: dateToSecondsSinceMidnight(sunrise),
        sunsetSec: dateToSecondsSinceMidnight(sunset),
        source: 'solar'
    };
}

function parseIsoToSeconds(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : dateToSecondsSinceMidnight(date);
}

function parseSunPayload(json) {
    const data = json?.results || json;
    const sunriseSec = parseIsoToSeconds(data?.sunrise);
    const sunsetSec = parseIsoToSeconds(data?.sunset);
    if (sunriseSec == null || sunsetSec == null) return null;
    return { sunriseSec, sunsetSec, source: 'sunrise-sunset.org' };
}

async function fetchSunriseSunset(dateStr) {
    const url = new URL(SUN_API_URL);
    url.searchParams.set('lat', String(RABAT_CENTER[1]));
    url.searchParams.set('lng', String(RABAT_CENTER[0]));
    url.searchParams.set('tzid', RABAT_TZ);
    url.searchParams.set('date', dateStr);

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Sunrise-sunset ${response.status}`);
    }

    const times = parseSunPayload(await response.json());
    if (!times) throw new Error('Sunrise-sunset response missing times');
    return times;
}

async function loadCachedSunTimes(dateStr) {
    try {
        const json = await fetchJson(DATA_SNAPSHOT.sun);
        if (json?.date && json.date !== dateStr) return null;
        return parseSunPayload(json);
    } catch (error) {
        return null;
    }
}

async function loadSunTimes(date = new Date()) {
    const dateStr = formatLocalDate(date);
    const fallback = computeApproximateSunTimes(RABAT_CENTER[1], RABAT_CENTER[0], date);
    const cached = await loadCachedSunTimes(dateStr);
    if (cached) {
        sunTimes = { ...cached, dateStr, source: cached.source || 'snapshot' };
    }

    try {
        const times = await fetchSunriseSunset(dateStr);
        sunTimes = { ...times, dateStr };
        return sunTimes;
    } catch (error) {
        console.warn('Sunrise-sunset API unavailable, using snapshot or solar times:', error.message);
    }

    if (cached) return sunTimes;
    sunTimes = { ...fallback, dateStr };
    return sunTimes;
}

function themeForSeconds(seconds = simulationTime) {
    const { sunriseSec, sunsetSec } = sunTimes;
    if (sunriseSec === sunsetSec) return 'day';
    if (sunriseSec < sunsetSec) {
        return seconds >= sunriseSec && seconds < sunsetSec ? 'day' : 'night';
    }
    return seconds >= sunriseSec || seconds < sunsetSec ? 'day' : 'night';
}

function desiredTheme() {
    if (themePreference === 'day' || themePreference === 'night') return themePreference;
    return themeForSeconds(simulationTime);
}

function readStoredThemePreference() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'auto' || stored === 'day' || stored === 'night') return stored;
    } catch (e) {
        /* ignore */
    }
    return 'auto';
}

function storeThemePreference(value) {
    try {
        localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (e) {
        /* ignore */
    }
}

function updateThemeButtons() {
    document.querySelectorAll('#themeButtons button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.theme === themePreference);
    });
}

function setThemePreference(value) {
    themePreference = value;
    storeThemePreference(value);
    updateThemeButtons();
    syncMapTheme();
}

function applyThemeClass(theme) {
    document.documentElement.classList.toggle('night', theme === 'night');
    const note = document.getElementById('themeNote');
    if (!note) return;
    if (themePreference === 'day') {
        note.textContent = 'Light map · forced';
        return;
    }
    if (themePreference === 'night') {
        note.textContent = 'Dark map · forced';
        return;
    }
    note.textContent = theme === 'night'
        ? `Night map · sunrise ${formatClock(sunTimes.sunriseSec)}`
        : `Day map · sunset ${formatClock(sunTimes.sunsetSec)}`;
}

function basemapConfig(theme) {
    return {
        lightPreset: theme === 'night' ? 'night' : 'day',
        show3dObjects: true,
        show3dBuildings: true,
        show3dTrees: false,
        show3dLandmarks: true,
        show3dFacades: false,
        showPointOfInterestLabels: false,
        showTransitLabels: false
    };
}

function applyBasemapTheme(theme) {
    if (!map?.setConfigProperty) return;
    Object.entries(basemapConfig(theme)).forEach(([key, value]) => {
        try {
            map.setConfigProperty('basemap', key, value);
        } catch (error) {
            console.log(`Basemap config ${key} not applied:`, error.message);
        }
    });
}

function applyOverlayTheme() {
    if (!map) return;
    const night = mapTheme === 'night';
    if (map.getLayer('stop-labels')) {
        map.setPaintProperty('stop-labels', 'text-color', night ? '#e8e4dc' : '#333');
        map.setPaintProperty('stop-labels', 'text-halo-color', night ? '#12141a' : '#fff');
    }
}

function addMapOverlays() {
    add3DBuildings();
    addAtmosphere();
    applyBasemapTheme(mapTheme);
    if (routes.length) addRouteLines();
    if (stops.length) addStops();
    if (vehicles.length) {
        addVehicleLayers();
        updateVehiclePositions();
    }
    updateRouteVisibility();
}

function syncMapTheme() {
    const theme = desiredTheme();
    applyThemeClass(theme);
    if (!map) {
        mapTheme = theme;
        return;
    }
    if (theme === mapTheme) return;
    mapTheme = theme;
    applyBasemapTheme(theme);
    applyOverlayTheme();
}

function scheduleThemeWatch() {
    if (themeSwitchTimer) clearTimeout(themeSwitchTimer);
    const now = getSecondsSinceMidnight();
    const next = now < sunTimes.sunriseSec
        ? sunTimes.sunriseSec
        : now < sunTimes.sunsetSec
            ? sunTimes.sunsetSec
            : sunTimes.sunriseSec + 86400;
    const delay = Math.max((next - now) * 1000, 15000);
    themeSwitchTimer = setTimeout(async () => {
        const today = formatLocalDate(new Date());
        if (sunTimes.dateStr !== today) await loadSunTimes();
        syncMapTheme();
        scheduleThemeWatch();
    }, Math.min(delay, 6 * 60 * 60 * 1000));
}

function showFatalError(title, message) {
    const loading = document.getElementById('loading');
    if (!loading) return;
    loading.classList.remove('hidden');
    loading.classList.add('fatal');
    const spinner = document.querySelector('.loading-spinner');
    if (spinner) spinner.style.display = 'none';
    const text = document.querySelector('.loading-text');
    const subtext = document.querySelector('.loading-subtext');
    if (text) text.textContent = title;
    if (subtext) subtext.textContent = message;
}

function getSecondsSinceMidnight(date = new Date()) {
    return (
        date.getHours() * 3600 +
        date.getMinutes() * 60 +
        date.getSeconds() +
        date.getMilliseconds() / 1000
    );
}

function pickStopTime(stoptime, kind) {
    const realtime = stoptime[`realtime${kind}`];
    if (typeof realtime === 'number' && realtime >= 0) return realtime;
    const scheduled = stoptime[`scheduled${kind}`];
    return typeof scheduled === 'number' ? scheduled : 0;
}

function mixHex(hex, other, t) {
    const parse = (value) => [
        parseInt(value.slice(1, 3), 16),
        parseInt(value.slice(3, 5), 16),
        parseInt(value.slice(5, 7), 16)
    ];
    const a = parse(hex);
    const b = parse(other);
    const mixed = a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function metersToLngLat(lng, lat, east, north) {
    const dLat = north / 111320;
    const dLng = east / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lng + dLng, lat + dLat];
}

function vehicleFootprint(lng, lat, bearing, length, width, alongOffset = 0, acrossOffset = 0, cornerRadius = 0) {
    const rad = (bearing * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fy = Math.cos(rad);
    const rx = Math.cos(rad);
    const ry = -Math.sin(rad);
    const hl = length / 2;
    const hw = width / 2;
    const project = (along, across) => metersToLngLat(
        lng,
        lat,
        fx * (along + alongOffset) + rx * (across + acrossOffset),
        fy * (along + alongOffset) + ry * (across + acrossOffset)
    );

    const radius = Math.min(cornerRadius, hl * 0.92, hw * 0.92);
    if (radius < 0.08) {
        return [
            project(-hl, -hw),
            project(hl, -hw),
            project(hl, hw),
            project(-hl, hw),
            project(-hl, -hw)
        ];
    }

    const steps = 6;
    const corners = [];
    const addArc = (cx, cy, startAngle, endAngle) => {
        for (let i = 0; i <= steps; i++) {
            const angle = startAngle + ((endAngle - startAngle) * i) / steps;
            corners.push(project(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius));
        }
    };

    addArc(-hl + radius, -hw + radius, Math.PI, Math.PI * 1.5);
    addArc(hl - radius, -hw + radius, Math.PI * 1.5, Math.PI * 2);
    addArc(hl - radius, hw - radius, 0, Math.PI * 0.5);
    addArc(-hl + radius, hw - radius, Math.PI * 0.5, Math.PI);
    corners.push(corners[0]);
    return corners;
}

function offsetAlongBearing(lng, lat, bearing, meters) {
    const rad = (bearing * Math.PI) / 180;
    return metersToLngLat(lng, lat, Math.sin(rad) * meters, Math.cos(rad) * meters);
}

function vehicleShapeFeatures(vehicle, position, zoom = 16) {
    const color = vehicle.color;
    const windowColor = mixHex(color, '#1A1A1A', 0.58);
    const roofColor = mixHex(color, '#FFFFFF', 0.14);
    const boxColor = mixHex(color, '#111111', 0.22);
    const rubber = '#1A1A1A';
    const steelWheel = '#3A3A3A';
    const bearing = position.bearing || 0;
    const detail = zoom >= 16.2;
    const parts = [];

    const shared = {
        id: vehicle.id,
        routeName: vehicle.routeName,
        badge: vehicle.badge,
        headsign: vehicle.headsign,
        type: vehicle.type,
        color,
        textColor: vehicle.textColor
    };

    const pushPart = (lng, lat, length, width, height, base, partColor, alongOffset = 0, acrossOffset = 0, cornerRadius = 0) => {
        parts.push({
            type: 'Feature',
            properties: {
                ...shared,
                color: partColor,
                height,
                base
            },
            geometry: {
                type: 'Polygon',
                coordinates: [vehicleFootprint(lng, lat, bearing, length, width, alongOffset, acrossOffset, cornerRadius)]
            }
        });
    };

    const pushCar = (lng, lat, length, width, { clearance, skirt, windows, roof, box }) => {
        const bodyRadius = detail ? Math.min(0.55, width * 0.22) : 0;
        const cabinRadius = detail ? Math.min(0.42, width * 0.18) : 0;
        const boxRadius = detail ? Math.min(0.18, width * 0.08) : 0;
        pushPart(lng, lat, length, width, skirt, clearance, color, 0, 0, bodyRadius);
        pushPart(lng, lat, length * 0.92, width * 0.94, windows, skirt, windowColor, 0, 0, cabinRadius);
        pushPart(lng, lat, length, width, roof, windows, roofColor, 0, 0, bodyRadius);
        if (box) {
            pushPart(lng, lat, length * 0.28, width * 0.42, box, roof, boxColor, -length * 0.18, 0, boxRadius);
        }
    };

    const pushWheels = (lng, lat, alongs, halfWidth, radius, thickness, wheelColor) => {
        const slices = 7;
        const hubColor = mixHex(wheelColor, '#C8C8C8', 0.35);
        alongs.forEach((along) => {
            [-1, 1].forEach((side) => {
                const across = side * halfWidth;
                for (let i = 0; i < slices; i++) {
                    const t0 = -1 + (2 * i) / slices;
                    const t1 = -1 + (2 * (i + 1)) / slices;
                    const mid = (t0 + t1) / 2;
                    const half = Math.sqrt(Math.max(0, 1 - mid * mid)) * radius;
                    if (half < 0.05) continue;
                    pushPart(
                        lng,
                        lat,
                        Math.max((t1 - t0) * radius, 0.07),
                        thickness,
                        radius + half,
                        radius - half,
                        wheelColor,
                        along + mid * radius,
                        across
                    );
                }
                pushPart(lng, lat, radius * 0.42, thickness * 0.45, radius + radius * 0.22, radius - radius * 0.22, hubColor, along, across);
            });
        });
    };

    if (vehicle.type === 'tram') {
        const rear = offsetAlongBearing(position.lon, position.lat, bearing, -6.4);
        const front = offsetAlongBearing(position.lon, position.lat, bearing, 6.4);
        const cars = [rear, front];
        const length = 12;
        const width = 2.55;
        const roof = 3.45;
        cars.forEach((pt) => {
            pushCar(pt[0], pt[1], length, width, {
                clearance: 0.52, skirt: 1.15, windows: 2.55, roof, box: 3.95
            });
            if (detail) {
                pushWheels(pt[0], pt[1], [-4.3, -3.35, 3.35, 4.3], width / 2 + 0.08, 0.34, 0.22, steelWheel);
            }
        });
    } else if (vehicle.type === 'train') {
        const length = 11;
        const width = 2.8;
        const roof = 3.8;
        [-12, 0, 12].forEach((shift) => {
            const pt = offsetAlongBearing(position.lon, position.lat, bearing, shift);
            pushCar(pt[0], pt[1], length, width, {
                clearance: 0.58, skirt: 1.2, windows: 2.7, roof, box: 4.3
            });
            if (detail) {
                pushWheels(pt[0], pt[1], [-3.8, -2.7, 2.7, 3.8], width / 2 + 0.1, 0.38, 0.24, steelWheel);
            }
        });
    } else {
        const lng = position.lon;
        const lat = position.lat;
        const length = 12.8;
        const width = 2.6;
        pushCar(lng, lat, length, width, {
            clearance: 0.58, skirt: 1.05, windows: 2.45, roof: 3.25, box: 3.7
        });
        pushPart(lng, lat, 1.8, 2.35, 2.45, 1.05, mixHex(color, '#0B0B0B', 0.7), 5.2, 0, 0.38);
        if (detail) {
            pushWheels(lng, lat, [-4.7, -3.55, 4.35], width / 2 + 0.1, 0.42, 0.28, rubber);
            pushPart(lng, lat, 0.35, 2.5, 0.72, 0.28, '#2F2F2F', 6.15, 0, 0.12);
        }
    }

    return parts;
}

function upsertSource(id, data) {
    const existing = map.getSource(id);
    if (existing) {
        existing.setData(data);
        return;
    }
    map.addSource(id, { type: 'geojson', data });
}

function upsertLayer(layer, beforeId) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    map.addLayer(layer, beforeId);
}

async function graphqlQuery(query, variables = {}) {
    const response = await fetch(OTP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
    });
    const data = await response.json();
    if (data.errors) {
        console.error('GraphQL errors:', data.errors);
    }
    return data.data;
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.json();
}

function unwrapList(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    return [];
}

function expandTrips(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;

    if (payload.v === 1) {
        const catalog = payload.stops || [];
        return (payload.trips || []).map((trip) => ({
            gtfsId: trip.id,
            tripHeadsign: trip.h,
            pattern: {
                name: trip.p,
                route: trip.r
                    ? {
                        gtfsId: trip.r.id,
                        shortName: trip.r.n,
                        longName: trip.r.l,
                        color: trip.r.c,
                        textColor: trip.r.t
                    }
                    : null
            },
            stoptimes: (trip.s || []).map(([stopId, arrival, departure]) => ({
                stop: catalog[stopId] || null,
                scheduledArrival: arrival,
                scheduledDeparture: departure
            }))
        }));
    }

    const geometries = payload.geometries || [];
    return (payload.trips || []).map((trip) => {
        const packed = geometries[trip.pattern?.geometryId];
        const geometry = Array.isArray(packed)
            ? packed.map((point) => (Array.isArray(point) ? { lon: point[0], lat: point[1] } : point))
            : trip.pattern?.geometry || [];
        return {
            ...trip,
            pattern: {
                ...trip.pattern,
                geometry
            }
        };
    });
}

function attachTripGeometries(tripList, routeList) {
    const geoByKey = new Map();
    (routeList || []).forEach((route) => {
        (route.patterns || []).forEach((pattern) => {
            if (!pattern.geometry?.length) return;
            geoByKey.set(`${route.gtfsId}::${pattern.name || ''}`, pattern.geometry);
        });
    });

    return (tripList || []).map((trip) => {
        if (trip.pattern?.geometry?.length) return trip;
        const geometry = geoByKey.get(`${trip.pattern?.route?.gtfsId}::${trip.pattern?.name || ''}`);
        if (!geometry) return trip;
        return {
            ...trip,
            pattern: {
                ...trip.pattern,
                geometry
            }
        };
    });
}

const snapshotPromise = Promise.all([
    fetchJson(DATA_SNAPSHOT.routes).catch(() => null),
    fetchJson(DATA_SNAPSHOT.stops).catch(() => null),
    fetchJson(DATA_SNAPSHOT.trips).catch(() => null)
]).then(([routesPayload, stopsPayload, tripsPayload]) => {
    if (!routesPayload && !stopsPayload && !tripsPayload) return null;
    return {
        routes: unwrapList(routesPayload, 'routes'),
        stops: unwrapList(stopsPayload, 'stops'),
        trips: expandTrips(tripsPayload)
    };
});

function getRouteType(gtfsId = '') {
    if (gtfsId.includes('TRAMWAY')) return 'tram';
    if (gtfsId.includes('BUS')) return 'bus';
    if (gtfsId.includes('ONCF')) return 'train';
    return 'bus';
}

function normalizeHexColor(value, fallback) {
    if (!value || typeof value !== 'string') return fallback;
    let hex = value.trim().replace(/^#/, '');
    if (/^[0-9A-Fa-f]{3}$/.test(hex)) {
        hex = hex.split('').map((char) => char + char).join('');
    }
    if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return fallback;
    return `#${hex.toUpperCase()}`;
}

function getRouteColor(route = {}) {
    const type = getRouteType(route.gtfsId);
    const fallback = ROUTE_COLORS[type] || ROUTE_COLORS.default;
    return normalizeHexColor(route.color, fallback);
}

function getRouteTextColor(route = {}) {
    return normalizeHexColor(route.textColor, '#FFFFFF');
}

function routeBadgeLabel(name) {
    if (!name) return '';
    const trimmed = String(name).trim();
    if (trimmed.length <= 4) return trimmed;
    const match = trimmed.match(/^(T\d+|L\d+|[A-Z]{1,3}\d*|\d+)/i);
    return match ? match[1] : trimmed.slice(0, 3);
}

function addRouteBadgeImage() {
    const size = 80;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 36, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#111111';
    ctx.stroke();
    const imageData = ctx.getImageData(0, 0, size, size);
    if (map.hasImage('route-badge')) map.removeImage('route-badge');
    map.addImage('route-badge', imageData, { pixelRatio: 2 });
}

async function fetchRoutes() {
    const query = `{
        routes {
            gtfsId
            shortName
            longName
            color
            textColor
            patterns {
                name
                headsign
                geometry { lat lon }
                stops { gtfsId name lat lon }
            }
        }
    }`;

    const data = await graphqlQuery(query);
    return data?.routes || [];
}

async function fetchStops() {
    const query = `{
        stops {
            gtfsId
            name
            lat
            lon
            routes { gtfsId shortName }
        }
    }`;

    const data = await graphqlQuery(query);
    return data?.stops || [];
}

async function fetchTrips() {
    const query = `{
        trips {
            gtfsId
            tripHeadsign
            pattern {
                name
                route { gtfsId shortName longName color textColor }
            }
            stoptimes {
                stop { gtfsId name }
                scheduledArrival
                scheduledDeparture
                realtimeArrival
                realtimeDeparture
                realtimeState
            }
        }
    }`;

    const data = await graphqlQuery(query);
    return data?.trips || [];
}

function initMap(token) {
    mapboxgl.accessToken = token;
    mapTheme = desiredTheme();
    applyThemeClass(mapTheme);

    map = new mapboxgl.Map({
        container: 'map',
        style: MAP_STYLE,
        center: RABAT_CENTER,
        zoom: INITIAL_ZOOM,
        pitch: INITIAL_PITCH,
        bearing: INITIAL_BEARING,
        antialias: false,
        maxPitch: 75,
        fadeDuration: 0,
        renderWorldCopies: false,
        dragRotate: true,
        pitchWithRotate: true,
        touchPitch: true,
        touchZoomRotate: true,
        keyboard: true,
        config: {
            basemap: basemapConfig(mapTheme)
        }
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');

    map.dragRotate.enable();
    map.touchPitch.enable();
    map.touchZoomRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enable();
    map.getCanvas().addEventListener('contextmenu', (event) => event.preventDefault());

    map.on('error', (event) => {
        const message = event?.error?.message || '';
        console.error('Mapbox error:', message || event.error);
        if (/403|forbidden|unauthorized/i.test(message)) {
            showFatalError(
                'Map tiles blocked',
                'This Mapbox token cannot load streets or 3D buildings. Use a public token with Styles:Read and Styles:Tiles, and no URL restriction that excludes this site.'
            );
        }
    });

    map.on('style.load', () => {
        addMapOverlays();
    });

    map.once('load', async () => {
        setupInteractions();
        followWallClock = true;
        simulationTime = getSecondsSinceMidnight();
        updateTimeDisplay();
        startRealtimeClock();
        scheduleThemeWatch();

        await loadTransitData();
        document.getElementById('loading').classList.add('hidden');
        syncMapTheme();
    });
}

function add3DBuildings() {
    try {
        if (map.getLayer('3d-buildings')) return;
        const sources = map.getStyle()?.sources || {};
        if (!sources.composite) return;

        const layers = map.getStyle().layers || [];
        const labelLayerId = layers.find(
            (layer) => layer.type === 'symbol' && layer.layout && layer.layout['text-field']
        )?.id;
        const night = mapTheme === 'night';

        map.addLayer(
            {
                id: '3d-buildings',
                source: 'composite',
                'source-layer': 'building',
                filter: ['==', 'extrude', 'true'],
                type: 'fill-extrusion',
                minzoom: 12,
                paint: {
                    'fill-extrusion-color': night
                        ? [
                            'interpolate',
                            ['linear'],
                            ['get', 'height'],
                            0, '#2a3038',
                            40, '#232830',
                            90, '#1b2028'
                        ]
                        : [
                            'interpolate',
                            ['linear'],
                            ['get', 'height'],
                            0, '#efece6',
                            40, '#e4e0d8',
                            90, '#d5d0c6'
                        ],
                    'fill-extrusion-height': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        12, 0,
                        13, ['get', 'height']
                    ],
                    'fill-extrusion-base': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        12, 0,
                        13, ['get', 'min_height']
                    ],
                    'fill-extrusion-opacity': night ? 0.92 : 0.85
                }
            },
            labelLayerId
        );
    } catch (error) {
        console.log('Could not add 3D buildings:', error.message);
    }
}

function addAtmosphere() {
    // Mapbox Standard already provides sky, fog, and lighting through lightPreset.
}

function applyTransitData(next) {
    routes = next.routes || [];
    stops = next.stops || [];
    trips = attachTripGeometries(next.trips || [], routes);
    addRouteLines();
    addStops();
    initializeVehicles();
    updateStats();
}

async function fetchLiveTransitData() {
    const [nextRoutes, nextStops, nextTrips] = await Promise.all([
        fetchRoutes(),
        fetchStops(),
        fetchTrips()
    ]);
    return {
        routes: nextRoutes,
        stops: nextStops,
        trips: attachTripGeometries(nextTrips, nextRoutes)
    };
}

async function refreshTransitDataInBackground() {
    try {
        const live = await fetchLiveTransitData();
        if (!live.routes.length && !live.trips.length) return;
        applyTransitData(live);
    } catch (error) {
        console.warn('Background transit refresh failed:', error.message);
    }
}

async function loadTransitData() {
    const subtext = document.querySelector('.loading-subtext');
    try {
        subtext.textContent = 'Loading cached schedules...';
        const snapshot = await snapshotPromise;
        const hasSnapshot = snapshot && (snapshot.trips.length || snapshot.routes.length || snapshot.stops.length);

        if (hasSnapshot) {
            applyTransitData(snapshot);
            refreshTransitDataInBackground();
            return;
        }

        subtext.textContent = 'Loading transit data...';
        applyTransitData(await fetchLiveTransitData());
    } catch (error) {
        console.error('Error loading transit data:', error);
        subtext.textContent = 'Error loading data. Retrying...';
        setTimeout(loadTransitData, 3000);
    }
}

function addRouteLines() {
    const routeFeatures = [];

    routes.forEach(route => {
        const type = getRouteType(route.gtfsId);
        const color = getRouteColor(route);

        route.patterns?.forEach((pattern, idx) => {
            if (pattern.geometry && pattern.geometry.length > 1) {
                const coordinates = pattern.geometry.map(p => [p.lon, p.lat]);

                routeFeatures.push({
                    type: 'Feature',
                    properties: {
                        id: `${route.gtfsId}-${idx}`,
                        routeId: route.gtfsId,
                        shortName: route.shortName,
                        longName: route.longName,
                        headsign: pattern.headsign,
                        type: type,
                        color: color
                    },
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    }
                });
            }
        });
    });

    upsertSource('routes', {
        type: 'FeatureCollection',
        features: routeFeatures
    });

    upsertLayer({
        id: 'route-lines-casing',
        type: 'line',
        source: 'routes',
        slot: 'middle',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': '#ffffff',
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 3,
                14, 6,
                18, 10
            ],
            'line-opacity': 0.9,
            'line-emissive-strength': 0.4
        }
    });

    upsertLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        slot: 'middle',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 2,
                14, 3.5,
                18, 6
            ],
            'line-opacity': 1,
            'line-emissive-strength': 0.55
        }
    });
}

function addStops() {
    const stopFeatures = stops.map(stop => {
        const types = new Set();
        stop.routes?.forEach(r => types.add(getRouteType(r.gtfsId)));
        const primaryType = types.has('tram') ? 'tram' : types.has('train') ? 'train' : 'bus';

        return {
            type: 'Feature',
            properties: {
                id: stop.gtfsId,
                name: stop.name,
                type: primaryType,
                routes: stop.routes?.map(r => r.shortName).join(', ') || ''
            },
            geometry: {
                type: 'Point',
                coordinates: [stop.lon, stop.lat]
            }
        };
    });

    upsertSource('stops', {
        type: 'FeatureCollection',
        features: stopFeatures
    });

    upsertLayer({
        id: 'stops',
        type: 'circle',
        source: 'stops',
        minzoom: 11,
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                11, 4,
                14, 6,
                16, 8,
                18, 11
            ],
            'circle-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': [
                'match', ['get', 'type'],
                'tram', ROUTE_COLORS.tram,
                'train', ROUTE_COLORS.train,
                'bus', ROUTE_COLORS.bus,
                ROUTE_COLORS.default
            ],
            'circle-pitch-alignment': 'viewport'
        }
    });

    upsertLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'stops',
        minzoom: 15,
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-max-width': 10,
            'text-optional': true
        },
        paint: {
            'text-color': mapTheme === 'night' ? '#e8e4dc' : '#333',
            'text-halo-color': mapTheme === 'night' ? '#12141a' : '#fff',
            'text-halo-width': 1.5
        }
    });

    document.getElementById('stopCount').textContent = stops.length;
}

function initializeVehicles() {
    vehicles = [];

    trips.forEach(trip => {
        if (!trip.stoptimes || trip.stoptimes.length < 2 || !trip.pattern?.geometry || !trip.pattern.route) {
            return;
        }

        const routeType = getRouteType(trip.pattern.route.gtfsId);
        const color = getRouteColor(trip.pattern.route);
        const textColor = getRouteTextColor(trip.pattern.route);
        const startTime = pickStopTime(trip.stoptimes[0], 'Departure');
        const endTime = pickStopTime(trip.stoptimes[trip.stoptimes.length - 1], 'Arrival');

        vehicles.push({
            id: trip.gtfsId,
            tripId: trip.gtfsId,
            routeId: trip.pattern.route.gtfsId,
            routeName: trip.pattern.route.shortName,
            headsign: trip.tripHeadsign || trip.pattern.route.longName,
            type: routeType,
            color: color,
            textColor: textColor,
            badge: routeBadgeLabel(trip.pattern.route.shortName),
            geometry: trip.pattern.geometry,
            stoptimes: trip.stoptimes,
            startTime: startTime,
            endTime: endTime,
            position: null,
            bearing: 0
        });
    });

    addVehicleLayers();
}

function addVehicleLayers() {
    upsertSource('vehicles', {
        type: 'FeatureCollection',
        features: []
    });

    addRouteBadgeImage();

    upsertSource('vehicle-bodies', {
        type: 'FeatureCollection',
        features: []
    });

    upsertLayer({
        id: 'vehicle-bodies',
        type: 'fill-extrusion',
        source: 'vehicle-bodies',
        minzoom: 13,
        paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base'],
            'fill-extrusion-opacity': 0.96,
            'fill-extrusion-emissive-strength': 0.45
        }
    });

    upsertLayer({
        id: 'vehicles',
        type: 'circle',
        source: 'vehicles',
        maxzoom: 14,
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 5,
                13, 7
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': 1,
            'circle-pitch-alignment': 'viewport'
        }
    });

    upsertLayer({
        id: 'vehicle-hit',
        type: 'circle',
        source: 'vehicles',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                13, 16,
                16, 20,
                18, 24
            ],
            'circle-opacity': 0,
            'circle-pitch-alignment': 'viewport',
            'circle-translate-anchor': 'viewport',
            'circle-translate': [
                'interpolate', ['linear'], ['zoom'],
                13, ['literal', [0, -12]],
                16, ['literal', [0, -28]],
                18, ['literal', [0, -46]]
            ]
        }
    });

    upsertLayer({
        id: 'vehicle-badges',
        type: 'symbol',
        source: 'vehicles',
        minzoom: 13,
        layout: {
            'icon-image': 'route-badge',
            'icon-size': [
                'interpolate', ['linear'], ['zoom'],
                13, 0.78,
                16, 1.02,
                18, 1.2
            ],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'viewport',
            'icon-rotation-alignment': 'viewport',
            'symbol-z-offset': ['get', 'labelZ'],
            'text-field': ['get', 'badge'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                13, 9,
                16, 10,
                18, 11
            ],
            'text-letter-spacing': -0.04,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-pitch-alignment': 'viewport',
            'text-rotation-alignment': 'viewport'
        },
        paint: {
            'text-color': '#111111',
            'icon-translate-anchor': 'viewport',
            'text-translate-anchor': 'viewport',
            'icon-translate': [
                'interpolate', ['linear'], ['zoom'],
                13, ['literal', [0, -12]],
                16, ['literal', [0, -28]],
                18, ['literal', [0, -46]]
            ],
            'text-translate': [
                'interpolate', ['linear'], ['zoom'],
                13, ['literal', [0, -12]],
                16, ['literal', [0, -28]],
                18, ['literal', [0, -46]]
            ]
        }
    });

    updateVehiclePositions();
}

function pointAlongGeometry(geometry, t) {
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * (geometry.length - 1);
    const index = Math.min(Math.floor(scaled), geometry.length - 2);
    const local = scaled - index;
    const p1 = geometry[index];
    const p2 = geometry[index + 1];
    return {
        lon: p1.lon + (p2.lon - p1.lon) * local,
        lat: p1.lat + (p2.lat - p1.lat) * local,
        bearing: Math.atan2(p2.lon - p1.lon, p2.lat - p1.lat) * 180 / Math.PI
    };
}

function calculateVehiclePosition(vehicle, currentTime) {
    const { stoptimes, geometry } = vehicle;

    if (currentTime < vehicle.startTime || currentTime > vehicle.endTime) {
        return null;
    }

    if (!geometry || geometry.length < 2) return null;

    const totalSegments = stoptimes.length - 1;

    for (let i = 0; i < stoptimes.length - 1; i++) {
        const departureTime = pickStopTime(stoptimes[i], 'Departure');
        const nextArrival = pickStopTime(stoptimes[i + 1], 'Arrival');
        const nextDeparture = pickStopTime(stoptimes[i + 1], 'Departure');

        if (currentTime < departureTime) {
            return pointAlongGeometry(geometry, i / totalSegments);
        }

        if (currentTime >= departureTime && currentTime <= nextArrival) {
            const duration = Math.max(nextArrival - departureTime, 1);
            const progress = (currentTime - departureTime) / duration;
            return pointAlongGeometry(geometry, (i + progress) / totalSegments);
        }

        if (currentTime > nextArrival && currentTime < nextDeparture) {
            return pointAlongGeometry(geometry, (i + 1) / totalSegments);
        }
    }

    return pointAlongGeometry(geometry, 1);
}

function updateVehiclePositions() {
    const activeVehicles = [];
    const bodyFeatures = [];
    let tramCount = 0, busCount = 0, trainCount = 0;

    vehicles.forEach(vehicle => {
        if (!visibleTypes[vehicle.type]) return;

        const position = calculateVehiclePosition(vehicle, simulationTime);
        if (position) {
            vehicle.position = position;
            vehicle.bearing = position.bearing || 0;

            activeVehicles.push({
                type: 'Feature',
                properties: {
                    id: vehicle.id,
                    routeName: vehicle.routeName,
                    badge: vehicle.badge,
                    headsign: vehicle.headsign,
                    type: vehicle.type,
                    color: vehicle.color,
                    textColor: vehicle.textColor,
                    bearing: vehicle.bearing,
                    labelZ: vehicle.type === 'train' ? 7.4 : vehicle.type === 'tram' ? 6.6 : 5.8
                },
                geometry: {
                    type: 'Point',
                    coordinates: [position.lon, position.lat]
                }
            });

            bodyFeatures.push(...vehicleShapeFeatures(vehicle, position, map.getZoom()));

            if (vehicle.type === 'tram') tramCount++;
            else if (vehicle.type === 'bus') busCount++;
            else if (vehicle.type === 'train') trainCount++;
        }
    });

    const source = map.getSource('vehicles');
    if (source) {
        source.setData({
            type: 'FeatureCollection',
            features: activeVehicles
        });
    }

    const bodySource = map.getSource('vehicle-bodies');
    if (bodySource) {
        bodySource.setData({
            type: 'FeatureCollection',
            features: bodyFeatures
        });
    }

    document.getElementById('tramCount').textContent = tramCount;
    document.getElementById('busCount').textContent = busCount;
    document.getElementById('trainCount').textContent = trainCount;
}

function isLiveClock() {
    return isPlaying && followWallClock && simulationSpeed === 1 &&
        Math.abs(simulationTime - getSecondsSinceMidnight()) < 2;
}

function updateTimeDisplay() {
    const hours = Math.floor(simulationTime / 3600) % 24;
    const minutes = Math.floor((simulationTime % 3600) / 60);
    const seconds = Math.floor(simulationTime % 60);

    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('currentTime').textContent = timeStr;

    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('currentDate').textContent = now.toLocaleDateString('en-US', options);
    document.getElementById('timeSlider').value = simulationTime;

    const live = isLiveClock();
    const badge = document.getElementById('liveBadge');
    if (badge) {
        badge.classList.toggle('active', live);
        badge.textContent = live ? 'Live' : 'Playback, not live';
    }
}

function setPlayButtonState() {
    const btn = document.getElementById('playBtn');
    if (!btn) return;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    btn.innerHTML = isPlaying
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>';
}

function tick(timestamp) {
    if (!isPlaying) {
        animationFrameId = null;
        return;
    }

    if (!lastFrameTs) lastFrameTs = timestamp;
    const dt = Math.min((timestamp - lastFrameTs) / 1000, 0.1);
    lastFrameTs = timestamp;

    if (followWallClock && simulationSpeed === 1) {
        simulationTime = getSecondsSinceMidnight();
    } else {
        followWallClock = false;
        simulationTime += dt * simulationSpeed;
        if (simulationTime >= 86400) simulationTime -= 86400;
        if (simulationTime < 0) simulationTime += 86400;
    }

    updateTimeDisplay();
    const moving = map && (map.isMoving() || map.isZooming() || map.isRotating());
    const interval = simulationSpeed <= 1 ? 80 : simulationSpeed <= 10 ? 40 : 16;
    if (!moving && timestamp - lastVehicleUpdateTs >= interval) {
        lastVehicleUpdateTs = timestamp;
        updateVehiclePositions();
        syncMapTheme();
    }

    animationFrameId = requestAnimationFrame(tick);
}

function startRealtimeClock() {
    isPlaying = true;
    lastFrameTs = 0;
    if (followWallClock) {
        simulationTime = getSecondsSinceMidnight();
        simulationSpeed = 1;
        document.querySelectorAll('.speed-buttons button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.speed === '1');
        });
    }
    setPlayButtonState();
    if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(tick);
    }
}

function togglePlay() {
    if (isPlaying) {
        isPlaying = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        setPlayButtonState();
        updateTimeDisplay();
        return;
    }

    startRealtimeClock();
}

function resetToNow() {
    followWallClock = true;
    simulationSpeed = 1;
    simulationTime = getSecondsSinceMidnight();
    document.querySelectorAll('.speed-buttons button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.speed === '1');
    });
    updateTimeDisplay();
    updateVehiclePositions();
    syncMapTheme();
    startRealtimeClock();
}

function updateStats() {
    updateVehiclePositions();
}

function setupInteractions() {
    if (interactionsReady) return;
    interactionsReady = true;

    map.on('moveend', () => {
        if (vehicles.length) updateVehiclePositions();
    });

    const showVehiclePopup = (e) => {
        const props = e.features[0].properties;

        new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
                <div class="vehicle-popup">
                    <h4>
                        <span class="route-badge" style="background: ${props.color}; color: ${props.textColor || 'white'};">
                            ${props.routeName}
                        </span>
                        ${props.type.charAt(0).toUpperCase() + props.type.slice(1)}
                    </h4>
                    <p><strong>Direction:</strong> ${props.headsign}</p>
                </div>
            `)
            .addTo(map);
    };

    document.querySelectorAll('#themeButtons button').forEach((btn) => {
        btn.addEventListener('click', () => setThemePreference(btn.dataset.theme));
    });

    document.getElementById('timeSlider').addEventListener('input', (e) => {
        followWallClock = false;
        simulationTime = parseInt(e.target.value, 10);
        lastFrameTs = 0;
        updateTimeDisplay();
        updateVehiclePositions();
        syncMapTheme();
    });

    document.getElementById('playBtn').addEventListener('click', togglePlay);
    document.getElementById('resetBtn').addEventListener('click', resetToNow);

    document.querySelectorAll('.speed-buttons button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.speed-buttons button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            simulationSpeed = Number(btn.dataset.speed);
            followWallClock = simulationSpeed === 1;
            if (followWallClock) {
                simulationTime = getSecondsSinceMidnight();
            }
            updateTimeDisplay();
            if (!isPlaying) startRealtimeClock();
            syncMapTheme();
        });
    });

    document.querySelectorAll('.legend-item').forEach(item => {
        item.addEventListener('click', () => {
            const type = item.dataset.type;
            visibleTypes[type] = !visibleTypes[type];
            item.classList.toggle('active', visibleTypes[type]);
            updateRouteVisibility();
            updateVehiclePositions();
        });
    });

    map.on('click', 'vehicle-bodies', showVehiclePopup);
    map.on('click', 'vehicle-hit', showVehiclePopup);
    map.on('click', 'vehicles', showVehiclePopup);
    map.on('click', 'vehicle-badges', showVehiclePopup);

    map.on('click', 'stops', (e) => {
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates;

        new mapboxgl.Popup()
            .setLngLat(coords)
            .setHTML(`
                <div class="vehicle-popup">
                    <h4>${props.name}</h4>
                    <p><strong>Lines:</strong> ${props.routes || 'N/A'}</p>
                </div>
            `)
            .addTo(map);
    });

    map.on('mouseenter', 'vehicle-bodies', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'vehicle-bodies', () => {
        map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'vehicle-badges', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'vehicle-badges', () => {
        map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'vehicles', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'vehicles', () => {
        map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'stops', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'stops', () => {
        map.getCanvas().style.cursor = '';
    });

    document.getElementById('view3d').addEventListener('click', () => {
        document.getElementById('view3d').classList.add('active');
        document.getElementById('view2d').classList.remove('active');
        map.easeTo({
            pitch: 60,
            bearing: -20,
            duration: 1000
        });
    });

    document.getElementById('view2d').addEventListener('click', () => {
        document.getElementById('view2d').classList.add('active');
        document.getElementById('view3d').classList.remove('active');
        map.easeTo({
            pitch: 0,
            bearing: 0,
            duration: 1000
        });
    });
}

function updateRouteVisibility() {
    if (!map?.getLayer('route-lines')) return;
    const visibleTypesArray = Object.entries(visibleTypes)
        .filter(([_, visible]) => visible)
        .map(([type, _]) => type);

    if (visibleTypesArray.length === 0) {
        map.setFilter('route-lines', ['==', 'type', '']);
        map.setFilter('route-lines-casing', ['==', 'type', '']);
        map.setFilter('stops', ['==', 'type', '']);
        map.setFilter('stop-labels', ['==', 'type', '']);
        return;
    }

    const filter = ['in', ['get', 'type'], ['literal', visibleTypesArray]];

    map.setFilter('route-lines', filter);
    map.setFilter('route-lines-casing', filter);
    map.setFilter('stops', filter);
    map.setFilter('stop-labels', filter);
}

document.addEventListener('DOMContentLoaded', async () => {
    simulationTime = getSecondsSinceMidnight();

    const token = resolveMapboxToken();
    if (!token) {
        showFatalError(
            'Mapbox token missing',
            'Set MAPBOX_ACCESS_TOKEN in the environment before deploy, or open with ?token=YOUR_MAPBOX_TOKEN'
        );
        return;
    }

    themePreference = readStoredThemePreference();
    updateThemeButtons();
    simulationTime = getSecondsSinceMidnight();
    initMap(token);
    loadSunTimes().then(() => {
        syncMapTheme();
        scheduleThemeWatch();
    });
});
