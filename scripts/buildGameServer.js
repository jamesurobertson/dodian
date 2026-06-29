import { resolve } from "$std/path/mod.ts";
import { buildExecutable } from "../shared/buildExecutable.js";
import { setCwd } from "chdir-anywhere";
setCwd();
Deno.chdir("..");

await buildExecutable({
	outputDir: resolve("gameServer/out"),
	outputFileName: "dodianGameServer",
	entryPoint: resolve("gameServer/src/mainInstance.js"),
	permissionFlags: [
		"--allow-net",
		"--allow-read",
	],
	include: [
		resolve("gameServer/src/gameplay/arenaWorker/mod.js"),
	],
});
