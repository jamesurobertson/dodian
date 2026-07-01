import { Bot } from "./Bot.js";
import { BotConnection } from "./BotConnection.js";
import { FREE_SKIN_COLOR_COUNT } from "../config.js";

const BOT_NAMES = [
	"Pixel",
	"Volt",
	"Nova",
	"Zephyr",
	"Echo",
	"Comet",
	"Drift",
	"Vortex",
	"Blip",
	"Quark",
	"Glyph",
	"Rook",
	"Jinx",
	"Mako",
	"Onyx",
	"Ridge",
	"Slate",
	"Hazel",
	"Cobalt",
	"Flux",
	"Wisp",
	"Dune",
	"Ember",
	"Koi",
];

/**
 * Keeps a fixed number of AI bots alive in a game. Bots are ordinary Players backed by a
 * BotConnection; this ticks their AI each game loop and respawns any that died.
 */
export class BotManager {
	#game;
	#count;
	/** @type {Set<Bot>} */
	#bots = new Set();

	/**
	 * @param {import("./Game.js").Game} game
	 * @param {number} count Target arena population — bots fill up to this, minus the real players
	 * currently in the arena (so bots drop off as humans join and refill as they leave).
	 */
	constructor(game, count) {
		this.#game = game;
		this.#count = count;
	}

	/** Number of bots currently alive in the game. */
	get activeCount() {
		return this.#bots.size;
	}

	/**
	 * @param {number} now
	 */
	tick(now) {
		if (this.#count <= 0) return;

		// Retire bots that have died and remove them from the game.
		for (const bot of this.#bots) {
			if (bot.player.permanentlyDead) {
				this.#game.removePlayer(bot.player);
				this.#bots.delete(bot);
			}
		}

		// `#count` is the target arena population: keep that many players by filling the rest with
		// bots, so bots quietly make room as real players join and refill when they leave.
		const target = Math.max(0, this.#count - this.#game.humanPlayerCount);

		// Drop surplus bots when real players fill the arena.
		if (this.#bots.size > target) {
			for (const bot of this.#bots) {
				if (this.#bots.size <= target) break;
				this.#game.removePlayer(bot.player);
				this.#bots.delete(bot);
			}
		}

		// Top the population back up.
		while (this.#bots.size < target) {
			this.#spawn();
		}

		for (const bot of this.#bots) {
			bot.tick(now);
		}
	}

	#spawn() {
		const connection = new BotConnection();
		// Tagged so new players can tell bots apart from humans.
		const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + " (bot)";
		const skin = { colorId: 1 + Math.floor(Math.random() * FREE_SKIN_COLOR_COUNT), patternId: 0 };
		const player = this.#game.createPlayer(
			/** @type {any} */ (connection),
			{ skin, name, isSpectator: false },
		);
		this.#bots.add(new Bot(player, this.#game));
	}
}
