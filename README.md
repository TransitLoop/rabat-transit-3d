# Rabat Transit 3D

Real-time 3D transit visualization for Rabat-Salé-Témara, Morocco.

![Rabat Transit 3D](https://img.shields.io/badge/MapBox-GL%20JS-blue) ![OpenTripPlanner](https://img.shields.io/badge/OTP-GraphQL-green)

## Features

- **Full-screen 3D map** with tilted perspective view using MapBox GL JS
- **Live vehicle animation** that starts automatically at wall-clock time (1 real second = 1 simulated second)
- **Small 3D tram and bus models** moving along their routes
- **3D/2D view toggle** with smooth transitions
- **Optional preview speeds** (10×, 60×, 5min) — default is Live
- **Route filtering** by transit type (Tram/Bus/Train)
- **Interactive popups** for vehicles and stops
- **Live statistics** showing active vehicle counts

## Data Source

Transit data is fetched from the OpenTripPlanner GraphQL endpoint:
- **Endpoint**: `https://rrm.transitloop.net/otp/routers/default/index/graphql`
- **Region**: Rabat-Salé-Témara (RRM), Morocco

A snapshot of those responses lives in `data/` so the map can render immediately. The app then refreshes routes, stops, and trips from OTP in the background.

Regenerate the snapshot:

```bash
node prefetch-data.js
```

## Mapbox token

The Mapbox access token is injected from environment variables at build time. **Set it before you deploy.**

Supported variable names (first match wins):

- `MAPBOX_ACCESS_TOKEN` (preferred)
- `MAPBOX_TOKEN`
- `MAPBOX_API_KEY`

### Netlify

1. Site settings → **Environment variables**
2. Add `MAPBOX_ACCESS_TOKEN` with your public Mapbox token (`pk.…`)
3. Deploy (or trigger a new deploy so the build can write `config.js`)

The Netlify build command is `node inject-env.js`, which writes the token into `config.js`.

### Local

```bash
cp .env.example .env
# paste your token into .env
node inject-env.js
python3 -m http.server 8080
```

You can also pass a token in the URL for a one-off test: `?token=YOUR_MAPBOX_TOKEN`

Get a free token at [mapbox.com](https://account.mapbox.com/access-tokens/)

## Quick Start

```bash
# After injecting a token (see above)
python3 -m http.server 8080
# or: npx serve .
```

Then visit `http://localhost:8080`

## Deploy to Netlify

### One-click deploy
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/TransitLoop/rabat-transit-3d)

Set `MAPBOX_ACCESS_TOKEN` in the site environment variables **before** the first deploy.

### Manual deploy
1. Fork this repository
2. Go to [Netlify](https://app.netlify.com)
3. Click **"Add new site"** → **"Import an existing project"**
4. Select your forked repository
5. Add `MAPBOX_ACCESS_TOKEN` under environment variables
6. Deploy (build command: `node inject-env.js`)

## Tech Stack

- **MapBox GL JS v3.3.0** - 3D map rendering
- **OpenTripPlanner GraphQL API** - Transit data
- **Vanilla JavaScript** - No frameworks needed

## Transit Types

| Type | Color | Description |
|------|-------|-------------|
| Tram | Pink | Tramway lines T1, T2 |
| Bus | Blue | Bus network (ALSA Rabat) |
| Train | Orange | ONCF rail services |

## Controls

| Control | Action |
|---------|--------|
| **Live / Pause** | Vehicles start live; pause freezes the clock |
| **Now** | Jump back to the current time of day and resume live |
| **Playback** | Live (real-time), or 10× / 60× / 5min preview |
| **Time slider** | Scrub through the day |
| **3D/2D toggle** | Switch map perspective |
| **Legend items** | Click to show/hide transit types |

## Reference

Inspired by [mobilitetsatlas.dk](https://mobilitetsatlas.dk/kommune/koebenhavn?view=gade) Copenhagen mobility atlas.

## License

MIT License - Built by [TransitLoop](https://transitloop.net)
