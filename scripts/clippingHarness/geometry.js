/**
 * Phase 0 throwaway: minimal fixed-point geometry helpers used to evaluate
 * polygon-clipping robustness. If the harness validates the approach, the
 * canonicalize/area/bbox logic here is promoted to gameServer/src/util/geometry.js.
 *
 * Coordinate convention: every vertex is [x, y] of INTEGER sub-units.
 * Rings are arrays of [x, y]. A ring is implicitly closed (first != last is
 * fine; we treat it as closed). A Polygon is [outerRing, ...holeRings].
 * A MultiPolygon is [Polygon, ...]. This matches the polygon-clipping format.
 */

/** Exact integer signed area*2 of a ring (shoelace). Positive = CCW. */
export function signedArea2(ring) {
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum;
}

/** Absolute area of a MultiPolygon in sub-unit^2. Holes (CW) subtract naturally. */
export function multiPolygonArea(mp) {
	let area2 = 0;
	for (const poly of mp) {
		for (let r = 0; r < poly.length; r++) {
			// Outer ring contributes +, holes contribute - if wound oppositely.
			area2 += signedArea2(poly[r]);
		}
	}
	return Math.abs(area2) / 2;
}

/** Total vertex count across every ring of a MultiPolygon. */
export function vertexCount(mp) {
	let n = 0;
	for (const poly of mp) {
		for (const ring of poly) n += ring.length;
	}
	return n;
}

/** Bounding box [minX, minY, maxX, maxY] of a MultiPolygon. */
export function bbox(mp) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const poly of mp) {
		for (const ring of poly) {
			for (const [x, y] of ring) {
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
		}
	}
	return [minX, minY, maxX, maxY];
}

/** Snap one ring to the integer grid, drop duplicate + collinear vertices. */
function canonicalizeRing(ring) {
	// 1. Snap to integer grid and drop consecutive duplicates.
	const snapped = [];
	for (const [fx, fy] of ring) {
		const x = Math.round(fx);
		const y = Math.round(fy);
		const last = snapped[snapped.length - 1];
		if (!last || last[0] !== x || last[1] !== y) snapped.push([x, y]);
	}
	// Drop a trailing vertex equal to the first (ring is implicitly closed).
	if (snapped.length > 1) {
		const f = snapped[0], l = snapped[snapped.length - 1];
		if (f[0] === l[0] && f[1] === l[1]) snapped.pop();
	}
	if (snapped.length < 3) return null;

	// 2. Remove collinear vertices using exact integer cross products.
	//    Iterate until stable (removals can expose new collinear triples).
	let pts = snapped;
	let changed = true;
	while (changed && pts.length >= 3) {
		changed = false;
		const out = [];
		const n = pts.length;
		for (let i = 0; i < n; i++) {
			const a = pts[(i - 1 + n) % n];
			const b = pts[i];
			const c = pts[(i + 1) % n];
			const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
			if (cross === 0) {
				changed = true; // b lies on segment a->c; skip it
				continue;
			}
			out.push(b);
		}
		pts = out;
	}
	if (pts.length < 3) return null;
	if (signedArea2(pts) === 0) return null;
	return pts;
}

/**
 * Canonicalize a whole MultiPolygon: snap to grid, strip duplicate/collinear
 * vertices, drop zero-area rings. This is THE step that must keep vertex counts
 * bounded across thousands of sequential boolean ops. Returns a fresh MultiPolygon.
 */
export function canonicalize(mp) {
	const out = [];
	for (const poly of mp) {
		const rings = [];
		for (let r = 0; r < poly.length; r++) {
			const cleaned = canonicalizeRing(poly[r]);
			if (cleaned) rings.push(cleaned);
		}
		if (rings.length > 0) out.push(rings);
	}
	return out;
}

/** Cheap sanity check: every coordinate is a finite integer. */
export function isIntegerMultiPolygon(mp) {
	for (const poly of mp) {
		for (const ring of poly) {
			for (const [x, y] of ring) {
				if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
				if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
			}
		}
	}
	return true;
}
