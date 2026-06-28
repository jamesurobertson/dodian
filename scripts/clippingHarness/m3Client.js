/**
 * M3 headless capture verification (throwaway).
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9999 -s 200
 *   deno run -A scripts/clippingHarness/m3Client.js 9999
 *
 * The bot leaves its spawn territory, traces a rectangular loop outside it (four heading legs),
 * and re-enters. Capture should enclose new area, so the area-based MY_SCORE must increase
 * above the initial spawn area. Also asserts the bot did not die during the excursion.
 */

const port = Number(Deno.args[0] || 9999);
const TAU = Math.PI * 2;

const PROTOCOL_VERSION = 13;
const READY = 4;
const UPDATE_MY_HEADING = 1;
const PLAYER_STATE = 2;
const MY_SCORE = 9;
const PLAYER_DIE = 5;

let initialScore = null;
let latestScore = null;
let died = false;
let startedExcursion = false;

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";

function sendHeading(heading) {
	const raw = Math.round(((((heading % TAU) + TAU) % TAU) / TAU) * 65536) & 0xffff;
	const buf = new ArrayBuffer(3);
	const view = new DataView(buf);
	view.setUint8(0, UPDATE_MY_HEADING);
	view.setUint16(1, raw, false);
	ws.send(buf);
}

ws.addEventListener("open", () => {
	const pv = new ArrayBuffer(3);
	new DataView(pv).setUint8(0, PROTOCOL_VERSION);
	new DataView(pv).setUint16(1, 1, false);
	ws.send(pv);
	ws.send(new Uint8Array([READY]).buffer);
});

ws.addEventListener("message", (e) => {
	if (!(e.data instanceof ArrayBuffer)) return;
	const view = new DataView(e.data);
	const type = view.getUint8(0);
	if (type == MY_SCORE) {
		latestScore = view.getUint32(1, false);
		if (initialScore == null) initialScore = latestScore;
	} else if (type == PLAYER_STATE) {
		if (view.getUint16(9, false) != 0) return;
		if (!startedExcursion) {
			startedExcursion = true;
			const h0 = (view.getUint16(11, false) / 65536) * TAU; // spawn heading points inward
			runExcursion(h0);
		}
	} else if (type == PLAYER_DIE) {
		if (view.getUint16(1, false) == 0) died = true;
	}
});

ws.addEventListener("error", (e) => {
	console.error("WS error:", e.message || e);
	Deno.exit(1);
});

// A triangle loop relative to the spawn heading (which points inward, away from walls):
// leg out at h0, then turn 120deg twice, returning near the start and re-entering territory.
const LEG = 850;
function runExcursion(h0) {
	const turn = (2 * Math.PI) / 3;
	sendHeading(h0);
	setTimeout(() => sendHeading(h0 + turn), LEG);
	setTimeout(() => sendHeading(h0 + 2 * turn), LEG * 2);
	setTimeout(finish, LEG * 3 + 1200);
}

function finish() {
	ws.close();
	console.log(`initialScore=${initialScore} finalScore=${latestScore} died=${died}`);
	if (died) {
		console.error("FAIL: bot died during the excursion.");
		Deno.exit(1);
	}
	if (initialScore == null || latestScore == null) {
		console.error("FAIL: never received a score.");
		Deno.exit(1);
	}
	if (latestScore > initialScore) {
		console.log(`PASS: captured area increased score by ${latestScore - initialScore} tiles.`);
		Deno.exit(0);
	}
	console.error("FAIL: score did not increase (no capture).");
	Deno.exit(1);
}
