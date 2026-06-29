/** @typedef {"default" | "drawing" | "arena"} GameModes */

import { lerp, SingleInstancePromise, Vec2 } from "renda";
import { Player } from "./Player.js";
import { Territory } from "./Territory.js";
import { BotManager } from "./BotManager.js";
import { WebSocketConnection } from "../WebSocketConnection.js";
import {
	FREEFORM_SELF_COLLISION_GRACE_SEGMENTS,
	GM_REPORT_SCORES,
	LEADERBOARD_UPDATE_FREQUENCY,
	MINIMAP_PART_UPDATE_FREQUENCY,
	PLAYER_SPAWN_RADIUS,
	REQUIRED_PLAYER_COUNT_FOR_GLOBAL_LEADERBOARD,
	SPAWN_CANDIDATE_COUNT,
	SPAWN_CLEARANCE_TILES,
	SPAWN_TERRITORY_HALF_TILES,
	TRAIL_HASH_CELL_SIZE,
} from "../config.js";
import { ApplicationLoop } from "../ApplicationLoop.js";
import { SpatialHash } from "../util/SpatialHash.js";
import { segmentsIntersect } from "../util/geometry.js";

/**
 * @typedef TileTypeForMessage
 * @property {number} colorId
 * @property {number} patternId
 */

/** @type {GameModes[]} */
export const validGamemodes = ["default", "drawing", "arena"];

export class Game {
	#mainInstance;

	#gameMode;
	get gameMode() {
		return this.#gameMode;
	}

	#arenaWidth = 0;
	#arenaHeight = 0;
	#pitWidth = 0;
	#pitHeight = 0;

	get arenaWidth() {
		return this.#arenaWidth;
	}

	get arenaHeight() {
		return this.#arenaHeight;
	}

	/**
	 * Whether a point lies inside the central pit (arena game mode only).
	 * @param {number} x
	 * @param {number} y
	 */
	isInsidePit(x, y) {
		if (this.#pitWidth <= 0 || this.#pitHeight <= 0) return false;
		const left = this.#arenaWidth / 2 - this.#pitWidth / 2;
		const right = this.#arenaWidth / 2 + this.#pitWidth / 2;
		const top = this.#arenaHeight / 2 - this.#pitHeight / 2;
		const bottom = this.#arenaHeight / 2 + this.#pitHeight / 2;
		return x >= left && x < right && y >= top && y < bottom;
	}

	/** Broad-phase acceleration structure for continuous trail collision (rebuilt each tick). */
	#trailHash = new SpatialHash(TRAIL_HASH_CELL_SIZE);

	/** Authoritative polygon territory for all players. */
	#territory = new Territory();

	get territory() {
		return this.#territory;
	}

	/** @type {BotManager} */
	#botManager;

	/**
	 * @param {number} id
	 * @returns {Player | undefined}
	 */
	getPlayerById(id) {
		return this.#players.get(id);
	}

	/**
	 * Nearest point on another player's cuttable trail within `range` tiles of `player`'s head, for
	 * bot targeting. Skips itself, dead/spectator/spawn-protected players, players with no trail (a
	 * player inside their own territory can't be cut), and — for positional advantage — any enemy
	 * whose trail is not longer than `minOwnerTrailLen` (i.e. only hunt enemies more exposed than
	 * the caller). Returns null if nothing qualifies.
	 * @param {import("./Player.js").Player} player
	 * @param {number} range
	 * @param {number} minOwnerTrailLen
	 * @returns {{x: number, y: number} | null}
	 */
	findCuttableTrailPointNear(player, range, minOwnerTrailLen) {
		const pos = player.getPosition();
		let bestD2 = range * range;
		/** @type {{x: number, y: number} | null} */
		let best = null;
		for (const other of this.#players.values()) {
			if (other === player || other.dead || other.isSpectator || other.isSpawnProtected) continue;
			if (other.freeformTrailLength < 2 || other.freeformTrailLength <= minOwnerTrailLen) continue;
			for (const seg of other.getFreeformTrailSegments()) {
				const dx = seg.ax - pos.x, dy = seg.ay - pos.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < bestD2) {
					bestD2 = d2;
					best = { x: seg.ax, y: seg.ay };
				}
			}
		}
		return best;
	}

	/** Total players in the game right now (humans + bots). */
	get playerCount() {
		return this.#players.size;
	}

	/** Bots currently alive in the game. */
	get activeBotCount() {
		return this.#botManager.activeCount;
	}

	/** @type {ArrayBuffer[]} */
	#minimapMessages = [];
	#updateNextMinimapPartInstance;
	#lastMinimapUpdateTime = 0;
	#lastMinimapPart = 0;
	#lastLeaderboardSendTime = 0;
	/** @type {ArrayBuffer?} */
	#lastLeaderboardMessage = null;

	get lastLeaderboardMessage() {
		return this.#lastLeaderboardMessage;
	}

	/**
	 * @param {ApplicationLoop} applicationLoop
	 * @param {import("../Main.js").Main} mainInstance
	 * @param {Object} options
	 * @param {number} [options.arenaWidth]
	 * @param {number} [options.arenaHeight]
	 * @param {number} [options.pitWidth]
	 * @param {number} [options.pitHeight]
	 * @param {GameModes} [options.gameMode]
	 * @param {number} [options.botCount]
	 */
	constructor(applicationLoop, mainInstance, {
		arenaWidth = 600,
		arenaHeight = 600,
		pitWidth = 16,
		pitHeight = 16,
		gameMode = "default",
		botCount = 0,
	} = {}) {
		this.#mainInstance = mainInstance;
		this.#gameMode = gameMode;
		this.#arenaWidth = arenaWidth;
		this.#arenaHeight = arenaHeight;
		this.#pitWidth = pitWidth;
		this.#pitHeight = pitHeight;
		this.#botManager = new BotManager(this, botCount);

		// When a capture's worker result arrives, apply the new area + broadcast territory for every
		// affected player, and let the capturing player resume its trail lifecycle.
		this.#territory.onCaptureResolved((capturerId, affected) => {
			const capturer = this.#players.get(capturerId);
			for (const a of affected) {
				const p = this.#players.get(a.id);
				if (!p) continue;
				p.applyCapturedArea(a.area);
				this.broadcastPlayerTerritory(p);
				// A non-capturer left with no rings at all has had their whole island captured:
				// eliminate them and credit the capturer (this is "circle someone's island to kill").
				if (capturer && p !== capturer && a.rings.length === 0 && !p.dead) {
					capturer.killByEnclosure(p);
				}
			}
			if (capturer) capturer.onCaptureResolved();
		});

		this.#updateNextMinimapPartInstance = new SingleInstancePromise(() => this.#updateNextMinimapPart());

		applicationLoop.onSlowTickEnded(() => {
			for (const player of this.#players.values()) {
				this.broadcastPlayerState(player);
				player.sendPlayerStateToPlayer(player);
			}
		});
	}

	/**
	 * @param {number} now
	 * @param {number} dt
	 */
	loop(now, dt) {
		this.#botManager.tick(now);

		for (const player of this.#players.values()) {
			player.loop(now, dt);
		}

		this.#runTrailCollisions();

		if (now - this.#lastMinimapUpdateTime > MINIMAP_PART_UPDATE_FREQUENCY) {
			this.#lastMinimapUpdateTime = now;
			this.#updateNextMinimapPartInstance.run();
		}

		if (now - this.#lastLeaderboardSendTime > LEADERBOARD_UPDATE_FREQUENCY) {
			this.#lastLeaderboardSendTime = now;
			this.#sendLeaderboard();
		}
	}

	/**
	 * Continuous trail collision pass, run once per tick after every player has moved.
	 * Rebuilds the spatial hash from all living players' trail segments, then tests each
	 * player's head segment against nearby segments:
	 *  - crossing another player's trail cuts it, killing that player and crediting the mover;
	 *  - crossing your own trail (beyond a small grace window next to the head) kills you.
	 */
	#runTrailCollisions() {
		if (this.#gameMode == "drawing") return;
		const hash = this.#trailHash;
		hash.clear();
		for (const player of this.#players.values()) {
			if (player.dead || player.isSpectator) continue;
			for (const seg of player.getFreeformTrailSegments()) {
				hash.insertSegment(seg.ax, seg.ay, seg.bx, seg.by, seg);
			}
		}
		for (const mover of this.#players.values()) {
			if (mover.dead || mover.isSpectator) continue;
			const head = mover.getMovementSegment();
			if (!head) continue;
			const ownLen = mover.freeformTrailLength;
			const candidates = hash.querySegment(head.ax, head.ay, head.bx, head.by);
			for (const seg of candidates) {
				if (seg.player == mover) {
					// The head always touches its newest segment(s); ignore them.
					if (seg.index >= ownLen - 1 - FREEFORM_SELF_COLLISION_GRACE_SEGMENTS) continue;
				} else if (seg.player.dead) {
					continue;
				}
				if (segmentsIntersect(head.ax, head.ay, head.bx, head.by, seg.ax, seg.ay, seg.bx, seg.by)) {
					if (seg.player == mover) {
						if (mover.isSpawnProtected) continue; // immune just after spawning
						mover.killBySelfTrail();
					} else {
						// A protected victim can't be cut, and a protected mover can't cut others.
						if (seg.player.isSpawnProtected || mover.isSpawnProtected) continue;
						mover.killByTrailCut(seg.player);
					}
					break;
				}
			}
		}
	}

	#lastPlayerId = 0;
	#getNewPlayerId() {
		while (true) {
			this.#lastPlayerId++;
			if (this.#lastPlayerId >= Math.pow(2, 16) - 1) {
				this.#lastPlayerId = 0;
			}
			let exists = false;
			for (const existingId of this.#players.keys()) {
				if (this.#lastPlayerId == existingId) {
					exists = true;
					break;
				}
			}
			if (!exists && this.#lastPlayerId != 0) {
				return this.#lastPlayerId;
			}
		}
	}

	/** @type {Map<number, Player>} */
	#players = new Map();

	/**
	 * @param {WebSocketConnection} connection
	 * @param {import("./Player.js").CreatePlayerOptions} playerOptions
	 */
	createPlayer(connection, playerOptions) {
		const id = this.#getNewPlayerId();
		const player = new Player(id, this, connection, this.#mainInstance, playerOptions);
		this.#players.set(id, player);
		this.#fireOnPlayerCountChange();
		return player;
	}

	/**
	 * @returns {{position: Vec2, heading: number}}
	 */
	getNewSpawnPosition() {
		const randomCandidate = () => {
			let tempX = Math.floor(
				lerp(PLAYER_SPAWN_RADIUS + 1, this.#arenaWidth - PLAYER_SPAWN_RADIUS - 1, Math.random()),
			);
			let tempY = Math.floor(
				lerp(PLAYER_SPAWN_RADIUS + 1, this.#arenaHeight - PLAYER_SPAWN_RADIUS - 1, Math.random()),
			);

			// Keep players from spawning inside (or on the border of) the pit in arena mode.
			if (
				this.#gameMode == "arena" &&
				tempX >= this.#arenaWidth / 2 - this.#pitWidth / 2 - 2 &&
				tempX <= this.#arenaWidth / 2 + this.#pitWidth / 2 + 1
			) {
				while (
					tempY >= this.#arenaHeight / 2 - this.#pitHeight / 2 - 2 &&
					tempY <= this.#arenaHeight / 2 + this.#pitHeight / 2 + 1
				) {
					tempY = Math.floor(
						lerp(PLAYER_SPAWN_RADIUS + 1, this.#arenaHeight - PLAYER_SPAWN_RADIUS - 1, Math.random()),
					);
				}
			}
			return new Vec2(tempX, tempY);
		};

		// Sample several candidates. Prefer ones whose spawn square is CLEAR of every existing
		// territory (so you never spawn inside or touching someone's island); among equally-clear
		// candidates keep the farthest from any player. Falls back to best-effort if the map is so
		// packed that nothing is clear.
		let position = randomCandidate();
		let bestDist = -1;
		let bestClear = false;
		for (let i = 0; i < SPAWN_CANDIDATE_COUNT; i++) {
			const candidate = randomCandidate();
			const clear = this.#spawnAreaIsClear(candidate.x, candidate.y);
			let minDist = Infinity;
			for (const player of this.#players.values()) {
				if (player.isSpectator || player.permanentlyDead) continue;
				minDist = Math.min(minDist, candidate.distanceTo(player.getPosition()));
			}
			if ((clear && !bestClear) || (clear === bestClear && minDist > bestDist)) {
				bestClear = clear;
				bestDist = minDist;
				position = candidate;
			}
		}

		// Point the initial heading from the spawn towards the arena centre, so players always
		// start by moving inward rather than straight into a wall.
		const heading = Math.atan2(
			this.#arenaHeight / 2 - position.y,
			this.#arenaWidth / 2 - position.x,
		);
		return { position, heading };
	}

	/**
	 * True if a spawn square centred at (cx, cy), grown by the clearance margin, overlaps no existing
	 * player's territory — i.e. spawning here wouldn't land inside or touching someone's island.
	 * @param {number} cx
	 * @param {number} cy
	 * @returns {boolean}
	 */
	#spawnAreaIsClear(cx, cy) {
		const reach = SPAWN_TERRITORY_HALF_TILES + SPAWN_CLEARANCE_TILES;
		const minX = cx - reach, maxX = cx + reach, minY = cy - reach, maxY = cy + reach;
		for (const player of this.#players.values()) {
			if (player.isSpectator || player.permanentlyDead) continue;
			const b = this.#territory.getBoundsTiles(player.id);
			if (!b) continue;
			// Bounding-box quick reject: territories that can't reach the spawn box are fine.
			if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
			// Sample the spawn box on a fine grid; if any point sits in their territory, it's not clear.
			for (let y = minY; y <= maxY; y += 1) {
				for (let x = minX; x <= maxX; x += 1) {
					if (this.#territory.isInside(player.id, x, y)) return false;
				}
			}
		}
		return true;
	}

	/**
	 * @param {Player} player
	 */
	removePlayer(player) {
		if (this.#players.size == REQUIRED_PLAYER_COUNT_FOR_GLOBAL_LEADERBOARD) {
			// If the current player count is REQUIRED_PLAYER_COUNT_FOR_GLOBAL_LEADERBOARD,
			// then once this player is removed scores will no longer be counted.
			// We want to at least report the current player scores, that way their progress wasn't all for nothing.
			// Global scores are deduplicated based on the player name,
			// so the fact that we might report a score for these players a second time shouldn't be an issue.
			for (const player of this.#players.values()) {
				if (!player.isSpectator) {
					this.#reportPlayerScore(player.getGlobalLeaderboardScore());
				}
			}
		} else if (!player.isSpectator) {
			this.#reportPlayerScore(player.getGlobalLeaderboardScore());
		}
		player.removedFromGame();
		this.#players.delete(player.id);
		this.#fireOnPlayerCountChange();
	}

	/** @typedef {(count: number) => void} OnPlayerCountChangeCallback */

	/** @type {Set<OnPlayerCountChangeCallback>} */
	#onPlayerCountChangeCbs = new Set();

	/**
	 * @param {OnPlayerCountChangeCallback} cb
	 */
	onPlayerCountChange(cb) {
		this.#onPlayerCountChangeCbs.add(cb);
	}

	#fireOnPlayerCountChange() {
		this.#onPlayerCountChangeCbs.forEach((cb) => cb(this.#players.size));
	}

	/** @typedef {(score: import("../../../serverManager/src/LeaderboardManager.js").PlayerScoreData) => void} OnPlayerScoreReportedCallback */

	/** @type {Set<OnPlayerScoreReportedCallback>} */
	#onPlayerScoreReportedCbs = new Set();

	/**
	 * @param {OnPlayerScoreReportedCallback} cb
	 */
	onPlayerScoreReported(cb) {
		this.#onPlayerScoreReportedCbs.add(cb);
	}

	/**
	 * @param {import("../../../serverManager/src/LeaderboardManager.js").PlayerScoreData} score
	 */
	#reportPlayerScore(score) {
		if (
			this.#players.size < REQUIRED_PLAYER_COUNT_FOR_GLOBAL_LEADERBOARD ||
			!GM_REPORT_SCORES.includes(this.#gameMode)
		) {
			return;
		}
		this.#onPlayerScoreReportedCbs.forEach((cb) => cb(score));
	}

	async #updateNextMinimapPart() {
		this.#lastMinimapPart = (this.#lastMinimapPart + 1) % 4;
		const lastMinimapPart = this.#lastMinimapPart;
		const part = await this.#territory.getMinimapPart(lastMinimapPart, this.#arenaWidth, this.#arenaHeight);
		const message = WebSocketConnection.createMinimapMessage(lastMinimapPart, part);
		this.#minimapMessages[lastMinimapPart] = message;
		for (const player of this.#players.values()) {
			player.connection.send(message);
		}
	}

	*getMinimapMessages() {
		yield* this.#minimapMessages;
	}

	#sendLeaderboard() {
		/** @type {[player: Player, score: number][]} */
		const playerScores = [];
		for (const player of this.#players.values()) {
			if (this.#gameMode != "arena") {
				playerScores.push([player, player.getTotalScore()]);
			} else {
				playerScores.push([player, player.getTotalKill()]);
			}
		}

		playerScores.sort((a, b) => b[1] - a[1]);

		let i = 1;
		for (const [player] of playerScores) {
			player.setRank(i);
			i++;
		}

		/** @type {[name: string, score: number][]} */
		const scores = playerScores.slice(0, 10).map((scoreData) => {
			const [player, score] = scoreData;
			return [player.name, score];
		});

		const message = WebSocketConnection.createLeaderboardMessage(scores, this.#players.size);
		this.#lastLeaderboardMessage = message;

		for (const player of this.#players.values()) {
			player.connection.send(message);
		}
	}

	getPlayerCount() {
		return this.#players.size;
	}

	/**
	 * Yields a list of players whose viewport contain (part of) the provided rect.
	 * @param {import("../util/util.js").Rect} rect
	 */
	*getOverlappingViewportPlayersForRect(rect) {
		for (const player of this.#players.values()) {
			const viewport = player.getUpdatesViewport();
			if (
				rect.max.x < viewport.min.x || viewport.max.x < rect.min.x || rect.max.y < viewport.min.y ||
				viewport.max.y < rect.min.y
			) {
				continue;
			}

			yield player;
		}
	}

	/**
	 * Yields a list of players whose viewport contain the provided point.
	 * @param {Vec2} pos
	 */
	*getOverlappingViewportPlayersForPos(pos) {
		yield* this.getOverlappingViewportPlayersForRect({
			min: pos.clone(),
			max: pos.clone(),
		});
	}

	/**
	 * Yields a list of players that are either inside the provided rect,
	 * or have a part of their trail inside the rect.
	 * @param {import("../util/util.js").Rect} rect
	 */
	*getOverlappingTrailBoundsPlayersForRect(rect) {
		for (const player of this.#players.values()) {
			const trailBounds = player.getTrailBounds();
			if (
				rect.max.x < trailBounds.min.x || trailBounds.max.x < rect.min.x ||
				rect.max.y < trailBounds.min.y || trailBounds.max.y < rect.min.y
			) {
				continue;
			}

			yield player;
		}
	}

	/**
	 * Yields a list of players that are either at the provided position,
	 * or have might have a part of their trail at the provided position.
	 * @param {Vec2} pos
	 */
	*getOverlappingTrailBoundsPlayersForPos(pos) {
		yield* this.getOverlappingTrailBoundsPlayersForRect({
			min: pos.clone(),
			max: pos.clone(),
		});
	}

	/**
	 * Sends the position and direction of a player to all nearby players.
	 * @param {import("./Player.js").Player} player
	 */
	broadcastPlayerState(player) {
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			player.sendPlayerStateToPlayer(nearbyPlayer);
		}
	}

	/**
	 * Sends the player's polygon territory to all nearby players (and themselves).
	 * @param {import("./Player.js").Player} player
	 */
	broadcastPlayerTerritory(player) {
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			player.sendTerritoryToPlayer(nearbyPlayer);
		}
	}

	/**
	 * Streams the player's continuous trail to all nearby players (and themselves).
	 * @param {import("./Player.js").Player} player
	 */
	broadcastFreeformTrail(player) {
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			player.sendFreeformTrailToPlayer(nearbyPlayer);
		}
	}

	/**
	 * Sends the current color of the player to all nearby players.
	 * @param {import("./Player.js").Player} player
	 */
	broadcastPlayerColor(player) {
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			player.sendPlayerColorToPlayer(nearbyPlayer);
		}
	}

	/**
	 * Notifies nearby players that this player died.
	 * @param {import("./Player.js").Player} player
	 */
	broadcastPlayerDeath(player) {
		const position = player.getPosition();
		const deathTypeInt = WebSocketConnection.deathTypeToInt(player.deathType);
		const message = WebSocketConnection.createPlayerDieMessage(player.id, position, deathTypeInt);
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			if (nearbyPlayer == player) {
				// The client that owns the player should receive 0 as player id
				// We don't want to send the current position of the player either, the client already
				// keeps track of the location where the player died, and if we do send the position,
				// it might cause issues later when the death is undone.
				// The killer id lets this client switch its camera to whoever eliminated it.
				const samePlayerMessage = WebSocketConnection.createPlayerDieMessage(0, null, deathTypeInt, player.killerId);
				nearbyPlayer.connection.send(samePlayerMessage);
			} else {
				nearbyPlayer.connection.send(message);
			}
		}
	}

	/**
	 * Notifies nearby players to render a hit line animation at a specific point.
	 * @param {import("./Player.js").Player} player The player that was hit.
	 * @param {import("./Player.js").Player} hitByPlayer The player that caused the hit.
	 */
	broadcastHitLineAnimation(player, hitByPlayer) {
		const position = hitByPlayer.getPosition();
		const didHitSelf = player == hitByPlayer;
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			const pointsColorId = player.skinColorIdForPlayer(nearbyPlayer);
			const hitByPlayerId = nearbyPlayer == hitByPlayer ? 0 : hitByPlayer.id;
			const message = WebSocketConnection.createHitLineMessage(
				hitByPlayerId,
				pointsColorId,
				position,
				didHitSelf,
			);
			nearbyPlayer.connection.send(message);
		}
	}

	/**
	 * @param {import("./Player.js").Player} player
	 * @param {number} honkDuration
	 */
	broadcastHonk(player, honkDuration) {
		const message = WebSocketConnection.createHonkMessage(player.id, honkDuration);
		for (const nearbyPlayer of player.inOtherPlayerViewports()) {
			if (nearbyPlayer == player) continue;
			nearbyPlayer.connection.send(message);
		}
	}
}
