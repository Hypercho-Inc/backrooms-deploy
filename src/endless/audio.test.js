import assert from 'node:assert/strict';
import test from 'node:test';
import { createEndlessAudio, prioritizeEmitters, proximityGain } from './audio.js';

test('emitter prioritization deterministically selects the nearest entries within type caps', () => {
  const emitters = [
    { id: 'vent-far', type: 'ceiling-vent', position: { x: 9, y: 2, z: 0 } },
    { id: 'rack-far', type: 'server-rack', position: { x: 7, y: 0, z: 0 } },
    { id: 'fixture-b', type: 'fluorescent', position: { x: -2, y: 3, z: 0 } },
    { id: 'vent-near', type: 'ventilation', position: { x: 1, y: 2, z: 0 } },
    { id: 'rack-near', type: 'rack', position: { x: 3, y: 0, z: 0 } },
    { id: 'fixture-a', type: 'ballast', position: { x: 2, y: 3, z: 0 } },
    { id: 'vent-middle', type: 'duct', position: { x: 4, y: 2, z: 0 } },
  ];
  const listener = { x: 0, y: 0, z: 0 };
  const limits = { vent: 2, rack: 1, fluorescent: 1 };

  const first = prioritizeEmitters(emitters, listener, limits).map((emitter) => emitter.id);
  const reordered = prioritizeEmitters([...emitters].reverse(), listener, limits)
    .map((emitter) => emitter.id);

  assert.deepEqual(first, ['vent-near', 'rack-near', 'fixture-a', 'vent-middle']);
  assert.deepEqual(reordered, first);
  assert.ok(!first.includes('vent-far'));
  assert.ok(!first.includes('rack-far'));
  assert.ok(!first.includes('fixture-b'));
});

test('proximity gain rises smoothly as the listener approaches an emitter', () => {
  const profile = { near: 1, far: 13, curve: 1.5 };
  const atSource = proximityGain(0, profile);
  const close = proximityGain(3, profile);
  const middle = proximityGain(7, profile);
  const distant = proximityGain(11, profile);

  assert.equal(atSource, 1);
  assert.ok(close > middle);
  assert.ok(middle > distant);
  assert.ok(distant > 0);
  assert.equal(proximityGain(13, profile), 0);
  assert.equal(proximityGain(100, profile), 0);
});

test('audio lifecycle is a safe no-op when Web Audio is unavailable', async () => {
  const audio = createEndlessAudio({ AudioContextImpl: null });

  assert.equal(audio.start(), false);
  assert.equal(audio.update(), 0);
  assert.equal(audio.update({
    listener: { x: 0, y: 1.7, z: 0, yaw: 0 },
    emitters: [{ id: 'vent', type: 'vent', x: 1, y: 2, z: 1 }],
    elapsed: 4,
  }), 0);
  assert.equal(audio.footstep(false), false);
  assert.equal(audio.setMuted(true), true);
  assert.equal(await audio.suspend(), false);
  assert.equal(await audio.resume(), false);
  assert.equal(await audio.dispose(), false);
  assert.equal(audio.start(), false);
});

test('default construction remains Node-safe without a window AudioContext', async () => {
  const audio = createEndlessAudio();
  assert.equal(audio.start(), false);
  assert.equal(await audio.dispose(), false);
});
