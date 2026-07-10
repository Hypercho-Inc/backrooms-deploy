/**
 * Deterministic, coordinate-addressed topology for the endless data center.
 *
 * The grid has no stored extent. Every edge and streaming hint is derived from
 * the world seed and integer cell coordinates, so chunks can be generated in
 * any order and discarded without changing the world when they are reloaded.
 */

export const CELL_SIZE = 4;
export const CHUNK_CELLS = 8;
export const DIRECTIONS = Object.freeze(['north', 'east', 'south', 'west']);

const UINT32_RANGE = 0x100000000;
const CROSS_AISLE_SPACING = CHUNK_CELLS;
const DIVIDER_SPACING = CHUNK_CELLS * 3;
const DIVIDER_GATE_SPACING = CHUNK_CELLS;

const SALT_EAST_WEST_OPENING = 0x6b1d5a97;
const SALT_DIVIDER_GATE = 0x27d4eb2f;
const SALT_FIXTURE = 0xa0761d65;
const SALT_FIXTURE_PHASE = 0xe7037ed1;
const SALT_VENT = 0x8ebc6af1;
const SALT_FURNITURE = 0x589965cd;
const SALT_CABLE = 0x1d8e4e27;
const SALT_ROOM = 0xeb44accb;

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function floorMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function coordinateWords(value) {
  const low = value >>> 0;
  const high = Math.floor(value / UINT32_RANGE) >>> 0;
  return [low, high];
}

function avalanche(value) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/**
 * Hash a seed, signed cell coordinate, and stream salt to an unsigned 32-bit
 * integer. Seed and salt intentionally normalize to uint32, matching campaign
 * seeds. Both words of each safe-integer coordinate participate in the hash,
 * avoiding a repeat after only 2^32 cells.
 */
export function hashCoordinates(seed, x, z, salt = 0) {
  const normalizedSeed = Math.trunc(requireFiniteNumber(seed, 'seed')) >>> 0;
  const normalizedSalt = Math.trunc(requireFiniteNumber(salt, 'salt')) >>> 0;
  const cellX = requireSafeInteger(x, 'x');
  const cellZ = requireSafeInteger(z, 'z');
  const [xLow, xHigh] = coordinateWords(cellX);
  const [zLow, zHigh] = coordinateWords(cellZ);

  let hash = avalanche(normalizedSeed ^ normalizedSalt ^ 0x9e3779b9);
  hash = avalanche(hash ^ xLow ^ 0x85ebca6b);
  hash = avalanche(hash ^ xHigh ^ 0xc2b2ae35);
  hash = avalanche(hash ^ zLow ^ 0x27d4eb2f);
  hash = avalanche(hash ^ zHigh ^ 0x165667b1);
  return hash >>> 0;
}

/**
 * Convert one world-space axis to its nearest cell center. Exact half-cell
 * boundaries belong to the cell in the positive direction.
 */
export function worldToCell(value) {
  const world = requireFiniteNumber(value, 'world coordinate');
  const cell = Math.floor((world + CELL_SIZE / 2) / CELL_SIZE);
  return requireSafeInteger(cell, 'cell coordinate');
}

/** Convert one integer cell axis to its world-space center. */
export function cellToWorld(cell) {
  const coordinate = requireSafeInteger(cell, 'cell coordinate');
  const world = coordinate * CELL_SIZE;
  if (!Number.isSafeInteger(world)) {
    throw new RangeError('cell coordinate is too large for an exact world position');
  }
  return world;
}

/** Return the signed chunk coordinate containing one cell axis. */
export function chunkForCell(cell) {
  return Math.floor(requireSafeInteger(cell, 'cell coordinate') / CHUNK_CELLS);
}

function isCrossAisle(cellZ) {
  return floorMod(cellZ, CROSS_AISLE_SPACING) === 0;
}

function isDividerEdge(lowerCellZ) {
  return floorMod(lowerCellZ + 1, DIVIDER_SPACING) === 0;
}

function dividerHasGate(seed, cellX, lowerCellZ) {
  const divider = Math.floor((lowerCellZ + 1) / DIVIDER_SPACING);
  const phase = hashCoordinates(seed, divider, 0, SALT_DIVIDER_GATE)
    % DIVIDER_GATE_SPACING;
  return floorMod(cellX - phase, DIVIDER_GATE_SPACING) === 0;
}

function hasEastWestWall(seed, leftCellX, cellZ) {
  // Every eighth row is an uninterrupted cross-aisle. Between those rows,
  // walls form long north/south rack aisles with sparse service openings.
  if (isCrossAisle(cellZ)) return false;
  return hashCoordinates(seed, leftCellX, cellZ, SALT_EAST_WEST_OPENING) % 13 !== 0;
}

function hasNorthSouthWall(seed, cellX, lowerCellZ) {
  // Normal aisle travel is uninterrupted. Every third chunk boundary is a
  // divider; one deterministic gate per eight columns keeps every band joined.
  // Therefore any cell can reach a cross-aisle in its divider band, travel to
  // a gate, cross into the next band, and repeat in either signed direction.
  if (!isDividerEdge(lowerCellZ)) return false;
  return !dividerHasGate(seed, cellX, lowerCellZ);
}

/**
 * Return whether an edge of a cell is closed. Shared edges are reduced to one
 * canonical east/west or north/south coordinate before hashing, making the
 * answer identical from either neighboring cell.
 */
export function hasWall(seed, cellX, cellZ, direction) {
  const x = requireSafeInteger(cellX, 'cellX');
  const z = requireSafeInteger(cellZ, 'cellZ');
  if (!DIRECTIONS.includes(direction)) {
    throw new TypeError(`direction must be one of: ${DIRECTIONS.join(', ')}`);
  }

  switch (direction) {
    case 'north':
      return hasNorthSouthWall(seed, x, z - 1);
    case 'east':
      return hasEastWestWall(seed, x, z);
    case 'south':
      return hasNorthSouthWall(seed, x, z);
    case 'west':
      return hasEastWestWall(seed, x - 1, z);
    default:
      return false;
  }
}

function describeFixture(seed, cellX, cellZ, illuminated) {
  if (illuminated) return 'warm';
  const roll = hashCoordinates(seed, cellX, cellZ, SALT_FIXTURE) % 100;
  if (roll < 64) return 'steady';
  if (roll < 80) return 'flicker';
  if (roll < 91) return 'broken';
  return 'warm';
}

function describeFurniture(seed, cellX, cellZ, rackSides, illuminated) {
  // Keep the long rack aisles clear. Furniture is a sparse hint for cross
  // aisles, service openings, and the occasional illuminated maintenance bay.
  if (rackSides.length === 2 && !illuminated) return null;
  const roll = hashCoordinates(seed, cellX, cellZ, SALT_FURNITURE) % 40;
  if (roll === 0) return 'desk';
  if (roll === 1) return 'chair';
  if (roll === 2) return 'cabinet';
  return null;
}

/**
 * Return traversal-order-independent streaming hints for one cell.
 * `rackSides` uses -1 for west and 1 for east.
 */
export function describeCell(seed, cellX, cellZ) {
  const x = requireSafeInteger(cellX, 'cellX');
  const z = requireSafeInteger(cellZ, 'cellZ');
  const rackSides = [];
  if (hasWall(seed, x, z, 'west')) rackSides.push(-1);
  if (hasWall(seed, x, z, 'east')) rackSides.push(1);

  // The room hash is shared by a 4x4 cell block so the hint produces pools of
  // warm light instead of unrelated single-cell speckles.
  const roomX = Math.floor(x / 4);
  const roomZ = Math.floor(z / 4);
  const illuminated = (x === 0 && z === 0)
    || hashCoordinates(seed, roomX, roomZ, SALT_ROOM) % 29 === 0;
  const fixture = describeFixture(seed, x, z, illuminated);

  return Object.freeze({
    fixture,
    phase: hashCoordinates(seed, x, z, SALT_FIXTURE_PHASE) / UINT32_RANGE,
    rackSides: Object.freeze(rackSides),
    vent: hashCoordinates(seed, x, z, SALT_VENT) % 17 === 0,
    furniture: describeFurniture(seed, x, z, rackSides, illuminated),
    cable: hashCoordinates(seed, x, z, SALT_CABLE) % 9 === 0,
    illuminated,
  });
}
