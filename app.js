const FUEL_LABELS = { 95: 'Unleaded 95', 98: 'Unleaded 98', diesel: 'Diesel' };
const MAP_BOUNDS = [[34.35, 32.15], [35.85, 34.75]];
const $ = (id) => document.getElementById(id);

let fuel = '95';
let stations = [];
let userPosition = null;
let nearbyOnly = false;
let feedError = null;
let feedWarning = null;
let feedIsStale = false;
let feedUpdatedAt = null;
let map;
let markers = [];
let userMarker;
let searchTimer;
let loadController;

function formatEuro(value) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

function haversineKm(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function directionsUrl(station) {
  return `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`;
}

function setFeedStatus(message, status = 'live') {
  const statusElement = $('feedStatus');
  statusElement.className = `feed-status ${status}`;
  $('feedMessage').textContent = message;
  $('retryBtn').hidden = status !== 'error';
}

function stationFromApi(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  const price = Number(value.price ?? value.prices?.[fuel]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < MAP_BOUNDS[0][0] || lat > MAP_BOUNDS[1][0]
    || lng < MAP_BOUNDS[0][1] || lng > MAP_BOUNDS[1][1]
    || !Number.isFinite(price) || price <= 0 || price > 5) return null;

  return {
    id: String(value.id ?? `${lat},${lng}`),
    name: String(value.name || value.brand || value.company || 'Fuel station'),
    brand: String(value.brand || ''),
    company: String(value.company || ''),
    address: String(value.address || value.village || value.district || ''),
    district: String(value.district || ''),
    lat,
    lng,
    price,
  };
}

function setEmptyState(title, message) {
  $('emptyTitle').textContent = title;
  $('emptyMessage').textContent = message;
  $('emptyState').hidden = false;
}

function buildPopup(station) {
  const popup = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'popup-name';
  name.textContent = station.name;
  popup.append(name);

  const detail = document.createElement('p');
  detail.className = 'popup-detail';
  detail.textContent = [station.company, station.address, station.district]
    .filter((part, index, values) => part && values.indexOf(part) === index)
    .join(' · ');
  if (detail.textContent) popup.append(detail);

  const price = document.createElement('p');
  price.className = 'popup-price';
  price.textContent = `${formatEuro(station.price)} / L`;
  popup.append(price);

  if (station.distance != null) {
    const distance = document.createElement('p');
    distance.className = 'popup-detail';
    distance.textContent = `${station.distance.toFixed(1)} km away`;
    popup.append(distance);
  }

  const directions = document.createElement('a');
  directions.className = 'popup-nav';
  directions.href = directionsUrl(station);
  directions.target = '_blank';
  directions.rel = 'noopener noreferrer';
  directions.textContent = 'Get directions ↗';
  popup.append(directions);
  return popup;
}

function filteredStations() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const district = $('area').value;
  const radius = Number($('radius').value);
  const results = stations
    .filter((station) => district === 'all' || station.district === district)
    .filter((station) => !query || [
      station.name, station.brand, station.company, station.address, station.district,
    ].join(' ').toLocaleLowerCase().includes(query))
    .map((station) => ({
      ...station,
      distance: userPosition ? haversineKm(userPosition, station) : null,
    }))
    .filter((station) => !nearbyOnly || (station.distance != null && station.distance <= radius));

  const sort = $('sort').value;
  results.sort((a, b) => {
    if (sort === 'distance' && userPosition) return a.distance - b.distance || a.price - b.price;
    if (sort === 'name') return a.name.localeCompare(b.name) || a.price - b.price;
    return a.price - b.price || (a.distance ?? Infinity) - (b.distance ?? Infinity);
  });
  return results;
}

function renderList(results) {
  const list = $('stationList');
  list.replaceChildren();
  $('emptyState').hidden = results.length > 0;

  if (results.length === 0) {
    if (feedError && stations.length === 0) {
      setEmptyState('Station prices unavailable', 'The government station-price feed could not be reached. Try again later; no sample station prices are shown.');
    } else if (nearbyOnly && stations.length > 0) {
      setEmptyState('No stations in this radius', 'Try a larger nearby distance or show all stations across Cyprus.');
    } else if (stations.length > 0) {
      setEmptyState('No matching stations', 'Try a different search or district.');
    } else {
      setEmptyState('No stations reported', 'There are no stations with a reported price for this fuel type right now.');
    }
    return;
  }

  const lowestPrice = results[0].price;
  for (const [index, station] of results.entries()) {
    const card = document.createElement('article');
    card.className = 'station-card';

    const rank = document.createElement('span');
    rank.className = 'station-rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    card.append(rank);

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'station-info station-focus-button';
    const name = document.createElement('div');
    name.className = 'station-name';
    name.textContent = station.name;
    info.append(name);
    const address = document.createElement('div');
    address.className = 'station-address';
    address.textContent = [station.company, station.address, station.district]
      .filter((part, partIndex, parts) => part && parts.indexOf(part) === partIndex)
      .join(' · ') || 'Cyprus';
    info.append(address);
    if (station.distance != null) {
      const distance = document.createElement('div');
      distance.className = 'station-distance';
      distance.textContent = `${station.distance.toFixed(1)} km away`;
      info.append(distance);
    }
    info.setAttribute('aria-label', `${station.name}, ${formatEuro(station.price)} per litre. Show on map.`);
    info.addEventListener('click', () => {
      const marker = markers.find((entry) => entry.station.id === station.id);
      if (marker) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14));
        marker.openPopup();
      }
    });
    card.append(info);

    const actions = document.createElement('div');
    actions.className = 'station-actions';
    const priceBlock = document.createElement('div');
    const price = document.createElement('div');
    price.className = 'station-price';
    price.textContent = formatEuro(station.price);
    priceBlock.append(price);
    const unit = document.createElement('div');
    unit.className = 'station-price-unit';
    unit.textContent = 'per litre';
    priceBlock.append(unit);
    if (station.price === lowestPrice) {
      const badge = document.createElement('span');
      badge.className = 'cheapest-badge';
      badge.textContent = 'LOWEST';
      priceBlock.append(badge);
    }
    actions.append(priceBlock);

    const directions = document.createElement('a');
    directions.className = 'directions-link';
    directions.href = directionsUrl(station);
    directions.target = '_blank';
    directions.rel = 'noopener noreferrer';
    directions.textContent = 'Directions ↗';
    directions.setAttribute('aria-label', `Directions to ${station.name}`);
    actions.append(directions);
    card.append(actions);
    list.append(card);
  }
}

function renderMap(results, fit = false) {
  if (!window.L) {
    $('map').textContent = 'The interactive map could not load. You can still browse the station list below.';
    $('map').classList.add('map-unavailable');
    return;
  }

  if (!map) {
    map = L.map('map', { scrollWheelZoom: false, zoomControl: false }).setView([35.1264, 33.4299], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
  }

  markers.forEach(({ marker }) => marker.remove());
  markers = [];
  results.forEach((station) => {
    const priceLabel = formatEuro(station.price);
    const icon = L.divIcon({
      className: 'map-price-icon',
      html: `<div class="map-price-pin"><span>${priceLabel}</span></div>`,
      iconSize: [52, 27],
      iconAnchor: [13, 25],
      popupAnchor: [13, -23],
    });
    const marker = L.marker([station.lat, station.lng], { icon })
      .bindPopup(buildPopup(station))
      .addTo(map);
    markers.push({ station, marker });
  });

  if (userMarker) userMarker.remove();
  if (userPosition) {
    userMarker = L.marker([userPosition.lat, userPosition.lng], {
      icon: L.divIcon({
        className: '',
        html: '<span class="user-marker"></span>',
        iconSize: [15, 15],
        iconAnchor: [7, 7],
      }),
      zIndexOffset: 1000,
    }).bindPopup('Your location').addTo(map);
  }

  if (fit && results.length) {
    const bounds = L.latLngBounds(results.map((station) => [station.lat, station.lng]));
    if (userPosition && nearbyOnly) bounds.extend([userPosition.lat, userPosition.lng]);
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: nearbyOnly ? 12 : 9 });
  } else if (userPosition && nearbyOnly && map) {
    map.setView([userPosition.lat, userPosition.lng], 11);
  }
  if (map) window.setTimeout(() => map.invalidateSize(), 0);
}

function render(fitMap = false) {
  const results = filteredStations();
  const title = nearbyOnly ? 'Stations near you' : 'Stations across Cyprus';
  $('resultsTitle').textContent = title;
  $('resultsDescription').textContent = nearbyOnly
    ? `Showing ${$('radius').value} km around your location. Prices are for ${FUEL_LABELS[fuel]}.`
    : `Fuel prices and station locations for ${FUEL_LABELS[fuel]} from the Cyprus Government Observatory.`;
  $('listTitle').textContent = nearbyOnly ? 'Nearby fuel stations' : 'Fuel stations';
  $('count').textContent = `${results.length} ${results.length === 1 ? 'station' : 'stations'}`;
  $('updated').textContent = feedUpdatedAt
    ? `Feed checked ${new Date(feedUpdatedAt).toLocaleString()}${feedIsStale ? ' · last successful refresh' : ''}`
    : 'Waiting for station data';
  renderList(results);
  renderMap(results, fitMap);
  $('locationLabel').textContent = nearbyOnly ? 'Show all Cyprus' : 'Find near me';
  $('locateBtn').setAttribute('aria-label', nearbyOnly ? 'Show all stations across Cyprus' : 'Find nearby fuel stations');
}

function updateStatus() {
  if (feedError) {
    setFeedStatus(feedError, 'error');
    return;
  }
  if (feedIsStale) {
    setFeedStatus(feedWarning || `Showing last successful feed${feedUpdatedAt ? ` · checked ${new Date(feedUpdatedAt).toLocaleString()}` : ''}; refresh is needed.`, 'stale');
    return;
  }
  if (feedUpdatedAt) {
    setFeedStatus(`Government feed checked ${new Date(feedUpdatedAt).toLocaleString()}. Prices can change at the pump.`, 'live');
    return;
  }
  setFeedStatus('Loading station prices…', 'loading');
}

async function loadStations() {
  loadController?.abort();
  loadController = new AbortController();
  const controller = loadController;
  const requestedFuel = fuel;
  setFeedStatus('Loading station prices…', 'loading');
  $('retryBtn').hidden = true;
  try {
    const response = await fetch(`/api/stations?fuel=${encodeURIComponent(requestedFuel)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (controller !== loadController) return;
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('The station API did not return JSON. Run PumpWatch through its Node server, not a static file server.');
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Station feed returned HTTP ${response.status}`);
    }
    if (!data || !Array.isArray(data.stations)) {
      throw new Error('The station feed returned an invalid response.');
    }
    stations = data.stations.map(stationFromApi).filter(Boolean);
    feedUpdatedAt = data.updatedAt || null;
    feedIsStale = data.stale === true;
    feedWarning = data.error || null;
    feedError = stations.length === 0 ? (data.error || null) : null;
    if (data.stations.length > stations.length) {
      console.warn(`Ignored ${data.stations.length - stations.length} invalid ${requestedFuel} station record(s).`);
    }
    updateStatus();
    render(true);
  } catch (error) {
    if (error.name === 'AbortError' || controller !== loadController) return;
    stations = [];
    feedUpdatedAt = null;
    feedIsStale = false;
    feedWarning = null;
    feedError = error.message || 'Station prices could not be loaded.';
    updateStatus();
    render(true);
    console.error('Unable to load Cyprus station prices:', error);
  }
}

function locationFailed(message) {
  $('locationNote').hidden = false;
  $('locationNote').textContent = message;
}

function useLocation() {
  if (userPosition && nearbyOnly) {
    nearbyOnly = false;
    $('locationNote').hidden = true;
    $('radiusWrap').hidden = true;
    render(true);
    return;
  }
  if (!navigator.geolocation) {
    locationFailed('Location is not available in this browser. You can still browse all stations by district.');
    return;
  }

  const button = $('locateBtn');
  button.disabled = true;
  $('locationNote').hidden = true;
  navigator.geolocation.getCurrentPosition((position) => {
    userPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
    nearbyOnly = true;
    $('area').value = 'all';
    $('sort').value = 'distance';
    $('radiusWrap').hidden = false;
    $('sort').querySelector('option[value="distance"]').disabled = false;
    $('locationNote').hidden = true;
    button.disabled = false;
    render(true);
    if (!stations.length) locationFailed('Your location is ready. Nearby stations will appear when the station-price feed is available.');
  }, (error) => {
    button.disabled = false;
    const message = error.code === error.PERMISSION_DENIED
      ? 'Location permission was not granted. You can still browse all stations by district.'
      : 'Your location could not be determined. Please try again or browse all stations.';
    locationFailed(message);
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
}

document.querySelectorAll('[data-fuel]').forEach((button) => {
  button.addEventListener('click', () => {
    if (fuel === button.dataset.fuel) return;
    fuel = button.dataset.fuel;
    document.querySelectorAll('[data-fuel]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    loadStations();
  });
});

['search', 'area', 'sort', 'radius'].forEach((id) => {
  $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
    if (id === 'sort' && $('sort').value === 'distance' && !userPosition) {
      $('sort').value = 'price';
      locationFailed('Choose “Find near me” to sort stations by distance.');
    }
    if (id === 'search') {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => render(), 150);
    } else {
      render(id === 'area');
    }
  });
});

$('locateBtn').addEventListener('click', useLocation);
$('retryBtn').addEventListener('click', loadStations);
document.addEventListener('DOMContentLoaded', () => {
  $('sort').querySelector('option[value="distance"]').disabled = true;
  loadStations();
});
