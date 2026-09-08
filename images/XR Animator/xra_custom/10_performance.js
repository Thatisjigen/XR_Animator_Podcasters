(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA PERF]';
  const { config, events, util } = XRA;

  const PRESETS = {
    // ECO is the real low-end profile. MINIMAL remains as a legacy alias so old
    // profiles continue to load, but the UI now exposes ECO instead.
    ECO:      { cam: [424, 240, 20], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Face+Body', rates: [15, 10] },
    MINIMAL:  { cam: [424, 240, 20], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Face+Body', rates: [15, 10] },
    LOW:      { cam: [640, 360, 24], pose: 'Lite',   lip: [512, 20],  post: true,  native: 'Face+Body', rates: [20, 12] },
    BALANCED: { cam: [640, 480, 30], pose: 'Normal', lip: [512, 30],  post: false, native: 'Face+Body', rates: [30, 20] },
    QUALITY:  { cam: [1280,720, 30], pose: 'Normal', lip: [1024, 30], post: false, native: 'Face+Body', rates: [30, 30] },
    HIGH:     { cam: [1280,720, 30], pose: 'Best',   lip: [1024, 30], post: false, native: 'Full Body', rates: [60, 30] },
    MAX:      { cam: [1280,720, 60], pose: 'Best',   lip: [2048, 60], post: false, native: 'Full Body', rates: [60, 60] }
  };

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
      hand_fps: effectiveHandFps()
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
    const basePose = Number(config.performance.pose_fps || 30);
    const baseHand = Number(config.performance.hand_fps || 20);
    runtimePoseFps ??= basePose;
    runtimeHandFps ??= baseHand;
    runtimePoseFps = Math.min(runtimePoseFps, basePose);
    runtimeHandFps = Math.min(runtimeHandFps, baseHand);

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
      else if (runtimePoseFps > Math.max(15, basePose - 10)) {
        runtimePoseFps = Math.max(15, runtimePoseFps - 5);
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

  function pipelineNameFromNative(native) {
    if (native === 'Face+Body') return 'SPLIT';
    if (native === 'Full Body') return 'FULL_BODY';
    if (native === 'Full Body Holistic') return 'HOLISTIC';
    if (native === 'Face') return 'FACE';
    return String(native || 'SPLIT').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  }

  function nativeFromPipeline(name) {
    name = String(name || '').toUpperCase();
    return name === 'SPLIT' ? 'Face+Body' : 'Full Body';
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
    const allowed = new Set(['Face', 'Face+Body', 'Full Body', 'Full Body Holistic']);
    if (!allowed.has(native)) throw new Error('Unsupported mocap mode: ' + native);
    initNative(native);
    config.performance.tracking_pipeline = pipelineNameFromNative(native);
    await util.sleep(900);
    await XRA.profileService.save();
    events.emit('pipeline', { native, name: config.performance.tracking_pipeline });
    return native;
  }

  async function setPipeline(name) {
    const native = nativeFromPipeline(name);
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

  events.on('profile-loaded', () => {
    // Safe runtime restore only: no pipeline init.
    runtimePoseFps = runtimeHandFps = null;
    apply();
    ensureRuntimeMonitor();
  });

  window.addEventListener('MMDStarted', () => {
    setTimeout(() => apply(), 500);
    setTimeout(sendInferenceRates, 1200);
  });

  setTimeout(sendInferenceRates, 1500);
  setTimeout(ensureRuntimeMonitor, 1700);
})();
