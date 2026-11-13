'use strict';
'require view';
'require poll';
'require rpc';

/*
 * Realtime temperature cards: one card per hwmon temperature sensor.
 * History is kept client-side only, for as long as the view is open.
 * Styling follows the LuCI app styling guide (theme export tokens only,
 * scoped "temperature-" names, style returned inside the view tree).
 */

const callSensors = rpc.declare({
	object: 'luci.temperature',
	method: 'getSensors',
	expect: { '': {} }
});

const POLL_INTERVAL = 3;            // seconds
const WINDOW = 600;                 // seconds of history shown
const GRAPH_HEIGHT = 120;           // px
const SVGNS = 'http://www.w3.org/2000/svg';

const CSS = `
.temperature-root { container-type: inline-size; }
.temperature-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
	gap: 1rem;
}
@container (max-width: 360px) {
	.temperature-grid { grid-template-columns: 1fr; }
}
.temperature-card {
	min-width: 0;
	padding: .75rem 1rem;
	border: 1px solid var(--border-color-medium, #ddd);
	border-radius: 6px;
	background: var(--background-color-high, #fff);
	color: var(--text-color-high, #333);
}
.temperature-card[data-state="warn"] { border-color: var(--warn-color-medium, #b26a00); }
.temperature-card[data-state="error"] { border-color: var(--error-color-medium, #c62828); }
.temperature-head {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: .5rem;
}
.temperature-title { font-weight: 600; color: var(--text-color-highest, #111); }
.temperature-sub { font-size: .85em; color: var(--text-color-medium, #666); }
.temperature-pill {
	padding: .1em .6em;
	border-radius: 999px;
	font-size: .75em;
	font-weight: 600;
	white-space: nowrap;
}
.temperature-pill[data-state="ok"] {
	background: var(--success-color-high, #2e7d32);
	color: var(--on-success-color, #fff);
}
.temperature-pill[data-state="warn"] {
	background: var(--warn-color-high, #b26a00);
	color: var(--on-warn-color, #fff);
}
.temperature-pill[data-state="error"] {
	background: var(--error-color-high, #c62828);
	color: var(--on-error-color, #fff);
}
.temperature-value {
	margin: .25rem 0 .5rem;
	font-size: 2em;
	font-weight: 600;
	line-height: 1.2;
	font-variant-numeric: tabular-nums;
}
.temperature-unit { margin-left: .15em; font-size: .5em; color: var(--text-color-medium, #666); }
.temperature-graph svg { display: block; width: 100%; height: ${GRAPH_HEIGHT}px; }
.temperature-gridline { stroke: var(--border-color-low, #eee); stroke-width: 1; }
.temperature-axis { fill: var(--text-color-low, #999); font-size: 10px; }
.temperature-area { fill: var(--primary-color-high, #1976d2); fill-opacity: .12; stroke: none; }
.temperature-line {
	fill: none;
	stroke: var(--primary-color-high, #1976d2);
	stroke-width: 1.5;
	stroke-linejoin: round;
}

.temperature-dot { fill: var(--primary-color-high, #1976d2); }
.temperature-limit-warn { stroke: var(--warn-color-medium, #b26a00); stroke-width: 1; stroke-dasharray: 4 3; }
.temperature-limit-error { stroke: var(--error-color-medium, #c62828); stroke-width: 1; stroke-dasharray: 4 3; }
.temperature-limit-warn-text { fill: var(--warn-color-medium, #b26a00); font-size: 10px; }
.temperature-limit-error-text { fill: var(--error-color-medium, #c62828); font-size: 10px; }
.temperature-time {
	display: flex;
	justify-content: space-between;
	font-size: .75em;
	color: var(--text-color-low, #999);
}
.temperature-stats {
	display: flex;
	flex-wrap: wrap;
	gap: .25rem 1rem;
	margin-top: .5rem;
	padding-top: .5rem;
	border-top: 1px solid var(--border-color-low, #eee);
	font-size: .85em;
	color: var(--text-color-medium, #666);
}
.temperature-stats strong { font-weight: 600; color: var(--text-color-high, #333); }
.temperature-footer { margin-top: .75rem; font-size: .85em; color: var(--text-color-medium, #666); }
.temperature-empty { color: var(--text-color-medium, #666); }
`;

function svgEl(tag, attrs) {
	const el = document.createElementNS(SVGNS, tag);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	return el;
}

function fmt(v) {
	return (v == null || isNaN(v)) ? '-' : '%.1f'.format(v);
}

function sensorState(s) {
	if (s.crit != null && s.temp >= s.crit)
		return 'error';
	if (s.max != null && s.temp >= s.max)
		return 'warn';
	return 'ok';
}

function stateLabel(state) {
	switch (state) {
	case 'error': return _('Critical');
	case 'warn':  return _('Hot');
	default:      return _('OK');
	}
}

function subtitle(s) {
	switch (s.kind) {
	case 'sfp':  return s.netdev ? _('SFP module') + ' · ' + s.netdev : _('SFP module') + ' · ' + s.name;
	case 'cpu':  return _('SoC thermal sensor');
	case 'wifi': return _('Wi-Fi radio') + ' · ' + s.name;
	default:     return s.name;
	}
}

const KIND_ORDER = { sfp: 0, cpu: 1, wifi: 2, other: 3 };

function sortSensors(a, b) {
	const ka = KIND_ORDER[a.kind] ?? 3, kb = KIND_ORDER[b.kind] ?? 3;
	if (ka != kb)
		return ka - kb;
	const wa = /wan/.test(a.netdev || '') ? 0 : 1, wb = /wan/.test(b.netdev || '') ? 0 : 1;
	if (wa != wb)
		return wa - wb;
	return (a.label || '').localeCompare(b.label || '');
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	cards: null,        // id -> card context
	idKey: null,        // joined ids of the cards currently shown
	now: 0,             // latest server timestamp

	load() {
		return L.resolveDefault(callSensors(), {});
	},

	buildCard(s) {
		const ctx = { id: s.id, hist: [], sensor: s };

		ctx.title = E('div', { 'class': 'temperature-title' }, s.label);
		ctx.sub = E('div', { 'class': 'temperature-sub' }, subtitle(s));
		ctx.pill = E('span', { 'class': 'temperature-pill', 'data-state': 'ok' }, _('OK'));
		ctx.value = E('span', {}, '-');
		ctx.svg = svgEl('svg', { 'role': 'img', 'aria-label': _('Temperature history') });
		ctx.stats = E('div', { 'class': 'temperature-stats' });

		ctx.node = E('div', { 'class': 'temperature-card', 'data-state': 'ok' }, [
			E('div', { 'class': 'temperature-head' }, [
				E('div', {}, [ ctx.title, ctx.sub ]),
				ctx.pill
			]),
			E('div', { 'class': 'temperature-value' }, [
				ctx.value,
				E('span', { 'class': 'temperature-unit' }, '°C')
			]),
			E('div', { 'class': 'temperature-graph' }, ctx.svg),
			E('div', { 'class': 'temperature-time' }, [
				E('span', {}, _('%d min ago').format(WINDOW / 60)),
				E('span', {}, _('now'))
			]),
			ctx.stats
		]);

		return ctx;
	},

	update(data) {
		const sensors = (Array.isArray(data?.sensors) ? data.sensors : []).slice().sort(sortSensors);
		const fans = Array.isArray(data?.fans) ? data.fans : [];

		this.now = data?.time || Math.floor(Date.now() / 1000);

		/* Rebuild the grid only when the set of sensors changes (SFP hot-plug) */
		const key = sensors.map(s => s.id).join('|');
		if (key != this.idKey) {
			const old = this.cards || {};
			this.cards = {};
			const nodes = [];

			for (const s of sensors) {
				const ctx = this.buildCard(s);
				if (old[s.id])
					ctx.hist = old[s.id].hist;
				this.cards[s.id] = ctx;
				nodes.push(ctx.node);
			}

			if (!nodes.length)
				nodes.push(E('p', { 'class': 'temperature-empty' }, _('No temperature sensors found.')));

			this.grid.replaceChildren(...nodes);
			this.idKey = key;
		}

		for (const s of sensors) {
			const ctx = this.cards[s.id];
			const last = ctx.hist[ctx.hist.length - 1];

			ctx.sensor = s;
			if (!last || last[0] < this.now)
				ctx.hist.push([ this.now, s.temp ]);

			while (ctx.hist.length && ctx.hist[0][0] < this.now - WINDOW)
				ctx.hist.shift();

			this.updateCard(ctx);
		}

		this.fans.textContent = fans.length
			? fans.map(f => _('Fan %s: %d%%').format(f.name, f.percent)).join(' · ')
			: '';
	},

	updateCard(ctx) {
		const s = ctx.sensor;
		const state = sensorState(s);
		const temps = ctx.hist.map(h => h[1]);
		const min = Math.min(...temps), peak = Math.max(...temps);
		const avg = temps.reduce((a, b) => a + b, 0) / temps.length;

		ctx.node.setAttribute('data-state', state);
		ctx.pill.setAttribute('data-state', state);
		ctx.pill.textContent = stateLabel(state);
		ctx.value.textContent = fmt(s.temp);

		const stats = [
			E('span', {}, [ _('Min') + ' ', E('strong', {}, fmt(min) + ' °C') ]),
			E('span', {}, [ _('Avg') + ' ', E('strong', {}, fmt(avg) + ' °C') ]),
			E('span', {}, [ _('Peak') + ' ', E('strong', {}, fmt(peak) + ' °C') ])
		];

		if (s.max != null) {
			const room = s.max - s.temp;
			stats.push(E('span', {}, room >= 0
				? _('%s °C below max').format(fmt(room))
				: _('%s °C above max').format(fmt(-room))));
		}

		ctx.stats.replaceChildren(...stats);
		this.drawGraph(ctx, min, peak);
	},

	drawGraph(ctx, min, peak) {
		const svg = ctx.svg;
		const W = svg.clientWidth || svg.parentNode?.clientWidth || 0;
		const H = GRAPH_HEIGHT;
		const s = ctx.sensor;

		if (!W)
			return;   /* not attached yet; drawn on next update */

		/* y range: data +-2 °C, snapped to 5 °C, at least 10 °C tall,
		   stretched to show a limit line if it lies close above the data */
		let lo = Math.floor((min - 2) / 5) * 5;
		let hi = Math.ceil((peak + 2) / 5) * 5;
		if (hi - lo < 10)
			hi = lo + 10;
		for (const lim of [ s.max, s.crit ])
			if (lim != null && lim > hi && lim <= hi + 15)
				hi = Math.ceil((lim + 1) / 5) * 5;

		const step = (hi - lo) > 30 ? 10 : 5;
		const y = t => H - (t - lo) / (hi - lo) * H;
		const x = ts => W * (1 - (this.now - ts) / WINDOW);

		svg.setAttribute('viewBox', '0 0 %d %d'.format(W, H));
		svg.replaceChildren();

		for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
			if (g == lo || g == hi)
				continue;
			svg.appendChild(svgEl('line', { 'class': 'temperature-gridline', x1: 0, x2: W, y1: y(g), y2: y(g) }));
			const label = svgEl('text', { 'class': 'temperature-axis', x: 4, y: y(g) - 3 });
			label.textContent = g + '°';
			svg.appendChild(label);
		}

		for (let m = 1; m < WINDOW / 60; m++) {
			const xm = W * (1 - m * 60 / WINDOW);
			if (m % 2 == 0)
				svg.appendChild(svgEl('line', { 'class': 'temperature-gridline', x1: xm, x2: xm, y1: 0, y2: H }));
		}

		const limits = [
			[ s.max, 'warn', _('max %d°') ],
			[ s.crit, 'error', _('crit %d°') ]
		];
		for (const [ lim, cls, text ] of limits) {
			if (lim == null || lim <= lo || lim > hi)
				continue;
			svg.appendChild(svgEl('line', { 'class': 'temperature-limit-' + cls, x1: 0, x2: W, y1: y(lim), y2: y(lim) }));
			const label = svgEl('text', { 'class': 'temperature-limit-' + cls + '-text', x: W - 4, y: y(lim) - 3, 'text-anchor': 'end' });
			label.textContent = text.format(lim);
			svg.appendChild(label);
		}

		const pts = ctx.hist.map(h => '%.1f,%.1f'.format(x(h[0]), y(h[1])));
		if (pts.length >= 2) {
			const x0 = x(ctx.hist[0][0]).toFixed(1), xn = x(ctx.hist[ctx.hist.length - 1][0]).toFixed(1);
			svg.appendChild(svgEl('path', { 'class': 'temperature-area', d: 'M%s,%d L%s L%s,%d Z'.format(x0, H, pts.join(' L'), xn, H) }));
			svg.appendChild(svgEl('polyline', { 'class': 'temperature-line', points: pts.join(' ') }));
		}
		else if (pts.length == 1) {
			const [ px, py ] = pts[0].split(',');
			svg.appendChild(svgEl('circle', { 'class': 'temperature-dot', cx: px, cy: py, r: 2 }));
		}
	},

	render(data) {
		this.grid = E('div', { 'class': 'temperature-grid' });
		this.fans = E('div', { 'class': 'temperature-footer' });

		const root = E('div', { 'class': 'cbi-map temperature-root' }, [
			E('style', {}, CSS),
			E('h2', {}, _('Temperature')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live readings of all hardware temperature sensors, including SFP/PON modules. Dashed lines mark each sensor\'s warning and critical limits.')),
			E('div', { 'class': 'cbi-section' }, [
				this.grid,
				this.fans,
				E('div', { 'class': 'temperature-footer' },
					_('(%d minute window, %d second interval; history starts when this page is opened)').format(WINDOW / 60, POLL_INTERVAL))
			])
		]);

		this.update(data);

		/* first draw once the view is attached and has a width */
		requestAnimationFrame(() => {
			for (const id in this.cards)
				this.updateCard(this.cards[id]);
		});

		poll.add(L.bind(function() {
			return L.resolveDefault(callSensors(), null).then(L.bind(function(d) {
				if (d)
					this.update(d);
			}, this));
		}, this), POLL_INTERVAL);

		return root;
	}
});
