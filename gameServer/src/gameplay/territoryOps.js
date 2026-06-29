// @ts-ignore: npm module resolved via the import map; types are not in the generated deno set.
import polygonClipping from "polygon-clipping";
import { canonicalize, multiPolygonArea, pointInMultiPolygon, simplifyRing } from "../util/geometry.js";
import { TERRITORY_CAPTURE_SIMPLIFY_EPS, TERRITORY_SUBUNIT_SCALE as SUB } from "../config.js";

/**
 * Pure polygon-territory operations, shared by the territory worker and unit tests. They operate
 * on a `Map<playerId, MultiPolygon>` of fixed-point sub-unit geometry. Kept worker-free so the
 * capture/steal/fill logic can be tested directly without a Worker context.
 */

/**
 * Keeps only the exterior ring of every polygon, discarding holes (fills enclosed empty pockets).
 * @param {any} multiPolygon union/difference output
 * @returns {number[][][][]}
 */
export function dropHoles(multiPolygon) {
	/** @type {number[][][][]} */
	const out = [];
	for (const poly of multiPolygon) {
		if (poly.length > 0) out.push([poly[0]]);
	}
	return out;
}

/**
 * @param {number[][][][] | undefined} mp
 * @returns {number} area in tiles^2
 */
export function territoryAreaTiles(mp) {
	if (!mp) return 0;
	return Math.round(multiPolygonArea(mp) / (SUB * SUB));
}

/**
 * Builds a canonicalized square MultiPolygon centred on (xTiles, yTiles).
 * @param {number} xTiles
 * @param {number} yTiles
 * @param {number} halfTiles
 * @returns {number[][][][]}
 */
export function spawnSquareMP(xTiles, yTiles, halfTiles) {
	const cx = Math.round(xTiles * SUB);
	const cy = Math.round(yTiles * SUB);
	const h = Math.round(halfTiles * SUB);
	return canonicalize([[[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]]]);
}

/**
 * Closes the trail loop into the capturing player's territory (filling holes), then steals overlap
 * from every other player. Mutates `territories` and returns the new rings + area for each affected
 * player.
 * @param {Map<number, number[][][][]>} territories
 * @param {number} id
 * @param {number[][]} trailTiles Trail path as [x, y] tile pairs.
 * @returns {{id: number, rings: number[][][][], area: number}[]}
 */
export function captureInto(territories, id, trailTiles) {
	/** @type {{id: number, rings: number[][][][], area: number}[]} */
	const affected = [];
	const mine = territories.get(id);
	if (!mine || trailTiles.length < 3) return affected;

	const ring = trailTiles.map((p) => [Math.round(p[0] * SUB), Math.round(p[1] * SUB)]);
	// Collapse the dense near-collinear vertices a continuous trail produces before clipping; this
	// keeps the boolean-op input small and well-conditioned (defense against polygon-clipping hangs).
	const simplified = simplifyRing(ring, TERRITORY_CAPTURE_SIMPLIFY_EPS);
	const loop = [[simplified]];

	let filled;
	try {
		filled = canonicalize(dropHoles(polygonClipping.union(mine, loop)));
	} catch (_e) {
		return affected;
	}
	if (filled.length === 0) return affected;
	territories.set(id, filled);
	affected.push({ id, rings: filled, area: territoryAreaTiles(filled) });

	for (const [otherId, otherMp] of territories) {
		if (otherId === id || otherMp.length === 0) continue;
		let diff;
		try {
			diff = canonicalize(polygonClipping.difference(otherMp, filled));
		} catch (_e) {
			continue;
		}
		territories.set(otherId, diff);
		affected.push({ id: otherId, rings: diff, area: territoryAreaTiles(diff) });
	}
	return affected;
}

/**
 * Rasterizes one quarter of the global minimap from all territories into the same 20x80 bit-packed
 * format the client already understands (1 bit per pixel, bit set = land owned by some player).
 * Replaces the old tile-array sampling.
 * @param {Map<number, number[][][][]>} territories
 * @param {number} part 0..3
 * @param {number} mapWidth
 * @param {number} mapHeight
 * @returns {ArrayBuffer}
 */
export function rasterizeMinimapPart(territories, part, mapWidth, mapHeight) {
	const W = 20, H = 80;
	const mapChunkWidth = mapWidth / 4;
	const buffer = new ArrayBuffer(Math.ceil((W * H) / 8));
	const view = new Uint8Array(buffer);
	const mps = [...territories.values()].filter((mp) => mp.length > 0);

	for (let i = 0; i < buffer.byteLength; i++) {
		let byte = 0;
		for (let j = 0; j < 8; j++) {
			const idx = i * 8 + j;
			const localX = Math.floor(idx / H); // 0..19 within this part
			const localY = idx % H; // 0..79
			const tileX = part * mapChunkWidth + (localX / W) * mapChunkWidth;
			const tileY = (localY / H) * mapHeight;
			const sx = Math.round(tileX * SUB), sy = Math.round(tileY * SUB);
			let filled = false;
			for (const mp of mps) {
				if (pointInMultiPolygon(sx, sy, mp)) {
					filled = true;
					break;
				}
			}
			byte |= (filled ? 1 : 0) << j;
		}
		view[i] = byte;
	}
	return buffer;
}
