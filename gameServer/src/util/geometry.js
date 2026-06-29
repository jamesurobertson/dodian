/**
 * Continuous-space geometry primitives for the freeform conversion.
 *
 * Two coordinate styles are used deliberately:
 *  - Polygon helpers (areas, canonicalize, point-in-polygon) operate on the
 *    polygon-clipping format: a Ring is [[x, y], ...], a Polygon is [outerRing, ...holes],
 *    a MultiPolygon is [Polygon, ...]. Territory uses fixed-point INTEGER sub-units.
 *  - Segment helpers take raw numbers (x/y pairs) so callers holding Vec2 trail points can
 *    pass `a.x, a.y, ...` without allocating.
 *
 * The polygon helpers were validated in Phase 0 (scripts/clippingHarness); canonicalize keeps
 * vertex counts bounded across thousands of sequential boolean ops.
 */

// ---------------------------------------------------------------------------
// Types (polygon-clipping format; coordinates are fixed-point integer sub-units)
// ---------------------------------------------------------------------------

/** @typedef {number[][]} Ring A list of [x, y] points (implicitly closed). */
/** @typedef {number[][][]} Polygon [outerRing, ...holeRings]. */
/** @typedef {number[][][][]} MultiPolygon [Polygon, ...]. */

// ---------------------------------------------------------------------------
// Segment / orientation primitives (number-based, allocation-free)
// ---------------------------------------------------------------------------

/**
 * Signed area*2 of triangle (a, b, c). >0 = c left of a->b, <0 = right, 0 = collinear.
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 */
export function orient2d(ax, ay, bx, by, cx, cy) {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Given collinear points, is c within the axis-aligned bounding box of segment a-b?
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 */
function onSegment(ax, ay, bx, by, cx, cy) {
	return Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) &&
		Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
}

/**
 * Returns true if segment AB intersects segment CD, including touching endpoints and
 * collinear overlap. This is the core trail-collision test.
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @param {number} dx
 * @param {number} dy
 */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
	const o1 = orient2d(ax, ay, bx, by, cx, cy);
	const o2 = orient2d(ax, ay, bx, by, dx, dy);
	const o3 = orient2d(cx, cy, dx, dy, ax, ay);
	const o4 = orient2d(cx, cy, dx, dy, bx, by);

	// Proper crossing: C and D on opposite sides of AB, and A and B on opposite sides of CD.
	if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) {
		return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
	}
	// Collinear / touching cases.
	if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
	if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
	if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
	if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting), used to detect territory boundary crossings
// ---------------------------------------------------------------------------

/**
 * Ray-cast point-in-ring test. `ring` is [[x, y], ...] (implicitly closed).
 * Points exactly on the boundary may return either result; callers treat the
 * boundary as a crossing event rather than relying on inside/outside there.
 * @param {number} px
 * @param {number} py
 * @param {Ring} ring
 */
export function pointInRing(px, py, ring) {
	let inside = false;
	const n = ring.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = ring[i][0], yi = ring[i][1];
		const xj = ring[j][0], yj = ring[j][1];
		const intersects = (yi > py) !== (yj > py) &&
			px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

/**
 * Even-odd point-in-multipolygon test. A point is inside the territory if it is inside an
 * odd number of rings overall, which correctly handles holes (outer CCW + hole CW rings).
 * @param {number} px
 * @param {number} py
 * @param {number[][][][]} mp MultiPolygon
 */
export function pointInMultiPolygon(px, py, mp) {
	let inside = false;
	for (const poly of mp) {
		for (const ring of poly) {
			if (pointInRing(px, py, ring)) inside = !inside;
		}
	}
	return inside;
}

// ---------------------------------------------------------------------------
// Polygon area / bookkeeping (validated in Phase 0)
// ---------------------------------------------------------------------------

/**
 * Exact integer signed area*2 of a ring (shoelace). Positive = CCW.
 * @param {Ring} ring
 */
export function signedArea2(ring) {
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum;
}

/**
 * Absolute area of a MultiPolygon in sub-unit^2. Holes (opposite winding) subtract naturally.
 * @param {MultiPolygon} mp
 */
export function multiPolygonArea(mp) {
	let area2 = 0;
	for (const poly of mp) {
		for (let r = 0; r < poly.length; r++) {
			area2 += signedArea2(poly[r]);
		}
	}
	return Math.abs(area2) / 2;
}

/**
 * Total vertex count across every ring of a MultiPolygon.
 * @param {MultiPolygon} mp
 */
export function vertexCount(mp) {
	let n = 0;
	for (const poly of mp) {
		for (const ring of poly) n += ring.length;
	}
	return n;
}

/**
 * Bounding box [minX, minY, maxX, maxY] of a MultiPolygon.
 * @param {MultiPolygon} mp
 */
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

/**
 * Perpendicular distance from point p to the segment a-b.
 * @param {number[]} p
 * @param {number[]} a
 * @param {number[]} b
 */
function perpDistance(p, a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Iterative Douglas-Peucker simplification of an open polyline.
 * @param {number[][]} points
 * @param {number} eps
 * @returns {number[][]}
 */
function dpSimplify(points, eps) {
	if (points.length < 3) return points.slice();
	const keep = new Array(points.length).fill(false);
	keep[0] = keep[points.length - 1] = true;
	/** @type {number[][]} */
	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const range = stack.pop();
		if (!range) break;
		const s = range[0], e = range[1];
		let maxD = 0, idx = -1;
		for (let i = s + 1; i < e; i++) {
			const d = perpDistance(points[i], points[s], points[e]);
			if (d > maxD) {
				maxD = d;
				idx = i;
			}
		}
		if (maxD > eps && idx !== -1) {
			keep[idx] = true;
			stack.push([s, idx]);
			stack.push([idx, e]);
		}
	}
	/** @type {number[][]} */
	const out = [];
	for (let i = 0; i < points.length; i++) {
		if (keep[i]) out.push(points[i]);
	}
	return out;
}

/**
 * Simplifies a closed ring with Douglas-Peucker, preserving its closure.
 * @param {Ring} ring
 * @param {number} eps
 * @returns {Ring}
 */
export function simplifyRing(ring, eps) {
	if (ring.length <= 4) return ring;
	const simp = dpSimplify(ring.concat([ring[0]]), eps);
	simp.pop(); // drop the duplicated closing point
	return simp.length >= 3 ? simp : ring;
}

/**
 * Simplifies every ring of a MultiPolygon. Used to shrink territory before sending over the wire;
 * the authoritative geometry (and score) keep using the unsimplified version.
 * @param {MultiPolygon} mp
 * @param {number} eps
 * @returns {MultiPolygon}
 */
export function simplifyMultiPolygon(mp, eps) {
	/** @type {number[][][][]} */
	const out = [];
	for (const poly of mp) {
		/** @type {number[][][]} */
		const rings = [];
		for (const ring of poly) {
			const s = simplifyRing(ring, eps);
			if (s.length >= 3) rings.push(s);
		}
		if (rings.length > 0) out.push(rings);
	}
	return out;
}

/**
 * Offsets a closed ring outward by `r` with rounded convex corners. The boundary is pushed out by r
 * everywhere (so a captured trail loop reaches the OUTER edge of the drawn trail rather than its
 * centerline), and convex corners are swept by short arcs so they read as fluid rather than sharp.
 * Concave corners just emit both offset points and may self-intersect slightly — a following
 * union()/canonicalize() resolves that. Winding-agnostic (uses the ring's own signed area).
 * @param {Ring} ring
 * @param {number} r offset distance in the ring's coordinate units (sub-units)
 * @returns {Ring}
 */
export function outsetRingRound(ring, r) {
	const n = ring.length;
	if (n < 3 || r <= 0) return ring;
	let area2 = 0;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	const ccw = area2 > 0;
	const sign = ccw ? 1 : -1; // outward normal of edge (a->b) is sign*(ey,-ex)/len
	/** @type {Ring} */
	const out = [];
	for (let i = 0; i < n; i++) {
		const cur = ring[i], prev = ring[(i - 1 + n) % n], next = ring[(i + 1) % n];
		const e1x = cur[0] - prev[0], e1y = cur[1] - prev[1];
		const e2x = next[0] - cur[0], e2y = next[1] - cur[1];
		const l1 = Math.sqrt(e1x * e1x + e1y * e1y), l2 = Math.sqrt(e2x * e2x + e2y * e2y);
		if (l1 < 1e-9 || l2 < 1e-9) {
			out.push([cur[0], cur[1]]);
			continue;
		}
		const n1x = sign * (e1y / l1), n1y = sign * (-e1x / l1);
		const n2x = sign * (e2y / l2), n2y = sign * (-e2x / l2);
		const ax = cur[0] + n1x * r, ay = cur[1] + n1y * r; // end of the incoming edge's offset
		const bx = cur[0] + n2x * r, by = cur[1] + n2y * r; // start of the outgoing edge's offset
		const cross = e1x * e2y - e1y * e2x;
		const convex = ccw ? cross > 0 : cross < 0;
		if (convex) {
			out.push([ax, ay]);
			let a1 = Math.atan2(n1y, n1x), a2 = Math.atan2(n2y, n2x);
			let da = a2 - a1;
			while (da <= -Math.PI) da += 2 * Math.PI;
			while (da > Math.PI) da -= 2 * Math.PI;
			const steps = Math.max(1, Math.round(Math.abs(da) / (Math.PI / 6)));
			for (let s = 1; s < steps; s++) {
				const a = a1 + da * (s / steps);
				out.push([cur[0] + Math.cos(a) * r, cur[1] + Math.sin(a) * r]);
			}
			out.push([bx, by]);
		} else {
			out.push([ax, ay]);
			out.push([bx, by]);
		}
	}
	return out;
}

/**
 * Snap one ring to the integer grid, drop duplicate + collinear vertices.
 * @param {Ring} ring
 * @returns {Ring | null}
 */
function canonicalizeRing(ring) {
	/** @type {number[][]} */
	const snapped = [];
	for (const [fx, fy] of ring) {
		const x = Math.round(fx);
		const y = Math.round(fy);
		const last = snapped[snapped.length - 1];
		if (!last || last[0] !== x || last[1] !== y) snapped.push([x, y]);
	}
	if (snapped.length > 1) {
		const f = snapped[0], l = snapped[snapped.length - 1];
		if (f[0] === l[0] && f[1] === l[1]) snapped.pop();
	}
	if (snapped.length < 3) return null;

	let pts = snapped;
	let changed = true;
	while (changed && pts.length >= 3) {
		changed = false;
		/** @type {number[][]} */
		const out = [];
		const n = pts.length;
		for (let i = 0; i < n; i++) {
			const a = pts[(i - 1 + n) % n];
			const b = pts[i];
			const c = pts[(i + 1) % n];
			if (orient2d(a[0], a[1], b[0], b[1], c[0], c[1]) === 0) {
				changed = true; // b is collinear; drop it
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
 * Canonicalize a MultiPolygon: snap to grid, strip duplicate/collinear vertices, drop
 * zero-area rings. Must be run after every boolean op to keep vertex counts bounded.
 * @param {number[][][][]} mp
 * @returns {number[][][][]}
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
