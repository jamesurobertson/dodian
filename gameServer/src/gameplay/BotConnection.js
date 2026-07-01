/**
 * A stand-in for WebSocketConnection used by AI bots. Bots are real Players in the game, but they
 * have no socket, so every outgoing message is a no-op. It implements just the surface that Player
 * and Game call on a connection.
 */
export class BotConnection {
	/** Lets the game distinguish bots from real players (see Game.humanPlayerCount). */
	get isBot() {
		return true;
	}
	get protocolVersion() {
		return 1;
	}
	get plusSkinsAllowed() {
		return false;
	}
	send() {}
	sendPlayerState() {}
	sendPlayerSkin() {}
	sendPlayerName() {}
	sendPlayerIsSpectator() {}
	sendRemovePlayer() {}
	sendMyScore() {}
	sendMyRank() {}
	sendGameOver() {}
	close() {}
}
