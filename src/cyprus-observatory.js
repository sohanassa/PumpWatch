const PAGE_URL = process.env.CYPRUS_OBSERVATORY_URL
  || 'https://eforms.eservices.cyprus.gov.cy/MCIT/MCIT/PetroleumPrices';
const USER_AGENT = process.env.CYPRUS_USER_AGENT || 'PumpWatch/1.0 (Cyprus fuel price finder)';
const FUELS = [
  { type: 1, key: '95' },
  { type: 2, key: '98' },
  { type: 3, key: 'diesel' },
];
const BOUNDS = { latMin: 34.4, latMax: 35.8, lonMin: 32.2, lonMax: 34.7 };

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseCoordinates(raw) {
  let text;
  try {
    text = decodeURIComponent(decodeEntities(raw));
  } catch {
    return null;
  }
  const decimal = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (decimal) return [Number(decimal[1]), Number(decimal[2])];

  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′]\s*(\d+(?:\.\d+)?)\s*["″]?\s*([NSEW])/g)];
  if (parts.length !== 2) return null;
  let lat = null;
  let lng = null;
  for (const [, degrees, minutes, seconds, hemisphere] of parts) {
    const value = Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600;
    if (hemisphere === 'N' || hemisphere === 'S') {
      lat = hemisphere === 'S' ? -value : value;
    } else {
      lng = hemisphere === 'W' ? -value : value;
    }
  }
  return lat == null || lng == null ? null : [lat, lng];
}

function parseTable(html) {
  const rows = [];
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/isOffLine/i.test(row)) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 5) continue;
    const coordinate = row.match(/coordinates=([^"'&]+)/i);
    if (!coordinate) continue;
    const coords = parseCoordinates(coordinate[1]);
    if (!coords) continue;
    const [lat, lng] = coords;
    if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lonMin || lng > BOUNDS.lonMax) continue;

    const price = Number(cellText(cells[4]).replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0 || price > 5) continue;
    rows.push({
      brand: cellText(cells[0]),
      company: cellText(cells[1]),
      address: cellText(cells[2]),
      village: cellText(cells[3]),
      price,
      lat,
      lng,
    });
  }
  return rows;
}

function cookiesFrom(response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const values = getSetCookie
    ? getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  return values.map((cookie) => cookie.split(';')[0]).join('; ');
}

function extractToken(html) {
  return html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)?.[1]
    || html.match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i)?.[1];
}

function districtFor(lat, lng) {
  const centers = [
    ['Nicosia', 35.174, 33.364],
    ['Limassol', 34.678, 33.044],
    ['Larnaca', 34.922, 33.623],
    ['Paphos', 34.775, 32.425],
    ['Famagusta', 35.04, 33.98],
  ];
  let closest = centers[0];
  let closestDistance = Infinity;
  for (const center of centers) {
    const distance = (lat - center[1]) ** 2 + (lng - center[2]) ** 2;
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = center;
    }
  }
  return closest[0];
}

async function fetchHtml() {
  const response = await fetch(PAGE_URL, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') || '';
    throw new Error(`Observatory redirected (${response.status}) to ${location}. The web-form feed requires authorized access.`);
  }
  if (!response.ok) throw new Error(`Observatory GET returned HTTP ${response.status}`);

  const html = await response.text();
  const token = extractToken(html);
  if (!token) throw new Error('Observatory form has no anti-forgery token; the page or access requirements have changed.');
  return { token, cookie: cookiesFrom(response) };
}

async function fetchFuel(token, cookie, fuel) {
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    'Entity.PetroleumType': String(fuel.type),
    'Entity.StationCityEnum': 'All',
    'Entity.StationDistrict': '',
  });
  const response = await fetch(PAGE_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Observatory request for ${fuel.key} redirected to ${response.headers.get('location') || 'unknown location'}.`);
  }
  if (!response.ok) throw new Error(`Observatory request for ${fuel.key} returned HTTP ${response.status}`);
  return parseTable(await response.text());
}

async function fetchAll() {
  const { token, cookie } = await fetchHtml();
  const stations = new Map();
  const fetchedAt = new Date().toISOString();
  const counts = {};

  for (const fuel of FUELS) {
    const rows = await fetchFuel(token, cookie, fuel);
    counts[fuel.key] = rows.length;
    for (const row of rows) {
      const id = `cy-${row.lat.toFixed(5)},${row.lng.toFixed(5)}`;
      let station = stations.get(id);
      if (!station) {
        station = {
          id,
          name: row.brand || row.company || id,
          brand: row.brand || null,
          company: row.company || null,
          address: row.address,
          district: districtFor(row.lat, row.lng),
          lat: row.lat,
          lng: row.lng,
          prices: {},
          updatedAt: fetchedAt,
        };
        stations.set(id, station);
      }
      station.prices[fuel.key] = row.price;
    }
  }

  return {
    source: 'Cyprus Government Retail Fuel Price Observatory',
    fetchedAt,
    stationCount: stations.size,
    counts,
    stations: [...stations.values()],
  };
}

module.exports = { fetchAll, parseCoordinates, parseTable, districtFor };
