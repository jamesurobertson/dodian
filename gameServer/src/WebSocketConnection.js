import { clamp, Vec2 } from "renda";
import {
	POSITION_NETWORK_SCALE,
	TERRITORY_NETWORK_SIMPLIFY_EPS,
	VALID_PLAYER_NAME_LENGTH,
	VALID_SKIN_COLOR_RANGE,
	VALID_SKIN_PATTERN_RANGE,
} from "./config.js";
import { Player } from "./gameplay/Player.js";
import { ControlSocketConnection } from "./ControlSocketConnection.js";
import { simplifyMultiPolygon } from "./util/geometry.js";

const TAU = Math.PI * 2;

/**
 * - `"add-segment"` - adds a new polygon to the current trail.
 * - `"reset"` - clear the current trail
 * - `null` leave the trail unchanged
 * @typedef {"add-segment" | "reset" | null} ChangeTrailBehaviour
 */

/**
 * The color ids that clients send to servers include 0,
 * which assigns a random color on the server's end.
 * But there is no need to ever send 0 to the client, so it expects the first color
 * to start at 0 instead.
 * Ideally we should have kept the color ids for both server and client mapped to the same colors.
 * But mistakes have been made, and we need to subtract 1 from the id now.
 * @param {number} colorId
 */
function serverToClientColorId(colorId) {
	return colorId - 1;
}

export const initializeControlSocketMessage = "initializeControlSocket";

/**
 * Handles the messaging between server and client.
 * Received messages are converted to a format that is easier to work with.
 * For instance, ArrayBuffers with coordinates are converted to Vec2 and then
 * passed on to a class such as its `#player` or `#game`.
 *
 * Similarly, this contains a few `send` methods which converts stuff like Vec2
 * back into ArrayBuffers before sending the data.
 */
export class WebSocketConnection {
	#socket;
	#mainInstance;
	#game;
	/** @type {Player?} */
	#player = null;
	/** @type {ControlSocketConnection?} */
	#controlSocket = null;

	get controlSocket() {
		return this.#controlSocket;
	}

	/**
	 * @param {WebSocket} socket
	 * @param {string} ip
	 * @param {import("./Main.js").Main} mainInstance
	 * @param {import("./gameplay/Game.js").Game} game
	 */
	constructor(socket, ip, mainInstance, game) {
		this.#mainInstance = mainInstance;
		this.#socket = socket;
		this.#game = game;
	}

	static get SendAction() {
		return {
			/**
			 * Legacy, unused.
			 */
			UPDATE_BLOCKS: 1,
			/**
			 * Updates player state such as position, direction, and trail.
			 */
			PLAYER_STATE: 2,
			/**
			 * Informs the client to replace all tiles in a rectangle with a specified color.
			 */
			FILL_RECT: 3,
			/**
			 * Updates the trail of a specific player.
			 */
			SET_PLAYER_TRAIL: 4,
			/**
			 * Lets all nearby clients know that they should play the death animation for a specific player.
			 */
			PLAYER_DIE: 5,
			/**
			 * Sends an area of the map to a player.
			 * Each tile is sent individually with no form of compression, so the message could be quite big.
			 */
			CHUNK_OF_BLOCKS: 6,
			/**
			 * Notifies the client that they can stop rendering and remove all data from a player.
			 * This is sent when a player moves out of another player's viewport.
			 * When they enter each other's viewport again, data such as skin id and player name needs to be sent again.
			 */
			REMOVE_PLAYER: 7,
			/**
			 * Notifies the client about the name of a specific player.
			 */
			PLAYER_NAME: 8,
			/**
			 * Sends the captured tile count and kill count of the current player.
			 */
			MY_SCORE: 9,
			MY_RANK: 10,
			/**
			 * Sends the player names and scores of the top 10 players, and the total amount of players in the game.
			 */
			LEADERBOARD: 11,
			/**
			 * Lets the client know about the size of the map.
			 * This is used for correctly rendering the position on the minimap, among other things.
			 */
			MAP_SIZE: 12,
			/**
			 * Tells the client to show the game over screen.
			 */
			GAME_OVER: 13,
			/**
			 * Sends a part of the minimap to the client.
			 */
			MINIMAP: 14,
			/**
			 * Tells the client which skin a specific player has.
			 */
			PLAYER_SKIN: 15,
			/**
			 * Notifies the client that whatever trail it is currently creating for a player,
			 * should be ended at a specific position.
			 */
			EMPTY_TRAIL_WITH_LAST_POS: 16,
			/**
			 * Lets the client know that all required data has been sent to start the game.
			 * This will will hide the loading transition on the client.
			 */
			READY: 17,
			/**
			 * Notifies clients to render a 'hit line' circle at a location.
			 */
			PLAYER_HIT_LINE: 18,
			REFRESH_AFTER_DIE: 19,
			/**
			 * A player honked.
			 */
			PLAYER_HONK: 20,
			PONG: 21,
			/**
			 * Lets the client know that a player didn't die after all, and it should
			 * start rendering and moving it again.
			 */
			UNDO_PLAYER_DIE: 22,
			TEAM_LIFE_COUNT: 23,
			PLAYER_IS_SPECTATOR: 24,
			/**
			 * Freeform conversion: sends a player's polygon territory (all rings) so the client can
			 * fill it. Replaces the tile-based FILL_RECT / CHUNK_OF_BLOCKS rendering path.
			 */
			SET_PLAYER_TERRITORY: 25,
		};
	}

	static get ReceiveAction() {
		return {
			/**
			 * The client changed their desired heading (freeform movement). Payload is a single
			 * Uint16 mapping [0, 65536) to [0, 2π). The server owns position; it only steers
			 * the heading towards this target, so this is purely an input request.
			 */
			UPDATE_MY_HEADING: 1,
			/**
			 * Sets the name of the player that will be created.
			 * If this is sent after the player has been created, the message is ignored.
			 */
			SET_USERNAME: 2,
			/**
			 * Sets the skin of the connected client.
			 * This message is ignored when it is sent after the `READY` message.
			 */
			SKIN: 3,
			/**
			 * Lets the server know that the player is ready to join the game.
			 */
			READY: 4,
			REQUEST_CLOSE: 5,
			/**
			 * The player honked.
			 */
			HONK: 6,
			PING: 7,
			/**
			 * The client wants to know about the state of the trail as it currently exists according to the server.
			 */
			REQUEST_MY_TRAIL: 8,
			MY_TEAM_URL: 9,
			SET_TEAM_USERNAME: 10,
			/**
			 * Sends the version of the client to the server.
			 */
			VERSION: 11,
			/**
			 * @deprecated
			 */
			PATREON_CODE: 12,
			PROTOCOL_VERSION: 13,
			/**
			 * A peli sdk auth code which is used to determine which skins a player is allowed to use.
			 */
			PELI_AUTH_CODE: 14,
			/**
			 * Lets the server know if the player is using spectator mode.
			 */
			SPECTATOR_MODE: 15,
		};
	}

	#lastPingTime = performance.now();

	/** @type {import("./gameplay/Player.js").SkinData?} */
	#receivedSkinData = null;
	#receivedName = "";
	#receivedSpectatorMode = false;

	/** @type {number?} */
	#protocolVersion = null;
	get protocolVersion() {
		return this.#protocolVersion || 0;
	}

	#plusSkinsAllowed = false;
	set plusSkinsAllowed(value) {
		this.#plusSkinsAllowed = value;
		if (this.#game && this.#player) {
			this.#game.broadcastPlayerColor(this.#player);

			// The color of other players is adjusted to prevent other players from rendering with the same color as us.
			// This means that if our own color changes, there's a chance that the color of other players changed as well.
			// So we need to resend the player colors of all other players as well.
			this.#player.updateNearbyPlayerSkinColors();
		}
	}

	get plusSkinsAllowed() {
		return this.#plusSkinsAllowed;
	}

	/**
	 * @param {ArrayBuffer} data
	 */
	#parseBinaryStringMessage(data) {
		const maxNameByteLength = VALID_PLAYER_NAME_LENGTH * 4; // Unicode characters take up a max of 4 bytes
		const maxByteLength = maxNameByteLength + 1; // The first byte is the message type
		if (data.byteLength > maxByteLength) return null;
		const decoder = new TextDecoder();
		const bytes = new Uint8Array(data, 1);
		return decoder.decode(bytes).slice(0, VALID_PLAYER_NAME_LENGTH);
	}

	/**
	 * @param {string} data
	 */
	async onStringMessage(data) {
		if (this.#player) return;

		const parsed = JSON.parse(data);

		if (this.#controlSocket) {
			this.#controlSocket.onMessage(parsed);
		} else if (parsed == initializeControlSocketMessage) {
			this.#controlSocket = new ControlSocketConnection(this);
		}
	}

	/**
	 * @param {ArrayBuffer} data
	 */
	async onMessage(data) {
		if (this.#controlSocket) return;

		const view = new DataView(data);
		const messageType = view.getUint8(0);

		if (messageType == WebSocketConnection.ReceiveAction.PROTOCOL_VERSION) {
			if (this.#protocolVersion != null) {
				throw new Error("Protocol version can only be specified once");
			}
			const version = view.getUint16(1);
			this.#protocolVersion = version;
		} else if (messageType == WebSocketConnection.ReceiveAction.READY) {
			if (this.#protocolVersion == null) {
				this.#protocolVersion = 0;
			}
			if (this.#player) return;
			this.#player = this.#game.createPlayer(this, {
				skin: this.#receivedSkinData,
				name: this.#receivedName,
				isSpectator: this.#receivedSpectatorMode,
			});
			// Clients only really expect a single number, so we'll just take the maximum size of the map.
			const mapSize = Math.max(this.#game.arenaWidth, this.#game.arenaHeight);
			this.#sendMapSize(mapSize);
			for (const message of this.#game.getMinimapMessages()) {
				this.send(message);
			}
			const leaderboard = this.#game.lastLeaderboardMessage;
			if (leaderboard) {
				this.send(leaderboard);
			}
			this.#sendReady();
		} else if (messageType == WebSocketConnection.ReceiveAction.PING) {
			this.#lastPingTime = performance.now();
			this.#sendPong();
		} else if (messageType == WebSocketConnection.ReceiveAction.UPDATE_MY_HEADING) {
			if (view.byteLength < 3) return;
			if (!this.#player) return;
			const rawHeading = view.getUint16(1, false);
			const heading = (rawHeading / 65536) * TAU;
			this.#player.clientHeadingUpdateRequested(heading);
		} else if (messageType == WebSocketConnection.ReceiveAction.SKIN) {
			if (this.#player) return;
			if (view.byteLength != 3) return;
			let cursor = 1;
			let colorId = view.getUint8(cursor);
			cursor++;
			let patternId = view.getUint8(cursor);
			cursor++;
			colorId = clamp(colorId, 0, VALID_SKIN_COLOR_RANGE);
			patternId = clamp(patternId, 0, VALID_SKIN_PATTERN_RANGE);
			this.#receivedSkinData = {
				colorId,
				patternId,
			};
		} else if (messageType == WebSocketConnection.ReceiveAction.SET_USERNAME) {
			if (this.#player) return;
			const name = this.#parseBinaryStringMessage(data);
			if (name) this.#receivedName = name;
		} else if (messageType == WebSocketConnection.ReceiveAction.HONK) {
			if (!this.#player || this.#player.isSpectator) return;
			if (view.byteLength != 2) return;
			let honkDuration = view.getUint8(1);
			honkDuration = Math.max(honkDuration, 70);
			this.#player.honk(honkDuration);
		} else if (messageType == WebSocketConnection.ReceiveAction.PELI_AUTH_CODE) {
			const code = this.#parseBinaryStringMessage(data);
			if (!code) return;
			const { hooks } = this.#mainInstance;
			if (!hooks) return;
			hooks.peliAuthCodeReceived(this, code);
		} else if (messageType == WebSocketConnection.ReceiveAction.SPECTATOR_MODE) {
			if (this.#player) return;
			if (view.byteLength != 2) return;
			this.#receivedSpectatorMode = view.getUint8(1) == 1;
		}
	}

	/**
	 * @param {string | ArrayBufferLike | Blob | ArrayBufferView} data
	 */
	send(data) {
		try {
			this.#socket.send(data);
		} catch (e) {
			if (e instanceof DOMException && e.name == "InvalidStateError") {
				return;
			}
			console.error("An error occurred while trying to send a message", data, e);
			if (e instanceof Error) {
				console.error(e.stack);
			}
		}
	}

	#sendReady() {
		this.send(new Uint8Array([WebSocketConnection.SendAction.READY]));
	}

	#sendPong() {
		this.send(new Uint8Array([WebSocketConnection.SendAction.PONG]));
	}

	/**
	 * @param {number} mapSize
	 */
	#sendMapSize(mapSize) {
		const buffer = new ArrayBuffer(3);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.MAP_SIZE);
		cursor++;

		view.setUint16(cursor, mapSize, false);
		cursor += 2;

		this.send(buffer);
	}

	/**
	 * Sends the continuous position and heading of a player.
	 * Position is sent as fixed-point Uint32 (tile units * POSITION_NETWORK_SCALE) so the client
	 * gets sub-tile precision; heading is a Uint16 mapping [0, 65536) to [0, 2π).
	 *
	 * @param {number} x Position x in tile units (float).
	 * @param {number} y Position y in tile units (float).
	 * @param {number} playerId
	 * @param {number} heading Heading in radians.
	 */
	sendPlayerState(x, y, playerId, heading) {
		const buffer = new ArrayBuffer(13);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_STATE);
		cursor++;
		view.setUint32(cursor, Math.max(0, Math.round(x * POSITION_NETWORK_SCALE)), false);
		cursor += 4;
		view.setUint32(cursor, Math.max(0, Math.round(y * POSITION_NETWORK_SCALE)), false);
		cursor += 4;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		const normalizedHeading = ((heading % TAU) + TAU) % TAU;
		view.setUint16(cursor, Math.round((normalizedHeading / TAU) * 65536) & 0xFFFF, false);
		cursor += 2;

		this.send(buffer);
	}

	/**
	 * @param {number} playerId
	 * @param {number} colorId
	 */
	sendPlayerSkin(playerId, colorId) {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_SKIN);
		cursor++;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		view.setUint8(cursor, serverToClientColorId(colorId));
		cursor++;
		this.send(buffer);
	}

	/**
	 * @param {number} playerId
	 * @param {string} playerName
	 */
	sendPlayerName(playerId, playerName) {
		const encoder = new TextEncoder();
		const nameBytes = encoder.encode(playerName);
		const buffer = new ArrayBuffer(3 + nameBytes.byteLength);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_NAME);
		cursor++;

		view.setUint16(cursor, playerId);
		cursor += 2;

		const intView = new Uint8Array(buffer);
		intView.set(nameBytes, cursor);

		this.send(buffer);
	}

	/**
	 * @param {number} playerId
	 */
	sendPlayerIsSpectator(playerId) {
		const buffer = new ArrayBuffer(3);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_IS_SPECTATOR);
		cursor++;

		view.setUint16(cursor, playerId, false);
		cursor += 2;
		this.send(buffer);
	}

	/**
	 * Notifies the client that they can stop rendering a player and remove it from their memory.
	 * @param {number} playerId
	 */
	sendRemovePlayer(playerId) {
		const buffer = new ArrayBuffer(3);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.REMOVE_PLAYER);
		cursor++;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		this.send(buffer);
	}

	/**
	 * Encodes a player's polygon territory. All rings (outer rings and holes) are sent flat; the
	 * client fills them with the even-odd rule so holes render correctly regardless of winding.
	 * Territory is stored in sub-units (tile * TERRITORY_SUBUNIT_SCALE = 1024); coordinates are
	 * converted to the same tile*256 fixed-point used by positions (sub-unit / 4) and sent as u32.
	 *
	 * Layout: [type, playerId:u16, ringCount:u16, (vertCount:u16, (x:u32, y:u32) * vertCount) * ringCount]
	 * @param {number} playerId
	 * @param {number[][][][] | undefined} multiPolygon
	 */
	static createTerritoryMessage(playerId, multiPolygon) {
		/** @type {number[][][]} */
		const rings = [];
		if (multiPolygon) {
			const simplified = simplifyMultiPolygon(multiPolygon, TERRITORY_NETWORK_SIMPLIFY_EPS);
			for (const poly of simplified) {
				for (const ring of poly) rings.push(ring);
			}
		}

		let size = 5;
		for (const ring of rings) size += 2 + ring.length * 8;
		const buffer = new ArrayBuffer(size);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.SET_PLAYER_TERRITORY);
		cursor++;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		view.setUint16(cursor, rings.length, false);
		cursor += 2;
		for (const ring of rings) {
			view.setUint16(cursor, ring.length, false);
			cursor += 2;
			for (const point of ring) {
				view.setUint32(cursor, Math.max(0, Math.round(point[0] / 4)), false);
				cursor += 4;
				view.setUint32(cursor, Math.max(0, Math.round(point[1] / 4)), false);
				cursor += 4;
			}
		}
		return buffer;
	}

	/**
	 * Encodes a player's continuous trail (the path they've drawn since leaving their territory) so
	 * the client can render it directly instead of deriving it. Points are tile-unit positions sent
	 * as tile*256 fixed-point u32, matching PLAYER_STATE.
	 *
	 * Layout: [type, playerId:u16, pointCount:u16, (x:u32, y:u32) * pointCount]
	 * @param {number} playerId
	 * @param {{x: number, y: number}[]} points
	 */
	static createFreeformTrailMessage(playerId, points) {
		const buffer = new ArrayBuffer(5 + points.length * 8);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.SET_PLAYER_TRAIL);
		cursor++;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		view.setUint16(cursor, points.length, false);
		cursor += 2;
		for (const point of points) {
			view.setUint32(cursor, Math.max(0, Math.round(point.x * POSITION_NETWORK_SCALE)), false);
			cursor += 4;
			view.setUint32(cursor, Math.max(0, Math.round(point.y * POSITION_NETWORK_SCALE)), false);
			cursor += 4;
		}
		return buffer;
	}

	/**
	 * Maps a death type to the integer the client decodes. Shared by GAME_OVER and PLAYER_DIE.
	 * @param {import("./gameplay/Player.js").DeathType?} deathType
	 * @returns {number}
	 */
	static deathTypeToInt(deathType) {
		if (deathType == "player") return 1;
		if (deathType == "arena-bounds") return 2;
		if (deathType == "self") return 3;
		if (deathType == "enclosed") return 4;
		return 0;
	}

	/**
	 * @param {number} playerId
	 * @param {Vec2?} position The position where the player died. This is only useful when the player
	 * died while hitting a wall or their own trail. In that case we want to make it clearly visible that this is
	 * what caused the player to die. But when the player is killed by another player, the position
	 * doesn't really matter and we'd rather let the client determine where to render the player's death.
	 * @param {number} [deathTypeInt] The death-type code (see deathTypeToInt), appended as a trailing
	 * byte so the dying client can show the right "game over" screen (e.g. "your island was captured").
	 * @param {number} [killerId] The id of the player who killed this one, appended as a trailing u16
	 * so the dying client can switch the camera to (and name) its killer.
	 */
	static createPlayerDieMessage(playerId, position, deathTypeInt = 0, killerId = 0) {
		const bufferLength = (position ? 7 : 3) + 3;
		const buffer = new ArrayBuffer(bufferLength);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_DIE);
		cursor++;
		view.setUint16(cursor, playerId, false);
		cursor += 2;
		if (position) {
			view.setUint16(cursor, position.x, false);
			cursor += 2;
			view.setUint16(cursor, position.y, false);
			cursor += 2;
		}
		view.setUint8(cursor, deathTypeInt);
		cursor++;
		view.setUint16(cursor, killerId, false);
		cursor += 2;
		return buffer;
	}

	/**
	 * @param {number} hitByPlayerId
	 * @param {number} pointsColorId The color of the rendered '+500' text above the effect.
	 * @param {Vec2} position
	 * @param {boolean} didHitSelf
	 */
	static createHitLineMessage(hitByPlayerId, pointsColorId, position, didHitSelf) {
		const buffer = new ArrayBuffer(9);
		const view = new DataView(buffer);
		let cursor = 0;
		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_HIT_LINE);
		cursor++;
		view.setUint16(cursor, hitByPlayerId, false);
		cursor += 2;
		view.setUint8(cursor, serverToClientColorId(pointsColorId));
		cursor++;
		view.setUint16(cursor, position.x, false);
		cursor += 2;
		view.setUint16(cursor, position.y, false);
		cursor += 2;
		view.setUint8(cursor, didHitSelf ? 1 : 0);
		cursor++;
		return buffer;
	}

	/**
	 * @param {number} playerId
	 * @param {number} honkDuration
	 */
	static createHonkMessage(playerId, honkDuration) {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.PLAYER_HONK);
		cursor++;

		view.setUint16(cursor, playerId, false);
		cursor += 2;

		view.setUint8(cursor, honkDuration);
		cursor++;

		return buffer;
	}

	/**
	 * @param {number} partId
	 * @param {ArrayBuffer} minimapData
	 */
	static createMinimapMessage(partId, minimapData) {
		const buffer = new ArrayBuffer(2 + minimapData.byteLength);
		const view = new Uint8Array(buffer);
		const minmapView = new Uint8Array(minimapData);

		view[0] = WebSocketConnection.SendAction.MINIMAP;
		view[1] = partId;

		view.set(minmapView, 2);
		return buffer;
	}

	/**
	 * @param {number} scoreTiles The amount of tiles the player had captured when they died.
	 * @param {number} scoreKills The amount of kills the player had, including possibly killing themselve.
	 * @param {number} highestRank The highest rank that was ever reached during this game.
	 * @param {number} timeAliveSeconds How many seconds the player was alive.
	 * @param {number} rankingFirstSeconds How many seconds the player was ranked as number one.
	 * @param {import("./gameplay/Player.js").DeathType} deathType
	 * @param {string} killedByName The other player that killed this player, or an empty string if death type is not "player".
	 */
	sendGameOver(scoreTiles, scoreKills, highestRank, timeAliveSeconds, rankingFirstSeconds, deathType, killedByName) {
		const encoder = new TextEncoder();
		const killedByNameBytes = encoder.encode(killedByName);

		const buffer = new ArrayBuffer(18 + killedByNameBytes.byteLength);
		const view = new DataView(buffer);
		const intView = new Uint8Array(buffer);

		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.GAME_OVER);
		cursor++;

		view.setUint32(cursor, scoreTiles, false);
		cursor += 4;

		view.setUint16(cursor, scoreKills, false);
		cursor += 2;

		view.setUint16(cursor, highestRank, false);
		cursor += 2;

		view.setUint32(cursor, timeAliveSeconds, false);
		cursor += 4;

		view.setUint32(cursor, rankingFirstSeconds, false);
		cursor += 4;

		view.setUint8(cursor, WebSocketConnection.deathTypeToInt(deathType));
		cursor++;

		intView.set(killedByNameBytes, cursor);
		cursor += killedByNameBytes.byteLength;

		this.send(buffer);
	}

	/**
	 * @param {number} capturedTiles
	 * @param {number} kills
	 */
	sendMyScore(capturedTiles, kills) {
		const buffer = new ArrayBuffer(7);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.MY_SCORE);
		cursor++;

		view.setUint32(cursor, capturedTiles, false);
		cursor += 4;

		view.setUint16(cursor, kills, false);
		cursor += 2;

		this.send(buffer);
	}

	/**
	 * @param {number} rank
	 */
	sendMyRank(rank) {
		const buffer = new ArrayBuffer(3);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.MY_RANK);
		cursor++;

		view.setUint16(cursor, rank, false);
		cursor += 2;

		this.send(buffer);
	}

	/**
	 * @param {[name: string, score: number][]} scores
	 * @param {number} totalPlayers
	 */
	static createLeaderboardMessage(scores, totalPlayers) {
		const encoder = new TextEncoder();
		const encodedScores = scores.map((scoreData) => {
			const [name, score] = scoreData;
			const nameBytes = encoder.encode(name);
			const scoreBytes = new Uint8Array(4);
			const view = new DataView(scoreBytes.buffer);
			view.setUint32(0, score);
			return [scoreBytes, new Uint8Array([nameBytes.byteLength]), nameBytes];
		});

		let scoreBoardLength = 0;
		for (const scoreData of encodedScores) {
			for (const byteArray of scoreData) {
				scoreBoardLength += byteArray.length;
			}
		}

		const buffer = new ArrayBuffer(3 + scoreBoardLength);
		const intView = new Uint8Array(buffer);
		const view = new DataView(buffer);
		let cursor = 0;

		view.setUint8(cursor, WebSocketConnection.SendAction.LEADERBOARD);
		cursor++;

		view.setUint16(cursor, totalPlayers, false);
		cursor += 2;

		for (const scoreData of encodedScores) {
			for (const byteArray of scoreData) {
				intView.set(byteArray, cursor);
				cursor += byteArray.byteLength;
			}
		}

		return buffer;
	}

	/**
	 * Forcefully closes the connection.
	 * This fires onClose as well.
	 */
	close() {
		this.#socket.close();
	}

	onClose() {
		if (this.#player) {
			this.#game.removePlayer(this.#player);
		}
	}

	/**
	 * @param {number} now
	 * @param {number} dt
	 */
	loop(now, dt) {
		if (now - this.#lastPingTime > 1000 * 60 * 5) {
			this.close();
		}
	}
}
