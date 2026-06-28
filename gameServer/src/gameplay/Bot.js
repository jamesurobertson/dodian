const TAU = Math.PI * 2;

/**
 * Drives a single AI player. Behaviour: venture out of its own territory on a drifting heading for
 * a while, then head back home to close the loop and capture the enclosed area — repeat. Steers away
 * from the world border so it doesn't get stuck against a wall.
 */
export class Bot {
	#player;
	#game;
	#home;
	#goalHeading;
	/** @type {"venture" | "return"} */
	#mode = "venture";
	#until;

	/**
	 * @param {import("./Player.js").Player} player
	 * @param {import("./Game.js").Game} game
	 */
	constructor(player, game) {
		this.#player = player;
		this.#game = game;
		this.#home = player.getPosition();
		this.#goalHeading = player.heading;
		this.#until = performance.now() + 1500 + Math.random() * 2500;
	}

	get player() {
		return this.#player;
	}

	/**
	 * @param {number} now
	 */
	#startVenture(now) {
		this.#mode = "venture";
		this.#goalHeading = Math.random() * TAU;
		this.#until = now + 1500 + Math.random() * 3000;
	}

	/**
	 * @param {number} now
	 */
	tick(now) {
		const p = this.#player;
		if (p.dead) return;
		const pos = p.getPosition();
		const w = this.#game.arenaWidth;
		const h = this.#game.arenaHeight;
		const margin = 14;

		let target;
		if (pos.x < margin || pos.x > w - margin || pos.y < margin || pos.y > h - margin) {
			// Too close to a wall — steer back towards the centre and start a fresh venture.
			target = Math.atan2(h / 2 - pos.y, w / 2 - pos.x);
			this.#goalHeading = target;
			this.#mode = "venture";
			this.#until = now + 1800;
		} else if (this.#mode === "return") {
			target = Math.atan2(this.#home.y - pos.y, this.#home.x - pos.x);
			if (this.#game.territory.isInside(p.id, pos.x, pos.y)) {
				// Back inside our land: the loop closed and captured — head out again.
				this.#startVenture(now);
				target = this.#goalHeading;
			}
		} else {
			// Venturing: drift the heading a little so the trail loop encloses some area.
			this.#goalHeading += (Math.random() - 0.5) * 0.25;
			target = this.#goalHeading;
			if (now > this.#until) this.#mode = "return";
		}

		p.clientHeadingUpdateRequested(target);
	}
}
