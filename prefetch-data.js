#!/usr/bin/env node
/**
 * Download OTP + sun API responses into /data for a fast first paint.
 * Usage: node prefetch-data.js
 */
const fs = require('fs');
const path = require('path');

const OTP_ENDPOINT = 'https://rrm.transitloop.net/otp/routers/default/index/graphql';
const SUN_API_URL = 'https://api.sunrise-sunset.org/v2';
const RABAT = { lat: 34.0209, lng: -6.8498, tzid: 'Africa/Casablanca' };
const OUT_DIR = path.join(__dirname, 'data');

const ROUTES_QUERY = `{
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

const STOPS_QUERY = `{
    stops {
        gtfsId
        name
        lat
        lon
        routes { gtfsId shortName }
    }
}`;

const TRIPS_QUERY = `{
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

function compactTrips(trips) {
    const stopList = [];
    const stopIndex = new Map();

    const idForStop = (stop) => {
        if (!stop?.gtfsId) return -1;
        if (!stopIndex.has(stop.gtfsId)) {
            stopIndex.set(stop.gtfsId, stopList.length);
            stopList.push({ gtfsId: stop.gtfsId, name: stop.name || '' });
        }
        return stopIndex.get(stop.gtfsId);
    };

    return {
        v: 1,
        fetchedAt: new Date().toISOString(),
        stops: stopList,
        trips: (trips || []).map((trip) => ({
            id: trip.gtfsId,
            h: trip.tripHeadsign || '',
            p: trip.pattern?.name || '',
            r: trip.pattern?.route
                ? {
                    id: trip.pattern.route.gtfsId,
                    n: trip.pattern.route.shortName,
                    l: trip.pattern.route.longName,
                    c: trip.pattern.route.color,
                    t: trip.pattern.route.textColor
                }
                : null,
            s: (trip.stoptimes || []).map((stoptime) => [
                idForStop(stoptime.stop),
                stoptime.scheduledArrival ?? 0,
                stoptime.scheduledDeparture ?? 0
            ])
        }))
    };
}

async function graphqlQuery(query, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(OTP_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`OTP ${response.status} ${response.statusText}`);
        }
        const payload = await response.json();
        if (payload.errors?.length) {
            console.warn('GraphQL errors:', payload.errors.map((error) => error.message).join('; '));
        }
        return payload.data || {};
    } finally {
        clearTimeout(timer);
    }
}

function writeJson(filename, value) {
    const target = path.join(OUT_DIR, filename);
    fs.writeFileSync(target, JSON.stringify(value));
    const mb = (fs.statSync(target).size / (1024 * 1024)).toFixed(2);
    console.log(`Wrote data/${filename} (${mb} MB)`);
}

async function fetchSun() {
    const url = new URL(SUN_API_URL);
    url.searchParams.set('lat', String(RABAT.lat));
    url.searchParams.set('lng', String(RABAT.lng));
    url.searchParams.set('tzid', RABAT.tzid);
    url.searchParams.set('date', new Date().toISOString().slice(0, 10));
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`Sunrise-sunset ${response.status}`);
    return response.json();
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log('Fetching routes...');
    const routes = (await graphqlQuery(ROUTES_QUERY, 120000)).routes || [];
    writeJson('routes.json', { fetchedAt: new Date().toISOString(), routes });

    console.log('Fetching stops...');
    const stops = (await graphqlQuery(STOPS_QUERY, 120000)).stops || [];
    writeJson('stops.json', { fetchedAt: new Date().toISOString(), stops });

    console.log('Fetching trips (this is the slow call)...');
    const trips = (await graphqlQuery(TRIPS_QUERY, 180000)).trips || [];
    writeJson('trips.json', compactTrips(trips));

    try {
        console.log('Fetching sunrise-sunset...');
        const sun = await fetchSun();
        writeJson('sun.json', { fetchedAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10), ...sun });
    } catch (error) {
        console.warn('Sun snapshot skipped:', error.message);
    }

    writeJson('manifest.json', {
        fetchedAt: new Date().toISOString(),
        routes: routes.length,
        stops: stops.length,
        trips: trips.length
    });

    console.log(`Done. ${routes.length} routes, ${stops.length} stops, ${trips.length} trips.`);
}

main().catch((error) => {
    console.error(error);
    const hasSnapshot = ['routes.json', 'stops.json', 'trips.json'].every((name) =>
        fs.existsSync(path.join(OUT_DIR, name))
    );
    if (hasSnapshot) {
        console.warn('Keeping existing data/ snapshot.');
        process.exit(0);
    }
    process.exit(1);
});
