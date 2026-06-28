import { assert, assertEquals } from "https://deno.land/std@0.198.0/assert/mod.ts";
import {
	canonicalize,
	multiPolygonArea,
	pointInMultiPolygon,
	pointInRing,
	segmentsIntersect,
	vertexCount,
} from "../src/util/geometry.js";
import { SpatialHash } from "../src/util/SpatialHash.js";

Deno.test("segmentsIntersect: proper crossing", () => {
	assert(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0));
});

Deno.test("segmentsIntersect: disjoint segments", () => {
	assert(!segmentsIntersect(0, 0, 1, 1, 5, 5, 6, 6));
});

Deno.test("segmentsIntersect: parallel non-overlapping", () => {
	assert(!segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1));
});

Deno.test("segmentsIntersect: touching at an endpoint counts", () => {
	assert(segmentsIntersect(0, 0, 5, 0, 5, 0, 5, 5));
});

Deno.test("segmentsIntersect: collinear overlap counts", () => {
	assert(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0));
});

Deno.test("segmentsIntersect: collinear but separated does not", () => {
	assert(!segmentsIntersect(0, 0, 5, 0, 10, 0, 15, 0));
});

Deno.test("pointInRing: inside and outside a square", () => {
	const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
	assert(pointInRing(5, 5, ring));
	assert(!pointInRing(15, 5, ring));
	assert(!pointInRing(-1, -1, ring));
});

Deno.test("pointInMultiPolygon: square with a hole", () => {
	const outer = [[0, 0], [20, 0], [20, 20], [0, 20]];
	const hole = [[5, 5], [15, 5], [15, 15], [5, 15]];
	const mp = [[outer, hole]];
	assert(pointInMultiPolygon(2, 2, mp)); // inside outer, outside hole
	assert(!pointInMultiPolygon(10, 10, mp)); // inside the hole => not owned
	assert(!pointInMultiPolygon(25, 25, mp)); // fully outside
});

Deno.test("canonicalize: removes collinear vertices, preserves area", () => {
	// A square with an extra collinear midpoint on the bottom edge.
	const mp = [[[[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]]];
	const out = canonicalize(mp);
	assertEquals(vertexCount(out), 4); // collinear midpoint dropped
	assertEquals(multiPolygonArea(out), 100);
});

Deno.test("canonicalize: drops zero-area / degenerate rings", () => {
	const mp = [[[[0, 0], [10, 0], [20, 0]]]]; // all collinear => no area
	assertEquals(canonicalize(mp).length, 0);
});

Deno.test("SpatialHash: returns near segments and excludes far ones", () => {
	const hash = new SpatialHash(4);
	const near = { id: "near" };
	const far = { id: "far" };
	hash.insertSegment(0, 0, 1, 1, near);
	hash.insertSegment(100, 100, 101, 101, far);
	const candidates = hash.querySegment(0.5, 0.5, 2, 2);
	assert(candidates.has(near));
	assert(!candidates.has(far));
});

Deno.test("SpatialHash: clear empties the structure", () => {
	const hash = new SpatialHash(4);
	hash.insertSegment(0, 0, 1, 1, { id: 1 });
	hash.clear();
	assertEquals(hash.querySegment(0, 0, 1, 1).size, 0);
});
