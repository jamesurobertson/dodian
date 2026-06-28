/**
 * Bot verification (throwaway): connect one observer and confirm the server's AI bots are present
 * and roaming (multiple non-zero players, each moving a meaningful distance), with territory.
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9998 -s 80 --bots 6
 *   deno run -A scripts/clippingHarness/m6BotsClient.js 9998
 */

const port = Number(Deno.args[0] || 9998);
const PROTOCOL_VERSION = 13, READY = 4, PLAYER_STATE = 2, SET_PLAYER_TERRITORY = 25, SET_PLAYER_TRAIL = 4;
let trailMsgs = 0, trailWithPoints = 0;

/** @type {Record<number, {fx:number, fy:number, moved:number, lx:number, ly:number}>} */
const others = {};
const territoriesSeen = new Set();

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";
ws.addEventListener("open", () => {
	const pv = new ArrayBuffer(3);
	new DataView(pv).setUint8(0, PROTOCOL_VERSION);
	new DataView(pv).setUint16(1, 1, false);
	ws.send(pv);
	ws.send(new Uint8Array([READY]).buffer);
});
ws.addEventListener("message", (e) => {
	if (!(e.data instanceof ArrayBuffer)) return;
	const v = new DataView(e.data);
	const t = v.getUint8(0);
	if (t === PLAYER_STATE) {
		const id = v.getUint16(9, false);
		if (id === 0) return;
		const x = v.getUint32(1, false) / 256, y = v.getUint32(5, false) / 256;
		const o = others[id];
		if (!o) others[id] = { fx: x, fy: y, lx: x, ly: y, moved: 0 };
		else {
			o.moved += Math.hypot(x - o.lx, y - o.ly);
			o.lx = x;
			o.ly = y;
		}
	} else if (t === SET_PLAYER_TERRITORY) {
		const pid = v.getUint16(1, false);
		if (pid !== 0 && v.getUint16(3, false) > 0) territoriesSeen.add(pid);
	} else if (t === SET_PLAYER_TRAIL) {
		trailMsgs++;
		if (v.getUint16(3, false) > 0) trailWithPoints++;
	}
});
ws.addEventListener("error", (e) => {
	console.error("WS error:", e.message || e);
	Deno.exit(1);
});

setTimeout(() => {
	ws.close();
	const ids = Object.keys(others);
	const maxMoved = ids.reduce((m, id) => Math.max(m, others[+id].moved), 0);
	const roaming = ids.filter((id) => others[+id].moved > 4).length;
	console.log(
		`bots seen=${ids.length} roaming(>4 tiles)=${roaming} maxMoved=${
			maxMoved.toFixed(1)
		} withTerritory=${territoriesSeen.size} trailMsgs=${trailMsgs} (withPoints=${trailWithPoints})`,
	);
	if (ids.length >= 3 && roaming >= 3) {
		console.log("PASS: bots are present and roaming.");
		Deno.exit(0);
	}
	console.error("FAIL: not enough roaming bots observed.");
	Deno.exit(1);
}, 7000);
