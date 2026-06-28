/**
 * M1 headless verification client (throwaway).
 *
 * Start a game server first:
 *   deno run -A gameServer/src/mainInstance.js -p 9999 -s 100
 * Then run:
 *   deno run -A scripts/clippingHarness/m1Client.js 9999
 *
 * It performs the protocol handshake, decodes the new PLAYER_STATE (fixed-point position +
 * heading), confirms the server moves the player continuously, then sends a heading and
 * confirms the player's travel direction follows it.
 */

const port = Number(Deno.args[0] || 9999);
const TAU = Math.PI * 2;
const SCALE = 256; // must match POSITION_NETWORK_SCALE

const PROTOCOL_VERSION = 13;
const READY = 4;
const UPDATE_MY_HEADING = 1;
const PLAYER_STATE = 2;

/** @type {{t: number, x: number, y: number, heading: number}[]} */
const samples = [];

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";

function send(bytes) {
	ws.send(new Uint8Array(bytes).buffer);
}
function sendHeading(heading) {
	const raw = Math.round((heading / TAU) * 65536) & 0xffff;
	const buf = new ArrayBuffer(3);
	const view = new DataView(buf);
	view.setUint8(0, UPDATE_MY_HEADING);
	view.setUint16(1, raw, false);
	ws.send(buf);
}

ws.addEventListener("open", () => {
	// protocol version 1
	const pv = new ArrayBuffer(3);
	const pvView = new DataView(pv);
	pvView.setUint8(0, PROTOCOL_VERSION);
	pvView.setUint16(1, 1, false);
	ws.send(pv);
	// ready -> creates the player
	send([READY]);
});

ws.addEventListener("message", (e) => {
	if (!(e.data instanceof ArrayBuffer)) return;
	const view = new DataView(e.data);
	const type = view.getUint8(0);
	if (type == PLAYER_STATE) {
		const playerId = view.getUint16(9, false);
		if (playerId != 0) return; // only our own player
		const x = view.getUint32(1, false) / SCALE;
		const y = view.getUint32(5, false) / SCALE;
		const heading = (view.getUint16(11, false) / 65536) * TAU;
		samples.push({ t: performance.now(), x, y, heading });
	}
});

ws.addEventListener("error", (e) => {
	console.error("WS error:", e.message || e);
	Deno.exit(1);
});

// Phase A: observe free movement for 1s. Phase B: command heading 0 (+x) and observe.
setTimeout(() => sendHeading(0), 1000);

setTimeout(() => {
	ws.close();
	if (samples.length < 5) {
		console.error(`FAIL: only ${samples.length} PLAYER_STATE samples received`);
		Deno.exit(1);
	}
	const first = samples[0];
	const mid = samples[Math.floor(samples.length / 2)];
	const last = samples[samples.length - 1];

	// total distance travelled
	let dist = 0;
	for (let i = 1; i < samples.length; i++) {
		dist += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
	}

	// After commanding heading 0 (+x), the last leg should move mostly in +x.
	const legDx = last.x - mid.x;
	const legDy = last.y - mid.y;

	console.log(`samples=${samples.length}`);
	console.log(`first=(${first.x.toFixed(2)}, ${first.y.toFixed(2)}) heading=${first.heading.toFixed(2)}`);
	console.log(`last =(${last.x.toFixed(2)}, ${last.y.toFixed(2)}) heading=${last.heading.toFixed(2)}`);
	console.log(`total path length=${dist.toFixed(2)} tiles`);
	console.log(`final leg after heading->0: dx=${legDx.toFixed(2)} dy=${legDy.toFixed(2)}`);

	const moved = dist > 2; // ~6 tiles/s over ~1.5s, expect well over 2
	const followsHeading = legDx > Math.abs(legDy); // moving mostly +x
	if (moved && followsHeading) {
		console.log("PASS: continuous movement works and follows commanded heading.");
		Deno.exit(0);
	} else {
		console.error(`FAIL: moved=${moved} followsHeading=${followsHeading}`);
		Deno.exit(1);
	}
}, 2000);
