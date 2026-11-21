// Shared hwmon temperature/PWM discovery, used by both the rpcd plugin
// (luci.temperature getSensors) and the history collector.
//
//   import { collect } from 'luci.temperature.sensors';
//   const { time, sensors, fans } = collect();

'use strict';

import { glob, readfile, readlink, basename } from 'fs';

function rd(path) {
	const v = readfile(path);
	return (v == null) ? null : trim(v);
}

// sysfs millidegrees -> degrees, null when absent/invalid
function milli(path) {
	const v = rd(path);
	if (v == null || v == '')
		return null;
	const n = +v;
	return (n == n) ? n / 1000.0 : null;
}

// Raw DT cells are binary with leading NUL bytes; hex-encode them so they
// are usable as object keys.
function hexfile(path) {
	const raw = readfile(path);
	if (raw == null)
		return null;
	let hex = '';
	for (let i = 0; i < length(raw); i++)
		hex += sprintf('%02x', ord(raw, i));
	return hex;
}

// SFP cages are linked to their netdev through the device tree "sfp" phandle.
function sfpNetdevMap() {
	const map = {};
	for (let p in glob('/sys/class/net/*/of_node/sfp')) {
		const ph = hexfile(p);
		if (ph)
			map[ph] = split(p, '/')[4];
	}
	return map;
}

// hwmon devices backed by a thermal zone (e.g. cpu_thermal) carry no
// tempN_max/tempN_crit; use the zone's "hot" and "critical" trip points.
function zoneTrips(hwdir) {
	const trips = {};
	for (let t in glob(hwdir + '/device/trip_point_*_type')) {
		const type = rd(t);
		const temp = milli(replace(t, /_type$/, '_temp'));
		if (temp == null)
			continue;
		if (type == 'hot' && (trips.max == null || temp < trips.max))
			trips.max = temp;
		else if (type == 'critical' && (trips.crit == null || temp < trips.crit))
			trips.crit = temp;
	}
	return trips;
}

function describe(hwname, hwdir, sfpmap) {
	if (match(hwname, /^cpu[_-]thermal$/))
		return { kind: 'cpu', label: 'CPU' };

	if (match(hwname, /^sfp\d*$/)) {
		const ph = hexfile(hwdir + '/of_node/phandle');
		const dev = (ph != null) ? sfpmap[ph] : null;
		return { kind: 'sfp', label: dev ? 'SFP ' + dev : 'SFP ' + hwname, netdev: dev };
	}

	let m = match(hwname, /^mt79\w+_(phy\d+(\.\d+)?)$/);
	if (m)
		return { kind: 'wifi', label: 'Wi-Fi ' + m[1] };

	m = match(hwname, /^(phy\d+)$/);
	if (m)
		return { kind: 'wifi', label: 'Wi-Fi ' + m[1] };

	return { kind: 'other', label: hwname };
}

// Read every hwmon temperature sensor (and PWM fan) and return the current
// snapshot: { time, sensors: [...], fans: [...] }.
export function collect() {
	const sfpmap = sfpNetdevMap();
	const sensors = [];
	const fans = [];

	const seen = {};

	for (let hwdir in glob('/sys/class/hwmon/hwmon*')) {
		const hwname = rd(hwdir + '/name') ?? basename(hwdir);
		const inputs = glob(hwdir + '/temp*_input');
		const d0 = length(inputs) ? describe(hwname, hwdir, sfpmap) : null;

		for (let input in inputs) {
			const base = replace(input, /_input$/, '');
			const temp = milli(input);
			if (temp == null)
				continue;

			const d = { ...d0 };
			const lbl = rd(base + '_label');
			const idx = match(base, /temp(\d+)$/)[1];

			// Only qualify the label for multi-sensor chips with meaningful labels
			if (lbl && lbl != 'temperature' && length(inputs) > 1)
				d.label += ' ' + lbl;

			// Key on the chip name, not hwmonN: the kernel reuses hwmonN
			// numbers, so an SFP swap could inherit another sensor's id.
			let id = hwname + '_temp' + idx;
			if (seen[id])
				id += '_' + basename(hwdir);
			seen[id] = true;

			let max = milli(base + '_max');
			let crit = milli(base + '_crit');
			if (max == null || crit == null) {
				const trips = zoneTrips(hwdir);
				max ??= trips.max;
				crit ??= trips.crit;
			}

			// Some drivers (mt7996) report max above crit; expose the
			// lower one as the warning level, the higher as critical.
			if (max != null && crit != null && max > crit) {
				const t = max;
				max = crit;
				crit = t;
			}

			push(sensors, {
				id: id,
				name: hwname,
				kind: d.kind,
				label: d.label,
				netdev: d.netdev,
				temp: temp,
				max: max,
				crit: crit
			});
		}

		for (let pwm in glob(hwdir + '/pwm[0-9]')) {
			const v = rd(pwm);
			if (v != null)
				push(fans, { name: hwname, pwm: +v, percent: int(+v * 100 / 255) });
		}
	}

	return { time: time(), sensors: sensors, fans: fans };
};
