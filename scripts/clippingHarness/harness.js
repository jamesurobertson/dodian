/**
 * Phase 0 throwaway harness — de-risks the polygon-clipping choice that gates
 * the whole freeform conversion. Run with:
 *
 *   deno run -A scripts/clippingHarness/harness.js
 *
 * It exercises polygon-clipping (and, if it imports cleanly, martinez) on
 * fixed-point integer coordinates against the scenarios the real game will hit:
 *   1. 10k sequential capture-unions  -> does vertex count stay BOUNDED?
 *   2. self-intersecting trail rings   -> handled without garbage?
 *   3. degenerate slivers              -> dropped, no explosion?
 *   4. steal-land difference           -> areas conserved, no degeneracy?
 *   5. same run WITHOUT canonicalize    -> demonstrates why canonicalize matters.
 */

import polygonClipping from "npm:polygon-clipping@0.15.7";
import {
	bbox,
	canonicalize,
	isIntegerMultiPolygon,
	multiPolygonArea,
	vertexCount,
} from "./geometry.js";

// 1 tile = SUB sub-units. The plan starts at 1024; we report what each gives.
const SUB = 1024;

// ---- deterministic PRNG so runs are reproducible -------------------------
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---- library adapters: normalize to common MultiPolygon format -----------
const libs = {};
libs["polygon-clipping"] = {
	union: (a, b) => polygonClipping.union(a, b),
	difference: (a, b) => polygonClipping.difference(a, b),
};
try {
	const martinez = (await import("npm:martinez-polygon-clipping@0.7.3")).default;
	libs["martinez"] = {
		union: (a, b) => normalizeMP(martinez.union(a, b)),
		difference: (a, b) => normalizeMP(martinez.diff(a, b)),
	};
} catch (e) {
	console.log(`(martinez unavailable: ${e.message})\n`);
}

// martinez can return Polygon-depth or MultiPolygon-depth; normalize to MP.
function normalizeMP(geom) {
	if (!geom || geom.length === 0) return [];
	// MultiPolygon: geom[0][0][0] is a [x,y] pair (number).
	if (typeof geom[0][0][0] === "number") return [geom]; // it was a single Polygon
	return geom;
}

// ---- shape generators (all integer sub-units) ----------------------------
function square(cx, cy, halfTiles) {
	const h = halfTiles * SUB;
	return [[[
		[cx - h, cy - h],
		[cx + h, cy - h],
		[cx + h, cy + h],
		[cx - h, cy + h],
	]]];
}

// A rectangle whose centre lands inside a guaranteed-filled CORE (the starting
// block is half-size 15 tiles, so any rect centred within ±CORE overlaps filled
// territory and the blob stays a single connected region — as real captures
// always connect back to your land). Rects extend beyond the core to grow the
// territory irregularly, building a complex but connected perimeter over time.
function excursionRect(rng) {
	const CORE = 10 * SUB; // < starting half-size (15 tiles) => always overlaps
	const cx = randInt(rng, -CORE, CORE);
	const cy = randInt(rng, -CORE, CORE);
	const hw = randInt(rng, 2, 9) * SUB;
	const hh = randInt(rng, 2, 9) * SUB;
	return [[[[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]]]];
}

// A self-intersecting "bowtie" ribbon — the slither-style trail loop case.
function bowtie(cx, cy, s) {
	return [[[
		[cx - s, cy - s],
		[cx + s, cy + s],
		[cx + s, cy - s],
		[cx - s, cy + s],
	]]];
}

// ---- scenario runners ----------------------------------------------------
function runSequential(lib, { useCanon, iters = 10000, seed = 1 }) {
	const rng = mulberry32(seed);
	let territory = square(0, 0, 15); // 30x30-tile starting block
	let maxOpMs = 0;
	let totalOpMs = 0;
	let invalids = 0;
	let maxPieces = 1; // how fragmented did the MultiPolygon get?
	const samples = [];

	for (let i = 0; i < iters; i++) {
		const exc = excursionRect(rng);
		const t0 = performance.now();
		let next;
		try {
			next = lib.union(territory, exc);
		} catch (e) {
			invalids++;
			continue;
		}
		if (useCanon) next = canonicalize(next);
		const dt = performance.now() - t0;
		maxOpMs = Math.max(maxOpMs, dt);
		totalOpMs += dt;
		if (next.length === 0 || !isIntegerMultiPolygon(useCanon ? next : canonicalize(next))) invalids++;
		else territory = next;
		maxPieces = Math.max(maxPieces, territory.length);
		if (i % 1000 === 999) {
			samples.push([i + 1, vertexCount(territory)]);
			console.error(`      [${useCanon ? "canon" : "raw  "}] iter ${i + 1}: ` +
				`verts=${vertexCount(territory)} pieces=${territory.length} lastOp=${dt.toFixed(2)}ms`);
		}
	}
	return {
		finalVerts: vertexCount(territory),
		finalAreaTiles: Math.round(multiPolygonArea(territory) / (SUB * SUB)),
		maxOpMs: maxOpMs.toFixed(3),
		avgOpMs: (totalOpMs / iters).toFixed(4),
		invalids,
		maxPieces,
		samples,
	};
}

function runAdversarial(lib) {
	const results = {};

	// self-intersecting bowtie unioned into a square
	try {
		let r = lib.union(square(0, 0, 10), bowtie(12 * SUB, 0, 6 * SUB));
		r = canonicalize(r);
		results.bowtie = {
			ok: r.length > 0 && isIntegerMultiPolygon(r),
			verts: vertexCount(r),
			areaTiles: Math.round(multiPolygonArea(r) / (SUB * SUB)),
		};
	} catch (e) {
		results.bowtie = { ok: false, error: e.message };
	}

	// degenerate sliver: a near-zero-height rectangle
	try {
		const sliver = [[[[0, 0], [20 * SUB, 0], [20 * SUB, 1], [0, 1]]]];
		let r = lib.union(square(0, 0, 10), sliver);
		r = canonicalize(r);
		results.sliver = {
			ok: r.length > 0 && isIntegerMultiPolygon(r),
			verts: vertexCount(r),
		};
	} catch (e) {
		results.sliver = { ok: false, error: e.message };
	}

	// steal-land: subtract an overlapping enemy capture from my territory
	try {
		const mine = square(0, 0, 15);
		const enemyCapture = square(10 * SUB, 0, 8); // overlaps my right half
		const beforeTiles = multiPolygonArea(mine) / (SUB * SUB);
		let r = lib.difference(mine, enemyCapture);
		r = canonicalize(r);
		const afterTiles = multiPolygonArea(r) / (SUB * SUB);
		results.steal = {
			ok: isIntegerMultiPolygon(r) && afterTiles < beforeTiles,
			beforeTiles: Math.round(beforeTiles),
			afterTiles: Math.round(afterTiles),
			verts: vertexCount(r),
		};
	} catch (e) {
		results.steal = { ok: false, error: e.message };
	}

	return results;
}

// ---- run ------------------------------------------------------------------
console.log(`=== Phase 0 clipping harness (SUB=${SUB} sub-units/tile) ===\n`);

for (const [name, lib] of Object.entries(libs)) {
	console.log(`### ${name}`);

	const adv = runAdversarial(lib);
	console.log("  adversarial:");
	for (const [k, v] of Object.entries(adv)) {
		console.log(`    ${k}: ${JSON.stringify(v)}`);
	}

	const withCanon = runSequential(lib, { useCanon: true });
	console.log("  10k sequential unions WITH canonicalize:");
	console.log(`    final verts=${withCanon.finalVerts}  areaTiles=${withCanon.finalAreaTiles}` +
		`  avgOp=${withCanon.avgOpMs}ms  maxOp=${withCanon.maxOpMs}ms  invalids=${withCanon.invalids}`);
	console.log(`    vertex growth (iter:verts): ${withCanon.samples.map((s) => s.join(":")).join("  ")}`);

	const noCanon = runSequential(lib, { useCanon: false, iters: 2000 });
	console.log("  2k sequential unions WITHOUT canonicalize:");
	console.log(`    final verts=${noCanon.finalVerts}  (compare: canonicalize keeps this bounded)`);
	console.log("");
}

console.log("Done. Decision criteria: bounded vertex growth WITH canonicalize, all");
console.log("adversarial cases ok, low maxOp ms. Pick the library that satisfies all.");
