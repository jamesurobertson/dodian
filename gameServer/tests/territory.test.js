import { assert } from "https://deno.land/std@0.198.0/assert/mod.ts";
import { captureInto, rasterizeMinimapPart, spawnSquareMP, territoryAreaTiles } from "../src/gameplay/territoryOps.js";

function countBits(b) {
	let c = 0;
	while (b) {
		c += b & 1;
		b >>= 1;
	}
	return c;
}

/** Asserts every polygon has exactly one ring (no holes) — verifies the dropHoles fill rule. */
function assertNoHoles(mp, label) {
	for (const poly of mp || []) {
		assert(poly.length === 1, `${label} has a hole (polygon with ${poly.length} rings)`);
	}
}

Deno.test("capture grows the capturing player's area and leaves no holes", () => {
	const terr = new Map();
	terr.set(1, spawnSquareMP(20, 20, 5)); // 10x10 square => area ~100
	const before = territoryAreaTiles(terr.get(1));
	const affected = captureInto(terr, 1, [[24, 16], [30, 16], [30, 24], [24, 24]]);
	const after = territoryAreaTiles(terr.get(1));
	assert(after > before, `expected area to grow (${before} -> ${after})`);
	assert(affected.find((a) => a.id === 1).area === after);
	assertNoHoles(terr.get(1), "player 1");
});

Deno.test("capture steals overlapping area from another player", () => {
	const terr = new Map();
	terr.set(1, spawnSquareMP(20, 20, 5)); // player 1: [15,25]
	terr.set(2, spawnSquareMP(30, 20, 5)); // player 2: [25,35]
	const before2 = territoryAreaTiles(terr.get(2));
	assert(before2 > 0);

	const affected = captureInto(terr, 1, [[24, 16], [33, 16], [33, 24], [24, 24]]);

	const after2 = territoryAreaTiles(terr.get(2));
	assert(after2 < before2, `expected player 2 to lose area (${before2} -> ${after2})`);
	assert(affected.find((a) => a.id === 2), "steal should report player 2 as affected");
	assert(territoryAreaTiles(terr.get(1)) > 100, "player 1 should have grown past its spawn area");
	assertNoHoles(terr.get(1), "player 1");
	assertNoHoles(terr.get(2), "player 2");
});

Deno.test("spawn square has the expected area", () => {
	const terr = new Map();
	terr.set(5, spawnSquareMP(40, 40, 4)); // 8x8 => 64
	assert(territoryAreaTiles(terr.get(5)) === 64, "8x8 spawn square should be 64 tiles");
});

Deno.test("minimap rasterization marks owned land and leaves empty space blank", () => {
	const terr = new Map();
	terr.set(1, spawnSquareMP(10, 40, 8)); // covers x[2,18] on an 80-wide map
	let bits0 = 0;
	for (const b of new Uint8Array(rasterizeMinimapPart(terr, 0, 80, 80))) bits0 += countBits(b);
	assert(bits0 > 0, "part 0 (x[0,20]) should contain owned pixels");
	let bits3 = 0;
	for (const b of new Uint8Array(rasterizeMinimapPart(terr, 3, 80, 80))) bits3 += countBits(b);
	assert(bits3 === 0, "part 3 (x[60,80]) should be empty");
});
