/**
 * Multiplayer smoke test (throwaway): two bots on a small arena should appear in each other's
 * viewport — each receives the other's PLAYER_STATE and SET_PLAYER_TERRITORY — with no crashes.
 * Connections are staggered because the server briefly rate-limits repeat connections per IP.
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9998 -s 24
 *   deno run -A scripts/clippingHarness/m5MultiClient.js 9998
 */

const port = Number(Deno.args[0] || 9998);
const TAU = Math.PI * 2;
const PROTOCOL_VERSION = 13, READY = 4, UPDATE_MY_HEADING = 1, PLAYER_STATE = 2, SET_PLAYER_TERRITORY = 25, RDY = 17;

function bot(label, delayMs) {
	const state = { label, sawOtherState: false, sawOtherTerritory: false, states: 0, ready: false, msgs: 0 };
	/** @type {WebSocket} */
	let ws;

	function sendHeading(h) {
		if (!ws || ws.readyState !== 1) return;
		const buf = new ArrayBuffer(3), v = new DataView(buf);
		v.setUint8(0, UPDATE_MY_HEADING);
		v.setUint16(1, Math.round((((h % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff, false);
		ws.send(buf);
	}

	setTimeout(() => {
		ws = new WebSocket(`ws://127.0.0.1:${port}/`);
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => {
			const pv = new ArrayBuffer(3);
			new DataView(pv).setUint8(0, PROTOCOL_VERSION);
			new DataView(pv).setUint16(1, 1, false);
			ws.send(pv);
			ws.send(new Uint8Array([READY]).buffer);
			let h = label === "A" ? 0 : Math.PI;
			setInterval(() => { h += 0.4; sendHeading(h); }, 250);
		});
		ws.addEventListener("message", (e) => {
			if (!(e.data instanceof ArrayBuffer)) return;
			const v = new DataView(e.data);
			const t = v.getUint8(0);
			state.msgs++;
			if (t === RDY) state.ready = true;
			if (t === PLAYER_STATE) {
				state.states++;
				if (v.getUint16(9, false) !== 0) state.sawOtherState = true;
			} else if (t === SET_PLAYER_TERRITORY && v.getUint16(1, false) !== 0) state.sawOtherTerritory = true;
		});
	}, delayMs);

	return { state, close: () => ws && ws.close() };
}

const a = bot("A", 0);
const b = bot("B", 600);

setTimeout(() => {
	a.close();
	b.close();
	console.log("A:", JSON.stringify(a.state));
	console.log("B:", JSON.stringify(b.state));
	const ok = a.state.sawOtherState && a.state.sawOtherTerritory && b.state.sawOtherState && b.state.sawOtherTerritory;
	if (ok) {
		console.log("PASS: both bots see each other's state and territory.");
		Deno.exit(0);
	}
	console.error("FAIL: bots did not observe each other.");
	Deno.exit(1);
}, 8000);
