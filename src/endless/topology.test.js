import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CELL_SIZE,
  CHUNK_CELLS,
  DIRECTIONS,
  cellToWorld,
  chunkForCell,
  describeCell,
  hashCoordinates,
  hasWall,
  worldToCell,
} from './topology.js';

const OFFSETS = Object.freeze({
  north: { x: 0, z: -1, opposite: 'south' },
  east: { x: 1, z: 0, opposite: 'west' },
  south: { x: 0, z: 1, opposite: 'north' },
  west: { x: -1, z: 0, opposite: 'east' },
});

function floorMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function cellKey(x, z) {
  return `${x},${z}`;
}

function reachableCells(seed, minimum, maximum) {
  const start = { x: 0, z: 0 };
  const queue = [start];
  const visited = new Set([cellKey(start.x, start.z)]);
  let cursor = 0;

  while (cursor < queue.length) {
    const current = queue[cursor++];
    for (const direction of DIRECTIONS) {
      if (hasWall(seed, current.x, current.z, direction)) continue;
      const offset = OFFSETS[direction];
      const next = { x: current.x + offset.x, z: current.z + offset.z };
      if (
        next.x < minimum || next.x > maximum
        || next.z < minimum || next.z > maximum
      ) continue;
      const key = cellKey(next.x, next.z);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push(next);
    }
  }

  return visited;
}

test('coordinate helpers preserve signed cells and use floor-based chunks', () => {
  assert.equal(CELL_SIZE, 4);
  assert.equal(CHUNK_CELLS, 8);
  assert.deepEqual(DIRECTIONS, ['north', 'east', 'south', 'west']);

  for (let cell = -64; cell <= 64; cell += 1) {
    assert.equal(worldToCell(cellToWorld(cell)), cell);
  }
  assert.equal(worldToCell(-2.01), -1);
  assert.equal(worldToCell(-2), 0);
  assert.equal(worldToCell(1.999), 0);
  assert.equal(worldToCell(2), 1);

  assert.equal(chunkForCell(-17), -3);
  assert.equal(chunkForCell(-9), -2);
  assert.equal(chunkForCell(-8), -1);
  assert.equal(chunkForCell(-1), -1);
  assert.equal(chunkForCell(0), 0);
  assert.equal(chunkForCell(7), 0);
  assert.equal(chunkForCell(8), 1);
  assert.equal(chunkForCell(16), 2);
});

test('coordinate hashes are deterministic unsigned words and include high coordinate bits', () => {
  const samples = [
    [0, 0, 0, 0],
    [0xffffffff, -1, -1, 0x12345678],
    [42, 1234567, -7654321, 9],
    [42, 0x100000000, -0x100000000, 9],
  ];

  for (const sample of samples) {
    const first = hashCoordinates(...sample);
    const second = hashCoordinates(...sample);
    assert.equal(first, second);
    assert.ok(Number.isInteger(first));
    assert.ok(first >= 0 && first <= 0xffffffff);
  }

  assert.notEqual(
    hashCoordinates(7, 0, 0, 3),
    hashCoordinates(7, 0x100000000, 0, 3),
  );
  assert.notEqual(
    hashCoordinates(7, -1, 4, 3),
    hashCoordinates(7, 1, 4, 3),
  );
});

test('every shared edge is symmetric across seeds and negative coordinates', () => {
  for (const seed of [0, 1, 0xdecafbad, 0xffffffff]) {
    for (let z = -32; z <= 32; z += 1) {
      for (let x = -32; x <= 32; x += 1) {
        for (const direction of DIRECTIONS) {
          const offset = OFFSETS[direction];
          assert.equal(
            hasWall(seed, x, z, direction),
            hasWall(seed, x + offset.x, z + offset.z, offset.opposite),
            `asymmetric ${direction} edge at ${x},${z} for seed ${seed}`,
          );
        }
      }
    }
  }
});

test('north/south rack aisles have guaranteed cross-aisles and divider gates', () => {
  const dividerSpacing = CHUNK_CELLS * 3;
  for (const seed of [3, 77, 0xa5a5a5a5]) {
    let ordinarySideWalls = 0;
    let ordinarySideEdges = 0;

    for (let z = -64; z <= 64; z += 1) {
      const crossAisle = floorMod(z, CHUNK_CELLS) === 0;
      for (let x = -48; x <= 48; x += 1) {
        if (crossAisle) {
          assert.equal(hasWall(seed, x, z, 'east'), false);
          assert.equal(hasWall(seed, x, z, 'west'), false);
        } else {
          ordinarySideEdges += 1;
          if (hasWall(seed, x, z, 'east')) ordinarySideWalls += 1;
        }

        const dividerEdge = floorMod(z + 1, dividerSpacing) === 0;
        if (!dividerEdge) assert.equal(hasWall(seed, x, z, 'south'), false);
      }
    }

    assert.ok(
      ordinarySideWalls / ordinarySideEdges > 0.85,
      'sparse service openings must preserve the long rack aisles',
    );

    for (let lowerZ = -73; lowerZ <= 71; lowerZ += 1) {
      if (floorMod(lowerZ + 1, dividerSpacing) !== 0) continue;
      for (let blockX = -48; blockX < 48; blockX += CHUNK_CELLS) {
        let gates = 0;
        for (let x = blockX; x < blockX + CHUNK_CELLS; x += 1) {
          if (!hasWall(seed, x, lowerZ, 'south')) gates += 1;
        }
        assert.equal(
          gates,
          1,
          `divider at z=${lowerZ} needs one gate in x=[${blockX},${blockX + 7}]`,
        );
      }
    }
  }
});

test('descriptions are stable across traversal order and expose streaming hints', () => {
  const seed = 0x716f9a23;
  const origin = describeCell(seed, 0, 0);
  assert.equal(origin.illuminated, true);
  assert.equal(origin.fixture, 'warm');
  const coordinates = [];
  for (let z = -19; z <= 19; z += 3) {
    for (let x = -23; x <= 23; x += 4) coordinates.push({ x, z });
  }

  const forward = new Map(coordinates.map(({ x, z }) => [cellKey(x, z), describeCell(seed, x, z)]));
  const reverse = new Map(
    [...coordinates].reverse().map(({ x, z }) => [cellKey(x, z), describeCell(seed, x, z)]),
  );
  assert.deepEqual(forward, reverse);

  const allowedFixtures = new Set(['steady', 'flicker', 'broken', 'warm']);
  const allowedFurniture = new Set([null, 'desk', 'chair', 'cabinet']);
  for (const { x, z } of coordinates) {
    const description = forward.get(cellKey(x, z));
    assert.deepEqual(
      Object.keys(description).sort(),
      ['cable', 'fixture', 'furniture', 'illuminated', 'phase', 'rackSides', 'vent'],
    );
    assert.ok(allowedFixtures.has(description.fixture));
    assert.ok(description.phase >= 0 && description.phase < 1);
    assert.ok(description.rackSides.every((side) => side === -1 || side === 1));
    assert.deepEqual(description.rackSides, [...description.rackSides].sort((a, b) => a - b));
    assert.equal(description.rackSides.includes(-1), hasWall(seed, x, z, 'west'));
    assert.equal(description.rackSides.includes(1), hasWall(seed, x, z, 'east'));
    assert.equal(typeof description.vent, 'boolean');
    assert.ok(allowedFurniture.has(description.furniture));
    assert.equal(typeof description.cable, 'boolean');
    assert.equal(typeof description.illuminated, 'boolean');
  }

  assert.ok(
    coordinates.some(({ x, z }) => (
      JSON.stringify(describeCell(seed, x, z))
      !== JSON.stringify(describeCell(seed + 1, x, z))
    )),
    'the seed must affect streamed cell detail',
  );
});

test('the topology remains connected throughout a large signed sample', () => {
  const minimum = -48;
  const maximum = 48;
  const expected = (maximum - minimum + 1) ** 2;
  for (const seed of [0, 42, 0x4149534c, 0xffffffff]) {
    const visited = reachableCells(seed, minimum, maximum);
    assert.equal(
      visited.size,
      expected,
      `seed ${seed} reached ${visited.size} of ${expected} sampled cells`,
    );
    assert.ok(visited.has(cellKey(minimum, minimum)));
    assert.ok(visited.has(cellKey(maximum, maximum)));
    assert.ok(visited.has(cellKey(-CHUNK_CELLS, CHUNK_CELLS)));
    assert.ok(visited.has(cellKey(CHUNK_CELLS, -CHUNK_CELLS)));
  }
});

test('far-away cells have no artificial boundary and reject invalid directions', () => {
  const seed = 981723;
  for (const [x, z] of [
    [1_000_000, 1_000_000],
    [-1_000_000, 1_000_000],
    [1_000_000, -1_000_000],
    [-1_000_000, -1_000_000],
  ]) {
    assert.ok(DIRECTIONS.some((direction) => !hasWall(seed, x, z, direction)));
    const description = describeCell(seed, x, z);
    assert.ok(description.phase >= 0 && description.phase < 1);
  }
  assert.throws(() => hasWall(seed, 0, 0, 'up'), /direction/);
});
