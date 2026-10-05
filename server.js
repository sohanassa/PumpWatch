const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fetchAll } = require('./src/cyprus-observatory');

const PORT = Number(process.env.PORT || 8787);
const REFRESH_MS = Number(process.env.REFRESH_MS || 6 * 60 * 60 * 1000);
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const ROOT = __dirname;
const STATIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const state = { data: null, loading: false, lastError: null, lastAttempt: null };
let lastManualRefresh = 0;

async function refresh() {
  if (state.loading) return false;
  state.loading = true;
  state.lastAttempt = new Date().toISOString();
  try {
    const data = await fetchAll();
    if (!data || !Array.isArray(data.stations) || !Number.isFinite(data.stationCount)) {
      throw new Error('The observatory adapter returned invalid station data.');
    }
    state.data = data;
    state.lastError = null;
    console.log(`PumpWatch refreshed: ${data.stationCount} stations`);
    return true;
  } catch (error) {
    state.lastError = String(error?.message || error);
    console.error('PumpWatch refresh failed:', state.lastError);
    return false;
  } finally {
    state.loading = false;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function stationResponse(url) {
  const fuel = url.searchParams.get('fuel') || '95';
  if (!['95', '98', 'diesel'].includes(fuel)) {
    return { status: 400, body: { error: 'fuel must be 95, 98, or diesel' } };
  }
  if (!state.data) {
    return {
      status: 503,
      body: {
        stations: [],
        fuel,
        source: 'Cyprus Government Retail Fuel Price Observatory',
        updatedAt: null,
        loading: state.loading,
        error: state.lastError || 'Station data has not loaded yet.',
      },
    };
  }

  const stations = state.data.stations
    .filter((station) => station.prices?.[fuel] != null)
    .map((station) => ({ ...station, price: station.prices[fuel] }));
  const lastSuccess = Date.parse(state.data.fetchedAt);
  const stale = Boolean(state.lastError)
    || !Number.isFinite(lastSuccess)
    || Date.now() - lastSuccess > STALE_AFTER_MS;
  return {
    status: 200,
    body: {
      stations,
      fuel,
      source: state.data.source,
      updatedAt: state.data.fetchedAt,
      stationCount: stations.length,
      stale,
      ...(state.lastError ? { error: `Refresh failed; showing last successful data. ${state.lastError}` } : {}),
    },
  };
}

async function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path' });
    return;
  }
  if (decodedPath.includes('\0')) {
    sendJson(response, 400, { error: 'Invalid URL path' });
    return;
  }

  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  if (!STATIC_FILES.has(normalizedPath)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  const filePath = path.resolve(ROOT, `.${normalizedPath}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    console.error('Static file request failed:', error);
    sendJson(response, 500, { error: 'Unable to serve the requested file.' });
  }
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL' });
    return;
  }

  if (url.pathname === '/health') {
    sendJson(response, state.data ? 200 : 503, {
      ok: Boolean(state.data),
      loading: state.loading,
      lastAttempt: state.lastAttempt,
      updatedAt: state.data?.fetchedAt || null,
      stationCount: state.data?.stationCount || 0,
      stale: state.data ? stationResponse(new URL('http://localhost/?fuel=95')).body.stale : true,
      error: state.lastError,
    });
    return;
  }
  if (url.pathname === '/api/stations') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'GET required' });
      return;
    }
    const result = stationResponse(url);
    sendJson(response, result.status, result.body);
    return;
  }
  if (url.pathname === '/api/refresh') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST required' });
      return;
    }
    if (state.loading) {
      sendJson(response, 409, { ok: false, error: 'A refresh is already in progress.' });
      return;
    }
    const refreshCooldownMs = 60_000;
    const timeSinceRefresh = Date.now() - lastManualRefresh;
    if (timeSinceRefresh < refreshCooldownMs) {
      response.setHeader('Retry-After', String(Math.ceil((refreshCooldownMs - timeSinceRefresh) / 1000)));
      sendJson(response, 429, { ok: false, error: 'Please wait before requesting another refresh.' });
      return;
    }
    lastManualRefresh = Date.now();
    const ok = await refresh();
    sendJson(response, ok ? 200 : 503, {
      ok,
      updatedAt: state.data?.fetchedAt || null,
      stationCount: state.data?.stationCount || 0,
      error: state.lastError,
    });
    return;
  }
  if (url.pathname === '/api/source') {
    sendJson(response, 200, {
      name: 'Cyprus Government Retail Fuel Price Observatory',
      url: 'https://www.gov.cy/en/service/retail-fuel-price-observatory/',
      openDataUrl: 'https://data.gov.cy/el/dataset/paratiritirio-lianikon-timon-kaysimon-api',
      licence: 'CC BY-SA 4.0',
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'GET required' });
    return;
  }
  await serveStatic(request, response, url.pathname);
});

server.listen(PORT, () => {
  console.log(`PumpWatch listening on http://localhost:${PORT}`);
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
});
