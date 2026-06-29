import { TypedMessenger } from "renda";
import { bbox, canonicalize, multiPolygonArea, pointInMultiPolygon } from "../util/geometry.js";
import { TERRITORY_SUBUNIT_SCALE as SUB, TERRITORY_WORKER_CAPTURE_TIMEOUT_MS } from "../config.js";

/**
 * @typedef {{id: number, rings: number[][][][], area: number}} AffectedTerritory
 * @typedef {(capturerId: number, affected: AffectedTerritory[]) => void} CaptureResolvedCallback
 */

/**
 * Main-thread proxy for polygon territory. The authoritative geometry and all heavy boolean ops
 * live in the territory worker; this side keeps a read-only MIRROR of every player's MultiPolygon
 * so the game loop can answer "is this point inside my own territory?" synchronously each tick and
 * stream territory to clients. Captures are submitted to the worker and the returned rings are
 * applied to the mirror asynchronously (a tick or two later) via the resolve callback.
 *
 * Coordinates are fixed-point integer sub-units (tile * TERRITORY_SUBUNIT_SCALE).
 */
export class Territory {
	/** @type {Map<number, number[][][][]>} playerId -> MultiPolygon mirror */
	#mirror = new Map();

	/** @type {Worker} */
	#worker;
	/** @type {TypedMessenger<{}, import("./territoryWorker/mod.js").TerritoryWorkerHandlers>} */
	#messenger;

	/** @type {CaptureResolvedCallback?} */
	#onResolved = null;

	/**
	 * Captures awaiting a worker result, keyed by a monotonic token. Tracked so that (a) a result
	 * arriving from a worker we've since terminated can be ignored, and (b) when the watchdog
	 * respawns a wedged worker we can release every stuck capturer's in-flight guard.
	 * @type {Map<number, number>} token -> capturing playerId
	 */
	#pendingCaptures = new Map();
	#nextCaptureToken = 0;
	/** @type {number} incremented each respawn so stale promises from a dead worker are dropped. */
	#workerGeneration = 0;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#watchdog = null;

	constructor() {
		const { worker, messenger } = this.#createWorker();
		this.#worker = worker;
		this.#messenger = messenger;
	}

	/** Creates a fresh worker + messenger pair. */
	#createWorker() {
		const worker = new Worker(new URL("./territoryWorker/mod.js", import.meta.url), { type: "module" });
		/** @type {TypedMessenger<{}, import("./territoryWorker/mod.js").TerritoryWorkerHandlers>} */
		const messenger = new TypedMessenger();
		messenger.initializeWorker(worker, {});
		return { worker, messenger };
	}

	/** (Re)arms the watchdog if captures are outstanding, or clears it if none remain. */
	#refreshWatchdog() {
		if (this.#watchdog !== null) {
			clearTimeout(this.#watchdog);
			this.#watchdog = null;
		}
		if (this.#pendingCaptures.size > 0) {
			this.#watchdog = setTimeout(() => this.#respawnWedgedWorker(), TERRITORY_WORKER_CAPTURE_TIMEOUT_MS);
		}
	}

	/**
	 * Called when a capture has made no progress for the timeout window: the worker is presumed
	 * stuck in a pathological polygon-clipping op (spinning, so it will never resolve or throw).
	 * Terminate it, start a fresh worker, replay the mirror into it, and release every capturer
	 * whose capture we just dropped so their trail lifecycle un-freezes.
	 */
	#respawnWedgedWorker() {
		const dropped = [...this.#pendingCaptures.values()];
		console.error(
			`territory worker wedged (no capture result in ${TERRITORY_WORKER_CAPTURE_TIMEOUT_MS}ms); ` +
				`respawning, dropping ${dropped.length} in-flight capture(s)`,
		);
		this.#workerGeneration++;
		this.#pendingCaptures.clear();
		this.#watchdog = null;
		try {
			this.#worker.terminate();
		} catch (_e) { /* already gone */ }
		const { worker, messenger } = this.#createWorker();
		this.#worker = worker;
		this.#messenger = messenger;
		// Re-seed the fresh worker from the authoritative-enough mirror (every completed capture is
		// reflected there; only the dropped in-flight ones are lost, which is the intended outcome).
		for (const [id, mp] of this.#mirror) {
			this.#messenger.send.restoreTerritory(id, mp);
		}
		// Un-freeze the stuck capturers; their trail was already consumed, so they simply resume.
		if (this.#onResolved) {
			for (const id of dropped) this.#onResolved(id, []);
		}
	}

	/**
	 * Registers the callback fired when a capture's worker result arrives, with the capturing
	 * player's id and the new area for every affected player.
	 * @param {CaptureResolvedCallback} cb
	 */
	onCaptureResolved(cb) {
		this.#onResolved = cb;
	}

	/**
	 * Grants a square starting territory. The mirror is updated synchronously (so spawn area and
	 * inside-tests work immediately); the worker is given the identical ring.
	 * @param {number} playerId
	 * @param {number} xTiles
	 * @param {number} yTiles
	 * @param {number} halfTiles
	 * @returns {number} area in tiles^2
	 */
	setSpawn(playerId, xTiles, yTiles, halfTiles) {
		const cx = Math.round(xTiles * SUB);
		const cy = Math.round(yTiles * SUB);
		const h = Math.round(halfTiles * SUB);
		const ring = [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
		this.#mirror.set(playerId, canonicalize([[ring]]));
		this.#messenger.send.setSpawn(playerId, ring);
		return this.areaTiles(playerId);
	}

	/**
	 * @param {number} playerId
	 * @param {number} xTiles
	 * @param {number} yTiles
	 */
	isInside(playerId, xTiles, yTiles) {
		const mp = this.#mirror.get(playerId);
		if (!mp || mp.length === 0) return false;
		return pointInMultiPolygon(Math.round(xTiles * SUB), Math.round(yTiles * SUB), mp);
	}

	/**
	 * Submits a capture to the worker. When the result returns, the mirror is updated for every
	 * affected player and the resolve callback fires.
	 * @param {number} playerId
	 * @param {{x: number, y: number}[]} trailTiles
	 */
	requestCapture(playerId, trailTiles) {
		const arr = trailTiles.map((p) => [p.x, p.y]);
		const token = this.#nextCaptureToken++;
		const generation = this.#workerGeneration;
		this.#pendingCaptures.set(token, playerId);
		this.#refreshWatchdog();
		this.#messenger.send.capture(playerId, arr).then((result) => {
			// Ignore results from a worker we've already terminated, or a capture the watchdog dropped.
			if (generation !== this.#workerGeneration || !this.#pendingCaptures.has(token)) return;
			this.#pendingCaptures.delete(token);
			this.#refreshWatchdog();
			for (const a of result.affected) {
				if (a.rings && a.rings.length) {
					this.#mirror.set(a.id, a.rings);
				} else {
					this.#mirror.delete(a.id);
				}
			}
			if (this.#onResolved) this.#onResolved(playerId, result.affected);
		}).catch((e) => {
			if (generation !== this.#workerGeneration || !this.#pendingCaptures.has(token)) return;
			this.#pendingCaptures.delete(token);
			this.#refreshWatchdog();
			console.error("territory capture failed", e);
			if (this.#onResolved) this.#onResolved(playerId, []);
		});
	}

	/**
	 * @param {number} playerId
	 * @returns {number[][][][] | undefined}
	 */
	getMultiPolygon(playerId) {
		return this.#mirror.get(playerId);
	}

	/**
	 * Bounding box of a player's territory in tile units, or null if they have none.
	 * @param {number} playerId
	 * @returns {{minX: number, minY: number, maxX: number, maxY: number} | null}
	 */
	getBoundsTiles(playerId) {
		const mp = this.#mirror.get(playerId);
		if (!mp || mp.length === 0) return null;
		const [minX, minY, maxX, maxY] = bbox(mp);
		return { minX: minX / SUB, minY: minY / SUB, maxX: maxX / SUB, maxY: maxY / SUB };
	}

	/**
	 * Rasterizes one quarter of the global minimap (in the worker) from all territories.
	 * @param {number} part 0..3
	 * @param {number} mapWidth
	 * @param {number} mapHeight
	 * @returns {Promise<ArrayBuffer>}
	 */
	getMinimapPart(part, mapWidth, mapHeight) {
		return this.#messenger.send.getMinimapPart(part, mapWidth, mapHeight);
	}

	/**
	 * @param {number} playerId
	 * @returns {number} area in tiles^2
	 */
	areaTiles(playerId) {
		const mp = this.#mirror.get(playerId);
		if (!mp) return 0;
		return Math.round(multiPolygonArea(mp) / (SUB * SUB));
	}

	/**
	 * @param {number} playerId
	 */
	remove(playerId) {
		this.#mirror.delete(playerId);
		this.#messenger.send.remove(playerId);
	}
}
