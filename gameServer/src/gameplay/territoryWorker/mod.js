import { TypedMessenger } from "renda";
import { canonicalize } from "../../util/geometry.js";
import { captureInto, rasterizeMinimapPart, territoryAreaTiles } from "../territoryOps.js";

/**
 * Authoritative polygon territory, off the main thread. Holds every player's MultiPolygon and runs
 * the heavy boolean ops (union on capture, difference to steal) via the shared territoryOps logic.
 * The main thread keeps a read-only mirror for synchronous inside/outside tests and submits captures
 * here; results are applied to the mirror when they return.
 *
 * Captures are processed in postMessage (FIFO) order, serializing concurrent captures against the
 * authoritative geometry — no extra generation counter is needed.
 */

/** @type {Map<number, number[][][][]>} playerId -> MultiPolygon */
const territories = new Map();

const handlers = {
	/**
	 * @param {number} id
	 * @param {number[][]} ring Spawn square ring (sub-units), built identically on the main thread.
	 */
	setSpawn(id, ring) {
		territories.set(id, canonicalize([[ring]]));
		return territoryAreaTiles(territories.get(id));
	},

	/**
	 * @param {number} id
	 */
	remove(id) {
		territories.delete(id);
	},

	/**
	 * Re-seeds a player's authoritative territory from the main-thread mirror. Used after a wedged
	 * worker is terminated and respawned: the fresh worker starts empty, so the main thread replays
	 * every known territory back into it.
	 * @param {number} id
	 * @param {number[][][][]} mp Full MultiPolygon (sub-units).
	 */
	restoreTerritory(id, mp) {
		territories.set(id, mp);
	},

	/**
	 * @param {number} id
	 * @param {number[][]} trailTiles Trail path as [x, y] tile pairs.
	 * @returns {{affected: {id: number, rings: number[][][][], area: number}[]}}
	 */
	capture(id, trailTiles) {
		return { affected: captureInto(territories, id, trailTiles) };
	},

	/**
	 * @param {number} part 0..3
	 * @param {number} mapWidth
	 * @param {number} mapHeight
	 * @returns {ArrayBuffer}
	 */
	getMinimapPart(part, mapWidth, mapHeight) {
		return rasterizeMinimapPart(territories, part, mapWidth, mapHeight);
	},
};

/** @typedef {typeof handlers} TerritoryWorkerHandlers */

const messenger = new TypedMessenger();
messenger.initializeWorkerContext(handlers);
