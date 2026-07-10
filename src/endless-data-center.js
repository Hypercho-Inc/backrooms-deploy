import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import {
  CELL_SIZE,
  CHUNK_CELLS,
  cellToWorld,
  chunkForCell,
  describeCell,
  hasWall,
  hashCoordinates,
  worldToCell,
} from './endless/topology.js';
import { createEndlessAudio } from './endless/audio.js';

const WALL_HEIGHT = 3.15;
const WALL_THICKNESS = 0.16;
const PLAYER_RADIUS = 0.31;
const STANDING_EYE = 1.62;
const CROUCH_EYE = 1.12;
const CHUNK_WORLD_SIZE = CELL_SIZE * CHUNK_CELLS;
const FLOATING_ORIGIN_THRESHOLD = CHUNK_WORLD_SIZE * 16;
const UINT32_RANGE = 0x100000000;
const UP = new THREE.Vector3(0, 1, 0);

const TAPE_MESSAGES = Object.freeze([
  'A DRIVE SPINS UP IN AN EMPTY CHASSIS',
  'COOLING ZONE 04 REPORTS A HUMAN TEMPERATURE',
  'THE NEXT AISLE HAS THE SAME SCRATCHES',
  'A BADGE READER ACCEPTS THE CAMERA',
  'VENTILATION CHANGES DIRECTION BEHIND YOU',
  'RACK LABELS COUNT DOWN BELOW ZERO',
  'THE FLOOR PLAN HAS NO OUTSIDE EDGE',
  'A PHONE RINGS INSIDE A SEALED CABINET',
]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function hashUnit(seed, x, z, salt = 0) {
  return hashCoordinates(seed, x, z, salt) / UINT32_RANGE;
}

function signed(value, width = 4) {
  const prefix = value < 0 ? '-' : '+';
  return `${prefix}${String(Math.abs(value)).padStart(width, '0')}`;
}

function chunkKey(chunkX, chunkZ) {
  return `${chunkX}:${chunkZ}`;
}

function supportsWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

function formatTimestamp(elapsed) {
  const date = new Date(Date.UTC(1998, 8, 23, 2, 17, 0) + elapsed * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}.${month}.${day}  ${hours}:${minutes}:${seconds}`;
}

function formatTimecode(elapsed) {
  const wholeSeconds = Math.max(0, Math.floor(elapsed));
  const frames = Math.floor((elapsed - wholeSeconds) * 30) % 30;
  const seconds = wholeSeconds % 60;
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const hours = Math.floor(wholeSeconds / 3600);
  return [hours, minutes, seconds, frames]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function addTransform(records, x, y, z, options = {}) {
  records.push({
    x,
    y,
    z,
    rx: options.rx || 0,
    ry: options.ry || 0,
    rz: options.rz || 0,
    sx: options.sx ?? 1,
    sy: options.sy ?? 1,
    sz: options.sz ?? 1,
    color: options.color,
  });
}

function createInstancedMesh(geometry, material, records, options = {}) {
  if (!records.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, records.length);
  const dummy = new THREE.Object3D();
  records.forEach((record, index) => {
    dummy.position.set(record.x, record.y, record.z);
    dummy.rotation.set(record.rx, record.ry, record.rz);
    dummy.scale.set(record.sx, record.sy, record.sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
  });
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = Boolean(options.castShadow);
  mesh.receiveShadow = Boolean(options.receiveShadow);
  mesh.computeBoundingSphere?.();
  return mesh;
}

function createLedMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
    },
    vertexShader: `
      attribute vec3 ledColor;
      attribute float blink;
      attribute float phase;
      uniform float time;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float pulse = blink > 0.5
          ? step(0.34, fract(time * (0.55 + phase * 1.9) + phase))
          : 1.0;
        vColor = ledColor * (0.5 + pulse * 1.5);
        vAlpha = 0.42 + pulse * 0.58;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = clamp(40.0 / max(1.0, -viewPosition.z), 1.2, 4.2);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 point = gl_PointCoord - vec2(0.5);
        float radius = dot(point, point);
        if (radius > 0.25) discard;
        float glow = smoothstep(0.25, 0.0, radius);
        gl_FragColor = vec4(vColor * (0.72 + glow * 1.4), vAlpha * glow);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
}

function createSharedResources() {
  const geometries = {
    tile: new THREE.BoxGeometry(CELL_SIZE, 0.1, CELL_SIZE),
    wall: new THREE.BoxGeometry(CELL_SIZE + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
    fixture: new THREE.BoxGeometry(1.35, 0.055, 0.38),
    rack: new THREE.BoxGeometry(0.84, 2.38, 1.56),
    rackFace: new THREE.BoxGeometry(0.035, 2.14, 1.38),
    unitBox: new THREE.BoxGeometry(1, 1, 1),
    vent: new THREE.BoxGeometry(1.05, 0.07, 0.55),
  };
  const materials = {
    floor: new THREE.MeshStandardMaterial({
      color: 0x35454e,
      emissive: 0x0b1519,
      emissiveIntensity: 0.08,
      roughness: 0.62,
      metalness: 0.34,
    }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x344249, roughness: 0.76, metalness: 0.18 }),
    wall: new THREE.MeshStandardMaterial({
      color: 0x4b606b,
      emissive: 0x0a151a,
      emissiveIntensity: 0.06,
      roughness: 0.7,
      metalness: 0.2,
    }),
    rack: new THREE.MeshStandardMaterial({
      color: 0x2c3a41,
      emissive: 0x081216,
      emissiveIntensity: 0.09,
      roughness: 0.48,
      metalness: 0.62,
    }),
    rackFace: new THREE.MeshStandardMaterial({
      color: 0x0e1c21,
      emissive: 0x071419,
      emissiveIntensity: 0.18,
      roughness: 0.42,
      metalness: 0.58,
    }),
    props: new THREE.MeshStandardMaterial({ color: 0x4a5252, roughness: 0.72, metalness: 0.18 }),
    cable: new THREE.MeshStandardMaterial({ color: 0x111718, roughness: 0.92, metalness: 0.03 }),
    vent: new THREE.MeshStandardMaterial({ color: 0x202d33, roughness: 0.5, metalness: 0.55 }),
    fixtureSteady: new THREE.MeshStandardMaterial({
      color: 0xbad8da,
      emissive: 0xb9e8e4,
      emissiveIntensity: 2.35,
      roughness: 0.34,
      metalness: 0.12,
    }),
    fixtureWarm: new THREE.MeshStandardMaterial({
      color: 0xd8c28d,
      emissive: 0xffd68d,
      emissiveIntensity: 2.15,
      roughness: 0.36,
      metalness: 0.1,
    }),
    fixtureBroken: new THREE.MeshStandardMaterial({
      color: 0x202a2e,
      emissive: 0x050708,
      emissiveIntensity: 0.08,
      roughness: 0.82,
      metalness: 0.2,
    }),
  };
  materials.fixtureFlicker = [0, 1, 2].map(() => new THREE.MeshStandardMaterial({
    color: 0xa8c8cb,
    emissive: 0xa4dfe0,
    emissiveIntensity: 1.8,
    roughness: 0.38,
    metalness: 0.12,
  }));
  materials.led = createLedMaterial();
  return { geometries, materials };
}

function createChunk({ seed, chunkX, chunkZ, originX, originZ, resources }) {
  const group = new THREE.Group();
  group.name = `endless_chunk_${chunkX}_${chunkZ}`;
  group.position.set(
    chunkX * CHUNK_WORLD_SIZE - originX,
    0,
    chunkZ * CHUNK_WORLD_SIZE - originZ,
  );

  const records = {
    floor: [],
    ceiling: [],
    walls: [],
    racks: [],
    rackFaces: [],
    fixturesSteady: [],
    fixturesWarm: [],
    fixturesBroken: [],
    fixturesFlicker: [[], [], []],
    vents: [],
    props: [],
    cables: [],
  };
  const ledPositions = [];
  const ledColors = [];
  const ledBlink = [];
  const ledPhases = [];
  const emitters = [];
  const colliders = [];

  const firstCellX = chunkX * CHUNK_CELLS;
  const firstCellZ = chunkZ * CHUNK_CELLS;
  for (let localZ = 0; localZ < CHUNK_CELLS; localZ += 1) {
    for (let localX = 0; localX < CHUNK_CELLS; localX += 1) {
      const cellX = firstCellX + localX;
      const cellZ = firstCellZ + localZ;
      const x = localX * CELL_SIZE;
      const z = localZ * CELL_SIZE;
      const globalX = cellToWorld(cellX);
      const globalZ = cellToWorld(cellZ);
      const descriptor = describeCell(seed, cellX, cellZ);
      const tileRoll = hashUnit(seed, cellX, cellZ, 0x2f9be6c1);
      const floorColor = new THREE.Color(0x35454e).offsetHSL(0, 0, (tileRoll - 0.5) * 0.055);
      const wallColor = new THREE.Color(0x4b606b).offsetHSL(0, 0, (tileRoll - 0.5) * 0.07);

      addTransform(records.floor, x, -0.08, z, { color: floorColor });
      addTransform(records.ceiling, x, WALL_HEIGHT + 0.08, z, {
        color: descriptor.illuminated ? 0x4b5358 : 0x344249,
      });
      if (hasWall(seed, cellX, cellZ, 'north')) {
        addTransform(records.walls, x, WALL_HEIGHT / 2, z - CELL_SIZE / 2, { color: wallColor });
      }
      if (hasWall(seed, cellX, cellZ, 'west')) {
        addTransform(records.walls, x - CELL_SIZE / 2, WALL_HEIGHT / 2, z, {
          ry: Math.PI / 2,
          color: wallColor,
        });
      }

      const fixtureRecord = { x, y: WALL_HEIGHT - 0.065, z, ry: Math.PI / 2 };
      if (descriptor.fixture === 'steady') records.fixturesSteady.push(fixtureRecord);
      else if (descriptor.fixture === 'warm') records.fixturesWarm.push(fixtureRecord);
      else if (descriptor.fixture === 'broken') records.fixturesBroken.push(fixtureRecord);
      else records.fixturesFlicker[Math.floor(descriptor.phase * 3) % 3].push(fixtureRecord);

      if (descriptor.fixture !== 'broken') {
        emitters.push({
          id: `fixture:${cellX}:${cellZ}`,
          type: 'fluorescent',
          position: { x: globalX, y: WALL_HEIGHT - 0.1, z: globalZ },
          state: descriptor.fixture,
          phase: descriptor.phase,
        });
      }
      if (descriptor.vent) {
        addTransform(records.vents, x + 0.86, WALL_HEIGHT - 0.04, z, {
          ry: descriptor.phase > 0.5 ? 0 : Math.PI / 2,
        });
        emitters.push({
          id: `vent:${cellX}:${cellZ}`,
          type: 'vent',
          position: { x: globalX + 0.86, y: WALL_HEIGHT - 0.12, z: globalZ },
        });
      }

      for (const side of descriptor.rackSides) {
        const rackX = x + side * 1.36;
        const faceX = x + side * 0.92;
        addTransform(records.racks, rackX, 1.19, z, {
          color: descriptor.illuminated ? 0x3b4c53 : 0x29383f,
        });
        addTransform(records.rackFaces, faceX, 1.18, z, {
          color: 0x050d10,
        });
        const globalRackX = globalX + side * 1.36;
        colliders.push({
          minX: globalRackX - 0.43,
          maxX: globalRackX + 0.43,
          minZ: globalZ - 0.79,
          maxZ: globalZ + 0.79,
        });
        emitters.push({
          id: `rack:${cellX}:${cellZ}:${side}`,
          type: 'rack',
          position: { x: globalRackX, y: 1.2, z: globalZ },
        });

        for (let led = 0; led < 8; led += 1) {
          const ledRoll = hashCoordinates(seed, cellX * 17 + led, cellZ * 13 + side, 0x9d29f761);
          const palette = [0x58ff93, 0xff5b45, 0x56a7ff, 0x81ffd5];
          ledPositions.push(
            faceX - side * 0.022,
            0.45 + (led % 4) * 0.46,
            z - 0.43 + Math.floor(led / 4) * 0.73,
          );
          const ledColor = new THREE.Color(palette[ledRoll % palette.length]);
          ledColors.push(ledColor.r, ledColor.g, ledColor.b);
          ledBlink.push(ledRoll % 5 === 0 ? 1 : 0);
          ledPhases.push(((ledRoll >>> 8) % 1000) / 1000);
        }
      }

      if (descriptor.furniture) {
        const side = hashUnit(seed, cellX, cellZ, 0x7b7d159c) > 0.5 ? 1 : -1;
        const furnitureX = x + side * 1.05;
        const globalFurnitureX = globalX + side * 1.05;
        if (descriptor.furniture === 'desk') {
          addTransform(records.props, furnitureX, 0.76, z, {
            sx: 1.35, sy: 0.09, sz: 0.66, color: 0x5c5549,
          });
          addTransform(records.props, furnitureX - 0.52, 0.38, z, {
            sx: 0.08, sy: 0.7, sz: 0.55, color: 0x454743,
          });
          addTransform(records.props, furnitureX + 0.52, 0.38, z, {
            sx: 0.08, sy: 0.7, sz: 0.55, color: 0x454743,
          });
          colliders.push({
            minX: globalFurnitureX - 0.72,
            maxX: globalFurnitureX + 0.72,
            minZ: globalZ - 0.38,
            maxZ: globalZ + 0.38,
          });
        } else if (descriptor.furniture === 'chair') {
          addTransform(records.props, furnitureX, 0.48, z, {
            sx: 0.58, sy: 0.1, sz: 0.58, color: 0x394449,
          });
          addTransform(records.props, furnitureX + side * 0.25, 0.79, z, {
            sx: 0.08, sy: 0.62, sz: 0.58, color: 0x394449,
          });
          colliders.push({
            minX: globalFurnitureX - 0.36,
            maxX: globalFurnitureX + 0.36,
            minZ: globalZ - 0.36,
            maxZ: globalZ + 0.36,
          });
        } else {
          addTransform(records.props, furnitureX, 0.82, z, {
            sx: 0.78, sy: 1.62, sz: 0.48, color: 0x465257,
          });
          colliders.push({
            minX: globalFurnitureX - 0.42,
            maxX: globalFurnitureX + 0.42,
            minZ: globalZ - 0.28,
            maxZ: globalZ + 0.28,
          });
        }
      }

      if (descriptor.cable) {
        addTransform(records.cables, x, 0.035, z + (descriptor.phase - 0.5) * 1.1, {
          ry: descriptor.phase > 0.5 ? Math.PI / 2 : 0,
          sx: 0.075,
          sy: 0.025,
          sz: 2.65,
          color: descriptor.phase > 0.66 ? 0x3b241f : descriptor.phase > 0.33 ? 0x17262a : 0x14191a,
        });
      }
    }
  }

  const { geometries, materials } = resources;
  const meshes = [
    createInstancedMesh(geometries.tile, materials.floor, records.floor, { receiveShadow: true }),
    createInstancedMesh(geometries.tile, materials.ceiling, records.ceiling),
    createInstancedMesh(geometries.wall, materials.wall, records.walls),
    createInstancedMesh(geometries.rack, materials.rack, records.racks),
    createInstancedMesh(geometries.rackFace, materials.rackFace, records.rackFaces),
    createInstancedMesh(geometries.fixture, materials.fixtureSteady, records.fixturesSteady),
    createInstancedMesh(geometries.fixture, materials.fixtureWarm, records.fixturesWarm),
    createInstancedMesh(geometries.fixture, materials.fixtureBroken, records.fixturesBroken),
    ...records.fixturesFlicker.map((entries, index) => (
      createInstancedMesh(geometries.fixture, materials.fixtureFlicker[index], entries)
    )),
    createInstancedMesh(geometries.vent, materials.vent, records.vents),
    createInstancedMesh(geometries.unitBox, materials.props, records.props),
    createInstancedMesh(geometries.unitBox, materials.cable, records.cables),
  ].filter(Boolean);
  meshes.forEach((mesh) => group.add(mesh));

  let ledGeometry = null;
  if (ledPositions.length) {
    ledGeometry = new THREE.BufferGeometry();
    ledGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ledPositions, 3));
    ledGeometry.setAttribute('ledColor', new THREE.Float32BufferAttribute(ledColors, 3));
    ledGeometry.setAttribute('blink', new THREE.Float32BufferAttribute(ledBlink, 1));
    ledGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(ledPhases, 1));
    ledGeometry.computeBoundingSphere();
    group.add(new THREE.Points(ledGeometry, materials.led));
  }

  return {
    chunkX,
    chunkZ,
    group,
    ledGeometry,
    emitters,
    colliders,
    dispose() {
      group.removeFromParent();
      meshes.forEach((mesh) => mesh.dispose());
      ledGeometry?.dispose();
      group.clear();
    },
  };
}

function pushCircleOutOfBox(position, box, radius = PLAYER_RADIUS) {
  const nearestX = clamp(position.x, box.minX, box.maxX);
  const nearestZ = clamp(position.y, box.minZ, box.maxZ);
  const dx = position.x - nearestX;
  const dz = position.y - nearestZ;
  const distanceSquared = dx * dx + dz * dz;
  if (distanceSquared >= radius * radius) return false;
  if (distanceSquared > 0.0000001) {
    const distance = Math.sqrt(distanceSquared);
    const push = (radius - distance) / distance;
    position.x += dx * push;
    position.y += dz * push;
    return true;
  }

  const left = Math.abs(position.x - box.minX);
  const right = Math.abs(box.maxX - position.x);
  const north = Math.abs(position.y - box.minZ);
  const south = Math.abs(box.maxZ - position.y);
  const minimum = Math.min(left, right, north, south);
  if (minimum === left) position.x = box.minX - radius;
  else if (minimum === right) position.x = box.maxX + radius;
  else if (minimum === north) position.y = box.minZ - radius;
  else position.y = box.maxZ + radius;
  return true;
}

function wallBoxesNear(seed, position) {
  const cellX = worldToCell(position.x);
  const cellZ = worldToCell(position.y);
  const half = CELL_SIZE / 2;
  const thickness = WALL_THICKNESS / 2;
  const boxes = [];
  for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      const centerX = cellToWorld(x);
      const centerZ = cellToWorld(z);
      if (hasWall(seed, x, z, 'north')) {
        boxes.push({
          minX: centerX - half,
          maxX: centerX + half,
          minZ: centerZ - half - thickness,
          maxZ: centerZ - half + thickness,
        });
      }
      if (hasWall(seed, x, z, 'west')) {
        boxes.push({
          minX: centerX - half - thickness,
          maxX: centerX - half + thickness,
          minZ: centerZ - half,
          maxZ: centerZ + half,
        });
      }
    }
  }
  return boxes;
}

export async function startEndlessDataCenter() {
  const dom = {
    game: document.querySelector('#game'),
    viewport: document.querySelector('#viewport'),
    overlay: document.querySelector('#overlay'),
    classification: document.querySelector('#classification'),
    overlayKicker: document.querySelector('#overlay-kicker'),
    overlayTitle: document.querySelector('#overlay-title'),
    overlayBody: document.querySelector('#overlay-body'),
    enterButton: document.querySelector('#enter-button'),
    enterLabel: document.querySelector('#enter-label'),
    controlsCopy: document.querySelector('#controls-copy'),
    experienceSwitch: document.querySelector('#experience-switch'),
    soundToggle: document.querySelector('#sound-toggle'),
    message: document.querySelector('#message'),
    grain: document.querySelector('#grain'),
    touchUi: document.querySelector('#touch-ui'),
    movePad: document.querySelector('#move-pad'),
    moveStick: document.querySelector('#move-stick'),
    touchLook: document.querySelector('#touch-look'),
    touchSprint: document.querySelector('#touch-sprint'),
    touchCrouch: document.querySelector('#touch-crouch'),
    touchLight: document.querySelector('#touch-light'),
    touchFlash: document.querySelector('#touch-flash'),
    touchAction: document.querySelector('#touch-action'),
    touchPause: document.querySelector('#touch-pause'),
    vhsTimestamp: document.querySelector('#vhs-timestamp'),
    vhsTimecode: document.querySelector('#vhs-timecode'),
    vhsSector: document.querySelector('#vhs-sector'),
    unsupported: document.querySelector('#unsupported'),
  };
  if (!supportsWebGL2()) {
    dom.unsupported?.classList.add('is-visible');
    return;
  }

  const query = new URLSearchParams(window.location.search);
  const mobile = query.has('touch') || window.matchMedia('(pointer: coarse)').matches;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const qaMode = query.has('qa');
  const requestedSeed = query.get('seed');
  let seed = requestedSeed === null
    ? Number(sessionStorage.getItem('threshold-endless-seed'))
    : Number(requestedSeed);
  if (!Number.isFinite(seed) || seed <= 0 || (query.has('fresh') && requestedSeed === null)) {
    seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }
  seed >>>= 0;
  sessionStorage.setItem('threshold-endless-seed', String(seed));

  dom.game.dataset.experience = 'endless';
  dom.game.dataset.worldMode = 'endless-data-center';
  dom.game.dataset.objectives = 'disabled';
  dom.game.dataset.combat = 'disabled';
  dom.game.dataset.monster = 'none';
  dom.game.dataset.seed = String(seed);
  dom.game.dataset.ready = 'false';
  dom.game.dataset.gameState = 'start';
  dom.game.setAttribute('aria-label', 'Endless data-center Backrooms exploration');
  dom.classification.textContent = 'THRESHOLD TAPE / SITE ∞';
  dom.overlayKicker.textContent = 'UNINDEXED EDGE FACILITY';
  dom.overlayTitle.innerHTML = 'NO EXIT<br />WAS INSTALLED.';
  dom.overlayBody.textContent = 'The aisles continue past the address space. Keep the camera running.';
  dom.enterLabel.textContent = 'BEGIN RECORDING';
  dom.controlsCopy.innerHTML = mobile
    ? '<span><b>LEFT</b> MOVE</span><span><b>RIGHT</b> LOOK</span><span><b>RUN</b> HOLD</span><span><b>LIGHT</b> TOGGLE</span>'
    : '<span><b>WASD</b> MOVE</span><span><b>MOUSE</b> LOOK</span><span><b>SHIFT</b> RUN</span><span><b>C</b> CROUCH</span><span><b>F</b> LIGHT</span><span><b>ESC</b> PAUSE</span>';
  if (dom.experienceSwitch) {
    dom.experienceSwitch.href = '?campaign=1&level=0';
    dom.experienceSwitch.textContent = 'PLAY 30-LEVEL CAMPAIGN';
  }
  document.title = 'SITE ∞ / THRESHOLD';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1820);
  scene.fog = new THREE.FogExp2(0x0b1820, mobile ? 0.021 : 0.019);
  const camera = new THREE.PerspectiveCamera(mobile ? 75 : 72, window.innerWidth / window.innerHeight, 0.05, 145);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = Math.PI;
  scene.add(camera);

  const renderer = new THREE.WebGLRenderer({
    antialias: !mobile,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = mobile ? 1.52 : 1.17;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1 : 1.45));
  renderer.setSize(window.innerWidth, window.innerHeight);
  dom.viewport.replaceChildren(renderer.domElement);

  const hemisphere = new THREE.HemisphereLight(0x7ca7b4, 0x10191d, mobile ? 0.98 : 0.68);
  const ambient = new THREE.AmbientLight(0x426c7c, mobile ? 0.54 : 0.27);
  scene.add(hemisphere, ambient);

  const flashlight = new THREE.SpotLight(0xd7f3ee, mobile ? 215 : 168, 24, 0.4, 0.74, 1.65);
  const flashlightTarget = new THREE.Object3D();
  flashlight.position.set(0, -0.08, 0.06);
  flashlightTarget.position.set(0, -0.06, -1);
  camera.add(flashlight, flashlightTarget);
  flashlight.target = flashlightTarget;
  const flashlightBounce = new THREE.PointLight(0xaad9d8, mobile ? 18 : 11, 5.4, 2);
  flashlightBounce.position.set(0, -0.28, -0.45);
  camera.add(flashlightBounce);

  const resources = createSharedResources();
  const chunks = new Map();
  const lightPool = Array.from({ length: mobile ? 4 : 8 }, () => {
    const light = new THREE.PointLight(0xb9e9e4, 0, 14.5, 2);
    scene.add(light);
    return light;
  });
  const audio = createEndlessAudio({ seed, volume: 0.72 });
  const controls = new PointerLockControls(camera, renderer.domElement);
  const keys = new Set();
  const player = new THREE.Vector2(0, 0);
  const velocity = new THREE.Vector2();
  const input = new THREE.Vector2();
  const direction = new THREE.Vector3();
  const right = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const touchInput = new THREE.Vector2();
  const saved = query.has('fresh') ? null : (() => {
    try {
      return JSON.parse(sessionStorage.getItem('threshold-endless-position') || 'null');
    } catch {
      return null;
    }
  })();
  if (saved?.seed === seed && Number.isFinite(saved.x) && Number.isFinite(saved.z)) {
    player.set(saved.x, saved.z);
    if (Number.isFinite(saved.yaw)) camera.rotation.y = saved.yaw;
  }

  let originX = Math.round(player.x / CHUNK_WORLD_SIZE) * CHUNK_WORLD_SIZE;
  let originZ = Math.round(player.y / CHUNK_WORLD_SIZE) * CHUNK_WORLD_SIZE;
  let emitterCache = [];
  let gameState = 'start';
  let elapsed = 0;
  let lastFrame = performance.now();
  let accumulator = 0;
  let stepDistance = 0;
  let headBob = 0;
  let currentEye = STANDING_EYE;
  let crouching = false;
  let touchSprint = false;
  let flashlightOn = true;
  let muted = false;
  let messageUntil = 0;
  let nextTapeMessage = 18;
  let lightRefreshAt = 0;
  let audioRefreshAt = 0;
  let vhsRefreshAt = 0;
  let saveAt = 0;
  const renderRadius = mobile ? 1 : 2;
  dom.touchLight?.setAttribute('aria-pressed', 'true');
  if (dom.touchLight) dom.touchLight.textContent = 'LIGHT ON';

  function refreshEmitterCache() {
    emitterCache = [...chunks.values()].flatMap((chunk) => chunk.emitters);
    audioRefreshAt = 0;
  }

  function repositionChunks() {
    for (const chunk of chunks.values()) {
      chunk.group.position.set(
        chunk.chunkX * CHUNK_WORLD_SIZE - originX,
        0,
        chunk.chunkZ * CHUNK_WORLD_SIZE - originZ,
      );
    }
  }

  function recenterRenderer() {
    if (
      Math.abs(player.x - originX) < FLOATING_ORIGIN_THRESHOLD
      && Math.abs(player.y - originZ) < FLOATING_ORIGIN_THRESHOLD
    ) return false;
    originX = Math.round(player.x / CHUNK_WORLD_SIZE) * CHUNK_WORLD_SIZE;
    originZ = Math.round(player.y / CHUNK_WORLD_SIZE) * CHUNK_WORLD_SIZE;
    repositionChunks();
    lightRefreshAt = 0;
    return true;
  }

  function updateChunks() {
    const playerCellX = worldToCell(player.x);
    const playerCellZ = worldToCell(player.y);
    const centerChunkX = chunkForCell(playerCellX);
    const centerChunkZ = chunkForCell(playerCellZ);
    const required = new Set();
    for (let chunkZ = centerChunkZ - renderRadius; chunkZ <= centerChunkZ + renderRadius; chunkZ += 1) {
      for (let chunkX = centerChunkX - renderRadius; chunkX <= centerChunkX + renderRadius; chunkX += 1) {
        const key = chunkKey(chunkX, chunkZ);
        required.add(key);
        if (chunks.has(key)) continue;
        const chunk = createChunk({ seed, chunkX, chunkZ, originX, originZ, resources });
        chunks.set(key, chunk);
        scene.add(chunk.group);
      }
    }
    for (const [key, chunk] of chunks) {
      if (required.has(key)) continue;
      chunk.dispose();
      chunks.delete(key);
    }
    refreshEmitterCache();
    lightRefreshAt = 0;
    dom.game.dataset.chunkCount = String(chunks.size);
    dom.game.dataset.sector = `${centerChunkX}:${centerChunkZ}`;
    if (dom.vhsSector) dom.vhsSector.textContent = `SECTOR ${signed(centerChunkX)} / ${signed(centerChunkZ)}`;
  }

  function nearbyPropColliders() {
    const chunkX = chunkForCell(worldToCell(player.x));
    const chunkZ = chunkForCell(worldToCell(player.y));
    const result = [];
    for (let z = chunkZ - 1; z <= chunkZ + 1; z += 1) {
      for (let x = chunkX - 1; x <= chunkX + 1; x += 1) {
        const chunk = chunks.get(chunkKey(x, z));
        if (!chunk) continue;
        for (const box of chunk.colliders) {
          if (
            box.maxX < player.x - CELL_SIZE
            || box.minX > player.x + CELL_SIZE
            || box.maxZ < player.y - CELL_SIZE
            || box.minZ > player.y + CELL_SIZE
          ) continue;
          result.push(box);
        }
      }
    }
    return result;
  }

  function resolveCollision() {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      let changed = false;
      for (const box of wallBoxesNear(seed, player)) changed = pushCircleOutOfBox(player, box) || changed;
      for (const box of nearbyPropColliders()) changed = pushCircleOutOfBox(player, box) || changed;
      if (!changed) break;
    }
  }

  function fixtureIntensity(emitter, time) {
    if (emitter.state === 'warm') return 38;
    if (emitter.state !== 'flicker') return 30 + Math.sin(time * 2 + emitter.phase * 7) * 1.5;
    const wave = Math.sin(time * (15 + emitter.phase * 9) + emitter.phase * 31);
    const dropout = Math.sin(time * 3.1 + emitter.phase * 71) > 0.88;
    return dropout ? 1.2 : 12 + Math.max(0, wave) * 34;
  }

  function updateLights(force = false) {
    if (!force && elapsed < lightRefreshAt) return;
    lightRefreshAt = elapsed + 0.24;
    const fixtures = emitterCache
      .filter((emitter) => emitter.type === 'fluorescent')
      .map((emitter) => ({
        emitter,
        distance: Math.hypot(emitter.position.x - player.x, emitter.position.z - player.y),
      }))
      .filter((entry) => entry.distance < 19)
      .sort((left, right) => (
        left.distance - right.distance
        || String(left.emitter.id).localeCompare(String(right.emitter.id))
      ));
    lightPool.forEach((light, index) => {
      const entry = fixtures[index];
      if (!entry) {
        light.intensity = 0;
        light.userData.emitter = null;
        return;
      }
      const { emitter } = entry;
      light.position.set(emitter.position.x - originX, 2.82, emitter.position.z - originZ);
      light.color.set(emitter.state === 'warm' ? 0xffd18c : 0xb8ede6);
      light.userData.emitter = emitter;
      light.intensity = fixtureIntensity(emitter, elapsed);
    });
  }

  function animateFixturePresentation() {
    resources.materials.fixtureFlicker.forEach((material, index) => {
      const wave = Math.sin(elapsed * (12.5 + index * 3.2) + index * 2.7);
      const dropout = Math.sin(elapsed * (2.1 + index * 0.3) + index * 11) > 0.92;
      material.emissiveIntensity = dropout ? 0.06 : 0.7 + Math.max(0, wave) * 2.3;
    });
    resources.materials.fixtureSteady.emissiveIntensity = 2.25 + Math.sin(elapsed * 0.73) * 0.14;
    resources.materials.led.uniforms.time.value = elapsed;
    for (const light of lightPool) {
      if (!light.userData.emitter) continue;
      light.intensity = fixtureIntensity(light.userData.emitter, elapsed);
    }
  }

  function showMessage(text, duration = 1.1) {
    if (!dom.message) return;
    dom.message.textContent = text;
    dom.message.classList.add('is-visible');
    messageUntil = elapsed + duration;
  }

  function updateVhs() {
    if (elapsed < vhsRefreshAt) return;
    vhsRefreshAt = elapsed + 1 / 10;
    if (dom.vhsTimestamp) dom.vhsTimestamp.textContent = formatTimestamp(elapsed);
    if (dom.vhsTimecode) {
      dom.vhsTimecode.textContent = formatTimecode(elapsed);
      dom.vhsTimecode.dateTime = `PT${Math.floor(elapsed)}S`;
    }
  }

  const grainContext = dom.grain?.getContext('2d', { alpha: true });
  let grainImage = null;
  let grainAt = 0;
  if (grainContext) {
    dom.grain.width = 320;
    dom.grain.height = 180;
    grainImage = grainContext.createImageData(dom.grain.width, dom.grain.height);
  }

  function updateGrain(now) {
    if (!grainContext || !grainImage || (reducedMotion && grainAt > 0) || now < grainAt) return;
    grainAt = now + (reducedMotion ? 1000 : 82);
    const pixels = grainImage.data;
    const dropoutRow = Math.floor(Math.random() * dom.grain.height);
    for (let index = 0; index < pixels.length; index += 4) {
      const pixel = index / 4;
      const row = Math.floor(pixel / dom.grain.width);
      const value = 96 + Math.floor(Math.random() * 90);
      pixels[index] = value;
      pixels[index + 1] = value + 4;
      pixels[index + 2] = value + 1;
      pixels[index + 3] = row === dropoutRow ? 75 : 18 + Math.floor(Math.random() * 22);
    }
    grainContext.putImageData(grainImage, 0, 0);
  }

  function setFlashlight(on) {
    flashlightOn = Boolean(on);
    flashlight.visible = flashlightOn;
    flashlightBounce.visible = flashlightOn;
    dom.touchLight?.setAttribute('aria-pressed', String(flashlightOn));
    if (dom.touchLight) dom.touchLight.textContent = flashlightOn ? 'LIGHT ON' : 'LIGHT OFF';
    showMessage(flashlightOn ? 'CAMERA LIGHT ON' : 'CAMERA LIGHT OFF', 0.55);
  }

  function hideOverlay() {
    dom.overlay.classList.add('is-dismissing');
    window.setTimeout(() => dom.overlay.classList.remove('is-visible', 'is-dismissing'), reducedMotion ? 80 : 820);
    if (mobile) dom.touchUi?.classList.add('is-visible');
  }

  function showPauseOverlay() {
    gameState = 'paused';
    dom.game.dataset.gameState = gameState;
    dom.overlay.dataset.mode = 'pause';
    dom.classification.textContent = 'THRESHOLD TAPE / SIGNAL HELD';
    dom.overlayKicker.textContent = 'TRACKING INTERRUPTED';
    dom.overlayTitle.innerHTML = 'THE AISLES<br />KEPT MOVING.';
    dom.overlayBody.textContent = 'The fans did not pause with the recording.';
    dom.enterLabel.textContent = 'RESUME RECORDING';
    dom.overlay.classList.remove('is-dismissing');
    dom.overlay.classList.add('is-visible');
    dom.touchUi?.classList.remove('is-visible');
    audio.suspend();
  }

  function beginPlay() {
    gameState = 'playing';
    dom.game.dataset.gameState = gameState;
    dom.game.dataset.landing = 'false';
    hideOverlay();
    audio.start();
    audio.resume();
    lastFrame = performance.now();
  }

  controls.addEventListener('lock', beginPlay);
  controls.addEventListener('unlock', () => {
    keys.clear();
    velocity.multiplyScalar(0.2);
    if (gameState === 'playing') showPauseOverlay();
  });
  document.addEventListener('pointerlockerror', () => {
    showPauseOverlay();
    dom.overlayBody.textContent = 'Pointer lock was blocked. Select the button to try again.';
  });

  dom.overlay.addEventListener('pointerdown', () => audio.start(), { passive: true });
  dom.enterButton.addEventListener('click', () => {
    audio.start();
    if (mobile || qaMode) beginPlay();
    else controls.lock();
  });
  dom.soundToggle.addEventListener('click', () => {
    muted = !muted;
    audio.setMuted(muted);
    dom.soundToggle.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
    dom.soundToggle.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
  });

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'KeyF') setFlashlight(!flashlightOn);
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => {
    keys.clear();
    touchInput.set(0, 0);
    touchSprint = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend();
    else if (gameState === 'playing') audio.resume();
  });

  if (mobile) {
    let movePointer = null;
    const updateMove = (event) => {
      const rect = dom.movePad.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = event.clientX - centerX;
      let dy = event.clientY - centerY;
      const maximum = rect.width * 0.33;
      const distance = Math.hypot(dx, dy);
      if (distance > maximum) {
        dx = dx / distance * maximum;
        dy = dy / distance * maximum;
      }
      touchInput.set(dx / maximum, -dy / maximum);
      dom.moveStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };
    dom.movePad.addEventListener('pointerdown', (event) => {
      movePointer = event.pointerId;
      dom.movePad.setPointerCapture(event.pointerId);
      updateMove(event);
    });
    dom.movePad.addEventListener('pointermove', (event) => {
      if (event.pointerId === movePointer) updateMove(event);
    });
    const releaseMove = (event) => {
      if (event.pointerId !== movePointer) return;
      movePointer = null;
      touchInput.set(0, 0);
      dom.moveStick.style.transform = 'translate(-50%, -50%)';
    };
    dom.movePad.addEventListener('pointerup', releaseMove);
    dom.movePad.addEventListener('pointercancel', releaseMove);

    let lookPointer = null;
    let lookX = 0;
    let lookY = 0;
    dom.touchLook.addEventListener('pointerdown', (event) => {
      lookPointer = event.pointerId;
      lookX = event.clientX;
      lookY = event.clientY;
      dom.touchLook.setPointerCapture(event.pointerId);
    });
    dom.touchLook.addEventListener('pointermove', (event) => {
      if (event.pointerId !== lookPointer) return;
      const dx = event.clientX - lookX;
      const dy = event.clientY - lookY;
      lookX = event.clientX;
      lookY = event.clientY;
      camera.rotation.y -= dx * 0.0042;
      camera.rotation.x = clamp(camera.rotation.x - dy * 0.0036, -1.32, 1.32);
    });
    const releaseLook = (event) => {
      if (event.pointerId === lookPointer) lookPointer = null;
    };
    dom.touchLook.addEventListener('pointerup', releaseLook);
    dom.touchLook.addEventListener('pointercancel', releaseLook);
    dom.touchSprint.addEventListener('pointerdown', (event) => {
      touchSprint = true;
      dom.touchSprint.setPointerCapture(event.pointerId);
    });
    dom.touchSprint.addEventListener('pointerup', () => { touchSprint = false; });
    dom.touchSprint.addEventListener('pointercancel', () => { touchSprint = false; });
    dom.touchCrouch.addEventListener('click', () => {
      crouching = !crouching;
      dom.touchCrouch.textContent = crouching ? 'CROUCHED' : 'CROUCH';
      dom.touchCrouch.setAttribute('aria-pressed', String(crouching));
    });
    dom.touchLight.addEventListener('click', () => setFlashlight(!flashlightOn));
    dom.touchPause.addEventListener('click', showPauseOverlay);
    dom.touchFlash.hidden = true;
    dom.touchAction.hidden = true;
  }

  function simulatePlayer(delta) {
    const forwardInput = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + touchInput.y;
    const strafeInput = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
      - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + touchInput.x;
    input.set(strafeInput, forwardInput);
    if (input.lengthSq() > 1) input.normalize();

    camera.getWorldDirection(direction);
    direction.y = 0;
    direction.normalize();
    right.crossVectors(direction, UP).normalize();
    desired.copy(direction).multiplyScalar(input.y).addScaledVector(right, input.x);
    if (desired.lengthSq() > 1) desired.normalize();
    const moving = input.lengthSq() > 0.01;
    const keyboardCrouch = keys.has('KeyC') || keys.has('ControlLeft') || keys.has('ControlRight');
    const activeCrouch = crouching || keyboardCrouch;
    const running = moving && !activeCrouch && (
      touchSprint || keys.has('ShiftLeft') || keys.has('ShiftRight')
    );
    const targetSpeed = activeCrouch ? 1.25 : running ? 4.15 : 2.3;
    const response = 1 - Math.exp(-(moving ? 12 : 16) * delta);
    velocity.x = lerp(velocity.x, desired.x * targetSpeed, response);
    velocity.y = lerp(velocity.y, desired.z * targetSpeed, response);

    const displacementX = velocity.x * delta;
    const displacementZ = velocity.y * delta;
    const steps = Math.max(1, Math.ceil(Math.hypot(displacementX, displacementZ) / (PLAYER_RADIUS * 0.35)));
    for (let step = 0; step < steps; step += 1) {
      player.x += displacementX / steps;
      player.y += displacementZ / steps;
      resolveCollision();
    }

    const speed = velocity.length();
    if (moving && speed > 0.25) {
      stepDistance += speed * delta;
      const stride = running ? 1.45 : activeCrouch ? 2.1 : 1.75;
      if (stepDistance >= stride) {
        stepDistance = 0;
        audio.footstep(running);
      }
      headBob += delta * speed * (running ? 3 : 2.45);
    }
    currentEye = lerp(currentEye, activeCrouch ? CROUCH_EYE : STANDING_EYE, 1 - Math.exp(-9 * delta));
    const bob = reducedMotion || activeCrouch ? 0 : Math.sin(headBob * Math.PI) * Math.min(speed / 4, 1) * 0.03;
    recenterRenderer();
    camera.position.set(player.x - originX, currentEye + bob, player.y - originZ);
  }

  function updateAudio() {
    if (elapsed < audioRefreshAt) return;
    audioRefreshAt = elapsed + 0.1;
    audio.update({
      listener: { x: player.x, y: currentEye, z: player.y, yaw: camera.rotation.y },
      emitters: emitterCache,
      elapsed,
    });
  }

  function persistPosition() {
    sessionStorage.setItem('threshold-endless-position', JSON.stringify({
      seed,
      x: player.x,
      z: player.y,
      yaw: camera.rotation.y,
    }));
  }

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1 : 1.45));
  }
  window.addEventListener('resize', resize);
  window.addEventListener('pagehide', () => {
    persistPosition();
    chunks.forEach((chunk) => chunk.dispose());
    chunks.clear();
    Object.values(resources.geometries).forEach((geometry) => geometry.dispose());
    Object.values(resources.materials).flat().forEach((material) => material.dispose());
    renderer.dispose();
    audio.dispose();
  }, { once: true });

  updateChunks();
  camera.position.set(player.x - originX, STANDING_EYE, player.y - originZ);
  updateLights(true);
  dom.game.dataset.ready = 'true';
  dom.game.setAttribute('aria-busy', 'false');
  dom.enterButton.focus({ preventScroll: true });
  if (qaMode) {
    beginPlay();
    if (query.has('autowalk')) keys.add('KeyW');
  }

  let previousCellX = worldToCell(player.x);
  let previousCellZ = worldToCell(player.y);
  function animate(now) {
    requestAnimationFrame(animate);
    const delta = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    if (gameState === 'playing') {
      elapsed += delta;
      accumulator += delta;
      while (accumulator >= 1 / 90) {
        simulatePlayer(1 / 90);
        accumulator -= 1 / 90;
      }
      const cellX = worldToCell(player.x);
      const cellZ = worldToCell(player.y);
      if (cellX !== previousCellX || cellZ !== previousCellZ) {
        const previousChunkX = chunkForCell(previousCellX);
        const previousChunkZ = chunkForCell(previousCellZ);
        previousCellX = cellX;
        previousCellZ = cellZ;
        if (chunkForCell(cellX) !== previousChunkX || chunkForCell(cellZ) !== previousChunkZ) updateChunks();
      }
      updateLights();
      animateFixturePresentation();
      updateAudio();
      updateVhs();
      if (elapsed >= nextTapeMessage) {
        const index = hashCoordinates(seed, Math.floor(elapsed / 12), cellX + cellZ, 0x3c6ef372)
          % TAPE_MESSAGES.length;
        showMessage(TAPE_MESSAGES[index], 1.25);
        nextTapeMessage = elapsed + 17 + hashUnit(seed, cellX, cellZ, 0xbb67ae85) * 23;
      }
      if (messageUntil && elapsed > messageUntil) {
        dom.message.classList.remove('is-visible');
        dom.message.textContent = '';
        messageUntil = 0;
      }
      if (elapsed >= saveAt) {
        saveAt = elapsed + 3;
        persistPosition();
      }
      dom.game.dataset.playerCell = `${cellX}:${cellZ}`;
    }
    updateGrain(now);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}
