import { WebSocketConnection } from "../WebSocketConnection.js";
import {
	FREE_SKIN_COLOR_COUNT,
	FREEFORM_MAX_TRAIL_POINTS_HARD,
	GM_FORCE_FLYING_PATCHES,
	MAX_UNDO_EVENT_TIME,
	MIN_TILES_VIEWPORT_RECT_SIZE,
	PAID_SKIN_PATTERN_IDS,
	PLAYER_TRAVEL_SPEED,
	PLAYER_TURN_RATE,
	SPAWN_PROTECTION_MS,
	SPAWN_TERRITORY_HALF_TILES,
	UPDATES_VIEWPORT_RECT_SIZE,
	VIEWPORT_EDGE_CHUNK_SIZE,
} from "../config.js";
import { lerp, Vec2 } from "renda";
import { checkTrailSegment } from "../util/util.js";
import { PlayerEventHistory } from "./PlayerEventHistory.js";

const TAU = Math.PI * 2;

/**
 * When sent inside messages, these translate to an integer:
 * - right - 0
 * - down - 1
 * - left - 2
 * - up - 3
 * - paused - 4
 * @typedef {"right" | "down" | "left" | "up" | "paused"} Direction
 */

/**
 * @typedef {Exclude<Direction, "paused">} UnpausedDirection
 */

/** @typedef {"player" | "arena-bounds" | "self"} DeathType */

/**
 * @typedef SkinData
 * @property {number} colorId
 * @property {number} patternId
 */

/**
 * @typedef CreatePlayerOptions
 * @property {SkinData?} skin
 * @property {string} name
 * @property {boolean} isSpectator
 */

export class Player {
	#id;
	#game;
	#connection;
	#mainInstance;

	#currentTileType = 0;

	/**
	 * The current position of the player, rounded to the coordinate of the current tile.
	 */
	#currentPosition;

	/**
	 * Returns the current position of the player, rounded to the coordinate of the current tile.
	 */
	getPosition() {
		return this.#currentPosition.clone();
	}

	/**
	 * The X position of the player when the most recent horizontal edge chunk was sent to the client.
	 * If the player moves too far away from this position, a new edge chunk will be sent.
	 */
	#lastEdgeChunkSendX;

	/**
	 * The Y position of the player when the most recent vertical edge chunk was sent to the client.
	 * If the player moves too far away from this position, a new edge chunk will be sent.
	 */
	#lastEdgeChunkSendY;

	/**
	 * Continuous freeform movement state. The player always travels at PLAYER_TRAVEL_SPEED
	 * along `#heading` (radians, 0 = +x / "right", increasing clockwise because +y is down).
	 * The client may only request a `#targetHeading`; each tick the server rotates `#heading`
	 * towards it, clamped by PLAYER_TURN_RATE. The server is the sole authority on position.
	 */
	#heading = 0;
	#targetHeading = 0;

	get heading() {
		return this.#heading;
	}

	/**
	 * Continuous freeform trail: the polyline path the player has travelled, as a list of
	 * float tile positions. Used for trail-vs-trail and self collision in continuous space.
	 * Separate from the legacy axis-aligned #trailVertices (dormant during the conversion).
	 * @type {Vec2[]}
	 */
	#freeformTrail = [];

	/**
	 * Whether the player's head is currently inside their own territory. Drives the trail
	 * lifecycle: leaving territory starts a trail, re-entering closes it and captures area.
	 */
	#insideOwnTerritory = true;

	/** True while a capture is being processed by the worker; freezes the trail lifecycle. */
	#captureInFlight = false;

	/** @type {Vec2[]} */
	#trailVertices = [];

	#currentTrailLengthExcludingPos = 0;

	get isGeneratingTrail() {
		return this.#trailVertices.length > 0;
	}

	/**
	 * The bounding box of the current trail, used for hit detection with other players
	 * and determining which players are inside another player's viewport.
	 * @type {import("../util/util.js").Rect}
	 */
	#trailBounds = {
		min: new Vec2(),
		max: new Vec2(),
	};

	#eventHistory = new PlayerEventHistory();

	#capturedTileCount = 0;
	#maxCapturedTileCount = 0;
	#killCount = 0;
	#rank;
	#highestRank;
	#joinTime;
	#isCurrentlyRankingFirst = false;
	#rankingFirstStartTime = 0;
	#rankingFirstSeconds = 0;
	#maxTrailLength = 0;

	/**
	 * @typedef DeathState
	 * @property {number} dieTime
	 * @property {DeathType} type
	 * @property {string} killerName
	 */

	/** @type {DeathState?} */
	#lastDeathState = null;
	get dead() {
		return Boolean(this.#lastDeathState);
	}

	#permanentlyDead = false;
	#permanentlyDieTime = 0;
	get permanentlyDead() {
		return this.#permanentlyDead;
	}

	#skinColorId = 0;
	#skinPatternId = 0;
	/** If the client sent a paid skin id, this is the skin we fallback to if it turns out the client hasn't paid. */
	#fallbackSkinColorId = 0;
	#name = "";
	get name() {
		return this.#name;
	}

	#isSpectator = false;
	get isSpectator() {
		return this.#isSpectator;
	}

	/** Newly spawned players are briefly immune to death and cannot cut others. */
	get isSpawnProtected() {
		return performance.now() < this.#joinTime + SPAWN_PROTECTION_MS;
	}

	/**
	 * The list of other players that this player currently has in their viewport.
	 * We use this to keep track of when new players have entered this player's viewport.
	 * That way we can send stuff like the skin and player name.
	 * @type {Set<Player>}
	 */
	#playersInViewport = new Set();

	/**
	 * A list of other players for which this player is currently in their viewport.
	 * We use this to notify other players that they are no longer observing this player.
	 * @type {Set<Player>}
	 */
	#inOtherPlayerViewports = new Set();

	*inOtherPlayerViewports() {
		yield* this.#inOtherPlayerViewports;
	}

	/**
	 * @param {number} id
	 * @param {import("./Game.js").Game} game
	 * @param {WebSocketConnection} connection
	 * @param {import("../Main.js").Main} mainInstance
	 * @param {CreatePlayerOptions} options
	 */
	constructor(id, game, connection, mainInstance, options) {
		this.#id = id;
		this.#game = game;
		this.#connection = connection;
		this.#mainInstance = mainInstance;

		if (options.skin) {
			this.#skinColorId = options.skin.colorId;
			this.#skinPatternId = options.skin.patternId;
		}
		this.#name = options.name;
		this.#fallbackSkinColorId = Math.floor(lerp(1, FREE_SKIN_COLOR_COUNT + 1, Math.random()));
		if (this.#skinColorId == 0) {
			this.#skinColorId = this.#fallbackSkinColorId;
		}
		this.#isSpectator = options.isSpectator;

		const { position, heading } = game.getNewSpawnPosition();
		this.#currentPosition = position;
		this.#heading = heading;
		this.#targetHeading = heading;
		this.#freeformTrail.push(this.#currentPosition.clone());
		this.#lastEdgeChunkSendX = this.#currentPosition.x;
		this.#lastEdgeChunkSendY = this.#currentPosition.y;
		this.#playerAddedToViewport(this);
		this.#currentPositionChanged();

		this.#eventHistory.onUndoEvent((event) => {
			if (event.type == "kill-player") {
				this.game.undoPlayerDeath(event.playerId);
				if (event.deathType != "arena-bounds") {
					this.#killCount--;
					this.#killCount = Math.max(0, this.#killCount);
					this.#sendMyScore();
				}
			} else if (event.type == "start-trail") {
				// The player started creating a trail, we reset it in order to prevent
				// the tiles underneath the trail from getting filled as a result of the player
				// returning to their captured area.
				this.#clearTrailVertices();
				this.game.broadcastPlayerTrail(this);
			}
		});

		if (!this.#isSpectator) {
			// Keep the legacy tile spawn-fill for now (cosmetic; the tile arena is dormant during
			// the conversion). Territory area is the authoritative score source.
			game.arena.fillPlayerSpawn(this.#currentPosition, id);
			const area = game.territory.setSpawn(
				id,
				this.#currentPosition.x,
				this.#currentPosition.y,
				SPAWN_TERRITORY_HALF_TILES,
			);
			this.#setCapturedTileCount(area);
			this.sendTerritoryToPlayer(this);
		}

		// We prevent the second way of flying.
		if (this.#connection.protocolVersion >= 1 || GM_FORCE_FLYING_PATCHES.includes(this.#game.gameMode)) {
			this.#currentTileType = id;
		}

		this.#joinTime = performance.now();

		// We add one because at this point the current player hasn't been added to the game yet.
		this.#rank = game.getPlayerCount() + 1;
		this.#highestRank = this.#rank;
		this.#sendMyRank();
	}

	get id() {
		return this.#id;
	}

	get game() {
		return this.#game;
	}

	get connection() {
		return this.#connection;
	}

	/**
	 * Returns a rect defining the area for which events should be sent to this player.
	 * @returns {import("../util/util.js").Rect}
	 */
	getUpdatesViewport() {
		return {
			min: this.#currentPosition.clone().addScalar(-UPDATES_VIEWPORT_RECT_SIZE),
			max: this.#currentPosition.clone().addScalar(UPDATES_VIEWPORT_RECT_SIZE),
		};
	}

	/**
	 * Returns the bounding box of the trail of the player.
	 * If the player doesn't have a trail, the bounding box is just the player's position.
	 */
	getTrailBounds() {
		return {
			min: this.#trailBounds.min.clone(),
			max: this.#trailBounds.max.clone(),
		};
	}

	/**
	 * The client requested a new target heading for its player. The server does not move the
	 * player to a client-provided position; it only records the desired heading and steers
	 * towards it (clamped by PLAYER_TURN_RATE) during the game loop. This makes the server the
	 * sole authority on position, which is the core movement anti-cheat for freeform play.
	 * @param {number} targetHeading Angle in radians.
	 */
	clientHeadingUpdateRequested(targetHeading) {
		if (this.#mainInstance.applicationLoop.currentTickIsSlow()) return;
		if (!Number.isFinite(targetHeading)) return;
		if (this.dead || this.isSpectator) return;
		// Normalise into [0, 2π) so the shortest-rotation math in the loop stays well defined.
		this.#targetHeading = ((targetHeading % TAU) + TAU) % TAU;
	}

	/**
	 * @param {SkinData} skinData
	 */
	setSkin({ colorId, patternId }) {
		this.#skinColorId = colorId;
		this.#skinPatternId = patternId;
	}

	/**
	 * Adds a vertex to the current trail, deduplicating any unnecessary vertices.
	 * Throws when a diagonal vertex is added.
	 * @param {Vec2} pos
	 */
	#addTrailVertex(pos) {
		const lastVertexA = this.#trailVertices.at(-1);
		if (lastVertexA) {
			if (pos.x == lastVertexA.x && pos.y == lastVertexA.y) {
				// The last vertex is already at the same location,
				// we won't do anything to avoid duplicate vertices.
				return;
			}
			if (pos.x != lastVertexA.x && pos.y != lastVertexA.y) {
				throw new Error(
					"Assertion failed: Attempted to add a trail vertex that would result in a diagonal segment.",
				);
			}
			const lastVertexB = this.#trailVertices.at(-2);
			if (lastVertexB) {
				// We check if the previous two vertices are on the same line as the one we're about to add.
				// If so, we modify the last vertex instead of adding a new one.
				if (lastVertexA.x == lastVertexB.x && lastVertexA.x == pos.x) {
					if (pos.y >= lastVertexA.y && pos.y <= lastVertexB.y) {
						throw new Error(
							`Assertion failed: Attempted to add a trail vertex (${pos}) in between two previous vertices. Full trail: ${
								this.#trailVertices.join(" ")
							}`,
						);
					}
					lastVertexA.set(pos);
					return;
				}
				if (lastVertexA.y == lastVertexB.y && lastVertexA.y == pos.y) {
					if (pos.x >= lastVertexA.x && pos.x <= lastVertexB.x) {
						throw new Error(
							`Assertion failed: Attempted to add a trail vertex (${pos}) in between two previous vertices. Full trail: ${
								this.#trailVertices.join(" ")
							}`,
						);
					}
					lastVertexA.set(pos);
					return;
				}
			}
		}
		this.#trailVertices.push(pos.clone());
		this.#updateTrailLengthExcludingPos();
	}

	#clearTrailVertices() {
		this.#trailVertices = [];
		this.#currentTrailLengthExcludingPos = 0;
	}

	#updateTrailLengthExcludingPos() {
		let length = 0;
		for (let i = 0; i < this.#trailVertices.length - 1; i++) {
			const vertexA = this.#trailVertices[i];
			const vertexB = this.#trailVertices[i + 1];
			length += vertexA.distanceTo(vertexB);
		}
		this.#currentTrailLengthExcludingPos = length;
	}

	/**
	 * Sends the state of this player to `receivingPlayer`.
	 * @param {import("./Player.js").Player} receivingPlayer
	 */
	sendPlayerStateToPlayer(receivingPlayer) {
		const playerId = this == receivingPlayer ? 0 : this.id;
		receivingPlayer.connection.sendPlayerState(
			this.#currentPosition.x,
			this.#currentPosition.y,
			playerId,
			this.#heading,
		);
	}

	/**
	 * Sends the state of this player to `receivingPlayer`.
	 * @param {import("./Player.js").Player} receivingPlayer
	 */
	sendPlayerColorToPlayer(receivingPlayer) {
		const playerId = this == receivingPlayer ? 0 : this.id;
		const colorId = this.skinColorIdForPlayer(receivingPlayer);
		receivingPlayer.connection.sendPlayerSkin(playerId, colorId);
	}

	/**
	 * Sends the state of this player to `receivingPlayer`.
	 * @param {import("./Player.js").Player} receivingPlayer
	 */
	sendTrailToPlayer(receivingPlayer) {
		const playerId = this == receivingPlayer ? 0 : this.id;
		const message = WebSocketConnection.createTrailMessage(playerId, Array.from(this.#trailVertices));
		receivingPlayer.connection.send(message);
	}

	/**
	 * Sends this player's polygon territory to `receivingPlayer`.
	 * @param {import("./Player.js").Player} receivingPlayer
	 */
	sendTerritoryToPlayer(receivingPlayer) {
		const playerId = this == receivingPlayer ? 0 : this.id;
		const mp = this.game.territory.getMultiPolygon(this.id);
		const message = WebSocketConnection.createTerritoryMessage(playerId, mp);
		receivingPlayer.connection.send(message);
	}

	get visibleSkinColorId() {
		if (!this.#connection.plusSkinsAllowed && this.#skinColorId > FREE_SKIN_COLOR_COUNT) {
			return this.#fallbackSkinColorId;
		}
		return this.#skinColorId;
	}

	get visibleSkinPatternId() {
		if (!this.#connection.plusSkinsAllowed && PAID_SKIN_PATTERN_IDS.includes(this.#skinPatternId)) {
			return 0;
		}
		return this.#skinPatternId;
	}

	/**
	 * Returns an integer that a client can use to render the correct color for this player or one of its tiles.
	 * When two players have the same color, a different integer is returned to make sure a
	 * player doesn't see any players with their own color.
	 * The returned value ranges from 1 to FREE_SKINS_COUNT.
	 * @param {Player} otherPlayer The player that the message will be sent to.
	 */
	skinColorIdForPlayer(otherPlayer) {
		if (this.visibleSkinColorId != otherPlayer.visibleSkinColorId || otherPlayer == this) {
			return this.visibleSkinColorId;
		} else {
			// At this point, the color of this player is the same as my color, we'll generate a random color (that is not mine)
			// The color is not strictly random, but instead we use the id of the player as 'seed',
			// that way the colorId stays consistent when this is called multiple times.

			// The amount of possible colors to choose from.
			// If we are using a free skin then this one cannot be generated, subtract one to exclude it.
			let possibleSkinsCount = FREE_SKIN_COLOR_COUNT;
			if (this.visibleSkinColorId <= possibleSkinsCount) {
				possibleSkinsCount--;
			}

			// This modulo operator maps 0 to 0, 1 to 1 etc. until possibleSkinsCount is reached, which is mapped to 0 again.
			let fakeSkinId = this.id % possibleSkinsCount;
			// So now fakeSkinId could range anywhere from 0 to (possibleSkinsCount - 1).

			// But we want to exclude 0 from this range, since that colorId represents grey.
			// We 'shift' the range to the right by incrementing it.
			fakeSkinId++;
			// Now fakeSkinId could range anywhere from 1 to possibleSkinsCount.

			// But what we want is to generate any color except the one from the other player.
			// Otherwise we still might end up displaying this player with the same color as that of the client we are sending it to.
			// Which is exactly what we were trying to prevent in the first place.

			// We 'cut' the range in half by shifting only one portion to the right.
			// Only if the the current value is higher than or equal to the color of the other player, will we increment it.
			if (fakeSkinId >= otherPlayer.visibleSkinColorId) {
				fakeSkinId++;
			}
			// Now fakeSkinId could range anywhere from 1 to (otherPlayer.skinId - 1)
			// or from (otherPlayer.skinId + 1) to FREE_SKINS_COUNT.
			return fakeSkinId;
		}
	}

	updateNearbyPlayerSkinColors() {
		for (const player of this.#playersInViewport) {
			if (player == this) continue;
			player.sendPlayerColorToPlayer(this);
		}
	}

	*getTrailVertices() {
		for (const vertex of this.#trailVertices) {
			yield vertex.clone();
		}
	}

	/**
	 * Territory-driven trail lifecycle, run every tick after the player moves:
	 *  - inside -> outside: start a trail, seeded at the last inside position so the eventual
	 *    closing union overlaps the existing territory cleanly;
	 *  - outside -> inside: append the re-entry point, capture the enclosed area, clear the trail;
	 *  - still outside: extend the trail;
	 *  - still inside: no trail.
	 * @param {number} prevX Previous position x (inside the territory on a leaving transition).
	 * @param {number} prevY Previous position y.
	 */
	#updateFreeformTrail(prevX, prevY) {
		if (this.#isSpectator) return;
		// While a capture is in flight, the mirror is briefly stale; freeze the lifecycle until the
		// worker result lands (onCaptureResolved) to avoid acting on stale inside/outside state.
		if (this.#captureInFlight) return;
		const inside = this.game.territory.isInside(this.id, this.#currentPosition.x, this.#currentPosition.y);

		if (this.#insideOwnTerritory && !inside) {
			this.#freeformTrail = [new Vec2(prevX, prevY), this.#currentPosition.clone()];
		} else if (!this.#insideOwnTerritory && inside) {
			this.#freeformTrail.push(this.#currentPosition.clone());
			this.#captureFreeformTrail();
			this.#freeformTrail = [];
		} else if (!inside) {
			// Only record a point once the head has actually moved a little. Otherwise, when the
			// player is pinned against the border (or barely moving), duplicate points pile up and
			// form degenerate, self-intersecting segments that trigger a false self-collision death.
			const last = this.#freeformTrail[this.#freeformTrail.length - 1];
			if (!last || last.distanceTo(this.#currentPosition) > 0.2) {
				this.#freeformTrail.push(this.#currentPosition.clone());
			}
			// Anti-grief: an excursion that never returns is capped; exceeding it kills the player.
			if (this.#freeformTrail.length > FREEFORM_MAX_TRAIL_POINTS_HARD) {
				this.killBySelfTrail();
			}
		} else if (this.#freeformTrail.length > 0) {
			this.#freeformTrail = [];
		}

		this.#insideOwnTerritory = inside;
	}

	/**
	 * Closes the current trail into the player's territory and applies the resulting area
	 * (and any stolen area) to the affected players' scores.
	 */
	#captureFreeformTrail() {
		const trailTiles = this.#freeformTrail.map((v) => ({ x: v.x, y: v.y }));
		this.#captureInFlight = true;
		this.#freeformTrail = []; // the loop is consumed; freeze the trail until the worker result lands
		this.game.territory.requestCapture(this.id, trailTiles);
	}

	/**
	 * Applies a new captured area to this player's score. Called when a capture result arrives
	 * (for the capturing player and for anyone whose land was stolen).
	 * @param {number} area
	 */
	applyCapturedArea(area) {
		this.#setCapturedTileCount(area);
	}

	/**
	 * Called when this player's own capture result has been applied to the territory mirror. The
	 * head is now inside the freshly enlarged territory, so resume the lifecycle from "inside".
	 */
	onCaptureResolved() {
		this.#captureInFlight = false;
		this.#insideOwnTerritory = true;
		this.#freeformTrail = [];
	}

	get freeformTrailLength() {
		return this.#freeformTrail.length;
	}

	/**
	 * Yields each segment of the continuous trail as a plain object, tagged with this player
	 * and the segment index, ready to be inserted into the collision spatial hash.
	 */
	*getFreeformTrailSegments() {
		for (let i = 0; i < this.#freeformTrail.length - 1; i++) {
			const a = this.#freeformTrail[i];
			const b = this.#freeformTrail[i + 1];
			yield { player: this, ax: a.x, ay: a.y, bx: b.x, by: b.y, index: i };
		}
	}

	/**
	 * Returns the most recent trail segment (the head), or null if the trail is too short.
	 * @returns {{ax: number, ay: number, bx: number, by: number} | null}
	 */
	getFreeformHeadSegment() {
		const n = this.#freeformTrail.length;
		if (n < 2) return null;
		const a = this.#freeformTrail[n - 2];
		const b = this.#freeformTrail[n - 1];
		return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
	}

	/**
	 * This player's head crossed `victim`'s trail, cutting it. The victim dies and this
	 * player is credited with the kill.
	 * @param {Player} victim
	 */
	killByTrailCut(victim) {
		const success = this.#killPlayer(victim, "player");
		if (success) this.game.broadcastHitLineAnimation(victim, this);
	}

	/**
	 * This player's head crossed their own trail.
	 */
	killBySelfTrail() {
		const success = this.#killPlayer(this, "self");
		if (success) this.game.broadcastHitLineAnimation(this, this);
	}

	/**
	 * Rotates `#heading` towards `#targetHeading` by at most PLAYER_TURN_RATE * dt,
	 * taking the shortest angular direction. Keeps the result normalised to [0, 2π).
	 * @param {number} dt
	 */
	#advanceHeading(dt) {
		const maxDelta = PLAYER_TURN_RATE * dt;
		// Shortest signed angular difference, mapped into (-π, π].
		let diff = ((this.#targetHeading - this.#heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
		if (Math.abs(diff) <= maxDelta) {
			this.#heading = this.#targetHeading;
		} else {
			this.#heading += Math.sign(diff) * maxDelta;
		}
		this.#heading = ((this.#heading % TAU) + TAU) % TAU;
	}

	/**
	 * @param {number} now
	 * @param {number} dt
	 */
	loop(now, dt) {
		if (!this.dead) {
			// Steer the heading towards the client's requested target, clamped by the turn rate,
			// then advance the position continuously along the (new) heading.
			const prevX = this.#currentPosition.x;
			const prevY = this.#currentPosition.y;
			this.#advanceHeading(dt);
			const distance = dt * PLAYER_TRAVEL_SPEED;
			this.#currentPosition.x += Math.cos(this.#heading) * distance;
			this.#currentPosition.y += Math.sin(this.#heading) * distance;
			// The outer world border is a sliding wall, not death: clamp to the arena interior so the
			// player skims along the edge instead of dying when they reach it.
			const m = 0.5;
			this.#currentPosition.x = Math.max(m, Math.min(this.game.arena.width - 1 - m, this.#currentPosition.x));
			this.#currentPosition.y = Math.max(m, Math.min(this.game.arena.height - 1 - m, this.#currentPosition.y));
			this.#updateFreeformTrail(prevX, prevY);

			try {
				this.game.broadcastPlayerState(this);
				this.#currentPositionChanged();
			} catch (e) {
				console.error(e);
				if (this.game.gameMode != "arena") {
					this.#connection.close();
				}
			}
		}

		if (this.#lastDeathState) {
			const dt = performance.now() - this.#lastDeathState.dieTime;
			if (dt > MAX_UNDO_EVENT_TIME) {
				this.#permanentlyDie();
			}
		}
		if (this.#permanentlyDead) {
			const dt = performance.now() - this.#permanentlyDieTime;
			if (dt > 5_000) {
				this.connection.close();
			}
		}
	}

	#currentPositionChanged() {
		// Update the trailbounds
		if (this.isGeneratingTrail) {
			this.#trailBounds.min.x = Math.min(this.#trailBounds.min.x, this.#currentPosition.x);
			this.#trailBounds.min.y = Math.min(this.#trailBounds.min.y, this.#currentPosition.y);
			this.#trailBounds.max.x = Math.max(this.#trailBounds.max.x, this.#currentPosition.x);
			this.#trailBounds.max.y = Math.max(this.#trailBounds.max.y, this.#currentPosition.y);
		} else {
			this.#trailBounds.min = this.#currentPosition.clone();
			this.#trailBounds.max = this.#currentPosition.clone();
		}

		// Update max trail length
		if (this.isGeneratingTrail) {
			const lastVertex = this.#trailVertices.at(-1);
			if (!lastVertex) throw new Error("Assertion failed, trailVertices is empty");
			const trailLength = lastVertex.distanceTo(this.#currentPosition) + this.#currentTrailLengthExcludingPos;
			this.#maxTrailLength = Math.max(this.#maxTrailLength, trailLength);
		}

		{
			// Check if any new players entered or left our viewport
			let leftPlayers = new Set([...this.#playersInViewport]);
			for (const player of this.game.getOverlappingTrailBoundsPlayersForRect(this.getUpdatesViewport())) {
				leftPlayers.delete(player);
				this.#playerAddedToViewport(player);
			}
			for (const player of leftPlayers) {
				this.#playerRemovedFromViewport(player);
			}

			// Check if we moved in or out of someone elses viewport
			leftPlayers = new Set([...this.#inOtherPlayerViewports]);
			for (const player of this.game.getOverlappingViewportPlayersForRect(this.getTrailBounds())) {
				leftPlayers.delete(player);
				player.#playerAddedToViewport(this);
			}
			for (const player of leftPlayers) {
				player.#playerRemovedFromViewport(this);
			}
		}

		// The outer world border no longer kills (the player is clamped to it in loop() and slides
		// along it). In arena mode the central pit border is still lethal.
		if (!this.isSpectator && this.game.gameMode == "arena") {
			const tileX = Math.floor(this.#currentPosition.x);
			const tileY = Math.floor(this.#currentPosition.y);
			if (this.game.arena.getTileValue(new Vec2(tileX, tileY)) === -1) {
				this.#killPlayer(this, "arena-bounds");
			}
		}

		// Trail-vs-trail collision is reintroduced as continuous segment intersection in the
		// continuous-collision milestone; the old integer point-in-trail check is removed here.

		// Send new sections of the map when needed.
		this.#sendRequiredEdgeChunks();
	}

	/**
	 * Another player just moved into our viewport, or we moved closer to another player.
	 * We need to notify the client of their skin and name etc.
	 * @param {Player} player
	 */
	#playerAddedToViewport(player) {
		if (this.#playersInViewport.has(player)) return;
		if (player.permanentlyDead) return;
		this.#playersInViewport.add(player);
		player.#inOtherPlayerViewports.add(this);
		player.sendPlayerStateToPlayer(this);
		const colorId = player.skinColorIdForPlayer(this);
		const playerId = player == this ? 0 : player.id;
		this.#connection.sendPlayerSkin(playerId, colorId);
		this.#connection.sendPlayerName(playerId, player.#name);
		if (player.#isSpectator) {
			this.#connection.sendPlayerIsSpectator(playerId);
		}
		if (player.dead) {
			const playerDeadMessage = WebSocketConnection.createPlayerDieMessage(player.id, null);
			this.#connection.send(playerDeadMessage);
		}
		player.sendTrailToPlayer(this);
		player.sendTerritoryToPlayer(this);
	}

	/**
	 * Another player just moved out of our viewport, or we moved away from it.
	 * We need to notify the client that they can stop rendering this player.
	 * @param {Player} player
	 */
	#playerRemovedFromViewport(player) {
		if (this.#removedFromGame) return;
		if (player == this) return;
		if (!this.#playersInViewport.has(player)) return;
		this.#playersInViewport.delete(player);
		player.#inOtherPlayerViewports.delete(this);
		this.#connection.sendRemovePlayer(player.id);
	}

	#sendRequiredEdgeChunks() {
		const chunkSize = VIEWPORT_EDGE_CHUNK_SIZE;
		const viewportSize = MIN_TILES_VIEWPORT_RECT_SIZE;
		/** @type {{x: number, y: number, w: number, h: number} | null} */
		let chunk = null;
		if (this.#currentPosition.x >= this.#lastEdgeChunkSendX + chunkSize) {
			chunk = {
				x: this.#currentPosition.x + viewportSize,
				y: this.#lastEdgeChunkSendY - viewportSize - chunkSize,
				w: chunkSize,
				h: (viewportSize + chunkSize) * 2,
			};
			this.#lastEdgeChunkSendX = this.#currentPosition.x;
		}
		if (this.#currentPosition.x <= this.#lastEdgeChunkSendX - chunkSize) {
			chunk = {
				x: this.#currentPosition.x - viewportSize - chunkSize,
				y: this.#lastEdgeChunkSendY - viewportSize - chunkSize,
				w: chunkSize,
				h: (viewportSize + chunkSize) * 2,
			};
			this.#lastEdgeChunkSendX = this.#currentPosition.x;
		}
		if (this.#currentPosition.y >= this.#lastEdgeChunkSendY + chunkSize) {
			chunk = {
				x: this.#lastEdgeChunkSendX - viewportSize - chunkSize,
				y: this.#currentPosition.y + viewportSize,
				w: (viewportSize + chunkSize) * 2,
				h: chunkSize,
			};
			this.#lastEdgeChunkSendY = this.#currentPosition.y;
		}
		if (this.#currentPosition.y <= this.#lastEdgeChunkSendY - chunkSize) {
			chunk = {
				x: this.#lastEdgeChunkSendX - viewportSize - chunkSize,
				y: this.#currentPosition.y - viewportSize - chunkSize,
				w: (viewportSize + chunkSize) * 2,
				h: chunkSize,
			};
			this.#lastEdgeChunkSendY = this.#currentPosition.y;
		}
		if (chunk) {
			const { x, y, w, h } = chunk;
			this.sendChunk({
				min: new Vec2(x, y),
				max: new Vec2(x + w, y + h),
			});
		}
	}

	/**
	 * Sends a chunk of tiles from the arena.
	 * @param {import("../util/util.js").Rect} rect The area to send.
	 */
	sendChunk(rect) {
		const chunkData = this.game.getArenaChunkForMessage(rect, this);
		for (const rect of chunkData) {
			this.connection.sendFillRect(rect.rect, rect.tileType.colorId, rect.tileType.patternId, true);
		}
	}

	/**
	 * (re)sends a chunk of tiles from the arena containing entire visible viewport to this player.
	 */
	sendCurrentViewportChunk() {
		const pos = this.getPosition();
		this.sendChunk({
			min: pos.clone().subScalar(UPDATES_VIEWPORT_RECT_SIZE),
			max: pos.clone().addScalar(UPDATES_VIEWPORT_RECT_SIZE),
		});
	}

	/**
	 * Kills another player (or this player itself) and records an event in the event history.
	 * So that the death can be undone should the player move back in time.
	 *
	 * @param {Player} otherPlayer
	 * @param {DeathType} deathType
	 */
	#killPlayer(otherPlayer, deathType) {
		if (otherPlayer.dead) return false;
		this.#eventHistory.addEvent(this.getPosition(), {
			type: "kill-player",
			playerId: otherPlayer.id,
			deathType,
		});
		otherPlayer.#die(deathType, this.name);
		if (deathType != "arena-bounds") {
			this.#killCount++;
			this.#sendMyScore();
		}
		return true;
	}

	/**
	 * Initiates a player death. Though at this point the death is not permanent yet.
	 * The death can still be undone by the player that killed the other player, if it turns out
	 * they moved away just in time before hitting them.
	 *
	 * @param {DeathType} deathType
	 * @param {string} killerName
	 */
	#die(deathType, killerName) {
		if (this.#lastDeathState) return;
		this.#lastDeathState = {
			dieTime: performance.now(),
			type: deathType,
			killerName,
		};
		// Clear the continuous trail so a dead player's trail can no longer cut anyone.
		this.#freeformTrail = [];
		this.game.broadcastPlayerDeath(this);
	}

	undoDie() {
		this.#lastDeathState = null;
		this.game.broadcastUndoPlayerDeath(this);
	}

	#permanentlyDie() {
		if (this.#permanentlyDead) return;
		this.#permanentlyDead = true;
		this.#permanentlyDieTime = performance.now();
		this.#clearAllMyTiles();
		if (!this.#lastDeathState) {
			throw new Error("Assertion failed, no death state is set");
		}
		this.#incrementRankingFirstSeconds();
		const rankingFirstSeconds = Math.round(this.#rankingFirstSeconds / 1000);
		this.connection.sendGameOver(
			this.#capturedTileCount,
			this.#killCount,
			this.#highestRank,
			this.#getTimeAliveSeconds(),
			rankingFirstSeconds,
			this.#lastDeathState.type,
			this.#lastDeathState.type == "player" ? this.#lastDeathState.killerName : "",
		);
	}

	#getTimeAliveSeconds() {
		const timeAliveMs = performance.now() - this.#joinTime;
		return Math.round(timeAliveMs / 1000);
	}

	/**
	 * If true, the player is no longer in game and
	 * updates should no longer be sent since the connection is likely already closed.
	 */
	#removedFromGame = false;

	removedFromGame() {
		this.#removedFromGame = true;
		this.#clearAllMyTiles();
		for (const player of this.#playersInViewport) {
			player.#inOtherPlayerViewports.delete(this);
		}
		for (const player of this.#inOtherPlayerViewports) {
			player.#playerRemovedFromViewport(this);
		}
	}

	#allMyTilesCleared = false;

	/**
	 * Resets all owned tiles of this player back to tiles that are not owned by anyone.
	 * This can only be called once, so after this has been called, no attempts should be
	 * made to add new tiles of this player to the arena.
	 */
	#clearAllMyTiles() {
		if (this.#allMyTilesCleared || this.#isSpectator) return;
		this.#allMyTilesCleared = true;
		this.game.arena.clearAllPlayerTiles(this.id);
		this.game.territory.remove(this.id);
	}

	/**
	 * This will cause the arena worker to fire fill rect events which cover all filled tiles for this player.
	 * This can be used to update the color of this player.
	 */
	fireAllMyTileUpdates() {
		if (this.#isSpectator) return;
		this.game.arena.fireAllPlayerTileUpdates(this.id);
	}

	/**
	 * @param {Vec2} point
	 */
	rectOverlapsTrailBounds(point) {
		const bounds = this.#trailBounds;
		return point.x >= bounds.min.x && point.y >= bounds.min.y && point.x <= bounds.max.x && point.y <= bounds.max.y;
	}

	/**
	 * Checks if a point is inside the trail of the player.
	 * If the player is not generating a trail,
	 * this checks if the point lies at the exact location of the current player.
	 * @param {Vec2} point
	 * @param {Object} options
	 * @param {boolean} [options.includeLastSegments] When true, also checks if the point lies between the
	 * last two segments and the current position of the player. When checking if the player is touching their own
	 * trail, we need to ignore the last two segments since the player position is always touching the last segment.
	 * If the player made a turn recently, it might also be inside the second to last segment.
	 */
	pointIsInTrail(point, {
		includeLastSegments = true,
	} = {}) {
		if (this.isGeneratingTrail) {
			const verticesLengthOffset = includeLastSegments ? 1 : 2;
			const verticesLength = this.#trailVertices.length - verticesLengthOffset;
			for (let i = 0; i < verticesLength; i++) {
				const start = this.#trailVertices[i];
				const end = this.#trailVertices[i + 1];
				if (checkTrailSegment(point, start, end)) return true;
			}
			if (includeLastSegments) {
				const lastVertex = this.#trailVertices.at(-1);
				if (!lastVertex) throw new Error("Assertion failed, trailVertices is empty");
				if (checkTrailSegment(point, lastVertex, this.#currentPosition)) return true;
			}
			return false;
		} else {
			if (includeLastSegments) {
				return point.x == this.#currentPosition.x && point.y == this.#currentPosition.y;
			}
			return false;
		}
	}

	/**
	 * Checks if the type of the tile the player is currently on has changed.
	 * This can happen either because the player moved to a new coordinate,
	 * or because the current tile type got changed to that of another player.
	 * @param {Vec2} previousPosition Used for the final vertex when a trail ends.
	 */
	#updateCurrentTile(previousPosition) {
		const tileValue = this.#game.arena.getTileValue(this.#currentPosition);
		if (this.#currentTileType != tileValue) {
			// When the player moves out of their captured area, we will start a new trail.
			if (tileValue != this.#id && !this.isGeneratingTrail) {
				this.#eventHistory.addEvent(this.getPosition(), { type: "start-trail" });
				this.#addTrailVertex(this.#currentPosition);
				this.game.broadcastPlayerTrail(this);
			}

			// When the player comes back into their captured area, we add a final vertex to the trail,
			// Then fill the tiles underneath the trail, and finally clear the trail.
			if (tileValue == this.#id && this.isGeneratingTrail) {
				this.#addTrailVertex(previousPosition);
				if (this.#allMyTilesCleared) {
					throw new Error("Assertion failed, player tiles have already been removed from the arena.");
				}
				this.game.arena.fillPlayerTrail(this.#trailVertices, this.id);
				this.#updateCapturedArea();
				this.game.broadcastPlayerEmptyTrail(this);
				this.#clearTrailVertices();
			}

			this.#currentTileType = tileValue;
		}
	}

	async #updateCapturedArea() {
		const totalFilledTileCount = await this.game.arena.updateCapturedArea(
			this.id,
			Array.from(this.game.getUnfillableLocations(this)),
		);
		this.#setCapturedTileCount(totalFilledTileCount);
	}

	/**
	 * @param {number} capturedTileCount
	 */
	#setCapturedTileCount(capturedTileCount) {
		if (this.#capturedTileCount != capturedTileCount) {
			this.#capturedTileCount = capturedTileCount;
			this.#maxCapturedTileCount = Math.max(this.#maxCapturedTileCount, this.#capturedTileCount);
			this.#sendMyScore();
		}
	}

	#sendMyScore() {
		this.#connection.sendMyScore(this.#capturedTileCount, this.#killCount);
	}

	/**
	 * @param {number} rank
	 */
	setRank(rank) {
		this.#rank = rank;
		this.#highestRank = Math.min(this.#highestRank, rank);
		this.#sendMyRank();

		const isRankingFirst = this.#rank == 1;
		if (isRankingFirst != this.#isCurrentlyRankingFirst) {
			this.#isCurrentlyRankingFirst = isRankingFirst;
			if (isRankingFirst) {
				this.#rankingFirstStartTime = performance.now();
			} else {
				this.#incrementRankingFirstSeconds();
			}
		}
	}

	#incrementRankingFirstSeconds() {
		if (this.#rankingFirstStartTime <= 0) return;
		const duration = performance.now() - this.#rankingFirstStartTime;
		this.#rankingFirstSeconds += duration;
		this.#rankingFirstStartTime = 0;
	}

	#sendMyRank() {
		this.#connection.sendMyRank(this.#rank);
	}

	getTotalScore() {
		return this.#capturedTileCount + this.#killCount * 500;
	}

	getTotalKill() {
		return this.#killCount;
	}

	/**
	 * @returns {import("../../../serverManager/src/LeaderboardManager.js").PlayerScoreData}
	 */
	getGlobalLeaderboardScore() {
		return {
			name: this.name,
			scoreTiles: this.#maxCapturedTileCount,
			rankingFirstSeconds: Math.round(this.#rankingFirstSeconds / 1000),
			scoreKills: this.#killCount,
			timeAliveSeconds: this.#getTimeAliveSeconds(),
			trailLength: this.#maxTrailLength,
		};
	}

	/**
	 * @param {number} honkDuration
	 */
	honk(honkDuration) {
		this.game.broadcastHonk(this, honkDuration);
	}
}
