# Phase 0 decision — polygon clipping library

**Result: use `polygon-clipping@0.15.7`. Coordinate space = fixed-point integers, `SUB = 1024` sub-units per tile. Run `canonicalize()` (snap-to-grid + drop duplicate/collinear/zero-area) after every boolean op.**

Reproduce: `deno run -A scripts/clippingHarness/harness.js`

## Measured results (SUB=1024, seeded, deterministic)

| Check | polygon-clipping | martinez |
|---|---|---|
| Self-intersecting bowtie union | ok (10 verts, area 440) | ok (10 verts, area 440) |
| Degenerate sliver union | ok (collapses to 8 verts) | ok (8 verts) |
| Steal-land difference (900 tiles − overlap) | **692 tiles (exact)** | 345 tiles (**wrong**) |
| 10k sequential capture-unions: vertex count | **bounded ~60–82, stable** | fragmented into 2–3 pieces |
| Per-op cost | **0.073ms avg / 3.1ms max** | n/a (disqualified) |
| Invalid/degenerate outputs over 10k ops | **0** | — |

The exact expected steal area is 900 − (13×16 overlap = 208) = **692**, which polygon-clipping
returns and martinez does not. martinez also produced spurious extra polygons (topology
fragmentation) during the sequential stress test. polygon-clipping is correct, robust, and fast.

## Why these specific choices

- **Fixed-point integers (`SUB=1024`)**: snapping every vertex to an integer grid removes the
  near-degenerate intersections that cause float clipping libraries to spray slivers. 1024
  gives smooth-enough curves; a 600-tile arena × 1024 ≈ 6e5, squared ≈ 3.8e11, well within
  `Number.MAX_SAFE_INTEGER` for shoelace/intersection math.
- **`canonicalize()` after every op**: this is what keeps the vertex count bounded across
  thousands of sequential captures (verified: stays ~60–82 over 10k unions instead of growing
  unbounded). It is mandatory, not optional.

## Promotion path

`scripts/clippingHarness/geometry.js` (signedArea2, multiPolygonArea, vertexCount, bbox,
canonicalize, isIntegerMultiPolygon) is promoted to `gameServer/src/util/geometry.js` in Phase 2,
extended with segment-segment intersection and point-in-polygon. The harness dir is throwaway.
