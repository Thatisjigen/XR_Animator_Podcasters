// XRA_UNIVERSAL_RUNTIME_V9
(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA PERF]';
  const { config, events, util } = XRA;

  const PRESETS = {
    // ECO is the real low-end profile. MINIMAL remains as a legacy alias so old
    // profiles continue to load, but the UI now exposes ECO instead.
    ECO:      { cam: [424, 240, 20], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Full Body', rates: [15, 10] },
    MINIMAL:  { cam: [424, 240, 20], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Full Body', rates: [15, 10] },
    LOW:      { cam: [640, 360, 24], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Full Body', rates: [20, 12] },
    BALANCED: { cam: [640, 480, 30], pose: 'Normal', lip: [512, 30],  post: false, native: 'Full Body', rates: [30, 20] },
    QUALITY:  { cam: [1280,720, 30], pose: 'Normal', lip: [1024, 30], post: false, native: 'Full Body', rates: [30, 30] },
    HIGH:     { cam: [1280,720, 30], pose: 'Best',   lip: [1024, 30], post: false, native: 'Full Body', rates: [60, 30] },
    MAX:      { cam: [1280,720, 60], pose: 'Best',   lip: [2048, 60], post: false, native: 'Full Body', rates: [60, 60] }
  };

  // V7.81: the startup "MediaPipe Vision Full Body" calibration boost is
  // retired (see 00_core.js). External backends ship full 3D landmarks + standard
  // casing, so we boot straight into the configured engine. Keep the object as a
  // thin shim marked completed so the legacy guards below are inert.
  const startupCalibration = XRA.startupCalibration ||= {
    active: false,
    completed: true,
    native: 'Full Body'
  };
  startupCalibration.active = false;
  startupCalibration.completed = true;

  let postFXBaseline = null;
  let controlChannel = null;
  try { controlChannel = new BroadcastChannel('XRA_CONTROL'); }
  catch (e) { console.warn(TAG, 'BroadcastChannel unavailable', e); }

  function applyCameraSettings() {
    const opts = window.MMD_SA_options?.user_camera;
    if (!opts) return false;

    if (config.camera.optimized) {
      opts.pixel_limit ||= {};
      opts.pixel_limit.disabled = false;
      opts.pixel_limit.current = [config.camera.width, config.camera.height];
      opts.fps = { ideal: config.camera.fps };
    }
    else {
      const saved = XRA.profile?.XR_Animator_settings?.user_camera;
      opts.pixel_limit ||= {};
      opts.pixel_limit.disabled = saved?.pixel_limit?.disabled !== false;
      opts.pixel_limit.current = saved?.pixel_limit?.current || null;
      opts.fps = saved?.fps || null;
    }

    if (opts.ML_models?.pose) {
      opts.ML_models.pose.model_quality = config.pose_model;
    }

    const camera = window.System?._browser?.camera;
    const constraints = camera?.set_constraints?.();
    if (constraints) {
      // V7.6: camera mutations are serialized by nativeBridge. Re-applying
      // constraints concurrently with a restart/device switch is a common
      // source of black/vanishing webcam previews on Linux/V4L2.
      if (XRA.nativeBridge?.applyCameraConstraintsSafe) {
        XRA.nativeBridge.applyCameraConstraintsSafe(constraints, { recover: true }).catch(e => {
          console.warn(TAG, 'safe camera constraints failed', e);
        });
      }
      else if (camera?.video_track?.applyConstraints) {
        camera.video_track.applyConstraints(constraints).catch(e => {
          console.warn(TAG, 'camera constraints failed', e);
        });
      }
    }
    return true;
  }

  function capturePostFXBaseline() {
    if (postFXBaseline || !window.MMD_SA?.THREEX?.PPE) return;
    postFXBaseline = {};
    for (const name of ['UnrealBloom', 'N8AO', 'DOF']) {
      try {
        const fx = MMD_SA.THREEX.PPE[name];
        if (fx) postFXBaseline[name] = !!fx.enabled;
      }
      catch (e) {}
    }
  }

  function setPostFXDisabled(disabled) {
    if (!window.MMD_SA?.THREEX?.PPE) return false;
    if (disabled) capturePostFXBaseline();

    for (const name of ['UnrealBloom', 'N8AO', 'DOF']) {
      try {
        const fx = MMD_SA.THREEX.PPE[name];
        if (!fx) continue;
        if (disabled) fx.enabled = false;
        else if (postFXBaseline && name in postFXBaseline) fx.enabled = !!postFXBaseline[name];
      }
      catch (e) {}
    }
    return true;
  }

  let runtimePoseFps = null;
  let runtimeHandFps = null;
  let telemetry = null;
  let monitorRAF = 0;
  let monitorFrames = 0;
  let monitorLong = 0;
  let monitorSum = 0;
  let monitorWindowStart = 0;
  let monitorLastFrame = 0;
  let monitorBaselineFps = 0;
  let stableWindows = 0;
  let adaptiveState = 'base';
  let diagnosticsHud = null;
  let diagnosticsLastPaint = 0;
  const diagnostics = { fps: 0, frame_ms: 0, long_pct: 0 };

  if (controlChannel) {
    controlChannel.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'mocap_rates_request') sendInferenceRates();
      if (data.type === 'mocap_telemetry') telemetry = data;
    };
  }

  function effectivePoseFps() {
    return Number(runtimePoseFps ?? config.performance.pose_fps ?? 30);
  }

  function effectiveHandFps() {
    return Number(runtimeHandFps ?? config.performance.hand_fps ?? 20);
  }

  function sendInferenceRates() {
    controlChannel?.postMessage({
      type: 'mocap_rates',
      pose_fps: effectivePoseFps(),
      hand_fps: XRA.xraBackend?.snapshot?.()?.active === true ? effectivePoseFps() : effectiveHandFps()
    });
  }

  function resetAdaptiveRates() {
    runtimePoseFps = null;
    runtimeHandFps = null;
    adaptiveState = 'base';
    stableWindows = 0;
    sendInferenceRates();
  }

  function adaptiveStep(fps, longPct) {
      if (!config.performance?.runtime_adaptive) {
        if (runtimePoseFps != null || runtimeHandFps != null) resetAdaptiveRates();
        return;
      }

      const basePose = Math.max(5, Number(config.performance.pose_fps || 30));
      const baseHand = Math.max(5, Number(config.performance.hand_fps || 20));
      const backend = XRA.xraBackend?.snapshot?.() || {};
      const external = backend.active === true;
      const inferMs = Number(backend.capture?.last_infer_ms || 0);

      runtimePoseFps ??= basePose;
      runtimeHandFps ??= baseHand;
      runtimePoseFps = Math.min(runtimePoseFps, basePose);
      runtimeHandFps = Math.min(runtimeHandFps, baseHand);

      if (external && Number.isFinite(inferMs) && inferMs > 0) {
        // 25% headroom: inference should not own the whole frame budget.
        let safePose = Math.floor(1000 / Math.max(1, inferMs * 1.25));
        safePose = Math.max(5, Math.min(basePose, safePose));
        if (fps < Math.max(20, monitorBaselineFps * .80) || longPct > 18) {
          safePose = Math.max(5, safePose - 2);
        }

        const previous = runtimePoseFps;
        if (safePose <= runtimePoseFps - 2) {
          runtimePoseFps = safePose;
          stableWindows = 0;
        }
        else if (safePose > runtimePoseFps) {
          stableWindows++;
          if (stableWindows >= 2) {
            runtimePoseFps = Math.min(safePose, runtimePoseFps + 2);
            stableWindows = 0;
          }
        }
        else {
          stableWindows = Math.min(2, stableWindows + 1);
        }

        // External wholebody models produce hands in the same inference pass.
        runtimeHandFps = runtimePoseFps;
        adaptiveState = runtimePoseFps === basePose
          ? 'backend base'
          : `backend ${runtimePoseFps} Hz (${inferMs.toFixed(0)} ms)`;
        if (previous !== runtimePoseFps) sendInferenceRates();
        return;
      }

      // Browser/native fallback keeps the existing render-pressure behaviour.
      monitorBaselineFps = Math.max(monitorBaselineFps * .995, fps);
      const baseline = Math.max(24, monitorBaselineFps || fps);
      const stressed = fps < baseline * .82 || longPct > 18;
      const healthy = fps > baseline * .93 && longPct < 8;
      if (stressed) {
        stableWindows = 0;
        if (runtimeHandFps > Math.max(8, baseHand - 10)) {
          runtimeHandFps = Math.max(8, runtimeHandFps - 5);
          adaptiveState = `hands ${runtimeHandFps} Hz`;
        }
        else if (runtimePoseFps > Math.max(10, basePose - 15)) {
          runtimePoseFps = Math.max(10, runtimePoseFps - 5);
          adaptiveState = `pose ${runtimePoseFps} Hz`;
        }
        sendInferenceRates();
      }
      else if (healthy) {
        stableWindows++;
        if (stableWindows >= 2) {
          stableWindows = 0;
          const oldPose = runtimePoseFps, oldHand = runtimeHandFps;
          if (runtimePoseFps < basePose) runtimePoseFps = Math.min(basePose, runtimePoseFps + 5);
          else if (runtimeHandFps < baseHand) runtimeHandFps = Math.min(baseHand, runtimeHandFps + 5);
          adaptiveState = runtimePoseFps === basePose && runtimeHandFps === baseHand ? 'base' : 'recovering';
          if (oldPose !== runtimePoseFps || oldHand !== runtimeHandFps) sendInferenceRates();
        }
      }
    }

  function ensureDiagnosticsHud() {
    if (diagnosticsHud?.isConnected) return diagnosticsHud;
    const node = document.createElement('div');
    node.className = 'xra-diagnostics-hud';
    node.hidden = true;
    document.body.appendChild(node);
    diagnosticsHud = node;
    return node;
  }

  function paintDiagnostics(now) {
    const node = ensureDiagnosticsHud();
    const visible = !!config.performance?.diagnostics_hud;
    node.hidden = !visible;
    if (!visible || now - diagnosticsLastPaint < 450) return;
    diagnosticsLastPaint = now;
    const rec = XRA.recorder?.status?.() || {};
    const gate = Number.isFinite(Number(rec.gate_db)) ? `${Number(rec.gate_db).toFixed(1)} dB ${rec.gate_open ? 'OPEN' : 'CLOSED'}` : '—';
    const worker = telemetry
      ? `${Number(telemetry.inference_ms || 0).toFixed(1)} ms · ${Number(telemetry.fps || 0).toFixed(1)} fps`
      : '—';
    node.textContent =
      `Render ${diagnostics.fps.toFixed(1)} FPS · ${diagnostics.frame_ms.toFixed(1)} ms · long ${diagnostics.long_pct.toFixed(1)}%\n` +
      `Pose ${effectivePoseFps()} Hz · Hands ${effectiveHandFps()} Hz · Adaptive ${config.performance?.runtime_adaptive ? adaptiveState : 'OFF'}\n` +
      `Worker ${worker}\n` +
      `REC ${rec.active ? `${Number(rec.draw_fps || 0).toFixed(1)} fps · dropped≈${Number(rec.dropped_frames_estimate || 0)}` : 'OFF'} · Mic ${gate}\n` +
      `Torso confidence ${Number(XRA.tracking?.guardConfidence ?? 1).toFixed(2)}`;
  }

  function runtimeMonitorFrame(now) {
    monitorRAF = 0;
    if (!(config.performance?.runtime_adaptive || config.performance?.diagnostics_hud)) return;
    if (!monitorWindowStart) {
      monitorWindowStart = now;
      monitorLastFrame = now;
    }
    const dt = now - monitorLastFrame;
    monitorLastFrame = now;
    if (dt > 0 && dt < 1000) {
      monitorFrames++;
      monitorSum += dt;
      if (dt > 34) monitorLong++;
    }

    if (now - monitorWindowStart >= 2000) {
      diagnostics.frame_ms = monitorFrames ? monitorSum / monitorFrames : 0;
      diagnostics.fps = diagnostics.frame_ms ? 1000 / diagnostics.frame_ms : 0;
      diagnostics.long_pct = monitorFrames ? 100 * monitorLong / monitorFrames : 0;
      adaptiveStep(diagnostics.fps, diagnostics.long_pct);
      monitorFrames = monitorLong = 0;
      monitorSum = 0;
      monitorWindowStart = now;
    }
    paintDiagnostics(now);
    monitorRAF = requestAnimationFrame(runtimeMonitorFrame);
  }

  function ensureRuntimeMonitor() {
    const enabled = !!(config.performance?.runtime_adaptive || config.performance?.diagnostics_hud);
    controlChannel?.postMessage({ type: 'benchmark_telemetry', value: !!config.performance?.diagnostics_hud });
    if (enabled && !monitorRAF) {
      monitorWindowStart = monitorFrames = monitorLong = monitorSum = 0;
      monitorLastFrame = 0;
      monitorRAF = requestAnimationFrame(runtimeMonitorFrame);
    }
    else if (!enabled) {
      if (monitorRAF) cancelAnimationFrame(monitorRAF);
      monitorRAF = 0;
      ensureDiagnosticsHud().hidden = true;
      resetAdaptiveRates();
    }
  }

  function setRuntimeAdaptive(enabled) {
    config.performance.runtime_adaptive = !!enabled;
    if (!enabled) resetAdaptiveRates();
    ensureRuntimeMonitor();
    XRA.profileService.save();
    events.emit('runtime-adaptive', !!enabled);
  }

  function setDiagnosticsHud(enabled) {
    config.performance.diagnostics_hud = !!enabled;
    ensureRuntimeMonitor();
    XRA.profileService.save();
    events.emit('diagnostics-hud', !!enabled);
  }

  function apply({ camera = true, postfx = true, rates = true } = {}) {
    if (camera) applyCameraSettings();
    if (postfx) setPostFXDisabled(!!config.performance.disable_postfx);
    if (rates) sendInferenceRates();
    events.emit('performance-applied', config.performance);
  }

  function currentNativeType() {
    return window.MMD_SA_options?.user_camera?.streamer_mode?.mocap_type || null;
  }

  function initNative(type) {
    const sm = window.System?._browser?.camera?.streamer_mode;
    if (!sm?.init_mocap) throw new Error('init_mocap unavailable');
    sm.init_mocap(type);
    if (window.MMD_SA_options?.user_camera?.streamer_mode) {
      MMD_SA_options.user_camera.streamer_mode.mocap_type = type;
    }
    return type;
  }

  // V7.81: pre-allocate the body/pose solver structures at boot regardless of
  // the initially selected mode. Historically, booting directly into "Face"
  // only enabled the facemesh path, leaving the pose worker, IK state and
  // landmark buffers unallocated; switching to Full Body at runtime then failed
  // to track the body because the one-time allocation had been skipped.
  //
  // We therefore run init_mocap('Full Body') exactly once (which allocates the
  // poseNet solver + IK + landmark filters), then immediately re-apply the
  // configured mode. This is a no-op if the configured mode IS Full Body.
  let trackingStructuresPreallocated = false;
  function preallocateTrackingStructures() {
    if (trackingStructuresPreallocated) return false;
    const camera = window.System?._browser?.camera;
    const sm = camera?.streamer_mode;
    if (!camera?.initialized || !sm?.init_mocap) return false;

    const target = config.performance?.tracking_pipeline === 'FACE' ? 'Face' : 'Full Body';
    try {
      // Allocate ALL body/pose structures + IK state + landmark buffers.
      initNative('Full Body');
      // Restore the user's configured mode (no-op when it is Full Body).
      if (target !== 'Full Body') initNative(target);
      trackingStructuresPreallocated = true;
      events.emit('tracking-structures-ready', { target });
      XRA.debug?.record?.('startup.tracking-structures-preallocated', { target });
      return true;
    }
    catch (e) {
      console.warn(TAG, 'tracking structure pre-allocation failed', e);
      return false;
    }
  }

  function pipelineNameFromNative(native) {
    if (native === 'Face') return 'FACE';
    return 'FULL_BODY';
  }

  function nativeFromPipeline(name) {
    name = String(name || '').toUpperCase();
    if (name === 'FACE') return 'Face';
    return 'Full Body';
  }

  let startupMocapTriggered = false;
  let calibrationListenerAttached = false;
  let startupSafetyTimer = 0;
  let startupGuardedStreamer = null;
  let startupMocapWatchTimer = 0;

  function prepareStartupMocap(reason = 'startup') {
    if (!startupCalibration.active || startupCalibration.completed) return false;
    XRA.profileService?.assertStartupNativeOptions?.();
    XRA.profileService?.assertStartupNativeOptions?.(window.MMD_SA_options?._XRA_settings_imported);
    const mode = window.MMD_SA_options?.user_camera?.streamer_mode;
    if (mode) mode.mocap_type = 'Full Body';
    XRA.debug?.sample?.('startup.mocap-prepared', 'startup.mocap-prepared', {
      reason,
      native:'Full Body',
      camera_initialized:!!window.System?._browser?.camera?.initialized,
      streamer_running:!!window.System?._browser?.camera?.streamer_mode?.running
    }, 1000);
    return !!mode;
  }

  function installStartupMocapStartGuard() {
    const sm = window.System?._browser?.camera?.streamer_mode;
    if (!sm || typeof sm.start !== 'function') return false;
    if (sm === startupGuardedStreamer) return true;

    const originalStart = sm.start;
    try {
      sm.start = function (...args) {
        prepareStartupMocap('before-native-start');
        return originalStart.apply(this, args);
      };
      startupGuardedStreamer = sm;
      return true;
    }
    catch (error) {
      console.warn(TAG, 'Unable to guard native mocap start', error);
      return false;
    }
  }

  function dismissCalibrationNotices() {
    // Native code can publish the final 100% line just after our listener.
    // Repeating the idempotent dismissal covers that last queued update too.
    for (const delay of [0, 120, 700, 2200]) {
      setTimeout(() => XRA.nativeBridge?.dismissCalibrationNotices?.(), delay);
    }
  }

  function installNeckCalibrationBridge() {
    const camera = window.System?._browser?.camera;
    const facemesh = camera?.facemesh;
    if (!facemesh || facemesh._neck_bridge_installed) return !!facemesh?._neck_bridge_installed;

    const origCalculateNeckData = facemesh.calculate_neck_data;
    if (typeof origCalculateNeckData !== 'function') return false;

    facemesh._neck_bridge_installed = true;
    let lastPoseNeck = null;

    facemesh.calculate_neck_data = function (t) {
      if (!t) return false;
      if (t.is_pose) lastPoseNeck = t;

      // During calibration, ensure facemesh neck samples are always paired with pose data
      // even when seated at a desk or when timestamps differ across workers.
      if (!this.calibrated && t.is_face) {
        const neckData = this._neck?.data;
        if (Array.isArray(neckData)) {
          const match = neckData.find(e => e.timestamp === t.timestamp);
          if (!match) {
            const faceWidth = (Number(t.face_width) > 0) ? Number(t.face_width) : 100;
            const fallbackShoulder = (Array.isArray(t.f_axis) && t.f_axis.length >= 2 && Number.isFinite(t.f_axis[0]) && Number.isFinite(t.f_axis[1]))
              ? [t.f_axis[0], t.f_axis[1] + faceWidth * 1.25, 0]
              : [0, -faceWidth * 1.25, 0];
            const shoulder = (Array.isArray(lastPoseNeck?.shoulder_center) && lastPoseNeck.shoulder_center.every(Number.isFinite))
              ? lastPoseNeck.shoulder_center
              : ((Array.isArray(this._neck?.shoulder_center) && this._neck.shoulder_center.every(Number.isFinite))
                ? this._neck.shoulder_center
                : fallbackShoulder);
            const spine = (Array.isArray(lastPoseNeck?.spine_rot_absolute) && lastPoseNeck.spine_rot_absolute.every(Number.isFinite))
              ? lastPoseNeck.spine_rot_absolute
              : ((Array.isArray(this._neck?._spine_rot_absolute) && this._neck._spine_rot_absolute.every(Number.isFinite))
                ? this._neck._spine_rot_absolute
                : [0, 0, 0]);

            neckData.unshift({
              is_pose: true,
              timestamp: t.timestamp,
              shoulder_center: shoulder,
              spine_rot_absolute: spine
            });
          }
        }
      }

      return origCalculateNeckData.call(this, t);
    };

    console.log(TAG, 'Neck calibration bridge installed successfully');
    return true;
  }

  function installStartupCalibrationListener() {
    if (calibrationListenerAttached) return;
    calibrationListenerAttached = true;

    function onCalibrationEvent(e) {
      if (!startupCalibration.active) {
        window.removeEventListener('SA_camera_facemesh_calibrating', onCalibrationEvent);
        calibrationListenerAttached = false;
        return;
      }

      const percent = Math.round(Number(e.detail?.percent || 0));
      if (percent >= 100) {
        window.removeEventListener('SA_camera_facemesh_calibrating', onCalibrationEvent);
        calibrationListenerAttached = false;
        clearTimeout(startupSafetyTimer);
        startupSafetyTimer = 0;
        events.emit('calibrated', { percent });
        dismissCalibrationNotices();
        setTimeout(() => finishStartupCalibrationBoost(), 500);
      }
    }

    window.addEventListener('SA_camera_facemesh_calibrating', onCalibrationEvent);
  }

  function selectStartupMocap() {
    if (startupMocapTriggered || !startupCalibration.active || startupCalibration.completed) return false;

    prepareStartupMocap('select');
    installStartupMocapStartGuard();
    const camera = window.System?._browser?.camera;
    const sm = camera?.streamer_mode;
    if (!camera?.initialized || !sm?.init_mocap || !camera?.facemesh) return false;

    installNeckCalibrationBridge();
    installStartupCalibrationListener();

    // Diagnose a stalled calibration, but keep Full Body active until native
    // calibration really completes as requested. A time limit must not silently
    // restore the saved pipeline while the user is still calibrating.
    if (!startupSafetyTimer) {
      startupSafetyTimer = setTimeout(() => {
        if (startupCalibration.active) {
          console.warn(TAG, 'Startup calibration is still waiting after 60s; keeping Full Body active');
          XRA.debug?.record('startup.calibration-waiting', { elapsed_ms:60000, native:'Full Body' });
        }
      }, 60000);
    }

    // Select the engine once even if the camera is already running. Merely
    // changing mocap_type updates the menu but does not create the Full Body
    // MediaPipe workers, which is why a manual selection + restart was needed.
    try {
      console.log(TAG, 'Selecting startup mocap engine: Full Body (MediaPipe Vision)...');
      initNative('Full Body');
      startupMocapTriggered = true;
    }
    catch (e) {
      console.warn(TAG, 'initNative Full Body failed', e);
      return false;
    }

    events.emit('startup-calibration-boost', { active: true, native: 'Full Body', running:!!sm.running });
    return true;
  }

  function ensureStartupCalibrationBoost() {
    return selectStartupMocap();
  }

  function finishStartupCalibrationBoost() {
    dismissCalibrationNotices();
    if (!startupCalibration.active) return false;
    startupCalibration.active = false;
    startupCalibration.completed = true;
    clearTimeout(startupSafetyTimer);
    startupSafetyTimer = 0;
    clearInterval(startupMocapWatchTimer);
    startupMocapWatchTimer = 0;

    // Restore saved tracking pipeline exactly as when selected manually
    const rawSaved = XRA.profile?.custom?.performance?.tracking_pipeline || config.performance?.tracking_pipeline || 'FULL_BODY';
    const savedPipeline = rawSaved === 'SPLIT' || rawSaved === 'HOLISTIC' ? 'FULL_BODY' : rawSaved;
    const savedNative = nativeFromPipeline(savedPipeline);
    config.performance.tracking_pipeline = pipelineNameFromNative(savedNative);

    console.log(TAG, `Startup calibration complete! Restoring saved mocap: ${savedNative} (${savedPipeline})`);

    XRA.profileService?.finishStartupNativeOverride?.();
    apply();

    try {
      if (savedNative && savedNative !== 'Full Body') {
        initNative(savedNative);
        if (window.MMD_SA?.MMD?.motionManager && !window.MMD_SA.MMD.motionManager.para_SA?.motion_tracking_enabled) {
          window.MMD_SA_options?.Dungeon_options?.item_base?.pose?._change_motion_?.(0, true);
        }
      }
      else if (window.MMD_SA_options?.user_camera?.streamer_mode) {
        MMD_SA_options.user_camera.streamer_mode.mocap_type = savedNative;
      }
    }
    catch (e) {
      console.warn(TAG, 'saved mocap restore after calibration failed', e);
      if (window.MMD_SA_options?.user_camera?.streamer_mode) {
        MMD_SA_options.user_camera.streamer_mode.mocap_type = savedNative;
      }
    }

    events.emit('pipeline', { native: savedNative, name: config.performance.tracking_pipeline });
    events.emit('startup-calibration-boost', { active: false, native: savedNative });
    XRA.ui?.refresh?.();
    return true;
  }

  async function poseExists(quality) {
    if (quality === 'Normal') return true;
    const suffix = quality === 'Lite' ? 'lite' : 'heavy';
    try {
      const r = await fetch(`/js/@mediapipe/tasks/pose_landmarker_${suffix}.task`, {
        method: 'HEAD', cache: 'no-store'
      });
      return r.ok;
    }
    catch (e) { return false; }
  }

  async function ensurePoseQuality(quality) {
    if (await poseExists(quality)) return quality;
    console.warn(TAG, quality, 'task missing; falling back to Normal');
    return 'Normal';
  }

  function copyPresetValues(name, poseOverride = null) {
    const preset = PRESETS[name];
    if (!preset) return false;

    const pose = poseOverride || preset.pose;
    config.camera.optimized = true;
    [config.camera.width, config.camera.height, config.camera.fps] = preset.cam;
    config.pose_model = pose;
    config.lip.optimized = true;
    [config.lip.fft_size, config.lip.analysis_fps] = preset.lip;
    config.performance.disable_postfx = preset.post;
    if (Array.isArray(preset.rates)) {
      [config.performance.pose_fps, config.performance.hand_fps] = preset.rates;
      runtimePoseFps = runtimeHandFps = null;
    }
    return true;
  }

  // Safe for startup: applies performance values but never calls init_mocap.
  async function applyPresetSafe(name) {
    name = String(name || '').toUpperCase();
    const preset = PRESETS[name];
    if (!preset) return false;

    const pose = await ensurePoseQuality(preset.pose);
    copyPresetValues(name, pose);
    config.performance.master_preset = name;
    apply();
    await XRA.profileService.save(0);
    events.emit('preset', { name, safe: true, pipeline: currentNativeType() });
    return true;
  }

  // Explicit runtime action only. E1 remains disabled; no startup/load auto-init.
  async function applyMasterPreset(name, { switchPipeline = true } = {}) {
    name = String(name || '').toUpperCase();
    if (name === 'CUSTOM') {
      config.performance.master_preset = 'CUSTOM';
      await XRA.profileService.save();
      events.emit('preset', { name: 'CUSTOM', safe: false, pipeline: currentNativeType() });
      return true;
    }

    const preset = PRESETS[name];
    if (!preset) return false;
    const pose = await ensurePoseQuality(preset.pose);
    copyPresetValues(name, pose);
    config.performance.master_preset = name;
    apply();

    if (switchPipeline) {
      initNative(preset.native);
      config.performance.tracking_pipeline = pipelineNameFromNative(preset.native);
      await util.sleep(1200);
    }

    await XRA.profileService.save(0);
    events.emit('preset', { name, safe: !switchPipeline, pipeline: currentNativeType() });
    return true;
  }

  async function measureFrames(ms = 1700) {
    let frames = 0;
    let longFrames = 0;
    let last = performance.now();
    let sum = 0;
    const start = last;

    await new Promise(resolve => {
      function frame(t) {
        const dt = t - last;
        last = t;
        sum += dt;
        frames++;
        if (dt > 34) longFrames++;
        if (t - start < ms) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });

    return {
      fps: frames ? 1000 / (sum / frames) : 0,
      longPct: frames ? 100 * longFrames / frames : 100
    };
  }

  async function benchmarkHardwareOnly() {
    const frame = await measureFrames(1800);
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    let preset = 'LOW';
    if (frame.fps > 52 && cores >= 8 && memory >= 8) preset = 'HIGH';
    else if (frame.fps > 27 && cores >= 4) preset = 'BALANCED';
    else if (frame.fps > 20) preset = 'LOW';
    else preset = 'ECO';
    return { ...frame, cores, memory, preset };
  }

  // Explicit runtime AUTO: tested E2 behavior. Never called automatically at startup/load.
  async function autoRuntime(status = () => {}) {
    const original = currentNativeType();
    status('AUTO: testing Split…');
    initNative('Face+Body');
    await util.sleep(2200);
    const split = await measureFrames();

    status(`AUTO: Split ${split.fps.toFixed(1)} fps · testing Full Body…`);
    initNative('Full Body');
    await util.sleep(2200);
    const full = await measureFrames();

    const chosen = split.fps >= full.fps ? 'Face+Body' : 'Full Body';
    const best = Math.max(split.fps, full.fps);
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;

    let preset = 'LOW';
    if (best > 52 && cores >= 8 && memory >= 8) preset = 'HIGH';
    else if (best > 27 && cores >= 4) preset = 'BALANCED';
    else if (best > 20) preset = 'LOW';
    else preset = 'ECO';

    const spec = PRESETS[preset];
    const pose = await ensurePoseQuality(spec.pose);
    copyPresetValues(preset, pose);
    config.performance.master_preset = 'AUTO';
    config.performance.auto_last_result = {
      split_fps: split.fps,
      full_fps: full.fps,
      pipeline: chosen,
      resolved_preset: preset,
      previous_pipeline: original
    };
    config.performance.tracking_pipeline = pipelineNameFromNative(chosen);
    apply();

    if (currentNativeType() !== chosen) {
      initNative(chosen);
      await util.sleep(1200);
    }

    await XRA.profileService.save(0);
    status(`AUTO → ${preset} / ${chosen}\nSplit ${split.fps.toFixed(1)} · Full ${full.fps.toFixed(1)} fps`);
    events.emit('preset', { name: 'AUTO', pipeline: chosen, result: config.performance.auto_last_result });
    return config.performance.auto_last_result;
  }


  async function setMocapMode(native) {
    if (native === 'Full Body Holistic' || native === 'Face+Body') native = 'Full Body';
    const allowed = new Set(['Face', 'Full Body']);
    if (!allowed.has(native)) throw new Error('Unsupported mocap mode: ' + native);
    // Ensure body/pose solvers exist even if the app booted into Face only,
    // so a runtime switch to Full Body can track the body immediately.
    preallocateTrackingStructures();
    initNative(native);
    config.performance.tracking_pipeline = pipelineNameFromNative(native);
    await util.sleep(900);
    await XRA.profileService.save();
    events.emit('pipeline', { native, name: config.performance.tracking_pipeline });
    return native;
  }

  async function setPipeline(name) {
    const native = nativeFromPipeline(name);
    preallocateTrackingStructures();
    initNative(native);
    config.performance.tracking_pipeline = pipelineNameFromNative(native);
    await util.sleep(900);
    await XRA.profileService.save();
    events.emit('pipeline', { native, name: config.performance.tracking_pipeline });
    return native;
  }

  XRA.performance = {
    PRESETS,
    apply,
    applyCameraSettings,
    setPostFXDisabled,
    sendInferenceRates,
    setRuntimeAdaptive,
    setDiagnosticsHud,
    ensureRuntimeMonitor,
    currentNativeType,
    applyPipeline: setPipeline,
    setPipeline,
    setMocapMode,
    poseExists,
    ensurePoseQuality,
    selectStartupMocap,
    ensureStartupCalibrationBoost,
    finishStartupCalibrationBoost,
    prepareStartupMocap,
    installStartupMocapStartGuard,
    installNeckCalibrationBridge,
    preallocateTrackingStructures,
    applyPresetSafe,
    applyMasterPreset,
    benchmarkHardwareOnly,
    autoRuntime,
    measureFrames,
    diagnosticsSnapshot() {
      return {
        ...diagnostics,
        pose_fps: effectivePoseFps(),
        hand_fps: effectiveHandFps(),
        adaptive_state: adaptiveState,
        telemetry
      };
    },
    nativeSummary() {
      const smoothing = window.System?._browser?.camera?.mocap_data_smoothing ?? 0;
      const bend = window.System?._browser?.camera?.poseNet?.body_bend_reduction_power ?? 0;
      return {
        mocap: currentNativeType() || 'native',
        width: config.camera.width,
        height: config.camera.height,
        fps: config.camera.fps,
        pose: config.pose_model,
        smoothing,
        bend
      };
    }
  };

  function watchForStartupCamera() {
    prepareStartupMocap('watch');
    installStartupMocapStartGuard();
    installNeckCalibrationBridge();
    if (!startupCalibration.active || startupCalibration.completed) return;
    selectStartupMocap();
    if (startupMocapWatchTimer) return;

    // Keep the override alive until calibration really completes. The old
    // watcher stopped after 20 seconds, often before the user pressed START;
    // a later native profile import could then restore the wrong engine.
    startupMocapWatchTimer = setInterval(() => {
      if (!startupCalibration.active || startupCalibration.completed) {
        clearInterval(startupMocapWatchTimer);
        startupMocapWatchTimer = 0;
        return;
      }
      prepareStartupMocap('watch');
      installStartupMocapStartGuard();
      installNeckCalibrationBridge();
      selectStartupMocap();
    }, 250);
  }

  events.on('profile-loaded', () => {
    runtimePoseFps = runtimeHandFps = null;
    apply();
    ensureRuntimeMonitor();
    installNeckCalibrationBridge();
    preallocateTrackingStructures();
    watchForStartupCamera();
  });

  events.on('camera-started', () => {
    installNeckCalibrationBridge();
    preallocateTrackingStructures();
    selectStartupMocap();
  });

  window.addEventListener('MMDStarted', () => {
    installNeckCalibrationBridge();
    preallocateTrackingStructures();
    setTimeout(() => apply(), 500);
    setTimeout(sendInferenceRates, 1200);
    watchForStartupCamera();
  });

  installNeckCalibrationBridge();
  preallocateTrackingStructures();
  watchForStartupCamera();
  setTimeout(sendInferenceRates, 1500);
  setTimeout(ensureRuntimeMonitor, 1700);
})();
