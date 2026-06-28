/**
 * M2 headless collision verification (throwaway).
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9999 -s 100
 *   deno run -A scripts/clippingHarness/m2Client.js 9999 straight   # expect SURVIVE
 *   deno run -A scripts/clippingHarness/m2Client.js 9999 circle     # expect SELF-DEATH
 *
 * "straight": drive heading 0 for 3.5s; pass if the player does NOT die (no false self-hit).
 * "circle": continuously steer ahead of the current heading so the player loops tightly;
 *           pass if the player dies from crossing its own trail within 6s.
 */

const port = Number(Deno.args[0] || 9999);
const mode = Deno.args[1] || "circle";
const TAU = Math.PI * 2;

const PROTOCOL_VERSION = 13;
const READY = 4;
const UPDATE_MY_HEADING = 1;
const PLAYER_STATE = 2;
const PLAYER_DIE = 5;

let lastHeading = 0;
let died = false;

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
	if (type == PLAYER_STATE) {
		if (view.getUint16(9, false) != 0) return;
		lastHeading = (view.getUint16(11, false) / 65536) * TAU;
	} else if (type == PLAYER_DIE) {
		if (view.getUint16(1, false) == 0) died = true;
	}
});

ws.addEventListener("error", (e) => {
	console.error("WS error:", e.message || e);
	Deno.exit(1);
});

// Steering loop.
const steer = setInterval(() => {
	if (mode == "straight") {
		sendHeading(0);
	} else {
		// Keep the target well ahead of the current heading so the turn-rate clamp makes
		// the player rotate continuously into a tight circle.
		sendHeading(lastHeading + 2.2);
	}
}, 80);

const deadline = mode == "straight" ? 3500 : 6000;
setTimeout(() => {
	clearInterval(steer);
	ws.close();
	if (mode == "straight") {
		if (!died) {
			console.log("PASS: straight-line player survived (no false self-collision).");
			Deno.exit(0);
		}
		console.error("FAIL: straight-line player died unexpectedly.");
		Deno.exit(1);
	} else {
		if (died) {
			console.log("PASS: circling player died from crossing its own trail.");
			Deno.exit(0);
		}
		console.error("FAIL: circling player never self-collided.");
		Deno.exit(1);
	}
}, deadline);
