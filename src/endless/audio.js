const DEFAULT_EMITTER_LIMITS = Object.freeze({
  vent: 4,
  rack: 3,
  fluorescent: 4,
});

const EMITTER_PROFILES = Object.freeze({
  vent: Object.freeze({ baseGain: 0.115, near: 1.5, far: 24, curve: 1.25 }),
  rack: Object.freeze({ baseGain: 0.09, near: 1.25, far: 20, curve: 1.45 }),
  fluorescent: Object.freeze({ baseGain: 0.042, near: 0.8, far: 11, curve: 1.8 }),
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function positionOf(value) {
  const source = value?.position && typeof value.position === 'object' ? value.position : value;
  return {
    x: finiteNumber(source?.x),
    y: finiteNumber(source?.y),
    z: finiteNumber(source?.z),
  };
}

function canonicalEmitterType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type.includes('vent') || type.includes('duct') || type.includes('airflow')) return 'vent';
  if (type.includes('server') || type.includes('rack') || type.includes('hdd')) return 'rack';
  if (type.includes('fluorescent') || type.includes('fixture') || type.includes('ballast')) {
    return 'fluorescent';
  }
  return type;
}

function emitterKey(emitter, type, index) {
  const explicit = emitter?.id ?? emitter?.key ?? emitter?.emitterId ?? emitter?.cellIndex;
  if (explicit !== undefined && explicit !== null && String(explicit)) {
    return `${type}:${String(explicit)}`;
  }
  const position = positionOf(emitter);
  const coordinateKey = [position.x, position.y, position.z]
    .map((value) => Math.round(value * 1000) / 1000)
    .join(',');
  return `${type}:${coordinateKey}:${index}`;
}

function capForEmitter(limits, rawType, type) {
  const source = limits && typeof limits === 'object' ? limits : DEFAULT_EMITTER_LIMITS;
  const rawKey = String(rawType || '').trim().toLowerCase();
  const value = Object.hasOwn(source, rawKey)
    ? source[rawKey]
    : Object.hasOwn(source, type)
      ? source[type]
      : source.default;
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.floor(value), 0, 32);
}

function rankEmitters(emitters, listener, limits) {
  const origin = positionOf(listener);
  const sourceLimits = limits === undefined
    ? DEFAULT_EMITTER_LIMITS
    : { ...DEFAULT_EMITTER_LIMITS, ...(limits || {}) };
  const ranked = [];

  for (const [index, emitter] of (Array.isArray(emitters) ? emitters : []).entries()) {
    if (!emitter || typeof emitter !== 'object') continue;
    const rawType = emitter.type ?? emitter.kind ?? emitter.audioType;
    const type = canonicalEmitterType(rawType);
    const cap = capForEmitter(sourceLimits, rawType, type);
    if (!type || cap <= 0) continue;
    const position = positionOf(emitter);
    const dx = position.x - origin.x;
    const dy = position.y - origin.y;
    const dz = position.z - origin.z;
    ranked.push({
      emitter,
      type,
      position,
      cap,
      index,
      key: emitterKey(emitter, type, index),
      distanceSquared: dx * dx + dy * dy + dz * dz,
    });
  }

  ranked.sort((left, right) => (
    left.distanceSquared - right.distanceSquared
    || left.type.localeCompare(right.type)
    || left.key.localeCompare(right.key)
    || left.index - right.index
  ));

  const counts = new Map();
  return ranked.filter((entry) => {
    const count = counts.get(entry.type) || 0;
    if (count >= entry.cap) return false;
    counts.set(entry.type, count + 1);
    return true;
  });
}

/**
 * Selects the closest useful environmental emitters while enforcing a hard cap
 * for each emitter type. The result is ordered nearest-first and is stable for
 * emitters with persistent ids, even if the input array is reordered.
 */
export function prioritizeEmitters(emitters, listener, limits) {
  return rankEmitters(emitters, listener, limits).map((entry) => entry.emitter);
}

/**
 * Pure distance curve used in addition to Web Audio's spatial panning. It
 * reaches silence at `far`, which lets virtualized voices retire cleanly.
 */
export function proximityGain(distance, options = {}) {
  const near = Math.max(0, finiteNumber(options.near, 1.25));
  const far = Math.max(near + 0.001, finiteNumber(options.far, 18));
  const curve = Math.max(0.1, finiteNumber(options.curve, 1.5));
  const safeDistance = Math.max(0, finiteNumber(distance, far));
  if (safeDistance <= near) return 1;
  if (safeDistance >= far) return 0;
  const remaining = 1 - ((safeDistance - near) / (far - near));
  return Math.pow(remaining, curve);
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed) {
  let state = seed >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

function setParam(param, value, time = 0) {
  if (!param) return;
  if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, time);
  else param.value = value;
}

function smoothParam(param, value, time, timeConstant = 0.04) {
  if (!param) return;
  if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(time);
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, time, timeConstant);
  } else {
    param.value = value;
  }
}

function rampParam(param, value, time) {
  if (!param) return;
  if (typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(value, time);
  } else {
    param.value = value;
  }
}

function safeDisconnect(node) {
  try {
    node?.disconnect?.();
  } catch {
    // A partially constructed graph may already be disconnected.
  }
}

function safeStop(source, when) {
  try {
    source?.stop?.(when);
  } catch {
    // Stopping a source twice is harmless during graph teardown.
  }
}

function resolveAudioContextImpl(configured) {
  if (configured !== undefined) return configured;
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function createNoiseBuffer(context, seed) {
  const duration = 2.25;
  const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const data = buffer.getChannelData(0);
  let state = (seed || 1) >>> 0;
  let brown = 0;
  for (let index = 0; index < data.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const white = (state / 2147483648) - 1;
    brown = clamp((brown * 0.985) + (white * 0.055), -1, 1);
    data[index] = (brown * 0.72) + (white * 0.16);
  }
  return buffer;
}

function hddInterval(key, count) {
  return 2.8 + (seededUnit(hashString(`${key}:seek:${count}`)) * 5.4);
}

/**
 * Creates the endless-exploration soundscape. No browser globals or audio
 * nodes are touched until start() is called.
 */
export function createEndlessAudio(options = {}) {
  const AudioContextImplOption = options.AudioContextImpl;
  const emitterLimits = {
    ...DEFAULT_EMITTER_LIMITS,
    ...(options.emitterLimits && typeof options.emitterLimits === 'object'
      ? options.emitterLimits
      : {}),
  };
  const outputVolume = clamp(finiteNumber(options.volume, 0.7), 0, 1);
  const mainsFrequency = clamp(finiteNumber(options.mainsFrequency, 60), 45, 65);
  const soundSeed = (finiteNumber(options.seed, 0x6d2b79f5) >>> 0) || 1;

  let context = null;
  let master = null;
  let buses = null;
  let noiseBuffer = null;
  let muted = Boolean(options.muted);
  let disposed = false;
  const sources = new Set();
  const nodes = new Set();
  const voices = new Map();
  const retiringVoices = new Set();

  function rememberNode(node) {
    if (node) nodes.add(node);
    return node;
  }

  function rememberSource(source, voice = null) {
    if (!source) return source;
    sources.add(source);
    rememberNode(source);
    if (voice) voice.sources.add(source);
    return source;
  }

  function forgetOneShot(source, ownedNodes) {
    sources.delete(source);
    for (const node of ownedNodes) {
      safeDisconnect(node);
      nodes.delete(node);
    }
  }

  function connect(source, destination) {
    source.connect(destination);
    return destination;
  }

  function createBus(gainValue) {
    const gain = rememberNode(context.createGain());
    setParam(gain.gain, gainValue, context.currentTime);
    gain.connect(master);
    return gain;
  }

  function startTracked(source, when = context.currentTime, offset) {
    if (offset === undefined) source.start(when);
    else source.start(when, offset);
  }

  function createOscillatorLayer(destination, frequency, gainValue, type = 'sine') {
    const oscillator = rememberSource(context.createOscillator());
    const gain = rememberNode(context.createGain());
    oscillator.type = type;
    setParam(oscillator.frequency, frequency, context.currentTime);
    setParam(gain.gain, gainValue, context.currentTime);
    connect(oscillator, gain).connect(destination);
    startTracked(oscillator);
  }

  function createNoiseLayer(destination, config) {
    const source = rememberSource(context.createBufferSource());
    const filter = rememberNode(context.createBiquadFilter());
    const gain = rememberNode(context.createGain());
    source.buffer = noiseBuffer;
    source.loop = true;
    filter.type = config.filterType || 'lowpass';
    setParam(filter.frequency, config.frequency, context.currentTime);
    setParam(filter.Q, config.q || 0.4, context.currentTime);
    setParam(gain.gain, config.gain, context.currentTime);
    connect(source, filter).connect(gain);
    gain.connect(destination);

    if (config.modulationDepth > 0) {
      const lfo = rememberSource(context.createOscillator());
      const depth = rememberNode(context.createGain());
      lfo.type = 'sine';
      setParam(lfo.frequency, config.modulationRate, context.currentTime);
      setParam(depth.gain, config.modulationDepth, context.currentTime);
      connect(lfo, depth).connect(gain.gain);
      startTracked(lfo);
    }

    const offset = seededUnit(hashString(`${soundSeed}:${config.name}`)) * noiseBuffer.duration;
    startTracked(source, context.currentTime, offset);
  }

  function buildRoomTone() {
    createOscillatorLayer(buses.room, mainsFrequency, 0.0085, 'sine');
    createOscillatorLayer(buses.room, mainsFrequency * 2, 0.0038, 'sine');
    createOscillatorLayer(buses.room, mainsFrequency * 3, 0.0014, 'triangle');

    createNoiseLayer(buses.ventilation, {
      name: 'distant-ventilation',
      filterType: 'lowpass',
      frequency: 720,
      q: 0.35,
      gain: 0.028,
      modulationRate: 0.085,
      modulationDepth: 0.0045,
    });
    createNoiseLayer(buses.machinery, {
      name: 'distant-server-fans',
      filterType: 'bandpass',
      frequency: 1120,
      q: 0.42,
      gain: 0.012,
      modulationRate: 0.23,
      modulationDepth: 0.002,
    });
  }

  function setPannerPosition(panner, position, now) {
    if (panner.positionX) {
      setParam(panner.positionX, position.x, now);
      setParam(panner.positionY, position.y, now);
      setParam(panner.positionZ, position.z, now);
    } else {
      panner.setPosition?.(position.x, position.y, position.z);
    }
  }

  function updateListener(listenerState) {
    const audioListener = context.listener;
    if (!audioListener) return;
    const position = positionOf(listenerState);
    const yaw = finiteNumber(listenerState?.yaw);
    const forward = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    const now = context.currentTime;

    if (audioListener.positionX) {
      setParam(audioListener.positionX, position.x, now);
      setParam(audioListener.positionY, position.y, now);
      setParam(audioListener.positionZ, position.z, now);
    } else {
      audioListener.setPosition?.(position.x, position.y, position.z);
    }

    if (audioListener.forwardX) {
      setParam(audioListener.forwardX, forward.x, now);
      setParam(audioListener.forwardY, forward.y, now);
      setParam(audioListener.forwardZ, forward.z, now);
      setParam(audioListener.upX, 0, now);
      setParam(audioListener.upY, 1, now);
      setParam(audioListener.upZ, 0, now);
    } else {
      audioListener.setOrientation?.(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  function addVoiceNoise(voice, config) {
    const source = rememberSource(context.createBufferSource(), voice);
    const filter = rememberNode(context.createBiquadFilter());
    const gain = rememberNode(context.createGain());
    voice.nodes.add(filter);
    voice.nodes.add(gain);
    source.buffer = noiseBuffer;
    source.loop = true;
    source.playbackRate.value = config.playbackRate;
    filter.type = config.filterType;
    setParam(filter.frequency, config.frequency, context.currentTime);
    setParam(filter.Q, config.q, context.currentTime);
    setParam(gain.gain, config.gain, context.currentTime);
    connect(source, filter).connect(gain);
    gain.connect(voice.panner);
    const offset = seededUnit(hashString(`${voice.key}:noise`)) * noiseBuffer.duration;
    startTracked(source, context.currentTime, offset);
  }

  function addVoiceOscillator(voice, frequency, gainValue, type = 'sine') {
    const oscillator = rememberSource(context.createOscillator(), voice);
    const gain = rememberNode(context.createGain());
    voice.nodes.add(gain);
    oscillator.type = type;
    setParam(oscillator.frequency, frequency, context.currentTime);
    setParam(gain.gain, gainValue, context.currentTime);
    connect(oscillator, gain).connect(voice.panner);
    startTracked(oscillator);
  }

  function createEmitterVoice(entry, elapsed) {
    const profile = EMITTER_PROFILES[entry.type];
    if (!profile) return null;
    const panner = rememberNode(context.createPanner());
    const output = rememberNode(context.createGain());
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = profile.near;
    panner.maxDistance = profile.far;
    panner.rolloffFactor = 0.7;
    setParam(output.gain, 0, context.currentTime);
    panner.connect(output);
    output.connect(
      entry.type === 'vent'
        ? buses.ventilation
        : entry.type === 'fluorescent'
          ? buses.fixtures
          : buses.machinery,
    );

    const voice = {
      key: entry.key,
      type: entry.type,
      panner,
      output,
      sources: new Set(),
      nodes: new Set([panner, output]),
      clickCount: 0,
      nextSeekElapsed: elapsed + hddInterval(entry.key, 0),
      releaseAt: Infinity,
    };
    setPannerPosition(panner, entry.position, context.currentTime);

    if (entry.type === 'vent') {
      addVoiceNoise(voice, {
        filterType: 'lowpass',
        frequency: 860,
        q: 0.42,
        gain: 0.52,
        playbackRate: 0.92 + (seededUnit(hashString(entry.key)) * 0.13),
      });
      addVoiceOscillator(voice, 37 + (seededUnit(hashString(`${entry.key}:rotor`)) * 12), 0.035);
    } else if (entry.type === 'rack') {
      addVoiceNoise(voice, {
        filterType: 'bandpass',
        frequency: 980 + (seededUnit(hashString(entry.key)) * 360),
        q: 0.38,
        gain: 0.34,
        playbackRate: 1.03 + (seededUnit(hashString(`${entry.key}:fan`)) * 0.16),
      });
      addVoiceOscillator(voice, 74 + (seededUnit(hashString(`${entry.key}:rotor`)) * 24), 0.052);
      addVoiceOscillator(voice, 148 + (seededUnit(hashString(`${entry.key}:bearing`)) * 31), 0.019);
    } else {
      const drift = (seededUnit(hashString(entry.key)) - 0.5) * 2.4;
      addVoiceOscillator(voice, (mainsFrequency * 2) + drift, 0.09, 'triangle');
      addVoiceOscillator(voice, (mainsFrequency * 4) + drift, 0.025, 'sine');
    }
    return voice;
  }

  function playHddClick(voice, intensity) {
    const now = context.currentTime;
    const oscillator = rememberSource(context.createOscillator());
    const filter = rememberNode(context.createBiquadFilter());
    const gain = rememberNode(context.createGain());
    const ownedNodes = [oscillator, filter, gain];
    oscillator.type = 'square';
    setParam(oscillator.frequency, 1550, now);
    if (typeof oscillator.frequency.exponentialRampToValueAtTime === 'function') {
      oscillator.frequency.exponentialRampToValueAtTime(430, now + 0.022);
    }
    filter.type = 'highpass';
    setParam(filter.frequency, 360, now);
    setParam(filter.Q, 0.65, now);
    setParam(gain.gain, 0, now);
    rampParam(gain.gain, 0.18 * intensity, now + 0.002);
    rampParam(gain.gain, 0, now + 0.028);
    connect(oscillator, filter).connect(gain);
    gain.connect(voice.panner);
    oscillator.onended = () => forgetOneShot(oscillator, ownedNodes);
    oscillator.start(now);
    oscillator.stop(now + 0.032);
  }

  function releaseVoice(voice, now) {
    if (retiringVoices.has(voice)) return;
    smoothParam(voice.output.gain, 0, now, 0.025);
    voice.releaseAt = now + 0.12;
    for (const source of voice.sources) safeStop(source, voice.releaseAt);
    retiringVoices.add(voice);
  }

  function cleanupRetiringVoices(force = false) {
    const now = context?.currentTime || 0;
    for (const voice of retiringVoices) {
      if (!force && now < voice.releaseAt) continue;
      for (const source of voice.sources) {
        sources.delete(source);
        nodes.delete(source);
      }
      for (const node of voice.nodes) {
        safeDisconnect(node);
        nodes.delete(node);
      }
      retiringVoices.delete(voice);
    }
  }

  function clearGraph() {
    const now = context?.currentTime || 0;
    for (const source of sources) safeStop(source, now);
    for (const node of nodes) safeDisconnect(node);
    sources.clear();
    nodes.clear();
    voices.clear();
    retiringVoices.clear();
    master = null;
    buses = null;
    noiseBuffer = null;
  }

  function start() {
    if (disposed) return false;
    if (context) return true;
    const AudioContextImpl = resolveAudioContextImpl(AudioContextImplOption);
    if (!AudioContextImpl) return false;

    let candidate = null;
    try {
      candidate = new AudioContextImpl();
      context = candidate;
      master = rememberNode(context.createGain());
      setParam(master.gain, muted ? 0 : outputVolume, context.currentTime);
      master.connect(context.destination);
      buses = {
        room: createBus(1),
        ventilation: createBus(0.78),
        fixtures: createBus(0.72),
        machinery: createBus(0.82),
        transients: createBus(0.9),
      };
      noiseBuffer = createNoiseBuffer(context, soundSeed);
      buildRoomTone();
      Promise.resolve(context.resume?.()).catch(() => {});
      return true;
    } catch {
      clearGraph();
      context = null;
      Promise.resolve(candidate?.close?.()).catch(() => {});
      return false;
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (context && master && context.state !== 'closed') {
      smoothParam(master.gain, muted ? 0 : outputVolume, context.currentTime, 0.025);
    }
    return muted;
  }

  async function suspend() {
    if (!context || disposed || context.state === 'closed') return false;
    try {
      await context.suspend?.();
      return true;
    } catch {
      return false;
    }
  }

  async function resume() {
    if (!context || disposed || context.state === 'closed') return false;
    try {
      await context.resume?.();
      return true;
    } catch {
      return false;
    }
  }

  function update({ listener = {}, emitters = [], elapsed = 0 } = {}) {
    if (!context || disposed || context.state === 'closed') return 0;
    const safeElapsed = Math.max(0, finiteNumber(elapsed, context.currentTime));
    updateListener(listener);
    cleanupRetiringVoices();
    const ranked = rankEmitters(emitters, listener, emitterLimits);
    const selectedKeys = new Set();
    const now = context.currentTime;

    for (const entry of ranked) {
      selectedKeys.add(entry.key);
      let voice = voices.get(entry.key);
      if (!voice) {
        try {
          voice = createEmitterVoice(entry, safeElapsed);
        } catch {
          voice = null;
        }
        if (!voice) continue;
        voices.set(entry.key, voice);
      }
      setPannerPosition(voice.panner, entry.position, now);
      const profile = EMITTER_PROFILES[entry.type];
      const distance = Math.sqrt(entry.distanceSquared);
      const approach = proximityGain(distance, profile);
      smoothParam(voice.output.gain, profile.baseGain * approach, now, 0.055);

      if (entry.type === 'rack') {
        if (approach > 0.1 && safeElapsed >= voice.nextSeekElapsed) {
          voice.clickCount += 1;
          playHddClick(voice, clamp(approach * 1.3, 0.15, 1));
          voice.nextSeekElapsed = safeElapsed + hddInterval(voice.key, voice.clickCount);
        } else if (approach <= 0.1 && safeElapsed >= voice.nextSeekElapsed) {
          voice.nextSeekElapsed = safeElapsed + hddInterval(voice.key, voice.clickCount);
        }
      }
    }

    for (const [key, voice] of voices) {
      if (selectedKeys.has(key)) continue;
      voices.delete(key);
      releaseVoice(voice, now);
    }
    return ranked.length;
  }

  function footstep(running = false) {
    if (!context || disposed || context.state === 'closed' || muted) return false;
    try {
      const now = context.currentTime;
      const noise = rememberSource(context.createBufferSource());
      const noiseFilter = rememberNode(context.createBiquadFilter());
      const noiseGain = rememberNode(context.createGain());
      const thump = rememberSource(context.createOscillator());
      const thumpGain = rememberNode(context.createGain());
      const ownedNodes = [noise, noiseFilter, noiseGain, thump, thumpGain];
      const intensity = running ? 1 : 0.68;

      noise.buffer = noiseBuffer;
      noiseFilter.type = 'lowpass';
      setParam(noiseFilter.frequency, running ? 760 : 570, now);
      setParam(noiseGain.gain, 0, now);
      rampParam(noiseGain.gain, 0.115 * intensity, now + 0.004);
      rampParam(noiseGain.gain, 0, now + 0.075);
      connect(noise, noiseFilter).connect(noiseGain);
      noiseGain.connect(buses.transients);

      thump.type = 'sine';
      setParam(thump.frequency, running ? 82 : 68, now);
      if (typeof thump.frequency.exponentialRampToValueAtTime === 'function') {
        thump.frequency.exponentialRampToValueAtTime(42, now + 0.085);
      }
      setParam(thumpGain.gain, 0, now);
      rampParam(thumpGain.gain, 0.07 * intensity, now + 0.005);
      rampParam(thumpGain.gain, 0, now + 0.095);
      connect(thump, thumpGain).connect(buses.transients);

      let ended = 0;
      const onEnded = () => {
        ended += 1;
        if (ended === 2) {
          sources.delete(noise);
          sources.delete(thump);
          for (const node of ownedNodes) {
            safeDisconnect(node);
            nodes.delete(node);
          }
        }
      };
      noise.onended = onEnded;
      thump.onended = onEnded;
      const offset = seededUnit(hashString(`${soundSeed}:step:${Math.floor(now * 1000)}`))
        * Math.max(0, noiseBuffer.duration - 0.1);
      noise.start(now, offset, 0.085);
      thump.start(now);
      thump.stop(now + 0.1);
      return true;
    } catch {
      return false;
    }
  }

  async function dispose() {
    if (disposed) return false;
    disposed = true;
    const closingContext = context;
    clearGraph();
    context = null;
    if (closingContext && closingContext.state !== 'closed') {
      try {
        await closingContext.close?.();
      } catch {
        // Disposal is complete even if the browser rejects close().
      }
    }
    return Boolean(closingContext);
  }

  return {
    start,
    setMuted,
    suspend,
    resume,
    update,
    footstep,
    dispose,
  };
}
