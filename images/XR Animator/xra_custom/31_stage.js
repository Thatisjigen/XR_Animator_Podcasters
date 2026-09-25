(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA STAGE]';
  const { config, events, util } = XRA;

  let gltfLoaderInstance = null;
  let bufferGeometryUtilsPromise = null;
  let activeStageMesh = null;
  const activeProps = {}; // { [propKey]: { mesh, staticPos, staticRot, staticScale, currentHand, lastSeenTime } }
  let sceneZoomRetryTimer = 0;
  const cameraZoomBeforeScene = new Map();
  const trackballZoomRuntime = new WeakMap();

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
    bottle:     { pos: [ 4.0, 8.55, 3.2], rot: [0, 0, 0], scale: 1.0 },
    book:       { pos: [-4.0, 8.05, 3.2], rot: [Math.PI / 2, 0, 0], scale: 1.0 },
    knife:      { pos: [ 5.0, 8.05, 3.2], rot: [0, 0, 0.3], scale: 1.0 },
    fork:       { pos: [ 5.5, 8.05, 3.2], rot: [0, 0, 0.3], scale: 1.0 },
    spoon:      { pos: [ 6.0, 8.05, 3.2], rot: [0, 0, 0.3], scale: 1.0 },
    apple:      { pos: [-5.0, 8.30, 3.2], rot: [0, 0, 0], scale: 1.0 },
    orange:     { pos: [-5.5, 8.30, 3.2], rot: [0, 0, 0], scale: 1.0 },
    banana:     { pos: [-6.0, 8.20, 3.2], rot: [0, 0, 0.5], scale: 1.0 },
    scissors:   { pos: [ 1.5, 8.05, 3.2], rot: [0, 0, 0], scale: 1.0 },
    mouse:      { pos: [-1.5, 8.10, 3.2], rot: [0, 0, 0], scale: 1.0 },
    laptop:     { pos: [ 0.0, 8.05, 5.0], rot: [0, 0, 0], scale: 1.0 },
    donut:      { pos: [-6.5, 8.30, 3.2], rot: [0, 0, 0], scale: 1.0 },
    toothbrush: { pos: [ 6.5, 8.05, 3.2], rot: [0, 0, 0.3], scale: 1.0 },
    vase:       { pos: [ 7.0, 8.55, 3.2], rot: [0, 0, 0], scale: 1.0 },
  };

  // Fine-tuned grip transforms in XR Animator world units relative to wrist bone:
  // Palm center is ~0.5 units (5cm) along the hand axis into the palm.
  const PROP_GRIP_TRANSFORMS = {
    cell_phone: {
      right: { pos: [0.0, -0.02, 0.08], rot: [0.10, 0.15, -Math.PI / 2] },
      left:  { pos: [0.0, -0.02, 0.08], rot: [0.10, -0.15, Math.PI / 2] },
      scale: 1.0,
    },
    cup: {
      right: { pos: [0.0, -0.05, 0.04], rot: [0.0, 0.0, 0.0] },
      left:  { pos: [0.0, -0.05, 0.04], rot: [0.0, 0.0, 0.0] },
      scale: 1.0,
    },
    microphone: {
      right: { pos: [0.0, -0.03, 0.06], rot: [-0.25, 0.10, -Math.PI / 2] },
      left:  { pos: [0.0, -0.03, 0.06], rot: [-0.25, -0.10, Math.PI / 2] },
      scale: 1.0,
    },
  };

  const DEFAULT_GRIP = {
    right: { pos: [0.0, -0.02, 0.05], rot: [0, 0, -Math.PI / 2] },
    left:  { pos: [0.0, -0.02, 0.05], rot: [0, 0, Math.PI / 2] },
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

  function utilityModuleUrl(filename) {
    const base = String(window.System?.Gadget?.path || '').replace(/\/+$/, '');
    return `${base}/three.js/utils/${filename}`;
  }

  async function getBufferGeometryUtils() {
    if (!bufferGeometryUtilsPromise) {
      bufferGeometryUtilsPromise = import(utilityModuleUrl('BufferGeometryUtils.js'))
        .catch((error) => {
          bufferGeometryUtilsPromise = null;
          throw error;
        });
    }
    return bufferGeometryUtilsPromise;
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

  function staticMeshBatchKey(node) {
    const geometry = node?.geometry;
    const material = node?.material;
    if (
      !node?.isMesh || node.isSkinnedMesh || node.isInstancedMesh ||
      !geometry?.isBufferGeometry || !material || Array.isArray(material) ||
      material.transparent || node.children?.length ||
      Object.keys(geometry.morphAttributes || {}).length
    ) return '';

    const attributes = Object.keys(geometry.attributes || {}).sort().map((name) => {
      const attribute = geometry.attributes[name];
      const arrayType = attribute?.array?.constructor?.name || '';
      return `${name}:${attribute?.itemSize}:${attribute?.normalized ? 1 : 0}:${arrayType}`;
    }).join('|');
    return [
      material.uuid || material.id || material.name,
      geometry.index ? 'indexed' : 'plain',
      attributes,
      node.castShadow ? 'cast' : 'no-cast',
      node.receiveShadow ? 'receive' : 'no-receive',
      node.renderOrder || 0,
    ].join('::');
  }

  async function batchStaticStageMeshes(root, animations = []) {
    if (!root?.traverse || animations?.length) return { before: 0, after: 0, skipped: true };

    let hasSkinnedMesh = false;
    const groups = new Map();
    root.updateMatrixWorld?.(true);
    root.traverse((node) => {
      if (node?.isSkinnedMesh) hasSkinnedMesh = true;
      const key = staticMeshBatchKey(node);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    });
    if (hasSkinnedMesh) return { before: 0, after: 0, skipped: true };

    const mergeGroups = [...groups.values()].filter(nodes => nodes.length > 1);
    const before = mergeGroups.reduce((total, nodes) => total + nodes.length, 0);
    if (!before) return { before: 0, after: 0, skipped: false };

    try {
      const THREE = getRuntimeThree();
      const { mergeGeometries } = await getBufferGeometryUtils();
      if (!THREE?.Matrix4 || !THREE?.Mesh || typeof mergeGeometries !== 'function') {
        return { before: 0, after: 0, skipped: true };
      }

      root.updateMatrixWorld?.(true);
      const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
      let mergedCount = 0;
      let batchCount = 0;
      for (const nodes of mergeGroups) {
        const geometries = [];
        for (const node of nodes) {
          const geometry = node.geometry.clone();
          const transform = new THREE.Matrix4().multiplyMatrices(rootInverse, node.matrixWorld);
          geometry.applyMatrix4(transform);
          geometries.push(geometry);
        }

        const mergedGeometry = mergeGeometries(geometries, false);
        geometries.forEach(geometry => geometry.dispose?.());
        if (!mergedGeometry) continue;

        const first = nodes[0];
        const mergedMesh = new THREE.Mesh(mergedGeometry, first.material);
        mergedMesh.name = `XRA_Batch_${batchCount + 1}_${first.material?.name || 'material'}`;
        mergedMesh.castShadow = !!first.castShadow;
        mergedMesh.receiveShadow = !!first.receiveShadow;
        mergedMesh.renderOrder = first.renderOrder || 0;
        mergedMesh.frustumCulled = true;
        mergedMesh.userData ||= {};
        mergedMesh.userData.xraBatchedMeshCount = nodes.length;
        root.add(mergedMesh);

        const disposed = new Set();
        for (const node of nodes) {
          node.parent?.remove(node);
          if (!disposed.has(node.geometry)) {
            node.geometry.dispose?.();
            disposed.add(node.geometry);
          }
        }
        mergedCount += nodes.length;
        batchCount++;
      }

      return { before: mergedCount, after: batchCount, skipped: false };
    }
    catch (error) {
      console.warn(TAG, 'Static stage batching unavailable:', error);
      return { before: 0, after: 0, skipped: true };
    }
  }

  function getRenderCameras() {
    const cameras = [
      window.MMD_SA?.THREEX?.camera?.obj,
      window.MMD_SA?._trackball_camera?.object,
    ].filter(Boolean);
    return [...new Set(cameras)];
  }

  function pointDistance(a, b) {
    if (!a || !b) return NaN;
    return Math.hypot(
      Number(a.x) - Number(b.x),
      Number(a.y) - Number(b.y),
      Number(a.z) - Number(b.z),
    );
  }

  function setupTrackballCamera() {
    const trackball = window.MMD_SA?._trackball_camera;
    if (!trackball) return;
    trackball.noZoom = !!config.camera?.mouse_locked;
    // Set safe distance limits for mouse wheel zooming:
    // minDistance prevents clipping inside avatar head/face
    // maxDistance prevents zooming out into the void / NaN / freezing
    trackball.minDistance = 5.0;
    trackball.maxDistance = 80.0;
  }

  function isUiElement(target) {
    if (!target || !(target instanceof Element)) return false;
    return !!target.closest(
      '#XRA_CUSTOM_PANEL, .xra-right-panel, #XRA_NATIVE_SETTINGS, .xra-native-drawer, .xra-native-root, .xra-panel, .xra-overlay, .xra-modal, select, input, button, textarea, a, label, [data-xra-ui], #UI_box, #extra_buttons, #extra_boxes, .L_box, .control_box, .native-menu, dialog, [role="dialog"], [role="menu"]'
    );
  }

  function handleWheelZoom(event) {
    if (config.camera?.mouse_locked) return;
    const trackball = window.MMD_SA?._trackball_camera;
    if (!trackball || !trackball.enabled || trackball.noZoom) return;

    if (isUiElement(event.target)) {
      return;
    }

    let delta = 0;
    if (typeof event.deltaY === 'number') {
      delta = event.deltaY;
    } else if (event.detail) {
      delta = event.detail * 40;
    } else if (event.wheelDelta) {
      delta = -event.wheelDelta;
    }

    if (!delta) return;

    event.preventDefault();

    const cam = trackball.object;
    const targetPos = trackball.target;
    if (!cam || !targetPos) return;

    const factor = delta > 0 ? 1.08 : 0.92;
    const eye = cam.position.clone().sub(targetPos);
    let dist = eye.length() * factor;

    const minDist = Number(trackball.minDistance || 5.0);
    const maxDist = Number(trackball.maxDistance || 80.0);
    dist = Math.max(minDist, Math.min(maxDist, dist));

    eye.setLength(dist);
    cam.position.copy(targetPos).add(eye);
    if (trackball._eye) trackball._eye.copy(eye);
    if (trackball.lastPosition) trackball.lastPosition.copy(cam.position);
    cam.lookAt(targetPos);
    cam.updateProjectionMatrix?.();
  }

  function applySceneZoom() {
    const stageConf = config.stage || {};
    const enabled = !!stageConf.enabled && !!stageConf.path;
    const zoomValue = Number(stageConf.scene_zoom ?? 1);
    const zoom = Math.max(0.5, Math.min(8, Number.isFinite(zoomValue) ? zoomValue : 1));
    stageConf.scene_zoom = zoom;
    const cameras = getRenderCameras();

    if (!cameras.length) {
      clearTimeout(sceneZoomRetryTimer);
      sceneZoomRetryTimer = setTimeout(() => applySceneZoom(), 250);
      return false;
    }

    clearTimeout(sceneZoomRetryTimer);
    sceneZoomRetryTimer = 0;

    for (const camera of cameras) {
      if (enabled && !cameraZoomBeforeScene.has(camera))
        cameraZoomBeforeScene.set(camera, Number(camera.zoom) || 1);
      camera.zoom = enabled ? zoom : (cameraZoomBeforeScene.get(camera) || 1);
      camera.updateProjectionMatrix?.();
      if (!enabled) cameraZoomBeforeScene.delete(camera);
    }

    setupTrackballCamera();
    events.emit('stage-scene-zoom', { enabled, zoom: enabled ? zoom : 1 });
    return true;
  }

  function sanitizeCameraVector(value, length) {
    if (!Array.isArray(value) || value.length < length) return null;
    const vector = value.slice(0, length).map(Number);
    return vector.every(Number.isFinite) ? vector : null;
  }

  function sanitizeCameraViewPreset(value) {
    if (!value || typeof value !== 'object') return null;
    const name = String(value.name || '').trim();
    const position = sanitizeCameraVector(value.position, 3);
    const target = sanitizeCameraVector(value.target, 3);
    const up = sanitizeCameraVector(value.up, 3);
    const quaternion = sanitizeCameraVector(value.quaternion, 4);
    const fov = Number(value.fov);
    const zoom = Number(value.zoom);
    if (!name || !position || !target || !up || !Number.isFinite(fov) || !Number.isFinite(zoom)) return null;
    return {
      name,
      position,
      target,
      up,
      quaternion,
      fov: Math.max(1, Math.min(179, fov)),
      zoom: Math.max(0.01, Math.min(100, zoom)),
    };
  }

  function listCameraViewPresets() {
    config.camera ||= {};
    const presets = (Array.isArray(config.camera.view_presets) ? config.camera.view_presets : [])
      .map(sanitizeCameraViewPreset)
      .filter(Boolean);
    config.camera.view_presets = presets;
    return presets;
  }

  function saveCameraViewPreset(name) {
    const cleanName = String(name || '').trim();
    const trackball = window.MMD_SA?._trackball_camera;
    const camera = getRenderCameras()[0] || trackball?.object;
    if (!cleanName || !camera?.position || !camera?.up) return null;

    let target = trackball?.target?.clone?.();
    if (!target) {
      target = camera.position.clone();
      const direction = camera.getWorldDirection?.(camera.position.clone().set(0, 0, -1));
      if (direction) target.add(direction.multiplyScalar(10));
    }
    if (!target) return null;

    const preset = sanitizeCameraViewPreset({
      name: cleanName,
      position: camera.position.toArray(),
      target: target.toArray(),
      up: camera.up.toArray(),
      quaternion: camera.quaternion?.toArray?.() || null,
      fov: Number(camera.fov) || 45,
      zoom: Number(camera.zoom) || 1,
    });
    if (!preset) return null;

    const presets = listCameraViewPresets();
    const existing = presets.findIndex(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
    if (existing >= 0) presets.splice(existing, 1, preset);
    else presets.push(preset);
    config.camera.view_presets = presets;
    config.camera.selected_view_preset = preset.name;
    events.emit('camera-view-presets-changed', { action: existing >= 0 ? 'updated' : 'saved', preset });
    return preset;
  }

  function applyCameraViewPreset(name) {
    const wanted = String(name || '').trim().toLocaleLowerCase();
    const preset = listCameraViewPresets().find(item => item.name.toLocaleLowerCase() === wanted);
    if (!preset) return false;

    const trackball = window.MMD_SA?._trackball_camera;
    const cameras = getRenderCameras();
    if (!cameras.length && trackball?.object) cameras.push(trackball.object);
    if (!cameras.length) return false;

    for (const camera of cameras) {
      camera.position?.fromArray?.(preset.position);
      camera.up?.fromArray?.(preset.up);
      if (preset.quaternion && camera.quaternion?.fromArray) camera.quaternion.fromArray(preset.quaternion);
      else camera.lookAt?.(...preset.target);
      if ('fov' in camera) camera.fov = preset.fov;
      if ('zoom' in camera) camera.zoom = preset.zoom;
      camera.updateMatrix?.();
      camera.matrixWorldNeedsUpdate = true;
      camera.updateProjectionMatrix?.();
    }

    if (trackball) {
      trackball.target?.fromArray?.(preset.target);
      trackball._eye?.subVectors?.(trackball.object.position, trackball.target);
      trackball.lastPosition?.copy?.(trackball.object.position);
      trackball._zoomStart?.copy?.(trackball._zoomEnd);
      trackball._panStart?.copy?.(trackball._panEnd);
      trackball._rotateStart?.copy?.(trackball._rotateEnd);
    }
    if (config.stage?.enabled && config.stage?.path) config.stage.scene_zoom = preset.zoom;
    config.camera.selected_view_preset = preset.name;
    events.emit('camera-view-preset-applied', { preset });
    return true;
  }

  function deleteCameraViewPreset(name) {
    const wanted = String(name || '').trim().toLocaleLowerCase();
    const presets = listCameraViewPresets();
    const filtered = presets.filter(item => item.name.toLocaleLowerCase() !== wanted);
    if (filtered.length === presets.length) return false;
    config.camera.view_presets = filtered;
    if (String(config.camera.selected_view_preset || '').toLocaleLowerCase() === wanted) {
      config.camera.selected_view_preset = '';
    }
    events.emit('camera-view-presets-changed', { action: 'deleted', name });
    return true;
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
    const mmdBoneName = handSide === 'right' ? '右手首' : '左手首';
    return avatar.get_bone_by_MMD_name?.(mmdBoneName) || avatar.mesh?.bones_by_name?.[mmdBoneName];
  }

  function getMiddleFingerBone(handSide) {
    const avatar = getAvatarModel();
    if (!avatar) return null;
    if (isVRMModel(avatar)) {
      const name = handSide === 'right' ? 'rightMiddleProximal' : 'leftMiddleProximal';
      return (
        avatar.getBoneNode?.(name) ||
        avatar.model?.humanoid?.getNormalizedBoneNode?.(name) ||
        avatar.model?.humanoid?.getBoneNode?.(name)
      );
    }
    const mmd = handSide === 'right' ? '右中指１' : '左中指１';
    return avatar.get_bone_by_MMD_name?.(mmd) || avatar.mesh?.bones_by_name?.[mmd] || null;
  }

  function getGripTransform(handSide) {
    const THREE = getRuntimeThree();
    if (!THREE) return null;
    const wrist = getWristBone(handSide);
    if (!wrist) return null;
    try { wrist.updateWorldMatrix?.(true, false); } catch (_) {}
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const mid = getMiddleFingerBone(handSide);
    if (mid) {
      try { mid.updateWorldMatrix?.(true, false); } catch (_) {}
      const wPos = new THREE.Vector3();
      const mPos = new THREE.Vector3();
      wrist.getWorldPosition(wPos);
      mid.getWorldPosition(mPos);
      pos.lerpVectors(wPos, mPos, 0.45);
      wrist.getWorldQuaternion(quat);
    } else {
      wrist.getWorldPosition(pos);
      wrist.getWorldQuaternion(quat);
    }
    return { position: pos, quaternion: quat };
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

  let currentStageLoadId = 0;

  function removeAllStagesFromScene() {
    const scene = getScene();
    if (!scene) return;
    const toRemove = [];
    scene.traverse?.((node) => {
      if (node && node !== scene && (node._is_xra_stage || node._xra_path || node.name === 'XRA_Active_Stage')) {
        toRemove.push(node);
      }
    });
    toRemove.forEach((node) => {
      disposeMesh(node);
      if (node.parent) {
        node.parent.remove(node);
      } else if (scene) {
        scene.remove(node);
      }
    });
    if (activeStageMesh) {
      disposeMesh(activeStageMesh);
      activeStageMesh = null;
    }
  }

  // --- 3D Stage Management ---

  async function applyStage() {
    const stageConf = config.stage || {};
    const path = stageConf.path || '';
    const enabled = !!stageConf.enabled && !!path;

    applySceneZoom();

    if (!enabled) {
      removeAllStagesFromScene();
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

    removeAllStagesFromScene();

    const thisLoadId = ++currentStageLoadId;
    const isFBX = path.toLowerCase().endsWith('.fbx');
    const loader = isFBX ? await getFBXLoader() : await getGLTFLoader();
    if (!loader) {
      console.warn(TAG, `Cannot load stage: ${isFBX ? 'FBXLoader' : 'GLTFLoader'} unavailable`);
      return false;
    }

    try {
      const stageUrl = new URL(path, location.href);
      stageUrl.searchParams.set('_t', Date.now());
      const url = stageUrl.href;
      loader.load(
        url,
        async (result) => {
          if (thisLoadId !== currentStageLoadId) {
            disposeMesh(result);
            return;
          }
          removeAllStagesFromScene();
          const rawMesh = isFBX ? result : (result.scene || result.scenes?.[0]);
          if (!rawMesh) return;

          const THREE = getRuntimeThree();

          const stageGroup = new THREE.Group();
          stageGroup._xra_path = path;

          let embeddedCamera = null;
          rawMesh.traverse?.((node) => {
            if (!embeddedCamera && node?.isPerspectiveCamera) embeddedCamera = node;
          });
          stageGroup._embeddedCamera = embeddedCamera;

          rawMesh.position.set(0, 0, 0);
          rawMesh.rotation.set(0, 0, 0);
          rawMesh.scale.set(1, 1, 1);
          rawMesh.updateMatrixWorld?.(true);

          const batchResult = await batchStaticStageMeshes(
            rawMesh,
            result?.animations || rawMesh.animations || []
          );
          if (thisLoadId !== currentStageLoadId) {
            disposeMesh(rawMesh);
            return;
          }
          if (batchResult.before > batchResult.after) {
            console.info(TAG, `Static stage batched: ${batchResult.before} meshes -> ${batchResult.after} draw batches`);
          }

          let baseScale = 1.0;
          if (THREE?.Box3) {
            try {
              const bbox = new THREE.Box3().setFromObject(rawMesh);
              if (!bbox.isEmpty()) {
                const size = bbox.getSize(new THREE.Vector3());
                const center = bbox.getCenter(new THREE.Vector3());
                const height = size.y;
                stageGroup._localBounds = bbox.clone();

                // Generic metric unit scaling:
                // XR Animator's VRM avatars use decimeter scale (vrm_scale = 11.0, avatar height ~17.5 units).
                // Standard 3D stages exported from Blender / GLTF in meters (room heights 0.2m - 50m)
                // must be scaled by vrm_scale (11.0) so 1 meter in the stage equals 1 meter on the avatar.
                const vrmScale = Number(window.MMD_SA?.THREEX?.VRM?.vrm_scale || 11.0);
                if (height > 0.1 && height <= 50.0) {
                  baseScale = vrmScale;
                } else if (height > 50.0 && height <= 5000.0) {
                  // Centimeter models (e.g. 250 cm high ceiling)
                  baseScale = vrmScale / 100.0;
                } else {
                  baseScale = 1.0;
                }

                if (config.stage?.auto_center) {
                  rawMesh.position.set(-center.x, -bbox.min.y, -center.z);
                } else {
                  // Ground floor at Y=0, preserve author's original X and Z origin
                  rawMesh.position.set(0, -bbox.min.y, 0);
                }
              }
            } catch (boxErr) {
              console.warn(TAG, 'Stage bounds calculation failed:', boxErr);
            }
          }
          stageGroup._baseScale = baseScale;

          stageGroup._embeddedLights = [];
          rawMesh.traverse((node) => {
            if (node.isLight) {
              if (node.intensity > 15) {
                node._originalIntensity = node.intensity * 0.02;
              } else {
                node._originalIntensity = node.intensity;
              }
              stageGroup._embeddedLights.push(node);
            }
            if (node.isMesh) {
              node.frustumCulled = true;
            }
          });

          stageGroup.add(rawMesh);
          scene.add(stageGroup);
          activeStageMesh = stageGroup;
          updateStageTransform();
          applyStageLights();
          setupTrackballCamera();
          applySceneZoom();
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

  function applyStageLights() {
    if (!activeStageMesh || !activeStageMesh._embeddedLights) return;
    const enabled = config.stage?.lights_enabled !== false;
    const intensity = Number(config.stage?.lights_intensity ?? 1.0);
    for (const light of activeStageMesh._embeddedLights) {
      light.visible = enabled;
      light.intensity = (light._originalIntensity ?? 1.0) * intensity;
    }
  }

  function getAvatarBaseOrigin() {
    const dungeon = window.MMD_SA_options?.Dungeon;
    if (dungeon?.started) {
      const position = dungeon.character?.pos;
      if (
        Number.isFinite(Number(position?.x)) &&
        Number.isFinite(Number(position?.y)) &&
        Number.isFinite(Number(position?.z))
      ) {
        return {
          x: Number(position.x),
          y: Number(position.y),
          z: Number(position.z),
        };
      }
    }
    return { x: 0, y: 0, z: 0 };
  }

  function getAvatarBasePosition() {
    return getAvatarBaseOrigin();
  }

  function applyAvatarPosition() {
    const avatar = getAvatarModel();
    const root = avatar?.mesh || avatar?.scene;
    if (!root || !root.position) return false;

    const baseOrigin = getAvatarBaseOrigin();
    const ox = Number(config.avatar?.offset_x ?? 0.0);
    const oy = Number(config.avatar?.offset_y ?? 0.0);
    const oz = Number(config.avatar?.offset_z ?? 0.0);
    const rotY = (Number(config.avatar?.rotation_y ?? 0.0)) * (Math.PI / 180.0);
    const x = baseOrigin.x + ox;
    const y = baseOrigin.y + oy;
    const z = baseOrigin.z + oz;
    const epsilon = 1e-6;
    const changed =
      Math.abs(root.position.x - x) > epsilon ||
      Math.abs(root.position.y - y) > epsilon ||
      Math.abs(root.position.z - z) > epsilon ||
      Math.abs(root.rotation.y - rotY) > epsilon;

    if (!changed) return true;
    root.position.set(x, y, z);
    root.rotation.y = rotY;
    root.updateMatrix?.();
    root.matrixWorldNeedsUpdate = true;
    return true;
  }

  function updateStageTransform() {
    if (!activeStageMesh) return;
    const stageConf = config.stage || {};

    const offsetX = Number(stageConf.offset_x ?? 0.0);
    const offsetY = Number(stageConf.offset_y ?? 0.0);
    const offsetZ = Number(stageConf.offset_z ?? 0.0);
    const userScale = Number(stageConf.scale ?? 1.0);
    const baseScale = Number(activeStageMesh._baseScale ?? 1.0);
    const finalScale = baseScale * userScale;

    const rotX = Number(stageConf.rotation_x ?? 0.0) * (Math.PI / 180.0);
    const rotY = Number(stageConf.rotation_y ?? 0.0) * (Math.PI / 180.0);
    const rotZ = Number(stageConf.rotation_z ?? 0.0) * (Math.PI / 180.0);

    const basePos = getAvatarBasePosition();
    activeStageMesh.position.set(basePos.x + offsetX, basePos.y + offsetY, basePos.z + offsetZ);
    activeStageMesh.scale.set(finalScale, finalScale, finalScale);
    activeStageMesh.rotation.set(rotX, rotY, rotZ);
    activeStageMesh.updateMatrixWorld?.(true);
  }

  function resetCameraToDefault() {
    const trackball = window.MMD_SA?._trackball_camera;
    if (trackball) {
      trackball.up0?.set?.(0, 1, 0);
      trackball.object?.up?.set?.(0, 1, 0);
      trackball.noZoom = false;
      trackball.minDistance = 5.0;
      trackball.maxDistance = 80.0;
    }
    if (window.MMD_SA?.reset_camera) {
      window.MMD_SA.reset_camera(true);
    }
    setupTrackballCamera();
    applySceneZoom();
    return true;
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
      const propUrl = new URL(glbPath, location.href);
      propUrl.searchParams.set('_t', Date.now());
      const url = propUrl.href;
      loader.load(url, (gltf) => {
        const mesh = gltf.scene || gltf.scenes?.[0];
        if (!mesh) return resolve(null);

        const anc = anchor || DEFAULT_PROP_ANCHORS[propKey] || { pos: [0, 8.05, 3.0], rot: [0, 0, 0], scale: 1 };
        const basePos = getAvatarBasePosition();
        const worldPos = [basePos.x + anc.pos[0], anc.pos[1], basePos.z + anc.pos[2]];
        const scaledScale = anc.scale;

        mesh.position.set(...worldPos);
        mesh.rotation.set(...anc.rot);
        mesh.scale.set(scaledScale, scaledScale, scaledScale);
        mesh.visible = false;

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
          staticPos: [...worldPos],
          staticRot: [...anc.rot],
          staticScale: scaledScale,
          currentHand: null,
          lastSeenTime: 0,
        };
        resolve(activeProps[propKey]);
      }, undefined, (err) => {
        console.warn(TAG, `Failed to load prop ${propKey}:`, err);
        resolve(null);
      });
    });
  }

  function updateHeldProps() {
    try {
      updateHeldProps_inner();
    } catch (e) {
      console.error("Error in updateHeldProps:", e);
    }
  }

  function updateHeldProps_inner() {
    if (!config.object_tracking?.enabled) return;
    const THREE = getRuntimeThree();
    if (!THREE) return;
    for (const [propKey, prop] of Object.entries(activeProps)) {
      if (!prop.currentHand || !prop.mesh) continue;
      const gripTransform = getGripTransform(prop.currentHand);
      if (!gripTransform) continue;

      const wristPos = gripTransform.position;
      const wristQuat = gripTransform.quaternion;

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

    prop.mesh.visible = true;
    updateHeldProps();
  }

  function detachProp(propKey) {
    const prop = activeProps[propKey];
    if (!prop || !prop.mesh) return;

    const changed = !!prop.currentHand || prop.mesh.visible;
    prop.mesh.visible = false;
    prop.currentHand = null;
    prop.lastSeenTime = 0;
    if (changed) events.emit('prop-detached', { prop: propKey });
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
      // Map COCO class to prop key (loads props/<key>.glb)
      const CLASS_TO_PROP = {
        'cell phone': 'cell_phone', 'remote': 'cell_phone',
        'cup': 'cup', 'wine glass': 'cup',
        'bottle': 'bottle',
        'microphone': 'microphone',
        'book': 'book',
        'laptop': 'laptop',
        'scissors': 'scissors',
        'knife': 'knife',
        'fork': 'fork',
        'spoon': 'spoon',
        'apple': 'apple',
        'orange': 'orange',
        'banana': 'banana',
        'donut': 'donut',
        'mouse': 'mouse',
        'toothbrush': 'toothbrush',
        'vase': 'vase',
      };
      let propKey = null;
      for (const [cls, key] of Object.entries(CLASS_TO_PROP)) {
        if (cat.includes(cls)) { propKey = key; break; }
      }

      if (propKey) {
        if (det.hand) {
          detectedMap[propKey] = det.hand;
        }
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
    if (!config.object_tracking?.enabled) return;
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
    if (!config.object_tracking?.enabled) return;
    const propFiles = await listProps();
    for (const file of propFiles) {
      const name = file.replace(/^props\//, '').replace(/\.glb$/i, '');
      if (DEFAULT_PROP_ANCHORS[name] && !activeProps[name]) {
        const prop = await loadProp(name, file);
        if (prop?.mesh) prop.mesh.visible = false;
      }
    }
  }

  // Startup hooks
  window.addEventListener('MMDStarted', () => {
    setTimeout(applyStage, 600);
    setTimeout(setupTrackballCamera, 700);
    setTimeout(applySceneZoom, 800);
    setTimeout(applyAvatarPosition, 900);
    setTimeout(initDefaultProps, 1200);
  });
  window.addEventListener('SA_Dungeon_onstart', () => {
    setTimeout(applyStage, 500);
    setTimeout(applyAvatarPosition, 550);
  });
  window.addEventListener('jThree_ready', () => setTimeout(setupTrackballCamera, 0));
  window.addEventListener('MMDCameraReset', () => setTimeout(setupTrackballCamera, 0));
  window.addEventListener('MMDCameraReset_after', () => setTimeout(() => {
    setupTrackballCamera();
    applySceneZoom();
  }, 0));
  window.addEventListener('SA_camera_poseNet_process_bones_onended', applyAvatarPosition);
  window.addEventListener('SA_MMD_before_render', () => {
    updateHeldProps();
    applyAvatarPosition();
  });
  window.addEventListener('wheel', (e) => {
    if (isUiElement(e.target)) {
      e.stopPropagation();
    }
  }, { capture: true, passive: true });
  window.addEventListener('wheel', handleWheelZoom, { passive: false });
  events.on('profile-loaded', () => {
    applyStage();
    applyAvatarPosition();
    setupTrackballCamera();
    if (config.object_tracking?.enabled) updateGripTransforms();
    else resetAllProps();
  });

  XRA.stage = {
    apply: applyStage,
    updateTransform: updateStageTransform,
    applyStageLights,
    applyAvatarPosition,
    getAvatarBaseOrigin,
    getAvatarBasePosition,
    frameCamera: resetCameraToDefault,
    resetCamera: resetCameraToDefault,
    setupTrackballCamera,
    applySceneZoom,
    applyLinkedSceneZoom: applySceneZoom,
    listCameraViewPresets,
    saveCameraViewPreset,
    applyCameraViewPreset,
    deleteCameraViewPreset,
    updateGripTransforms,
    resetAllProps,
    setObjectTrackingEnabled,
    listStages,
    listProps,
    loadProp,
    attachPropToHand,
    detachProp,
    onObjectDetected,
    activeProps,
    getActiveStageMesh: () => activeStageMesh,
  };
})();
