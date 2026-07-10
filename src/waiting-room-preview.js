import { createRemotePlayerManager } from './remote-players.js';

/**
 * Renders the real in-game survivor rig into every occupied waiting-room slot.
 * The existing game renderer is shared across all four cards via scissor
 * rendering, so the lobby does not allocate another graphics context.
 */
export function createWaitingRoomPreview(THREE, {
  renderer,
  slotsElement,
  reducedMotion = false,
} = {}) {
  if (!THREE || typeof THREE.WebGLRenderer !== 'function') {
    throw new TypeError('createWaitingRoomPreview requires the active Three.js namespace.');
  }
  if (!renderer?.domElement || !slotsElement) {
    throw new TypeError('createWaitingRoomPreview requires the game renderer and slots element.');
  }

  let scene = null;
  let camera = null;
  let manager = null;
  let platform = null;
  let backdrop = null;
  let visible = false;
  let disposed = false;
  let players = [];
  let previewTime = 0;

  function initialize() {
    if (scene || disposed) return;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    camera.position.set(0, 0.9, 4.55);
    camera.lookAt(0, 0.84, 0);

    const hemisphere = new THREE.HemisphereLight(0xeee6c7, 0x15180f, 2.2);
    const key = new THREE.DirectionalLight(0xffe9ad, 3.6);
    key.position.set(-2.4, 4.2, 3.8);
    const rim = new THREE.DirectionalLight(0x91b0a1, 2.2);
    rim.position.set(3.2, 2.4, -2.6);
    const face = new THREE.PointLight(0xffe8b6, 9, 7, 2);
    face.position.set(0, 1.9, 3.1);
    scene.add(hemisphere, key, rim, face);

    const platformMaterial = new THREE.MeshStandardMaterial({
      color: 0x34372a,
      emissive: 0x11140e,
      emissiveIntensity: 0.35,
      roughness: 0.78,
      metalness: 0.16,
      transparent: true,
      opacity: 0.82,
    });
    platform = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 0.055, 24), platformMaterial);
    platform.position.y = -0.065;
    const backdropMaterial = new THREE.MeshBasicMaterial({
      color: 0x58624b,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      toneMapped: false,
    });
    backdrop = new THREE.Mesh(new THREE.CircleGeometry(1.08, 32), backdropMaterial);
    backdrop.position.set(0, 0.88, -0.48);
    scene.add(backdrop, platform);

    manager = createRemotePlayerManager(THREE, scene, {
      avatarScale: 1.12,
      castShadow: false,
      receiveShadow: false,
      nameTags: false,
      flashlights: false,
      flashlightBeams: false,
      positionSmoothing: 24,
      rotationSmoothing: 18,
    });
  }

  function setPlayers(nextPlayers = []) {
    if (disposed) return;
    initialize();
    players = nextPlayers.slice(0, 4).map((player) => ({
      id: String(player.id),
      name: String(player.name || 'WANDERER'),
      ready: player.ready === true,
      color: new THREE.Color(player.look?.color ?? 0x81794b)
        .offsetHSL(0, 0.1, 0.12)
        .getHex(),
      characterId: typeof player.characterId === 'string' && player.characterId
        ? player.characterId
        : undefined,
    }));
    const present = new Set(players.map((player) => player.id));
    for (const id of [...manager.keys()]) {
      if (!present.has(id)) manager.remove(id);
    }
    players.forEach((player) => {
      const entry = manager.upsert({
        id: player.id,
        name: player.name,
        characterId: player.characterId,
        color: player.color,
        position: { x: 0, y: 0, z: 0 },
        yaw: -0.12,
        pitch: 0,
        speed: 0,
        crouching: false,
        running: false,
        flashlight: false,
        visible: true,
      });
      entry.group.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.filter(Boolean).forEach((material) => {
          if (!material.isMeshStandardMaterial || material.userData.waitingRoomLit) return;
          material.userData.waitingRoomLit = true;
          material.emissive.copy(material.color).multiplyScalar(0.2);
          material.emissiveIntensity = 0.72;
        });
      });
    });
  }

  function render() {
    const canvas = renderer.domElement;
    if (!visible || !scene || !players.length || canvas.clientWidth < 2 || canvas.clientHeight < 2) {
      return;
    }
    const previousAutoClear = renderer.autoClear;
    const previousExposure = renderer.toneMappingExposure;
    renderer.autoClear = false;
    renderer.toneMappingExposure = Math.max(previousExposure, 1.18);
    renderer.setScissorTest(true);

    const canvasRect = canvas.getBoundingClientRect();
    const width = canvasRect.width;
    const height = canvasRect.height;
    const slotNodes = slotsElement.querySelectorAll('.waiting-slot[data-player-id]');
    for (const slot of slotNodes) {
      const player = players.find((candidate) => candidate.id === slot.dataset.playerId);
      if (!player) continue;
      const rect = slot.getBoundingClientRect();
      const x = Math.max(0, rect.left - canvasRect.left);
      const y = Math.max(0, canvasRect.bottom - rect.bottom);
      const slotWidth = Math.min(width - x, rect.width);
      const slotHeight = Math.min(height - y, rect.height);
      if (slotWidth < 2 || slotHeight < 2) continue;

      manager.forEach((entry) => {
        entry.group.visible = entry.id === player.id;
      });
      platform.material.color.set(player.ready ? 0x74794e : 0x34372a);
      platform.material.emissive.set(player.ready ? 0x333a18 : 0x11140e);
      platform.material.emissiveIntensity = player.ready ? 0.9 : 0.35;
      backdrop.material.color.set(player.color);
      backdrop.material.opacity = player.ready ? 0.48 : 0.3;
      camera.aspect = slotWidth / slotHeight;
      camera.updateProjectionMatrix();
      renderer.setViewport(x, y, slotWidth, slotHeight);
      renderer.setScissor(x, y, slotWidth, slotHeight);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.autoClear = previousAutoClear;
    renderer.toneMappingExposure = previousExposure;
    manager.forEach((entry) => {
      entry.group.visible = true;
    });
  }

  return {
    setVisible(nextVisible) {
      if (disposed) return;
      visible = Boolean(nextVisible);
      if (visible) initialize();
    },
    setPlayers,
    update(deltaSeconds) {
      if (!visible || disposed) return;
      const delta = reducedMotion ? 0 : deltaSeconds;
      previewTime += delta;
      manager?.update(delta, camera);
      manager?.forEach((entry) => {
        entry.group.rotation.y = -0.12 + Math.sin(previewTime * 0.72 + entry.id.length) * 0.12;
      });
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      manager?.dispose();
      platform?.geometry.dispose();
      platform?.material.dispose();
      backdrop?.geometry.dispose();
      backdrop?.material.dispose();
      players = [];
    },
  };
}
