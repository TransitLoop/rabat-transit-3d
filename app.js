// Rabat Transit 3D - Real-time Transit Visualization
// OpenTripPlanner GraphQL endpoint
const OTP_ENDPOINT = 'https://rrm.transitloop.net/otp/routers/default/index/graphql';

// Rabat center coordinates
const RABAT_CENTER = [-6.8498, 34.0209];
const INITIAL_ZOOM = 14;
const INITIAL_PITCH = 60;
const INITIAL_BEARING = -20;

// Route colors by type
const ROUTE_COLORS = {
    tram: '#e91e63',
    bus: '#2196f3',
    train: '#ff9800',
    default: '#9e9e9e'
};

// State
let map;
let routes = [];
let stops = [];
let patterns = [];
let trips = [];
let vehicles = [];
let simulationTime = 9 * 3600; // 9:00 AM in seconds
let isPlaying = false;
let playInterval = null;
let simulationSpeed = 1;
let visibleTypes = { tram: true, bus: true, train: true };

// Initialize MapBox - Use a public token or set your own in the URL hash
// You can pass your own token via URL: ?token=YOUR_MAPBOX_TOKEN
const urlParams = new URLSearchParams(window.location.search);
const customToken = urlParams.get('token');
mapboxgl.accessToken = customToken || 'pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw';

// GraphQL query helper
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

// Determine route type from gtfsId
function getRouteType(gtfsId) {
    if (gtfsId.includes('TRAMWAY')) return 'tram';
    if (gtfsId.includes('BUS')) return 'bus';
    if (gtfsId.includes('ONCF')) return 'train';
    return 'bus';
}

// Get color for route
function getRouteColor(route) {
    const type = getRouteType(route.gtfsId);
    return ROUTE_COLORS[type] || ROUTE_COLORS.default;
}

// Fetch all routes with patterns
async function fetchRoutes() {
    const query = `{
        routes {
            gtfsId
            shortName
            longName
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

// Fetch all stops
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

// Fetch trips with stoptimes for scheduling
async function fetchTrips() {
    const query = `{
        trips {
            gtfsId
            tripHeadsign
            pattern {
                name
                route { gtfsId shortName longName }
                geometry { lat lon }
            }
            stoptimes {
                stop { gtfsId name lat lon }
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

// Initialize the map
function initMap() {
    map = new mapboxgl.Map({
        container: 'map',
        style: 'mapbox://styles/mapbox/streets-v12',
        center: RABAT_CENTER,
        zoom: INITIAL_ZOOM,
        pitch: INITIAL_PITCH,
        bearing: INITIAL_BEARING,
        antialias: true
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.ScaleControl(), 'bottom-right');

    map.on('style.load', async () => {
        // Add 3D terrain if available
        try {
            map.addSource('mapbox-dem', {
                type: 'raster-dem',
                url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                tileSize: 512,
                maxzoom: 14
            });
            map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
        } catch (e) {
            console.log('Terrain not available:', e);
        }
        
        // Add 3D buildings
        add3DBuildings();
        
        // Add atmosphere/sky
        addAtmosphere();
        
        // Load transit data
        await loadTransitData();
        
        // Hide loading overlay
        document.getElementById('loading').classList.add('hidden');
        
        // Start time update
        updateTimeDisplay();
        
        // Add click handlers for vehicles
        setupInteractions();
    });
}

// Add 3D buildings layer
function add3DBuildings() {
    try {
        const layers = map.getStyle().layers;
        const labelLayerId = layers.find(
            (layer) => layer.type === 'symbol' && layer.layout && layer.layout['text-field']
        )?.id;

        // Check if building source exists
        const style = map.getStyle();
        const hasComposite = style.sources && style.sources.composite;
        
        if (hasComposite) {
            map.addLayer(
                {
                    'id': '3d-buildings',
                    'source': 'composite',
                    'source-layer': 'building',
                    'filter': ['==', 'extrude', 'true'],
                    'type': 'fill-extrusion',
                    'minzoom': 12,
                    'paint': {
                        'fill-extrusion-color': [
                            'interpolate',
                            ['linear'],
                            ['get', 'height'],
                            0, '#e8e8e8',
                            50, '#d0d0d0',
                            100, '#b8b8b8'
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
                        'fill-extrusion-opacity': 0.7
                    }
                },
                labelLayerId
            );
            console.log('3D buildings layer added successfully');
        } else {
            console.log('Composite source not available, skipping 3D buildings');
        }
    } catch (error) {
        console.log('Could not add 3D buildings:', error.message);
    }
}

// Add atmosphere effect
function addAtmosphere() {
    map.setFog({
        'color': 'rgb(255, 255, 255)',
        'high-color': 'rgb(200, 200, 220)',
        'horizon-blend': 0.1,
        'space-color': 'rgb(150, 180, 220)',
        'star-intensity': 0
    });
    
    // Add sky layer for better 3D effect
    try {
        map.addLayer({
            'id': 'sky',
            'type': 'sky',
            'paint': {
                'sky-type': 'atmosphere',
                'sky-atmosphere-sun': [0.0, 90.0],
                'sky-atmosphere-sun-intensity': 15
            }
        });
    } catch (e) {
        console.log('Sky layer not supported');
    }
}

// Load all transit data
async function loadTransitData() {
    try {
        document.querySelector('.loading-subtext').textContent = 'Loading routes...';
        routes = await fetchRoutes();
        
        document.querySelector('.loading-subtext').textContent = 'Loading stops...';
        stops = await fetchStops();
        
        document.querySelector('.loading-subtext').textContent = 'Loading schedules...';
        trips = await fetchTrips();
        
        document.querySelector('.loading-subtext').textContent = 'Rendering map...';
        
        // Add route lines
        addRouteLines();
        
        // Add stops
        addStops();
        
        // Initialize vehicles
        initializeVehicles();
        
        // Update stats
        updateStats();
        
    } catch (error) {
        console.error('Error loading transit data:', error);
        document.querySelector('.loading-subtext').textContent = 'Error loading data. Retrying...';
        setTimeout(loadTransitData, 3000);
    }
}

// Add route lines to the map
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

    // Add source
    map.addSource('routes', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: routeFeatures
        }
    });

    // Add route outline (casing)
    map.addLayer({
        id: 'route-lines-casing',
        type: 'line',
        source: 'routes',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': '#ffffff',
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 4,
                14, 8,
                18, 14
            ],
            'line-opacity': 0.8
        }
    });

    // Add route lines
    map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 2,
                14, 5,
                18, 10
            ],
            'line-opacity': 0.9
        }
    });
}

// Add stops to the map
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

    map.addSource('stops', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: stopFeatures
        }
    });

    // Add stop circles
    map.addLayer({
        id: 'stops',
        type: 'circle',
        source: 'stops',
        minzoom: 13,
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                13, 3,
                16, 6,
                18, 10
            ],
            'circle-color': [
                'match', ['get', 'type'],
                'tram', ROUTE_COLORS.tram,
                'train', ROUTE_COLORS.train,
                'bus', ROUTE_COLORS.bus,
                ROUTE_COLORS.default
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
        }
    });

    // Add stop labels
    map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'stops',
        minzoom: 15,
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
            'text-max-width': 10
        },
        paint: {
            'text-color': '#333',
            'text-halo-color': '#fff',
            'text-halo-width': 2
        }
    });

    document.getElementById('stopCount').textContent = stops.length;
}

// Initialize vehicles from trips
function initializeVehicles() {
    vehicles = [];
    
    trips.forEach(trip => {
        if (!trip.stoptimes || trip.stoptimes.length < 2 || !trip.pattern?.geometry) {
            return;
        }
        
        const routeType = getRouteType(trip.pattern.route.gtfsId);
        const color = ROUTE_COLORS[routeType] || ROUTE_COLORS.default;
        
        // Get trip start and end times
        const startTime = trip.stoptimes[0].scheduledDeparture;
        const endTime = trip.stoptimes[trip.stoptimes.length - 1].scheduledArrival;
        
        vehicles.push({
            id: trip.gtfsId,
            tripId: trip.gtfsId,
            routeId: trip.pattern.route.gtfsId,
            routeName: trip.pattern.route.shortName,
            headsign: trip.tripHeadsign || trip.pattern.route.longName,
            type: routeType,
            color: color,
            geometry: trip.pattern.geometry,
            stoptimes: trip.stoptimes,
            startTime: startTime,
            endTime: endTime,
            position: null,
            bearing: 0
        });
    });

    // Add vehicles source
    map.addSource('vehicles', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: []
        }
    });

    // Add vehicle glow/pulse effect (outer ring)
    map.addLayer({
        id: 'vehicles-glow',
        type: 'circle',
        source: 'vehicles',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 8,
                14, 16,
                18, 28
            ],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.3,
            'circle-blur': 1
        }
    });

    // Add vehicle layer - main circle
    map.addLayer({
        id: 'vehicles',
        type: 'circle',
        source: 'vehicles',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 5,
                14, 10,
                18, 18
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 2,
                14, 3,
                18, 4
            ],
            'circle-stroke-color': '#ffffff',
            'circle-opacity': 1
        }
    });

    // Add vehicle labels (route name)
    map.addLayer({
        id: 'vehicle-labels',
        type: 'symbol',
        source: 'vehicles',
        minzoom: 14,
        layout: {
            'text-field': ['get', 'routeName'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                14, 8,
                18, 12
            ],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
            'text-ignore-placement': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': ['get', 'color'],
            'text-halo-width': 1
        }
    });

    // Update vehicles display
    updateVehiclePositions();
}

// Calculate vehicle position based on current time
function calculateVehiclePosition(vehicle, currentTime) {
    const { stoptimes, geometry } = vehicle;
    
    // Check if trip is active
    if (currentTime < vehicle.startTime || currentTime > vehicle.endTime) {
        return null;
    }
    
    // Find current segment based on stoptimes
    let segmentIndex = 0;
    let segmentProgress = 0;
    
    for (let i = 0; i < stoptimes.length - 1; i++) {
        const departureTime = stoptimes[i].scheduledDeparture;
        const arrivalTime = stoptimes[i + 1].scheduledArrival;
        
        if (currentTime >= departureTime && currentTime <= arrivalTime) {
            segmentIndex = i;
            segmentProgress = (currentTime - departureTime) / (arrivalTime - departureTime);
            break;
        }
    }
    
    // Map segment to geometry
    if (!geometry || geometry.length < 2) return null;
    
    // Calculate position along geometry
    const totalSegments = stoptimes.length - 1;
    const geoProgress = (segmentIndex + segmentProgress) / totalSegments;
    const geoIndex = Math.floor(geoProgress * (geometry.length - 1));
    const geoLocalProgress = (geoProgress * (geometry.length - 1)) - geoIndex;
    
    if (geoIndex >= geometry.length - 1) {
        const lastPoint = geometry[geometry.length - 1];
        return { lon: lastPoint.lon, lat: lastPoint.lat };
    }
    
    const p1 = geometry[geoIndex];
    const p2 = geometry[Math.min(geoIndex + 1, geometry.length - 1)];
    
    const lon = p1.lon + (p2.lon - p1.lon) * geoLocalProgress;
    const lat = p1.lat + (p2.lat - p1.lat) * geoLocalProgress;
    
    // Calculate bearing
    const bearing = Math.atan2(p2.lon - p1.lon, p2.lat - p1.lat) * 180 / Math.PI;
    
    return { lon, lat, bearing };
}

// Update all vehicle positions
function updateVehiclePositions() {
    const activeVehicles = [];
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
                    headsign: vehicle.headsign,
                    type: vehicle.type,
                    color: vehicle.color,
                    bearing: vehicle.bearing
                },
                geometry: {
                    type: 'Point',
                    coordinates: [position.lon, position.lat]
                }
            });
            
            if (vehicle.type === 'tram') tramCount++;
            else if (vehicle.type === 'bus') busCount++;
            else if (vehicle.type === 'train') trainCount++;
        }
    });
    
    // Update source
    const source = map.getSource('vehicles');
    if (source) {
        source.setData({
            type: 'FeatureCollection',
            features: activeVehicles
        });
    }
    
    // Update counts
    document.getElementById('tramCount').textContent = tramCount;
    document.getElementById('busCount').textContent = busCount;
    document.getElementById('trainCount').textContent = trainCount;
}

// Update time display
function updateTimeDisplay() {
    const hours = Math.floor(simulationTime / 3600);
    const minutes = Math.floor((simulationTime % 3600) / 60);
    const seconds = Math.floor(simulationTime % 60);
    
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('currentTime').textContent = timeStr;
    
    // Update date display
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('currentDate').textContent = now.toLocaleDateString('en-US', options);
    
    // Update slider
    document.getElementById('timeSlider').value = simulationTime;
}

// Play/pause simulation
function togglePlay() {
    isPlaying = !isPlaying;
    const btn = document.getElementById('playBtn');
    
    if (isPlaying) {
        btn.textContent = '❚❚ Pause';
        playInterval = setInterval(() => {
            simulationTime += simulationSpeed;
            if (simulationTime >= 86400) simulationTime = 0;
            updateTimeDisplay();
            updateVehiclePositions();
        }, 1000 / 60); // 60 FPS
    } else {
        btn.textContent = '▶ Play';
        clearInterval(playInterval);
    }
}

// Reset to current time
function resetToNow() {
    const now = new Date();
    simulationTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    updateTimeDisplay();
    updateVehiclePositions();
}

// Update stats
function updateStats() {
    let tramRoutes = 0, busRoutes = 0, trainRoutes = 0;
    
    routes.forEach(route => {
        const type = getRouteType(route.gtfsId);
        if (type === 'tram') tramRoutes++;
        else if (type === 'train') trainRoutes++;
        else busRoutes++;
    });
    
    // Initial vehicle position update
    updateVehiclePositions();
}

// Setup user interactions
function setupInteractions() {
    // Time slider
    document.getElementById('timeSlider').addEventListener('input', (e) => {
        simulationTime = parseInt(e.target.value);
        updateTimeDisplay();
        updateVehiclePositions();
    });
    
    // Play button
    document.getElementById('playBtn').addEventListener('click', togglePlay);
    
    // Reset button
    document.getElementById('resetBtn').addEventListener('click', resetToNow);
    
    // Speed buttons
    document.querySelectorAll('.speed-buttons button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.speed-buttons button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            simulationSpeed = parseInt(btn.dataset.speed);
        });
    });
    
    // Legend toggles
    document.querySelectorAll('.legend-item').forEach(item => {
        item.addEventListener('click', () => {
            const type = item.dataset.type;
            visibleTypes[type] = !visibleTypes[type];
            item.classList.toggle('active', visibleTypes[type]);
            
            // Update route visibility
            updateRouteVisibility();
            updateVehiclePositions();
        });
    });
    
    // Vehicle click
    map.on('click', 'vehicles', (e) => {
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates;
        
        new mapboxgl.Popup()
            .setLngLat(coords)
            .setHTML(`
                <div class="vehicle-popup">
                    <h4>
                        <span class="route-badge" style="background: ${props.color}; color: white;">
                            ${props.routeName}
                        </span>
                        ${props.type.charAt(0).toUpperCase() + props.type.slice(1)}
                    </h4>
                    <p><strong>Direction:</strong> ${props.headsign}</p>
                </div>
            `)
            .addTo(map);
    });
    
    // Stop click
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
    
    // Cursor changes
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
    
    // 2D/3D view toggle
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

// Update route visibility based on legend toggles
function updateRouteVisibility() {
    const visibleTypesArray = Object.entries(visibleTypes)
        .filter(([_, visible]) => visible)
        .map(([type, _]) => type);
    
    if (visibleTypesArray.length === 0) {
        // Hide all if none selected
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Set initial time to now
    const now = new Date();
    simulationTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    
    initMap();
});
