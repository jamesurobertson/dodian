/**
 * Border-slide verification (throwaway): drive straight into a wall and hold the heading.
 * The player should clamp to the border and NOT die.
 *
 *   deno run -A gameServer/src/mainInstance.js -p 9998 -s 50
 *   deno run -A scripts/clippingHarness/m5BorderClient.js 9998
 */

const port = Number(Deno.args[0] || 9998);
const TAU = Math.PI * 2;
const PROTOCOL_VERSION = 13, READY = 4, UPDATE_MY_HEADING = 1, PLAYER_STATE = 2, PLAYER_DIE = 5, MAP_SIZE = 12;

let died = false, lastX = 0, lastY = 0, mapSize = 50;

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
ws.binaryType = "arraybuffer";
function sendHeading(h) {
	const buf = new ArrayBuffer(3), v = new DataView(buf);
	v.setUint8(0, UPDATE_MY_HEADING);
	v.setUint16(1, Math.round((((h % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff, false);
	ws.send(buf);
}
ws.addEventListener("open", () => {
	const pv = new ArrayBuffer(3);
	new DataView(pv).setUint8(0, PROTOCOL_VERSION);
	new DataView(pv).setUint16(1, 1, false);
	ws.send(pv);
	ws.send(new Uint8Array([READY]).buffer);
	// Hold heading +x: cross the arena and jam straight into the right wall.
	setInterval(() => sendHeading(0), 60);
});
ws.addEventListener("message", (e) => {
	if (!(e.data instanceof ArrayBuffer)) return;
	const v = new DataView(e.data);
	const t = v.getUint8(0);
	if (t === PLAYER_STATE && v.getUint16(9, false) === 0) {
		lastX = v.getUint32(1, false) / 256;
		lastY = v.getUint32(5, false) / 256;
	} else if (t === MAP_SIZE) mapSize = v.getUint16(1, false);
	else if (t === PLAYER_DIE && v.getUint16(1, false) === 0) died = true;
});

setTimeout(() => {
	ws.close();
	const atWall = lastX >= mapSize - 2;
	console.log(`finalX=${lastX.toFixed(1)} mapSize=${mapSize} atWall=${atWall} died=${died}`);
	if (died) {
		console.error("FAIL: player died while pinned against the border.");
		Deno.exit(1);
	}
	if (!atWall) {
		console.error("FAIL: player never reached the wall (test inconclusive).");
		Deno.exit(1);
	}
	console.log("PASS: player slid to the border and survived holding into it.");
	Deno.exit(0);
}, 12000);
