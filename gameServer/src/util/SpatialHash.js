/**
 * Uniform spatial hash over line segments, used as the broad-phase for continuous
 * trail-vs-trail collision. It is purely an acceleration structure (not game state):
 * segments are bucketed by the grid cells their bounding box covers, and a query returns
 * the candidate segments sharing any cell with the query segment. Callers then run the
 * exact segmentsIntersect test on the (small) candidate set.
 *
 * Coordinates are in tile units (floats). Pick a cell size a few times the typical
 * per-tick movement so each short trail segment touches only a handful of cells.
 */
export class SpatialHash {
	#cellSize;
	/** @type {Map<number, any[]>} */
	#cells = new Map();

	/**
	 * @param {number} cellSize Cell size in tile units.
	 */
	constructor(cellSize = 4) {
		this.#cellSize = cellSize;
	}

	clear() {
		this.#cells.clear();
	}

	/**
	 * Combine two cell coordinates into a single numeric key. The +32768 bias keeps
	 * arena-sized coordinates non-negative; arenas are far smaller than 65536 cells.
	 * @param {number} cx
	 * @param {number} cy
	 */
	#key(cx, cy) {
		return (cx + 32768) * 65536 + (cy + 32768);
	}

	/**
	 * Inserts a segment, registering `item` in every cell its bounding box overlaps.
	 * @param {number} ax
	 * @param {number} ay
	 * @param {number} bx
	 * @param {number} by
	 * @param {any} item Arbitrary payload returned by queries (e.g. {player, ax, ay, bx, by}).
	 */
	insertSegment(ax, ay, bx, by, item) {
		const minCx = Math.floor(Math.min(ax, bx) / this.#cellSize);
		const maxCx = Math.floor(Math.max(ax, bx) / this.#cellSize);
		const minCy = Math.floor(Math.min(ay, by) / this.#cellSize);
		const maxCy = Math.floor(Math.max(ay, by) / this.#cellSize);
		for (let cx = minCx; cx <= maxCx; cx++) {
			for (let cy = minCy; cy <= maxCy; cy++) {
				const key = this.#key(cx, cy);
				let bucket = this.#cells.get(key);
				if (!bucket) {
					bucket = [];
					this.#cells.set(key, bucket);
				}
				bucket.push(item);
			}
		}
	}

	/**
	 * Returns the unique set of items registered in any cell overlapping the query
	 * segment's bounding box. May include items that don't actually intersect — callers
	 * must run the exact test.
	 * @param {number} ax
	 * @param {number} ay
	 * @param {number} bx
	 * @param {number} by
	 * @returns {Set<any>}
	 */
	querySegment(ax, ay, bx, by) {
		/** @type {Set<any>} */
		const result = new Set();
		const minCx = Math.floor(Math.min(ax, bx) / this.#cellSize);
		const maxCx = Math.floor(Math.max(ax, bx) / this.#cellSize);
		const minCy = Math.floor(Math.min(ay, by) / this.#cellSize);
		const maxCy = Math.floor(Math.max(ay, by) / this.#cellSize);
		for (let cx = minCx; cx <= maxCx; cx++) {
			for (let cy = minCy; cy <= maxCy; cy++) {
				const bucket = this.#cells.get(this.#key(cx, cy));
				if (!bucket) continue;
				for (const item of bucket) result.add(item);
			}
		}
		return result;
	}
}
