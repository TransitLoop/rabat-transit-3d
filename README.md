# Rabat Transit 3D

Real-time 3D transit visualization for Rabat-Salé-Témara, Morocco.

![Rabat Transit 3D](https://img.shields.io/badge/MapBox-GL%20JS-blue) ![OpenTripPlanner](https://img.shields.io/badge/OTP-GraphQL-green)

## Features

- **Full-screen 3D map** with tilted perspective view using MapBox GL JS
- **Real-time vehicle animation** showing trams, buses, and trains
- **3D/2D view toggle** with smooth transitions
- **Time simulation** with play/pause and adjustable speed (1×, 10×, 60×, 5min)
- **Route filtering** by transit type (Tram/Bus/Train)
- **Vehicle labels** visible at zoom
- **Interactive popups** for vehicles and stops
- **Live statistics** showing active vehicle counts

## Data Source

Transit data is fetched from the OpenTripPlanner GraphQL endpoint:
- **Endpoint**: `https://rrm.transitloop.net/otp/routers/default/index/graphql`
- **Region**: Rabat-Salé-Témara (RRM), Morocco

## Quick Start

### Option 1: Open directly
Simply open `index.html` in a web browser.

### Option 2: Local server
```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve .
```

Then visit `http://localhost:8080`

## Deploy to Netlify

### One-click deploy
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/TransitLoop/rabat-transit-3d)

### Manual deploy
1. Fork this repository
2. Go to [Netlify](https://app.netlify.com)
3. Click **"Add new site"** → **"Import an existing project"**
4. Select your forked repository
5. Deploy (no build command needed - it's a static site)

### Drag & Drop
1. Download this repository
2. Go to [Netlify](https://app.netlify.com) → **"Add new site"** → **"Deploy manually"**
3. Drag and drop the folder

## Custom MapBox Token

The app uses a public MapBox token by default. For full 3D buildings support, use your own token:

```
https://your-site.netlify.app/?token=YOUR_MAPBOX_TOKEN
```

Get a free token at [mapbox.com](https://account.mapbox.com/auth/signup/)

## Tech Stack

- **MapBox GL JS v3.3.0** - 3D map rendering
- **OpenTripPlanner GraphQL API** - Transit data
- **Vanilla JavaScript** - No frameworks needed

## Transit Types

| Type | Color | Description |
|------|-------|-------------|
| 🚋 Tram | Pink | Tramway lines T1, T2 |
| 🚌 Bus | Blue | Bus network (ALSA Rabat) |
| 🚂 Train | Orange | ONCF rail services |

## Controls

| Control | Action |
|---------|--------|
| **Play/Pause** | Start/stop vehicle animation |
| **Now** | Reset to current time |
| **Speed buttons** | 1×, 10×, 60×, 5min simulation speed |
| **Time slider** | Scrub through the day |
| **3D/2D toggle** | Switch map perspective |
| **Legend items** | Click to show/hide transit types |

## Reference

Inspired by [mobilitetsatlas.dk](https://mobilitetsatlas.dk/kommune/koebenhavn?view=gade) Copenhagen mobility atlas.

## License

MIT License - Built by [TransitLoop](https://transitloop.net)
