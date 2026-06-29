import { segmentsIntersect } from "../util/geometry.js";
import { FREEFORM_SELF_COLLISION_GRACE_SEGMENTS } from "../config.js";

const TAU = Math.PI * 2;

// Self-trail avoidance. The bot looks this many tiles ahead along a candidate heading for its own
// older (killable) trail; if blocked it tries these angular offsets (radians, nearest-to-desired
// first) until it finds a clear path. Sized so the bot has room to steer away before its head
// reaches an old segment.
const LOOKAHEAD_TILES = 6;
const AVOID_OFFSETS = [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.35, -1.35, 1.85, -1.85, 2.4, -2.4];

// Aggression: how far (tiles) a bot will spot an enemy's trail, and the trail-length (≈ how far out
// it already is) thresholds that gate aggression vs. caution. Below AGGRO it hunts; past SAFETY it
// always heads home to bank rather than risk getting cut while over-extended.
// Kept well within the player's on-screen radius so bots only lunge at a trail that's right next to
// them, rather than converging from across the view.
const BOT_SIGHT_RANGE = 6;
const BOT_AGGRO_MAX_TRAIL = 200;
const BOT_SAFETY_MAX_TRAIL = 280;
// How much LESS exposed (shorter trail) a bot must be than its quarry before chasing while it's out
// in the open — the margin that makes the chase a clear positional advantage rather than a trade.
const BOT_ADVANTAGE_MARGIN = 40;

/**
 * Drives a single AI player. Behaviour: venture out of its own territory on a drifting heading for
 * a while, then head back home to close the loop and capture the enclosed area — repeat. Steers away
 * from the world border so it doesn't get stuck against a wall, and away from its own trail so it
 * (almost) never cuts itself.
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

		const insideOwn = this.#game.territory.isInside(p.id, pos.x, pos.y);
		const trailLen = p.freeformTrailLength;
		// Aggressive only when we can afford it: safe inside our own land, or not yet over-extended.
		const canHunt = insideOwn || trailLen < BOT_AGGRO_MAX_TRAIL;
		// Positional advantage: from safety we'll cut anyone who's out; while out ourselves we only go
		// after enemies clearly more exposed than us (longer trail), so we're the one who lands the cut.
		const minEnemyTrail = insideOwn ? 1 : trailLen + BOT_ADVANTAGE_MARGIN;
		const enemy = canHunt ? this.#game.findCuttableTrailPointNear(p, BOT_SIGHT_RANGE, minEnemyTrail) : null;

		let target;
		if (pos.x < margin || pos.x > w - margin || pos.y < margin || pos.y > h - margin) {
			// Too close to a wall — steer back towards the centre and start a fresh venture.
			target = Math.atan2(h / 2 - pos.y, w / 2 - pos.x);
			this.#goalHeading = target;
			this.#mode = "venture";
			this.#until = now + 1800;
		} else if (enemy !== null) {
			// Aggressive: chase the enemy line to cut it.
			target = Math.atan2(enemy.y - pos.y, enemy.x - pos.x);
			this.#mode = "venture";
			this.#until = now + 2000; // after the cut (or miss), keep venturing a bit
		} else if (this.#mode === "return" || trailLen > BOT_SAFETY_MAX_TRAIL) {
			// Conservative: bank our progress — head back to our island and close the loop.
			const tb = this.#game.territory.getBoundsTiles(p.id);
			const hx = tb ? (tb.minX + tb.maxX) / 2 : this.#home.x;
			const hy = tb ? (tb.minY + tb.maxY) / 2 : this.#home.y;
			target = Math.atan2(hy - pos.y, hx - pos.x);
			this.#mode = "return";
			if (insideOwn) {
				// Back inside our land: the loop closed and captured — head out again.
				this.#startVenture(now);
				target = this.#goalHeading;
			}
		} else {
			// Venturing: drift the heading gently so the trail loop encloses some area without the
			// erratic swings (the smaller the drift, the less the path doubles back on itself).
			this.#goalHeading += (Math.random() - 0.5) * 0.12;
			target = this.#goalHeading;
			if (now > this.#until) this.#mode = "return";
		}

		// Final safety: never steer the head into the bot's own older trail.
		target = this.#avoidOwnTrail(pos, target);
		this.#goalHeading = target;
		p.clientHeadingUpdateRequested(target);
	}

	/**
	 * Returns a heading near `desired` whose short look-ahead ray doesn't cross the bot's own older
	 * trail — the part that would actually kill it (segments newer than the grace window can't).
	 * Tries `desired` first, then widening offsets to either side; falls back to `desired` if every
	 * candidate is blocked (rare).
	 * @param {{x: number, y: number}} pos
	 * @param {number} desired
	 * @returns {number}
	 */
	#avoidOwnTrail(pos, desired) {
		const ownLen = this.#player.freeformTrailLength;
		// Killable segments have index <= ownLen - 2 - GRACE; need at least one to bother probing.
		const killableMax = ownLen - 2 - FREEFORM_SELF_COLLISION_GRACE_SEGMENTS;
		if (killableMax < 0) return desired;

		// Collect only nearby killable segments (a cheap distance prefilter keeps this bounded even
		// for long trails — far-away segments can't be within the look-ahead reach).
		const reach = LOOKAHEAD_TILES + 2;
		const reach2 = reach * reach;
		const segs = [];
		for (const seg of this.#player.getFreeformTrailSegments()) {
			if (seg.index > killableMax) break; // segments are yielded in index order
			const dax = seg.ax - pos.x, day = seg.ay - pos.y;
			const dbx = seg.bx - pos.x, dby = seg.by - pos.y;
			if (dax * dax + day * day > reach2 && dbx * dbx + dby * dby > reach2) continue;
			segs.push(seg);
		}
		if (segs.length === 0) return desired;

		for (const off of AVOID_OFFSETS) {
			const ang = desired + off;
			const ex = pos.x + Math.cos(ang) * LOOKAHEAD_TILES;
			const ey = pos.y + Math.sin(ang) * LOOKAHEAD_TILES;
			let blocked = false;
			for (const s of segs) {
				if (segmentsIntersect(pos.x, pos.y, ex, ey, s.ax, s.ay, s.bx, s.by)) {
					blocked = true;
					break;
				}
			}
			if (!blocked) return ang;
		}
		return desired;
	}
}
