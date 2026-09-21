(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA STAGE]';
  const { config, events, util } = XRA;

  let gltfLoaderInstance = null;
  let activeStageMesh = null;
  const activeProps = {}; // { [propKey]: { mesh, staticPos, staticRot, staticScale, currentHand, lastSeenTime } }

  function getAvatarModel() {
    return window.MMD_SA?.THREEX?.get_model?.(0) || window.MMD_SA?.THREEX?.models?.[0] || null;
  }

  function isVRMModel(avatar) {
    const a = avatar || getAvatarModel();
    if (!a) return true; // Default to VRM (standard metric meters)
    return a.type === 'VRM' || !!a.is_VRM || !!a.model?.humanoid || !!a.vrm;
  }

  function getScaleFactor() {
    return 1.0;
  }

  function getHandRaisedThreshold() {
    return 9.2;
  }

  const DETACH_GRACE_PERIOD_MS = 1200;

  // Preset static desk positions in XR Animator world units (desk height Y ~ 8.0)
  const DEFAULT_PROP_ANCHORS = {
    cell_phone: { pos: [-2.8, 8.05, 3.2], rot: [Math.PI / 2, 0, 0.15], scale: 1.0 },
    cup:        { pos: [ 2.8, 8.55, 3.2], rot: [0, 0, 0], scale: 1.0 },
    microphone: { pos: [ 0.0, 8.90, 2.6], rot: [0.35, 0, 0], scale: 1.0 },
  };

  // Fine-tuned grip transforms in XR Animator world units relative to wrist bone:
  // Palm center is ~0.5 units (5cm) along the hand axis into the palm.
  const PROP_GRIP_TRANSFORMS = {
    cell_phone: {
      right: { pos: [-0.55, -0.15, 0.25], rot: [0.10, 0.25, -Math.PI / 2] },
      left:  { pos: [ 0.55, -0.15, 0.25], rot: [0.10, -0.25, Math.PI / 2] },
      scale: 1.0,
    },
    cup: {
      right: { pos: [-0.55, -0.20, 0.20], rot: [0.0, 0.10, 0.0] },
      left:  { pos: [ 0.55, -0.20, 0.20], rot: [0.0, -0.10, 0.0] },
      scale: 1.0,
    },
    microphone: {
      right: { pos: [-0.45, -0.20, 0.30], rot: [-0.35, 0.20, -Math.PI / 2] },
      left:  { pos: [ 0.45, -0.20, 0.30], rot: [-0.35, -0.20, Math.PI / 2] },
      scale: 1.0,
    },
  };

  const DEFAULT_GRIP = {
    right: { pos: [-0.50, -0.15, 0.20], rot: [0, 0, -Math.PI / 2] },
    left:  { pos: [ 0.50, -0.15, 0.20], rot: [0, 0, Math.PI / 2] },
    scale: 1.0,
  };

  // XR Animator keeps the legacy renderer on window.THREE (r58) and the
  // active VRM renderer on MMD_SA.THREEX.THREE (r177).  The bundled FBX/GLTF
  // loaders are r177 modules, so loaded objects must use the active renderer's
  // Three instance.  Mixing the two makes the load callback fail before the
  // stage is added to the scene (r58 has no Group).
  function getRuntimeThree() {
    return window.MMD_SA?.THREEX?.THREE || window.THREEX || window.THREE || null;
  }

  function loaderModuleUrl(filename) {
    const base = String(window.System?.Gadget?.path || '').replace(/\/+$/, '');
    return `${base}/three.js/loaders/${filename}`;
  }

  let fbxLoaderInstance = null;
  async function getFBXLoader() {
    if (fbxLoaderInstance) return fbxLoaderInstance;
    const THREE = getRuntimeThree();
    if (!THREE) return null;
    if (THREE.FBXLoader) {
      fbxLoaderInstance = new THREE.FBXLoader();
      return fbxLoaderInstance;
    }
    try {
      const loaderModule = await import(loaderModuleUrl('FBXLoader.js'));
      Object.assign(THREE, loaderModule);
      fbxLoaderInstance = new loaderModule.FBXLoader();
      return fbxLoaderInstance;
    }
    catch (e) {
      console.warn(TAG, 'FBXLoader import failed', e);
      return null;
    }
  }

  async function getGLTFLoader() {
    if (gltfLoaderInstance) return gltfLoaderInstance;
    const THREE = getRuntimeThree();
    if (!THREE) return null;
    if (THREE.GLTFLoader) {
      gltfLoaderInstance = new THREE.GLTFLoader();
      return gltfLoaderInstance;
    }
    try {
      const loaderModule = await import(loaderModuleUrl('GLTFLoader.js'));
      Object.assign(THREE, loaderModule);
      gltfLoaderInstance = new loaderModule.GLTFLoader();
      return gltfLoaderInstance;
    }
    catch (e) {
      console.warn(TAG, 'GLTFLoader import failed', e);
      return null;
    }
  }

  function getScene() {
    return window.MMD_SA?.THREEX?.scene || window.jThree?.( 'scene' )?.three?.(0) || null;
  }

  function getWristBone(handSide) {
    const avatar = getAvatarModel();
    if (!avatar) return null;
    const isVRM = isVRMModel(avatar);

    if (isVRM) {
      const vrmBoneName = handSide === 'right' ? 'rightHand' : 'leftHand';
      return (
        avatar.getBoneNode?.(vrmBoneName) ||
        avatar.model?.humanoid?.getNormalizedBoneNode?.(vrmBoneName) ||
        avatar.model?.humanoid?.getBoneNode?.(vrmBoneName) ||
        avatar.get_bone_by_MMD_name?.(handSide === 'right' ? '右手首' : '左手首')
      );
    }
    // MMD
    const mmdBoneName = handSide === 'right' ? '右手首' : '左手首';
    return avatar.get_bone_by_MMD_name?.(mmdBoneName) || avatar.mesh?.bones_by_name?.[mmdBoneName];
  }

  function getWristWorldPosition(handSide) {
    const bone = getWristBone(handSide);
    const THREE = getRuntimeThree();
    if (!bone || !THREE) return null;
    const v = new THREE.Vector3();
    bone.getWorldPosition(v);
    return v;
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    mesh.traverse?.((node) => {
      if (node.geometry) node.geometry.dispose?.();
      if (node.material) {
        if (Array.isArray(node.material)) {
          node.material.forEach(m => m?.dispose?.());
        } else {
          node.material.dispose?.();
        }
      }
    });
    const scene = getScene();
    if (scene && mesh.parent === scene) {
      scene.remove(mesh);
    } else if (mesh.parent) {
      mesh.parent.remove(mesh);
    }
  }

  // --- 3D Stage Management ---

  async function applyStage() {
    const stageConf = config.stage || {};
    const path = stageConf.path || '';
    const enabled = !!stageConf.enabled && !!path;

    if (!enabled) {
      if (activeStageMesh) {
        disposeMesh(activeStageMesh);
        activeStageMesh = null;
        console.log(TAG, 'Stage removed and disposed');
      }
      events.emit('stage-updated', { enabled: false, path: '' });
      return true;
    }

    const scene = getScene();
    if (!scene) {
      setTimeout(applyStage, 300);
      return false;
    }

    if (activeStageMesh && activeStageMesh._xra_path === path) {
      updateStageTransform();
      return true;
    }

    if (activeStageMesh) {
      disposeMesh(activeStageMesh);
      activeStageMesh = null;
    }

    const isFBX = path.toLowerCase().endsWith('.fbx');
    const loader = isFBX ? await getFBXLoader() : await getGLTFLoader();
    if (!loader) {
      console.warn(TAG, `Cannot load stage: ${isFBX ? 'FBXLoader' : 'GLTFLoader'} unavailable`);
      return false;
    }

    try {
      const url = new URL(path, location.href).href;
      loader.load(
        url,
        (result) => {
          activeStageMesh = isFBX ? result : (result.scene || result.scenes?.[0]);
          if (!activeStageMesh) return;
          activeStageMesh._xra_path = path;

          // Lights are scene-global in Three.js even when parented to the
          // stage.  Do not inject helper lights here: they also illuminate the
          // avatar and every loaded prop, changing the user's established look.
          const THREE = getRuntimeThree();

          activeStageMesh.traverse((node) => {
            if (node.isMesh) {
              node.frustumCulled = false;
              if (node.material) {
                if (Array.isArray(node.material)) {
                  node.material.forEach(m => { if (m && THREE) m.side = THREE.DoubleSide; });
                } else {
                  if (THREE) node.material.side = THREE.DoubleSide;
                }
              }
            }
          });

          scene.add(activeStageMesh);
          updateStageTransform();
          console.log(TAG, 'Loaded 3D stage from:', path);
          events.emit('stage-updated', { enabled: true, path });
        },
        undefined,
        (err) => {
          console.warn(TAG, 'Failed to load 3D stage:', err);
        }
      );
      return true;
    }
    catch (e) {
      console.warn(TAG, 'Stage load exception:', e);
      return false;
    }
  }

  function updateStageTransform() {
    if (!activeStageMesh) return;
    const stageConf = config.stage || {};

    const offsetY = Number(stageConf.offset_y ?? 0.0);
    const offsetZ = Number(stageConf.offset_z ?? 0.0);
    const scale = Number(stageConf.scale ?? 1.0);
    const rotY = Number(stageConf.rotation_y ?? 0.0) * (Math.PI / 180.0);

    activeStageMesh.position.set(0, offsetY, offsetZ);
    activeStageMesh.scale.set(scale, scale, scale);
    activeStageMesh.rotation.set(0, rotY, 0);
  }

  async function listStages(force = false) {
    try {
      const r = await fetch('/__xra_stages?' + (force ? 'refresh=1&' : '') + '_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data.files) ? data.files : [];
    }
    catch (e) {
      console.warn(TAG, 'listStages failed', e);
      return [];
    }
  }

  // --- 3D Props Management ---

  async function listProps(force = false) {
    try {
      const r = await fetch('/__xra_props?' + (force ? 'refresh=1&' : '') + '_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data.files) ? data.files : [];
    }
    catch (e) {
      console.warn(TAG, 'listProps failed', e);
      return [];
    }
  }

  async function loadProp(propKey, glbPath, anchor) {
    const scene = getScene();
    if (!scene) return null;
    const loader = await getGLTFLoader();
    if (!loader) return null;

    return new Promise((resolve) => {
      const url = new URL(glbPath, location.href).href;
      loader.load(url, (gltf) => {
        const mesh = gltf.scene || gltf.scenes?.[0];
        if (!mesh) return resolve(null);

        const anc = anchor || DEFAULT_PROP_ANCHORS[propKey] || { pos: [0, 8.05, 3.0], rot: [0, 0, 0], scale: 1 };
        const scaledPos = [...anc.pos];
        const scaledScale = anc.scale;

        mesh.position.set(...scaledPos);
        mesh.rotation.set(...anc.rot);
        mesh.scale.set(scaledScale, scaledScale, scaledScale);

        // A light parented to a prop still affects the whole scene and stacked
        // props multiply the avatar brightness.  Props reuse the scene lights.
        const THREE = getRuntimeThree();

        mesh.traverse((node) => {
          if (node.isMesh) {
            node.frustumCulled = false;
            if (node.material) {
              if (Array.isArray(node.material)) {
                node.material.forEach(m => { if (m && THREE) m.side = THREE.DoubleSide; });
              } else if (THREE) {
                node.material.side = THREE.DoubleSide;
              }
            }
          }
        });

        scene.add(mesh);
        activeProps[propKey] = {
          mesh,
          staticPos: [...scaledPos],
          staticRot: [...anc.rot],
          staticScale: scaledScale,
          currentHand: null,
          lastSeenTime: 0,
        };
        console.log(TAG, `Prop loaded: ${propKey} at`, scaledPos);
        resolve(activeProps[propKey]);
      }, undefined, (err) => {
        console.warn(TAG, `Failed to load prop ${propKey}:`, err);
        resolve(null);
      });
    });
  }

  function updateHeldProps() {
    if (!config.object_tracking?.enabled) {
      resetAllProps();
      return;
    }
    const THREE = getRuntimeThree();
    if (!THREE) return;
    for (const [propKey, prop] of Object.entries(activeProps)) {
      if (!prop.currentHand || !prop.mesh) continue;
      const bone = getWristBone(prop.currentHand);
      if (!bone) continue;

      try {
        bone.updateWorldMatrix?.(true, false);
      } catch (e) {}

      const wristPos = new THREE.Vector3();
      const wristQuat = new THREE.Quaternion();
      bone.getWorldPosition(wristPos);
      bone.getWorldQuaternion(wristQuat);

      const userGrip = config.object_tracking?.grip?.[propKey] || {};
      const defaultGrip = PROP_GRIP_TRANSFORMS[propKey] || DEFAULT_GRIP;
      const grip = defaultGrip[prop.currentHand] || defaultGrip.right;

      // User calibration sliders are in cm; in XR Animator world units: 1 unit = 10cm, so 1cm = 0.1 units
      const uX = (Number(userGrip.pos_x ?? 0) / 10.0);
      const uY = (Number(userGrip.pos_y ?? 0) / 10.0);
      const uZ = (Number(userGrip.pos_z ?? 0) / 10.0);

      const offset = new THREE.Vector3(
        grip.pos[0] + uX,
        grip.pos[1] + uY,
        grip.pos[2] + uZ
      );
      offset.applyQuaternion(wristQuat);

      const rotEuler = new THREE.Euler(
        grip.rot[0] + ((Number(userGrip.rot_x ?? 0)) * Math.PI / 180.0),
        grip.rot[1] + ((Number(userGrip.rot_y ?? 0)) * Math.PI / 180.0),
        grip.rot[2] + ((Number(userGrip.rot_z ?? 0)) * Math.PI / 180.0),
        'XYZ'
      );
      const rotQuat = new THREE.Quaternion().setFromEuler(rotEuler);

      const finalScale = grip.scale || 1.0;

      prop.mesh.position.copy(wristPos).add(offset);
      prop.mesh.quaternion.copy(wristQuat).multiply(rotQuat);
      prop.mesh.scale.set(finalScale, finalScale, finalScale);
    }
  }

  function attachPropToHand(propKey, handSide) {
    if (!config.object_tracking?.enabled) {
      detachProp(propKey);
      return;
    }
    const prop = activeProps[propKey];
    if (!prop || !prop.mesh) return;

    const bone = getWristBone(handSide);
    if (!bone) return;

    if (prop.currentHand !== handSide) {
      prop.currentHand = handSide;
      events.emit('prop-attached', { prop: propKey, hand: handSide });
    }

    updateHeldProps();
  }

  function detachProp(propKey) {
    const prop = activeProps[propKey];
    if (!prop || !prop.mesh || !prop.currentHand) return;

    const scene = getScene();
    if (scene && prop.mesh.parent !== scene) {
      if (prop.mesh.parent) prop.mesh.parent.remove(prop.mesh);
      scene.add(prop.mesh);
    }

    prop.mesh.position.set(...prop.staticPos);
    prop.mesh.rotation.set(...prop.staticRot);
    prop.mesh.scale.set(prop.staticScale, prop.staticScale, prop.staticScale);
    prop.currentHand = null;
    prop.lastSeenTime = 0;
    events.emit('prop-detached', { prop: propKey });
  }

  function resetAllProps() {
    for (const propKey of Object.keys(activeProps)) {
      detachProp(propKey);
    }
  }

  function setObjectTrackingEnabled(enabled) {
    if (!enabled) resetAllProps();
  }

  function updateGripTransforms() {
    updateHeldProps();
  }

  // Called when object detection results arrive from WebSocket
  function onObjectDetected(detections) {
    // A detection already in flight can arrive just after the user disables
    // the feature.  OFF must win over that stale result immediately.
    if (!config.object_tracking?.enabled) {
      resetAllProps();
      return;
    }
    if (!Array.isArray(detections)) return;

    const now = performance.now();
    const detectedMap = {};
    for (const det of detections) {
      const cat = (det.category || '').toLowerCase();
      let propKey = null;
      if (cat.includes('phone')) propKey = 'cell_phone';
      else if (cat.includes('cup') || cat.includes('bottle')) propKey = 'cup';
      else if (cat.includes('mic')) propKey = 'microphone';

      if (propKey) {
        detectedMap[propKey] = det.hand || 'right';
      }
    }

    const raisedThreshold = getHandRaisedThreshold();

    // Attach or evaluate holding hysteresis
    for (const [propKey, prop] of Object.entries(activeProps)) {
      const targetHand = detectedMap[propKey];
      if (targetHand) {
        prop.lastSeenTime = now;
        attachPropToHand(propKey, targetHand);
      } else if (prop.currentHand) {
        // ANTI-DROP HYSTERESIS:
        // Check if hand is still raised (holding pose). If so, DO NOT DROP!
        const wristPos = getWristWorldPosition(prop.currentHand);
        const isHandRaised = wristPos ? wristPos.y > raisedThreshold : false;

        if (isHandRaised) {
          // Hand is still in holding zone (chest/face/air) -> keep holding firmly
        } else {
          // Hand has descended to desk/resting level
          if (now - (prop.lastSeenTime || 0) > DETACH_GRACE_PERIOD_MS) {
            detachProp(propKey);
          }
        }
      }
    }

    events.emit('objects-detected', detections);
  }

  // Periodic check loop for hands returning to desk level
  setInterval(() => {
    if (!config.object_tracking?.enabled) {
      resetAllProps();
      return;
    }
    const now = performance.now();
    const raisedThreshold = getHandRaisedThreshold();
    for (const [propKey, prop] of Object.entries(activeProps)) {
      if (!prop.currentHand) continue;
      const wristPos = getWristWorldPosition(prop.currentHand);
      const isHandRaised = wristPos ? wristPos.y > raisedThreshold : false;
      if (!isHandRaised && (now - (prop.lastSeenTime || 0) > DETACH_GRACE_PERIOD_MS + 400)) {
        detachProp(propKey);
      }
    }
  }, 300);

  // Initialize default sample props if available
  async function initDefaultProps() {
    const propFiles = await listProps();
    for (const file of propFiles) {
      const name = file.replace(/^props\//, '').replace(/\.glb$/i, '');
      if (DEFAULT_PROP_ANCHORS[name] && !activeProps[name]) {
        await loadProp(name, file);
      }
    }
  }

  // Startup hooks
  window.addEventListener('MMDStarted', () => {
    setTimeout(applyStage, 600);
    setTimeout(initDefaultProps, 1200);
  });
  window.addEventListener('SA_Dungeon_onstart', () => setTimeout(applyStage, 500));
  window.addEventListener('SA_MMD_before_render', updateHeldProps);
  events.on('profile-loaded', () => {
    applyStage();
    if (config.object_tracking?.enabled) updateGripTransforms();
    else resetAllProps();
  });

  XRA.stage = {
    apply: applyStage,
    updateTransform: updateStageTransform,
    updateGripTransforms,
    listStages,
    listProps,
    loadProp,
    attachPropToHand,
    detachProp,
    resetAllProps,
    setObjectTrackingEnabled,
    onObjectDetected,
    activeProps,
  };
})();
