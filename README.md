# PumpWatch — Fuel price finder and comparer

PumpWatch compares reported fuel prices at stations across Cyprus. It includes
an interactive map, district and text search, cheapest-first sorting, nearby
search by browser location, radius filtering, and directions links. Location
is requested only after the visitor chooses **Find near me**.

## Data source and access status

Station prices are sourced from the [Cyprus Government Retail Fuel Price
Observatory](https://data.gov.cy/el/dataset/paratiritirio-lianikon-timon-kaysimon-api),
listed by the National Open Data Portal under CC BY-SA 4.0. The backend
normalizes station names, coordinates, districts, and individual 95, 98, and
diesel prices. It intentionally does not use the OilPriceAPI national average
as a station price.

The supplied backend follows the government observatory's web form, but the
form currently redirects unauthenticated requests to CY Login. When that
happens, PumpWatch reports that station data is unavailable; it does not show
fabricated demo stations. Authorized observatory access or a public official
API endpoint is needed for real prices to load. The upstream access issue is
not hidden by the deployment.

## Run locally

Requires Node.js 20 or newer. The app and API are served from the same origin.

```sh
npm start
```

Open `http://localhost:8787`. The backend refreshes on startup and every six
hours by default. It exposes:

- `GET /api/stations?fuel=95` (also `98` or `diesel`)
- `GET /api/source`
- `GET /health`
- `POST /api/refresh`

Set `CYPRUS_OBSERVATORY_URL`, `CYPRUS_USER_AGENT`, `PORT`, or `REFRESH_MS` in
the environment to configure the service. Do not commit access credentials.
The API serves only the static frontend files; it does not expose backend
source or environment files.

Run the parser tests with:

```sh
npm test
```

## Deploy with Docker

The included Dockerfile serves the static site and API together:

```sh
docker compose up --build -d
```

Publish port `8787` behind an HTTPS reverse proxy for geolocation. Configure
the host platform's health check as `GET /health`. If the upstream station
feed fails, `/health` returns a non-success response until data loads, while
the browser shows an explicit station-feed error.

## Notes

- Nearby search uses the user's location in the browser and filters the
  station feed by a selected radius. Coordinates are not sent to the backend.
- Districts are approximate groups derived from station coordinates; map
  pins retain the upstream coordinates.
- OpenStreetMap tiles and Leaflet are loaded from their public services.
- The government feed is refreshed periodically and marked stale if refreshes
  fail or the last successful refresh is over 12 hours old.
