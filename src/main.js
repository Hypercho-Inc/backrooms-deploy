import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { LEVELS, LEVEL_IDS, getLevelIndex } from './levels/index.js';
import { createGameContentFingerprint } from './levels/fingerprint.js';
import { animateMonster, buildMonster } from './monster.js';
import { createMultiplayerClient } from './multiplayer.js';
import { createRemotePlayerManager } from './remote-players.js';
import { createWaitingRoomPreview } from './waiting-room-preview.js';
import { characterCatalog } from './characters/index.js';
import { createVoiceChat } from './voice-chat.js';
import { createAtmosphereDirector } from './atmosphere.js';
import { buildIncidentGroup, planIncidents } from './incidents.js';
import { chooseSpacedCells, enumerateCellIndexes } from './content-placement.js';
import {
  ROOM_CAPACITY,
  SURVIVOR_LOOKS,
  survivorLook,
  waitingRoomModel,
} from './waiting-room.js';
import {
  perceptionProfile,
  spendFlash,
  stepBattery,
  stepFear,
  stepHiding,
  stepNoiseImpulse,
} from './survival.js';
const N = 1;
const E = 2;
const S = 4;
const W = 8;
const DIRECTIONS = [
  { bit: N, opposite: S, dc: 0, dr: -1 },
  { bit: E, opposite: W, dc: 1, dr: 0 },
  { bit: S, opposite: N, dc: 0, dr: 1 },
  { bit: W, opposite: E, dc: -1, dr: 0 },
];
const GAME_CONTENT_FINGERPRINT = createGameContentFingerprint(LEVELS, characterCatalog.definitions);

const CELL_SIZE = 4;
const WALL_HEIGHT = 3.05;
const WALL_THICKNESS = 0.17;
const EYE_HEIGHT = 1.62;
const PLAYER_RADIUS = 0.31;

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
  status: document.querySelector('#status'),
  levelLabel: document.querySelector('#level-label'),
  objective: document.querySelector('#objective'),
  coopHud: document.querySelector('#coop-hud'),
  coopRoom: document.querySelector('#coop-room'),
  coopRoster: document.querySelector('#coop-roster'),
  voiceControls: document.querySelector('#voice-controls'),
  voiceToggle: document.querySelector('#voice-toggle'),
  micToggle: document.querySelector('#mic-toggle'),
  voiceState: document.querySelector('#voice-state'),
  coopLobby: document.querySelector('#coop-lobby'),
  modeSolo: document.querySelector('#mode-solo'),
  modeHost: document.querySelector('#mode-host'),
  modeJoin: document.querySelector('#mode-join'),
  modeRooms: document.querySelector('#mode-rooms'),
  coopForm: document.querySelector('#coop-form'),
  playerName: document.querySelector('#player-name'),
  roomCodeField: document.querySelector('#room-code-field'),
  roomCode: document.querySelector('#room-code'),
  roomVisibility: document.querySelector('#room-visibility'),
  coopConnect: document.querySelector('#coop-connect'),
  roomDirectory: document.querySelector('#room-directory'),
  roomDirectoryCount: document.querySelector('#room-directory-count'),
  roomList: document.querySelector('#room-list'),
  roomDirectoryEmpty: document.querySelector('#room-directory-empty'),
  waitingRoom: document.querySelector('#waiting-room'),
  waitingRoomCount: document.querySelector('#waiting-room-count'),
  waitingSlots: document.querySelector('#waiting-slots'),
  lookPicker: document.querySelector('#look-picker'),
  waitingRoomStatus: document.querySelector('#waiting-room-status'),
  coopState: document.querySelector('#coop-state'),
  copyInvite: document.querySelector('#copy-invite'),
  soundToggle: document.querySelector('#sound-toggle'),
  interact: document.querySelector('#interact'),
  message: document.querySelector('#message'),
  stamina: document.querySelector('#stamina'),
  staminaFill: document.querySelector('#stamina span'),
  flashlightHud: document.querySelector('#flashlight-hud'),
  flashlightLabel: document.querySelector('#flashlight-label'),
  flashlightFill: document.querySelector('#flashlight-hud i'),
  evidenceState: document.querySelector('#evidence-state'),
  stealthState: document.querySelector('#stealth-state'),
  threat: document.querySelector('#threat'),
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
  unsupported: document.querySelector('#unsupported'),
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const rgbInt = ([red, green, blue]) => (red << 16) | (green << 8) | blue;
const randomBetween = ([minimum, maximum], random) => minimum + random() * (maximum - minimum);

function shuffleInPlace(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function normalizeCallsign(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
}

function normalizeRoomCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function eventDetail(event) {
  return event?.detail ?? event ?? {};
}

function playerColor(id, lookId) {
  const explicitLook = SURVIVOR_LOOKS.find((look) => look.id === String(lookId || '').toLowerCase());
  if (explicitLook) return explicitLook.color;
  const text = String(id || 'team');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const colors = [0x596653, 0x687261, 0x6d6553, 0x52696c, 0x70615b, 0x5f6b59];
  return colors[Math.abs(hash) % colors.length];
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

class Maze {
  constructor(cols, rows, seed, options = {}) {
    this.cols = cols;
    this.rows = rows;
    this.seed = seed;
    this.options = options;
    this.random = mulberry32(seed);
    this.cells = new Uint8Array(cols * rows);
    this.cells.fill(N | E | S | W);
    this.generate();
  }

  index(col, row) {
    return row * this.cols + col;
  }

  coords(index) {
    return { col: index % this.cols, row: Math.floor(index / this.cols) };
  }

  valid(col, row) {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  generate() {
    const visited = new Uint8Array(this.cells.length);
    const start = this.index(Math.floor(this.cols / 2), Math.floor(this.rows / 2));
    const stack = [start];
    visited[start] = 1;

    while (stack.length) {
      const current = stack[stack.length - 1];
      const { col, row } = this.coords(current);
      const choices = [];

      for (const direction of DIRECTIONS) {
        const nextCol = col + direction.dc;
        const nextRow = row + direction.dr;
        if (!this.valid(nextCol, nextRow)) continue;
        const next = this.index(nextCol, nextRow);
        if (!visited[next]) choices.push({ direction, next });
      }

      if (!choices.length) {
        stack.pop();
        continue;
      }

      const choice = choices[Math.floor(this.random() * choices.length)];
      this.cells[current] &= ~choice.direction.bit;
      this.cells[choice.next] &= ~choice.direction.opposite;
      visited[choice.next] = 1;
      stack.push(choice.next);
    }

    const extraOpenings = Math.floor(this.cells.length * (this.options.loopRatio ?? 0.19));
    for (let i = 0; i < extraOpenings; i += 1) {
      const col = Math.floor(this.random() * this.cols);
      const row = Math.floor(this.random() * this.rows);
      const internalDirections = DIRECTIONS.filter((direction) =>
        this.valid(col + direction.dc, row + direction.dr),
      );
      const direction = internalDirections[Math.floor(this.random() * internalDirections.length)];
      this.removeWall(col, row, direction);
    }

    const roomCount = Math.max(
      this.options.minRooms ?? 8,
      Math.floor(this.cells.length / (this.options.roomDivisor ?? 54)),
    );
    const roomMinimum = this.options.roomSize?.min ?? 2;
    const roomMaximum = this.options.roomSize?.max ?? 4;
    for (let i = 0; i < roomCount; i += 1) {
      const width = roomMinimum + Math.floor(this.random() * (roomMaximum - roomMinimum + 1));
      const height = roomMinimum + Math.floor(this.random() * (roomMaximum - roomMinimum + 1));
      const originCol = 1 + Math.floor(this.random() * (this.cols - width - 2));
      const originRow = 1 + Math.floor(this.random() * (this.rows - height - 2));

      for (let row = originRow; row < originRow + height; row += 1) {
        for (let col = originCol; col < originCol + width; col += 1) {
          if (col < originCol + width - 1) this.removeWall(col, row, DIRECTIONS[1]);
          if (row < originRow + height - 1) this.removeWall(col, row, DIRECTIONS[2]);
        }
      }
    }
  }

  removeWall(col, row, direction) {
    const nextCol = col + direction.dc;
    const nextRow = row + direction.dr;
    if (!this.valid(col, row) || !this.valid(nextCol, nextRow)) return;
    const current = this.index(col, row);
    const next = this.index(nextCol, nextRow);
    this.cells[current] &= ~direction.bit;
    this.cells[next] &= ~direction.opposite;
  }

  hasWall(index, bit) {
    return Boolean(this.cells[index] & bit);
  }

  neighbors(index) {
    const { col, row } = this.coords(index);
    const result = [];
    for (const direction of DIRECTIONS) {
      if (this.hasWall(index, direction.bit)) continue;
      const nextCol = col + direction.dc;
      const nextRow = row + direction.dr;
      if (this.valid(nextCol, nextRow)) result.push(this.index(nextCol, nextRow));
    }
    return result;
  }

  distanceMap(startIndex) {
    const distances = new Int16Array(this.cells.length);
    distances.fill(-1);
    const queue = [startIndex];
    distances[startIndex] = 0;
    let cursor = 0;

    while (cursor < queue.length) {
      const current = queue[cursor++];
      for (const next of this.neighbors(current)) {
        if (distances[next] !== -1) continue;
        distances[next] = distances[current] + 1;
        queue.push(next);
      }
    }
    return distances;
  }

  farthestFrom(startIndex) {
    const distances = this.distanceMap(startIndex);
    let farthest = startIndex;
    for (let i = 0; i < distances.length; i += 1) {
      if (distances[i] > distances[farthest]) farthest = i;
    }
    return farthest;
  }

  shortestPath(startIndex, targetIndex) {
    if (startIndex === targetIndex) return [startIndex];
    const previous = new Int32Array(this.cells.length);
    previous.fill(-1);
    const queue = [startIndex];
    previous[startIndex] = startIndex;
    let cursor = 0;

    while (cursor < queue.length) {
      const current = queue[cursor++];
      if (current === targetIndex) break;
      for (const next of this.neighbors(current)) {
        if (previous[next] !== -1) continue;
        previous[next] = current;
        queue.push(next);
      }
    }

    if (previous[targetIndex] === -1) return [];
    const path = [];
    let current = targetIndex;
    while (current !== startIndex) {
      path.push(current);
      current = previous[current];
    }
    path.push(startIndex);
    return path.reverse();
  }

  cellToWorld(index) {
    const { col, row } = this.coords(index);
    return new THREE.Vector3(
      (col - (this.cols - 1) / 2) * CELL_SIZE,
      0,
      (row - (this.rows - 1) / 2) * CELL_SIZE,
    );
  }

  worldToCell(x, z) {
    const col = clamp(Math.round(x / CELL_SIZE + (this.cols - 1) / 2), 0, this.cols - 1);
    const row = clamp(Math.round(z / CELL_SIZE + (this.rows - 1) / 2), 0, this.rows - 1);
    return this.index(col, row);
  }

  wallSegments() {
    const segments = [];
    const half = CELL_SIZE / 2;
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const index = this.index(col, row);
        const center = this.cellToWorld(index);
        if (this.hasWall(index, N)) {
          segments.push({ x: center.x, z: center.z - half, horizontal: true });
        }
        if (this.hasWall(index, W)) {
          segments.push({ x: center.x - half, z: center.z, horizontal: false });
        }
        if (row === this.rows - 1 && this.hasWall(index, S)) {
          segments.push({ x: center.x, z: center.z + half, horizontal: true });
        }
        if (col === this.cols - 1 && this.hasWall(index, E)) {
          segments.push({ x: center.x + half, z: center.z, horizontal: false });
        }
      }
    }
    return segments;
  }

  randomCellAtDistance(originIndex, minDistance, maxDistance, random = Math.random) {
    const distances = this.distanceMap(originIndex);
    const options = [];
    for (let i = 0; i < distances.length; i += 1) {
      if (distances[i] >= minDistance && distances[i] <= maxDistance) options.push(i);
    }
    if (!options.length) return this.farthestFrom(originIndex);
    return options[Math.floor(random() * options.length)];
  }
}

class AudioEngine {
  constructor(profile = {}) {
    this.profile = profile;
    this.context = null;
    this.master = null;
    this.hum = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.dipUntil = 0;
    this.nextBeat = 0;
    this.nextThreatSound = 0;
    this.nextAmbientSound = 0;
  }

  async start() {
    if (this.context) {
      if (this.context.state !== 'running') await this.context.resume();
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : (this.profile.masterGain ?? 0.72);
    this.master.connect(this.context.destination);

    this.hum = this.context.createGain();
    this.hum.gain.value = this.profile.humGain ?? 0.055;
    this.hum.connect(this.master);

    const oscillators = this.profile.oscillators || [
      { frequency: 60, type: 'sine', gain: 0.22 },
      { frequency: 120, type: 'triangle', gain: 0.065 },
      { frequency: 180, type: 'sine', gain: 0.025 },
      { frequency: 31, type: 'sine', gain: 0.09 },
    ];

    for (const config of oscillators) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = config.type;
      oscillator.frequency.value = config.frequency;
      oscillator.detune.value = (Math.random() - 0.5) * 5;
      gain.gain.value = config.gain;
      oscillator.connect(gain).connect(this.hum);
      oscillator.start();
    }

    this.noiseBuffer = this.createNoiseBuffer(2.4);
    const noise = this.context.createBufferSource();
    const bandpass = this.context.createBiquadFilter();
    const noiseGain = this.context.createGain();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    bandpass.type = this.profile.noise?.filter || 'bandpass';
    bandpass.frequency.value = this.profile.noise?.frequency || 580;
    bandpass.Q.value = this.profile.noise?.q ?? 0.46;
    noiseGain.gain.value = this.profile.noise?.gain ?? 0.025;
    noise.connect(bandpass).connect(noiseGain).connect(this.hum);
    noise.start();
  }

  createNoiseBuffer(duration) {
    const length = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.82 + white * 0.18;
      channel[i] = last;
    }
    return buffer;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(muted ? 0 : (this.profile.masterGain ?? 0.72), this.context.currentTime, 0.025);
  }

  suspend() {
    if (this.context?.state === 'running') this.context.suspend();
  }

  resume() {
    if (this.context?.state === 'suspended') this.context.resume();
  }

  update(tension, elapsed, threat = null) {
    if (!this.context || !this.hum) return;
    const now = this.context.currentTime;
    const dipped = elapsed < this.dipUntil;
    const baseHum = this.profile.humGain ?? 0.055;
    const target = dipped ? 0.004 : baseHum - 0.003 + tension * 0.016 + Math.sin(elapsed * 0.81) * 0.0025;
    this.hum.gain.setTargetAtTime(target, now, dipped ? 0.03 : 0.18);

    if (tension > 0.56 && now > this.nextBeat) {
      this.heartbeat(0.15 + tension * 0.24);
      this.nextBeat = now + lerp(1.25, 0.54, tension);
    }

    if (threat && threat.distance < 19 && now > this.nextThreatSound) {
      this.monsterBreath(threat.pan, threat.distance, threat.mode === 'chase');
      this.nextThreatSound = now + (threat.mode === 'chase' ? 1.2 : 2.4) + Math.random() * 0.8;
    }

    if (this.profile.drips && now > this.nextAmbientSound) {
      this.drip(Math.random() * 2 - 1);
      this.nextAmbientSound = now + 3 + Math.random() * 7;
    }
  }

  powerDip(elapsed, duration = 1.1) {
    this.dipUntil = Math.max(this.dipUntil, elapsed + duration);
    if (!this.context) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(148, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.16);
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.22);
  }

  footstep(running = false) {
    if (!this.context || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = running ? 1.28 : 0.92 + Math.random() * 0.14;
    filter.type = 'lowpass';
    filter.frequency.value = running
      ? (this.profile.footstep?.runLowpass || 310)
      : (this.profile.footstep?.walkLowpass || 240);
    filter.Q.value = 0.9;
    gain.gain.setValueAtTime(running ? 0.18 : 0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (running ? 0.11 : 0.15));
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now, Math.random() * 1.6, 0.18);
    source.stop(now + 0.2);
  }

  scare(pan = 0) {
    if (!this.context || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const panner = this.context.createStereoPanner();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.22 + Math.random() * 0.14;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(170, now);
    filter.frequency.exponentialRampToValueAtTime(520, now + 1.15);
    filter.Q.value = 3.4;
    panner.pan.value = clamp(pan, -1, 1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start(now, Math.random() * 0.8, 1.6);
    source.stop(now + 1.65);
  }

  heartbeat(gainValue) {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const offset of [0, 0.16]) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(this.profile.heartbeat?.startFrequency || 64, now + offset);
      oscillator.frequency.exponentialRampToValueAtTime(this.profile.heartbeat?.endFrequency || 36, now + offset + 0.12);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(gainValue, now + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.18);
    }
  }

  impact() {
    if (!this.context) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(this.profile.impact?.startFrequency || 51, now);
    oscillator.frequency.exponentialRampToValueAtTime(this.profile.impact?.endFrequency || 19, now + 0.75);
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.95);
  }

  monsterStep(pan, distance, running = false, sound = {}) {
    if (!this.context || !this.noiseBuffer || distance > 22) return;
    sound = Object.keys(sound).length ? sound : (this.profile.monsterSound || {});
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const panner = this.context.createStereoPanner();
    const gain = this.context.createGain();
    const proximity = clamp(1 - distance / 22, 0, 1);
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = (running ? 0.54 : 0.39) * lerp(1, 0.78, clamp(Number(sound.drag) || 0, 0, 1));
    filter.type = 'lowpass';
    filter.frequency.value = running ? 155 : 112;
    panner.pan.value = clamp(pan, -1, 1);
    gain.gain.setValueAtTime(0.2 * proximity * clamp(Number(sound.stepWeight) || 1, 0.35, 1.6), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start(now, Math.random() * 1.4, 0.3);
    source.stop(now + 0.32);
  }

  monsterBreath(pan, distance, chasing, sound = {}) {
    if (!this.context || !this.noiseBuffer) return;
    sound = Object.keys(sound).length ? sound : (this.profile.monsterSound || {});
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const panner = this.context.createStereoPanner();
    const gain = this.context.createGain();
    const proximity = clamp(1 - distance / 20, 0, 1);
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = (chasing ? 0.2 : 0.14) * clamp(Number(sound.breathPitch) || 1, 0.4, 1.4);
    filter.type = 'bandpass';
    filter.frequency.value = chasing ? 145 : 92;
    filter.Q.value = 1.4;
    panner.pan.value = clamp(pan, -1, 1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      (chasing ? 0.2 : 0.12) * proximity * clamp(Number(sound.breathWeight) || 1, 0.3, 1.5),
      now + 0.16,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
    source.connect(filter).connect(panner).connect(gain).connect(this.master);
    source.start(now, Math.random() * 0.8, 1.1);
    source.stop(now + 1.12);
  }

  objectiveComplete() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const [index, frequency] of [196, 247, 330].entries()) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.055, now + index * 0.08 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.08 + 0.42);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now + index * 0.08);
      oscillator.stop(now + index * 0.08 + 0.45);
    }
  }

  flashBurst() {
    if (!this.context || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const capacitor = this.context.createOscillator();
    const capacitorGain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 2.6;
    filter.type = 'highpass';
    filter.frequency.value = 1600;
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    capacitor.type = 'sine';
    capacitor.frequency.setValueAtTime(2100, now + 0.04);
    capacitor.frequency.exponentialRampToValueAtTime(480, now + 0.24);
    capacitorGain.gain.setValueAtTime(0.055, now + 0.04);
    capacitorGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    source.connect(filter).connect(gain).connect(this.master);
    capacitor.connect(capacitorGain).connect(this.master);
    source.start(now, Math.random() * 1.2, 0.13);
    source.stop(now + 0.14);
    capacitor.start(now + 0.04);
    capacitor.stop(now + 0.27);
  }

  archivePickup() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const [index, frequency] of [880, 660, 440].entries()) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = index === 1 ? 'square' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.035, now + index * 0.045 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.045 + 0.13);
      oscillator.connect(gain).connect(this.master);
      oscillator.start(now + index * 0.045);
      oscillator.stop(now + index * 0.045 + 0.15);
    }
  }

  phantomStep(pan = 0, heavy = false) {
    this.monsterStep(pan, heavy ? 7 : 12, heavy);
  }

  ambientCue(cue, pan = 0, intensity = 0.7) {
    if (!this.context) return;
    const name = String(cue || 'distant-knock');
    const now = this.context.currentTime;
    const panner = this.context.createStereoPanner();
    const gain = this.context.createGain();
    panner.pan.value = clamp(pan, -1, 1);
    const amount = clamp(intensity, 0, 1);
    if (/ring|bell/.test(name)) {
      const oscillator = this.context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(name.includes('shift') ? 620 : 780, now);
      oscillator.frequency.exponentialRampToValueAtTime(name.includes('shift') ? 410 : 520, now + 0.72);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.065 * amount, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
      oscillator.connect(panner).connect(gain).connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + 1.3);
      return;
    }
    if (/splash|water|drain|steam|breath/.test(name) && this.noiseBuffer) {
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      source.buffer = this.noiseBuffer;
      source.playbackRate.value = name.includes('splash') ? 0.72 : 0.3;
      filter.type = 'bandpass';
      filter.frequency.value = name.includes('steam') ? 980 : name.includes('splash') ? 420 : 150;
      filter.Q.value = 1.7;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.095 * amount, now + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      source.connect(filter).connect(panner).connect(gain).connect(this.master);
      source.start(now, Math.random() * 1.1, 1);
      source.stop(now + 1.02);
      return;
    }
    const oscillator = this.context.createOscillator();
    oscillator.type = /relay|ballast|fluorescent/.test(name) ? 'square' : 'triangle';
    oscillator.frequency.setValueAtTime(/pipe|knock/.test(name) ? 118 : 210, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.24);
    gain.gain.setValueAtTime(0.11 * amount, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    oscillator.connect(panner).connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.34);
  }

  drip(pan) {
    if (!this.context) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const panner = this.context.createStereoPanner();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1160 + Math.random() * 500, now);
    oscillator.frequency.exponentialRampToValueAtTime(310, now + 0.09);
    panner.pan.value = pan;
    gain.gain.setValueAtTime(0.045, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    oscillator.connect(panner).connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  }
}

function buildTexture(kind, size, repeatX, repeatY, anisotropy, profile = {}) {
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = size;
  bumpCanvas.width = bumpCanvas.height = size;
  const colorContext = colorCanvas.getContext('2d');
  const bumpContext = bumpCanvas.getContext('2d');
  const colorImage = colorContext.createImageData(size, size);
  const bumpImage = bumpContext.createImageData(size, size);
  const pattern = profile.pattern || (kind === 'wall' ? 'wallpaper' : kind === 'floor' ? 'carpet' : 'tile');
  const defaults = kind === 'wall' ? [183, 174, 91] : kind === 'floor' ? [92, 83, 48] : [178, 176, 148];
  const base = profile.base || defaults;
  const patternSeed = Array.from(pattern).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const random = mulberry32(kind.charCodeAt(0) * 991 + size + patternSeed * 17);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const noise = random() * 2 - 1;
      let r;
      let g;
      let b;
      let height;

      if (kind === 'wall') {
        const bottomGrime = Math.pow(y / size, 4) * (profile.bottomGrime ?? 17);
        if (pattern.includes('concrete') && !pattern.includes('seeping')) {
          const seam = x < 3 || y < 3 ? -16 : 0;
          const pore = random() > 0.987 ? -34 : 0;
          const cloud = Math.sin(x * 0.021) * Math.sin(y * 0.017) * 5;
          r = base[0] + cloud + noise * 11 + seam + pore - bottomGrime;
          g = base[1] + cloud + noise * 10 + seam + pore - bottomGrime;
          b = base[2] + cloud * 0.7 + noise * 9 + seam + pore - bottomGrime;
          height = 126 + noise * 28 + seam * 1.5 + pore;
        } else if (pattern.includes('seeping') || pattern.includes('runoff')) {
          const drip = Math.max(0, Math.sin(x * 0.083) + Math.sin(x * 0.029 + 1.8)) * (y / size) * 8;
          const mineral = Math.sin(y * 0.12 + x * 0.014) * 3;
          r = base[0] + noise * 9 - drip + mineral - bottomGrime;
          g = base[1] + noise * 10 - drip * 0.65 + mineral - bottomGrime;
          b = base[2] + noise * 8 - drip * 0.38 + mineral * 0.5 - bottomGrime;
          height = 122 + noise * 22 + drip * 2;
        } else {
          const stripe = Math.sin((x / size) * Math.PI * 20) * 3.8;
          const fiber = Math.sin((y / size) * Math.PI * 170) * 1.1;
          r = base[0] + stripe + fiber + noise * 8 - bottomGrime;
          g = base[1] + stripe * 0.72 + noise * 7 - bottomGrime;
          b = base[2] + stripe * 0.3 + noise * 5 - bottomGrime * 0.42;
          height = 128 + stripe * 2 + noise * 18;
        }
      } else if (kind === 'floor') {
        if (pattern.includes('oil') || pattern === 'tile') {
          const gridX = x % 64 < 4;
          const gridY = y % 64 < 4;
          const grout = gridX || gridY ? -28 : 0;
          const wear = Math.sin(x * 0.031) * Math.sin(y * 0.023) * 5;
          r = base[0] + wear + noise * 10 + grout;
          g = base[1] + wear + noise * 9 + grout;
          b = base[2] + wear * 0.6 + noise * 8 + grout;
          height = 132 + noise * 16 + grout * 1.8;
        } else if (pattern.includes('flooded') || pattern === 'wet') {
          const ripple = Math.sin(x * 0.045 + Math.sin(y * 0.018)) * 3;
          const stain = Math.sin(x * 0.019) * Math.sin(y * 0.027) * 9;
          r = base[0] + ripple + stain + noise * 12;
          g = base[1] + ripple + stain + noise * 13;
          b = base[2] + ripple + stain * 0.7 + noise * 11;
          height = 126 + ripple * 3 + noise * 15;
        } else {
          const fibers = Math.sin((x + y * 0.28) * 1.7) * 4;
          const stain = Math.sin(x * 0.037) * Math.sin(y * 0.031) * 6;
          r = base[0] + fibers + stain + noise * 18;
          g = base[1] + fibers * 0.75 + stain + noise * 15;
          b = base[2] + stain * 0.35 + noise * 10;
          height = 118 + fibers * 2 + noise * 30;
        }
      } else {
        const corrugated = pattern === 'corrugated' || pattern.includes('service');
        const edgeSize = corrugated ? 8 : 4;
        const tileEdge = x < edgeSize || y < edgeSize || x > size - edgeSize - 1 || y > size - edgeSize - 1 ? -23 : 0;
        const corrugation = corrugated ? Math.sin(x * 0.16) * 9 : 0;
        const speckle = random() > 0.985 ? -28 : 0;
        r = base[0] + noise * 8 + tileEdge + speckle + corrugation;
        g = base[1] + noise * 7 + tileEdge + speckle + corrugation;
        b = base[2] + noise * 6 + tileEdge + speckle + corrugation * 0.7;
        height = 142 + noise * 13 + tileEdge * 2 + corrugation * 2;
      }

      colorImage.data[index] = clamp(r, 0, 255);
      colorImage.data[index + 1] = clamp(g, 0, 255);
      colorImage.data[index + 2] = clamp(b, 0, 255);
      colorImage.data[index + 3] = 255;
      bumpImage.data[index] = clamp(height, 0, 255);
      bumpImage.data[index + 1] = clamp(height, 0, 255);
      bumpImage.data[index + 2] = clamp(height, 0, 255);
      bumpImage.data[index + 3] = 255;
    }
  }

  colorContext.putImageData(colorImage, 0, 0);
  bumpContext.putImageData(bumpImage, 0, 0);

  const map = new THREE.CanvasTexture(colorCanvas);
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, bumpMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = anisotropy;
  }
  return { map, bumpMap };
}

function buildObjectiveModel(type, color) {
  const group = new THREE.Group();
  const casingMaterial = new THREE.MeshStandardMaterial({ color: 0x282c28, roughness: 0.68, metalness: 0.34 });
  const faceMaterial = new THREE.MeshStandardMaterial({ color: 0x5b6158, roughness: 0.74, metalness: 0.22 });
  const controlMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.2 });
  const indicatorMaterial = new THREE.MeshStandardMaterial({
    color: 0x4f160f,
    emissive: 0x7d160e,
    emissiveIntensity: 1.2,
    roughness: 0.38,
  });

  let control;
  if (type === 'valve') {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 14), casingMaterial);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.z = -0.03;
    group.add(pipe);
    control = new THREE.Group();
    control.position.z = 0.26;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.045, 9, 24), controlMaterial);
    control.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.11, 12), casingMaterial);
    hub.rotation.x = Math.PI / 2;
    control.add(hub);
    for (let i = 0; i < 4; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.5, 0.035), controlMaterial);
      spoke.rotation.z = i * Math.PI / 4;
      control.add(spoke);
    }
    group.add(control);
  } else {
    const casing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.18), casingMaterial);
    group.add(casing);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.68, 0.07), faceMaterial);
    face.position.z = 0.125;
    group.add(face);
    control = new THREE.Group();
    control.position.set(0, -0.02, 0.2);
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.38, 12), controlMaterial);
    fuse.rotation.z = Math.PI / 2;
    control.add(fuse);
    for (const x of [-0.22, 0.22]) {
      const clampMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.09), casingMaterial);
      clampMesh.position.x = x;
      control.add(clampMesh);
    }
    group.add(control);
  }

  const indicator = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.05), indicatorMaterial);
  indicator.position.set(type === 'valve' ? 0.38 : 0.19, type === 'valve' ? 0.24 : 0.27, 0.21);
  group.add(indicator);
  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  group.userData.control = control;
  group.userData.indicator = indicator;
  group.userData.activationProgress = 0;
  group.userData.type = type;
  return group;
}

function buildEvidenceModel(color = 0xb83426) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x171914, roughness: 0.82, metalness: 0.08 });
  const label = new THREE.MeshStandardMaterial({ color: 0xc8c3a2, roughness: 0.9, metalness: 0 });
  const reel = new THREE.MeshStandardMaterial({ color: 0x55584f, roughness: 0.5, metalness: 0.28 });
  const glow = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 2.4,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.07, 0.24), shell);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const sticker = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.012, 0.12), label);
  sticker.position.y = 0.041;
  group.add(sticker);
  for (const x of [-0.075, 0.075]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.016, 12), reel);
    wheel.position.set(x, 0.052, 0);
    group.add(wheel);
  }
  const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), glow);
  indicator.position.set(0.155, 0.055, 0.075);
  group.add(indicator);
  group.userData.indicator = indicator;
  return group;
}

function buildStoryPlacard(text, accent = '#b8bd86') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 144;
  const context = canvas.getContext('2d');
  context.fillStyle = '#171811';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(215, 211, 181, 0.52)';
  context.lineWidth = 5;
  context.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
  context.fillStyle = accent;
  context.font = '700 30px Courier New';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const words = String(text || '').split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const current = lines.at(-1);
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width > 450 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = candidate;
  }
  const startY = lines.length === 1 ? 74 : 53;
  lines.forEach((line, index) => context.fillText(line, 256, startY + index * 44));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const group = new THREE.Group();
  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(1.45, 0.43, 0.045),
    new THREE.MeshStandardMaterial({ color: 0x171811, roughness: 0.78, metalness: 0.14 }),
  );
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.39),
    new THREE.MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      emissive: 0x1a2117,
      emissiveIntensity: 0.42,
      roughness: 0.74,
    }),
  );
  face.position.z = 0.025;
  group.add(backing, face);
  return group;
}

function buildEnvironmentProps(
  level,
  maze,
  random,
  mobile,
  colliders,
  protectedCells = new Set(),
  occupiedCells = new Set(),
) {
  const group = new THREE.Group();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const protectedSet = protectedCells instanceof Set ? protectedCells : new Set(protectedCells);
  const allCells = Array.from(maze.cells, (_, index) => index)
    .filter((index) => !protectedSet.has(index));

  const chooseCells = (requestedCount, definition, blocking) => {
    const chosen = [];
    const chosenSet = new Set();
    const cluster = Array.isArray(definition.cluster) ? definition.cluster : [1, 1];
    const clusterMin = Math.max(1, Math.trunc(Number(cluster[0]) || 1));
    const clusterMax = Math.max(clusterMin, Math.trunc(Number(cluster[1]) || clusterMin));
    const available = () => allCells.filter((cellIndex) => (
      !chosenSet.has(cellIndex) && (!blocking || !occupiedCells.has(cellIndex))
    ));

    while (chosen.length < requestedCount) {
      const anchors = available();
      if (!anchors.length) break;
      const anchor = anchors[Math.floor(random() * anchors.length)];
      const anchorCoords = maze.coords(anchor);
      const clusterCount = Math.min(
        requestedCount - chosen.length,
        clusterMin + Math.floor(random() * (clusterMax - clusterMin + 1)),
      );
      const nearby = available()
        .filter((cellIndex) => {
          const coords = maze.coords(cellIndex);
          return Math.abs(coords.col - anchorCoords.col) + Math.abs(coords.row - anchorCoords.row) <= 2;
        })
        .map((cellIndex) => ({ cellIndex, order: random() }))
        .sort((left, right) => left.order - right.order);
      if (!nearby.some(({ cellIndex }) => cellIndex === anchor)) {
        nearby.unshift({ cellIndex: anchor, order: -1 });
      }
      let addedToCluster = 0;
      for (const { cellIndex } of nearby) {
        if (chosen.length >= requestedCount || addedToCluster >= clusterCount) break;
        if (chosenSet.has(cellIndex) || (blocking && occupiedCells.has(cellIndex))) continue;
        chosen.push(cellIndex);
        chosenSet.add(cellIndex);
        if (blocking) occupiedCells.add(cellIndex);
        addedToCluster += 1;
      }
      if (!chosenSet.has(anchor) && chosen.length < requestedCount) {
        chosen.push(anchor);
        chosenSet.add(anchor);
        if (blocking) occupiedCells.add(anchor);
      }
    }
    return chosen;
  };

  for (const definition of level.props) {
    const requestedCount = Math.floor(maze.cells.length * definition.density * (mobile ? 0.55 : 1));
    if (requestedCount <= 0) continue;
    const blocking = ['square-column', 'service-crate', 'discarded-chair', 'oil-drum'].includes(definition.type);
    const placementCells = chooseCells(requestedCount, definition, blocking);
    if (!placementCells.length) continue;
    const count = placementCells.length;
    let geometry;
    let material;
    const materialColor = definition.accent === undefined ? definition.color : 0xffffff;

    if (definition.type === 'wall-pipe' || definition.type === 'hanging-chain') {
      geometry = new THREE.CylinderGeometry(
        definition.type === 'hanging-chain' ? 0.018 : 0.055,
        definition.type === 'hanging-chain' ? 0.018 : 0.055,
        definition.type === 'hanging-chain' ? 1.6 : 2.8,
        8,
      );
      material = new THREE.MeshStandardMaterial({ color: materialColor, roughness: 0.68, metalness: 0.42 });
    } else if (definition.type === 'standing-water') {
      geometry = new THREE.CircleGeometry(1, 20);
      material = new THREE.MeshPhysicalMaterial({
        color: materialColor,
        roughness: 0.18,
        metalness: 0.04,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        clearcoat: 0.72,
      });
    } else if (definition.type === 'ceiling-vent' || definition.type === 'cable-tray' || definition.type === 'drain-grate') {
      geometry = new THREE.BoxGeometry(1, 0.045, definition.type === 'cable-tray' ? 0.24 : 0.72);
      material = new THREE.MeshStandardMaterial({ color: materialColor, roughness: 0.74, metalness: 0.32 });
    } else if (definition.type === 'square-column' || definition.type === 'service-crate' || definition.type === 'discarded-chair') {
      geometry = new THREE.BoxGeometry(1, 1, 1);
      material = new THREE.MeshStandardMaterial({ color: materialColor, roughness: 0.82, metalness: 0.08 });
    } else if (definition.type === 'oil-drum') {
      geometry = new THREE.CylinderGeometry(0.31, 0.31, 0.86, 14);
      material = new THREE.MeshStandardMaterial({ color: materialColor, roughness: 0.66, metalness: 0.34 });
    } else continue;

    const instances = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i += 1) {
      const cellIndex = placementCells[i];
      const cell = maze.cellToWorld(cellIndex);
      let colliderSize = null;
      if (definition.type === 'wall-pipe') {
        position.set(cell.x + (random() - 0.5) * 1.5, WALL_HEIGHT - 0.42, cell.z + (random() - 0.5) * 1.5);
        quaternion.setFromEuler(new THREE.Euler(random() > 0.5 ? Math.PI / 2 : 0, 0, random() > 0.5 ? Math.PI / 2 : 0));
      } else if (definition.type === 'hanging-chain') {
        position.set(cell.x + (random() - 0.5) * 1.6, WALL_HEIGHT - 0.8, cell.z + (random() - 0.5) * 1.6);
        quaternion.identity();
      } else if (definition.type === 'standing-water') {
        position.set(cell.x + (random() - 0.5), 0.018, cell.z + (random() - 0.5));
        quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
        const puddleScale = 0.35 + random() * 1.15;
        scale.set(puddleScale, puddleScale * (0.55 + random() * 0.35), 1);
      } else if (definition.type === 'drain-grate') {
        position.set(cell.x + (random() - 0.5) * 1.5, 0.025, cell.z + (random() - 0.5) * 1.5);
        quaternion.identity();
        scale.set(0.68, 1, 0.68);
      } else if (definition.type === 'square-column') {
        const columnAngle = random() * Math.PI * 2;
        position.set(
          cell.x + Math.cos(columnAngle) * 0.82,
          WALL_HEIGHT / 2,
          cell.z + Math.sin(columnAngle) * 0.82,
        );
        quaternion.identity();
        scale.set(0.46, WALL_HEIGHT, 0.46);
        colliderSize = { x: 0.46, z: 0.46 };
      } else if (definition.type === 'service-crate') {
        position.set(cell.x + (random() > 0.5 ? 1.25 : -1.25), 0.36, cell.z + (random() - 0.5) * 0.9);
        quaternion.setFromEuler(new THREE.Euler(0, random() * Math.PI, 0));
        scale.set(0.74, 0.72, 0.74);
        colliderSize = { x: 0.74, z: 0.74 };
      } else if (definition.type === 'oil-drum') {
        position.set(cell.x + (random() > 0.5 ? 1.2 : -1.2), 0.43, cell.z + (random() - 0.5) * 0.8);
        quaternion.identity();
        colliderSize = { x: 0.62, z: 0.62 };
      } else if (definition.type === 'discarded-chair') {
        position.set(cell.x + (random() - 0.5) * 1.4, 0.3, cell.z + (random() - 0.5) * 1.4);
        quaternion.setFromEuler(new THREE.Euler(0.12, random() * Math.PI, random() * 0.2 - 0.1));
        scale.set(0.48, 0.6, 0.48);
        colliderSize = { x: 0.48, z: 0.48 };
      } else {
        position.set(cell.x + (random() - 0.5), WALL_HEIGHT - 0.08, cell.z + (random() - 0.5));
        quaternion.identity();
        scale.set(definition.type === 'cable-tray' ? 2.4 : 0.8, 1, 1);
      }
      matrix.compose(position, quaternion, scale);
      instances.setMatrixAt(i, matrix);
      if (definition.accent !== undefined) {
        instances.setColorAt(i, new THREE.Color(random() < 0.34 ? definition.accent : definition.color));
      }
      if (colliderSize) {
        colliders.push({
          minX: position.x - colliderSize.x / 2,
          maxX: position.x + colliderSize.x / 2,
          minZ: position.z - colliderSize.z / 2,
          maxZ: position.z + colliderSize.z / 2,
        });
      }
      scale.set(1, 1, 1);
    }
    instances.instanceMatrix.needsUpdate = true;
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
    instances.castShadow = definition.type !== 'standing-water';
    instances.receiveShadow = true;
    group.add(instances);
  }
  group.userData.occupiedCells = occupiedCells;
  return group;
}

function hasWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

async function init() {
  if (!hasWebGL2()) {
    dom.unsupported.classList.add('is-visible');
    return;
  }

  const query = new URLSearchParams(window.location.search);
  const qaMode = query.has('qa') && !query.has('room');
  const qaAutowalk = query.has('autowalk');
  const qaComplete = qaMode && query.has('complete');
  const qaMonsterMode = qaMode ? query.get('monster') : null;
  const qaShadow = qaMode && query.has('shadow');
  const levelIndex = getLevelIndex(query);
  const level = LEVELS[levelIndex];
  const requestedCharacterId = String(query.get('character') || '').trim();
  const localCharacterId = characterCatalog.has(requestedCharacterId) ? requestedCharacterId : '';
  const mobile = query.has('touch') || window.matchMedia('(pointer: coarse)').matches;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const multiplayerRequested = query.has('room') || query.get('layout') === 'shared';
  const mazeSize = multiplayerRequested ? level.maze.desktop : mobile ? level.maze.mobile : level.maze.desktop;
  const cols = mazeSize.cols;
  const rows = mazeSize.rows;
  let campaignSeed = Number(sessionStorage.getItem('threshold-campaign-seed'));
  if (!Number.isFinite(campaignSeed) || campaignSeed <= 0) {
    campaignSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    sessionStorage.setItem('threshold-campaign-seed', String(campaignSeed));
  }
  const seed = (campaignSeed ^ level.maze.seedSalt) >>> 0;
  const random = mulberry32(seed ^ 0x9e3779b9);
  const cosmeticRandom = mulberry32(seed ^ 0x6d2b79f5);
  const propRandom = mulberry32(seed ^ 0xa511e9b3);
  const fixtureRandom = mulberry32(seed ^ 0x63d83595);
  const objectiveRandom = mulberry32(seed ^ 0xc2b2ae35);
  const evidenceRandom = mulberry32(seed ^ 0x27d4eb2f);
  const atmosphereDirector = createAtmosphereDirector(level.atmosphere || {}, {
    seed: seed ^ 0x0a7f3d1,
  });
  const maze = new Maze(cols, rows, seed, {
    loopRatio: level.maze.loopRatio,
    roomDivisor: level.maze.roomDivisor,
    minRooms: level.maze.minimumRooms,
    roomSize: level.maze.roomSize,
  });

  dom.classification.textContent = level.copy.classification;
  dom.levelLabel.textContent = `LEVEL ${levelIndex}`;
  dom.status.textContent = level.copy.status;
  dom.objective.textContent = level.objective.labels.hud;
  dom.overlayKicker.textContent = level.copy.start.kicker;
  dom.overlayTitle.innerHTML = level.copy.start.title;
  dom.overlayBody.textContent = level.copy.start.body;
  dom.enterLabel.textContent = level.copy.start.button;
  dom.game.setAttribute('aria-label', `${level.copy.classification} first-person horror game`);
  dom.game.dataset.level = String(levelIndex);
  dom.game.dataset.character = localCharacterId || 'auto';
  dom.game.dataset.seed = String(seed);
  document.title = `${level.name.toUpperCase()} / THRESHOLD`;
  document.documentElement.style.setProperty('--sick', new THREE.Color(level.objective.color).getStyle());
  const startIndex = maze.index(Math.floor(cols / 2), Math.floor(rows / 2));
  const exitDistances = maze.distanceMap(startIndex);
  let exitIndex = startIndex;
  for (let i = 0; i < exitDistances.length; i += 1) {
    if (maze.cells[i] !== 0 && exitDistances[i] > exitDistances[exitIndex]) exitIndex = i;
  }
  const startPosition = maze.cellToWorld(startIndex);

  // Plan required shared content before optional clutter. This guarantees that
  // even a dense contributed prop profile cannot erase objectives or archives.
  const fixtureStates = [];
  const activeFixtures = [];
  const deadFixtures = [];
  const startFixtureCoords = maze.coords(startIndex);
  for (let i = 0; i < maze.cells.length; i += 1) {
    const fixtureCoords = maze.coords(i);
    const qaBroken = qaShadow
      && Math.abs(fixtureCoords.col - startFixtureCoords.col)
        + Math.abs(fixtureCoords.row - startFixtureCoords.row) <= 1;
    const broken = qaBroken || (i !== startIndex && fixtureRandom() < level.lighting.fixture.brokenChance);
    fixtureStates[i] = { broken, phase: fixtureRandom() * Math.PI * 2 };
    (broken ? deadFixtures : activeFixtures).push(i);
  }

  const exitDistance = exitDistances[exitIndex];
  const allContentCandidates = enumerateCellIndexes(maze.cells)
    .filter((index) => index !== startIndex && index !== exitIndex);
  const objectiveFallbackCells = allContentCandidates.filter((index) => (
    DIRECTIONS.some((direction) => maze.hasWall(index, direction.bit))
  ));
  const preferredObjectiveCells = objectiveFallbackCells.filter((index) => (
    maze.cells[index] !== 0
    && !fixtureStates[index].broken
    && exitDistances[index] >= 6
    && exitDistances[index] <= Math.max(7, exitDistance - 3)
  ));
  const objectiveCellPlan = chooseSpacedCells(
    preferredObjectiveCells,
    objectiveFallbackCells,
    level.objective.count,
    objectiveRandom,
    CELL_SIZE * 3.2,
    (left, right) => maze.cellToWorld(left).distanceTo(maze.cellToWorld(right)),
  );
  const objectiveCellPlanSet = new Set(objectiveCellPlan);
  const evidenceFallbackCells = allContentCandidates.filter((index) => !objectiveCellPlanSet.has(index));
  const preferredEvidenceCells = evidenceFallbackCells.filter((index) => (
    maze.cells[index] !== 0 && exitDistances[index] >= 4
  ));
  const evidenceEntries = Array.isArray(level.evidence?.entries) ? level.evidence.entries : [];
  const evidenceCellPlan = chooseSpacedCells(
    preferredEvidenceCells,
    evidenceFallbackCells,
    evidenceEntries.length,
    evidenceRandom,
    CELL_SIZE * 4.2,
    (left, right) => maze.cellToWorld(left).distanceTo(maze.cellToWorld(right)),
  );

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(level.fog.color);
  scene.background = fogColor;
  scene.fog = new THREE.FogExp2(fogColor, mobile ? level.fog.density.mobile : level.fog.density.desktop);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, mobile ? 42 : 58);
  camera.position.set(startPosition.x, EYE_HEIGHT, startPosition.z);
  scene.add(camera);

  const renderer = new THREE.WebGLRenderer({
    antialias: !mobile,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = level.lighting.exposure;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  dom.viewport.appendChild(renderer.domElement);

  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    dom.unsupported.classList.add('is-visible');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    dom.unsupported.classList.remove('is-visible');
    renderer.compileAsync(scene, camera).catch(() => {});
  });

  const controls = new PointerLockControls(camera, renderer.domElement);
  controls.pointerSpeed = 0.78;

  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  const worldWidth = cols * CELL_SIZE;
  const worldDepth = rows * CELL_SIZE;
  const wallTextures = buildTexture('wall', 512, 1, 1, anisotropy, level.surfaces.wall);
  const floorTextures = buildTexture('floor', 512, worldWidth / 3.1, worldDepth / 3.1, anisotropy, level.surfaces.floor);
  const ceilingTextures = buildTexture('ceiling', 256, cols, rows, anisotropy, level.surfaces.ceiling);

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: wallTextures.map,
    bumpMap: wallTextures.bumpMap,
    bumpScale: level.surfaces.wall.bumpScale,
    color: 0xffffff,
    roughness: level.surfaces.wall.roughness,
    metalness: level.surfaces.wall.metalness,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: floorTextures.map,
    bumpMap: floorTextures.bumpMap,
    bumpScale: level.surfaces.floor.bumpScale,
    color: 0xffffff,
    roughness: level.surfaces.floor.roughness,
    metalness: level.surfaces.floor.metalness,
  });
  const ceilingMaterial = new THREE.MeshStandardMaterial({
    map: ceilingTextures.map,
    bumpMap: ceilingTextures.bumpMap,
    bumpScale: level.surfaces.ceiling.bumpScale,
    color: 0xffffff,
    emissive: level.surfaces.ceiling.emissive,
    emissiveIntensity: level.surfaces.ceiling.emissiveIntensity,
    roughness: level.surfaces.ceiling.roughness,
    metalness: level.surfaces.ceiling.metalness,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldDepth), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldDepth), ceilingMaterial);
  ceiling.position.y = WALL_HEIGHT;
  ceiling.rotation.x = Math.PI / 2;
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  const segments = maze.wallSegments();
  const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
  const walls = new THREE.InstancedMesh(wallGeometry, wallMaterial, segments.length);
  const baseMaterial = new THREE.MeshStandardMaterial(level.surfaces.trim);
  const baseboards = new THREE.InstancedMesh(wallGeometry, baseMaterial, segments.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const colliders = [];

  segments.forEach((segment, index) => {
    const width = segment.horizontal ? CELL_SIZE : WALL_THICKNESS;
    const depth = segment.horizontal ? WALL_THICKNESS : CELL_SIZE;
    const baseWidth = segment.horizontal ? CELL_SIZE : WALL_THICKNESS + 0.045;
    const baseDepth = segment.horizontal ? WALL_THICKNESS + 0.045 : CELL_SIZE;
    position.set(segment.x, WALL_HEIGHT / 2, segment.z);
    scale.set(width, WALL_HEIGHT, depth);
    matrix.compose(position, quaternion, scale);
    walls.setMatrixAt(index, matrix);

    position.set(segment.x, 0.105, segment.z);
    scale.set(baseWidth, 0.21, baseDepth);
    matrix.compose(position, quaternion, scale);
    baseboards.setMatrixAt(index, matrix);

    colliders.push({
      minX: segment.x - width / 2,
      maxX: segment.x + width / 2,
      minZ: segment.z - depth / 2,
      maxZ: segment.z + depth / 2,
    });
  });
  walls.instanceMatrix.needsUpdate = true;
  baseboards.instanceMatrix.needsUpdate = true;
  walls.castShadow = true;
  walls.receiveShadow = true;
  baseboards.castShadow = true;
  baseboards.receiveShadow = true;
  scene.add(walls, baseboards);

  const stainGeometry = new THREE.CircleGeometry(1, 18);
  const stainMaterial = new THREE.MeshStandardMaterial({
    color: rgbInt(level.surfaces.floor.grime),
    roughness: level.surfaces.floor.roughness,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  });
  const stains = new THREE.InstancedMesh(stainGeometry, stainMaterial, mobile ? 10 : 22);
  const floorQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  for (let i = 0; i < stains.count; i += 1) {
    const cell = Math.floor(cosmeticRandom() * maze.cells.length);
    const center = maze.cellToWorld(cell);
    position.set(center.x + (cosmeticRandom() - 0.5) * 2.1, 0.012, center.z + (cosmeticRandom() - 0.5) * 2.1);
    scale.set(0.35 + cosmeticRandom() * 1.45, 0.2 + cosmeticRandom() * 0.8, 1);
    matrix.compose(position, floorQuaternion, scale);
    stains.setMatrixAt(i, matrix);
  }
  stains.instanceMatrix.needsUpdate = true;
  scene.add(stains);

  const grimeCanvas = document.createElement('canvas');
  grimeCanvas.width = grimeCanvas.height = 128;
  const grimeContext = grimeCanvas.getContext('2d');
  grimeContext.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 6; i += 1) {
    const centerX = 28 + cosmeticRandom() * 72;
    const centerY = 28 + cosmeticRandom() * 72;
    const radius = 12 + cosmeticRandom() * 34;
    const gradient = grimeContext.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    gradient.addColorStop(0, `rgba(255,255,255,${0.3 + cosmeticRandom() * 0.38})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    grimeContext.fillStyle = gradient;
    grimeContext.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
  }
  const grimeTexture = new THREE.CanvasTexture(grimeCanvas);
  const wallGrime = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      alphaMap: grimeTexture,
      color: rgbInt(level.surfaces.wall.grime),
      opacity: level.surfaces.wall.grimeOpacity ?? 0.19,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
    mobile ? 12 : 28,
  );
  for (let i = 0; i < wallGrime.count; i += 1) {
    const segment = segments[Math.floor(cosmeticRandom() * segments.length)];
    const side = cosmeticRandom() > 0.5 ? 1 : -1;
    position.set(
      segment.x + (segment.horizontal ? (cosmeticRandom() - 0.5) * 2.2 : side * (WALL_THICKNESS / 2 + 0.004)),
      0.48 + cosmeticRandom() * 1.55,
      segment.z + (segment.horizontal ? side * (WALL_THICKNESS / 2 + 0.004) : (cosmeticRandom() - 0.5) * 2.2),
    );
    quaternion.setFromEuler(new THREE.Euler(0, segment.horizontal ? 0 : Math.PI / 2, 0));
    scale.set(0.42 + cosmeticRandom() * 1.18, 0.22 + cosmeticRandom() * 0.72, 1);
    matrix.compose(position, quaternion, scale);
    wallGrime.setMatrixAt(i, matrix);
  }
  wallGrime.instanceMatrix.needsUpdate = true;
  scene.add(wallGrime);
  const propOccupiedCells = new Set();
  scene.add(buildEnvironmentProps(
    level,
    maze,
    propRandom,
    multiplayerRequested ? false : mobile,
    colliders,
    new Set([startIndex, exitIndex, ...objectiveCellPlan, ...evidenceCellPlan]),
    propOccupiedCells,
  ));
  const storyFragments = level.atmosphere?.environmentalStory || [];
  for (const fragment of storyFragments) {
    const count = Math.floor(
      maze.cells.length * Math.max(0, Number(fragment.density) || 0) * (mobile ? 0.55 : 1),
    );
    if (count <= 0) continue;
    for (let i = 0; i < count; i += 1) {
      const placement = String(fragment.placement || 'wall');
      if (placement === 'objective') continue;
      const placard = buildStoryPlacard(
        fragment.text,
        new THREE.Color(level.objective.color).getStyle(),
      );
      if (placement === 'floor' || placement === 'fixture') {
        const cellIndex = Math.floor(cosmeticRandom() * maze.cells.length);
        const center = maze.cellToWorld(cellIndex);
        placard.position.set(
          center.x + (cosmeticRandom() - 0.5) * 1.1,
          placement === 'floor' ? 0.055 : WALL_HEIGHT - 0.065,
          center.z + (cosmeticRandom() - 0.5) * 1.1,
        );
        placard.rotation.x = placement === 'floor' ? -Math.PI / 2 : Math.PI / 2;
        placard.rotation.z = cosmeticRandom() * Math.PI * 2;
      } else {
        let segment = segments[Math.floor(cosmeticRandom() * segments.length)];
        if (placement === 'exit' || placement === 'objective') {
          const targetCell = placement === 'exit'
            ? exitIndex
            : Math.floor(cosmeticRandom() * maze.cells.length);
          const target = maze.cellToWorld(targetCell);
          segment = segments.reduce((nearest, candidate) => {
            if (!nearest) return candidate;
            const nearestDistance = (nearest.x - target.x) ** 2 + (nearest.z - target.z) ** 2;
            const candidateDistance = (candidate.x - target.x) ** 2 + (candidate.z - target.z) ** 2;
            return candidateDistance < nearestDistance ? candidate : nearest;
          }, null);
        }
        if (!segment) continue;
        let side = cosmeticRandom() > 0.5 ? 1 : -1;
        if (segment.horizontal && Math.abs(segment.z + side * 0.2) > worldDepth / 2 - 0.1) side *= -1;
        if (!segment.horizontal && Math.abs(segment.x + side * 0.2) > worldWidth / 2 - 0.1) side *= -1;
        placard.position.set(
          segment.x + (segment.horizontal ? (cosmeticRandom() - 0.5) * Math.max(0.2, CELL_SIZE - 1.8) : side * 0.12),
          1.42 + (cosmeticRandom() - 0.5) * 0.42,
          segment.z + (segment.horizontal ? side * 0.12 : (cosmeticRandom() - 0.5) * Math.max(0.2, CELL_SIZE - 1.8)),
        );
        placard.rotation.y = segment.horizontal
          ? (side > 0 ? 0 : Math.PI)
          : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
      scene.add(placard);
    }
  }

  const panelGeometry = new THREE.BoxGeometry(1.62, 0.035, 0.44);
  const frameGeometry = new THREE.BoxGeometry(1.86, 0.075, 0.65);
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: level.lighting.fixture.panelColor,
    emissive: level.lighting.fixture.panelColor,
    emissiveIntensity: 3.1,
    roughness: 0.38,
  });
  const deadPanelMaterial = new THREE.MeshStandardMaterial({
    color: level.lighting.fixture.deadPanelColor,
    emissive: level.lighting.fixture.deadPanelColor,
    emissiveIntensity: 0.08,
    roughness: 0.8,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: level.surfaces.trim.color,
    roughness: level.surfaces.trim.roughness,
    metalness: Math.max(0.1, level.surfaces.trim.metalness),
  });
  const activePanels = new THREE.InstancedMesh(panelGeometry, panelMaterial, activeFixtures.length);
  const deadPanels = new THREE.InstancedMesh(panelGeometry, deadPanelMaterial, deadFixtures.length);
  const fixtureFrames = new THREE.InstancedMesh(frameGeometry, frameMaterial, maze.cells.length);

  const setFixtureMatrix = (mesh, instanceIndex, cellIndex, y) => {
    const center = maze.cellToWorld(cellIndex);
    position.set(center.x, y, center.z);
    quaternion.setFromEuler(new THREE.Euler(0, ((cellIndex + Math.floor(cellIndex / cols)) % 2) * Math.PI / 2, 0));
    scale.set(1, 1, 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(instanceIndex, matrix);
  };
  activeFixtures.forEach((cell, index) => setFixtureMatrix(activePanels, index, cell, WALL_HEIGHT - 0.075));
  deadFixtures.forEach((cell, index) => setFixtureMatrix(deadPanels, index, cell, WALL_HEIGHT - 0.075));
  for (let i = 0; i < maze.cells.length; i += 1) setFixtureMatrix(fixtureFrames, i, i, WALL_HEIGHT - 0.035);
  activePanels.instanceMatrix.needsUpdate = true;
  deadPanels.instanceMatrix.needsUpdate = true;
  fixtureFrames.instanceMatrix.needsUpdate = true;
  scene.add(fixtureFrames, activePanels, deadPanels);

  const ambient = new THREE.HemisphereLight(
    level.lighting.hemisphere.sky,
    level.lighting.hemisphere.ground,
    mobile ? level.lighting.hemisphere.intensity.mobile : level.lighting.hemisphere.intensity.desktop,
  );
  const bounce = new THREE.AmbientLight(
    level.lighting.ambient.color,
    mobile ? level.lighting.ambient.intensity.mobile : level.lighting.ambient.intensity.desktop,
  );
  scene.add(ambient, bounce);

  const lightPool = [];
  const lightCount = mobile ? level.lighting.fixture.pool.mobile : level.lighting.fixture.pool.desktop;
  for (let i = 0; i < lightCount; i += 1) {
    const light = new THREE.SpotLight(
      level.lighting.fixture.color,
      level.lighting.fixture.intensity,
      level.lighting.fixture.distance,
      level.lighting.fixture.angle,
      level.lighting.fixture.penumbra,
      level.lighting.fixture.decay,
    );
    light.position.y = WALL_HEIGHT - 0.12;
    light.castShadow = !mobile && i === 0;
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 11;
    light.shadow.bias = -0.00035;
    light.shadow.normalBias = 0.035;
    scene.add(light, light.target);
    lightPool.push(light);
  }

  const flashlightProfile = level.equipment?.flashlight || {};
  const flashlightTarget = new THREE.Object3D();
  flashlightTarget.position.set(0, -0.04, -1);
  const playerFlashlight = new THREE.SpotLight(
    flashlightProfile.color ?? level.lighting.fixture.color,
    flashlightProfile.intensity ?? (mobile ? 38 : 52),
    flashlightProfile.distance ?? 18,
    flashlightProfile.angle ?? 0.42,
    flashlightProfile.penumbra ?? 0.72,
    1.7,
  );
  playerFlashlight.position.set(0.12, -0.08, -0.08);
  playerFlashlight.target = flashlightTarget;
  playerFlashlight.castShadow = false;
  const flashlightBounce = new THREE.PointLight(
    flashlightProfile.color ?? level.lighting.fixture.color,
    1.25,
    3.2,
    2,
  );
  flashlightBounce.position.set(0, -0.1, -0.2);
  camera.add(playerFlashlight, flashlightTarget, flashlightBounce);
  const remoteFlashLight = new THREE.PointLight(
    flashlightProfile.color ?? level.lighting.fixture.color,
    0,
    13,
    2,
  );
  remoteFlashLight.visible = false;
  scene.add(remoteFlashLight);

  const exitCell = maze.cellToWorld(exitIndex);
  const exitGroup = new THREE.Group();
  const exitWalls = DIRECTIONS.filter((direction) => maze.hasWall(exitIndex, direction.bit));
  const exitWall = exitWalls[0] || DIRECTIONS[0];
  const doorOffset = CELL_SIZE / 2 - 0.12;
  exitGroup.position.set(
    exitCell.x + exitWall.dc * doorOffset,
    0,
    exitCell.z + exitWall.dr * doorOffset,
  );
  exitGroup.rotation.y = exitWall.bit === N
    ? 0
    : exitWall.bit === S
      ? Math.PI
      : exitWall.bit === E
        ? -Math.PI / 2
        : Math.PI / 2;

  const doorMaterial = new THREE.MeshStandardMaterial({
    color: rgbInt(level.surfaces.wall.grime),
    roughness: 0.74,
    metalness: 0.12,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: level.surfaces.trim.color,
    roughness: level.surfaces.trim.roughness,
    metalness: level.surfaces.trim.metalness,
  });
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.32, 0.13), doorMaterial);
  door.position.y = 1.16;
  door.castShadow = true;
  exitGroup.add(door);

  for (const x of [-0.66, 0.66]) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.48, 0.18), trimMaterial);
    trim.position.set(x, 1.24, 0);
    exitGroup.add(trim);
  }
  const topTrim = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.12, 0.18), trimMaterial);
  topTrim.position.y = 2.42;
  exitGroup.add(topTrim);

  const signCanvas = document.createElement('canvas');
  signCanvas.width = 256;
  signCanvas.height = 72;
  const signContext = signCanvas.getContext('2d');
  signContext.fillStyle = '#29412c';
  signContext.fillRect(0, 0, signCanvas.width, signCanvas.height);
  signContext.strokeStyle = '#7ea77c';
  signContext.lineWidth = 5;
  signContext.strokeRect(4, 4, signCanvas.width - 8, signCanvas.height - 8);
  signContext.fillStyle = '#dbe8c7';
  signContext.font = '700 40px Arial';
  signContext.textAlign = 'center';
  signContext.textBaseline = 'middle';
  signContext.fillText(level.exit?.label || 'EXIT', signCanvas.width / 2, signCanvas.height / 2 + 2);
  const signTexture = new THREE.CanvasTexture(signCanvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  signTexture.anisotropy = anisotropy;
  const exitSignBacking = new THREE.Mesh(
    new THREE.BoxGeometry(0.88, 0.29, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x142018, roughness: 0.65 }),
  );
  exitSignBacking.position.set(0, 2.66, 0);
  exitGroup.add(exitSignBacking);
  const exitSign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.23),
    new THREE.MeshStandardMaterial({
      map: signTexture,
      emissiveMap: signTexture,
      emissive: 0x8eb789,
      emissiveIntensity: 2.8,
      roughness: 0.42,
    }),
  );
  exitSign.position.set(0, 2.66, 0.045);
  exitGroup.add(exitSign);
  if (level.objective.count > 0) exitSign.material.emissiveIntensity = 0.28;
  scene.add(exitGroup);

  const objectiveItems = [];
  if (level.objective.count > 0) {
    for (const cellIndex of objectiveCellPlan) {
      const cellCenter = maze.cellToWorld(cellIndex);
      const wallsInCell = DIRECTIONS.filter((direction) => maze.hasWall(cellIndex, direction.bit));
      const wall = wallsInCell[Math.floor(objectiveRandom() * wallsInCell.length)] || DIRECTIONS[0];
      const model = buildObjectiveModel(level.objective.type, level.objective.color);
      const mountOffset = CELL_SIZE / 2 - 0.14;
      model.position.set(
        cellCenter.x + wall.dc * mountOffset,
        1.12,
        cellCenter.z + wall.dr * mountOffset,
      );
      model.rotation.y = wall.bit === N
        ? 0
        : wall.bit === S
          ? Math.PI
          : wall.bit === E
            ? -Math.PI / 2
            : Math.PI / 2;
      model.userData.cellIndex = cellIndex;
      model.userData.activated = false;
      scene.add(model);
      objectiveItems.push(model);
    }
  }
  const objectiveTotal = objectiveItems.length;
  for (const fragment of storyFragments.filter((entry) => entry.placement === 'objective')) {
    if (!objectiveItems.length) break;
    const count = Math.floor(
      maze.cells.length * Math.max(0, Number(fragment.density) || 0) * (mobile ? 0.55 : 1),
    );
    if (count <= 0) continue;
    for (let index = 0; index < Math.min(count, objectiveItems.length); index += 1) {
      const objective = objectiveItems[index % objectiveItems.length];
      const placard = buildStoryPlacard(
        fragment.text,
        new THREE.Color(level.objective.color).getStyle(),
      );
      placard.position.copy(objective.position);
      placard.position.y = 1.92;
      placard.rotation.y = objective.rotation.y;
      scene.add(placard);
    }
  }
  if (objectiveTotal === 0) exitSign.material.emissiveIntensity = 2.8;
  dom.game.dataset.objectiveTotal = String(objectiveTotal);
  dom.game.dataset.exitCell = String(exitIndex);
  dom.game.dataset.monsterMode = 'hidden';

  const evidenceItems = evidenceCellPlan.map((cellIndex, index) => {
    const center = maze.cellToWorld(cellIndex);
    const model = buildEvidenceModel(level.objective.color);
    model.position.set(
      center.x + (evidenceRandom() - 0.5) * 1.15,
      0.095,
      center.z + (evidenceRandom() - 0.5) * 1.15,
    );
    model.rotation.y = evidenceRandom() * Math.PI * 2;
    model.userData.cellIndex = cellIndex;
    model.userData.evidenceIndex = index;
    model.userData.collected = false;
    model.userData.baseY = model.position.y;
    scene.add(model);
    return model;
  });
  let evidenceCollected = 0;
  dom.evidenceState.textContent = `ARCHIVE 0/${evidenceItems.length}`;
  dom.evidenceState.hidden = evidenceItems.length === 0;
  dom.game.dataset.evidence = '0';

  const protectedIncidentCells = [
    startIndex,
    exitIndex,
    ...objectiveItems.map((item) => item.userData.cellIndex),
    ...evidenceItems.map((item) => item.userData.cellIndex),
    ...propOccupiedCells,
  ];
  const incidentMobile = mobile && !multiplayerRequested;
  const incidentProfile = level.incidents || {};
  const incidentPlan = planIncidents({
    density: incidentProfile.density,
    minCount: incidentProfile.minCount,
    maxCount: incidentProfile.maxCount,
    minCellDistance: incidentProfile.minCellDistance,
    weights: incidentProfile.weights,
    types: incidentProfile.types,
    seed: seed ^ 0x1ac1de17,
    candidateCells: Array.from(maze.cells, (cell, cellIndex) => ({
      cellIndex,
      ...maze.coords(cellIndex),
    })).filter(({ cellIndex }) => exitDistances[cellIndex] >= 3),
    protectedCells: protectedIncidentCells,
    columns: cols,
    mobile: incidentMobile,
  });
  const incidentGroup = buildIncidentGroup(THREE, incidentPlan, {
    cellToWorld: (cellIndex) => maze.cellToWorld(cellIndex),
    mobile: incidentMobile,
    palette: level.incidents?.palette,
  });
  for (const incident of incidentGroup.children) {
    incident.userData.baseY = incident.position.y;
    if (!['collapsed-wanderer', 'abandoned-pack', 'chair-pile'].includes(incident.userData.incidentType)) {
      continue;
    }
    const radius = incident.userData.incidentType === 'chair-pile' ? 0.7 : 0.52;
    colliders.push({
      minX: incident.position.x - radius,
      maxX: incident.position.x + radius,
      minZ: incident.position.z - radius,
      maxZ: incident.position.z + radius,
    });
  }
  scene.add(incidentGroup);
  dom.game.dataset.incidents = String(incidentPlan.length);

  const entity = buildMonster(THREE, {
    name: level.monster.name,
    identity: level.monster.identity,
    presentation: level.monster.presentation,
    sound: level.monster.sound,
    height: 2.46 * level.monster.skin.scale,
    skinColor: level.monster.skin.body,
    eyeColor: level.monster.skin.eye || level.monster.skin.accent,
    mouthColor: level.monster.skin.type === 'faceless-shadow' ? level.monster.skin.body : 0x020202,
    toothColor: level.monster.skin.type === 'faceless-shadow' ? level.monster.skin.body : level.monster.skin.accent,
    eyeGlow: Boolean(level.monster.skin.eye),
    eyeIntensity: level.monster.skin.emissiveIntensity,
    detail: mobile ? 'low' : 'medium',
    seed: seed ^ 0x51f15e,
  });
  entity.visible = false;
  scene.add(entity);

  const remotePlayers = createRemotePlayerManager(THREE, scene, {
    castShadow: !mobile,
    receiveShadow: true,
    nameTags: true,
    flashlights: true,
    avatarScale: 1,
  });
  const waitingRoomPreview = createWaitingRoomPreview(THREE, {
    renderer,
    slotsElement: dom.waitingSlots,
    reducedMotion,
  });
  let lastVoiceErrorAt = 0;
  const multiplayer = createMultiplayerClient({
    url: query.get('server') || undefined,
    autoReconnect: true,
    expectedLevelIds: LEVEL_IDS,
    expectedContentFingerprint: GAME_CONTENT_FINGERPRINT,
  });
  const voiceChat = createVoiceChat({
    iceServers: import.meta.env.VITE_VOICE_ICE_SERVERS || [],
    sendSignal: (playerId, signal) => multiplayer.sendVoiceSignal(playerId, signal),
    onStateChange: (state) => updateVoiceUi(state),
    onError: () => {
      const timestamp = performance.now();
      if (multiplayerActive && timestamp - lastVoiceErrorAt > 2_500) {
        lastVoiceErrorAt = timestamp;
        showMessage('VOICE SIGNAL DEGRADED', 0.65);
      }
    },
  });
  const requestedRoomCode = normalizeRoomCode(query.get('room'));
  const defaultCallsign = `RECORDER ${String(10 + Math.floor(Math.random() * 90))}`;
  let localCallsign = normalizeCallsign(localStorage.getItem('threshold-callsign')) || defaultCallsign;
  let localLook = survivorLook(localStorage.getItem('threshold-survivor-look')).id;
  let localReady = false;
  let sessionStarted = false;
  let waitingAction = 'ready';
  let sessionStartPending = false;
  let lobbyBusy = false;
  let lobbyMode = requestedRoomCode ? 'join' : 'solo';
  let roomIsPublic = true;
  let directoryRequestGeneration = 0;
  let multiplayerActive = false;
  let localAlive = true;
  let networkMonsterState = null;
  let networkMonsterReceivedAt = 0;
  let networkMonsterInitialized = false;
  let networkMonsterWasVisible = false;
  let networkMonsterPreviousMode = 'hidden';
  let networkMonsterStepDistance = 0;
  let monsterPublishPending = false;
  let monsterPublishSignature = '';
  let monsterPublishSucceededAt = 0;
  let lastPlayerNetworkUpdate = 0;
  let lastMonsterNetworkUpdate = 0;
  let lastRoomRosterUpdate = 0;
  let lastKillIntentAt = 0;
  let roomNavigationPending = false;
  const remoteNetworkPlayers = new Map();
  const remoteFlashCooldowns = new Map();
  const remoteInteractionStarts = new Map();
  const killedRemotePlayers = new Set();
  const pendingRemoteKills = new Set();
  dom.playerName.value = localCallsign;
  dom.roomCode.value = requestedRoomCode;

  const audio = new AudioEngine({
    ...level.audio,
    monsterSound: level.monster.sound,
  });
  audio.setMuted(localStorage.getItem('threshold-muted') === '1');
  dom.soundToggle.textContent = audio.muted ? 'SOUND OFF' : 'SOUND ON';
  const keys = new Set();
  const playerPosition = new THREE.Vector2(startPosition.x, startPosition.z);
  const velocity = new THREE.Vector2();
  const inputDirection = new THREE.Vector2();
  const touchInput = new THREE.Vector2();
  const worldDirection = new THREE.Vector3();
  const rightDirection = new THREE.Vector3();
  const desiredDirection = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const entityVector = new THREE.Vector3();
  const entityTarget = new THREE.Vector3();
  const clock = new THREE.Clock();

  let gameState = 'start';
  let ending = false;
  let levelCompletionPending = false;
  let elapsed = 0;
  let accumulator = 0;
  let stamina = 1;
  const batteryStorageKey = `threshold-battery-${campaignSeed}`;
  const storedBatteryRaw = sessionStorage.getItem(batteryStorageKey);
  const storedBattery = Number(storedBatteryRaw);
  let flashlightCharge = storedBatteryRaw !== null && Number.isFinite(storedBattery)
    ? clamp(storedBattery, 0, 1)
    : 0.82;
  let flashlightOn = flashlightCharge > 0.02;
  let flashlightBoostUntil = 0;
  let flashlightCooldownUntil = 0;
  let flashWatchUntil = 0;
  let remoteFlashUntil = 0;
  let batteryPersistAt = 0;
  let equipmentHudUpdateAt = 0;
  let noiseImpulse = 0;
  let movementNoise = 0;
  let fear = 0;
  let playerHidden = false;
  let hidingSettle = 0;
  let playerExposure = flashlightOn ? 1 : 0.35;
  let playerInReliableLight = true;
  let worldLightReliability = 1;
  let entityTargetHidden = false;
  let entityTargetExposure = 1;
  let entityTargetAwarenessRate = 1;
  let headBob = 0;
  let currentEyeHeight = EYE_HEIGHT;
  let stepDistance = 0;
  let nextScare = randomBetween(level.monster.timing.firstScare, random);
  let nextChase = randomBetween(level.monster.timing.firstChase, random);
  let flickerUntil = 0;
  let glitchUntil = 0;
  let lightUpdateAt = 0;
  let messageUntil = 0;
  let messageTimer = null;
  let lastGrainUpdate = 0;
  let touchSprint = false;
  let touchCrouch = false;
  let nearExit = false;
  let currentInteraction = null;
  let heldInteraction = null;
  let interactionHeld = false;
  let objectivesCompleted = 0;
  let playerNoise = 0;
  let playerCrouching = false;
  let playerRunning = false;
  let playerActualSpeed = 0;
  let tension = 0;
  let entityMode = 'hidden';
  let entityUntil = 0;
  let huntRecoveryUntil = 0;
  let entityPath = [];
  let entityPathIndex = 0;
  let entityPathUpdate = 0;
  let entitySeenFor = 0;
  let entityLostSight = 0;
  let entityLastKnownCell = startIndex;
  let entityStepDistance = 0;
  let entityStuckTime = 0;
  let entityCurrentSpeed = 0;
  let entityActualSpeed = 0;
  let entityPerceptionUpdate = 0;
  let entityCanSeePlayer = false;
  let entitySightContact = false;
  let entityHeardPlayer = false;
  let entityAwareness = 0;
  let entityTargetPlayerId = 'local';
  let entityTargetPlayerX = playerPosition.x;
  let entityTargetPlayerZ = playerPosition.y;
  let entityTargetPlayerNoise = 0;
  let entityTargetWatched = false;
  let entityAnimationStart = 0;
  let lastFrame = performance.now();
  let fixedStep = 1 / 120;
  let frameTimeAverage = 1 / 60;
  let slowFrameDuration = 0;
  let adaptiveQualityReduced = false;
  let activeLightCount = lightPool.length;

  const grainContext = dom.grain.getContext('2d', { alpha: true });
  dom.grain.width = 180;
  dom.grain.height = 100;

  function updateGrain(force = false) {
    if (!force && (reducedMotion || elapsed - lastGrainUpdate < 0.085)) return;
    lastGrainUpdate = elapsed;
    const image = grainContext.createImageData(dom.grain.width, dom.grain.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.floor(random() * 255);
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 62;
    }
    grainContext.putImageData(image, 0, 0);
  }
  updateGrain(true);

  function showOverlay(kind) {
    cancelHeldInteraction();
    dom.overlay.classList.add('is-visible');
    dom.overlay.dataset.mode = kind;
    if (kind === 'pause') {
      dom.overlayKicker.textContent = level.copy.pause.kicker;
      dom.overlayTitle.innerHTML = level.copy.pause.title;
      dom.overlayBody.textContent = level.copy.pause.body;
      dom.enterLabel.textContent = level.copy.pause.button;
    } else if (kind === 'dead') {
      dom.overlayKicker.textContent = level.copy.death.kicker;
      dom.overlayTitle.innerHTML = level.copy.death.title;
      dom.overlayBody.textContent = level.copy.death.body;
      dom.enterLabel.textContent = level.copy.death.button;
    } else if (kind === 'won') {
      dom.overlayKicker.textContent = level.copy.win.kicker;
      dom.overlayTitle.innerHTML = level.copy.win.title;
      dom.overlayBody.textContent = level.copy.win.body;
      dom.enterLabel.textContent = level.copy.win.button;
    }
    requestAnimationFrame(() => dom.enterButton.focus({ preventScroll: true }));
  }

  function hideOverlay() {
    dom.overlay.classList.remove('is-visible');
    if (mobile) dom.touchUi.classList.add('is-visible');
  }

  function showMessage(text, duration = 1.1) {
    dom.message.textContent = text;
    dom.message.classList.add('is-visible');
    messageUntil = elapsed + duration;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      dom.message.classList.remove('is-visible');
      dom.message.textContent = '';
      messageUntil = 0;
    }, duration * 1000);
  }

  function setLobbyStatus(text, kind = '') {
    dom.coopState.textContent = text;
    dom.coopLobby.classList.toggle('is-error', kind === 'error');
    dom.coopLobby.classList.toggle('is-connected', kind === 'connected');
  }

  function voiceAvailable() {
    return voiceChat.supported && multiplayer.serverCapabilities.includes('voice-signaling');
  }

  function updateVoiceUi(state = voiceChat.snapshot()) {
    const available = voiceAvailable();
    const requesting = state.state === 'requesting';
    const enabled = Boolean(state.enabled);
    const blocked = state.state === 'blocked';
    dom.voiceControls.setAttribute('aria-busy', String(requesting));
    dom.voiceToggle.disabled = multiplayerActive && !available;
    dom.voiceToggle.dataset.state = available ? state.state : 'unsupported';
    dom.voiceToggle.setAttribute('aria-pressed', String(enabled));
    dom.voiceToggle.textContent = !available
      ? 'VOICE N/A'
      : requesting
        ? 'CANCEL MIC'
        : blocked
          ? 'VOICE RETRY'
          : state.state === 'paused'
            ? 'VOICE PAUSED'
            : enabled
              ? 'VOICE ON'
              : 'VOICE OFF';
    dom.voiceToggle.setAttribute(
      'aria-label',
      !available
        ? 'Room voice chat is unavailable'
        : requesting
          ? 'Cancel the pending microphone request'
        : enabled
          ? 'Disable room voice chat and release the microphone'
          : blocked
            ? 'Retry microphone access for room voice chat'
            : 'Enable room voice chat',
    );

    dom.micToggle.hidden = !enabled;
    dom.micToggle.disabled = state.state === 'paused';
    dom.micToggle.textContent = state.muted ? 'MIC MUTED' : 'MIC LIVE';
    dom.micToggle.setAttribute('aria-pressed', String(Boolean(state.muted)));
    dom.micToggle.setAttribute('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone');
    const peerText = state.peerCount === 1 ? '1 teammate linked' : `${state.peerCount} teammates linked`;
    dom.voiceState.textContent = !available
      ? 'Room voice chat is unavailable on this server or browser.'
      : requesting
        ? 'Requesting microphone access.'
        : blocked
          ? 'Microphone access was blocked. Activate Voice Retry to try again.'
          : state.state === 'paused'
            ? 'Voice chat is paused while this tab is hidden.'
            : enabled
              ? `Voice chat on, ${state.muted ? 'microphone muted' : 'microphone live'}, ${peerText}.`
              : 'Voice chat off.';
    dom.game.dataset.voice = !available ? 'unsupported' : state.state;
    dom.game.dataset.voiceMuted = String(Boolean(state.muted));
    dom.game.dataset.voicePeers = String(state.peerCount || 0);
  }

  function bindVoiceSession(room = multiplayer.room) {
    if (!room || !multiplayer.self?.id) return;
    voiceChat.bindSession({ selfId: multiplayer.self.id, players: room.players || [] });
    updateVoiceUi();
  }

  function setLobbyBusy(busy) {
    lobbyBusy = Boolean(busy);
    dom.coopLobby.setAttribute('aria-busy', String(Boolean(busy)));
    dom.coopConnect.disabled = Boolean(busy);
    dom.modeSolo.disabled = Boolean(busy);
    dom.modeHost.disabled = Boolean(busy);
    dom.modeJoin.disabled = Boolean(busy);
    dom.modeRooms.disabled = Boolean(busy);
    dom.roomVisibility.disabled = Boolean(busy);
    for (const button of dom.roomList.querySelectorAll('.room-signal')) {
      button.disabled = Boolean(busy) || button.dataset.joinable !== 'true';
    }
    dom.enterButton.disabled = Boolean(busy) || (!multiplayerActive && lobbyMode !== 'solo');
    if (multiplayerActive) updateWaitingRoom();
  }

  function setLobbyMode(mode) {
    const previousMode = lobbyMode;
    lobbyMode = ['solo', 'host', 'join', 'rooms'].includes(mode) ? mode : 'solo';
    const buttons = [
      [dom.modeSolo, 'solo'],
      [dom.modeHost, 'host'],
      [dom.modeJoin, 'join'],
      [dom.modeRooms, 'rooms'],
    ];
    for (const [button, value] of buttons) {
      const selected = lobbyMode === value;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    dom.coopForm.hidden = lobbyMode === 'solo';
    dom.coopForm.dataset.mode = lobbyMode;
    dom.roomCodeField.hidden = lobbyMode !== 'join';
    dom.roomVisibility.hidden = lobbyMode !== 'host';
    dom.roomDirectory.hidden = lobbyMode !== 'rooms';
    dom.coopConnect.textContent = lobbyMode === 'join'
      ? 'CONNECT'
      : lobbyMode === 'rooms'
        ? 'REFRESH'
        : 'OPEN ROOM';
    if (previousMode === 'rooms' && lobbyMode !== 'rooms') {
      directoryRequestGeneration += 1;
      Promise.resolve(multiplayer.unsubscribeRoomDirectory?.()).catch(() => {});
    }
    if (!multiplayerActive) {
      setLobbyStatus(
        lobbyMode === 'solo'
          ? 'SOLO RECORDING'
          : lobbyMode === 'host'
            ? roomIsPublic
              ? 'PUBLIC ROOM / LISTED IN ROOMS'
              : 'UNLISTED ROOM / CODE REQUIRED'
            : lobbyMode === 'join'
              ? 'ENTER A ROOM CODE'
              : 'BROWSE PUBLIC ROOMS',
      );
    }
    dom.enterButton.disabled = !multiplayerActive && lobbyMode !== 'solo';
  }

  function setRoomVisibility(isPublic) {
    roomIsPublic = Boolean(isPublic);
    dom.roomVisibility.textContent = roomIsPublic ? 'PUBLIC' : 'UNLISTED';
    dom.roomVisibility.setAttribute('aria-pressed', String(roomIsPublic));
    dom.roomVisibility.setAttribute(
      'aria-label',
      roomIsPublic ? 'Room will appear in the public directory' : 'Room will require a private code',
    );
    if (lobbyMode === 'host' && !multiplayerActive) {
      setLobbyStatus(roomIsPublic ? 'PUBLIC ROOM / LISTED IN ROOMS' : 'UNLISTED ROOM / CODE REQUIRED');
    }
  }

  function setDirectoryState(state, message) {
    dom.coopLobby.classList.toggle('is-directory-loading', state === 'loading');
    dom.roomDirectoryEmpty.textContent = message;
    dom.roomDirectoryEmpty.hidden = dom.roomList.childElementCount > 0 && state !== 'error';
    if (state === 'loading') dom.roomDirectoryCount.textContent = '--';
  }

  function directoryPhaseLabel(room) {
    if (!room.joinable) return Number(room.availableSlots) <= 0 ? 'FULL' : 'CLOSED';
    if (room.phase === 'loading') return 'TRANSIT';
    if (room.phase === 'active' || room.phase === 'playing') return 'IN LEVEL';
    return 'OPEN';
  }

  function renderRoomDirectory(payload = multiplayer.roomDirectory) {
    const directory = payload?.directory || payload || {};
    const rooms = Array.isArray(directory.rooms) ? directory.rooms : [];
    const focusedCode = document.activeElement?.closest?.('.room-signal')?.dataset.code;
    dom.roomList.replaceChildren();
    for (const room of rooms) {
      const code = normalizeRoomCode(room?.code);
      if (!code) continue;
      const playerCount = Math.max(0, Number(room.playerCount) || 0);
      const capacity = Math.max(1, Number(room.capacity) || 8);
      const availableSlots = Math.max(0, Number(room.availableSlots ?? capacity - playerCount) || 0);
      const levelNumber = Math.max(0, Number(room.level) || 0);
      const joinable = room.joinable !== false && availableSlots > 0;
      const listItem = document.createElement('div');
      listItem.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.className = 'room-signal';
      button.type = 'button';
      button.dataset.code = code;
      button.dataset.joinable = String(joinable);
      button.disabled = !joinable;
      button.setAttribute(
        'aria-label',
        `${joinable ? 'Join' : 'Unavailable'} room ${code}, level ${levelNumber}, ${playerCount} of ${capacity} survivors`,
      );

      const codeLabel = document.createElement('strong');
      codeLabel.textContent = code;
      const levelLabel = document.createElement('span');
      levelLabel.textContent = `LEVEL ${levelNumber}`;
      const rosterLabel = document.createElement('span');
      rosterLabel.textContent = `${playerCount}/${capacity}`;
      const phaseLabel = document.createElement('small');
      phaseLabel.textContent = directoryPhaseLabel({
        ...room,
        playerCount,
        capacity,
        availableSlots,
        joinable,
      });
      button.append(codeLabel, levelLabel, rosterLabel, phaseLabel);
      listItem.append(button);
      dom.roomList.append(listItem);
    }
    const listedCount = dom.roomList.childElementCount;
    const total = Math.max(listedCount, Number(directory.total) || listedCount);
    dom.roomDirectoryCount.textContent = directory.truncated
      ? `${listedCount}/${total}`
      : String(total).padStart(2, '0');
    dom.roomDirectoryEmpty.hidden = listedCount > 0;
    dom.roomDirectoryEmpty.textContent = 'NO OPEN SIGNALS / HOST A ROOM OR REFRESH';
    dom.coopLobby.classList.remove('is-directory-loading');
    if (focusedCode) {
      const restoredFocus = [...dom.roomList.querySelectorAll('.room-signal')]
        .find((button) => button.dataset.code === focusedCode);
      (restoredFocus || dom.coopConnect).focus({ preventScroll: true });
    }
  }

  async function refreshRoomDirectory({ subscribe = false } = {}) {
    if (lobbyMode !== 'rooms') return;
    const requestGeneration = ++directoryRequestGeneration;
    setDirectoryState('loading', 'SCANNING OPEN SIGNALS');
    setLobbyStatus('SCANNING PUBLIC ROOMS');
    try {
      const payload = subscribe
        ? await multiplayer.subscribeRoomDirectory({ limit: 50 })
        : await multiplayer.listRooms({ limit: 50 });
      if (requestGeneration !== directoryRequestGeneration || lobbyMode !== 'rooms') return;
      renderRoomDirectory(payload);
      setLobbyStatus('SELECT A SIGNAL TO JOIN');
    } catch (error) {
      if (requestGeneration !== directoryRequestGeneration || lobbyMode !== 'rooms') return;
      dom.roomList.replaceChildren();
      dom.roomDirectoryCount.textContent = '!!';
      setDirectoryState('error', 'ROOM DIRECTORY UNAVAILABLE / REFRESH TO RETRY');
      setLobbyStatus(error?.message?.toUpperCase?.() || 'ROOM DIRECTORY UNAVAILABLE', 'error');
    }
  }

  function roomResumeKey(code) {
    return `threshold-room-resume-${normalizeRoomCode(code)}`;
  }

  function connectedRoomPlayers() {
    return (multiplayer.room?.players || []).filter((player) => player.connected !== false);
  }

  function roomCapacity(room = multiplayer.room) {
    return clamp(Math.trunc(Number(room?.capacity) || ROOM_CAPACITY), 1, ROOM_CAPACITY);
  }

  function roomSessionStarted(room = multiplayer.room) {
    if (!room) return false;
    const phase = String(room.game?.phase || '').toLowerCase();
    return Number(room.epoch) > 1
      || ['playing', 'active', 'loading', 'complete'].includes(phase)
      || ['session-start', 'level-complete'].includes(room.game?.lastEvent);
  }

  function hydrateWaitingRoomState(room = multiplayer.room) {
    if (!room) return;
    const selfState = (room.players || [])
      .find((player) => player.id === multiplayer.self?.id)?.state || {};
    localLook = survivorLook(selfState.look || localLook).id;
    localReady = roomSessionStarted(room) || selfState.ready === true;
    sessionStarted = roomSessionStarted(room);
    sessionStartPending = false;
  }

  function currentWaitingRoomModel() {
    return waitingRoomModel({
      players: multiplayer.room?.players || [],
      selfId: multiplayer.self?.id,
      hostId: multiplayer.room?.hostId,
      localReady,
      localLook,
      localCharacterId,
      started: sessionStarted,
      capacity: roomCapacity(),
    });
  }

  function waitingPlayerSlot(player) {
    const slot = document.createElement('div');
    slot.className = 'waiting-slot';
    slot.setAttribute('role', 'listitem');
    slot.dataset.ready = String(player.ready);
    slot.dataset.local = String(player.local);
    slot.dataset.playerId = player.id;
    slot.setAttribute(
      'aria-label',
      `${player.name}, ${player.host ? 'host, ' : ''}${player.ready ? 'ready' : 'choosing'}, ${player.look.name} suit`,
    );

    const avatar = document.createElement('div');
    avatar.className = 'waiting-avatar-viewport';
    avatar.setAttribute('aria-hidden', 'true');

    const name = document.createElement('strong');
    name.textContent = player.name;
    const state = document.createElement('small');
    const role = player.host ? 'HOST' : player.local ? 'YOU' : 'SIGNAL';
    state.textContent = `${player.ready ? 'READY' : 'CHOOSING'} / ${role}`;
    slot.append(avatar, name, state);
    return slot;
  }

  function emptyWaitingSlot(index) {
    const slot = document.createElement('div');
    slot.className = 'waiting-slot is-empty';
    slot.setAttribute('role', 'listitem');
    slot.setAttribute('aria-label', `Empty survivor slot ${index + 1}`);
    const label = document.createElement('strong');
    label.textContent = 'WAITING';
    const state = document.createElement('small');
    state.textContent = 'OPEN SIGNAL';
    slot.append(label, state);
    return slot;
  }

  function updateWaitingRoom() {
    const visible = multiplayerActive && gameState === 'start';
    dom.coopLobby.classList.toggle('is-waiting', visible);
    dom.overlay.classList.toggle('has-waiting-room', visible);
    dom.waitingRoom.hidden = !visible;
    waitingRoomPreview.setVisible(visible);
    if (visible) dom.game.dataset.waitingRoom = 'true';
    else delete dom.game.dataset.waitingRoom;
    if (!visible) return;

    const waiting = currentWaitingRoomModel();
    waitingAction = waiting.action;
    dom.waitingRoomCount.textContent = `${waiting.players.length}/${waiting.capacity}`;
    dom.waitingSlots.replaceChildren(
      ...waiting.players.map(waitingPlayerSlot),
      ...Array.from(
        { length: waiting.emptySlots },
        (_, index) => emptyWaitingSlot(waiting.players.length + index),
      ),
    );
    waitingRoomPreview.setPlayers(waiting.players);

    for (const button of dom.lookPicker.querySelectorAll('[data-look]')) {
      const selected = button.dataset.look === localLook;
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = sessionStarted || sessionStartPending || lobbyBusy;
    }

    dom.waitingRoomStatus.textContent = sessionStartPending
      ? 'OPENING THE THRESHOLD / HOLD YOUR SIGNAL'
      : waiting.started
        ? 'RUN OPEN / ENTER WHEN READY'
        : waiting.isHost && waiting.allReady && localReady
          ? 'ALL SIGNALS READY / START WHEN YOU ARE'
          : localReady
            ? 'READY / WAITING FOR THE HOST'
            : 'CHOOSE A SUIT / READY WHEN THE TEAM IS ASSEMBLED';
    dom.enterLabel.textContent = waiting.actionLabel;
    dom.enterButton.disabled = lobbyBusy || sessionStartPending;
  }

  function updateRoomHud() {
    if (!multiplayerActive || !multiplayer.roomCode) {
      waitingRoomPreview.setVisible(false);
      dom.coopHud.classList.remove('is-visible');
      dom.voiceControls.hidden = true;
      dom.coopLobby.classList.remove('is-waiting');
      dom.overlay.classList.remove('has-waiting-room');
      dom.waitingRoom.hidden = true;
      dom.game.dataset.multiplayer = 'solo';
      delete dom.game.dataset.waitingRoom;
      delete dom.game.dataset.room;
      delete dom.game.dataset.roomHost;
      delete dom.game.dataset.roomEpoch;
      delete dom.game.dataset.remotePlayers;
      return;
    }
    const count = Math.max(1, connectedRoomPlayers().length);
    const capacity = roomCapacity();
    dom.coopRoom.textContent = `ROOM ${multiplayer.roomCode}${multiplayer.isHost ? ' / HOST' : ''}`;
    dom.coopRoster.textContent = `${count}/${capacity} ${count === 1 ? 'SURVIVOR' : 'SURVIVORS'}`;
    dom.coopHud.classList.add('is-visible');
    dom.voiceControls.hidden = false;
    bindVoiceSession();
    dom.game.dataset.multiplayer = 'active';
    dom.game.dataset.room = multiplayer.roomCode;
    dom.game.dataset.roomHost = String(multiplayer.isHost);
    dom.game.dataset.roomEpoch = String(multiplayer.room?.epoch ?? '');
    dom.game.dataset.remotePlayers = String(remotePlayers.size);
    setLobbyStatus(`ROOM ${multiplayer.roomCode} / ${multiplayer.isHost ? 'HOST' : 'CONNECTED'}`, 'connected');
    dom.copyInvite.hidden = false;
    updateWaitingRoom();
  }

  function roomInviteUrl() {
    const invite = new URL(window.location.href);
    invite.searchParams.set('room', multiplayer.roomCode || normalizeRoomCode(dom.roomCode.value));
    invite.searchParams.set('level', String(multiplayer.room?.level ?? levelIndex));
    invite.searchParams.set('layout', 'shared');
    invite.searchParams.delete('qa');
    invite.searchParams.delete('complete');
    invite.searchParams.delete('autowalk');
    invite.searchParams.delete('monster');
    return invite.toString();
  }

  function navigateToRoomWorld(room) {
    const roomCode = normalizeRoomCode(room?.code || multiplayer.roomCode);
    const roomSeed = Number(room?.seed);
    const roomLevel = Number(room?.level);
    if (!roomCode || !Number.isFinite(roomSeed) || !Number.isFinite(roomLevel)) return false;
    voiceChat.disable();
    sessionStorage.setItem('threshold-campaign-seed', String(roomSeed >>> 0));
    if (multiplayer.resumeToken) {
      sessionStorage.setItem(roomResumeKey(roomCode), multiplayer.resumeToken);
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('room', roomCode);
    nextUrl.searchParams.set('level', String(roomLevel));
    nextUrl.searchParams.set('layout', 'shared');
    nextUrl.searchParams.delete('qa');
    nextUrl.searchParams.delete('complete');
    nextUrl.searchParams.delete('autowalk');
    nextUrl.searchParams.delete('monster');
    nextUrl.searchParams.delete('shadow');
    roomNavigationPending = true;
    window.location.replace(nextUrl.toString());
    return true;
  }

  function normalizeRemoteSnapshot(payload) {
    const player = payload?.player || payload || {};
    const state = payload?.state || player.state || {};
    const id = String(payload?.playerId || player.id || state.id || '');
    if (!id) return null;
    const position = state.position || {
      x: state.x,
      y: state.y,
      z: state.z,
    };
    if (!Number.isFinite(Number(position?.x)) || !Number.isFinite(Number(position?.z))) return null;
    const flashlight = state.flashlight === true;
    const crouching = state.crouching === true;
    const noise = clamp(Number(state.noise) || 0, 0, 2);
    const rawExposure = Number(state.exposure);
    const fallbackExposure = flashlight ? 1 : crouching ? 0.3 : 0.35;
    const look = survivorLook(state.look);
    return {
      id,
      name: player.name || state.name || 'TEAMMATE',
      position: {
        x: Number(position.x),
        y: Number(position.y) || 0,
        z: Number(position.z),
      },
      yaw: Number(state.yaw) || 0,
      pitch: Number(state.pitch) || 0,
      speed: Math.max(0, Number(state.speed) || 0),
      velocity: state.velocity,
      running: state.running === true,
      crouching,
      noise,
      hidden: state.hidden === true,
      exposure: Number.isFinite(rawExposure) ? clamp(rawExposure, 0, 1.5) : fallbackExposure,
      alive: state.alive !== false,
      playing: state.playing !== false,
      flashlight,
      visible: state.alive !== false && state.visible !== false,
      look: look.id,
      ready: state.ready === true,
      characterId: typeof state.characterId === 'string' && characterCatalog.has(state.characterId)
        ? state.characterId
        : undefined,
      color: playerColor(id, state.look),
      receivedAt: performance.now(),
    };
  }

  function upsertRemotePlayer(payload) {
    const snapshot = normalizeRemoteSnapshot(payload);
    if (!snapshot || snapshot.id === multiplayer.self?.id) return;
    const previousSnapshot = remoteNetworkPlayers.get(snapshot.id);
    if (previousSnapshot?.noiseHoldUntil > performance.now()) {
      snapshot.noise = Math.max(snapshot.noise, previousSnapshot.noise);
      snapshot.noiseHoldUntil = previousSnapshot.noiseHoldUntil;
    }
    if (killedRemotePlayers.has(snapshot.id)) {
      snapshot.alive = false;
      snapshot.visible = false;
      snapshot.speed = 0;
    }
    remoteNetworkPlayers.set(snapshot.id, snapshot);
    remotePlayers.upsert(snapshot);
  }

  function updateVoiceSpatial() {
    if (!voiceChat.enabled || voiceChat.peerCount === 0) return;
    camera.getWorldDirection(worldDirection);
    const rightX = -worldDirection.z;
    const rightZ = worldDirection.x;
    for (const [playerId, snapshot] of remoteNetworkPlayers) {
      const dx = snapshot.position.x - playerPosition.x;
      const dz = snapshot.position.z - playerPosition.y;
      const distance = Math.hypot(dx, dz);
      const pan = distance > 0.001 ? (dx * rightX + dz * rightZ) / distance : 0;
      voiceChat.setPeerSpatialState(playerId, { distance, pan });
    }
  }

  function removeRemotePlayer(id) {
    const key = String(id || '');
    if (!key) return;
    remoteNetworkPlayers.delete(key);
    remotePlayers.remove(key);
  }

  function applyNetworkMonster(payload) {
    const state = payload?.state || payload;
    if (!state || typeof state !== 'object') return;
    const now = performance.now();
    const visible = state.visible !== false && state.mode !== 'hidden';
    const recoveryRemaining = Number(state.recoveryRemaining);
    huntRecoveryUntil = !visible && Number.isFinite(recoveryRemaining) && recoveryRemaining > 0
      ? elapsed + recoveryRemaining
      : 0;
    const targetX = Number(state.x ?? state.position?.x);
    const targetZ = Number(state.z ?? state.position?.z);
    const gap = networkMonsterReceivedAt ? now - networkMonsterReceivedAt : Infinity;
    const poseGap = Number.isFinite(targetX) && Number.isFinite(targetZ)
      ? Math.hypot(entity.position.x - targetX, entity.position.z - targetZ)
      : 0;
    const snapPose = visible && (
      !networkMonsterInitialized
      || !networkMonsterWasVisible
      || gap > 900
      || poseGap > 7
    );
    const previousMode = networkMonsterState?.mode || networkMonsterPreviousMode;
    const previousTargetPlayerId = networkMonsterState?.targetPlayerId;
    networkMonsterState = { ...state };
    networkMonsterReceivedAt = now;
    networkMonsterInitialized = true;
    networkMonsterWasVisible = visible;
    networkMonsterPreviousMode = String(state.mode || 'hidden');
    if (snapPose && Number.isFinite(targetX) && Number.isFinite(targetZ)) {
      entity.position.set(targetX, 0, targetZ);
      if (Number.isFinite(Number(state.yaw))) entity.rotation.y = Number(state.yaw);
      entityCurrentSpeed = Math.max(0, Number(state.speed) || 0);
      entityActualSpeed = entityCurrentSpeed;
      entityAnimationStart = elapsed - Math.max(0, Number(state.animationTime) || 0);
      networkMonsterStepDistance = 0;
    }
    if (
      visible
      && state.mode === 'chase'
      && state.targetPlayerId === multiplayer.self?.id
      && (previousMode !== 'chase' || previousTargetPlayerId !== multiplayer.self?.id)
    ) {
      showMessage('RUN', 0.72);
      audio.impact();
      flickerUntil = Math.max(flickerUntil, elapsed + 2.2);
    }
  }

  function applyRoomSnapshot(room = multiplayer.room) {
    if (!room) return;
    const present = new Set();
    for (const player of room.players || []) {
      if (player.id === multiplayer.self?.id || player.connected === false) continue;
      present.add(String(player.id));
      if (player.state) upsertRemotePlayer(player);
    }
    for (const id of [...remoteNetworkPlayers.keys()]) {
      if (!present.has(id)) removeRemotePlayer(id);
    }
    reconcileObjectives(room.objectives || {}, room.epoch);
    reconcileEvidence(room.objectives || {}, room.epoch);
    if (room.monster?.epoch === room.epoch) applyNetworkMonster(room.monster);
    if (room.game?.epoch === room.epoch && room.game.lastEvent === 'level-complete') {
      win({ broadcast: false });
    }
    updateRoomHud();
  }

  function recoverRoomSnapshot() {
    if (!multiplayerActive || !multiplayer.isConnected) return;
    multiplayer.requestSnapshot().then(applyRoomSnapshot).catch(() => {
      setLobbyStatus('ROOM RESYNC FAILED', 'error');
    });
  }

  function isCurrentRoomEvent(payload) {
    return Number(payload?.epoch) === Number(multiplayer.room?.epoch);
  }

  async function finishRoomJoin(payload) {
    const room = payload?.room || multiplayer.room;
    if (!room) throw new Error('The room did not return a world snapshot.');
    const roomSeed = Number(room.seed) >>> 0;
    const roomLevel = Number(room.level);
    if (multiplayer.resumeToken) {
      sessionStorage.setItem(roomResumeKey(room.code), multiplayer.resumeToken);
    }
    const needsReload = roomSeed !== campaignSeed
      || roomLevel !== levelIndex
      || (mobile && !multiplayerRequested);
    if (needsReload) return navigateToRoomWorld(room);

    hydrateWaitingRoomState(room);
    multiplayerActive = true;
    localAlive = true;
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('room', room.code);
    currentUrl.searchParams.set('level', String(room.level));
    currentUrl.searchParams.set('layout', 'shared');
    window.history.replaceState(null, '', currentUrl);
    lobbyMode = multiplayer.isHost ? 'host' : 'join';
    setLobbyMode(lobbyMode);
    applyRoomSnapshot(room);
    setLobbyBusy(false);
    sendLocalPlayerState(true);
    return false;
  }

  async function leaveMultiplayer() {
    const previousCode = multiplayer.roomCode;
    voiceChat.disable();
    try {
      if (multiplayer.roomCode && multiplayer.isConnected) await multiplayer.leaveRoom();
    } catch {
      multiplayer.disconnect({ forgetRoom: true });
    }
    if (previousCode) sessionStorage.removeItem(roomResumeKey(previousCode));
    multiplayerActive = false;
    localReady = false;
    sessionStarted = false;
    sessionStartPending = false;
    remoteNetworkPlayers.clear();
    remotePlayers.clear();
    killedRemotePlayers.clear();
    pendingRemoteKills.clear();
    networkMonsterState = null;
    networkMonsterInitialized = false;
    networkMonsterWasVisible = false;
    dom.copyInvite.hidden = true;
    dom.enterLabel.textContent = level.copy.start.button;
    const soloUrl = new URL(window.location.href);
    soloUrl.searchParams.delete('room');
    soloUrl.searchParams.delete('layout');
    window.history.replaceState(null, '', soloUrl);
    updateRoomHud();
  }

  async function connectSelectedRoom() {
    if (lobbyMode === 'solo') return;
    localCallsign = normalizeCallsign(dom.playerName.value) || defaultCallsign;
    dom.playerName.value = localCallsign;
    localStorage.setItem('threshold-callsign', localCallsign);
    const code = normalizeRoomCode(dom.roomCode.value);
    dom.roomCode.value = code;
    if (lobbyMode === 'join' && code.length < 4) {
      setLobbyStatus('ROOM CODE REQUIRED', 'error');
      dom.roomCode.focus();
      return;
    }
    if (multiplayerActive) await leaveMultiplayer();
    setLobbyBusy(true);
    setLobbyStatus(lobbyMode === 'host' ? 'OPENING SECURE CHANNEL' : `CONNECTING TO ${code}`);
    try {
      let payload;
      if (lobbyMode === 'host') {
        payload = await multiplayer.createRoom({
          name: localCallsign,
          seed: campaignSeed,
          level: levelIndex,
          visibility: roomIsPublic ? 'public' : 'private',
        });
      } else {
        const savedResumeToken = sessionStorage.getItem(roomResumeKey(code)) || undefined;
        try {
          payload = await multiplayer.joinRoom(code, {
            name: localCallsign,
            resumeToken: savedResumeToken,
          });
        } catch (error) {
          if (error?.code !== 'RESUME_REJECTED' || !savedResumeToken) throw error;
          sessionStorage.removeItem(roomResumeKey(code));
          payload = await multiplayer.joinRoom(code, { name: localCallsign });
        }
      }
      const navigating = await finishRoomJoin(payload);
      if (!navigating) showMessage(multiplayer.isHost ? 'ROOM OPEN' : 'SIGNAL LINKED', 0.8);
    } catch (error) {
      setLobbyBusy(false);
      setLobbyStatus(error?.message?.toUpperCase?.() || 'ROOM CONNECTION FAILED', 'error');
    }
  }

  function objectiveProgressText() {
    if (!objectiveTotal) return level.objective.labels.hud;
    const progress = level.objective.labels.progress
      .replace('{current}', String(objectivesCompleted))
      .replace('{total}', String(objectiveTotal));
    return `${level.objective.labels.hud} / ${progress}`;
  }

  function updateObjectiveHud() {
    dom.objective.textContent = objectivesCompleted >= objectiveTotal && objectiveTotal > 0
      ? level.objective.labels.complete
      : objectiveProgressText();
    dom.objective.style.opacity = '1';
    dom.game.dataset.objectivesCompleted = String(objectivesCompleted);
  }

  function objectiveIdFor(item) {
    return `cell:${item.userData.cellIndex}`;
  }

  function objectiveFromId(objectiveId) {
    const cellIndex = Number(String(objectiveId || '').replace(/^cell:/, ''));
    if (!Number.isFinite(cellIndex)) return null;
    return objectiveItems.find((item) => item.userData.cellIndex === cellIndex) || null;
  }

  function activateObjectiveById(objectiveId, { announce = true } = {}) {
    const item = objectiveFromId(objectiveId);
    if (!item || item.userData.activated) return false;
    item.userData.activated = true;
    objectivesCompleted += 1;
    updateObjectiveHud();
    if (announce) {
      audio.objectiveComplete();
      const progress = `${level.objective.labels.item} ${objectivesCompleted} / ${objectiveTotal}`;
      showMessage(progress, 0.95);
      flickerUntil = Math.max(flickerUntil, elapsed + 0.45);
    }
    if (objectivesCompleted >= objectiveTotal) {
      exitSign.material.emissiveIntensity = 2.8;
      if (announce) {
        showMessage(level.objective.labels.complete, 1.6);
        audio.powerDip(elapsed, 0.5);
      }
    }
    return true;
  }

  function reconcileObjectives(objectives = {}, epoch = multiplayer.room?.epoch) {
    const activeIds = new Set(
      Object.values(objectives)
        .filter((event) => event?.action === 'activate' && event.epoch === epoch)
        .map((event) => String(event.objectiveId)),
    );
    objectivesCompleted = 0;
    for (const item of objectiveItems) {
      item.userData.activated = activeIds.has(objectiveIdFor(item));
      if (item.userData.activated) objectivesCompleted += 1;
    }
    exitSign.material.emissiveIntensity = objectivesCompleted >= objectiveTotal ? 2.8 : 0.28;
    updateObjectiveHud();
  }

  function evidenceIdFor(item) {
    return `evidence:${item.userData.cellIndex}`;
  }

  function evidenceFromId(evidenceId) {
    const cellIndex = Number(String(evidenceId || '').replace(/^evidence:/, ''));
    if (!Number.isFinite(cellIndex)) return null;
    return evidenceItems.find((item) => item.userData.cellIndex === cellIndex) || null;
  }

  function updateEvidenceHud() {
    dom.evidenceState.textContent = `ARCHIVE ${evidenceCollected}/${evidenceItems.length}`;
    dom.game.dataset.evidence = String(evidenceCollected);
  }

  function collectEvidenceById(evidenceId, { announce = true, grantCharge = false, collectorName = '' } = {}) {
    const item = evidenceFromId(evidenceId);
    if (!item || item.userData.collected) return false;
    item.userData.collected = true;
    item.visible = false;
    evidenceCollected += 1;
    updateEvidenceHud();
    if (grantCharge) {
      flashlightCharge = clamp(flashlightCharge + (level.evidence?.recharge ?? 0.3), 0, 1);
      persistFlashlightCharge();
      noiseImpulse = Math.max(noiseImpulse, 1.35);
      audio.archivePickup();
      updateEquipmentHud();
    }
    if (announce) {
      const entry = evidenceEntries[item.userData.evidenceIndex] || 'ARCHIVE FRAGMENT RECOVERED';
      showMessage(
        grantCharge ? entry : `${collectorName || 'A TEAMMATE'} FOUND AN ARCHIVE`,
        grantCharge ? 3.4 : 1.8,
      );
    }
    return true;
  }

  function reconcileEvidence(objectives = {}, epoch = multiplayer.room?.epoch) {
    const collectedIds = new Set(
      Object.values(objectives)
        .filter((event) => event?.action === 'collect' && event.epoch === epoch)
        .map((event) => String(event.objectiveId)),
    );
    evidenceCollected = 0;
    for (const item of evidenceItems) {
      item.userData.collected = collectedIds.has(evidenceIdFor(item));
      item.visible = !item.userData.collected;
      if (item.userData.collected) evidenceCollected += 1;
    }
    updateEvidenceHud();
  }

  function updateObjectiveAnimations(dt) {
    for (const item of objectiveItems) {
      const target = item.userData.activated ? 1 : 0;
      item.userData.activationProgress = lerp(
        item.userData.activationProgress,
        target,
        1 - Math.exp(-7 * dt),
      );
      const progress = item.userData.activationProgress;
      if (item.userData.type === 'valve') item.userData.control.rotation.z = progress * Math.PI * 1.65;
      else item.userData.control.rotation.x = -progress * 0.78;
      const indicatorMaterial = item.userData.indicator.material;
      indicatorMaterial.color.set(item.userData.activated ? 0x72a96b : 0x4f160f);
      indicatorMaterial.emissive.set(item.userData.activated ? 0x5f9b59 : 0x7d160e);
      indicatorMaterial.emissiveIntensity = item.userData.activated ? 2.3 : 1.2;
    }
    for (const item of evidenceItems) {
      if (item.userData.collected) continue;
      item.position.y = item.userData.baseY + Math.sin(elapsed * 1.8 + item.userData.evidenceIndex) * 0.018;
      item.rotation.y += dt * 0.12;
      if (item.userData.indicator?.material) {
        item.userData.indicator.material.emissiveIntensity = 1.8 + Math.sin(elapsed * 4.2) * 0.65;
      }
    }
    for (const incident of incidentGroup.children) {
      if (incident.userData.incidentType !== 'black-motes') continue;
      incident.rotation.y += dt * 0.16;
      incident.position.y = incident.userData.baseY + Math.sin(elapsed * 0.72 + incident.id) * 0.025;
    }
  }

  updateObjectiveHud();
  if (qaComplete) {
    objectiveItems.forEach((item) => { item.userData.activated = true; });
    objectivesCompleted = objectiveTotal;
    exitSign.material.emissiveIntensity = 2.8;
    updateObjectiveHud();
  }

  function resolveCollision() {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      let resolved = false;
      for (const box of colliders) {
        if (
          playerPosition.x + PLAYER_RADIUS < box.minX ||
          playerPosition.x - PLAYER_RADIUS > box.maxX ||
          playerPosition.y + PLAYER_RADIUS < box.minZ ||
          playerPosition.y - PLAYER_RADIUS > box.maxZ
        ) continue;

        const closestX = clamp(playerPosition.x, box.minX, box.maxX);
        const closestZ = clamp(playerPosition.y, box.minZ, box.maxZ);
        let dx = playerPosition.x - closestX;
        let dz = playerPosition.y - closestZ;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq >= PLAYER_RADIUS * PLAYER_RADIUS) continue;

        let normalX;
        let normalZ;
        let penetration;
        if (distanceSq > 0.0000001) {
          const distance = Math.sqrt(distanceSq);
          normalX = dx / distance;
          normalZ = dz / distance;
          penetration = PLAYER_RADIUS - distance;
        } else {
          const left = Math.abs(playerPosition.x - box.minX);
          const right = Math.abs(box.maxX - playerPosition.x);
          const top = Math.abs(playerPosition.y - box.minZ);
          const bottom = Math.abs(box.maxZ - playerPosition.y);
          const minimum = Math.min(left, right, top, bottom);
          normalX = minimum === left ? -1 : minimum === right ? 1 : 0;
          normalZ = minimum === top ? -1 : minimum === bottom ? 1 : 0;
          penetration = PLAYER_RADIUS + minimum;
        }

        playerPosition.x += normalX * penetration;
        playerPosition.y += normalZ * penetration;
        const inward = velocity.x * normalX + velocity.y * normalZ;
        if (inward < 0) {
          velocity.x -= inward * normalX;
          velocity.y -= inward * normalZ;
        }
        resolved = true;
      }
      if (!resolved) break;
    }
  }

  function resolveEntityCollision() {
    const radius = 0.2;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      let resolved = false;
      for (const box of colliders) {
        if (
          entity.position.x + radius < box.minX
          || entity.position.x - radius > box.maxX
          || entity.position.z + radius < box.minZ
          || entity.position.z - radius > box.maxZ
        ) continue;
        const closestX = clamp(entity.position.x, box.minX, box.maxX);
        const closestZ = clamp(entity.position.z, box.minZ, box.maxZ);
        const deltaX = entity.position.x - closestX;
        const deltaZ = entity.position.z - closestZ;
        const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
        if (distanceSquared >= radius * radius) continue;
        if (distanceSquared > 0.0000001) {
          const distance = Math.sqrt(distanceSquared);
          const correction = radius - distance;
          entity.position.x += (deltaX / distance) * correction;
          entity.position.z += (deltaZ / distance) * correction;
        } else {
          const distances = [
            { value: Math.abs(entity.position.x - box.minX), x: -1, z: 0 },
            { value: Math.abs(box.maxX - entity.position.x), x: 1, z: 0 },
            { value: Math.abs(entity.position.z - box.minZ), x: 0, z: -1 },
            { value: Math.abs(box.maxZ - entity.position.z), x: 0, z: 1 },
          ].sort((a, b) => a.value - b.value);
          entity.position.x += distances[0].x * (radius + distances[0].value);
          entity.position.z += distances[0].z * (radius + distances[0].value);
        }
        resolved = true;
      }
      if (!resolved) break;
    }
  }

  function updateEquipmentHud() {
    const percent = Math.round(flashlightCharge * 100);
    dom.flashlightLabel.textContent = `F  LIGHT ${flashlightOn ? 'ON' : 'OFF'} / ${percent}`;
    dom.flashlightFill.style.transform = `scaleX(${flashlightCharge})`;
    dom.flashlightHud.classList.toggle('is-low', flashlightCharge < 0.16);
    dom.touchLight.textContent = flashlightOn ? 'LIGHT ON' : 'LIGHT OFF';
    dom.touchLight.setAttribute('aria-pressed', String(flashlightOn));
    dom.touchFlash.disabled = elapsed < flashlightCooldownUntil || flashlightCharge < (flashlightProfile.flashCost ?? 0.28);
    dom.game.dataset.flashlight = String(flashlightOn);
    dom.game.dataset.battery = flashlightCharge.toFixed(3);
    dom.game.dataset.hidden = String(playerHidden);
    dom.game.dataset.fear = fear.toFixed(3);
  }

  function persistFlashlightCharge() {
    sessionStorage.setItem(batteryStorageKey, flashlightCharge.toFixed(4));
    batteryPersistAt = elapsed + 2;
  }

  function setFlashlight(next, { announce = true } = {}) {
    if (next && flashlightCharge <= 0.01) {
      if (announce) showMessage('THE LIGHT HAS NO CHARGE', 0.65);
      return false;
    }
    flashlightOn = Boolean(next);
    if (announce) showMessage(flashlightOn ? 'FLASHLIGHT ON' : 'FLASHLIGHT OFF', 0.45);
    updateEquipmentHud();
    sendLocalPlayerState(true);
    return flashlightOn;
  }

  function applyCameraFlashAt(sourceX, sourceZ, directionX, directionZ, localSource = false) {
    if (!entity.visible || entityMode === 'hidden') return false;
    const deltaX = entity.position.x - sourceX;
    const deltaZ = entity.position.z - sourceZ;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance > 13 || distance < 0.001) return false;
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    const gaze = (deltaX * directionX + deltaZ * directionZ) / (distance * directionLength);
    if (gaze < 0.7 || !hasClearLine(sourceX, sourceZ, entity.position.x, entity.position.z)) return false;
    flashWatchUntil = Math.max(flashWatchUntil, elapsed + 0.7);
    entityAwareness = Math.max(entityAwareness, 0.68);
    entityLastKnownCell = maze.worldToCell(sourceX, sourceZ);
    entityHeardPlayer = true;
    if (entityMode === 'glimpse') {
      entityMode = 'stalk';
      entityUntil = elapsed + level.monster.timing.stalkDuration;
    }
    if (localSource) showMessage('THE FLASH MADE IT LOOK AT YOU', 0.78);
    publishMonsterState(true);
    return true;
  }

  function presentRemoteFlash(state = {}) {
    const sourceX = Number(state.position?.x);
    const sourceZ = Number(state.position?.z);
    if (!Number.isFinite(sourceX) || !Number.isFinite(sourceZ)) return false;
    remoteFlashLight.position.set(sourceX, 1.45, sourceZ);
    remoteFlashLight.intensity = reducedMotion ? 18 : 92;
    remoteFlashLight.visible = true;
    remoteFlashUntil = elapsed + (reducedMotion ? 0.08 : 0.22);
    camera.getWorldDirection(worldDirection);
    worldDirection.y = 0;
    worldDirection.normalize();
    rightDirection.crossVectors(worldDirection, up).normalize();
    const deltaX = sourceX - playerPosition.x;
    const deltaZ = sourceZ - playerPosition.y;
    const distance = Math.hypot(deltaX, deltaZ) || 1;
    const pan = clamp((deltaX * rightDirection.x + deltaZ * rightDirection.z) / distance, -1, 1);
    audio.ambientCue('ballast-pop', pan, 1);
    return true;
  }

  function triggerCameraFlash() {
    if (gameState !== 'playing' || elapsed < flashlightCooldownUntil) return false;
    const result = spendFlash(flashlightCharge, flashlightProfile.flashCost ?? 0.28);
    if (!result.fired) {
      showMessage('NOT ENOUGH CHARGE', 0.58);
      return false;
    }
    flashlightCharge = result.charge;
    persistFlashlightCharge();
    flashlightBoostUntil = elapsed + 0.18;
    flashlightCooldownUntil = elapsed + 1.8;
    noiseImpulse = Math.max(noiseImpulse, 1.75);
    flickerUntil = Math.max(flickerUntil, elapsed + 0.28);
    audio.flashBurst();
    camera.getWorldDirection(worldDirection);
    worldDirection.y = 0;
    worldDirection.normalize();
    if (multiplayerActive && !multiplayer.isHost) {
      multiplayer.sendObjectiveIntent({
        objectiveId: 'entity',
        action: 'flash',
        state: {
          position: { x: playerPosition.x, z: playerPosition.y },
          direction: { x: worldDirection.x, z: worldDirection.z },
        },
      }).catch(() => {});
    } else {
      applyCameraFlashAt(
        playerPosition.x,
        playerPosition.y,
        worldDirection.x,
        worldDirection.z,
        true,
      );
      if (multiplayerActive) {
        multiplayer.sendGameEvent({
          action: 'camera-flash',
          state: {
            playerId: multiplayer.self?.id,
            position: { x: playerPosition.x, z: playerPosition.y },
          },
        }).catch(() => {});
      }
    }
    updateEquipmentHud();
    sendLocalPlayerState(true);
    return true;
  }

  function updateSurvivalState(dt, moving, crouching, actualSpeed) {
    const previousOn = flashlightOn;
    const battery = stepBattery({
      charge: flashlightCharge,
      on: flashlightOn,
      playing: gameState === 'playing',
    }, dt, flashlightProfile);
    flashlightCharge = battery.charge;
    flashlightOn = battery.on;
    if (previousOn && !flashlightOn && flashlightCharge <= 0.001) {
      showMessage('THE FLASHLIGHT DIED', 0.8);
    }

    noiseImpulse = stepNoiseImpulse(noiseImpulse, dt);
    playerNoise = Math.max(movementNoise, noiseImpulse);
    const currentCell = maze.worldToCell(playerPosition.x, playerPosition.y);
    const currentCoords = maze.coords(currentCell);
    const fixtureLight = lightPool.some((light) => {
      if (!light.visible) return false;
      const lightCell = Number(light.userData.cell);
      if (!Number.isFinite(lightCell)) return false;
      const lightCoords = maze.coords(lightCell);
      const deltaCol = lightCoords.col - currentCoords.col;
      const deltaRow = lightCoords.row - currentCoords.row;
      const adjacent = Math.abs(deltaCol) + Math.abs(deltaRow) === 1;
      let openToLight = lightCell === currentCell;
      if (adjacent) {
        const direction = DIRECTIONS.find((entry) => entry.dc === deltaCol && entry.dr === deltaRow);
        openToLight = direction ? !maze.hasWall(currentCell, direction.bit) : false;
      }
      return openToLight
        && Math.hypot(light.position.x - playerPosition.x, light.position.z - playerPosition.y) < 5.2;
    });
    const teammateLight = [...remoteNetworkPlayers.values()].some((snapshot) => (
      snapshot.alive
      && snapshot.playing
      && snapshot.flashlight
      && Math.hypot(snapshot.position.x - playerPosition.x, snapshot.position.z - playerPosition.y) < 5.2
    ));
    playerInReliableLight = worldLightReliability > 0.3 && (fixtureLight || teammateLight);
    const hiding = stepHiding({ settle: hidingSettle }, dt, {
      shadowed: !playerInReliableLight,
      stationary: !moving && actualSpeed < 0.12,
      flashlightOn,
      noise: Math.max(playerNoise, noiseImpulse),
      crouching,
    });
    hidingSettle = hiding.settle;
    playerHidden = hiding.hidden;
    playerExposure = playerHidden
      ? 0.06
      : flashlightOn
        ? 1
        : crouching
          ? 0.3
          : playerInReliableLight
            ? 0.68
            : 0.22;
    dom.stealthState.hidden = !playerHidden;

    const burst = elapsed < flashlightBoostUntil;
    const lowChargeFlicker = flashlightCharge < 0.16
      && flashlightOn
      && !reducedMotion
      && cosmeticRandom() < dt * (2.2 + (0.16 - flashlightCharge) * 22);
    playerFlashlight.visible = burst || (flashlightOn && !lowChargeFlicker);
    flashlightBounce.visible = playerFlashlight.visible;
    const chargeIntensity = lerp(0.58, 1, clamp(flashlightCharge / 0.35, 0, 1));
    playerFlashlight.intensity = (flashlightProfile.intensity ?? (mobile ? 38 : 52))
      * chargeIntensity
      * (burst ? (reducedMotion ? 1.65 : 5.5) : 1);
    flashlightBounce.intensity = (burst ? (reducedMotion ? 2.1 : 7.5) : 1.25) * chargeIntensity;
    if (elapsed >= batteryPersistAt) {
      persistFlashlightCharge();
    }
    if (elapsed >= equipmentHudUpdateAt) {
      equipmentHudUpdateAt = elapsed + 0.1;
      updateEquipmentHud();
    }
  }

  function simulatePlayer(dt) {
    const forwardInput = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + touchInput.y;
    const strafeInput = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
      - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + touchInput.x;
    inputDirection.set(strafeInput, forwardInput);
    if (inputDirection.lengthSq() > 1) inputDirection.normalize();

    camera.getWorldDirection(worldDirection);
    worldDirection.y = 0;
    worldDirection.normalize();
    rightDirection.crossVectors(worldDirection, up).normalize();
    desiredDirection
      .copy(worldDirection)
      .multiplyScalar(inputDirection.y)
      .addScaledVector(rightDirection, inputDirection.x);
    if (desiredDirection.lengthSq() > 1) desiredDirection.normalize();

    const moving = inputDirection.lengthSq() > 0.015;
    const crouching = touchCrouch
      || keys.has('ControlLeft')
      || keys.has('ControlRight')
      || keys.has('KeyC');
    const wantsSprint = (keys.has('ShiftLeft') || keys.has('ShiftRight') || touchSprint) && moving && !crouching;
    const sprinting = wantsSprint && stamina > 0.035;
    const targetSpeed = crouching ? 1.25 : sprinting ? 4.35 : 2.28;
    const targetX = desiredDirection.x * targetSpeed;
    const targetZ = desiredDirection.z * targetSpeed;
    const response = 1 - Math.exp(-(moving ? 12 : 15) * dt);
    velocity.x = lerp(velocity.x, targetX, response);
    velocity.y = lerp(velocity.y, targetZ, response);

    if (sprinting) stamina = Math.max(0, stamina - dt * 0.235);
    else stamina = Math.min(1, stamina + dt * (moving ? 0.1 : 0.16));

    const displacementX = velocity.x * dt;
    const displacementZ = velocity.y * dt;
    const distance = Math.hypot(displacementX, displacementZ);
    const substeps = Math.max(1, Math.ceil(distance / (PLAYER_RADIUS * 0.36)));
    for (let step = 0; step < substeps; step += 1) {
      playerPosition.x += displacementX / substeps;
      playerPosition.y += displacementZ / substeps;
      resolveCollision();
    }

    const actualSpeed = velocity.length();
    playerCrouching = crouching;
    playerRunning = sprinting;
    playerActualSpeed = actualSpeed;
    const noiseTarget = !moving ? 0 : crouching ? 0.12 : sprinting ? 1 : 0.42;
    movementNoise = lerp(movementNoise, noiseTarget, 1 - Math.exp(-5 * dt));
    playerNoise = Math.max(movementNoise, noiseImpulse);
    if (moving && actualSpeed > 0.3) {
      stepDistance += actualSpeed * dt;
      const stride = sprinting ? 1.45 : crouching ? 2.2 : 1.75;
      if (stepDistance >= stride) {
        stepDistance = 0;
        audio.footstep(sprinting);
      }
      headBob += dt * actualSpeed * (sprinting ? 3.05 : 2.55);
    }

    const targetEye = crouching ? 1.12 : EYE_HEIGHT;
    currentEyeHeight = lerp(currentEyeHeight, targetEye, 1 - Math.exp(-9 * dt));
    const bobAmount = reducedMotion || crouching ? 0 : Math.sin(headBob * Math.PI) * Math.min(actualSpeed / 4, 1) * 0.035;
    camera.position.set(playerPosition.x, currentEyeHeight + bobAmount, playerPosition.y);
    updateSurvivalState(dt, moving, crouching, actualSpeed);

    dom.stamina.classList.toggle('is-visible', stamina < 0.98 || wantsSprint);
    dom.staminaFill.style.transform = `scaleX(${stamina})`;
  }

  function updateLights() {
    const playerCell = maze.worldToCell(playerPosition.x, playerPosition.y);
    const { col: playerCol, row: playerRow } = maze.coords(playerCell);
    const candidates = [];
    const radius = mobile ? 2 : 3;

    for (let row = Math.max(0, playerRow - radius); row <= Math.min(rows - 1, playerRow + radius); row += 1) {
      for (let col = Math.max(0, playerCol - radius); col <= Math.min(cols - 1, playerCol + radius); col += 1) {
        const index = maze.index(col, row);
        if (fixtureStates[index].broken) continue;
        const center = maze.cellToWorld(index);
        candidates.push({ index, center, distance: center.distanceToSquared(camera.position) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);

    const activeLights = lightPool.slice(0, activeLightCount);
    lightPool.slice(activeLightCount).forEach((light) => { light.visible = false; });
    const candidatesByCell = new Map(candidates.map((candidate) => [candidate.index, candidate]));
    const usedCells = new Set();
    const assignments = new Array(activeLights.length);
    activeLights.forEach((light, index) => {
      const current = candidatesByCell.get(light.userData.cell);
      const stableRadius = index === 0 ? 5.2 : 7.8;
      if (current && current.distance < stableRadius * stableRadius && !usedCells.has(current.index)) {
        assignments[index] = current;
        usedCells.add(current.index);
      }
    });
    activeLights.forEach((light, index) => {
      if (assignments[index]) return;
      const next = candidates.find((candidate) => !usedCells.has(candidate.index));
      if (next) {
        assignments[index] = next;
        usedCells.add(next.index);
      }
    });

    activeLights.forEach((light, index) => {
      const candidate = assignments[index];
      if (!candidate) {
        light.visible = false;
        return;
      }
      light.visible = true;
      if (light.userData.cell === candidate.index) return;
      light.userData.cell = candidate.index;
      light.position.set(candidate.center.x, WALL_HEIGHT - 0.11, candidate.center.z);
      light.target.position.set(candidate.center.x, 0, candidate.center.z);
    });
  }

  function hasClearLine(startX, startZ, endX, endZ) {
    const deltaX = endX - startX;
    const deltaZ = endZ - startZ;
    const endpointEpsilon = 0.02 / Math.max(0.02, Math.hypot(deltaX, deltaZ));
    for (const box of colliders) {
      let minimum = 0;
      let maximum = 1;
      if (Math.abs(deltaX) < 0.000001) {
        if (startX < box.minX || startX > box.maxX) continue;
      } else {
        let near = (box.minX - startX) / deltaX;
        let far = (box.maxX - startX) / deltaX;
        if (near > far) [near, far] = [far, near];
        minimum = Math.max(minimum, near);
        maximum = Math.min(maximum, far);
        if (minimum > maximum) continue;
      }
      if (Math.abs(deltaZ) < 0.000001) {
        if (startZ < box.minZ || startZ > box.maxZ) continue;
      } else {
        let near = (box.minZ - startZ) / deltaZ;
        let far = (box.maxZ - startZ) / deltaZ;
        if (near > far) [near, far] = [far, near];
        minimum = Math.max(minimum, near);
        maximum = Math.min(maximum, far);
        if (minimum > maximum) continue;
      }
      if (minimum <= maximum && maximum > endpointEpsilon && minimum < 1 - endpointEpsilon) return false;
    }
    return true;
  }

  function placeEntity(mode) {
    const spawnPlayers = [{
      id: 'local',
      x: playerPosition.x,
      z: playerPosition.y,
      noise: playerNoise,
    }];
    for (const snapshot of remoteNetworkPlayers.values()) {
      if (
        snapshot.alive
        && snapshot.playing
        && performance.now() - snapshot.receivedAt < 2500
      ) spawnPlayers.push({
        id: snapshot.id,
        x: snapshot.position.x,
        z: snapshot.position.z,
        noise: snapshot.noise,
      });
    }
    const anchor = spawnPlayers.find((player) => player.id === entityTargetPlayerId)
      || [...spawnPlayers].sort((left, right) => right.noise - left.noise)[0];
    const playerCell = maze.worldToCell(anchor.x, anchor.z);
    let targetCell;
    if (mode === 'glimpse') {
      const distances = maze.distanceMap(playerCell);
      const visibleCells = [];
      for (let i = 0; i < distances.length; i += 1) {
        if (distances[i] < 4 || distances[i] > 10) continue;
        const candidate = maze.cellToWorld(i);
        const worldDistance = Math.hypot(candidate.x - anchor.x, candidate.z - anchor.z);
        const clearOfPlayers = spawnPlayers.every((player) => (
          Math.hypot(candidate.x - player.x, candidate.z - player.z) > 4.5
        ));
        if (
          worldDistance > 6
          && worldDistance < 23.5
          && clearOfPlayers
          && hasClearLine(anchor.x, anchor.z, candidate.x, candidate.z)
        ) visibleCells.push(i);
      }
      if (!visibleCells.length) return false;
      targetCell = visibleCells[Math.floor(random() * visibleCells.length)];
    } else {
      const distances = maze.distanceMap(playerCell);
      const hiddenCells = [];
      for (let i = 0; i < distances.length; i += 1) {
        if (distances[i] < 8 || distances[i] > 17 || i === exitIndex) continue;
        const candidate = maze.cellToWorld(i);
        const hiddenFromEveryone = spawnPlayers.every((player) => (
          Math.hypot(candidate.x - player.x, candidate.z - player.z) > 6
          && !hasClearLine(player.x, player.z, candidate.x, candidate.z)
        ));
        if (hiddenFromEveryone) hiddenCells.push(i);
      }
      if (!hiddenCells.length) return false;
      targetCell = hiddenCells[Math.floor(random() * hiddenCells.length)];
    }
    const target = maze.cellToWorld(targetCell);
    entity.position.set(target.x, 0, target.z);
    entity.rotation.y = Math.atan2(anchor.x - target.x, anchor.z - target.z);
    entity.visible = true;
    entityMode = mode;
    dom.game.dataset.monsterMode = entityMode;
    entityUntil = mode === 'glimpse'
      ? elapsed + level.monster.timing.glimpseDuration
      : mode === 'stalk'
        ? elapsed + level.monster.timing.stalkDuration
        : Infinity;
    entityLastKnownCell = playerCell;
    entityTargetPlayerId = anchor.id;
    entityTargetPlayerX = anchor.x;
    entityTargetPlayerZ = anchor.z;
    entityTargetPlayerNoise = anchor.noise;
    entityPath = [];
    entityPathIndex = 0;
    entityPathUpdate = 0;
    entitySeenFor = 0;
    entityLostSight = 0;
    entityCurrentSpeed = 0;
    entityStepDistance = 0;
    entityStuckTime = 0;
    entityAnimationStart = elapsed;
    entityPerceptionUpdate = 0;
    return true;
  }

  function hideEntity() {
    entity.visible = false;
    entityMode = 'hidden';
    dom.game.dataset.monsterMode = entityMode;
    entityPath = [];
    entitySeenFor = 0;
    entityCurrentSpeed = 0;
    entityCanSeePlayer = false;
    entitySightContact = false;
    entityHeardPlayer = false;
    entityAwareness = 0;
    entityStuckTime = 0;
    animateMonster(entity, { time: elapsed - entityAnimationStart, speed: 0, mode: 'hidden', distance: Infinity });
  }

  function updateNetworkEntity(dt) {
    const state = networkMonsterState;
    const stateAge = performance.now() - networkMonsterReceivedAt;
    if (!state || stateAge > 3500) {
      entity.visible = false;
      entityMode = 'hidden';
      entityCurrentSpeed = lerp(entityCurrentSpeed, 0, 1 - Math.exp(-6 * dt));
      return Infinity;
    }
    const visible = state.visible !== false && state.mode !== 'hidden';
    entity.visible = visible;
    entityMode = visible ? String(state.mode || 'stalk') : 'hidden';
    entityAwareness = clamp(Number(state.awareness) || 0, 0, 1);
    if (!visible) {
      animateMonster(entity, { time: elapsed - entityAnimationStart, speed: 0, mode: 'hidden', distance: Infinity });
      return Infinity;
    }
    const frameStartX = entity.position.x;
    const frameStartZ = entity.position.z;
    const targetX = Number(state.x ?? state.position?.x);
    const targetZ = Number(state.z ?? state.position?.z);
    if (stateAge < 700 && Number.isFinite(targetX) && Number.isFinite(targetZ)) {
      const alpha = 1 - Math.exp(-12 * dt);
      entity.position.x = lerp(entity.position.x, targetX, alpha);
      entity.position.z = lerp(entity.position.z, targetZ, alpha);
    }
    const targetYaw = Number(state.yaw);
    if (Number.isFinite(targetYaw)) {
      const yawDelta = Math.atan2(
        Math.sin(targetYaw - entity.rotation.y),
        Math.cos(targetYaw - entity.rotation.y),
      );
      entity.rotation.y += yawDelta * (1 - Math.exp(-14 * dt));
    }
    entity.position.y = 0;
    const transmittedSpeed = stateAge < 700 ? Math.max(0, Number(state.speed) || 0) : 0;
    entityCurrentSpeed = lerp(entityCurrentSpeed, transmittedSpeed, 1 - Math.exp(-10 * dt));
    const actualMovement = Math.hypot(entity.position.x - frameStartX, entity.position.z - frameStartZ);
    entityActualSpeed = clamp(
      actualMovement / Math.max(0.001, dt),
      0,
      level.monster.speeds.chase * 1.2,
    );
    const distance = Math.hypot(entity.position.x - playerPosition.x, entity.position.z - playerPosition.y);
    entityVector.copy(entity.position).sub(camera.position);
    entityVector.y = 0;
    if (entityVector.lengthSq() > 0.0001) entityVector.normalize();
    animateMonster(entity, {
      time: elapsed - entityAnimationStart,
      speed: entityActualSpeed,
      mode: distance < 1.8 ? 'attack' : entityMode,
      distance,
    });
    networkMonsterStepDistance += actualMovement;
    const stride = entityMode === 'chase' ? 0.9 : 0.72;
    if (stateAge < 700 && networkMonsterStepDistance >= stride) {
      networkMonsterStepDistance -= stride;
      const pan = clamp(rightDirection.dot(entityVector), -1, 1);
      audio.monsterStep(pan, distance, entityMode === 'chase');
    }
    dom.game.dataset.monsterMode = entityMode;
    return distance;
  }

  function updateEntity(dt) {
    if (entityMode === 'hidden') return Infinity;
    const entityFrameStartX = entity.position.x;
    const entityFrameStartZ = entity.position.z;
    entityVector.copy(entity.position).sub(camera.position);
    entityVector.y = 0;
    const distance = entityVector.length();
    entityVector.normalize();
    camera.getWorldDirection(worldDirection);
    worldDirection.y = 0;
    worldDirection.normalize();
    rightDirection.crossVectors(worldDirection, up).normalize();
    const lookDot = worldDirection.dot(entityVector);
    const lookingAtEntity = lookDot > 0.965
      && distance < 24
      && hasClearLine(playerPosition.x, playerPosition.y, entity.position.x, entity.position.z);

    const entityCell = maze.worldToCell(entity.position.x, entity.position.z);
    const playerCell = maze.worldToCell(playerPosition.x, playerPosition.y);
    if (entityTargetPlayerId === 'local') {
      entityTargetPlayerX = playerPosition.x;
      entityTargetPlayerZ = playerPosition.y;
      entityTargetPlayerNoise = playerNoise;
      entityTargetHidden = playerHidden;
      entityTargetExposure = playerExposure;
    } else {
      const trackedPlayer = remoteNetworkPlayers.get(entityTargetPlayerId);
      if (trackedPlayer?.alive && trackedPlayer.playing) {
        entityTargetPlayerX = trackedPlayer.position.x;
        entityTargetPlayerZ = trackedPlayer.position.z;
        entityTargetPlayerNoise = trackedPlayer.noise;
        entityTargetHidden = trackedPlayer.hidden;
        entityTargetExposure = trackedPlayer.exposure;
      } else {
        entityTargetPlayerId = 'local';
        entityTargetPlayerX = playerPosition.x;
        entityTargetPlayerZ = playerPosition.y;
        entityTargetPlayerNoise = playerNoise;
        entityTargetHidden = playerHidden;
        entityTargetExposure = playerExposure;
      }
    }
    let focusDistance = Math.hypot(
      entityTargetPlayerX - entity.position.x,
      entityTargetPlayerZ - entity.position.z,
    );
    let focusCell = maze.worldToCell(entityTargetPlayerX, entityTargetPlayerZ);
    entityPerceptionUpdate -= dt;
    if (entityPerceptionUpdate <= 0) {
      const candidates = [{
        id: 'local',
        x: playerPosition.x,
        z: playerPosition.y,
        noise: playerNoise,
        speed: playerActualSpeed,
        flashlight: flashlightOn,
        hidden: playerHidden,
        exposure: playerExposure,
        crouching: playerCrouching,
        yaw: camera.rotation.y + Math.PI,
        alive: localAlive,
        playing: true,
      }];
      for (const snapshot of remoteNetworkPlayers.values()) {
        if (performance.now() - snapshot.receivedAt > 3000) continue;
        candidates.push({
          id: snapshot.id,
          x: snapshot.position.x,
          z: snapshot.position.z,
            noise: snapshot.noise,
            speed: snapshot.speed,
            flashlight: snapshot.flashlight,
            hidden: snapshot.hidden,
            exposure: snapshot.exposure,
            crouching: snapshot.crouching,
            yaw: snapshot.yaw,
          alive: snapshot.alive,
          playing: snapshot.playing,
        });
      }
      let detected = null;
      let watchedByAny = false;
      for (const candidate of candidates) {
        if (!candidate.alive || !candidate.playing) continue;
        const deltaX = candidate.x - entity.position.x;
        const deltaZ = candidate.z - entity.position.z;
        const candidateDistance = Math.hypot(deltaX, deltaZ);
        const inverseDistance = 1 / Math.max(0.001, candidateDistance);
        const forwardDot = Math.sin(entity.rotation.y) * deltaX * inverseDistance
          + Math.cos(entity.rotation.y) * deltaZ * inverseDistance;
        const candidateCell = maze.worldToCell(candidate.x, candidate.z);
        const shadowed = fixtureStates[candidateCell]?.broken || worldLightReliability < 0.3;
        const hidden = Boolean(
          candidate.hidden
          && shadowed
          && !candidate.flashlight
          && candidate.noise < 0.16
          && candidate.speed < 0.18
        );
        const exposure = hidden
          ? 0.06
          : candidate.flashlight
            ? 1
            : candidate.crouching
              ? 0.3
              : shadowed
                ? 0.22
                : 0.68;
        const perception = perceptionProfile({ ...candidate, hidden });
        const sightConfig = level.monster.behavior?.sight || {};
        const configuredRange = Number(sightConfig.range) || 23;
        const sightRange = hidden
          ? perception.sightRange
          : configuredRange * (candidate.flashlight ? 1.12 : candidate.crouching ? 0.72 : 1);
        const sight = candidateDistance < sightRange
          && (forwardDot > (Number(sightConfig.peripheralDot) || 0.24) || candidateDistance < (hidden ? 3.4 : 4.5))
          && hasClearLine(entity.position.x, entity.position.z, candidate.x, candidate.z);
        const toEntityX = entity.position.x - candidate.x;
        const toEntityZ = entity.position.z - candidate.z;
        const gazeDot = Math.sin(candidate.yaw || 0) * toEntityX * inverseDistance
          + Math.cos(candidate.yaw || 0) * toEntityZ * inverseDistance;
        const watched = candidateDistance < 24
          && gazeDot > 0.965
          && hasClearLine(candidate.x, candidate.z, entity.position.x, entity.position.z);
        if (watched) watchedByAny = true;
        let heard = false;
        let routeDistance = Infinity;
        if (candidate.noise > 0.1) {
          routeDistance = maze.shortestPath(entityCell, candidateCell).length - 1;
          const hearingConfig = level.monster.behavior?.hearing || {};
          const hearingRange = (Number(hearingConfig.baseCells) || 2)
            + Math.round(candidate.noise * (Number(hearingConfig.noiseCells) || 9));
          heard = routeDistance >= 0 && routeDistance <= hearingRange;
        }
        if (!sight && !heard) continue;
        const score = (sight ? 120 - candidateDistance * 2 : 54 - routeDistance * 2)
          + candidate.noise * 18
          + perception.scoreBias
          + (candidate.id === entityTargetPlayerId ? 7 : 0);
        if (!detected || score > detected.score) detected = {
          ...candidate,
          cell: candidateCell,
          distance: candidateDistance,
          sight,
          heard,
          watched,
          hidden,
          exposure,
          awarenessRate: perception.awarenessRate,
          score,
        };
      }
      entitySightContact = Boolean(detected?.sight);
      entityHeardPlayer = Boolean(detected?.heard);
      if (detected) {
        entityTargetPlayerId = detected.id;
        entityTargetPlayerX = detected.x;
        entityTargetPlayerZ = detected.z;
        entityTargetPlayerNoise = detected.noise;
        entityTargetHidden = detected.hidden;
        entityTargetExposure = detected.exposure;
        entityTargetAwarenessRate = detected.awarenessRate;
        focusDistance = detected.distance;
        focusCell = detected.cell;
      }
      entityTargetWatched = watchedByAny || elapsed < flashWatchUntil;
      entityPerceptionUpdate = 0.12;
    }
    const sightAcquireRate = Number(level.monster.behavior?.sight?.acquireRate) || 1.4;
    entityAwareness = clamp(
      entityAwareness + dt * (
        entitySightContact
          ? sightAcquireRate
            * entityTargetAwarenessRate
            * lerp(0.3, 1.15, clamp(entityTargetExposure, 0, 1))
            + entityTargetPlayerNoise * 0.9
          : -0.62
      ),
      0,
      1,
    );
    entityCanSeePlayer = entitySightContact
      && entityAwareness > (Number(level.monster.behavior?.sight?.threshold) || 0.42);
    if (entityCanSeePlayer || entityHeardPlayer) entityLastKnownCell = focusCell;

    if (entityMode === 'glimpse') {
      if (lookingAtEntity || entityTargetWatched) entitySeenFor += dt;
      animateMonster(entity, { time: elapsed - entityAnimationStart, speed: 0, mode: 'glimpse', distance });
      if (elapsed > entityUntil || entitySeenFor > 0.52 || distance < 3.5) {
        entityMode = 'stalk';
        entityUntil = elapsed + level.monster.timing.stalkDuration;
        entityPathUpdate = 0;
        audio.powerDip(elapsed, 0.38);
      }
      return distance;
    }

    if (
      entityMode === 'stalk'
      && (
        (entityCanSeePlayer && focusDistance < level.monster.stalkTriggerDistance)
        || (entityHeardPlayer && entityTargetPlayerNoise > (Number(level.monster.behavior?.hearing?.chaseNoise) || 0.78))
      )
    ) {
      entityMode = 'chase';
      showMessage('RUN', 0.72);
      audio.impact();
      flickerUntil = elapsed + 2.2;
    } else if (entityMode === 'stalk' && elapsed > entityUntil) {
      entityMode = 'search';
      entityUntil = elapsed + 7 + random() * 4;
      entityPathUpdate = 0;
    }

    if (entityMode === 'chase') {
      if (entityCanSeePlayer) entityLostSight = 0;
      else entityLostSight += dt * (entityTargetHidden ? 1.75 : 1);
      if (entityLostSight > (Number(level.monster.behavior?.chase?.lostSightDelay) || 5.5) && !entityHeardPlayer) {
        entityMode = 'search';
        entityUntil = elapsed + randomBetween(
          level.monster.behavior?.chase?.searchDuration || [8, 13],
          random,
        );
        entityPathUpdate = 0;
      }
    } else if (entityMode === 'search') {
      if (
        entityCanSeePlayer
        || (entityHeardPlayer && entityTargetPlayerNoise > (Number(level.monster.behavior?.hearing?.reacquireNoise) || 0.45))
      ) {
        entityMode = 'chase';
        entityLostSight = 0;
        showMessage('IT FOUND YOU', 0.5);
      } else if (elapsed > entityUntil) {
        hideEntity();
        nextChase = elapsed + randomBetween(
          level.monster.behavior?.chase?.recovery || [14, 22],
          random,
        );
        huntRecoveryUntil = nextChase;
        return Infinity;
      }
    }

    entityPathUpdate -= dt;
    if (entityPathUpdate <= 0) {
      const entityCellCenter = maze.cellToWorld(entityCell);
      const nearCellCenter = Math.hypot(
        entity.position.x - entityCellCenter.x,
        entity.position.z - entityCellCenter.z,
      ) < 0.52;
      if (!nearCellCenter && entityPath.length > 1 && entityPathIndex < entityPath.length) {
        entityPathUpdate = 0.08;
      } else {
        if (
          (entityMode === 'stalk' || entityMode === 'search')
          && !entityCanSeePlayer
          && !entityHeardPlayer
          && entityPathIndex >= entityPath.length - 1
        ) {
          entityLastKnownCell = maze.randomCellAtDistance(
            entityCell,
            ...(level.monster.behavior?.wanderCells || [2, 6]),
            random,
          );
        }
        entityPath = maze.shortestPath(entityCell, entityLastKnownCell);
        entityPathIndex = Math.min(1, entityPath.length - 1);
        entityPathUpdate = entityMode === 'chase'
          ? level.monster.timing.pathRefresh.chase
          : entityMode === 'search'
            ? 0.5
            : level.monster.timing.pathRefresh.stalk;
      }
    }

    let targetSpeed = 0;
    if (entityPath.length) {
      const target = entityCell === entityLastKnownCell && (entityCanSeePlayer || entityHeardPlayer)
        ? entityTarget.set(entityTargetPlayerX, 0, entityTargetPlayerZ)
        : entityPath.length > 1 && entityPathIndex < entityPath.length
          ? maze.cellToWorld(entityPath[entityPathIndex])
          : entityTarget.copy(maze.cellToWorld(entityLastKnownCell));
      const direction = entityTarget.copy(target).sub(entity.position);
      direction.y = 0;
      const targetDistance = direction.length();
      if (targetDistance < 0.16) entityPathIndex += 1;
      else {
        direction.normalize();
        targetSpeed = entityMode === 'chase'
          ? level.monster.speeds.chase
          : entityMode === 'search'
            ? level.monster.speeds.stalk * 1.14
            : entityTargetWatched
              ? level.monster.speeds.watched
              : level.monster.speeds.stalk;
        entityCurrentSpeed = lerp(entityCurrentSpeed, targetSpeed, 1 - Math.exp(-4.5 * dt));
        const movement = Math.min(entityCurrentSpeed * dt, targetDistance);
        const targetYaw = Math.atan2(direction.x, direction.z);
        const yawDelta = Math.atan2(Math.sin(targetYaw - entity.rotation.y), Math.cos(targetYaw - entity.rotation.y));
        entity.rotation.y += yawDelta * Math.min(1, dt * (entityMode === 'chase' ? 8 : 4.5));
        const alignment = clamp(Math.cos(yawDelta), 0, 1);
        entity.position.x += Math.sin(entity.rotation.y) * movement * alignment;
        entity.position.z += Math.cos(entity.rotation.y) * movement * alignment;
        resolveEntityCollision();
      }
    }

    if (targetSpeed === 0) entityCurrentSpeed = lerp(entityCurrentSpeed, 0, 1 - Math.exp(-7 * dt));
    entity.position.y = 0;
    const actualMovement = Math.hypot(
      entity.position.x - entityFrameStartX,
      entity.position.z - entityFrameStartZ,
    );
    if (targetSpeed > 0.05 && actualMovement < 0.0015) entityStuckTime += dt;
    else entityStuckTime = Math.max(0, entityStuckTime - dt * 2);
    if (entityStuckTime > 0.72) {
      entityPathIndex = Math.min(entityPathIndex + 1, Math.max(0, entityPath.length - 1));
      entityPathUpdate = 0;
      entityStuckTime = 0;
      entity.rotation.y += (random() - 0.5) * 0.7;
    }
    const actualSpeed = clamp(
      actualMovement / Math.max(0.001, dt),
      0,
      level.monster.speeds.chase * 1.2,
    );
    entityActualSpeed = actualSpeed;
    entityStepDistance += actualMovement;
    const updatedDistance = Math.hypot(entity.position.x - playerPosition.x, entity.position.z - playerPosition.y);
    const soundPan = clamp(rightDirection.dot(entityVector), -1, 1);
    const monsterStride = entityMode === 'chase' ? 0.9 : 0.72;
    if (entityStepDistance >= monsterStride) {
      entityStepDistance -= monsterStride;
      audio.monsterStep(soundPan, updatedDistance, entityMode === 'chase');
    }
    animateMonster(entity, {
      time: elapsed - entityAnimationStart,
      speed: actualSpeed,
      mode: updatedDistance < 1.8 ? 'attack' : entityMode,
      distance: updatedDistance,
    });
    if (
      localAlive
      && gameState === 'playing'
      && updatedDistance < level.monster.catchDistance
      && hasClearLine(entity.position.x, entity.position.z, playerPosition.x, playerPosition.y)
    ) die();
    if (multiplayerActive && multiplayer.isHost && performance.now() - lastKillIntentAt > 900) {
      for (const snapshot of remoteNetworkPlayers.values()) {
        if (
          !snapshot.alive
          || !snapshot.playing
          || performance.now() - snapshot.receivedAt > 750
          || killedRemotePlayers.has(snapshot.id)
          || pendingRemoteKills.has(snapshot.id)
        ) continue;
        const remoteDistance = Math.hypot(
          entity.position.x - snapshot.position.x,
          entity.position.z - snapshot.position.z,
        );
        if (
          remoteDistance >= level.monster.catchDistance
          || !hasClearLine(entity.position.x, entity.position.z, snapshot.position.x, snapshot.position.z)
        ) continue;
        lastKillIntentAt = performance.now();
        pendingRemoteKills.add(snapshot.id);
        multiplayer.sendGameEvent({
          action: 'player-killed',
          state: { playerId: snapshot.id, monsterMode: entityMode },
        }).then(() => {
          killedRemotePlayers.add(snapshot.id);
          snapshot.alive = false;
          snapshot.visible = false;
          remotePlayers.upsert({ ...snapshot, visible: false, speed: 0 });
        }).catch(() => {
          showMessage('KILL SIGNAL LOST', 0.55);
        }).finally(() => {
          pendingRemoteKills.delete(snapshot.id);
        });
        break;
      }
    }
    return updatedDistance;
  }

  function triggerScare() {
    const type = Math.floor(random() * 4);
    if (type === 0) {
      flickerUntil = elapsed + 1.2 + random() * 1.3;
      audio.powerDip(elapsed, 0.7 + random() * 0.8);
    } else if (
      type === 1
      && entityMode === 'hidden'
      && elapsed >= huntRecoveryUntil
      && placeEntity('glimpse')
    ) {
      audio.scare(random() > 0.5 ? -0.75 : 0.75);
    } else if (type === 2) {
      audio.scare(random() * 2 - 1);
      if (random() > 0.55) showMessage('DID YOU HEAR THAT?', 0.62);
    } else {
      flickerUntil = elapsed + 0.58;
      audio.powerDip(elapsed, 0.24);
    }
    nextScare = elapsed + randomBetween(level.monster.timing.scareInterval, random);
  }

  function hydrateMonsterAuthority() {
    const state = networkMonsterState;
    if (!state) {
      hideEntity();
      publishMonsterState(true);
      return;
    }
    const targetX = Number(state.x ?? state.position?.x);
    const targetZ = Number(state.z ?? state.position?.z);
    if (Number.isFinite(targetX) && Number.isFinite(targetZ)) entity.position.set(targetX, 0, targetZ);
    if (Number.isFinite(Number(state.yaw))) entity.rotation.y = Number(state.yaw);
    entityMode = String(state.mode || 'hidden');
    entity.visible = state.visible !== false && entityMode !== 'hidden';
    entityCurrentSpeed = Math.max(0, Number(state.speed) || 0);
    entityActualSpeed = entityCurrentSpeed;
    entityAwareness = clamp(Number(state.awareness) || 0, 0, 1);
    entityLostSight = Math.max(0, Number(state.lostSight) || 0);
    entityLastKnownCell = Number.isFinite(Number(state.lastKnownCell))
      ? clamp(Math.trunc(Number(state.lastKnownCell)), 0, maze.cells.length - 1)
      : maze.worldToCell(entity.position.x, entity.position.z);
    entityAnimationStart = elapsed - Math.max(0, Number(state.animationTime) || 0);
    const safeDuration = entityMode === 'glimpse'
      ? level.monster.timing.glimpseDuration
      : entityMode === 'search'
        ? 8
        : level.monster.timing.stalkDuration;
    entityUntil = entityMode === 'chase'
      ? Infinity
      : elapsed + Math.max(0.8, Number(state.modeRemaining) || safeDuration);
    nextScare = state.nextScareRemaining !== null
      && state.nextScareRemaining !== undefined
      && Number.isFinite(Number(state.nextScareRemaining))
      ? elapsed + Math.max(0.8, Number(state.nextScareRemaining))
      : elapsed + randomBetween(level.monster.timing.scareInterval, random);
    nextChase = state.nextChaseRemaining !== null
      && state.nextChaseRemaining !== undefined
      && Number.isFinite(Number(state.nextChaseRemaining))
      ? elapsed + Math.max(0.8, Number(state.nextChaseRemaining))
      : entityMode === 'hidden'
        ? elapsed + 3
        : Infinity;
    const recoveryRemaining = Number(state.recoveryRemaining);
    huntRecoveryUntil = entityMode === 'hidden'
      && Number.isFinite(recoveryRemaining)
      && recoveryRemaining > 0
      ? elapsed + recoveryRemaining
      : 0;
    entityTargetPlayerId = state.targetPlayerId === multiplayer.self?.id
      ? 'local'
      : String(state.targetPlayerId || 'local');
    const tracked = entityTargetPlayerId === 'local'
      ? null
      : remoteNetworkPlayers.get(entityTargetPlayerId);
    if (tracked?.alive) {
      entityTargetPlayerX = tracked.position.x;
      entityTargetPlayerZ = tracked.position.z;
      entityTargetPlayerNoise = tracked.noise;
    } else {
      entityTargetPlayerId = 'local';
      entityTargetPlayerX = playerPosition.x;
      entityTargetPlayerZ = playerPosition.y;
      entityTargetPlayerNoise = playerNoise;
    }
    entityPath = [];
    entityPathIndex = 0;
    entityPathUpdate = 0;
    entityPerceptionUpdate = 0;
    entitySeenFor = 0;
    entityStepDistance = 0;
    monsterPublishSignature = '';
    publishMonsterState(true);
  }

  function publishMonsterState(force = false) {
    if (
      !multiplayerActive
      || !multiplayer.isHost
      || !multiplayer.isConnected
      || roomNavigationPending
    ) return;
    const now = performance.now();
    const cadence = entityMode === 'hidden' ? 800 : entityActualSpeed < 0.05 ? 220 : 90;
    if (monsterPublishPending || (!force && now - lastMonsterNetworkUpdate < cadence)) return;
    const state = {
      visible: entity.visible,
      mode: entityMode,
      x: entity.position.x,
      z: entity.position.z,
      yaw: entity.rotation.y,
      speed: entityActualSpeed,
      awareness: entityAwareness,
      animationTime: elapsed - entityAnimationStart,
      targetPlayerId: entityTargetPlayerId === 'local' ? multiplayer.self?.id : entityTargetPlayerId,
      lastKnownCell: entityLastKnownCell,
      lostSight: entityLostSight,
      modeRemaining: Number.isFinite(entityUntil) ? Math.max(0, entityUntil - elapsed) : null,
      nextScareRemaining: Number.isFinite(nextScare) ? Math.max(0, nextScare - elapsed) : null,
      nextChaseRemaining: Number.isFinite(nextChase) ? Math.max(0, nextChase - elapsed) : null,
      recoveryRemaining: Math.max(0, huntRecoveryUntil - elapsed),
    };
    const signature = [
      state.visible,
      state.mode,
      Math.round(state.x * 20),
      Math.round(state.z * 20),
      Math.round(state.yaw * 40),
      Math.round(state.speed * 20),
      Math.round(state.awareness * 10),
      state.targetPlayerId,
      state.lastKnownCell,
    ].join('|');
    if (!force && signature === monsterPublishSignature && now - monsterPublishSucceededAt < 1200) return;
    lastMonsterNetworkUpdate = now;
    monsterPublishPending = true;
    multiplayer.sendMonsterEvent({
      action: 'state',
      state,
    }).then(() => {
      monsterPublishSignature = signature;
      monsterPublishSucceededAt = performance.now();
    }).catch(() => {}).finally(() => {
      monsterPublishPending = false;
    });
  }

  function updateDirector(dt) {
    const doorDistance = camera.position.distanceTo(exitGroup.position);
    const networkGuest = multiplayerActive && !multiplayer.isHost;
    const entityDistance = networkGuest ? updateNetworkEntity(dt) : updateEntity(dt);
    const nearTeammate = [...remoteNetworkPlayers.values()].some((snapshot) => (
      snapshot.alive
      && snapshot.playing
      && Math.hypot(snapshot.position.x - playerPosition.x, snapshot.position.z - playerPosition.y) < 13
    ));
    const localPursuit = entityMode === 'chase' && (
      !multiplayerActive
      || (multiplayer.isHost
        ? entityTargetPlayerId === 'local'
        : networkMonsterState?.targetPlayerId === multiplayer.self?.id)
    );
    fear = stepFear(fear, dt, {
      monsterMode: entityMode,
      entityDistance,
      awareness: entityAwareness,
      flashlightOn,
      reliableLight: playerInReliableLight,
      charge: flashlightCharge,
      nearTeammate,
      hidden: playerHidden,
      pursuitFocused: entityMode !== 'chase' || localPursuit,
    });
    const immediateDanger = Number.isFinite(entityDistance)
      ? clamp(1 - entityDistance / 24, 0, 1) * 0.54
      : 0;
    const modePressure = entityMode === 'chase'
      ? (localPursuit ? 0.34 : 0.08)
      : entityMode === 'search'
        ? 0.18
        : entityMode === 'stalk' || entityMode === 'glimpse'
          ? 0.1
          : 0;
    const objectivePressure = objectiveTotal > 0 ? (objectivesCompleted / objectiveTotal) * 0.08 : 0;
    tension = clamp(
      immediateDanger
        + modePressure
        + fear * 0.34
        + objectivePressure
        + (doorDistance < 16 ? 0.06 : 0),
      0,
      1,
    );

    const atmosphereEvents = atmosphereDirector.update({
      elapsed,
      tension,
      monsterMode: entityMode,
      moving: playerActualSpeed > 0.25,
      objectivesCompleted,
      objectiveTotal,
    });
    for (const event of atmosphereEvents) {
      if (event.message) showMessage(event.message, event.duration);
      if (Number(event.effect?.flicker) > 0) {
        flickerUntil = Math.max(flickerUntil, elapsed + Number(event.effect.flicker));
      }
      if (Number(event.effect?.silence) > 0) audio.powerDip(elapsed, Number(event.effect.silence));
      if (!reducedMotion && Number(event.effect?.glitch) > 0) {
        glitchUntil = Math.max(glitchUntil, elapsed + Number(event.effect.glitch));
      }
      if (event.cue) audio.ambientCue(event.cue, event.pan, event.intensity);
    }
    dom.game.classList.toggle('is-glitching', !reducedMotion && elapsed < glitchUntil);

    if (!networkGuest && elapsed > nextScare && entityMode !== 'chase') triggerScare();
    if (!networkGuest && elapsed > nextChase && entityMode === 'hidden') {
      if (placeEntity('stalk')) {
        nextChase = Infinity;
        audio.scare(0);
      } else nextChase = elapsed + 3 + random() * 3;
    }
    if (!networkGuest) publishMonsterState();

    const flickering = !reducedMotion && elapsed < flickerUntil;
    let lightMultiplier = 1;
    if (flickering) {
      const intensity = cosmeticRandom();
      const faultFloor = Number(level.lighting.fixture.flicker?.faultFloor) || 0.025;
      lightMultiplier = intensity > 0.36 ? 0.65 + intensity * 0.35 : faultFloor;
    }
    const proximityCorruption = Number.isFinite(entityDistance)
      ? clamp(1 - entityDistance / 11, 0, 1) * (entityMode === 'chase' ? 0.44 : 0.22)
      : 0;
    lightMultiplier *= 1 - proximityCorruption * (0.72 + Math.sin(elapsed * 13.7) * 0.18);
    worldLightReliability = lightMultiplier;
    if (elapsed < remoteFlashUntil) {
      const remaining = clamp((remoteFlashUntil - elapsed) / (reducedMotion ? 0.08 : 0.22), 0, 1);
      remoteFlashLight.visible = true;
      remoteFlashLight.intensity = (reducedMotion ? 18 : 92) * remaining;
    } else remoteFlashLight.visible = false;
    const idleFlicker = level.lighting.fixture.flicker || {};
    lightPool.forEach((light, index) => {
      const phase = fixtureStates[light.userData.cell || 0]?.phase || 0;
      const wobble = 0.95 + Math.sin(
        elapsed * (Number(idleFlicker.idleRate) || 4.2) + phase,
      ) * (Number(idleFlicker.idleDepth) || 0.035);
      light.intensity = level.lighting.fixture.intensity * lightMultiplier * wobble * (index === 0 ? 1.08 : 0.92);
    });
    panelMaterial.emissiveIntensity = 3.1 * (flickering ? Math.max(0.08, lightMultiplier) : 1);
    renderer.toneMappingExposure = lerp(
      renderer.toneMappingExposure,
      level.lighting.exposure
        * (flickering ? 0.62 + lightMultiplier * 0.38 : 1)
        * (playerHidden ? 0.72 : 1),
      0.18,
    );
    dom.threat.style.opacity = String(clamp((tension - 0.38) * 0.8, 0, 0.48));
    dom.grain.style.opacity = reducedMotion ? '0.035' : String(0.068 + fear * 0.075);
    if (!reducedMotion) {
      const targetFov = 70
        + fear * 1.8
        + (localPursuit ? 3.4 : 0)
        + Math.sin(elapsed * 2.1) * fear * 0.42;
      const nextFov = lerp(camera.fov, targetFov, 1 - Math.exp(-4 * dt));
      if (Math.abs(nextFov - camera.fov) > 0.005) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
    }
    audio.update(tension, elapsed, Number.isFinite(entityDistance) ? {
      distance: entityDistance,
      pan: clamp(rightDirection.dot(entityVector), -1, 1),
      mode: entityMode,
    } : null);

    if (playerHidden) dom.status.textContent = 'UNSEEN / DO NOT MOVE';
    else if (localPursuit) dom.status.textContent = 'PURSUIT DETECTED';
    else if (entityMode === 'chase') dom.status.textContent = 'A TEAMMATE IS RUNNING';
    else if (entityMode === 'search') dom.status.textContent = 'MOVEMENT NEARBY';
    else if (huntRecoveryUntil > elapsed) dom.status.textContent = 'THE HUM HAS RETURNED';
    else if (fear > 0.62) dom.status.textContent = 'SIGNAL UNSTABLE';
    else dom.status.textContent = level.copy.status;
    dom.game.dataset.monsterMode = entityMode;
    dom.game.dataset.monsterDistance = Number.isFinite(entityDistance) ? entityDistance.toFixed(2) : 'hidden';
    dom.game.dataset.monsterAwareness = entityAwareness.toFixed(2);
    dom.game.dataset.fear = fear.toFixed(3);
    dom.game.dataset.recovery = Math.max(0, huntRecoveryUntil - elapsed).toFixed(2);
    if (elapsed > 7 && objectiveTotal === 0) dom.objective.style.opacity = '0';
  }

  function updateExit() {
    camera.getWorldDirection(worldDirection);
    worldDirection.y = 0;
    worldDirection.normalize();
    const playerCell = maze.worldToCell(playerPosition.x, playerPosition.y);
    currentInteraction = null;

    for (const item of evidenceItems) {
      if (item.userData.collected || item.userData.cellIndex !== playerCell) continue;
      const delta = entityTarget.copy(item.position).sub(camera.position);
      delta.y = 0;
      const distance = delta.length();
      if (distance > 1.85) continue;
      delta.normalize();
      if (worldDirection.dot(delta) > 0.38) {
        currentInteraction = { type: 'evidence', item };
        break;
      }
    }

    for (const item of objectiveItems) {
      if (currentInteraction) break;
      if (item.userData.activated || item.userData.cellIndex !== playerCell) continue;
      const delta = entityTarget.copy(item.position).sub(camera.position);
      delta.y = 0;
      const distance = delta.length();
      if (distance > 2.25) continue;
      delta.normalize();
      if (worldDirection.dot(delta) > 0.48) {
        currentInteraction = { type: 'objective', item };
        break;
      }
    }

    if (!currentInteraction) {
      const delta = entityTarget.copy(exitGroup.position).sub(camera.position);
      delta.y = 0;
      const distance = delta.length();
      delta.normalize();
      const facing = worldDirection.dot(delta) > 0.56;
      nearExit = playerCell === exitIndex && distance < 2.15 && facing;
      if (nearExit) currentInteraction = {
        type: 'exit',
        locked: objectivesCompleted < objectiveTotal,
      };
    } else nearExit = false;

    const interactionVisible = Boolean(currentInteraction);
    if (heldInteraction) {
      const percent = Math.round(heldInteraction.progress * 100);
      dom.interact.textContent = `HOLD E  ${percent}%`;
      dom.touchAction.textContent = `HOLD ${percent}%`;
    } else if (currentInteraction?.type === 'evidence') {
      dom.interact.textContent = 'E  PLAY ARCHIVE';
      dom.touchAction.textContent = 'PLAY';
    } else if (currentInteraction?.type === 'objective') {
      dom.interact.textContent = level.objective.labels.interact;
      dom.touchAction.textContent = 'USE';
    } else if (currentInteraction?.locked) {
      dom.interact.textContent = 'E  CHECK LOCK';
      dom.touchAction.textContent = 'CHECK';
    } else {
      dom.interact.textContent = 'E  OPEN';
      dom.touchAction.textContent = 'OPEN';
    }
    dom.interact.classList.toggle('is-visible', interactionVisible);
    dom.touchAction.classList.toggle('is-visible', interactionVisible);
  }

  function completeObjectiveInteraction(item) {
    if (!item || item.userData.activated) return;
    noiseImpulse = Math.max(noiseImpulse, 1.55);
    const objectiveId = objectiveIdFor(item);
    if (multiplayerActive && !multiplayer.isHost) {
      currentInteraction = null;
      showMessage('SENDING SIGNAL', 0.55);
      multiplayer.sendObjectiveIntent({
        objectiveId,
        action: 'activate',
        state: {
          cellIndex: item.userData.cellIndex,
          position: { x: playerPosition.x, z: playerPosition.y },
          noise: noiseImpulse,
        },
      }).catch(() => showMessage('SIGNAL LOST', 0.7));
      return;
    }
    const activated = activateObjectiveById(objectiveId);
    if (activated && multiplayerActive) {
      multiplayer.sendObjectiveEvent({
        objectiveId,
        action: 'activate',
        state: { cellIndex: item.userData.cellIndex },
      }).catch(() => {
        showMessage('ROOM SYNC FAILED', 0.7);
        recoverRoomSnapshot();
      });
    }
    currentInteraction = null;
  }

  function cancelHeldInteraction() {
    const canceled = heldInteraction;
    heldInteraction = null;
    interactionHeld = false;
    dom.interact.classList.remove('is-holding');
    dom.interact.style.removeProperty('--hold-progress');
    dom.game.dataset.interactionProgress = '0';
    if (canceled && multiplayerActive && !multiplayer.isHost) {
      multiplayer.sendObjectiveIntent({
        objectiveId: objectiveIdFor(canceled.item),
        action: 'cancel-activate',
        state: { cellIndex: canceled.item.userData.cellIndex },
      }).catch(() => {});
    }
  }

  function beginInteraction() {
    if (!currentInteraction || gameState !== 'playing') return;
    if (currentInteraction.type !== 'objective') {
      interact();
      return;
    }
    if (heldInteraction || currentInteraction.item.userData.activated) return;
    interactionHeld = true;
    heldInteraction = {
      item: currentInteraction.item,
      progress: 0,
      duration: currentInteraction.item.userData.type === 'valve' ? 1.8 : 1.2,
      startX: playerPosition.x,
      startZ: playerPosition.y,
    };
    if (multiplayerActive && !multiplayer.isHost) {
      multiplayer.sendObjectiveIntent({
        objectiveId: objectiveIdFor(currentInteraction.item),
        action: 'begin-activate',
        state: {
          cellIndex: currentInteraction.item.userData.cellIndex,
          position: { x: playerPosition.x, z: playerPosition.y },
        },
      }).catch(() => showMessage('INTERACTION SIGNAL LOST', 0.7));
    }
    dom.interact.classList.add('is-holding');
  }

  function endInteraction() {
    interactionHeld = false;
    if (heldInteraction) cancelHeldInteraction();
  }

  function updateHeldInteraction(dt) {
    if (!heldInteraction) return;
    const moved = Math.hypot(
      playerPosition.x - heldInteraction.startX,
      playerPosition.y - heldInteraction.startZ,
    ) > 0.34;
    if (
      !interactionHeld
      || moved
      || currentInteraction?.type !== 'objective'
      || currentInteraction.item !== heldInteraction.item
      || heldInteraction.item.userData.activated
    ) {
      cancelHeldInteraction();
      return;
    }
    heldInteraction.progress = clamp(heldInteraction.progress + dt / heldInteraction.duration, 0, 1);
    noiseImpulse = Math.max(noiseImpulse, 0.34 + heldInteraction.progress * 1.16);
    dom.interact.style.setProperty('--hold-progress', String(heldInteraction.progress));
    dom.game.dataset.interactionProgress = heldInteraction.progress.toFixed(2);
    if (heldInteraction.progress >= 1) {
      const item = heldInteraction.item;
      heldInteraction = null;
      interactionHeld = false;
      dom.interact.classList.remove('is-holding');
      dom.interact.style.removeProperty('--hold-progress');
      dom.game.dataset.interactionProgress = '0';
      completeObjectiveInteraction(item);
    }
  }

  function interact() {
    if (!currentInteraction || gameState !== 'playing') return;
    if (currentInteraction.type === 'objective') {
      beginInteraction();
      return;
    }
    if (currentInteraction.type === 'evidence') {
      const item = currentInteraction.item;
      const evidenceId = evidenceIdFor(item);
      if (multiplayerActive && !multiplayer.isHost) {
        multiplayer.sendObjectiveIntent({
          objectiveId: evidenceId,
          action: 'collect',
          state: {
            cellIndex: item.userData.cellIndex,
            position: { x: playerPosition.x, z: playerPosition.y },
          },
        }).catch(() => showMessage('ARCHIVE SIGNAL LOST', 0.65));
        showMessage('RECOVERING ARCHIVE', 0.55);
        return;
      }
      const collected = collectEvidenceById(evidenceId, { announce: true, grantCharge: true });
      if (collected && multiplayerActive) {
        multiplayer.sendObjectiveEvent({
          objectiveId: evidenceId,
          action: 'collect',
          state: { cellIndex: item.userData.cellIndex, collectedBy: multiplayer.self?.id },
        }).catch(() => recoverRoomSnapshot());
      }
      currentInteraction = null;
      return;
    }
    if (currentInteraction.locked) {
      showMessage(level.objective.labels.locked, 1.2);
      audio.scare(0);
      noiseImpulse = Math.max(noiseImpulse, 0.72);
      return;
    }
    if (multiplayerActive && !multiplayer.isHost) {
      multiplayer.sendObjectiveIntent({
        objectiveId: 'exit',
        action: 'extract',
        state: {
          cellIndex: exitIndex,
          position: { x: playerPosition.x, z: playerPosition.y },
        },
      }).catch(() => showMessage('SIGNAL LOST', 0.7));
      showMessage('WAITING FOR EXTRACTION', 0.8);
      return;
    }
    win();
  }

  function die() {
    if (ending) return;
    ending = true;
    localAlive = false;
    gameState = 'dead';
    persistFlashlightCharge();
    dom.game.dataset.gameState = gameState;
    if (multiplayerActive) sendLocalPlayerState(true);
    audio.impact();
    showMessage('IT HEARD YOU', 1.2);
    dom.threat.style.opacity = '0.88';
    if (!mobile && controls.isLocked) controls.unlock();
    setTimeout(() => {
      dom.message.classList.remove('is-visible');
      dom.threat.style.opacity = '0';
      showOverlay('dead');
      dom.touchUi.classList.remove('is-visible');
    }, 950);
  }

  function win({ broadcast = true } = {}) {
    if (ending) return;
    if (broadcast && multiplayerActive) {
      if (!multiplayer.isHost || levelCompletionPending) return;
      levelCompletionPending = true;
      multiplayer.sendGameEvent({
        action: 'level-complete',
        state: { level: levelIndex, completedAt: Date.now() },
      }).catch(() => {
        levelCompletionPending = false;
        showMessage('ROOM SYNC FAILED', 0.7);
        recoverRoomSnapshot();
      });
      return;
    }
    levelCompletionPending = false;
    ending = true;
    gameState = 'won';
    persistFlashlightCharge();
    dom.game.dataset.gameState = gameState;
    if (multiplayerActive) sendLocalPlayerState(true);
    audio.powerDip(elapsed, 2);
    showMessage(levelIndex === LEVELS.length - 1 ? 'THE RECORDING ENDS' : 'THRESHOLD OPEN', 1.3);
    if (!mobile && controls.isLocked) controls.unlock();
    setTimeout(() => {
      dom.message.classList.remove('is-visible');
      showOverlay('won');
      dom.touchUi.classList.remove('is-visible');
    }, 1100);
  }

  function beginPlay() {
    ending = false;
    localAlive = true;
    gameState = 'playing';
    waitingRoomPreview.dispose();
    hideOverlay();
    audio.resume();
    lastFrame = performance.now();
    clock.getDelta();
    dom.game.dataset.gameState = gameState;
    sendLocalPlayerState(true);
  }

  function sendLocalPlayerState(force = false) {
    if (!multiplayerActive || !multiplayer.isConnected || roomNavigationPending) return false;
    const now = performance.now();
    if (!force && now - lastPlayerNetworkUpdate < 66) return false;
    lastPlayerNetworkUpdate = now;
    return multiplayer.sendPlayerState({
      name: localCallsign,
      characterId: localCharacterId || undefined,
      look: localLook,
      ready: localReady,
      position: { x: playerPosition.x, y: 0, z: playerPosition.y },
      yaw: Math.atan2(
        Math.sin(camera.rotation.y + Math.PI),
        Math.cos(camera.rotation.y + Math.PI),
      ),
      pitch: camera.rotation.x,
      speed: gameState === 'playing' ? playerActualSpeed : 0,
      velocity: { x: velocity.x, z: velocity.y },
      running: gameState === 'playing' && playerRunning,
      crouching: playerCrouching,
      noise: gameState === 'playing' ? playerNoise : 0,
      hidden: gameState === 'playing' && playerHidden,
      exposure: playerExposure,
      alive: localAlive,
      playing: gameState === 'playing',
      authorityAvailable: gameState === 'playing' && !document.hidden,
      flashlight: localAlive && flashlightOn,
      visible: true,
      cellIndex: maze.worldToCell(playerPosition.x, playerPosition.y),
    });
  }

  function reduceQuality() {
    if (adaptiveQualityReduced) return;
    adaptiveQualityReduced = true;
    activeLightCount = Math.min(lightPool.length, mobile ? 2 : 4);
    fixedStep = 1 / 75;
    renderer.shadowMap.enabled = false;
    lightPool.forEach((light) => { light.castShadow = false; });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
    dom.grain.style.opacity = '0.04';
    dom.game.dataset.quality = 'reduced';
    updateLights();
  }

  multiplayer.on('status', ({ status }) => {
    if (status === 'reconnecting' || status === 'resuming') {
      if (multiplayerActive || multiplayer.roomCode) {
        voiceChat.disable({ announce: false });
        setLobbyStatus('SIGNAL LOST / RECONNECTING');
        dom.status.textContent = 'CO-OP LINK UNSTABLE';
      } else if (lobbyMode === 'rooms') {
        setLobbyStatus('DIRECTORY SIGNAL LOST / RECONNECTING');
        setDirectoryState('loading', 'RECONNECTING TO ROOM DIRECTORY');
      }
    } else if (status === 'replaced') {
      voiceChat.disable({ announce: false });
      multiplayerActive = false;
      setLobbyStatus('ROOM OPEN IN ANOTHER TAB', 'error');
      updateRoomHud();
    } else if (status === 'joined' && multiplayer.roomCode) {
      setLobbyStatus(`ROOM ${multiplayer.roomCode} / LINKED`, 'connected');
    }
  });

  multiplayer.on('room:joined', ({ room }) => {
    hydrateWaitingRoomState(room);
    applyRoomSnapshot(room);
  });
  multiplayer.on('room:snapshot', ({ room }) => {
    hydrateWaitingRoomState(room);
    applyRoomSnapshot(room);
  });
  multiplayer.on('resumed', ({ room }) => {
    hydrateWaitingRoomState(room);
    multiplayerActive = true;
    applyRoomSnapshot(room);
    sendLocalPlayerState(true);
    showMessage('SIGNAL RESTORED', 0.7);
  });
  multiplayer.on('reconnect:failed', ({ code }) => {
    if (code) sessionStorage.removeItem(roomResumeKey(code));
    multiplayerActive = false;
    voiceChat.disable({ announce: false });
    remoteNetworkPlayers.clear();
    remotePlayers.clear();
    networkMonsterState = null;
    networkMonsterInitialized = false;
    networkMonsterWasVisible = false;
    setLobbyBusy(false);
    updateRoomHud();
    setLobbyStatus('ROOM RESUME FAILED', 'error');
  });
  multiplayer.on('player:joined', ({ player, resumed }) => {
    if (resumed && player?.id) {
      killedRemotePlayers.delete(String(player.id));
      pendingRemoteKills.delete(String(player.id));
    }
    if (player?.state) upsertRemotePlayer(player);
    updateRoomHud();
    if (multiplayerActive && player?.name) showMessage(`${normalizeCallsign(player.name)} LINKED`, 0.62);
  });
  multiplayer.on('player:state', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    upsertRemotePlayer(payload);
    if (gameState === 'start') updateWaitingRoom();
  });
  multiplayer.on('player:left', ({ playerId, voluntary }) => {
    removeRemotePlayer(playerId);
    for (const key of remoteInteractionStarts.keys()) {
      if (key.startsWith(`${playerId}:`)) remoteInteractionStarts.delete(key);
    }
    remoteFlashCooldowns.delete(String(playerId));
    updateRoomHud();
    if (multiplayerActive) showMessage(voluntary ? 'A SIGNAL LEFT' : 'A SIGNAL WAS LOST', 0.62);
  });
  multiplayer.on('player:removed', ({ playerId }) => {
    removeRemotePlayer(playerId);
    for (const key of remoteInteractionStarts.keys()) {
      if (key.startsWith(`${playerId}:`)) remoteInteractionStarts.delete(key);
    }
    remoteFlashCooldowns.delete(String(playerId));
    updateRoomHud();
  });
  multiplayer.on('host:changed', ({ hostId }) => {
    updateRoomHud();
    if (multiplayerActive && hostId === multiplayer.self?.id) {
      showMessage('YOU ARE THE HOST', 0.8);
      hydrateMonsterAuthority();
    } else if (multiplayerActive) showMessage('HOST SIGNAL MOVED', 0.65);
  });

  multiplayer.on('objective:intent', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    if (!multiplayerActive || !multiplayer.isHost) return;
    const sender = remoteNetworkPlayers.get(String(payload.playerId));
    if (!sender?.alive || !sender.playing) return;
    const senderCell = maze.worldToCell(sender.position.x, sender.position.z);
    const interactionKey = `${payload.playerId}:${payload.objectiveId}`;
    if (payload.action === 'cancel-activate') {
      remoteInteractionStarts.delete(interactionKey);
      return;
    }
    if (payload.action === 'begin-activate') {
      const item = objectiveFromId(payload.objectiveId);
      if (!item || item.userData.activated || senderCell !== item.userData.cellIndex) return;
      const distance = Math.hypot(sender.position.x - item.position.x, sender.position.z - item.position.z);
      if (distance > 2.8) return;
      remoteInteractionStarts.set(interactionKey, performance.now());
      return;
    }
    if (payload.action === 'flash' && payload.objectiveId === 'entity') {
      const position = payload.state?.position || {};
      const direction = payload.state?.direction || {};
      const flashAllowedAt = remoteFlashCooldowns.get(String(payload.playerId)) || 0;
      if (
        !Number.isFinite(Number(position.x))
        || !Number.isFinite(Number(position.z))
        || !Number.isFinite(Number(direction.x))
        || !Number.isFinite(Number(direction.z))
        || Math.hypot(Number(position.x) - sender.position.x, Number(position.z) - sender.position.z) > 1.6
        || performance.now() < flashAllowedAt
      ) return;
      remoteFlashCooldowns.set(String(payload.playerId), performance.now() + 1_800);
      sender.noise = Math.max(sender.noise, 1.75);
      sender.noiseHoldUntil = performance.now() + 900;
      applyCameraFlashAt(
        sender.position.x,
        sender.position.z,
        Number(direction.x),
        Number(direction.z),
        false,
      );
      multiplayer.sendGameEvent({
        action: 'camera-flash',
        state: {
          playerId: payload.playerId,
          position: { x: sender.position.x, z: sender.position.z },
        },
      }).catch(() => {});
      return;
    }
    if (payload.action === 'collect') {
      const item = evidenceFromId(payload.objectiveId);
      if (!item || item.userData.collected || senderCell !== item.userData.cellIndex) return;
      const distance = Math.hypot(sender.position.x - item.position.x, sender.position.z - item.position.z);
      if (distance > 2.5) return;
      sender.noise = Math.max(sender.noise, 1.35);
      sender.noiseHoldUntil = performance.now() + 750;
      if (!collectEvidenceById(payload.objectiveId, {
        announce: true,
        grantCharge: false,
        collectorName: sender.name,
      })) return;
      multiplayer.sendObjectiveEvent({
        objectiveId: payload.objectiveId,
        action: 'collect',
        state: { cellIndex: item.userData.cellIndex, collectedBy: payload.playerId },
      }).catch(() => recoverRoomSnapshot());
      return;
    }
    if (payload.action === 'extract' && payload.objectiveId === 'exit') {
      const distance = Math.hypot(
        sender.position.x - exitGroup.position.x,
        sender.position.z - exitGroup.position.z,
      );
      if (objectivesCompleted >= objectiveTotal && senderCell === exitIndex && distance < 2.8) win();
      return;
    }
    if (payload.action !== 'activate') return;
    const item = objectiveFromId(payload.objectiveId);
    if (!item || item.userData.activated || senderCell !== item.userData.cellIndex) return;
    const distance = Math.hypot(sender.position.x - item.position.x, sender.position.z - item.position.z);
    if (distance > 2.8) return;
    const interactionStartedAt = remoteInteractionStarts.get(interactionKey);
    remoteInteractionStarts.delete(interactionKey);
    const requiredHoldMs = (item.userData.type === 'valve' ? 1.8 : 1.2) * 1000;
    if (!Number.isFinite(interactionStartedAt) || performance.now() - interactionStartedAt < requiredHoldMs * 0.85) {
      return;
    }
    sender.noise = Math.max(sender.noise, 1.45);
    sender.noiseHoldUntil = performance.now() + 850;
    if (!activateObjectiveById(payload.objectiveId)) return;
    multiplayer.sendObjectiveEvent({
      objectiveId: payload.objectiveId,
      action: 'activate',
      state: { cellIndex: item.userData.cellIndex, activatedBy: payload.playerId },
    }).catch(() => {
      showMessage('ROOM SYNC FAILED', 0.7);
      recoverRoomSnapshot();
    });
  });

  multiplayer.on('objective:event', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    if (payload.action === 'activate') activateObjectiveById(payload.objectiveId);
    if (payload.action === 'collect') {
      const collectedByLocal = payload.state?.collectedBy === multiplayer.self?.id;
      collectEvidenceById(payload.objectiveId, {
        announce: true,
        grantCharge: collectedByLocal,
        collectorName: collectedByLocal ? localCallsign : 'A TEAMMATE',
      });
    }
  });
  multiplayer.on('monster:event', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    if (!multiplayer.isHost) applyNetworkMonster(payload);
  });
  multiplayer.on('game:event', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    if (payload.action === 'session-start') {
      sessionStarted = true;
      sessionStartPending = false;
      localReady = true;
      updateWaitingRoom();
      showMessage('THE RUN IS OPEN', 0.8);
    }
    if (payload.action === 'level-complete') win({ broadcast: false });
    if (payload.action === 'player-killed' && payload.state?.playerId === multiplayer.self?.id) die();
    if (
      payload.action === 'camera-flash'
      && payload.state?.playerId !== multiplayer.self?.id
    ) presentRemoteFlash(payload.state);
  });
  multiplayer.on('world:synced', (world) => {
    killedRemotePlayers.clear();
    pendingRemoteKills.clear();
    const nextSeed = Number(world.seed) >>> 0;
    const nextLevel = Number(world.level);
    if (world.reset || nextSeed !== campaignSeed || nextLevel !== levelIndex) navigateToRoomWorld({
      code: multiplayer.roomCode,
      seed: nextSeed,
      level: nextLevel,
    });
  });
  multiplayer.on('voice:signal', (payload) => {
    if (!isCurrentRoomEvent(payload)) return;
    voiceChat.handleSignal(payload);
  });
  multiplayer.on('room:directory:updated', (directory) => {
    if (lobbyMode === 'rooms') renderRoomDirectory(directory);
  });
  multiplayer.on('protocol:error', (error) => {
    if (String(error?.code || '').startsWith('VOICE_') || error?.code === 'INVALID_VOICE_SIGNAL') return;
    if (multiplayerActive) showMessage('ROOM SIGNAL ERROR', 0.65);
    else {
      if (lobbyMode === 'rooms') {
        dom.roomList.replaceChildren();
        dom.roomDirectoryCount.textContent = '!!';
        setDirectoryState('error', 'ROOM DIRECTORY UNAVAILABLE / REFRESH TO RETRY');
      }
      setLobbyStatus(error?.message?.toUpperCase?.() || 'ROOM SIGNAL ERROR', 'error');
    }
  });

  function enterCurrentLevel() {
    if (mobile) {
      const fullscreenRequest = document.documentElement.requestFullscreen?.();
      fullscreenRequest?.catch(() => {});
      beginPlay();
    } else {
      controls.lock();
    }
    audio.start().catch(() => {});
  }

  function startRoomSession() {
    const waiting = currentWaitingRoomModel();
    if (!waiting.isHost || !waiting.allReady || sessionStartPending || sessionStarted) return;
    sessionStartPending = true;
    updateWaitingRoom();
    multiplayer.sendGameEvent({
      action: 'session-start',
      state: {
        phase: 'playing',
        startedAt: Date.now(),
        capacity: roomCapacity(),
      },
    }).then(() => {
      sessionStartPending = false;
      sessionStarted = true;
      localReady = true;
      updateWaitingRoom();
    }).catch((error) => {
      sessionStartPending = false;
      sessionStarted = roomSessionStarted(multiplayer.room);
      updateWaitingRoom();
      showMessage(
        error?.code === 'PLAYERS_NOT_READY' ? 'A SIGNAL IS NOT READY' : 'RUN COULD NOT OPEN',
        0.8,
      );
      recoverRoomSnapshot();
    });
  }

  dom.modeSolo.addEventListener('click', async () => {
    if (multiplayerActive) await leaveMultiplayer();
    setLobbyMode('solo');
  });
  dom.modeHost.addEventListener('click', () => setLobbyMode('host'));
  dom.modeJoin.addEventListener('click', () => setLobbyMode('join'));
  dom.roomVisibility.addEventListener('click', () => setRoomVisibility(!roomIsPublic));
  dom.modeRooms.addEventListener('click', () => {
    setLobbyMode('rooms');
    refreshRoomDirectory({ subscribe: true });
  });
  dom.coopConnect.addEventListener('click', () => {
    if (lobbyMode === 'rooms') refreshRoomDirectory();
    else connectSelectedRoom();
  });
  dom.roomList.addEventListener('click', (event) => {
    const button = event.target.closest('.room-signal');
    if (!button || button.disabled) return;
    dom.roomCode.value = normalizeRoomCode(button.dataset.code);
    setLobbyMode('join');
    connectSelectedRoom();
  });
  dom.playerName.addEventListener('input', () => {
    dom.playerName.value = normalizeCallsign(dom.playerName.value);
  });
  dom.roomCode.addEventListener('input', () => {
    dom.roomCode.value = normalizeRoomCode(dom.roomCode.value);
  });
  dom.roomCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connectSelectedRoom();
  });
  dom.lookPicker.addEventListener('click', (event) => {
    const button = event.target.closest('[data-look]');
    if (!button || button.disabled || sessionStarted) return;
    const nextLook = survivorLook(button.dataset.look).id;
    if (nextLook === localLook) return;
    localLook = nextLook;
    localStorage.setItem('threshold-survivor-look', localLook);
    if (localReady) localReady = false;
    updateWaitingRoom();
    sendLocalPlayerState(true);
  });
  dom.copyInvite.addEventListener('click', async () => {
    const inviteUrl = roomInviteUrl();
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: 'Join my THRESHOLD room',
          text: `Join room ${multiplayer.roomCode}. Up to ${roomCapacity()} survivors.`,
          url: inviteUrl,
        });
        setLobbyStatus(`ROOM ${multiplayer.roomCode} / INVITE SHARED`, 'connected');
      } else {
        await navigator.clipboard.writeText(inviteUrl);
        setLobbyStatus(`ROOM ${multiplayer.roomCode} / INVITE COPIED`, 'connected');
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setLobbyStatus('COPY BLOCKED BY BROWSER', 'error');
    }
  });

  controls.addEventListener('lock', beginPlay);
  controls.addEventListener('unlock', () => {
    keys.clear();
    velocity.multiplyScalar(0.25);
    if (ending || gameState === 'dead' || gameState === 'won') return;
    if (gameState === 'playing') {
      gameState = 'paused';
      dom.game.dataset.gameState = gameState;
      audio.suspend();
      showOverlay('pause');
      sendLocalPlayerState(true);
    }
  });

  dom.enterButton.addEventListener('click', () => {
    if (gameState === 'dead') {
      window.location.reload();
      return;
    }
    if (gameState === 'won') {
      const nextLevel = levelIndex === LEVELS.length - 1 ? 0 : levelIndex + 1;
      if (multiplayerActive) {
        if (!multiplayer.isHost) {
          dom.enterLabel.textContent = 'WAITING FOR HOST';
          showMessage('HOST CONTROLS THE THRESHOLD', 0.8);
          return;
        }
        const nextCampaignSeed = nextLevel === 0
          ? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
          : campaignSeed;
        sessionStorage.setItem('threshold-campaign-seed', String(nextCampaignSeed));
        dom.enterButton.disabled = true;
        dom.enterLabel.textContent = 'OPENING THRESHOLD';
        multiplayer.syncWorld({ seed: nextCampaignSeed, level: nextLevel, reset: true }).catch(() => {
          dom.enterButton.disabled = false;
          dom.enterLabel.textContent = level.copy.win.button;
          showMessage('ROOM SYNC FAILED', 0.8);
        });
        return;
      }
      if (nextLevel === 0) sessionStorage.removeItem('threshold-campaign-seed');
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('level', String(nextLevel));
      nextUrl.searchParams.delete('autowalk');
      window.location.href = nextUrl.toString();
      return;
    }
    if (multiplayerActive && gameState === 'start') {
      if (!sessionStarted) {
        if (waitingAction === 'start') {
          startRoomSession();
          return;
        }
        localReady = waitingAction === 'ready';
        updateWaitingRoom();
        sendLocalPlayerState(true);
        return;
      }
    }
    enterCurrentLevel();
  });

  document.addEventListener('pointerlockerror', () => {
    if (mobile || ending) return;
    gameState = 'paused';
    dom.game.dataset.gameState = gameState;
    audio.suspend();
    showOverlay('pause');
    dom.overlayBody.textContent = 'Pointer lock was blocked. Select the button to try again.';
  });

  dom.soundToggle.addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    localStorage.setItem('threshold-muted', audio.muted ? '1' : '0');
    dom.soundToggle.textContent = audio.muted ? 'SOUND OFF' : 'SOUND ON';
    dom.soundToggle.setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  });

  dom.voiceToggle.addEventListener('click', async () => {
    if (voiceChat.state === 'requesting') {
      voiceChat.disable();
      showMessage('MICROPHONE REQUEST CANCELED', 0.7);
      return;
    }
    if (voiceChat.enabled) {
      voiceChat.disable();
      showMessage('VOICE OFF / MICROPHONE RELEASED', 0.75);
      return;
    }
    if (!multiplayerActive || !multiplayer.roomCode) {
      showMessage('JOIN A ROOM TO USE VOICE', 0.75);
      return;
    }
    if (!voiceAvailable()) {
      showMessage(voiceChat.supported ? 'VOICE SERVER UNAVAILABLE' : 'VOICE NOT SUPPORTED', 0.85);
      updateVoiceUi();
      return;
    }
    bindVoiceSession();
    try {
      await voiceChat.enable();
      if (voiceChat.enabled) showMessage('VOICE LINKED / MICROPHONE LIVE', 0.8);
    } catch (error) {
      const message = error?.name === 'NotAllowedError'
        ? 'MICROPHONE PERMISSION BLOCKED'
        : error?.name === 'NotFoundError'
          ? 'NO MICROPHONE FOUND'
          : error?.name === 'SecurityError'
            ? 'HTTPS REQUIRED FOR VOICE'
            : 'VOICE START FAILED';
      showMessage(message, 1);
    }
  });

  dom.micToggle.addEventListener('click', () => {
    if (!voiceChat.enabled) return;
    const muted = voiceChat.setMuted(!voiceChat.muted);
    showMessage(muted ? 'MICROPHONE MUTED' : 'MICROPHONE LIVE', 0.55);
  });

  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'KeyE') beginInteraction();
    if (event.code === 'KeyF' && gameState === 'playing') setFlashlight(!flashlightOn);
    if (event.code === 'KeyQ') triggerCameraFlash();
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
    if (event.code === 'KeyE') endInteraction();
  });
  window.addEventListener('blur', () => {
    keys.clear();
    cancelHeldInteraction();
    touchInput.set(0, 0);
    touchSprint = false;
    playerActualSpeed = 0;
    playerRunning = false;
    playerNoise = 0;
    sendLocalPlayerState(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (voiceChat.enabled) voiceChat.setPaused(document.hidden);
    if (document.hidden) {
      keys.clear();
      touchInput.set(0, 0);
      touchSprint = false;
      playerActualSpeed = 0;
      playerRunning = false;
      playerNoise = 0;
      audio.suspend();
      sendLocalPlayerState(true);
    } else if (gameState === 'playing') {
      audio.resume();
      lastFrame = performance.now();
      sendLocalPlayerState(true);
    }
  });
  window.addEventListener('pagehide', () => {
    persistFlashlightCharge();
    waitingRoomPreview.dispose();
    voiceChat.destroy();
  }, { once: true });

  if (mobile) {
    dom.controlsCopy.innerHTML = '<span><b>LEFT</b> MOVE</span><span><b>RIGHT</b> LOOK</span><span><b>RUN</b> HOLD</span>';
    let movePointer = null;
    const updateMove = (event) => {
      const rect = dom.movePad.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = event.clientX - centerX;
      let dy = event.clientY - centerY;
      const distance = Math.hypot(dx, dy);
      const maxDistance = rect.width * 0.33;
      if (distance > maxDistance) {
        dx = (dx / distance) * maxDistance;
        dy = (dy / distance) * maxDistance;
      }
      touchInput.set(dx / maxDistance, -dy / maxDistance);
      dom.moveStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };
    const releaseMove = (event) => {
      if (event.pointerId !== movePointer) return;
      movePointer = null;
      touchInput.set(0, 0);
      dom.moveStick.style.transform = 'translate(-50%, -50%)';
    };
    dom.movePad.addEventListener('pointerdown', (event) => {
      movePointer = event.pointerId;
      dom.movePad.setPointerCapture(event.pointerId);
      updateMove(event);
    });
    dom.movePad.addEventListener('pointermove', (event) => {
      if (event.pointerId === movePointer) updateMove(event);
    });
    dom.movePad.addEventListener('pointerup', releaseMove);
    dom.movePad.addEventListener('pointercancel', releaseMove);

    let lookPointer = null;
    let lastLookX = 0;
    let lastLookY = 0;
    const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    dom.touchLook.addEventListener('pointerdown', (event) => {
      lookPointer = event.pointerId;
      lastLookX = event.clientX;
      lastLookY = event.clientY;
      dom.touchLook.setPointerCapture(event.pointerId);
    });
    dom.touchLook.addEventListener('pointermove', (event) => {
      if (event.pointerId !== lookPointer || gameState !== 'playing') return;
      lookEuler.setFromQuaternion(camera.quaternion);
      lookEuler.y -= (event.clientX - lastLookX) * 0.0042;
      lookEuler.x -= (event.clientY - lastLookY) * 0.0042;
      lookEuler.x = clamp(lookEuler.x, -Math.PI / 2 + 0.08, Math.PI / 2 - 0.08);
      camera.quaternion.setFromEuler(lookEuler);
      lastLookX = event.clientX;
      lastLookY = event.clientY;
    });
    const releaseLook = (event) => {
      if (event.pointerId === lookPointer) lookPointer = null;
    };
    dom.touchLook.addEventListener('pointerup', releaseLook);
    dom.touchLook.addEventListener('pointercancel', releaseLook);

    dom.touchSprint.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      touchSprint = true;
      dom.touchSprint.setPointerCapture(event.pointerId);
    });
    const releaseSprint = () => { touchSprint = false; };
    dom.touchSprint.addEventListener('pointerup', releaseSprint);
    dom.touchSprint.addEventListener('pointercancel', releaseSprint);
    dom.touchCrouch.addEventListener('click', () => {
      touchCrouch = !touchCrouch;
      dom.touchCrouch.textContent = touchCrouch ? 'CROUCHED' : 'CROUCH';
      dom.touchCrouch.setAttribute('aria-pressed', String(touchCrouch));
    });
    dom.touchLight.addEventListener('click', () => setFlashlight(!flashlightOn));
    dom.touchFlash.addEventListener('click', triggerCameraFlash);
    dom.touchAction.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dom.touchAction.setPointerCapture(event.pointerId);
      beginInteraction();
    });
    dom.touchAction.addEventListener('pointerup', endInteraction);
    dom.touchAction.addEventListener('pointercancel', endInteraction);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, adaptiveQualityReduced ? 1 : mobile ? 1.2 : 1.5));
  });

  setRoomVisibility(roomIsPublic);
  setLobbyMode(lobbyMode);
  if (requestedRoomCode) {
    dom.enterButton.disabled = true;
    await connectSelectedRoom();
    if (roomNavigationPending) return;
  }

  playerFlashlight.visible = flashlightOn;
  flashlightBounce.visible = flashlightOn;
  updateEquipmentHud();
  await renderer.compileAsync(scene, camera).catch(() => {});
  updateLights();
  dom.enterButton.focus({ preventScroll: true });
  if (qaMode) {
    beginPlay();
    if (qaAutowalk) keys.add('KeyW');
    if (qaMonsterMode && placeEntity(qaMonsterMode === 'glimpse' ? 'glimpse' : 'stalk')) {
      if (qaMonsterMode === 'chase') entityMode = 'chase';
      dom.game.dataset.monsterMode = entityMode;
    }
  }

  function animate(now) {
    requestAnimationFrame(animate);
    const rawDelta = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;

    if (gameState === 'playing') {
      elapsed += rawDelta;
      accumulator += rawDelta;
      frameTimeAverage = lerp(frameTimeAverage, rawDelta, 0.025);
      if (frameTimeAverage > 1 / 34) slowFrameDuration += rawDelta;
      else slowFrameDuration = Math.max(0, slowFrameDuration - rawDelta * 0.5);
      if (slowFrameDuration > 2.5) reduceQuality();
      while (accumulator >= fixedStep) {
        simulatePlayer(fixedStep);
        accumulator -= fixedStep;
      }
      if (!levelCompletionPending) updateDirector(rawDelta);
      updateExit();
      updateHeldInteraction(rawDelta);
      updateObjectiveAnimations(rawDelta);

      lightUpdateAt -= rawDelta;
      if (lightUpdateAt <= 0) {
        updateLights();
        lightUpdateAt = 0.34;
      }

      if (messageUntil && elapsed > messageUntil) {
        dom.message.classList.remove('is-visible');
        dom.message.textContent = '';
        messageUntil = 0;
      }
      updateGrain();
      dom.game.dataset.playerCell = String(
        maze.worldToCell(playerPosition.x, playerPosition.y),
      );
      sendLocalPlayerState();
    }

    if (multiplayerActive && now - lastRoomRosterUpdate > 2000) {
      lastRoomRosterUpdate = now;
      const stalePlayers = remotePlayers.pruneStale(12);
      stalePlayers.forEach((id) => remoteNetworkPlayers.delete(String(id)));
      updateRoomHud();
    }
    updateVoiceSpatial();
    remotePlayers.update(rawDelta, camera);
    renderer.render(scene, camera);
    waitingRoomPreview.update(rawDelta);
  }
  requestAnimationFrame(animate);
}

init().catch((error) => {
  console.error(error);
  dom.unsupported.classList.add('is-visible');
});
