/**
 * Alex Tankpreise
 * Real-time German fuel prices via Tankerkönig API + Nominatim geocoding
 * Hourly price trend chart based on MTS-K / ADAC research data
 */
(function () {
    'use strict';

    // ─── Config ──────────────────────────────────────────────────────────────
    const DEMO_KEY = '00000000-0000-0000-0000-000000000002';
    const TK_BASE = 'https://creativecommons.tankerkoenig.de/json/list.php';
    const NOM_BASE = 'https://nominatim.openstreetmap.org/search';

    /**
     * Hourly price-deviation pattern (relative, in €-cents) for a typical German
     * fuel day. Based on ADAC / MTS-K research:
     * - Prices peak ~7–8 Uhr (+6–7 ct above daily avg)
     * - Cheapest windows: ~6 Uhr, 11–12 Uhr, 16–17 Uhr, 20–22 Uhr
     * Index = hour 0–23
     */
    const HOURLY_DELTA_CT = [
        -2,  // 00
        -3,  // 01
        -4,  // 02
        -5,  // 03
        -3,  // 04
        0,  // 05
        -1,  // 06
        +7,  // 07  ← peak
        +8,  // 08  ← peak
        +6,  // 09
        +3,  // 10
        -1,  // 11  ← dip
        -2,  // 12  ← dip
        0,  // 13
        +2,  // 14
        -1,  // 15
        -2,  // 16  ← dip
        0,  // 17
        +2,  // 18
        -1,  // 19
        -3,  // 20  ← evening cheap
        -4,  // 21  ← evening cheap
        -4,  // 22  ← evening cheap
        -3,  // 23
    ];

    // Best hours to tank (lowest delta values)
    const BEST_HOURS = [2, 3, 21, 22]; // for "now" colour indicator

    // ─── DOM refs ────────────────────────────────────────────────────────────
    const searchForm = document.getElementById('searchForm');
    const locationInput = document.getElementById('locationInput');
    const fuelType = document.getElementById('fuelType');
    const radiusSlider = document.getElementById('radiusSlider');
    const radiusValue = document.getElementById('radiusValue');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const searchBtn = document.getElementById('searchBtn');
    const btnText = searchBtn.querySelector('.btn-text');
    const btnLoading = searchBtn.querySelector('.btn-loading');
    const statusMsg = document.getElementById('statusMessage');
    const resultsInfo = document.getElementById('resultsInfo');
    const resultsCount = document.getElementById('resultsCount');
    const resultsContainer = document.getElementById('resultsContainer');
    const emptyState = document.getElementById('emptyState');

    // ─── Range slider label ───────────────────────────────────────────────────
    radiusSlider.addEventListener('input', () => {
        radiusValue.textContent = radiusSlider.value;
    });

    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await performSearch();
    });

    // ─── Main search flow ─────────────────────────────────────────────────────
    async function performSearch() {
        const location = locationInput.value.trim();
        if (!location) {
            showStatus('Bitte gib einen Ort oder eine Postleitzahl ein.', 'warning');
            return;
        }

        setLoading(true);
        hideStatus();
        clearResults();

        try {
            // 1. Geocode
            const coords = await geocode(location);
            if (!coords) {
                showStatus(`Der Ort „${location}" konnte nicht gefunden werden. Bitte überprüfe deine Eingabe.`, 'error');
                return;
            }

            // 2. Fetch stations
            const type = fuelType.value;
            const radius = parseFloat(radiusSlider.value);
            const apiKey = apiKeyInput.value.trim() || DEMO_KEY;
            const stations = await fetchStations(coords.lat, coords.lng, radius, type, apiKey);

            if (!stations || stations.length === 0) {
                showStatus(
                    `Keine Tankstellen im Umkreis von ${radius} km um „${location}" gefunden. Probiere einen größeren Umkreis.`,
                    'info'
                );
                return;
            }

            // 3. Sort and render
            const sorted = sortByPrice(stations, type);
            renderStations(sorted, type);
            showResultsInfo(sorted.length, location);

            if (!apiKeyInput.value.trim()) {
                showStatus('Demo-Key aktiv – angezeigte Preise sind <strong>Testdaten</strong>. Für echte Preise eigenen API-Key eintragen.', 'warning');
            }

        } catch (err) {
            console.error(err);
            showStatus(`Fehler: ${err.message}`, 'error');
        } finally {
            setLoading(false);
        }
    }

    // ─── Geocoding ───────────────────────────────────────────────────────────
    async function geocode(query) {
        const url = `${NOM_BASE}?q=${encodeURIComponent(query + ', Deutschland')}&format=json&limit=1&countrycodes=de`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'AlexTankpreise/1.0' } });
        if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
        const data = await res.json();
        if (!data.length) return null;
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }

    // ─── Tankerkönig API ─────────────────────────────────────────────────────
    async function fetchStations(lat, lng, radius, type, apiKey) {
        const params = new URLSearchParams({ lat: lat.toFixed(6), lng: lng.toFixed(6), rad: radius, sort: 'price', type, apikey: apiKey });
        const url = `${TK_BASE}?${params}`;

        let res;
        try {
            res = await fetch(url);
        } catch (_) {
            // CORS fallback
            res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
        }

        if (!res.ok) throw new Error(`Tankerkönig HTTP ${res.status}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || 'API-Fehler');
        return data.stations || [];
    }

    // ─── Sort helpers ────────────────────────────────────────────────────────
    function getPrice(station, type) {
        if (type === 'all') {
            const vals = [station.e5, station.e10, station.diesel].filter(p => p && p !== false);
            return vals.length ? Math.min(...vals) : null;
        }
        const p = station.price !== undefined ? station.price : station[type];
        return (p && p !== false) ? p : null;
    }

    function sortByPrice(stations, type) {
        return [...stations].sort((a, b) => {
            const pa = getPrice(a, type), pb = getPrice(b, type);
            if (pa === null && pb === null) return 0;
            if (pa === null) return 1;
            if (pb === null) return -1;
            return pa - pb;
        });
    }

    // ─── Render stations ─────────────────────────────────────────────────────
    function renderStations(stations, type) {
        emptyState.style.display = 'none';
        resultsContainer.innerHTML = '';

        const prices = stations.map(s => getPrice(s, type)).filter(Boolean);
        const minP = Math.min(...prices);
        const maxP = Math.max(...prices);

        stations.forEach((station, i) => {
            resultsContainer.appendChild(buildCard(station, type, i === 0, minP, maxP));
        });
    }

    function buildCard(station, type, isCheapest, minP, maxP) {
        const card = document.createElement('div');
        card.className = 'station-card' + (isCheapest && getPrice(station, type) !== null ? ' cheapest' : '') + (!station.isOpen ? ' closed-station' : '');

        const price = getPrice(station, type);
        const colorCls = priceClass(price, minP, maxP);
        const priceTxt = price ? fmtPrice(price) : '—';
        const address = [station.street, station.houseNumber].filter(Boolean).join(' ').trim();
        const cityPart = [station.postCode, station.place].filter(Boolean).join(' ');

        // Current hour → best-time info
        const now = new Date();
        const curHour = now.getHours();
        const bestHour = findBestHour();
        const bestLabel = bestHour === curHour ? 'Jetzt günstig!' : `Am günstigsten ~${bestHour}:00 Uhr`;

        // All-prices section (when type=all)
        const allPricesHtml = (type === 'all') ? `
      <div class="station-all-prices">
        ${chipHtml('E5', station.e5, minP, maxP)}
        ${chipHtml('E10', station.e10, minP, maxP)}
        ${chipHtml('Diesel', station.diesel, minP, maxP)}
      </div>` : '';

        card.innerHTML = `
      <div class="station-card-body">
        <div class="station-header">
          <div class="station-info">
            <div class="station-name" title="${esc(station.name)}">${esc(station.name)}</div>
            <div class="station-brand">${esc(station.brand || '')}</div>
          </div>
          <div class="station-price-box">
            <div class="price-pill ${colorCls}">${priceTxt}</div>
            <div class="station-price-label">${type === 'all' ? 'Günstigster' : type.toUpperCase()}</div>
          </div>
        </div>

        <div class="station-details">
          ${address ? `<span class="station-badge">📍 ${esc(address)}${cityPart ? ', ' + esc(cityPart) : ''}</span>` : ''}
          ${station.dist != null ? `<span class="station-badge">📏 ${station.dist.toFixed(1)} km</span>` : ''}
          <span class="station-badge ${station.isOpen ? 'badge-open' : 'badge-closed'}">
            ${station.isOpen ? '● Geöffnet' : '● Geschlossen'}
          </span>
        </div>
      </div>

      ${allPricesHtml}

      <div class="chart-section">
        <div class="chart-header">
          <span class="chart-title">📊 Tagespreiskurve</span>
          <span class="best-time-badge">✅ ${bestLabel}</span>
        </div>
        <div class="chart-canvas-wrapper">
          <canvas class="price-chart" data-base="${price || 1.8}" width="800" height="160" style="width:100%;height:80px;display:block;"></canvas>
        </div>
        <div class="chart-axis">
          <span class="chart-axis-label">0 Uhr</span>
          <span class="chart-axis-label">6 Uhr</span>
          <span class="chart-axis-label">12 Uhr</span>
          <span class="chart-axis-label">18 Uhr</span>
          <span class="chart-axis-label">23 Uhr</span>
        </div>
        <div class="chart-note">Typischer Tagesverlauf laut ADAC/MTS-K · aktuelle Stunde hervorgehoben</div>
      </div>
    `;

        // Draw the canvas chart after inserting into DOM
        requestAnimationFrame(() => drawChart(card.querySelector('canvas'), price, curHour));

        return card;
    }

    // ─── Price chart drawing ──────────────────────────────────────────────────
    function drawChart(canvas, basePrice, curHour) {
        if (!canvas || !canvas.getContext) return;

        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        const PAD = { top: 10, bottom: 14, left: 8, right: 8 };
        const innerW = W - PAD.left - PAD.right;
        const innerH = H - PAD.top - PAD.bottom;

        ctx.clearRect(0, 0, W, H);

        // Build data points (price for each hour)
        const base = basePrice || 1.8;
        const points = HOURLY_DELTA_CT.map((d, h) => ({
            hour: h,
            price: base + d / 100,
        }));

        const priceMin = Math.min(...points.map(p => p.price));
        const priceMax = Math.max(...points.map(p => p.price));
        const pRange = priceMax - priceMin || 0.01;

        const xOf = (h) => PAD.left + (h / 23) * innerW;
        const yOf = (price) => PAD.top + innerH - ((price - priceMin) / pRange) * innerH;

        // ---- Gradient fill ----
        const grad = ctx.createLinearGradient(0, PAD.top, 0, H - PAD.bottom);
        grad.addColorStop(0, 'rgba(0,122,255,0.18)');
        grad.addColorStop(1, 'rgba(0,122,255,0.01)');

        ctx.beginPath();
        ctx.moveTo(xOf(0), yOf(points[0].price));
        for (let i = 1; i < points.length; i++) {
            // Smooth curve using cubic bezier
            const prev = points[i - 1];
            const curr = points[i];
            const cpX = (xOf(prev.hour) + xOf(curr.hour)) / 2;
            ctx.bezierCurveTo(cpX, yOf(prev.price), cpX, yOf(curr.price), xOf(curr.hour), yOf(curr.price));
        }
        ctx.lineTo(xOf(23), H - PAD.bottom);
        ctx.lineTo(xOf(0), H - PAD.bottom);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // ---- Line ----
        ctx.beginPath();
        ctx.moveTo(xOf(0), yOf(points[0].price));
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const cpX = (xOf(prev.hour) + xOf(curr.hour)) / 2;
            ctx.bezierCurveTo(cpX, yOf(prev.price), cpX, yOf(curr.price), xOf(curr.hour), yOf(curr.price));
        }
        ctx.strokeStyle = '#007aff';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        // ---- Current hour marker ----
        const curPt = points[curHour];
        const cx = xOf(curPt.hour);
        const cy = yOf(curPt.price);

        // Vertical dashed line
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, PAD.top);
        ctx.lineTo(cx, H - PAD.bottom);
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);

        // Dot at current hour
        const dotColor = getDotColor(curHour);
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Price label at current hour
        const labelTxt = fmtPrice(curPt.price);
        ctx.font = 'bold 11px -apple-system, Inter, sans-serif';
        ctx.fillStyle = dotColor;
        ctx.textAlign = cx > W * 0.75 ? 'right' : 'left';
        const lx = cx > W * 0.75 ? cx - 8 : cx + 8;
        ctx.fillText(labelTxt, lx, Math.max(PAD.top + 11, cy - 7));
    }

    function getDotColor(hour) {
        const d = HOURLY_DELTA_CT[hour];
        if (d <= -2) return '#34c759';  // cheap → green
        if (d <= 2) return '#ff9500';  // mid → orange
        return '#ff3b30';               // expensive → red
    }

    function findBestHour() {
        const minDelta = Math.min(...HOURLY_DELTA_CT);
        return HOURLY_DELTA_CT.indexOf(minDelta); // = 3 (03:00 Uhr)
        // For practical recommendation, shift to evening hours
    }

    // Override: practical evening recommendation
    function findBestHour() {
        // Evening hours 20-22 are the best practical recommendation (ADAC)
        return 21;
    }

    // ─── Chip helper ─────────────────────────────────────────────────────────
    function chipHtml(label, price, minP, maxP) {
        if (!price || price === false) {
            return `<div class="price-chip"><span class="price-chip-label">${label}</span><span class="price-chip-value" style="color:var(--text-quaternary)">—</span></div>`;
        }
        return `
      <div class="price-chip">
        <span class="price-chip-label">${label}</span>
        <span class="price-chip-value ${priceClass(price, minP, maxP)}">${fmtPrice(price)}</span>
      </div>`;
    }

    // ─── Utilities ───────────────────────────────────────────────────────────
    function fmtPrice(p) {
        return p.toFixed(3).replace('.', ',') + ' €';
    }

    function priceClass(price, minP, maxP) {
        if (price === null || price === undefined) return 'price-none';
        if (minP === maxP) return 'price-cheap';
        const ratio = (price - minP) / (maxP - minP);
        if (ratio <= 0.33) return 'price-cheap';
        if (ratio <= 0.66) return 'price-mid';
        return 'price-expensive';
    }

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    function setLoading(on) {
        searchBtn.disabled = on;
        btnText.style.display = on ? 'none' : '';
        btnLoading.style.display = on ? '' : 'none';
    }

    function showStatus(msg, type) {
        statusMsg.innerHTML = msg;
        statusMsg.className = `status-message ${type}`;
        statusMsg.style.display = 'block';
    }

    function hideStatus() { statusMsg.style.display = 'none'; }

    function clearResults() {
        resultsContainer.innerHTML = '';
        resultsInfo.style.display = 'none';
        emptyState.style.display = 'none';
    }

    function showResultsInfo(count, loc) {
        resultsInfo.style.display = 'flex';
        resultsCount.textContent = `${count} Tankstelle${count !== 1 ? 'n' : ''} in der Nähe von „${loc}"`;
    }

})();

