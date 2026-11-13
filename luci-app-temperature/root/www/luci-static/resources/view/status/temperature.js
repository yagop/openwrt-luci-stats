'use strict';
'require view';
'require poll';
'require rpc';

/*
 * Realtime temperature cards: one card per hwmon temperature sensor.
 * History is kept client-side only, for as long as the view is open.
 * Styling follows the LuCI app styling guide (theme export tokens only,
 * names prefixed with the package name, style returned inside the view tree).
 *
 * Every string child goes into E() inside an array: a bare string child is
 * assigned as innerHTML, and sensor labels come from sysfs and netdev names.
 */

const callSensors = rpc.declare({
	object: 'luci.temperature',
	method: 'getSensors',
	expect: { '': {} }
});

const POLL_INTERVAL = 3;            // seconds
const WINDOW = 600;                 // seconds of history shown
const GAP = POLL_INTERVAL * 2.5;    // seconds between samples that break the line
const MISS_LIMIT = 3;               // polls a sensor may be missing before its card goes
const GRAPH_HEIGHT = 120;           // px
const SVGNS = 'http://www.w3.org/2000/svg';
const P = 'luci-app-temperature';   // prefix for every class name

const CSS = `
.${P}-root { container-type: inline-size; }
.${P}-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
	gap: 1rem;
}
@container (max-width: 360px) {
	.${P}-grid { grid-template-columns: 1fr; }
}
.${P}-card {
	min-width: 0;
	padding: .75rem 1rem;
	border: 1px solid var(--border-color-medium, #ddd);
	border-radius: 6px;
	background: var(--background-color-high, #fff);
	color: var(--text-color-high, #333);
}
.${P}-card[data-state="warn"] { border-color: var(--warn-color-medium, #b26a00); }
.${P}-card[data-state="error"] { border-color: var(--error-color-medium, #c62828); }
.${P}-head {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: .5rem;
}
.${P}-title { font-weight: 600; color: var(--text-color-highest, #111); }
.${P}-sub { font-size: .85em; color: var(--text-color-medium, #666); }
.${P}-pill {
	padding: .1em .6em;
	border-radius: 999px;
	font-size: .75em;
	font-weight: 600;
	white-space: nowrap;
}
.${P}-pill[data-state="ok"] {
	background: var(--success-color-high, #2e7d32);
	color: var(--on-success-color, #fff);
}
.${P}-pill[data-state="warn"] {
	background: var(--warn-color-high, #b26a00);
	color: var(--on-warn-color, #fff);
}
.${P}-pill[data-state="error"] {
	background: var(--error-color-high, #c62828);
	color: var(--on-error-color, #fff);
}
.${P}-pill[data-state="stale"] {
	background: var(--background-color-medium, #eee);
	color: var(--text-color-medium, #666);
}
.${P}-value {
	margin: .25rem 0 .5rem;
	font-size: 2em;
	font-weight: 600;
	line-height: 1.2;
	font-variant-numeric: tabular-nums;
}
.${P}-unit { margin-left: .15em; font-size: .5em; color: var(--text-color-medium, #666); }
.${P}-graph svg { display: block; width: 100%; height: ${GRAPH_HEIGHT}px; }
.${P}-gridline { stroke: var(--border-color-low, #eee); stroke-width: 1; }
.${P}-axis { fill: var(--text-color-low, #999); font-size: 10px; }
.${P}-area { fill: var(--primary-color-high, #1976d2); fill-opacity: .12; stroke: none; }
.${P}-line {
	fill: none;
	stroke: var(--primary-color-high, #1976d2);
	stroke-width: 1.5;
	stroke-linejoin: round;
}
.${P}-dot { fill: var(--primary-color-high, #1976d2); }
.${P}-limit-warn { stroke: var(--warn-color-medium, #b26a00); stroke-width: 1; stroke-dasharray: 4 3; }
.${P}-limit-error { stroke: var(--error-color-medium, #c62828); stroke-width: 1; stroke-dasharray: 4 3; }
.${P}-limit-warn-text { fill: var(--warn-color-medium, #b26a00); font-size: 10px; }
.${P}-limit-error-text { fill: var(--error-color-medium, #c62828); font-size: 10px; }
.${P}-time {
	display: flex;
	justify-content: space-between;
	font-size: .75em;
	color: var(--text-color-low, #999);
}
.${P}-stats {
	display: flex;
	flex-wrap: wrap;
	gap: .25rem 1rem;
	margin-top: .5rem;
	padding-top: .5rem;
	border-top: 1px solid var(--border-color-low, #eee);
	font-size: .85em;
	color: var(--text-color-medium, #666);
}
.${P}-stats strong { font-weight: 600; color: var(--text-color-high, #333); }
.${P}-footer { margin-top: .75rem; font-size: .85em; color: var(--text-color-medium, #666); }
.${P}-empty { color: var(--text-color-medium, #666); }
`;

function svgEl(tag, attrs) {
	const el = document.createElementNS(SVGNS, tag);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	return el;
}

function fmt(v) {
	return (v == null || !isFinite(v)) ? '-' : '%.1f'.format(v);
}

function sensorState(s, stale) {
	if (stale)
		return 'stale';
	if (s.crit != null && s.temp >= s.crit)
		return 'error';
	if (s.max != null && s.temp >= s.max)
		return 'warn';
	return 'ok';
}

function stateLabel(state) {
	switch (state) {
	case 'stale': return _('No data');
	case 'error': return _('Critical');
	case 'warn':  return _('Hot');
	default:      return _('OK');
	}
}

function subtitle(s) {
	switch (s.kind) {
	case 'sfp':  return _('SFP module') + ' · ' + (s.netdev || s.name);
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
	return String(a.label || '').localeCompare(String(b.label || ''));
}

/* Split history into runs with no gap longer than GAP seconds */
function segments(hist) {
	const runs = [];
	let run = [];
	for (let i = 0; i < hist.length; i++) {
		if (run.length && hist[i][0] - hist[i - 1][0] > GAP) {
			runs.push(run);
			run = [];
		}
		run.push(hist[i]);
	}
	if (run.length)
		runs.push(run);
	return runs;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	known: null,        // id -> { sensor, missed }: sensors shown, incl. briefly missing ones
	hist: null,         // id -> [[ts, temp], ...]; outlives cards, so a hiccup keeps history
	cards: null,        // id -> card context
	idKey: null,        // joined ids of the cards currently shown
	now: 0,             // latest server timestamp

	load() {
		return L.resolveDefault(callSensors(), {});
	},

	buildCard(s) {
		const ctx = { id: s.id, sensor: s, stale: false };

		ctx.title = E('div', { 'class': P + '-title' }, [ s.label ]);
		ctx.sub = E('div', { 'class': P + '-sub' }, [ subtitle(s) ]);
		ctx.pill = E('span', { 'class': P + '-pill', 'data-state': 'ok' }, [ _('OK') ]);
		ctx.value = E('span', {}, [ '-' ]);
		ctx.svg = svgEl('svg', { 'role': 'img', 'aria-label': _('Temperature history') });
		ctx.stats = E('div', { 'class': P + '-stats' });

		ctx.node = E('div', { 'class': P + '-card', 'data-state': 'ok' }, [
			E('div', { 'class': P + '-head' }, [
				E('div', {}, [ ctx.title, ctx.sub ]),
				ctx.pill
			]),
			E('div', { 'class': P + '-value' }, [
				ctx.value,
				E('span', { 'class': P + '-unit' }, [ '°C' ])
			]),
			E('div', { 'class': P + '-graph' }, [ ctx.svg ]),
			E('div', { 'class': P + '-time' }, [
				E('span', {}, [ _('%d min ago').format(WINDOW / 60) ]),
				E('span', {}, [ _('now') ])
			]),
			ctx.stats
		]);

		return ctx;
	},

	update(data) {
		const sensors = Array.isArray(data?.sensors) ? data.sensors : [];
		const fans = Array.isArray(data?.fans) ? data.fans : [];
		const now = data?.time || Math.floor(Date.now() / 1000);

		/* Router clock stepped back (NTP): old samples would sit in the future */
		if (now < this.now)
			this.hist = {};
		this.now = now;

		const present = {};
		for (const s of sensors) {
			const hist = (this.hist[s.id] ??= []);
			const last = hist[hist.length - 1];

			present[s.id] = true;
			this.known[s.id] = { sensor: s, missed: 0 };
			if (!last || last[0] < now)
				hist.push([ now, s.temp ]);
		}

		/* A sensor missing from one poll (I2C hiccup on an SFP) keeps its card
		   and history; only after MISS_LIMIT polls is it treated as unplugged. */
		for (const id in this.known)
			if (!present[id] && ++this.known[id].missed > MISS_LIMIT)
				delete this.known[id];

		for (const id in this.hist) {
			const hist = this.hist[id];
			while (hist.length && hist[0][0] < now - WINDOW)
				hist.shift();
			if (!hist.length && !this.known[id])
				delete this.hist[id];
		}

		const shown = Object.values(this.known).map(k => k.sensor).sort(sortSensors);
		const key = shown.map(s => s.id).join('|');

		/* Rebuild the grid only when the set of sensors changes (SFP hot-plug) */
		if (key != this.idKey) {
			this.cards = {};
			const nodes = shown.map(s => (this.cards[s.id] = this.buildCard(s)).node);

			if (!nodes.length)
				nodes.push(E('p', { 'class': P + '-empty' }, [ _('No temperature sensors found.') ]));

			this.grid.replaceChildren(...nodes);
			this.idKey = key;
		}

		for (const s of shown) {
			const ctx = this.cards[s.id];
			ctx.sensor = s;
			ctx.stale = this.known[s.id].missed > 0;
			this.updateCard(ctx);
		}

		this.fans.textContent = fans.length
			? fans.map(f => _('Fan %s: %d%%').format(f.name, f.percent)).join(' · ')
			: '';
	},

	updateCard(ctx) {
		const s = ctx.sensor;
		const hist = this.hist[ctx.id] || [];
		const state = sensorState(s, ctx.stale);
		const temps = hist.map(h => h[1]);
		const min = temps.length ? Math.min(...temps) : s.temp;
		const peak = temps.length ? Math.max(...temps) : s.temp;
		const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : NaN;

		ctx.node.setAttribute('data-state', state);
		ctx.pill.setAttribute('data-state', state);
		ctx.pill.textContent = stateLabel(state);
		ctx.value.textContent = ctx.stale ? '-' : fmt(s.temp);

		const stats = [
			E('span', {}, [ _('Min') + ' ', E('strong', {}, [ fmt(temps.length ? min : NaN) + ' °C' ]) ]),
			E('span', {}, [ _('Avg') + ' ', E('strong', {}, [ fmt(avg) + ' °C' ]) ]),
			E('span', {}, [ _('Peak') + ' ', E('strong', {}, [ fmt(temps.length ? peak : NaN) + ' °C' ]) ])
		];

		if (s.max != null && !ctx.stale) {
			const room = s.max - s.temp;
			stats.push(E('span', {}, [ room >= 0
				? _('%s °C below max').format(fmt(room))
				: _('%s °C above max').format(fmt(-room)) ]));
		}

		ctx.stats.replaceChildren(...stats);
		this.drawGraph(ctx, hist, min, peak);
	},

	drawGraph(ctx, hist, min, peak) {
		const svg = ctx.svg;
		const W = svg.clientWidth || svg.parentNode?.clientWidth || 0;
		const H = GRAPH_HEIGHT;
		const s = ctx.sensor;

		if (!W || !isFinite(min) || !isFinite(peak))
			return;   /* not attached yet, or nothing to scale to; drawn on next update */

		/* y range: data +-2 °C, snapped to 5 °C, at least 10 °C tall, stretched
		   to show a limit line if it lies close above the data. A limit exactly
		   on the top edge counts too, or its label would fall outside the SVG. */
		let lo = Math.floor((min - 2) / 5) * 5;
		let hi = Math.ceil((peak + 2) / 5) * 5;
		if (hi - lo < 10)
			hi = lo + 10;
		for (const lim of [ s.max, s.crit ])
			if (lim != null && lim >= hi && lim <= hi + 15)
				hi = Math.ceil((lim + 1) / 5) * 5;

		const step = (hi - lo) > 30 ? 10 : 5;
		const y = t => H - (t - lo) / (hi - lo) * H;
		const x = ts => W * (1 - (this.now - ts) / WINDOW);

		svg.setAttribute('viewBox', '0 0 %d %d'.format(W, H));
		svg.replaceChildren();

		for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
			if (g == lo || g == hi)
				continue;
			svg.appendChild(svgEl('line', { 'class': P + '-gridline', x1: 0, x2: W, y1: y(g), y2: y(g) }));
			const label = svgEl('text', { 'class': P + '-axis', x: 4, y: y(g) - 3 });
			label.textContent = g + '°';
			svg.appendChild(label);
		}

		for (let m = 2; m < WINDOW / 60; m += 2) {
			const xm = W * (1 - m * 60 / WINDOW);
			svg.appendChild(svgEl('line', { 'class': P + '-gridline', x1: xm, x2: xm, y1: 0, y2: H }));
		}

		const limits = [
			[ s.max, 'warn', _('max %s°') ],
			[ s.crit, 'error', _('crit %s°') ]
		];
		for (const [ lim, cls, text ] of limits) {
			if (lim == null || lim <= lo || lim > hi)
				continue;
			const ly = y(lim);
			svg.appendChild(svgEl('line', { 'class': P + '-limit-' + cls, x1: 0, x2: W, y1: ly, y2: ly }));
			/* label above the line, or below it when the line is near the top */
			const label = svgEl('text', { 'class': P + '-limit-' + cls + '-text', x: W - 4,
				y: ly < 12 ? ly + 11 : ly - 3, 'text-anchor': 'end' });
			label.textContent = text.format('%.0f'.format(lim));
			svg.appendChild(label);
		}

		/* One line per run of samples, so a gap (failed poll, background tab)
		   is not drawn as a straight line that looks like data */
		for (const run of segments(hist)) {
			const pts = run.map(h => '%.1f,%.1f'.format(x(h[0]), y(h[1])));
			if (pts.length >= 2) {
				const x0 = x(run[0][0]).toFixed(1), xn = x(run[run.length - 1][0]).toFixed(1);
				svg.appendChild(svgEl('path', { 'class': P + '-area', d: 'M%s,%d L%s L%s,%d Z'.format(x0, H, pts.join(' L'), xn, H) }));
				svg.appendChild(svgEl('polyline', { 'class': P + '-line', points: pts.join(' ') }));
			}
			else {
				const [ px, py ] = pts[0].split(',');
				svg.appendChild(svgEl('circle', { 'class': P + '-dot', cx: px, cy: py, r: 2 }));
			}
		}
	},

	render(data) {
		this.known = {};
		this.hist = {};
		this.cards = {};
		this.idKey = null;
		this.now = 0;

		this.grid = E('div', { 'class': P + '-grid' });
		this.fans = E('div', { 'class': P + '-footer' });

		const root = E('div', { 'class': 'cbi-map ' + P + '-root' }, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('Temperature') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Live readings of all hardware temperature sensors, including SFP/PON modules. Dashed lines mark each sensor\'s warning and critical limits.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				this.grid,
				this.fans,
				E('div', { 'class': P + '-footer' }, [
					_('(%d minute window, %d second interval; history starts when this page is opened)').format(WINDOW / 60, POLL_INTERVAL)
				])
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
