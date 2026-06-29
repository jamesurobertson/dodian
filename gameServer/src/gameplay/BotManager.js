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
	 * @param {number} count
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

		// Top the population back up.
		while (this.#bots.size < this.#count) {
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
