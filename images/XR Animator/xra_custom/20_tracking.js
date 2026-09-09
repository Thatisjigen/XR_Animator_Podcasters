(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA TRACK]';
  const { config, events, util } = XRA;

  const STARTUP_LOCK_DELAY_MS = 1000;
  let startupLocksPending = true;
  let startupLocksTimer = 0;
  let startupCalibrationPoll = 0;
  let startupCalibrationInProgress = false;
  // Start unlocked even when the saved profile requests hand lock. The saved
  // preference is intentionally left untouched and restored after calibration.
  let handsEnabled = true;
  let bodyStable = false;
  let bodyAnchorMix = 0;
  let bodyTransition = null;
  let controlChannel = null;

  try {
    controlChannel = new BroadcastChannel('XRA_CONTROL');
    controlChannel.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'hands_state_request') broadcastHands();
      if (data.type === 'tracking_state_request') broadcastTrackingState();
      if (data.type === 'face_tracking_state') acceptFaceSignal(data);
      if (data.type === 'pose_tracking_state') acceptPoseSignal(data);
      if (data.type === 'hands_tracking_state') acceptHandsSignal(data);
    };
  }
  catch (e) {
    console.warn(TAG, 'BroadcastChannel unavailable', e);
  }

  function broadcastHands() {
    controlChannel?.postMessage({ type: 'hands_enabled', value: handsEnabled });
    controlChannel?.postMessage({
      type: 'hands_config',
      recovery: String(config.tracking?.hand_recovery_mode || 'normal'),
      sensitivity: String(config.tracking?.hand_detection_sensitivity || 'high')
    });
    broadcastTrackingState();
  }

  function broadcastTrackingState() {
    controlChannel?.postMessage({
      type: 'body_stabilization',
      value: !!(bodyStable || (!startupLocksPending && config.body?.stable)),
      recovery_ms: Math.max(0, Number(config.tracking?.freeze_recovery_ms ?? 350))
    });
    controlChannel?.postMessage({
      type: 'motion_hysteresis',
      value: !!(!startupLocksPending && config.tracking?.motion_hysteresis_enabled)
    });
  }

  function syncSplitHandLandmarker() {
    const pipeline = String(config.performance?.tracking_pipeline || 'SPLIT').toUpperCase();
    if (pipeline !== 'SPLIT') return;
    try {
      const hp = window.MMD_SA?.WebXR?.user_camera?.handpose;
      if (hp) hp.enabled = !!handsEnabled;
    }
    catch (e) {}
  }

  const MMD_ARM_BONES = (() => {
    const out = [
      '左肩', '右肩', '左肩P', '右肩P',
      '左腕', '右腕', '左腕捩', '右腕捩',
      '左ひじ', '右ひじ', '左手捩', '右手捩',
      '左手首', '右手首'
    ];
    const sides = ['左', '右'];
    const fingers = ['親', '人', '中', '薬', '小'];
    for (const side of sides) {
      fingers.forEach((finger, i) => {
        const start = i === 0 ? 0 : 1;
        for (let n = start; n < start + 3; n++) {
          out.push(side + finger + '指' + ['０', '１', '２', '３'][n]);
        }
      });
    }
    return out;
  })();

  const VRM_ARM_BONES = (() => {
    const out = [
      'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'rightUpperArm',
      'leftLowerArm', 'rightLowerArm',
      'leftHand', 'rightHand'
    ];
    const sides = ['left', 'right'];
    const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
    const joints = ['Proximal', 'Intermediate', 'Distal'];
    for (const side of sides) {
      for (const finger of fingers) {
        for (const joint of joints) out.push(side + finger + joint);
      }
      out.push(side + 'ThumbMetacarpal');
    }
    return out;
  })();

  const MMD_BODY_BONES = [
    '全ての親', 'センター', 'グルーブ', '腰', '下半身',
    '上半身', '上半身2', '上半身3',
    '左足', '右足', '左ひざ', '右ひざ',
    '左足首', '右足首'
  ];

  const VRM_BODY_BONES = [
    'hips', 'spine', 'chest', 'upperChest',
    'leftUpperLeg', 'rightUpperLeg',
    'leftLowerLeg', 'rightLowerLeg',
    'leftFoot', 'rightFoot'
  ];
  const MMD_BODY_TRANSLATION_ROOTS = new Set(['全ての親', 'センター', 'グルーブ', '腰', '下半身']);
  const VRM_BODY_TRANSLATION_ROOTS = new Set(['hips']);

  const frozenMMDBones = new Map();
  const frozenVRMBones = new Map();
  const anchoredMMDBones = new Map();
  const anchoredVRMBones = new Map();
  // Full-body mocap normally writes the center/hips bone, but VRM adapters and
  // some motions can transfer that offset to a model/scene root afterwards.
  // Keep those roots in the same captured reference so stabilization really
  // means no world translation on every avatar backend.
  const anchoredAvatarRoots = new Map();
  const guardMMDBones = new Map();
  const guardVRMBones = new Map();
  const guardLastMMD = new Map();
  const guardLastVRM = new Map();
  const guardRawMMD = new Map();
  const guardRawVRM = new Map();
  const guardMotionWindow = [];
  let guardHoldUntil = 0;
  let guardInvalidSince = 0;
  let guardRecoveryFrames = 0;
  let guardLastRejected = 0;
  let guardRelease = null;
  const guardReleaseMMD = new Map();
  const guardReleaseVRM = new Map();
  let guardTransition = null;
  const guardTransitionMMD = new Map();
  const guardTransitionVRM = new Map();
  let guardReacquireTransition = null;
  const guardReacquireMMD = new Map();
  const guardReacquireVRM = new Map();

  const MMD_LEFT_ARM = [
    '左肩', '左肩P', '左腕', '左腕捩', '左ひじ', '左手捩', '左手首',
    '左親指０', '左親指１', '左親指２',
    '左人指１', '左人指２', '左人指３',
    '左中指１', '左中指２', '左中指３',
    '左薬指１', '左薬指２', '左薬指３',
    '左小指１', '左小指２', '左小指３'
  ];
  const MMD_RIGHT_ARM = [
    '右肩', '右肩P', '右腕', '右腕捩', '右ひじ', '右手捩', '右手首',
    '右親指０', '右親指１', '右親指２',
    '右人指１', '右人指２', '右人指３',
    '右中指１', '右中指２', '右中指３',
    '右薬指１', '右薬指２', '右薬指３',
    '右小指１', '右小指２', '右小指３'
  ];
  let leftHandVisible = false;
  let rightHandVisible = false;
  let leftHandLastSeen = 0;
  let rightHandLastSeen = 0;
  const neutralLeftArmMMD = new Map();
  const neutralRightArmMMD = new Map();
  let leftArmTransition = null;
  let rightArmTransition = null;
  const leftArmTransitionFrom = new Map();
  const rightArmTransitionFrom = new Map();

  const MMD_HEAD_BONES = ['首', '頭'];
  const VRM_HEAD_BONES = ['neck', 'head'];
  // When the technical face mesh disappears we freeze the whole tracked pose,
  // not only neck/head. This prevents PoseNet/body hallucinations (for example
  // a finger covering the webcam) from jerking the avatar while lip-sync morphs
  // continue to update independently.
  const MMD_FACE_LOSS_FREEZE_BONES = [...new Set([...MMD_BODY_BONES, ...MMD_ARM_BONES, ...MMD_HEAD_BONES])];
  const VRM_FACE_LOSS_FREEZE_BONES = [...new Set([...VRM_BODY_BONES, ...VRM_ARM_BONES, ...VRM_HEAD_BONES])];
  const faceLossPoseMMD = new Map();
  const faceLossPoseVRM = new Map();
  let headLost = false;
  let headRecoveryStarted = 0;
  let faceLossFreezeStarted = 0;

  // Face tracking is the authoritative signal for head-loss handling when
  // facemesh is enabled. Pose models often hallucinate plausible nose/shoulder
  // landmarks after the real face has left the frame or is covered by a hand.
  const faceSignal = {
    available: false,
    present: false,
    confidence: null,
    source: 'unknown',
    lastUpdateAt: 0,
    lastPresentAt: 0,
    lastAbsentAt: 0,
    signature: ''
  };
  const poseSignal = {
    available: false,
    present: false,
    confidence: null,
    source: 'unknown',
    lastUpdateAt: 0,
    lastPresentAt: 0,
    lastAbsentAt: 0,
    signature: ''
  };
  // XR Animator already exposes the authoritative result consumed by its bone
  // solver. Keep a tiny local latch so a detector/camera stall can be treated
  // as loss after the first real pose, even when the custom worker channel is
  // unavailable (the common case on slower PCs and some cached builds).
  let nativePoseEverDetected = false;
  let faceRuntimeSignature = '';
  let faceRuntimeChangedAt = 0;
  let faceRuntimeEverPresent = false;
  let faceRuntimeLastPresentAt = 0;

  // V7.6.20: Head Freeze follows the same facemesh bitmap used by XR Animator's
  // technical preview whenever that canvas is available. This intentionally
  // avoids confidence/jump heuristics: if the face mesh is not being drawn,
  // the head is held; when it is drawn again, head tracking can resume.
  let technicalMeshSampleAt = 0;
  let technicalMeshSample = { available:false, present:false, source:'none' };
  let technicalMeshScratch = null;
  let technicalMeshCtx = null;
  let technicalMeshCandidatesCache = [];
  let technicalMeshCandidatesAt = 0;

  // Face-loss protection keeps a short history of known-good skeletal poses.
  // When the technical face mesh disappears, the freeze uses a stable pose from
  // just before the loss instead of the last frame, which may already contain a
  // tracking hallucination. Reacquisition requires several valid mesh samples.
  const faceLossPoseHistory = [];
  const faceLossPosePool = [];
  const FACE_LOSS_HISTORY_MS = 500;
  const FACE_LOSS_LOOKBACK_MS = 140;
  const FACE_LOSS_SAMPLE_MS = 45;
  const FACE_LOSS_REACQUIRE_SAMPLES = 4;
  let faceLossState = 'live'; // live | suspect | frozen | recovering
  let faceLossMissingSamples = 0;
  let faceLossPresentSamples = 0;
  let faceLossLastDecisionSampleAt = 0;
  let faceLossLastHistoryAt = 0;
  let faceLossLastEvent = '';

  function technicalFaceMeshCanvases(force = false) {
    const now = performance.now();
    const cachedUsable = technicalMeshCandidatesCache.every(entry => entry?.node && (entry.node.isConnected !== false));
    // V7.6.23: the old implementation walked every canvas in the document on
    // every 40 ms mesh sample. Cache resolved technical-preview canvases for a
    // few seconds; even an empty result is cached briefly so a runtime without
    // a readable facemesh canvas does not scan the whole DOM 25 times/second.
    const cacheMs = technicalMeshCandidatesCache.length ? 3000 : 1000;
    if (!force && technicalMeshCandidatesAt && cachedUsable && now - technicalMeshCandidatesAt < cacheMs) return technicalMeshCandidatesCache;

    const c = window.System?._browser?.camera;
    const uc = window.MMD_SA?.WebXR?.user_camera;
    const display = window.MMD_SA_options?.user_camera?.display;
    const out = [];
    const seen = new Set();
    const add = (node, shared = false) => {
      if (!node || seen.has(node)) return;
      const w = Number(node.width || node.videoWidth || 0);
      const h = Number(node.height || node.videoHeight || 0);
      if (w < 8 || h < 8) return;
      seen.add(node);
      out.push({ node, shared });
    };
    // Best case: the dedicated facemesh canvas, i.e. the exact source that
    // draws the technical face mesh.
    add(c?.facemesh?.canvas, false);
    add(uc?.facemesh?.canvas, false);
    // Some builds expose only the visible wireframe canvas. It can also contain
    // body/hand lines, so the sampler uses a much denser-pixel requirement.
    add(display?.wireframe instanceof HTMLCanvasElement ? display.wireframe : null, true);
    try {
      document.querySelectorAll('canvas').forEach(node => {
        const id = `${node.id || ''} ${node.className || ''} ${node.dataset?.type || ''} ${node.dataset?.name || ''}`.toLowerCase();
        if (/(facemesh|face[_ -]?mesh|face[_ -]?landmark)/.test(id)) add(node, false);
        else if (/(wireframe|mocap.*landmark|landmark.*mocap)/.test(id)) add(node, true);
      });
    } catch (e) {}
    technicalMeshCandidatesCache = out;
    technicalMeshCandidatesAt = now;
    return out;
  }

  function technicalFaceMeshEvidence(force = false) {
    const now = performance.now();
    if (!force && now - technicalMeshSampleAt < 40) return technicalMeshSample;
    technicalMeshSampleAt = now;

    const candidates = technicalFaceMeshCanvases();
    if (!candidates.length) {
      technicalMeshSample = { available:false, present:false, source:'no-face-canvas' };
      return technicalMeshSample;
    }

    if (!technicalMeshScratch) {
      technicalMeshScratch = document.createElement('canvas');
      technicalMeshScratch.width = 96;
      technicalMeshScratch.height = 54;
      technicalMeshCtx = technicalMeshScratch.getContext('2d', { willReadFrequently:true });
    }
    if (!technicalMeshCtx) {
      technicalMeshSample = { available:false, present:false, source:'no-2d-context' };
      return technicalMeshSample;
    }

    let bestReadable = null;
    for (const candidate of candidates) {
      const source = candidate.node;
      const requiredPixels = candidate.shared ? 36 : 6;
      try {
        technicalMeshCtx.clearRect(0, 0, 96, 54);
        technicalMeshCtx.drawImage(source, 0, 0, 96, 54);
        const data = technicalMeshCtx.getImageData(0, 0, 96, 54).data;
        let meshPixels = 0;
        let opaquePixels = 0;
        let coloredPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a > 16) opaquePixels++;
          if (a > 16 && Math.max(r,g,b) >= 35 && Math.max(r,g,b) - Math.min(r,g,b) >= 22) coloredPixels++;
          // XR Animator's technical facemesh uses cyan/teal mesh lines and
          // red landmark markers on a green/transparent background. Sampling
          // both signatures makes this tolerant of theme/renderer variations.
          const cyan = b >= 18 && g >= 38 && b > r + 7;
          const red = r >= 75 && r > g * 1.22 && r > b * 1.22;
          if (cyan || red) {
            meshPixels++;
            if (meshPixels >= requiredPixels) break;
          }
        }
        // A dedicated facemesh canvas is black/opaque even when no face exists,
        // so alpha alone is not evidence. Saturated non-background pixels cover
        // theme variants while shared wireframes retain the stricter signature.
        const present = meshPixels >= requiredPixels || (!candidate.shared && coloredPixels >= 12);
        const sample = {
          available:true,
          present,
          source:'technical-face-mesh',
          meshPixels,
          opaquePixels,
          coloredPixels
        };
        if (present) {
          technicalMeshSample = sample;
          return technicalMeshSample;
        }
        // Do not stop at an empty internal facemesh canvas: the actual visible
        // mesh may live on the following shared wireframe canvas.
        if (!bestReadable || meshPixels > bestReadable.meshPixels || coloredPixels > bestReadable.coloredPixels) {
          bestReadable = sample;
        }
      } catch (e) {
        // Try another face-specific canvas. Some OffscreenCanvas/WebGL paths
        // cannot be sampled after ownership is transferred.
      }
    }

    technicalMeshSample = bestReadable || { available:false, present:false, source:'face-canvas-unreadable' };
    return technicalMeshSample;
  }

  function acceptFaceSignal(data = {}) {
    const now = performance.now();
    faceSignal.available = data.available !== false;
    faceSignal.present = !!data.present;
    const c = data.confidence == null ? NaN : Number(data.confidence);
    faceSignal.confidence = Number.isFinite(c) ? util.clamp(c, 0, 1) : null;
    faceSignal.source = String(data.source || 'worker');
    faceSignal.lastUpdateAt = now;
    if (faceSignal.present) faceSignal.lastPresentAt = now;
    else faceSignal.lastAbsentAt = now;
    if (data.signature != null) faceSignal.signature = String(data.signature);
  }

  function acceptPoseSignal(data = {}) {
    const now = performance.now();
    poseSignal.available = data.available !== false;
    poseSignal.present = !!data.present;
    const confidence = data.confidence == null ? NaN : Number(data.confidence);
    poseSignal.confidence = Number.isFinite(confidence) ? util.clamp(confidence, 0, 1) : null;
    poseSignal.source = String(data.source || 'worker');
    poseSignal.lastUpdateAt = now;
    if (poseSignal.present) poseSignal.lastPresentAt = now;
    else poseSignal.lastAbsentAt = now;
    if (data.signature != null) poseSignal.signature = String(data.signature);
  }

  function cloneTransform(bone) {
    return {
      position: bone.position?.clone?.() || null,
      quaternion: bone.quaternion?.clone?.() || null,
      scale: bone.scale?.clone?.() || null
    };
  }

  function restoreTransform(bone, transform) {
    if (!bone || !transform) return;
    if (transform.position && bone.position) bone.position.copy(transform.position);
    if (transform.quaternion && bone.quaternion) bone.quaternion.copy(transform.quaternion);
    if (transform.scale && bone.scale) bone.scale.copy(transform.scale);
    bone.updateMatrix?.();
    bone.matrixWorldNeedsUpdate = true;
  }

  function blendTransform(bone, target, strength) {
    if (!bone || !target) return;
    const k = util.clamp(strength, 0, 1);
    if (target.position && bone.position) bone.position.lerp(target.position, k);
    if (target.quaternion && bone.quaternion) bone.quaternion.slerp(target.quaternion, k);
    if (target.scale && bone.scale) bone.scale.lerp(target.scale, k);
    bone.updateMatrix?.();
    bone.matrixWorldNeedsUpdate = true;
  }

  function blendInterpolateTransform(bone, from, target, mix) {
    if (!bone || !target) return;
    const k = util.clamp(mix, 0, 1);
    if (from?.position && target.position && bone.position) {
      bone.position.copy(from.position).lerp(target.position, k);
    } else if (target.position && bone.position) {
      bone.position.lerp(target.position, k);
    }
    if (from?.quaternion && target.quaternion && bone.quaternion) {
      bone.quaternion.copy(from.quaternion).slerp(target.quaternion, k);
    } else if (target.quaternion && bone.quaternion) {
      bone.quaternion.slerp(target.quaternion, k);
    }
    if (from?.scale && target.scale && bone.scale) {
      bone.scale.copy(from.scale).lerp(target.scale, k);
    } else if (target.scale && bone.scale) {
      bone.scale.lerp(target.scale, k);
    }
    bone.updateMatrix?.();
    bone.matrixWorldNeedsUpdate = true;
  }

  // Torso Guard is a rotation safety/stability layer, not a body-position
  // anchor. Keeping translation untouched allows a seated user to move
  // left/right/forward/backward while Guard remains enabled.
  function blendRotationOnly(bone, target, strength) {
    if (!bone || !target) return;
    const k = util.clamp(strength, 0, 1);
    if (target.quaternion && bone.quaternion) bone.quaternion.slerp(target.quaternion, k);
    else if (target.rotation && bone.rotation) {
      bone.rotation.x += angleNormalize(target.rotation.x - bone.rotation.x) * k;
      bone.rotation.y += angleNormalize(target.rotation.y - bone.rotation.y) * k;
      bone.rotation.z += angleNormalize(target.rotation.z - bone.rotation.z) * k;
    }
    bone.updateMatrix?.();
    bone.matrixWorldNeedsUpdate = true;
  }

  function blendBodyAnchorTransform(bone, transform, rotationStrength, positionStrength) {
    if (!bone || !transform) return;
    if (transform.position && bone.position) bone.position.lerp(transform.position, util.clamp(positionStrength, 0, 1));
    if (transform.quaternion && bone.quaternion) bone.quaternion.slerp(transform.quaternion, util.clamp(rotationStrength, 0, 1));
    if (transform.scale && bone.scale) bone.scale.lerp(transform.scale, util.clamp(rotationStrength, 0, 1));
    bone.updateMatrix?.();
    bone.matrixWorldNeedsUpdate = true;
  }

  function getMMDMesh() {
    try {
      return MMD_SA?.THREEX?._THREE?.MMD?.getModels?.()?.[0]?.mesh
        || window.THREE?.MMD?.getModels?.()?.[0]?.mesh
        || null;
    }
    catch (e) { return null; }
  }

  function getVRMModelX() {
    const threex = window.MMD_SA?.THREEX;
    try { return threex?.get_model?.(0) || threex?.models?.[0] || null; }
    catch (e) { return threex?.models?.[0] || null; }
  }

  function avatarRootNodes() {
    const roots = [];
    const seen = new Set();
    const add = node => {
      if (!node?.position || seen.has(node)) return;
      seen.add(node);
      roots.push(node);
    };
    const mesh = getMMDMesh();
    if (mesh) add(mesh);
    const modelX = getVRMModelX();
    const topNode = modelX?.scene || modelX?.model || modelX?.mesh;
    if (topNode && topNode !== mesh) add(topNode);
    return roots;
  }

  function captureAvatarRoots() {
    anchoredAvatarRoots.clear();
    for (const root of avatarRootNodes()) anchoredAvatarRoots.set(root, cloneTransform(root));
  }

  function blendAvatarRootPositions(strength) {
    const k = util.clamp(strength, 0, 1);
    for (const [root, transform] of anchoredAvatarRoots) {
      if (!root?.position || !transform?.position) continue;
      root.position.lerp(transform.position, k);
      root.updateMatrix?.();
      root.matrixWorldNeedsUpdate = true;
    }
  }

  function captureBones(names, mmdMap, vrmNames, vrmMap) {
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const name of names) {
        const bone = bones[name];
        if (!bone) {
          mmdMap.delete(name);
          continue;
        }
        const previous = mmdMap.get(name);
        if (previous) copyTransformInto(previous, bone);
        else mmdMap.set(name, cloneTransform(bone));
      }
    }
    else mmdMap.clear();

    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const name of vrmNames) {
        try {
          const bone = modelX.getBoneNode(name);
          if (!bone) {
            vrmMap.delete(name);
            continue;
          }
          const previous = vrmMap.get(name);
          if (previous) copyTransformInto(previous, bone);
          else vrmMap.set(name, cloneTransform(bone));
        }
        catch (e) {}
      }
    }
    else vrmMap.clear();
  }

  function captureFrozenArms() {
    captureBones(MMD_ARM_BONES, frozenMMDBones, VRM_ARM_BONES, frozenVRMBones);
  }

  function hardLockArms() {
    if (handsEnabled) return;
    if (!frozenMMDBones.size && !frozenVRMBones.size) captureFrozenArms();

    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const [name, transform] of frozenMMDBones) restoreTransform(bones[name], transform);
    }

    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const [name, transform] of frozenVRMBones) {
        try { restoreTransform(modelX.getBoneNode(name), transform); }
        catch (e) {}
      }
    }
  }

  function setHands(enabled, save = true) {
    handsEnabled = !!enabled;
    config.tracking ||= {};
    config.tracking.hands_enabled = handsEnabled;

    if (handsEnabled) {
      frozenMMDBones.clear();
      frozenVRMBones.clear();
    }
    else {
      captureFrozenArms();
      hardLockArms();
    }

    broadcastHands();
    syncSplitHandLandmarker();
    events.emit('hands', handsEnabled);
    if (save) XRA.profileService.save();
    return handsEnabled;
  }

  let poseSuspensionActive = false;
  let poseSuspensionTimer = null;

  function suspendForPoseChange() {
    if (!bodyStable) return;
    poseSuspensionActive = true;
    XRA.debug?.record('tracking.pose-suspension.started', { body_stable:bodyStable });
    if (poseSuspensionTimer) clearTimeout(poseSuspensionTimer);
    poseSuspensionTimer = setTimeout(() => {
      resumeAfterPoseChange();
    }, 2500);
  }

  function resumeAfterPoseChange() {
    if (poseSuspensionTimer) {
      clearTimeout(poseSuspensionTimer);
      poseSuspensionTimer = null;
    }
    if (!poseSuspensionActive && !bodyStable) return;
    setTimeout(() => {
      if (bodyStable) {
        captureBodyPose();
        startBodyTransition(1);
      }
      poseSuspensionActive = false;
      XRA.debug?.record('tracking.pose-suspension.ended', {
        body_stable:bodyStable,
        anchor_mix:bodyAnchorMix
      });
    }, 150);
  }

  function sanitizeUprightQuaternion(q) {
    if (!q) return;
    const x = Number(q.x || 0), y = Number(q.y || 0), z = Number(q.z || 0), w = Number(q.w ?? 1);
    const vy = 1 - 2 * (x * x + z * z);
    if (vy < 0.82) {
      const yaw = 2 * Math.atan2(y, w);
      const halfYaw = yaw / 2;
      q.x = 0;
      q.y = Math.sin(halfYaw);
      q.z = 0;
      q.w = Math.cos(halfYaw);
    }
  }

  function captureBodyPose() {
    lastAnchorTracePosition = null;
    captureBones(MMD_BODY_BONES, anchoredMMDBones, VRM_BODY_BONES, anchoredVRMBones);
    for (const name of ['腰', '下半身', '上半身', '上半身2']) {
      const t = anchoredMMDBones.get(name);
      if (t?.quaternion) sanitizeUprightQuaternion(t.quaternion);
    }
    for (const name of ['hips', 'spine', 'chest']) {
      const t = anchoredVRMBones.get(name);
      if (t?.quaternion) sanitizeUprightQuaternion(t.quaternion);
    }
    captureAvatarRoots();
    events.emit('body-captured', {
      mmd: anchoredMMDBones.size,
      vrm: anchoredVRMBones.size,
      roots: anchoredAvatarRoots.size
    });
    return anchoredMMDBones.size + anchoredVRMBones.size + anchoredAvatarRoots.size;
  }

  function smoothStep01(t) {
    t = util.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function startBodyTransition(targetMix) {
    bodyTransition = {
      from: bodyAnchorMix,
      to: util.clamp(targetMix, 0, 1),
      start: performance.now(),
      duration: Math.max(80, Number(config.body?.transition_ms ?? 450))
    };
    events.emit('body-transition', bodyTransition);
  }

  function updateBodyTransition(now = performance.now()) {
    if (!bodyTransition) return;
    const t = util.clamp((now - bodyTransition.start) / bodyTransition.duration, 0, 1);
    const eased = smoothStep01(t);
    bodyAnchorMix = bodyTransition.from + (bodyTransition.to - bodyTransition.from) * eased;

    if (t >= 1) {
      bodyAnchorMix = bodyTransition.to;
      const endedAt = bodyTransition.to;
      bodyTransition = null;
      if (endedAt <= 0.0001 && !bodyStable) {
        anchoredMMDBones.clear();
        anchoredVRMBones.clear();
        anchoredAvatarRoots.clear();
      }
      events.emit('body-transition-end', bodyAnchorMix);
    }
  }

  function tracePosition(node) {
    const p = node?.position;
    if (!p) return null;
    return ['x', 'y', 'z'].map(axis => Math.round(Number(p[axis] || 0) * 100000) / 100000);
  }

  function bodyAnchorTrace() {
    const mmd = {};
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const name of MMD_BODY_TRANSLATION_ROOTS) {
        const position = tracePosition(bones[name]);
        if (position) mmd[name] = position;
      }
    }
    const modelX = getVRMModelX();
    let vrmHips = null;
    try { vrmHips = tracePosition(modelX?.getBoneNode?.('hips')); }
    catch (e) {}
    return {
      mmd,
      vrm_hips:vrmHips,
      avatar_roots:avatarRootNodes().map(tracePosition).filter(Boolean)
    };
  }

  let lastAnchorTracePosition = null;

  function applyBodyAnchor(stage = 'runtime') {
    if (poseSuspensionActive) return;
    updateBodyTransition();
    if (bodyAnchorMix <= 0.0001) return;
    if (!anchoredMMDBones.size && !anchoredVRMBones.size && !anchoredAvatarRoots.size) captureBodyPose();

    // One coefficient owns both rotation and translation. In particular, 100%
    // becomes an exact copy of the captured roots after the short ON transition.
    const selectedStrength = util.clamp(Number(config.body?.anchor_strength ?? 0.80), 0, 1);
    const strength = selectedStrength * bodyAnchorMix;
    const translationStrength = strength;
    const shouldTrace = !!XRA.debug?.enabled && stage === 'before-render';
    const before = shouldTrace ? bodyAnchorTrace() : null;

    blendAvatarRootPositions(translationStrength);
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const [name, transform] of anchoredMMDBones) {
        blendBodyAnchorTransform(
          bones[name], transform, strength,
          MMD_BODY_TRANSLATION_ROOTS.has(name) ? translationStrength : 0
        );
      }
    }

    // XR Animator's VRM path uses a dummy MMD skeleton and a VRM humanoid at the
    // same time. Apply both snapshots: treating them as alternatives left the
    // final VRM hips free to translate even while the MMD center was anchored.
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const [name, transform] of anchoredVRMBones) {
        try {
          blendBodyAnchorTransform(
            modelX.getBoneNode(name), transform, strength,
            VRM_BODY_TRANSLATION_ROOTS.has(name) ? translationStrength : 0
          );
        }
        catch (e) {}
      }
    }

    if (shouldTrace) {
      const after = bodyAnchorTrace();
      const primary = after.vrm_hips || after.mmd['センター'] || after.avatar_roots[0] || null;
      const frameDelta = primary && lastAnchorTracePosition
        ? Math.hypot(...primary.map((value, index) => value - lastAnchorTracePosition[index]))
        : null;
      XRA.debug.record('anchor.frame', {
        stage,
        selected_strength:selectedStrength,
        effective_strength:strength,
        transition_mix:bodyAnchorMix,
        before,
        after,
        final_frame_delta:frameDelta
      });
      lastAnchorTracePosition = primary ? primary.slice() : null;
    }
  }

  function setBodyStable(enabled, recapture = true) {
    enabled = !!enabled;
    config.body ||= {};
    config.body.stable = enabled;

    if (enabled) {
      if (recapture || (!anchoredMMDBones.size && !anchoredVRMBones.size && !anchoredAvatarRoots.size)) captureBodyPose();
      bodyStable = true;
      startBodyTransition(1);
    }
    else {
      bodyStable = false;
      lastAnchorTracePosition = null;
      startBodyTransition(0);
    }

    broadcastTrackingState();
    events.emit('body-stable', bodyStable);
    XRA.profileService.save();
    return bodyStable;
  }

  function setBodyStabilization(enabled, recapture = true) {
    enabled = !!enabled;
    config.body ||= {};
    config.tracking ||= {};

    // Body stabilization owns only the captured body/root anchor. Abrupt-motion
    // rejection is intentionally controlled by the separate hysteresis toggle.
    if (!enabled && !config.tracking.freeze_head_on_face_loss) {
      resetFaceLossState(true);
      faceLossPoseMMD.clear();
      faceLossPoseVRM.clear();
    }
    return setBodyStable(enabled, enabled ? recapture : false);
  }

  function captureNeutralArms() {
    const bones = getMMDMesh()?.bones_by_name;
    if (!bones) return;
    for (const name of MMD_LEFT_ARM) {
      if (bones[name]) neutralLeftArmMMD.set(name, cloneTransform(bones[name]));
    }
    for (const name of MMD_RIGHT_ARM) {
      if (bones[name]) neutralRightArmMMD.set(name, cloneTransform(bones[name]));
    }
  }

  function onHandStatusChange(side, isEntering) {
    const bones = getMMDMesh()?.bones_by_name;
    if (!bones) return;
    const now = performance.now();
    const armList = side === 'Left' ? MMD_LEFT_ARM : MMD_RIGHT_ARM;
    const transFrom = side === 'Left' ? leftArmTransitionFrom : rightArmTransitionFrom;

    transFrom.clear();
    for (const name of armList) {
      const bone = bones[name];
      if (bone) transFrom.set(name, cloneTransform(bone));
    }

    const duration = 280;
    const transObj = { start: now, duration, type: isEntering ? 'enter' : 'exit' };
    if (side === 'Left') leftArmTransition = transObj;
    else rightArmTransition = transObj;
  }

  function acceptHandsSignal(data) {
    const now = performance.now();
    if (data.left != null) {
      if (data.left) {
        leftHandLastSeen = now;
        if (!leftHandVisible) {
          leftHandVisible = true;
          onHandStatusChange('Left', true);
        }
      } else if (leftHandVisible && (now - leftHandLastSeen > 200)) {
        leftHandVisible = false;
        onHandStatusChange('Left', false);
      }
    }

    if (data.right != null) {
      if (data.right) {
        rightHandLastSeen = now;
        if (!rightHandVisible) {
          rightHandVisible = true;
          onHandStatusChange('Right', true);
        }
      } else if (rightHandVisible && (now - rightHandLastSeen > 200)) {
        rightHandVisible = false;
        onHandStatusChange('Right', false);
      }
    }
  }

  function checkHandRuntimeEvidence(now) {
    try {
      const hp = window.System?._browser?.camera?.handpose || window.MMD_SA?.WebXR?.user_camera?.handpose;
      if (hp && Array.isArray(hp.last_results || hp.data)) {
        const list = hp.last_results || hp.data;
        const hasLeft = list.some(h => (h.label || h.categoryName) === 'Left');
        const hasRight = list.some(h => (h.label || h.categoryName) === 'Right');
        acceptHandsSignal({ left: hasLeft, right: hasRight });
      }
    } catch (e) {}
  }

  function applyHandTransitions() {
    if (!handsEnabled) return;
    const now = performance.now();
    const bones = getMMDMesh()?.bones_by_name;
    if (!bones) return;

    if (!neutralLeftArmMMD.size) captureNeutralArms();

    checkHandRuntimeEvidence(now);

    if (leftHandVisible && (now - leftHandLastSeen > 300)) {
      leftHandVisible = false;
      onHandStatusChange('Left', false);
    }
    if (rightHandVisible && (now - rightHandLastSeen > 300)) {
      rightHandVisible = false;
      onHandStatusChange('Right', false);
    }

    if (leftArmTransition) {
      const t = util.clamp((now - leftArmTransition.start) / leftArmTransition.duration, 0, 1);
      const k = smoothStep01(t);
      if (leftArmTransition.type === 'enter') {
        const blendMix = 1 - k;
        if (t >= 1) {
          leftArmTransition = null;
        } else {
          for (const [name, transform] of leftArmTransitionFrom) {
            const bone = bones[name];
            if (bone) blendTransform(bone, transform, blendMix);
          }
        }
      } else {
        const targetMap = neutralLeftArmMMD;
        if (t >= 1) {
          leftArmTransition = null;
        } else {
          for (const name of MMD_LEFT_ARM) {
            const bone = bones[name];
            const from = leftArmTransitionFrom.get(name);
            const to = targetMap.get(name);
            if (bone && from && to) blendInterpolateTransform(bone, from, to, k);
          }
        }
      }
    }

    if (rightArmTransition) {
      const t = util.clamp((now - rightArmTransition.start) / rightArmTransition.duration, 0, 1);
      const k = smoothStep01(t);
      if (rightArmTransition.type === 'enter') {
        const blendMix = 1 - k;
        if (t >= 1) {
          rightArmTransition = null;
        } else {
          for (const [name, transform] of rightArmTransitionFrom) {
            const bone = bones[name];
            if (bone) blendTransform(bone, transform, blendMix);
          }
        }
      } else {
        const targetMap = neutralRightArmMMD;
        if (t >= 1) {
          rightArmTransition = null;
        } else {
          for (const name of MMD_RIGHT_ARM) {
            const bone = bones[name];
            const from = rightArmTransitionFrom.get(name);
            const to = targetMap.get(name);
            if (bone && from && to) blendInterpolateTransform(bone, from, to, k);
          }
        }
      }
    }
  }

  function applyPoseLocks(stage = 'runtime') {
    // Do not deduplicate these two lifecycle hooks. XR Animator can update bones
    // again between pose-processing completion and the final render pass.
    // Applying the locks at both points is what made BODY STABLE reliably hold
    // torso/hips/legs in the known-good stable build.
    applyUpperBodyGuard();
    applyBodyAnchor(stage);
    hardLockArms();
    applyHandTransitions();
  }

  function quaternionAngleDeg(a, b) {
    if (!a || !b) return 0;
    const dot = Math.min(1, Math.max(-1,
      Number(a.x || 0) * Number(b.x || 0) +
      Number(a.y || 0) * Number(b.y || 0) +
      Number(a.z || 0) * Number(b.z || 0) +
      Number(a.w ?? 1) * Number(b.w ?? 1)
    ));
    return 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
  }

  // Motion Hysteresis stabilizes the core torso/head and rejects abrupt body jumps.
  // Arms and hands are intentionally excluded so users can move their hands freely
  // and have them exit/enter the camera without triggering whole-body freezes.
  const MMD_GUARD_BONES = [...new Set([...MMD_BODY_BONES, ...MMD_HEAD_BONES])];
  const VRM_GUARD_BONES = [...new Set([...VRM_BODY_BONES, ...VRM_HEAD_BONES])];
  const MMD_GUARD_CHECK = ['下半身', '上半身', '上半身2', '上半身3'];
  const VRM_GUARD_CHECK = ['hips', 'spine', 'chest', 'upperChest'];
  const MMD_GUARD_CHECK_SET = new Set(MMD_GUARD_CHECK);
  const VRM_GUARD_CHECK_SET = new Set(VRM_GUARD_CHECK);
  const MMD_GUARD_JUMP_CHECK = [...MMD_GUARD_CHECK, '首', '頭', '左肩', '右肩'];
  const VRM_GUARD_JUMP_CHECK = [...VRM_GUARD_CHECK, 'neck', 'head', 'leftShoulder', 'rightShoulder'];
  const MMD_DESK_TORSO = new Set(['上半身', '上半身2', '上半身3']);
  const MMD_DESK_HIPS = new Set(['センター', 'グルーブ', '腰', '下半身']);
  const MMD_DESK_LEGS = new Set(['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首']);
  const VRM_DESK_TORSO = new Set(['spine', 'chest', 'upperChest']);
  const VRM_DESK_HIPS = new Set(['hips']);
  const VRM_DESK_LEGS = new Set(['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']);
  let guardConfidence = 1;
  let guardMeasuredConfidence = null;
  let guardLastJump = 0;

  function angleNormalize(value) {
    value = Number(value || 0);
    while (value > Math.PI) value -= Math.PI * 2;
    while (value < -Math.PI) value += Math.PI * 2;
    return value;
  }

  function copyTransformInto(target, bone) {
    if (!target || !bone) return;
    if (target.position && bone.position) target.position.copy(bone.position);
    if (target.quaternion && bone.quaternion) target.quaternion.copy(bone.quaternion);
    if (target.scale && bone.scale) target.scale.copy(bone.scale);
    if (target.rotation && bone.rotation) {
      target.rotation.x = Number(bone.rotation.x || 0);
      target.rotation.y = Number(bone.rotation.y || 0);
      target.rotation.z = Number(bone.rotation.z || 0);
    }
  }

  function makeGuardTransform(bone) {
    const out = cloneTransform(bone);
    if (bone?.rotation) out.rotation = {
      x: Number(bone.rotation.x || 0),
      y: Number(bone.rotation.y || 0),
      z: Number(bone.rotation.z || 0)
    };
    return out;
  }

  function captureGuardPose() {
    guardMMDBones.clear(); guardVRMBones.clear();
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const name of MMD_GUARD_BONES) {
        const bone = bones[name];
        if (bone) guardMMDBones.set(name, makeGuardTransform(bone));
      }
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const name of VRM_GUARD_BONES) {
        try {
          const bone = modelX.getBoneNode(name);
          if (bone) guardVRMBones.set(name, makeGuardTransform(bone));
        } catch (e) {}
      }
    }
    guardLastMMD.clear(); guardLastVRM.clear();
    snapshotGuardLast();
    guardRawMMD.clear(); guardRawVRM.clear();
    if (bones) snapshotMap(MMD_GUARD_BONES, name => bones[name], guardRawMMD);
    if (modelX?.getBoneNode) snapshotMap(VRM_GUARD_BONES, name => modelX.getBoneNode(name), guardRawVRM);
    guardMotionWindow.length = 0;
    guardInvalidSince = 0; guardHoldUntil = 0; guardRecoveryFrames = 0; guardLastRejected = 0; guardLastJump = 0;
    events.emit('upper-body-guard-captured', { mmd: guardMMDBones.size, vrm: guardVRMBones.size });
    return guardMMDBones.size + guardVRMBones.size;
  }

  function captureGuardTransitionPose(check) {
    guardTransitionMMD.clear();
    guardTransitionVRM.clear();
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const name of MMD_GUARD_BONES) {
        const bone = bones[name];
        if (!bone) continue;
        const prev = guardLastMMD.get(name);
        const raw = guardRawMMD.get(name);
        const source = raw || prev;
        if (source) {
          const t = cloneTransform(source);
          if (bone.quaternion && source.quaternion) {
            const angle = quaternionAngleDeg(bone.quaternion, source.quaternion);
            if (angle > 0.1 && angle < 45) {
              const maxAngle = Math.min(angle, 12);
              t.quaternion.copy(source.quaternion).slerp(bone.quaternion, maxAngle / angle);
            }
          }
          guardTransitionMMD.set(name, t);
        } else {
          guardTransitionMMD.set(name, makeGuardTransform(bone));
        }
      }
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const name of VRM_GUARD_BONES) {
        try {
          const bone = modelX.getBoneNode(name);
          if (!bone) continue;
          const prev = guardLastVRM.get(name);
          const raw = guardRawVRM.get(name);
          const source = raw || prev;
          if (source) {
            const t = cloneTransform(source);
            if (bone.quaternion && source.quaternion) {
              const angle = quaternionAngleDeg(bone.quaternion, source.quaternion);
              if (angle > 0.1 && angle < 45) {
                const maxAngle = Math.min(angle, 12);
                t.quaternion.copy(source.quaternion).slerp(bone.quaternion, maxAngle / angle);
              }
            }
            guardTransitionVRM.set(name, t);
          } else {
            guardTransitionVRM.set(name, makeGuardTransform(bone));
          }
        } catch (e) {}
      }
    }
  }

  function poseConfidenceFromRuntime() {
    // Different XR Animator pipelines expose the latest pose in different places.
    // Keep this deliberately shallow and allocation-free; when unavailable the
    // guard falls back to its rotation plausibility score.
    const now = performance.now();
    if (poseSignal.available && now - poseSignal.lastUpdateAt < 700 && poseSignal.confidence != null) {
      return poseSignal.confidence;
    }
    const pn = window.System?._browser?.camera?.poseNet;
    const candidates = [
      pn?.pose, pn?._pose, pn?.last_pose, pn?.pose_data, pn?.result?.posenet,
      pn?._result?.posenet, window.MMD_SA?.WebXR?.user_camera?.pose
    ];
    for (const candidate of candidates) {
      const pose = Array.isArray(candidate) ? candidate[0] : candidate;
      const points = pose?.keypoints || pose?.poseLandmarks || pose?.landmarks;
      if (!Array.isArray(points) || !points.length) continue;
      let total = 0, count = 0;
      // MediaPipe: shoulders 11/12, hips 23/24. TFJS names are handled too.
      for (let i = 0; i < points.length; i++) {
        const point = points[i] || {};
        const name = String(point.name || point.part || '').toLowerCase();
        if (![11, 12, 23, 24].includes(i) && !/(shoulder|hip)/.test(name)) continue;
        const value = Number(point.visibility ?? point.score ?? point.presence);
        if (Number.isFinite(value)) { total += util.clamp(value, 0, 1); count++; }
      }
      if (count) return total / count;
    }
    return null;
  }

  function guardLooksInvalid() {
    const jumpLimit = Math.max(10, Number(config.tracking?.guard_jump_deg ?? 42));
    let maxJump = 0;
    let maxLimbJump = 0;
    let rawMaxJump = 0;
    let rawMaxLimbJump = 0;
    let neutralJump = 0;
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) {
      for (const name of MMD_GUARD_JUMP_CHECK) {
        const bone = bones[name], prev = guardLastMMD.get(name), neutral = guardMMDBones.get(name);
        if (bone?.quaternion && prev?.quaternion) {
          const jump = quaternionAngleDeg(bone.quaternion, prev.quaternion);
          if (MMD_GUARD_CHECK_SET.has(name)) maxJump = Math.max(maxJump, jump);
          else maxLimbJump = Math.max(maxLimbJump, jump);
        }
        const rawPrev = guardRawMMD.get(name);
        if (bone?.quaternion && rawPrev?.quaternion) {
          const jump = quaternionAngleDeg(bone.quaternion, rawPrev.quaternion);
          if (MMD_GUARD_CHECK_SET.has(name)) rawMaxJump = Math.max(rawMaxJump, jump);
          else rawMaxLimbJump = Math.max(rawMaxLimbJump, jump);
        }
        if (MMD_GUARD_CHECK_SET.has(name) && bone?.quaternion && neutral?.quaternion) {
          neutralJump = Math.max(neutralJump, quaternionAngleDeg(bone.quaternion, neutral.quaternion));
        }
      }
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) {
      for (const name of VRM_GUARD_JUMP_CHECK) {
        try {
          const bone = modelX.getBoneNode(name), prev = guardLastVRM.get(name), neutral = guardVRMBones.get(name);
          if (bone?.quaternion && prev?.quaternion) {
            const jump = quaternionAngleDeg(bone.quaternion, prev.quaternion);
            if (VRM_GUARD_CHECK_SET.has(name)) maxJump = Math.max(maxJump, jump);
            else maxLimbJump = Math.max(maxLimbJump, jump);
          }
          const rawPrev = guardRawVRM.get(name);
          if (bone?.quaternion && rawPrev?.quaternion) {
            const jump = quaternionAngleDeg(bone.quaternion, rawPrev.quaternion);
            if (VRM_GUARD_CHECK_SET.has(name)) rawMaxJump = Math.max(rawMaxJump, jump);
            else rawMaxLimbJump = Math.max(rawMaxLimbJump, jump);
          }
          if (VRM_GUARD_CHECK_SET.has(name) && bone?.quaternion && neutral?.quaternion) {
            neutralJump = Math.max(neutralJump, quaternionAngleDeg(bone.quaternion, neutral.quaternion));
          }
        } catch (e) {}
      }
    }
    const measured = poseConfidenceFromRuntime();
    const motionConfidence = util.clamp(1 - maxJump / Math.max(1, jumpLimit * 1.65), 0, 1);
    guardMeasuredConfidence = Number.isFinite(measured) ? measured : null;
    guardConfidence = guardMeasuredConfidence == null ? motionConfidence : Math.min(guardMeasuredConfidence, Math.max(.15, motionConfidence));
    guardLastJump = Math.max(maxJump, maxLimbJump);
    const minConfidence = util.clamp(config.tracking?.guard_confidence_min ?? .35, .05, .95);
    // During recovery the full-pose loss guard is already blending from the
    // frozen pose. Comparing the returning live pose against that old pose here
    // would reject it forever and prevent a clean re-acquisition.
    const lossGuardRecovering = faceLossState === 'recovering';
    const rawJump = Math.max(rawMaxJump, rawMaxLimbJump);
    const lowConfidence = guardMeasuredConfidence != null && guardMeasuredConfidence < minConfidence;
    // Preserve the raw live pose before a possible last-good overwrite below.
    if (bones) snapshotMap(MMD_GUARD_BONES, name => bones[name], guardRawMMD);
    if (modelX?.getBoneNode) snapshotMap(VRM_GUARD_BONES, name => modelX.getBoneNode(name), guardRawVRM);
    return {
      // Tracking loss is handled by applyHeadLossGuard. This independent guard
      // rejects only abrupt/low-confidence motion, so turning on hysteresis does
      // not implicitly turn on the face-loss protection.
      invalid: !lossGuardRecovering && (
        rawMaxJump > jumpLimit * .55 || rawMaxLimbJump > jumpLimit || lowConfidence
      ),
      maxJump: Math.max(maxJump, maxLimbJump),
      rawJump,
      jumpLimit,
      lowConfidence: !lossGuardRecovering && lowConfidence,
      neutralJump,
      confidence: guardConfidence
    };
  }

  function guardRapidSequence(check, now) {
    guardMotionWindow.push({
      at: now,
      suspicious: !!check.invalid,
      lowConfidence: !!check.lowConfidence,
      jump: Number(check.rawJump || 0)
    });
    while (guardMotionWindow.length && now - guardMotionWindow[0].at > 240) guardMotionWindow.shift();
    if (guardMotionWindow.length < 3) return false;
    const suspicious = guardMotionWindow.filter(sample => sample.suspicious).length;
    const lowConfidence = guardMotionWindow.filter(sample => sample.lowConfidence).length;
    const angularPath = guardMotionWindow.reduce((sum, sample) => sum + sample.jump, 0);
    return lowConfidence >= 2 || (suspicious >= 2 && angularPath >= check.jumpLimit * 1.15);
  }

  function snapshotMap(names, getter, map) {
    for (const name of names) {
      let bone = null;
      try { bone = getter(name); } catch (e) {}
      if (!bone) continue;
      const previous = map.get(name);
      if (previous) copyTransformInto(previous, bone);
      else map.set(name, makeGuardTransform(bone));
    }
  }

  function snapshotGuardLast() {
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) snapshotMap(MMD_GUARD_BONES, name => bones[name], guardLastMMD);
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) snapshotMap(VRM_GUARD_BONES, name => modelX.getBoneNode(name), guardLastVRM);
  }

  function adaptiveSmoothCurrent(previousMMD, previousVRM, check) {
    if (!config.tracking?.adaptive_smoothing) return;
    const amount = util.clamp(config.tracking?.adaptive_smoothing_strength ?? .45, 0, 1);
    if (amount <= 0) return;
    const jumpLimit = Math.max(10, Number(config.tracking?.guard_jump_deg ?? 42));
    const stillness = util.clamp(1 - Number(check.maxJump || 0) / jumpLimit, 0, 1);
    const confidenceBoost = util.clamp(1 - Number(check.confidence ?? 1), 0, 1) * .35;
    const k = util.clamp(amount * (0.08 + 0.42 * stillness + confidenceBoost), 0, .65);
    if (k <= .01) return;

    // Smooth only torso rotations. Blending hips/leg positions here made LIVE
    // feel partially anchored under the pelvis during lateral chair movement.
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) for (const name of MMD_GUARD_CHECK) {
      const transform = previousMMD.get(name);
      if (transform) blendRotationOnly(bones[name], transform, k);
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) for (const name of VRM_GUARD_CHECK) {
      const transform = previousVRM.get(name);
      if (!transform) continue;
      try { blendRotationOnly(modelX.getBoneNode(name), transform, k); } catch (e) {}
    }
  }

  function clampDeskRotation(bone, neutral) {
    if (!bone?.rotation || !neutral?.rotation) return;
    const maxPitch = Math.max(0, Number(config.tracking?.desk_max_pitch_deg ?? 15)) * Math.PI / 180;
    const maxYaw = Math.max(0, Number(config.tracking?.desk_max_yaw_deg ?? 25)) * Math.PI / 180;
    const maxRoll = Math.max(0, Number(config.tracking?.desk_max_roll_deg ?? 12)) * Math.PI / 180;
    const dx = angleNormalize(bone.rotation.x - neutral.rotation.x);
    const dy = angleNormalize(bone.rotation.y - neutral.rotation.y);
    const dz = angleNormalize(bone.rotation.z - neutral.rotation.z);
    bone.rotation.x = neutral.rotation.x + util.clamp(dx, -maxPitch, maxPitch);
    bone.rotation.y = neutral.rotation.y + util.clamp(dy, -maxYaw, maxYaw);
    bone.rotation.z = neutral.rotation.z + util.clamp(dz, -maxRoll, maxRoll);
  }

  function applyDeskLocks(mix = 1) {
    mix = util.clamp(mix, 0, 1);
    const torso = util.clamp(config.tracking?.desk_torso_lock ?? .55, 0, 1) * mix;
    const hips = util.clamp(config.tracking?.desk_hips_lock ?? .92, 0, 1) * mix;
    const legs = util.clamp(config.tracking?.desk_legs_lock ?? 1, 0, 1) * mix;
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) for (const [name, neutral] of guardMMDBones) {
      const bone = bones[name]; if (!bone) continue;
      if (MMD_DESK_TORSO.has(name)) { clampDeskRotation(bone, neutral); blendTransform(bone, neutral, torso); }
      else if (MMD_DESK_HIPS.has(name)) blendTransform(bone, neutral, hips);
      else if (MMD_DESK_LEGS.has(name)) blendTransform(bone, neutral, legs);
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) for (const [name, neutral] of guardVRMBones) {
      try {
        const bone = modelX.getBoneNode(name); if (!bone) continue;
        if (VRM_DESK_TORSO.has(name)) { clampDeskRotation(bone, neutral); blendTransform(bone, neutral, torso); }
        else if (VRM_DESK_HIPS.has(name)) blendTransform(bone, neutral, hips);
        else if (VRM_DESK_LEGS.has(name)) blendTransform(bone, neutral, legs);
      } catch (e) {}
    }
  }

  function guardMode() {
    if (startupLocksPending) return 'off';
    const mode = String(config.tracking?.guard_mode || '').toLowerCase();
    if (mode === 'guard' || mode === 'desk') return mode;
    return config.tracking?.upper_body_guard ? 'guard' : 'off';
  }

  function applyUpperBodyGuard() {
    let mode = guardMode();
    const now = performance.now();
    let releaseMix = 1;
    let releasing = false;
    if (mode === 'off') {
      if (!guardRelease) return;
      const duration = Math.max(80, Number(guardRelease.duration || config.tracking?.guard_release_ms || 450));
      const t = util.clamp((now - guardRelease.start) / duration, 0, 1);
      releaseMix = 1 - smoothStep01(t);
      mode = guardRelease.mode;
      releasing = true;
      if (t >= 1 || releaseMix <= 0.0001) {
        guardRelease = null;
        guardReleaseMMD.clear(); guardReleaseVRM.clear();
        clearGuardState();
        events.emit('guard-release-end');
        return;
      }
    }
    if (!guardMMDBones.size && !guardVRMBones.size) captureGuardPose();

    // On disable, fade the old guard out against the live mocap instead of
    // dropping the constraint in a single frame (which caused the visible snap).
    if (releasing) {
      // Release from the exact visually-locked pose captured at the moment OFF
      // was pressed. Blending the neutral target with a shrinking strength could
      // still expose 5-10% of the live mocap on the first frame and look like a snap.
      const mmdTarget = guardReleaseMMD.size ? guardReleaseMMD : guardMMDBones;
      const vrmTarget = guardReleaseVRM.size ? guardReleaseVRM : guardVRMBones;
      const bones = getMMDMesh()?.bones_by_name;
      if (bones) for (const [name, transform] of mmdTarget) blendTransform(bones[name], transform, releaseMix);
      const modelX = getVRMModelX();
      if (modelX?.getBoneNode) for (const [name, transform] of vrmTarget) {
        try { blendTransform(modelX.getBoneNode(name), transform, releaseMix); } catch (e) {}
      }
      events.emit('guard-release', { mix: releaseMix, mode });
      return;
    }
    const holdMs = Math.max(100, Number(config.tracking?.guard_hold_ms ?? 650));
    const previousMMD = guardLastMMD, previousVRM = guardLastVRM;
    const check = guardLooksInvalid();
    const rapidSequence = guardRapidSequence(check, now);
    let invalid = !!guardInvalidSince || rapidSequence;

    if (invalid) {
      if (!guardInvalidSince) {
        guardInvalidSince = now;
        guardRecoveryFrames = 0;
        guardTransition = {
          start: now,
          duration: Math.max(100, Number(config.tracking?.guard_transition_ms ?? 220))
        };
        captureGuardTransitionPose(check);
      }
      guardHoldUntil = guardInvalidSince + holdMs;
      guardLastRejected = check.maxJump;

      if (!rapidSequence && !check.invalid && check.confidence >= .25) guardRecoveryFrames++;
      else guardRecoveryFrames = 0;

      if (now >= guardHoldUntil && guardRecoveryFrames >= 4) {
        invalid = false;
        guardInvalidSince = 0;
        guardHoldUntil = 0;
        guardRecoveryFrames = 0;
        guardTransition = null;
        guardTransitionMMD.clear(); guardTransitionVRM.clear();
        guardMotionWindow.length = 0;

        guardReacquireTransition = {
          start: now,
          duration: Math.max(150, Number(config.tracking?.guard_reacquisition_ms ?? 300))
        };
        guardReacquireMMD.clear();
        guardReacquireVRM.clear();
        for (const [name, t] of guardLastMMD) guardReacquireMMD.set(name, cloneTransform(t));
        for (const [name, t] of guardLastVRM) guardReacquireVRM.set(name, cloneTransform(t));

        snapshotGuardLast();
        events.emit('upper-body-guard-reacquired', { coherentFrames:4, confidence:check.confidence });
      }
      else {
        events.emit('upper-body-guard-reject', { degrees: check.maxJump, confidence: check.confidence, until: guardHoldUntil });
      }
    }
    else {
      guardInvalidSince = 0;
      guardHoldUntil = 0;
      guardRecoveryFrames = 0;
      guardTransition = null;
      guardTransitionMMD.clear(); guardTransitionVRM.clear();
      adaptiveSmoothCurrent(previousMMD, previousVRM, check);
      snapshotGuardLast();

      if (guardReacquireTransition) {
        const t = util.clamp((now - guardReacquireTransition.start) / guardReacquireTransition.duration, 0, 1);
        const easeMix = 1 - smoothStep01(t);
        if (t >= 1 || easeMix <= 0.0001) {
          guardReacquireTransition = null;
          guardReacquireMMD.clear();
          guardReacquireVRM.clear();
        } else {
          const bones = getMMDMesh()?.bones_by_name;
          if (bones) {
            for (const [name, transform] of guardReacquireMMD) {
              const bone = bones[name];
              if (bone) blendTransform(bone, transform, easeMix);
            }
          }
          const modelX = getVRMModelX();
          if (modelX?.getBoneNode) {
            for (const [name, transform] of guardReacquireVRM) {
              try {
                const bone = modelX.getBoneNode(name);
                if (bone) blendTransform(bone, transform, easeMix);
              } catch (e) {}
            }
          }
        }
      }
    }

    if (invalid) {
      // Hold the most recent accepted pose until tracking is trustworthy again.
      // Transition gradually towards the held pose to prevent an abrupt 1-frame snap.
      const mmdTarget = guardLastMMD;
      const vrmTarget = guardLastVRM;
      let easeMix = 1;
      if (guardTransition) {
        const t = util.clamp((now - guardTransition.start) / guardTransition.duration, 0, 1);
        easeMix = smoothStep01(t);
        if (t >= 1) {
          guardTransition = null;
          guardTransitionMMD.clear();
          guardTransitionVRM.clear();
        }
      }
      const bones = getMMDMesh()?.bones_by_name;
      if (bones) {
        for (const [name, transform] of mmdTarget) {
          const bone = bones[name];
          if (!bone) continue;
          if (easeMix >= 1 || !guardTransitionMMD.has(name)) {
            blendTransform(bone, transform, 1);
          } else {
            blendInterpolateTransform(bone, guardTransitionMMD.get(name), transform, easeMix);
          }
        }
      }
      const modelX = getVRMModelX();
      if (modelX?.getBoneNode) {
        for (const [name, transform] of vrmTarget) {
          try {
            const bone = modelX.getBoneNode(name);
            if (!bone) continue;
            if (easeMix >= 1 || !guardTransitionVRM.has(name)) {
              blendTransform(bone, transform, 1);
            } else {
              blendInterpolateTransform(bone, guardTransitionVRM.get(name), transform, easeMix);
            }
          } catch (e) {}
        }
      }
      return;
    }

    if (mode === 'desk') {
      applyDeskLocks();
      return;
    }

    const strength = util.clamp(config.tracking?.upper_body_guard_strength ?? 0.70, 0, 1);
    // Valid tracking: stabilize rotation only. Translation remains 100% live.
    // The INVALID branch above still holds full transforms to prevent pretzels.
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) for (const name of MMD_GUARD_CHECK) {
      const transform = guardMMDBones.get(name);
      if (transform) blendRotationOnly(bones[name], transform, strength);
    }
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) for (const name of VRM_GUARD_CHECK) {
      const transform = guardVRMBones.get(name);
      if (!transform) continue;
      try { blendRotationOnly(modelX.getBoneNode(name), transform, strength); } catch (e) {}
    }
  }

  function clearGuardState() {
    guardMMDBones.clear(); guardVRMBones.clear(); guardLastMMD.clear(); guardLastVRM.clear(); guardRawMMD.clear(); guardRawVRM.clear();
    guardTransitionMMD.clear(); guardTransitionVRM.clear(); guardTransition = null;
    guardReacquireMMD.clear(); guardReacquireVRM.clear(); guardReacquireTransition = null;
    guardMotionWindow.length = 0;
    guardHoldUntil = 0; guardInvalidSince = 0; guardRecoveryFrames = 0; guardLastRejected = 0; guardLastJump = 0; guardConfidence = 1; guardMeasuredConfidence = null;
  }

  function captureGuardReleasePose() {
    guardReleaseMMD.clear(); guardReleaseVRM.clear();
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) snapshotMap(MMD_GUARD_BONES, name => bones[name], guardReleaseMMD);
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) snapshotMap(VRM_GUARD_BONES, name => modelX.getBoneNode(name), guardReleaseVRM);
  }

  function setGuardMode(mode, recapture = true) {
    mode = String(mode || 'off').toLowerCase();
    if (!['off', 'guard', 'desk'].includes(mode)) mode = 'off';
    config.tracking ||= {};
    const previous = guardMode();

    if (mode === 'off' && previous !== 'off') {
      captureGuardReleasePose();
      guardRelease = {
        mode: previous,
        start: performance.now(),
        duration: Math.max(80, Number(config.tracking?.guard_release_ms ?? 450))
      };
      config.tracking.guard_mode = 'off';
      config.tracking.upper_body_guard = false;
      events.emit('guard-release-start', guardRelease);
    }
    else {
      guardRelease = null;
      guardReleaseMMD.clear(); guardReleaseVRM.clear();
      config.tracking.guard_mode = mode;
      config.tracking.upper_body_guard = mode !== 'off';
      if (mode !== 'off' && recapture) captureGuardPose();
      if (mode === 'off') clearGuardState();
    }

    events.emit('upper-body-guard', mode !== 'off');
    events.emit('guard-mode', mode);
    XRA.profileService.save();
    return mode;
  }

  function setUpperBodyGuard(enabled, recapture = true) {
    return setMotionHysteresis(enabled, recapture);
  }

  function setMotionHysteresis(enabled, recapture = true) {
    enabled = !!enabled;
    config.tracking ||= {};
    config.tracking.motion_hysteresis_enabled = enabled;
    // Hysteresis follows the last accepted live pose; it must never pull toward
    // the calibration pose while tracking is valid.
    config.tracking.upper_body_guard_strength = 0;
    const active = setGuardMode(enabled ? 'guard' : 'off', recapture) !== 'off';
    broadcastTrackingState();
    events.emit('motion-hysteresis', active);
    return active;
  }

  function setUpperBodyGuardStrength(value) {
    config.tracking ||= {};
    config.tracking.upper_body_guard_strength = util.clamp(value, 0, 1);
    XRA.profileService.save();
    events.emit('upper-body-guard-config', config.tracking);
  }


  function runtimePosePoints() {
    const pn = window.System?._browser?.camera?.poseNet;
    const candidates = [
      pn?.pose, pn?._pose, pn?.last_pose, pn?.pose_data, pn?.result?.posenet,
      pn?._result?.posenet, window.MMD_SA?.WebXR?.user_camera?.pose
    ];
    for (const candidate of candidates) {
      const pose = Array.isArray(candidate) ? candidate[0] : candidate;
      const points = pose?.keypoints || pose?.poseLandmarks || pose?.landmarks;
      if (Array.isArray(points) && points.length) return points;
    }
    return null;
  }

  function poseLayout(points) {
    const n = Number(points?.length || 0);
    if (n >= 30) return 'mediapipe';
    if (n >= 15) return 'posenet';
    return 'named';
  }

  function pointXY(point) {
    if (!point) return null;
    const x = Number(point.x ?? point.position?.x ?? point.location?.x);
    const y = Number(point.y ?? point.position?.y ?? point.location?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function poseVideoSize() {
    const candidates = [
      window.MMD_SA?.WebXR?.user_camera?.video,
      window.System?._browser?.camera?.video,
      document.querySelector('video#SL_Host_Parent'),
      document.querySelector('video')
    ];
    for (const video of candidates) {
      const width = Number(video?.videoWidth || video?.width || 0);
      const height = Number(video?.videoHeight || video?.height || 0);
      if (width > 32 && height > 32) return { width, height };
    }
    return null;
  }

  function pointInsideFrame(point, margin = .08) {
    const xy = pointXY(point);
    if (!xy) return null;
    // MediaPipe-style normalized coordinates.
    if (Math.abs(xy.x) <= 2.5 && Math.abs(xy.y) <= 2.5) {
      return xy.x >= -margin && xy.x <= 1 + margin && xy.y >= -margin && xy.y <= 1 + margin;
    }
    // PoseNet-style pixel coordinates.
    const size = poseVideoSize();
    if (!size) return null;
    return xy.x >= -size.width * margin && xy.x <= size.width * (1 + margin) &&
           xy.y >= -size.height * margin && xy.y <= size.height * (1 + margin);
  }

  function landmarkIndices(points, kind) {
    const layout = poseLayout(points);
    if (layout === 'mediapipe') {
      if (kind === 'head') return [0,1,2,3,4,5,6,7,8,9,10];
      if (kind === 'core') return [11,12,23,24];
    }
    if (layout === 'posenet') {
      // COCO PoseNet: head 0..4, shoulders 5/6, hips 11/12.
      if (kind === 'head') return [0,1,2,3,4];
      if (kind === 'core') return [5,6,11,12];
    }
    return [];
  }

  function pointConfidenceGood(point, threshold = .35) {
    if (!point) return false;
    const value = Number(point.visibility ?? point.score ?? point.presence);
    return !Number.isFinite(value) || value >= threshold;
  }

  function facemeshEnabled() {
    return !!window.System?._browser?.camera?.facemesh?.enabled;
  }

  function facePointXY(point) {
    if (!point) return null;
    if (Array.isArray(point)) {
      const x = Number(point[0]), y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
    const x = Number(point.x ?? point.position?.x ?? point.location?.x);
    const y = Number(point.y ?? point.position?.y ?? point.location?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function inspectFaceRuntimeValue(value, depth = 0, seen = new Set()) {
    if (value == null || depth > 2) return null;
    if ((typeof value === 'object' || typeof value === 'function') && seen.has(value)) return null;
    if (typeof value === 'object' || typeof value === 'function') seen.add(value);

    if (Array.isArray(value)) {
      if (!value.length) return { available:true, present:false, confidence:null, signature:'empty' };
      // Direct face mesh / landmark array (468/478 points, or any substantial face mesh).
      if (value.length >= 20 && facePointXY(value[0])) {
        const sampleIds = [0, Math.floor(value.length*.2), Math.floor(value.length*.5), Math.floor(value.length*.8), value.length-1];
        const signature = sampleIds.map(i => {
          const xy = facePointXY(value[i]);
          return xy ? `${Math.round(xy.x*100)/100},${Math.round(xy.y*100)/100}` : 'x';
        }).join('|');
        return { available:true, present:true, confidence:null, signature:`mesh:${value.length}:${signature}` };
      }
      // faces:[{scaledMesh...}] / multiFaceLandmarks:[[...]]
      for (const item of value.slice(0, 2)) {
        const nested = inspectFaceRuntimeValue(item, depth + 1, seen);
        if (nested?.present) return nested;
      }
      return { available:true, present:false, confidence:null, signature:`array:${value.length}` };
    }

    if (typeof value !== 'object') return null;
    const confidenceKeys = ['faceInViewConfidence','faceScore','confidence','score','presence'];
    let confidence = null;
    for (const key of confidenceKeys) {
      const c = Number(value[key]);
      if (Number.isFinite(c)) { confidence = util.clamp(c,0,1); break; }
    }

    const faceKeys = [
      'faces','face','scaledMesh','mesh','landmarks','faceLandmarks','multiFaceLandmarks',
      'predictions','prediction','result','_result','last_result','lastResult',
      'data','_data','last_data','lastData'
    ];
    let sawContainer = false;
    for (const key of faceKeys) {
      if (!(key in value)) continue;
      sawContainer = true;
      const nested = inspectFaceRuntimeValue(value[key], depth + 1, seen);
      if (nested?.present) {
        if (nested.confidence == null && confidence != null) nested.confidence = confidence;
        return nested;
      }
      if (nested?.available && Array.isArray(value[key]) && value[key].length === 0) {
        return { available:true, present:false, confidence, signature:`${key}:empty` };
      }
    }

    // Some native facemesh implementations expose a direct boolean/count.
    for (const key of ['face_detected','faceDetected','detected','has_face','hasFace']) {
      if (typeof value[key] === 'boolean') {
        return { available:true, present:value[key], confidence, signature:`${key}:${value[key]}` };
      }
    }
    for (const key of ['face_count','faceCount','numFaces']) {
      const n = Number(value[key]);
      if (Number.isFinite(n)) return { available:true, present:n > 0, confidence, signature:`${key}:${n}` };
    }

    return sawContainer ? { available:true, present:false, confidence, signature:'container-empty' } : null;
  }

  function runtimeFaceTrackingEvidence() {
    const f = window.System?._browser?.camera?.facemesh;
    if (!f || !f.enabled) return { available:false, present:false, strong:false, hardLost:false, reason:'facemesh-disabled', source:'none' };

    // Split Face+Body does not send face state through our pose worker, but the
    // native facemesh runtime exposes the same current-frame detection flag it
    // uses internally. Once a face has been seen, zero is a real loss signal.
    // This catches a covered lens even if PoseNet hallucinates a plausible body.
    let nativeDetected = false;
    try { nativeDetected = Number(f.data_detected || 0) > 0; } catch (e) {}
    const nativeNow = performance.now();
    if (nativeDetected) {
      faceRuntimeEverPresent = true;
      faceRuntimeLastPresentAt = nativeNow;
      return {
        available:true, present:true, strong:true, hardLost:false,
        confidence:null, signature:'native-face:1', stale:false,
        reason:'native-face-live', source:'native-facemesh'
      };
    }
    if (faceRuntimeEverPresent) {
      return {
        available:true, present:false, strong:false, hardLost:true,
        confidence:0, signature:'native-face:0', stale:false,
        reason:'native-face-missing', source:'native-facemesh'
      };
    }

    const candidates = [
      f.faces, f.face, f.result, f._result, f.last_result, f.lastResult,
      f.data, f._data, f.last_data, f.lastData, f.predictions,
      f.scaledMesh, f.mesh, f.landmarks, f.faceLandmarks, f.multiFaceLandmarks,
      f
    ];
    let found = null;
    let foundIndex = -1;
    for (let i = 0; i < candidates.length; i++) {
      const v = inspectFaceRuntimeValue(candidates[i]);
      if (v?.available) {
        found = v;
        foundIndex = i;
        if (v.present) break;
      }
    }

    // Fresh worker/native event wins. It is the only source that can prove an
    // empty detection even if the native facemesh object keeps stale mesh data.
    const now = performance.now();
    if (faceSignal.available && now - faceSignal.lastUpdateAt < 700) {
      return {
        available:true,
        present:faceSignal.present,
        strong:faceSignal.present && (faceSignal.confidence == null || faceSignal.confidence >= .25),
        hardLost:!faceSignal.present,
        confidence:faceSignal.confidence,
        signature:faceSignal.signature,
        reason:faceSignal.present ? 'face-live' : 'face-missing',
        source:faceSignal.source || 'worker'
      };
    }

    if (found) {
      const signature = String(found.signature || '');
      if (signature && signature !== faceRuntimeSignature) {
        faceRuntimeSignature = signature;
        faceRuntimeChangedAt = now;
      } else if (!faceRuntimeChangedAt) {
        faceRuntimeChangedAt = now;
      }
      const confidence = found.confidence;
      if (found.present) {
        faceRuntimeEverPresent = true;
        faceRuntimeLastPresentAt = now;
      }
      const strong = !!found.present && (confidence == null || confidence >= .20);
      const stale = !!(signature && now - faceRuntimeChangedAt > 280);

      // A random empty property on the facemesh settings object is not enough
      // evidence to hide the avatar. Treat runtime "missing" as authoritative
      // only after the same runtime has previously exposed a real face.
      const negativeTrusted = !found.present && faceRuntimeEverPresent &&
        now - faceRuntimeLastPresentAt < 5000;
      if (!found.present && !negativeTrusted) {
        return {
          available:false, present:false, strong:false, hardLost:false,
          confidence, signature, stale, reason:`runtime-face-unknown-${foundIndex}`,
          source:'unknown'
        };
      }

      return {
        available:true,
        present:!!found.present,
        strong,
        hardLost:!found.present,
        confidence,
        signature,
        stale,
        reason:found.present ? 'runtime-face-live' : 'runtime-face-missing',
        source:'runtime'
      };
    }

    // If native face processing is known to be running but no inspectable
    // result is exposed, do not falsely hide a visible avatar.
    return {
      available:false, present:false, strong:false, hardLost:false,
      confidence:null, signature:'', reason:'face-signal-unknown', source:'unknown'
    };
  }

  function headTrackingEvidence() {
    const face = runtimeFaceTrackingEvidence();
    const technical = technicalFaceMeshEvidence();
    const technicalEvidence = technical.available ? {
        available:true,
        present:technical.present,
        strong:technical.present,
        hardLost:!technical.present,
        confidence:null,
        signature:'',
        stale:false,
        reason:technical.present ? 'technical-mesh-visible' : 'technical-mesh-missing',
        source:'technical-preview'
      } : null;

    // Positive evidence wins across sources. XR Animator can clear its numeric
    // data_detected counter before our render hook even though the current
    // technical mesh is visible; treating that transient zero as authoritative
    // caused the false FROZEN state shown in podcast framing.
    if (technicalEvidence?.present) return technicalEvidence;
    if (face.available && face.present) return face;
    if (face.available) return face;
    if (technicalEvidence) return technicalEvidence;

    const pose = poseHeadTrackingEvidence();
    // With facemesh enabled but no authoritative face result exposed, do not
    // interpret ordinary confidence dips / geometry wobble as face loss. Those
    // false positives are exactly what can make a hand/finger in front of the
    // webcam jerk the avatar. Only a clearly off-frame/missing pose is trusted.
    if (facemeshEnabled()) {
      const conservativeLost = !!pose?.hardLost && ['off-frame','no-head-landmarks'].includes(String(pose?.reason || ''));
      return { ...pose, hardLost: conservativeLost, source:'pose-fallback-conservative' };
    }
    return { ...pose, source:'pose-fallback' };
  }

  function poseHeadTrackingEvidence() {
    const points = runtimePosePoints();
    if (!points) return { available:false, strong:false, hardLost:false, reason:'no-pose' };
    const layout = poseLayout(points);
    const headIndices = landmarkIndices(points, 'head');
    const coreIndices = landmarkIndices(points, 'core');
    const minConfidence = util.clamp(config.tracking?.head_confidence_min ?? .30, .05, .95);

    let head = headIndices.map(i => ({ i, p:points[i], xy:pointXY(points[i]), inside:pointInsideFrame(points[i]) })).filter(v => v.p);
    let core = coreIndices.map(i => ({ i, p:points[i], xy:pointXY(points[i]), inside:pointInsideFrame(points[i]) })).filter(v => v.p);
    if (!head.length && layout === 'named') {
      head = points.map((p,i)=>({ i,p,xy:pointXY(p),inside:pointInsideFrame(p) }))
        .filter(v => /(nose|eye|ear|face)/.test(String(v.p?.name || v.p?.part || '').toLowerCase()));
      core = points.map((p,i)=>({ i,p,xy:pointXY(p),inside:pointInsideFrame(p) }))
        .filter(v => /(shoulder|hip)/.test(String(v.p?.name || v.p?.part || '').toLowerCase()));
    }
    if (!head.length) return { available:false, strong:false, hardLost:true, reason:'no-head-landmarks' };

    const goodHead = head.filter(v => v.xy && v.inside !== false && pointConfidenceGood(v.p, minConfidence));
    const insideHead = head.filter(v => v.inside === true);
    const confidentHead = head.filter(v => pointConfidenceGood(v.p, minConfidence));
    const required = layout === 'mediapipe' ? 4 : 2;

    // The nose is the most useful sentinel in both COCO PoseNet and MediaPipe.
    const nose = head.find(v => v.i === 0);
    const noseGood = !!(nose?.xy && nose.inside !== false && pointConfidenceGood(nose.p, minConfidence));

    // Anatomical sanity: the visible face centre should remain above the
    // shoulder line. Hallucinated PoseNet heads commonly collapse onto/below
    // the shoulders when the real head leaves the image.
    let geometryGood = true;
    const headXY = goodHead.map(v => v.xy).filter(Boolean);
    const coreXY = core.filter(v => v.xy && v.inside !== false && pointConfidenceGood(v.p, .18)).map(v => v.xy);
    if (headXY.length && coreXY.length >= 2) {
      const hy = headXY.reduce((a,v)=>a+v.y,0) / headXY.length;
      const sy = coreXY.slice(0,2).reduce((a,v)=>a+v.y,0) / Math.min(2, coreXY.length);
      const size = poseVideoSize();
      const normalized = Math.abs(hy) <= 2.5 && Math.abs(sy) <= 2.5;
      const margin = normalized ? .015 : Math.max(3, Number(size?.height || 480) * .015);
      geometryGood = hy < sy - margin;
    }

    const mostlyOutside = insideHead.length <= Math.max(1, Math.floor(head.length * .25));
    const weak = confidentHead.length < required || goodHead.length < required || !noseGood;
    const hardLost = mostlyOutside || (!geometryGood && goodHead.length >= 1) || (weak && goodHead.length <= 1);
    const strong = !hardLost && geometryGood && noseGood && goodHead.length >= required;
    const signature = head.map(v => {
      const c = Number(v.p?.visibility ?? v.p?.score ?? v.p?.presence);
      return v.xy ? `${Math.round(v.xy.x*1000)/1000},${Math.round(v.xy.y*1000)/1000},${Number.isFinite(c)?Math.round(c*100)/100:'n'}` : 'x';
    }).join('|');
    return { available:true, strong, hardLost, geometryGood, noseGood, goodCount:goodHead.length, total:head.length, signature, reason: hardLost ? (mostlyOutside?'off-frame':(!geometryGood?'geometry':'weak')) : (strong?'strong':'borderline') };
  }

  function snapshotFaceLossPose() {
    captureBones(MMD_FACE_LOSS_FREEZE_BONES, faceLossPoseMMD, VRM_FACE_LOSS_FREEZE_BONES, faceLossPoseVRM);
  }

  function blendFaceLossPose(strength = 1) {
    const k = util.clamp(strength, 0, 1);
    const bones = getMMDMesh()?.bones_by_name;
    if (bones) for (const [name, transform] of faceLossPoseMMD) blendTransform(bones[name], transform, k);
    const modelX = getVRMModelX();
    if (modelX?.getBoneNode) for (const [name, transform] of faceLossPoseVRM) {
      try { blendTransform(modelX.getBoneNode(name), transform, k); } catch (e) {}
    }
  }

  const MMD_FACE_LOSS_STABILITY_BONES = ['センター', '下半身', '上半身', '上半身2', '首', '頭', '左肩', '右肩'];
  const VRM_FACE_LOSS_STABILITY_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder'];

  function faceLossSnapshot(now = performance.now(), reusable = null) {
    const mmd = reusable?.mmd || new Map();
    const vrm = reusable?.vrm || new Map();
    captureBones(MMD_FACE_LOSS_FREEZE_BONES, mmd, VRM_FACE_LOSS_FREEZE_BONES, vrm);
    if (reusable) {
      reusable.at = now;
      reusable.jump = 0;
      reusable.stable = true;
      return reusable;
    }
    return { at:now, mmd, vrm, jump:0, stable:true };
  }

  function snapshotRotationJump(previous, current) {
    if (!previous || !current) return 0;
    let maxJump = 0;
    for (const name of MMD_FACE_LOSS_STABILITY_BONES) {
      const a = previous.mmd?.get(name)?.quaternion;
      const b = current.mmd?.get(name)?.quaternion;
      if (a && b) maxJump = Math.max(maxJump, quaternionAngleDeg(a, b));
    }
    for (const name of VRM_FACE_LOSS_STABILITY_BONES) {
      const a = previous.vrm?.get(name)?.quaternion;
      const b = current.vrm?.get(name)?.quaternion;
      if (a && b) maxJump = Math.max(maxJump, quaternionAngleDeg(a, b));
    }
    return maxJump;
  }

  function rememberFaceLossPose(now = performance.now()) {
    if (now - faceLossLastHistoryAt < FACE_LOSS_SAMPLE_MS) return;
    faceLossLastHistoryAt = now;
    const snapshot = faceLossSnapshot(now, faceLossPosePool.pop());
    if (!snapshot.mmd.size && !snapshot.vrm.size) return;
    const previous = faceLossPoseHistory[faceLossPoseHistory.length - 1];
    snapshot.jump = snapshotRotationJump(previous, snapshot);
    // A large core/head rotation jump within ~50 ms is much more likely to be a
    // tracking hallucination than useful freeze material. It is ignored only for
    // freeze selection; live mocap itself is never modified here.
    snapshot.stable = !previous || snapshot.jump <= 48;
    faceLossPoseHistory.push(snapshot);
    const cutoff = now - FACE_LOSS_HISTORY_MS;
    while (faceLossPoseHistory.length > 2 && faceLossPoseHistory[0].at < cutoff) {
      faceLossPosePool.push(faceLossPoseHistory.shift());
    }
  }

  function selectTrustedFaceLossPose(now = performance.now()) {
    const target = now - FACE_LOSS_LOOKBACK_MS;
    for (let i = faceLossPoseHistory.length - 1; i >= 0; i--) {
      const pose = faceLossPoseHistory[i];
      if (pose.stable && pose.at <= target) return pose;
    }
    for (let i = faceLossPoseHistory.length - 1; i >= 0; i--) {
      if (faceLossPoseHistory[i].stable) return faceLossPoseHistory[i];
    }
    return faceLossPoseHistory[0] || null;
  }

  function useFaceLossPose(snapshot) {
    if (!snapshot) return false;
    faceLossPoseMMD.clear();
    faceLossPoseVRM.clear();
    for (const [name, transform] of snapshot.mmd || []) faceLossPoseMMD.set(name, transform);
    for (const [name, transform] of snapshot.vrm || []) faceLossPoseVRM.set(name, transform);
    return !!(faceLossPoseMMD.size || faceLossPoseVRM.size);
  }

  function bodyTrackingEvidence() {
    const now = performance.now();
    const poseRuntime = window.System?._browser?.camera?.poseNet;
    const workerFresh = poseSignal.available && now - poseSignal.lastUpdateAt < 700;

    // The worker validates shoulders, hips, frame bounds and geometry before it
    // substitutes the last good pose. Native PoseNet sees that substituted pose
    // as valid, so a fresh worker loss must veto a positive native counter.
    if (workerFresh && !poseSignal.present) {
      return {
        available:true, present:false, strong:false, hardLost:true,
        confidence:poseSignal.confidence, signature:poseSignal.signature,
        reason:'worker-pose-rejected', source:poseSignal.source || 'mocap-worker',
        at:poseSignal.lastUpdateAt
      };
    }

    // This is the exact signal used by XR Animator's own pose solver. A positive
    // value means that the current processed frame contains a pose; the native
    // runtime resets it to zero as soon as that frame has no valid pose. Reading
    // it here avoids guessing from stale landmark arrays or relying exclusively
    // on BroadcastChannel, which can be absent on low-end/cached installations.
    if (poseRuntime?.enabled === true) {
      let detected = false;
      try { detected = Number(poseRuntime.data_detected || 0) > 0; }
      catch (e) {}
      if (detected) nativePoseEverDetected = true;

      const frameAt = Number(poseRuntime._RAF_timestamp);
      const hasFrameClock = Number.isFinite(frameAt) && frameAt > 0;
      const age = hasFrameClock ? Math.max(0, now - frameAt) : 0;
      const started = nativePoseEverDetected || !!poseRuntime.initial_data_detected;

      if (detected) {
        return {
          available:true, present:true, strong:true, hardLost:false,
          confidence:null, signature:`native:${Number(poseRuntime.data_detected || 1)}`,
          reason:'native-pose-live', source:'native-pose', at:hasFrameClock ? frameAt : now
        };
      }

      // Once a real pose has existed, zero is authoritative. `no_pose_data`
      // additionally covers the runtime's own loss latch. A detector that stops
      // producing frames for 700 ms is also considered lost, which is important
      // when a weak webcam/PC stalls instead of returning an empty result.
      if (started && (!hasFrameClock || age < 700 || poseRuntime.no_pose_data)) {
        return {
          available:true, present:false, strong:false, hardLost:true,
          confidence:0, signature:'native:missing', reason:'native-pose-missing',
          source:'native-pose', at:hasFrameClock ? frameAt : now
        };
      }
      if (started && age >= 700) {
        return {
          available:true, present:false, strong:false, hardLost:true,
          confidence:0, signature:'native:stalled', reason:'native-pose-stalled',
          source:'native-pose', at:frameAt
        };
      }
    }

    // Worker evidence remains a fallback for the short interval before the
    // native solver publishes its frame and for builds without the public flag.
    if (workerFresh) {
      return {
        available:true,
        present:poseSignal.present,
        strong:poseSignal.present && (poseSignal.confidence == null || poseSignal.confidence >= .20),
        hardLost:!poseSignal.present,
        confidence:poseSignal.confidence,
        signature:poseSignal.signature,
        reason:poseSignal.present ? 'pose-live' : 'pose-missing',
        source:poseSignal.source || 'mocap-worker',
        at:poseSignal.lastUpdateAt
      };
    }

    // Once the worker has reported a pose, a stalled detector/camera is itself a
    // loss condition. Before the first report we stay fail-open during startup.
    if (poseSignal.available && poseSignal.lastUpdateAt && now - poseSignal.lastUpdateAt >= 700) {
      return {
        available:true, present:false, strong:false, hardLost:true,
        confidence:null, signature:'stale', reason:'pose-signal-stale',
        source:'mocap-worker', at:poseSignal.lastUpdateAt
      };
    }
    if (poseRuntime && poseRuntime.enabled === false) {
      return { available:false, present:false, reason:'pose-disabled', source:'none', at:now };
    }
    return { available:false, present:false, strong:false, hardLost:false, reason:'pose-signal-pending', source:'none', at:now };
  }

  function trackingLossEvidence() {
    const body = bodyTrackingEvidence();
    const face = headTrackingEvidence();
    // With facemesh active, it is the loss authority in both directions: a
    // visible face keeps tracking live even when hips are outside a podcast crop,
    // and a missing face vetoes a hallucinated positive body pose.
    if (facemeshEnabled() && face.available) {
      return { ...face, at:faceSignal.lastUpdateAt || technicalMeshSampleAt || performance.now() };
    }
    if (body.available) {
      return body;
    }
    return { ...face, at:faceSignal.lastUpdateAt || technicalMeshSampleAt || performance.now() };
  }

  function emitFaceLossState(name, payload = {}) {
    const signature = `${name}:${payload.recovering ? 1 : 0}:${payload.unavailable ? 1 : 0}`;
    if (signature === faceLossLastEvent) return;
    faceLossLastEvent = signature;
    events.emit('head-loss-guard', payload);
  }

  function resetFaceLossState(clearHistory = true) {
    faceLossState = 'live';
    faceLossMissingSamples = 0;
    faceLossPresentSamples = 0;
    faceLossLastDecisionSampleAt = 0;
    faceLossLastHistoryAt = 0;
    faceLossLastEvent = '';
    headLost = false;
    headRecoveryStarted = 0;
    faceLossFreezeStarted = 0;
    if (clearHistory) {
      while (faceLossPoseHistory.length) faceLossPosePool.push(faceLossPoseHistory.pop());
    }
  }

  function applyHeadLossGuard() {
    // Body stabilization now always includes tracking-loss protection. The
    // legacy checkbox can additionally keep this protection active while body
    // stabilization itself is off.
    if (!bodyStable && !config.tracking?.freeze_head_on_face_loss) return;

    const evidence = trackingLossEvidence();
    const now = performance.now();
    const sampleAt = Number(evidence.at || now);
    const newSample = sampleAt !== faceLossLastDecisionSampleAt;
    if (newSample) faceLossLastDecisionSampleAt = sampleAt;

    if (!evidence.available) {
      if (headLost || faceLossState !== 'live') {
        resetFaceLossState(false);
        emitFaceLossState('unavailable', { active:false, unavailable:true, evidence:evidence.source });
      }
      return;
    }

    if (evidence.present) {
      if (newSample) {
        faceLossPresentSamples += 1;
        faceLossMissingSamples = 0;
      }

      if (faceLossState === 'live') {
        if (newSample) rememberFaceLossPose(now);
        emitFaceLossState('live', { active:false, evidence:evidence.reason });
        return;
      }

      // A returning mesh must remain valid for several consecutive technical
      // samples before the frozen pose is released. This prevents one flickering
      // face frame from re-enabling a hallucinated body pose.
      if (faceLossState !== 'recovering') {
        blendFaceLossPose(1);
        if (faceLossPresentSamples < FACE_LOSS_REACQUIRE_SAMPLES) {
          emitFaceLossState('waiting-reacquire', { active:true, recovering:false, fullPose:true, evidence:'tracking-validating' });
          return;
        }
        faceLossState = 'recovering';
        headRecoveryStarted = now;
      }

      const duration = Math.max(0, Number(config.tracking?.freeze_recovery_ms ?? 350));
      const t = duration <= 0 ? 1 : util.clamp((now - headRecoveryStarted) / duration, 0, 1);
      const hold = 1 - smoothStep01(t);
      if (hold > .001) {
        blendFaceLossPose(hold);
        emitFaceLossState('recovering', { active:true, recovering:true, fullPose:true, mix:hold, evidence:evidence.reason });
        return;
      }

      resetFaceLossState(true);
      rememberFaceLossPose(now);
      emitFaceLossState('live', { active:false, evidence:evidence.reason });
      return;
    }

    if (newSample) {
      faceLossMissingSamples += 1;
      faceLossPresentSamples = 0;
    }

    // Freeze immediately on the first missing detector sample, but use a
    // stable buffered pose from ~140 ms earlier. That avoids capturing the first
    // corrupted frame produced while a hand/obstruction is entering the camera.
    if (faceLossState === 'live' || faceLossState === 'recovering') {
      const trusted = selectTrustedFaceLossPose(now);
      if (!useFaceLossPose(trusted)) snapshotFaceLossPose();
      faceLossState = 'suspect';
      headLost = true;
      headRecoveryStarted = 0;
      faceLossFreezeStarted = now;
    }
    if (faceLossMissingSamples >= 2) faceLossState = 'frozen';

    if (!faceLossPoseMMD.size && !faceLossPoseVRM.size) return;
    const freezeDuration = Math.max(100, Number(config.tracking?.guard_transition_ms ?? 220));
    const freezeT = util.clamp((now - faceLossFreezeStarted) / freezeDuration, 0, 1);
    const freezeMix = smoothStep01(freezeT);
    blendFaceLossPose(freezeMix);
    emitFaceLossState(faceLossState, { active:true, fullPose:true, mix:freezeMix, evidence:evidence.reason });
  }

  function setFreezeHeadOnFaceLoss(enabled) {
    enabled = !!enabled;
    config.tracking ||= {};
    config.tracking.freeze_head_on_face_loss = enabled;
    // Rebuild the trusted pose after every toggle. This avoids reviving a
    // stale snapshot captured by an older tracking session/profile.
    faceLossPoseMMD.clear(); faceLossPoseVRM.clear();
    resetFaceLossState(true);
    technicalMeshSampleAt = 0;
    technicalMeshSample = { available:false, present:false, source:'none' };
    technicalMeshCandidatesCache = []; technicalMeshCandidatesAt = 0;
    events.emit('head-freeze-on-loss', { enabled, frozen:false });
    XRA.profileService.save();
    return enabled;
  }

  const COLLIDER_PRESETS = {
    OFF:    { mode: 0, head: 100, chest: 100, waist: 100, hip: 100, reaction: 'z_push' },
    SOFT:   { mode: 2, head: 90,  chest: 85,  waist: 80,  hip: 85,  reaction: 'z_push' },
    NORMAL: { mode: 2, head: 100, chest: 105, waist: 95,  hip: 100, reaction: 'z_push' },
    STRONG: { mode: 2, head: 115, chest: 130, waist: 115, hip: 120, reaction: 'z_push' }
  };

  function bodyCollider() {
    return window.System?._browser?.camera?.poseNet?.body_collider || null;
  }

  function applyColliderPreset(name) {
    name = String(name || 'CUSTOM').toUpperCase();
    config.collider ||= {};
    config.collider.preset = name;
    if (name === 'CUSTOM') return false;

    const preset = COLLIDER_PRESETS[name];
    const collider = bodyCollider();
    if (!preset || !collider) return false;

    collider.mode = preset.mode;
    if (collider.head) {
      collider.head.size_percent = preset.head;
      collider.head.reaction_type = preset.reaction;
    }
    if (collider.chest) collider.chest.size_percent = preset.chest;
    if (collider.waist) collider.waist.size_percent = preset.waist;
    if (collider.hip) collider.hip.size_percent = preset.hip;
    Object.assign(config.collider, { mode: preset.mode, reaction: preset.reaction, head: preset.head, chest: preset.chest, waist: preset.waist, hip: preset.hip });
    events.emit('collider', name);
    return true;
  }

  function setColliderField(part, field, value) {
    const collider = bodyCollider();
    if (!collider) return false;
    config.collider ||= {};
    config.collider.preset = 'CUSTOM';

    if (part === 'root') {
      collider[field] = value;
      if (field === 'mode') config.collider.mode = Number(value);
    }
    else if (collider[part]) {
      collider[part][field] = value;
      if (field === 'size_percent') config.collider[part] = Number(value);
      if (part === 'head' && field === 'reaction_type') config.collider.reaction = String(value);
    }

    events.emit('collider', 'CUSTOM');
    XRA.profileService.save();
    return true;
  }

  async function calibrate(countdown = null) {
    for (let n = 3; n >= 1; n--) {
      countdown?.(n);
      await util.sleep(700);
    }
    try { window.System?._browser?.camera?.facemesh?.reset_calibration?.(true); }
    catch (e) {}
    captureBodyPose();
    events.emit('calibrated');
    return true;
  }

  function restoreRuntime() {
    const camera = window.System?._browser?.camera;
    if (camera && config.tracking) {
      camera.mocap_data_smoothing = Number(config.tracking.native_smoothing ?? 0);
      if (camera.poseNet) {
        camera.poseNet.body_bend_reduction_power = Number(config.tracking.body_bend_reduction ?? 0);
        // Broken custom/native tracking-loss hiding was removed. Always leave
        // avatar visibility under XR Animator's normal render path.
        try { camera.poseNet.hide_avatar_on_tracking_loss = 0; } catch (e) {}
      }
      if ('avatar_loss_hide_mode' in config.tracking) config.tracking.avatar_loss_hide_mode = 0;
    }

    if (config.collider?.preset && config.collider.preset !== 'CUSTOM') {
      applyColliderPreset(config.collider.preset);
    }
    else {
      const collider = bodyCollider();
      if (collider && config.collider) {
        collider.mode = Number(config.collider.mode ?? 0);
        if (collider.head) {
          collider.head.reaction_type = config.collider.reaction || 'z_push';
          collider.head.size_percent = Number(config.collider.head ?? 100);
        }
        for (const part of ['chest','waist','hip']) if (collider[part]) collider[part].size_percent = Number(config.collider[part] ?? 100);
      }
    }

    config.tracking ||= {};
    config.body ||= {};
    config.tracking.upper_body_guard_strength = 0;

    if (startupLocksPending) {
      handsEnabled = true;
      bodyStable = false;
      bodyAnchorMix = 0;
      bodyTransition = null;
      anchoredMMDBones.clear();
      anchoredVRMBones.clear();
      anchoredAvatarRoots.clear();
      clearGuardState();
    }
    else {
      handsEnabled = config.tracking.hands_enabled !== false;
      const hysteresis = !!config.tracking.motion_hysteresis_enabled;
      config.tracking.guard_mode = hysteresis ? 'guard' : 'off';
      config.tracking.upper_body_guard = hysteresis;
    }

    if (!startupLocksPending && config.body.stable) {
      bodyStable = true;
      captureBodyPose();
      bodyAnchorMix = 1;
    }
    else if (!startupLocksPending) {
      bodyStable = false;
      bodyAnchorMix = 0;
      anchoredAvatarRoots.clear();
    }
    if (!startupLocksPending && config.tracking.motion_hysteresis_enabled) {
      setTimeout(() => captureGuardPose(), 120);
    }
    else if (!startupLocksPending) {
      clearGuardState();
    }
    guardRelease = null;
    faceLossPoseMMD.clear(); faceLossPoseVRM.clear(); resetFaceLossState(true);
    faceSignal.available = false; faceSignal.present = false; faceSignal.confidence = null; faceSignal.source = 'unknown'; faceSignal.lastUpdateAt = 0; faceSignal.lastPresentAt = 0; faceSignal.lastAbsentAt = 0; faceSignal.signature = '';
    poseSignal.available = false; poseSignal.present = false; poseSignal.confidence = null; poseSignal.source = 'unknown'; poseSignal.lastUpdateAt = 0; poseSignal.lastPresentAt = 0; poseSignal.lastAbsentAt = 0; poseSignal.signature = '';
    nativePoseEverDetected = false;
    faceRuntimeSignature = ''; faceRuntimeChangedAt = 0; faceRuntimeEverPresent = false; faceRuntimeLastPresentAt = 0;
    technicalMeshSampleAt = 0; technicalMeshSample = { available:false, present:false, source:'none' }; technicalMeshCandidatesCache = []; technicalMeshCandidatesAt = 0;
    broadcastHands();
    syncSplitHandLandmarker();
    events.emit('tracking-restored');
  }

  function savedStartupLocks() {
    return {
      hands: config.tracking?.hands_enabled === false,
      body: !!config.body?.stable,
      hysteresis: !!config.tracking?.motion_hysteresis_enabled
    };
  }

  function activateSavedStartupLocks() {
    if (!startupLocksPending) return false;
    startupLocksPending = false;
    clearTimeout(startupLocksTimer);
    clearInterval(startupCalibrationPoll);
    startupLocksTimer = startupCalibrationPoll = 0;
    const desired = savedStartupLocks();
    XRA.performance?.finishStartupCalibrationBoost?.();
    restoreRuntime();
    events.emit('hands', handsEnabled);
    events.emit('body-stable', bodyStable);
    events.emit('motion-hysteresis', !!config.tracking?.motion_hysteresis_enabled);
    events.emit('startup-locks-activated', desired);
    return desired.hands || desired.body || desired.hysteresis;
  }

  function scheduleSavedStartupLocks() {
    if (!startupLocksPending || startupLocksTimer) return false;
    clearInterval(startupCalibrationPoll);
    startupCalibrationPoll = 0;
    events.emit('startup-locks-delay', { delay: STARTUP_LOCK_DELAY_MS, ...savedStartupLocks() });
    startupLocksTimer = setTimeout(activateSavedStartupLocks, STARTUP_LOCK_DELAY_MS);
    return true;
  }

  function nativeCalibrationComplete() {
    const camera = window.System?._browser?.camera;
    if (!camera?.initialized && !camera?.video_track && !camera?.video?.srcObject) return false;
    const facemesh = camera.facemesh;
    if (!facemesh || facemesh.enabled === false) return false;
    return !!facemesh.calibrated;
  }

  function watchStartupCalibration() {
    if (!startupLocksPending || startupLocksTimer || startupCalibrationPoll) return;
    if (nativeCalibrationComplete()) return void scheduleSavedStartupLocks();
    startupCalibrationPoll = setInterval(() => {
      if (!startupLocksPending) return clearInterval(startupCalibrationPoll);
      if (nativeCalibrationComplete()) scheduleSavedStartupLocks();
    }, 500);
  }

  window.addEventListener('SA_camera_facemesh_calibrating', event => {
    XRA.performance?.installNeckCalibrationBridge?.();
    if (!startupLocksPending) return;
    const percent = Number(event.detail?.percent);
    if (!Number.isFinite(percent)) return;
    if (percent >= 100) {
      startupCalibrationInProgress = false;
      XRA.nativeBridge?.dismissCalibrationNotices?.();
      scheduleSavedStartupLocks();
      return;
    }
    startupCalibrationInProgress = true;
    if (startupLocksTimer) {
      clearTimeout(startupLocksTimer);
      startupLocksTimer = 0;
      watchStartupCalibration();
    }
  });

  window.addEventListener('SA_camera_poseNet_process_bones_onended', () => applyPoseLocks('pose-ended'));
  // Run the loss lock in the same native lifecycle event, after XR Animator has
  // applied the current detector result. This guarantees that an invalid frame
  // is overwritten before it can reach the VRM, including builds where
  // SA_MMD_before_render is not emitted for the active avatar renderer.
  window.addEventListener('SA_camera_poseNet_process_bones_onended', applyHeadLossGuard);
  window.addEventListener('SA_MMD_before_render', () => applyPoseLocks('before-render'));
  // The final-render lock covers the full skeletal pose. It does not touch
  // morph targets, so microphone lip-sync remains live while tracking is held.
  window.addEventListener('SA_MMD_before_render', applyHeadLossGuard);
  window.addEventListener('MMDStarted', () => {
    setTimeout(restoreRuntime, 850);
    setTimeout(restoreRuntime, 2500);
    setTimeout(watchStartupCalibration, 500);
  });

  events.on('profile-loaded', () => {
    setTimeout(restoreRuntime, 650);
    setTimeout(watchStartupCalibration, 750);
  });
  events.on('camera-started', watchStartupCalibration);
  // A VRM swap replaces the skeleton behind model index 0. Snapshots captured
  // from the previous avatar are not portable: applying those rotations during
  // a tracking loss can tear the new model apart. Rebuild every guard only
  // after the native swap has completed.
  events.on('avatar-changed', () => {
    clearGuardState();
    faceLossPoseMMD.clear(); faceLossPoseVRM.clear(); resetFaceLossState(true);
    neutralLeftArmMMD.clear(); neutralRightArmMMD.clear();
    leftArmTransition = null; rightArmTransition = null;
    leftArmTransitionFrom.clear(); rightArmTransitionFrom.clear();
    setTimeout(restoreRuntime, 450);
    setTimeout(restoreRuntime, 1200);
  });
  function nativeMotionIdentity(manager) {
    if (!manager) return '';
    const filename = String(manager.filename || '');
    const upperBody = !!manager.para_SA?.motion_tracking_upper_body_only;
    return `${filename}::${upperBody ? 'upper' : 'full'}`;
  }

  // XR Animator also emits this event when a short looping motion wraps back
  // to frame zero. That is not a pose change: suspending stabilization on each
  // loop used to release and recapture the body anchor roughly once a second.
  let lastNativeMotionIdentity = nativeMotionIdentity(window.MMD_SA?.MMD?.motionManager);
  window.addEventListener('SA_MMD_model0_onmotionchange', event => {
    const manager = event.detail?.motion_new || window.MMD_SA?.MMD?.motionManager;
    const identity = nativeMotionIdentity(manager);
    const previousIdentity = lastNativeMotionIdentity || nativeMotionIdentity(event.detail?.motion_old);
    const logicalChange = !!identity && identity !== previousIdentity;
    if (identity) lastNativeMotionIdentity = identity;
    XRA.debug?.record('tracking.native-motion-change', {
      motion:manager?.filename || null,
      identity:identity || null,
      previous_identity:previousIdentity || null,
      logical_change:logicalChange,
      body_stable:bodyStable
    });
    if (bodyStable && logicalChange) {
      suspendForPoseChange();
      setTimeout(() => {
        resumeAfterPoseChange();
      }, 350);
    }
  });
  events.on('pipeline', () => {
    setTimeout(broadcastHands, 300);
    setTimeout(syncSplitHandLandmarker, 650);
  });
  events.on('startup-calibration-boost', payload => {
    if (!payload?.active && startupLocksPending) {
      activateSavedStartupLocks();
    }
  });

  // Worker may be created after this module.
  setTimeout(broadcastHands, 500);
  setTimeout(broadcastHands, 1500);
  setTimeout(broadcastHands, 3000);

  function faceTrackingState() {
    if (!facemeshEnabled()) return { enabled:false, available:false, present:false, source:'facemesh-disabled' };
    const evidence = headTrackingEvidence();
    if (evidence.available) return { enabled:true, ...evidence, frozen:!!headLost };
    // Do not mark a visibly working face tracker as degraded just because the
    // technical preview canvas is not inspectable on this XR Animator build.
    return { enabled:true, available:false, present:true, source:'enabled-unknown', frozen:!!headLost };
  }

  function faceMeshState() {
    if (!facemeshEnabled()) return { enabled:false, available:false, present:false, source:'facemesh-disabled' };
    const sample = technicalFaceMeshEvidence();
    return { enabled:true, ...sample, frozen:!!headLost };
  }

  XRA.tracking = {
    setHands,
    broadcastHands,
    broadcastTrackingState,
    captureFrozenArms,
    captureBodyPose,
    setBodyStable,
    setBodyStabilization,
    setUpperBodyGuard,
    setMotionHysteresis,
    setGuardMode,
    setUpperBodyGuardStrength,
    captureGuardPose,
    setFreezeHeadOnFaceLoss,
    setFreezePoseOnTrackingLoss: setFreezeHeadOnFaceLoss,
    calibrate,
    applyColliderPreset,
    setColliderField,
    bodyCollider,
    COLLIDER_PRESETS,
    restoreRuntime,
    suspendForPoseChange,
    resumeAfterPoseChange,
    get handsEnabled() { return handsEnabled; },
    get bodyStable() { return bodyStable; },
    get bodyTransitioning() { return !!bodyTransition; },
    get bodyAnchorMix() { return bodyAnchorMix; },
    get startupLocksPending() { return startupLocksPending; },
    get upperBodyGuard() { return guardMode() !== 'off'; },
    get motionHysteresis() { return !!(!startupLocksPending && config.tracking?.motion_hysteresis_enabled); },
    get guardMode() { return guardMode(); },
    get guardHoldActive() { return !!guardInvalidSince; },
    get guardLastRejectedDegrees() { return guardLastRejected; },
    get guardConfidence() { return guardConfidence; },
    get guardMeasuredConfidence() { return guardMeasuredConfidence; },
    get guardLastJumpDegrees() { return guardLastJump; },
    get guardReleasing() { return !!guardRelease; },
    get freezeHeadOnFaceLoss() { return !!config.tracking?.freeze_head_on_face_loss; },
    get headFrozenOnLoss() { return !!headLost; },
    get trackingLost() { return !!headLost; },
    trackingState: bodyTrackingEvidence,
    faceMeshState,
    faceTrackingState,
    get faceMeshEnabled() { return facemeshEnabled(); }

  };

})();
