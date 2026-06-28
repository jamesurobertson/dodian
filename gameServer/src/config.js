/**
 * How many of the skins should be randomly assigned to players if they either didn't provide one,
 * or when two players have the same skin and a new color needs to be picked to distinguish the two players.
 */
export const FREE_SKIN_COLOR_COUNT = 12;

/**
 * Used to determine which skin patterns are available freely and which ones require a subscription.
 */
export const PAID_SKIN_PATTERN_IDS = [27];

/**
 * Defines a rectangle around the players position for which tiles are guaranteed to be visible.
 * Tiles outside this viewport may also have been sent,
 * but might not be due to `VIEWPORT_EDGE_CHUNK_SIZE` not being reached yet.
 */
export const MIN_TILES_VIEWPORT_RECT_SIZE = 20;

/**
 * The width or height of chunks of tiles that will be sent to a client when the player moves.
 */
export const VIEWPORT_EDGE_CHUNK_SIZE = 5;

/**
 * Defines a rectangle around the players position for which events will be sent to the player.
 */
export const UPDATES_VIEWPORT_RECT_SIZE = MIN_TILES_VIEWPORT_RECT_SIZE + VIEWPORT_EDGE_CHUNK_SIZE;

/**
 * How many tiles around the player should be filled when the player joins a game.
 */
export const PLAYER_SPAWN_RADIUS = 2;

/**
 * How long (ms) a freshly spawned player is protected: they cannot be killed and cannot cut
 * others. Prevents dying instantly to an enemy you couldn't see at spawn (vision is limited).
 */
export const SPAWN_PROTECTION_MS = 2500;

/**
 * How many random candidate positions to consider when spawning; the one farthest from existing
 * players is chosen so you don't spawn right on top of someone.
 */
export const SPAWN_CANDIDATE_COUNT = 24;

/**
 * How many tiles players move per millisecond. This should be the same value as on the client.
 */
export const PLAYER_TRAVEL_SPEED = 0.006;

/**
 * Continuous (freeform) movement: the maximum rate at which a player can rotate their
 * heading, in radians per millisecond. The server steers the current heading towards the
 * client-requested target heading, clamped by this value each tick. This both gives the
 * game a slither.io-style turn feel and acts as movement anti-cheat (the client can only
 * ever request a heading; the server owns position and how fast the heading may change).
 *
 * 0.005 rad/ms = 5 rad/s, so a full 180° reversal takes ~0.63s.
 */
export const PLAYER_TURN_RATE = 0.005;

/**
 * Fixed-point scale used when encoding continuous positions on the wire.
 * A position in tile units is sent as round(pos * POSITION_NETWORK_SCALE) in a Uint32.
 * 256 gives 1/256-tile precision, smooth enough for rendering and interpolation.
 */
export const POSITION_NETWORK_SCALE = 256;

/**
 * Continuous trail: maximum number of points retained in a player's trail polyline.
 * (Temporary tail cap used while territory capture is being built; once territory drives
 * the trail lifecycle the trail is instead bounded by how far the player ventures out.)
 */
export const FREEFORM_MAX_TRAIL_POINTS = 120;

/**
 * Hard cap on the number of points in a single excursion trail. At ~0.3 tiles/tick this is a
 * very long journey; exceeding it kills the player. Bounds CPU and polygon complexity, and stops
 * a griefer from wandering forever to build an arbitrarily large capture/trail.
 */
export const FREEFORM_MAX_TRAIL_POINTS_HARD = 2500;

/**
 * Continuous self-collision grace: how many of the most recent trail segments next to the
 * head are ignored when testing a player against their own trail. The head always touches
 * its newest segment, and a recent turn can place the head on the second-newest, so these
 * must be excluded or the player would instantly kill themselves.
 */
export const FREEFORM_SELF_COLLISION_GRACE_SEGMENTS = 8;

/**
 * Cell size (in tiles) of the spatial hash used as the broad-phase for trail collision.
 */
export const TRAIL_HASH_CELL_SIZE = 4;

/**
 * Fixed-point scale (sub-units per tile) for polygon territory geometry. Polygon clipping
 * runs on integers at this scale; validated in Phase 0 (scripts/clippingHarness) to keep
 * vertex counts bounded with canonicalize().
 */
export const TERRITORY_SUBUNIT_SCALE = 1024;

/**
 * Half the side length (in tiles) of the square territory a player is granted on spawn.
 */
export const SPAWN_TERRITORY_HALF_TILES = 3;

/**
 * Douglas-Peucker epsilon (in territory sub-units) applied to territory polygons before sending
 * them to clients. ~0.16 tiles: collapses the many near-collinear vertices a continuous capture
 * loop produces, cutting bandwidth and client render cost with no visible change. The authoritative
 * geometry and score keep using the full-resolution polygon.
 */
export const TERRITORY_NETWORK_SIMPLIFY_EPS = 160;

/**
 * Time in milliseconds that we allow the player to undo events.
 * This is essentially the max ping we allow the player to have before they start having a bad time.
 * If the player kills a player or themselves for instance, we give the client this amount of milliseconds
 * to make a turn and prevent the event from happening.
 */
export const MAX_UNDO_EVENT_TIME = 600;

/**
 * How many tiles players are allowed to move backwards due to latency.
 * Assuming a speed of 6 tiles per second and a value of 3 would mean that clients need more than 500ms ping
 * in order to not be able to control themselves.
 */
export const MAX_UNDO_TILE_COUNT = 5;

/**
 * The maximum allowed skin color id.
 */
export const VALID_SKIN_COLOR_RANGE = 13;

/**
 * The maximum allowed pattern id.
 */
export const VALID_SKIN_PATTERN_RANGE = 29;

/**
 * How many characters player are allowed to have.
 */
export const VALID_PLAYER_NAME_LENGTH = 20;

/**
 * How often (in milliseconds) a new part of the minimap is updated.
 * The minimap is divided in 4 parts, so a value of 250 would mean the full map sent every second.
 */
export const MINIMAP_PART_UPDATE_FREQUENCY = 250;

/**
 * How often (in milliseconds) the leaderboard is sent to all players in a game.
 */
export const LEADERBOARD_UPDATE_FREQUENCY = 3_000;

/**
 * If the amount of players in a game is less then this,
 * then scores won't be reported to the global leaderboard.
 * The current scores of all in game players will be reported
 * once the player count falls below this threshold,
 * allowing players to at least get their current progress on the leaderboard.
 */
export const REQUIRED_PLAYER_COUNT_FOR_GLOBAL_LEADERBOARD = 10;

/**
 * List of game modes where scores are reported to the global leaderboard.
 */
export const GM_REPORT_SCORES = ["default"];

/**
 * List of game modes where players are allowed to use trail cancel.
 */
export const GM_ALLOW_TRAIL_CANCEL = ["arena", "drawing"];

/**
 * List of game modes where we force some exploit fixes to be enabled regardless
 * of the protocol version that was sent by the client.
 */
export const GM_FORCE_FLYING_PATCHES = ["arena"];
