// Reversible sensor id <-> RRD file name mapping, shared by the collector
// and the getHistory ubus method so the two can never disagree.
//
// A sensor id becomes both a file name and a shell argument, so the encoded
// form uses only [A-Za-z0-9_]. Unlike a plain "replace everything else with
// _", it is collision-free: cpu-thermal_temp1 and cpu_thermal_temp1 map to
// different files.
//
//   [A-Za-z0-9]  -> itself
//   _            -> __
//   other byte   -> _xx  (two lowercase hex digits)
//
// Decoding is unambiguous because "_" is never a hex digit.

'use strict';

export function encode(id) {
	id = '' + id;
	let out = '';
	for (let i = 0; i < length(id); i++) {
		const c = substr(id, i, 1);
		if (match(c, /^[A-Za-z0-9]$/))
			out += c;
		else if (c == '_')
			out += '__';
		else
			out += sprintf('_%02x', ord(id, i));
	}
	return out;
};

// Returns null for a name this encoding cannot have produced.
export function decode(name) {
	let out = '';
	for (let i = 0; i < length(name); i++) {
		const c = substr(name, i, 1);
		if (match(c, /^[A-Za-z0-9]$/)) {
			out += c;
			continue;
		}
		if (c != '_')
			return null;
		if (substr(name, i + 1, 1) == '_') {
			out += '_';
			i++;
			continue;
		}
		const hx = substr(name, i + 1, 2);
		if (!match(hx, /^[0-9a-f][0-9a-f]$/))
			return null;
		out += chr(hex(hx));
		i += 2;
	}
	return out;
};
