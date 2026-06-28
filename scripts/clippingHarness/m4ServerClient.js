/**
 * M4 server-side verification (throwaway): confirms SET_PLAYER_TERRITORY streams and that the
 * decoded polygon area matches the area-based score after a capture.
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9999 -s 200
 *   deno run -A scripts/clippingHarness/m4ServerClient.js 9999
 */

const port = Number(Deno.args[0] || 9999);
const TAU = Math.PI * 2;

const PROTOCOL_VERSION = 13;
const READY = 4;
const UPDATE_MY_HEADING = 1;
const PLAYER_STATE = 2;
const MY_SCORE = 9;
const SET_PLAYER_TERRITORY = 25;

let latestScore = null;
let startedExcursion = false;
let lastTerritoryArea = 0;
let lastRingCount = 0;
let lastVerts = 0;

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";

function sendHeading(h) {
	const raw = Math.round(((((h % TAU) + TAU) % TAU) / TAU) * 65536) & 0xffff;
	const buf = new ArrayBuffer(3);
	const view = new DataView(buf);
	view.setUint8(0, UPDATE_MY_HEADING);
	view.setUint16(1, raw, false);
	ws.send(buf);
}

function decodeTerritoryArea(view) {
	// [type, playerId:u16, ringCount:u16, (vertCount:u16, (x:u32,y:u32)*vertCount)*ringCount]
	const ringCount = view.getUint16(3, false);
	let cursor = 5;
	let area2 = 0;
	let totalVerts = 0;
	for (let r = 0; r < ringCount; r++) {
		const vc = view.getUint16(cursor, false);
		totalVerts += vc;
		cursor += 2;
		const pts = [];
		for (let i = 0; i < vc; i++) {
			const x = view.getUint32(cursor, false) / 256;
			cursor += 4;
			const y = view.getUint32(cursor, false) / 256;
			cursor += 4;
			pts.push([x, y]);
		}
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i], b = pts[(i + 1) % pts.length];
			area2 += a[0] * b[1] - b[0] * a[1];
		}
	}
	return { ringCount, area: Math.abs(area2) / 2, verts: totalVerts };
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
	} else if (type == SET_PLAYER_TERRITORY) {
		if (view.getUint16(1, false) != 0) return; // self only
		const { ringCount, area, verts } = decodeTerritoryArea(view);
		lastTerritoryArea = area;
		lastRingCount = ringCount;
		lastVerts = verts;
	} else if (type == PLAYER_STATE) {
		if (view.getUint16(9, false) != 0) return;
		if (!startedExcursion) {
			startedExcursion = true;
			const h0 = (view.getUint16(11, false) / 65536) * TAU;
			const turn = (2 * Math.PI) / 3;
			sendHeading(h0);
			setTimeout(() => sendHeading(h0 + turn), 850);
			setTimeout(() => sendHeading(h0 + 2 * turn), 1700);
			setTimeout(finish, 850 * 3 + 1200);
		}
	}
});

ws.addEventListener("error", (e) => {
	console.error("WS error:", e.message || e);
	Deno.exit(1);
});

function finish() {
	ws.close();
	console.log(
		`score=${latestScore} territoryRings=${lastRingCount} verts=${lastVerts} territoryArea=${lastTerritoryArea.toFixed(1)}`,
	);
	if (lastRingCount < 1) {
		console.error("FAIL: no territory rings received.");
		Deno.exit(1);
	}
	// The decoded polygon area should be close to the area-based score (within rounding/quantization).
	if (latestScore != null && Math.abs(lastTerritoryArea - latestScore) <= Math.max(5, latestScore * 0.15)) {
		console.log("PASS: streamed territory polygon area matches the score.");
		Deno.exit(0);
	}
	console.error(`FAIL: territory area ${lastTerritoryArea} far from score ${latestScore}.`);
	Deno.exit(1);
}
