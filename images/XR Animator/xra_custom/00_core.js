(() => {
  'use strict';

  const TAG = '[XRA CORE]';
  const XRA = window.XRA = window.XRA || {};

  const defaults = {
    camera: {
      optimized: true,
      width: 640,
      height: 480,
      fps: 30
    },
    pose_model: 'Normal',
    lip: {
      optimized: true,
      fft_size: 512,
      analysis_fps: 30,
      mic_mix: 0.60,
      threshold: 0.018,
      meter_visible: false,
      response_gain: 1.0,
      vowel_emphasis: 1.0
    },
    performance: {
      preset: 'CUSTOM',
      master_preset: 'CUSTOM',
      tracking_pipeline: 'FULL_BODY',
      disable_postfx: false,
      pose_fps: 30,
      hand_fps: 20,
      auto_last_result: null,
      runtime_adaptive: false,
      diagnostics_hud: false
    },
    debug: {
      session_enabled: false,
      max_events: 12000
    },
    body: {
      anchor_strength: 0.80,
      transition_ms: 450,
      stable: false
    },
    tracking: {
      hands_enabled: true,
      hand_recovery_mode: 'normal',
      hand_detection_sensitivity: 'high',
      native_smoothing: 0,
      body_bend_reduction: 0,
      motion_hysteresis_enabled: false,
      upper_body_guard: false,
      upper_body_guard_strength: 0.0,
      guard_jump_deg: 42,
      guard_hold_ms: 650,
      guard_reacquire_deg: 60,
      guard_mode: 'off',
      desk_torso_lock: 0.55,
      desk_hips_lock: 0.92,
      desk_legs_lock: 1.0,
      adaptive_smoothing: true,
      adaptive_smoothing_strength: 0.45,
      guard_confidence_min: 0.35,
      desk_max_yaw_deg: 25,
      desk_max_pitch_deg: 15,
      desk_max_roll_deg: 12,
      guard_release_ms: 450,
      freeze_head_on_face_loss: false,
      freeze_recovery_ms: 350
    },
    background: {
      mode: 'color',
      color: '#202020',
      path: 'backgrounds/default.png'
    },
    collider: {
      preset: 'CUSTOM',
      mode: 0,
      reaction: 'z_push',
      head: 100,
      chest: 100,
      waist: 100,
      hip: 100
    },
    visual_effects: {
      UnrealBloom: null,
      N8AO: null,
      DOF: null
    },
    left_settings: {},
    avatar: {
      filename: ''
    },
    devices: {
      mic_device_id: '',
      camera_device_id: '',
      camera_label: '',
      mirror_preview: false,
      selfie_mode: false
    },
    recorder: {
      preset: 'PODCAST',
      mode: 'video_audio',
      capture_source: 'classic_v74',
      width: 1280,
      height: 720,
      fps: 30,
      video_bps: 3000000,
      audio_bps: 128000,
      audio_profile: 'podcast',
      noise_gate: true,
      gate_threshold_db: -48,
      gate_noise_floor_db: null,
      gate_hold_ms: 160,
      gate_release_ms: 120,
      segment_minutes: 0,
      output_format: 'webm',
      output_dir: '',
      filename: 'XR_Animator_{date}_{time}',
      raw_audio_backup: true,
      raw_audio_format: 'flac',
      hardware_encode: 'auto',
      chroma_safe: true,
      force_render_resolution: true
    },
    ui: {
      visible: true,
      show_startup: true,
      active_tab: 'quick',
      language: 'auto',
      preview_video: null,
      preview_wireframe: null,
      preview_debug: null
    }
  };

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, extra) {
    const out = clone(base);
    const merge = (a, b) => {
      if (!b || typeof b !== 'object') return a;
      for (const [key, value] of Object.entries(b)) {
        if (
          value && typeof value === 'object' && !Array.isArray(value) &&
          a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])
        ) {
          merge(a[key], value);
        }
        else {
          a[key] = value;
        }
      }
      return a;
    };
    return merge(out, extra || {});
  }

  class Emitter {
    constructor() { this.map = new Map(); }
    on(name, fn) {
      if (!this.map.has(name)) this.map.set(name, new Set());
      this.map.get(name).add(fn);
      return () => this.map.get(name)?.delete(fn);
    }
    emit(name, payload) {
      for (const fn of this.map.get(name) || []) {
        try { fn(payload); }
        catch (e) { console.error(TAG, 'event error:', name, e); }
      }
    }
  }

  const boot = window.__XRA_BOOT_PROFILE__;
  const profile = boot && typeof boot === 'object'
    ? {
        version: boot.version || 7.80,
        custom: deepMerge(defaults, boot.custom || {}),
        XR_Animator_settings: boot.XR_Animator_settings || null
      }
    : {
        version: 7.80,
        custom: clone(defaults),
        XR_Animator_settings: null
      };

  const config = profile.custom;

  config.tracking ||= {};
  config.body ||= {};

  // Unified body stabilization migration. Older profiles may store Body Stable,
  // Torso Guard and Podcast/Desk as separate modes. Preserve their stabilization
  // choice, then decouple the anti-jerk guard into its own explicit toggle.
  if (Number(boot?.version || 0) < 7.80) {
    const oldGuardMode = String(config.tracking.guard_mode || (config.tracking.upper_body_guard ? 'guard' : 'off')).toLowerCase();
    if (!config.body.stable && oldGuardMode !== 'off') {
      config.body.stable = true;
      const oldStrength = Number(config.tracking.upper_body_guard_strength);
      if (Number.isFinite(oldStrength)) config.body.anchor_strength = Math.max(0, Math.min(1, oldStrength));
    }
  }
  config.tracking.guard_mode = config.tracking.motion_hysteresis_enabled ? 'guard' : 'off';
  config.tracking.upper_body_guard = !!config.tracking.motion_hysteresis_enabled;
  config.tracking.upper_body_guard_strength = 0;

  // V7.6.13: retire the experimental head-loss/avatar-loss guards. The
  // underlying XR Animator pipelines do not expose a sufficiently reliable
  // face-loss signal across all modes, so stale profile values are discarded.
  for (const key of [
    'head_loss_guard','avatar_loss_hide_mode','avatar_face_loss_hide_ms','avatar_face_return_ms',
    'head_confidence_min','head_hold_ms','head_release_ms','head_loss_transition_ms',
    'head_jump_deg','head_reacquire_deg','head_reacquire_stable_ms'
  ]) delete config.tracking[key];

  // The retired camera snapshot/lock module is no longer loaded. Drop its stale
  // profile payload instead of carrying dead state through every save.
  delete config.view;
  delete config.performance.startup_mocap;
  delete config.performance.e2_master;
  delete config.ui.show_legacy_toolbar;
  if (config.performance?.tracking_pipeline === 'HOLISTIC' || config.performance?.tracking_pipeline === 'SPLIT') {
    config.performance.tracking_pipeline = 'FULL_BODY';
  }
  cleanRetiredSettings();

  // V7.6.2 migration: the safety raw-mic backup is now ON by default for old profiles.
  if (Number(boot?.version || 0) < 7.62 && boot?.custom?.recorder?.raw_audio_backup === false) {
    config.recorder.raw_audio_backup = true;
  }
  // V7.6.6: screen-sharing capture is retired. Use XR Animator's native
  // high-quality recorder output as the recommended source.
  config.recorder ||= {};
  config.recorder.gate_threshold_db = Math.max(-55, Math.min(-5, Number(config.recorder.gate_threshold_db ?? -48)));
  if (!config.recorder.capture_source || ['browser_visible','native_visible','native_xr'].includes(config.recorder.capture_source)) {
    config.recorder.capture_source = 'classic_v74';
  }
  const events = new Emitter();

  XRA.defaults = defaults;
  XRA.profile = profile;
  XRA.config = config;
  XRA.events = events;
  XRA.util = {
    clone,
    deepMerge,
    clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v))); },
    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
    same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  };

  function nativeMocapType() {
    const pipeline = String(config.performance?.tracking_pipeline || 'FULL_BODY').toUpperCase();
    if (pipeline === 'FACE') return 'Face';
    return 'Full Body';
  }

  // MediaPipe Vision full-body mocap engine is selected at startup for calibration,
  // then restored to the user's saved pipeline after calibration completes.
  const startupCalibration = XRA.startupCalibration ||= {
    active: true,
    completed: false,
    native: 'Full Body'
  };

  function cleanRetiredSettings() {
    config.left_settings ||= {};
    for (const key of Object.keys(config.left_settings)) {
      if (key.includes('Scene / 3D::')) delete config.left_settings[key];
    }
  }

  function syncCustomIntoNativeProfile(nativeConfig) {
    if (!nativeConfig || typeof nativeConfig !== 'object') return nativeConfig;

    nativeConfig.user_camera ||= {};
    nativeConfig.user_camera.pixel_limit ||= {};
    nativeConfig.user_camera.ML_models ||= {};
    nativeConfig.user_camera.ML_models.pose ||= {};
    nativeConfig.user_camera.display ||= {};
    nativeConfig.user_camera.display.video ||= {};
    nativeConfig.user_camera.display.wireframe ||= {};

    // Preview/debug states selected in XR SETTINGS are part of the profile.
    // Only override native settings after the user has explicitly chosen a
    // boolean value; null keeps XR Animator's own default/legacy tri-state.
    // Webcam preview is rendered by XRA from the existing live MediaStream.
    // Do not map it back to XR Animator's legacy camera-display tri-state,
    // which is renderer-dependent and can be overwritten at runtime.
    if (typeof config.ui?.preview_wireframe === 'boolean')
      nativeConfig.user_camera.display.wireframe.hidden = !config.ui.preview_wireframe;
    if (typeof config.ui?.preview_debug === 'boolean')
      nativeConfig.user_camera.ML_models.debug_hidden = !config.ui.preview_debug;

    if (config.camera.optimized) {
      nativeConfig.user_camera.pixel_limit.disabled = false;
      nativeConfig.user_camera.pixel_limit.current = [config.camera.width, config.camera.height];
      nativeConfig.user_camera.fps = { ideal: config.camera.fps };
    }

    nativeConfig.user_camera.ML_models.pose.model_quality = config.pose_model;

    nativeConfig.user_camera.streamer_mode ||= {};
    nativeConfig.user_camera.streamer_mode.camera_preference ||= {};
    nativeConfig.user_camera.streamer_mode.mocap_type =
      (startupCalibration.active && !startupCalibration.completed)
        ? startupCalibration.native
        : nativeMocapType();
    nativeConfig.user_camera.streamer_mode.camera_preference.label = config.devices?.camera_label || nativeConfig.user_camera.streamer_mode.camera_preference.label || '';

    return nativeConfig;
  }

  if (profile.XR_Animator_settings) {
    syncCustomIntoNativeProfile(profile.XR_Animator_settings);
  }

  function readNativeSettingsFallback() {
    if (window.MMD_SA_options?._XRA_settings_imported) {
      return MMD_SA_options._XRA_settings_imported;
    }
    try {
      const saved = window.System?.Gadget?.Settings?.readString?.('LABEL_XRA_settings');
      if (saved) return JSON.parse(decodeURIComponent(saved));
    }
    catch (e) { console.warn(TAG, 'native settings fallback read failed', e); }
    try {
      return window.MMD_SA_options?._XRA_settings_export?.() || null;
    }
    catch (e) { console.warn(TAG, 'native settings fallback export failed', e); }
    return null;
  }

  function assertStartupNativeOptions(nativeConfig = null) {
    if (!startupCalibration.active || startupCalibration.completed) return nativeConfig;

    if (nativeConfig && typeof nativeConfig === 'object') {
      nativeConfig.user_camera ||= {};
      nativeConfig.user_camera.streamer_mode ||= {};
      nativeConfig.user_camera.streamer_mode.mocap_type = startupCalibration.native;
    }

    const opts = window.MMD_SA_options?.user_camera;
    if (opts) {
      opts.streamer_mode ||= {};
      opts.streamer_mode.mocap_type = startupCalibration.native;
    }
    return nativeConfig;
  }

  function installStartupNativeProfile(nativeConfig = profile.XR_Animator_settings) {
    let source = nativeConfig || readNativeSettingsFallback();
    let runtime = null;
    if (source && typeof source === 'object') {
      runtime = clone(source);
      syncCustomIntoNativeProfile(runtime);
      assertStartupNativeOptions(runtime);
    }
    else {
      assertStartupNativeOptions();
    }
    if (runtime && typeof window.MMD_SA_options !== 'undefined') {
      // Keep the saved profile untouched. Native import may run on load,
      // jThree_ready and MMDStarted; all of those passes must see this clone.
      MMD_SA_options._XRA_settings_imported = runtime;
    }
    return runtime;
  }

  function finishStartupNativeOverride() {
    let saved = profile.XR_Animator_settings;
    if (!saved) {
      try { saved = clone(window.MMD_SA_options?._XRA_settings_export?.() || null); }
      catch (e) { console.warn(TAG, 'native settings restore export failed', e); }
    }
    if (saved && typeof window.MMD_SA_options !== 'undefined') {
      syncCustomIntoNativeProfile(saved);
      profile.XR_Animator_settings ||= saved;
      MMD_SA_options._XRA_settings_imported = saved;
    }
    return saved;
  }

  // Install before MMDStarted/streamer_mode.start(), not after the worker exists.
  installStartupNativeProfile();

  let saveTimer = null;
  let savePromise = null;
  let saveResolve = null;

  async function saveNow() {
    // V7.5: capture every currently registered XR SETTINGS control, not only
    // values touched since startup. Transient commands are not registered.
    try { XRA.xrSettings?.snapshotPersistedLeftState?.(); } catch (e) { console.warn(TAG, 'left state snapshot failed', e); }
    let nativeSettings = profile.XR_Animator_settings;

    try {
      if (typeof MMD_SA_options?._XRA_settings_export === 'function') {
        nativeSettings = MMD_SA_options._XRA_settings_export();
      }
    }
    catch (e) {
      console.warn(TAG, 'native settings export failed', e);
    }

    syncCustomIntoNativeProfile(nativeSettings);

    const payload = {
      version: 7.80,
      custom: config,
      XR_Animator_settings: nativeSettings || null
    };

    try {
      const res = await fetch('/__xra_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
      profile.version = 7.80;
      profile.XR_Animator_settings = nativeSettings || null;
      events.emit('saved', payload);
      return true;
    }
    catch (e) {
      console.error(TAG, 'save failed', e);
      events.emit('save-error', e);
      return false;
    }
  }

  // Coalesces bursts of settings writes into one disk write. Existing callers may await it.
  function requestSave(delay = 250) {
    if (saveTimer) clearTimeout(saveTimer);
    if (!savePromise) {
      savePromise = new Promise(resolve => { saveResolve = resolve; });
    }
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const ok = await saveNow();
      saveResolve?.(ok);
      saveResolve = null;
      savePromise = null;
    }, Math.max(0, Number(delay) || 0));
    return savePromise;
  }

  async function loadProfile() {
    try {
      const res = await fetch('/__xra_profile', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      const loaded = await res.json();
      const merged = deepMerge(defaults, loaded.custom || {});

      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, merged);
      cleanRetiredSettings();

      profile.version = loaded.version || 7.80;
      profile.XR_Animator_settings = loaded.XR_Animator_settings || null;
      syncCustomIntoNativeProfile(profile.XR_Animator_settings);
      const runtimeNativeSettings = startupCalibration.active
        ? installStartupNativeProfile(profile.XR_Animator_settings)
        : profile.XR_Animator_settings;

      if (
        runtimeNativeSettings &&
        typeof MMD_SA_options?._XRA_settings_import === 'function'
      ) {
        MMD_SA_options._XRA_settings_imported = runtimeNativeSettings;
        await MMD_SA_options._XRA_settings_import(runtimeNativeSettings);
      }

      // E1 remains intentionally disabled: LOAD never calls init_mocap.
      events.emit('profile-loaded', config);
      return true;
    }
    catch (e) {
      console.error(TAG, 'load failed', e);
      events.emit('load-error', e);
      return false;
    }
  }

  function resetField(path) {
    const parts = String(path).split('.');
    let src = defaults;
    let dst = config;
    for (let i = 0; i < parts.length - 1; i++) {
      src = src?.[parts[i]];
      dst = dst?.[parts[i]];
      if (!dst) return false;
    }
    const last = parts.at(-1);
    if (!src || !(last in src)) return false;
    dst[last] = clone(src[last]);
    events.emit('state', { path, value: dst[last] });
    return true;
  }

  function getPath(path, source = config) {
    return String(path).split('.').reduce((obj, key) => obj?.[key], source);
  }

  function isDefault(path) {
    return XRA.util.same(getPath(path, config), getPath(path, defaults));
  }

  function setPath(path, value, { save = true, emit = true } = {}) {
    const parts = String(path).split('.');
    let dst = config;
    for (let i = 0; i < parts.length - 1; i++) {
      dst[parts[i]] ||= {};
      dst = dst[parts[i]];
    }
    dst[parts.at(-1)] = value;
    if (emit) events.emit('state', { path, value });
    if (save) requestSave();
    return value;
  }

  XRA.profileService = {
    saveNow,
    save: requestSave,
    load: loadProfile,
    resetField,
    isDefault,
    get: getPath,
    set: setPath,
    syncCustomIntoNativeProfile,
    installStartupNativeProfile,
    assertStartupNativeOptions,
    finishStartupNativeOverride
  };

  // Native settings can fire several write events in quick succession; debounce them.
  window.addEventListener('SA_writeSettings', () => requestSave(350));

  let nativeReadyPromise = null;
  XRA.whenNativeReady = function whenNativeReady(timeout = 15000) {
    if (window.System?._browser?.camera && window.MMD_SA_options) return Promise.resolve(true);
    if (nativeReadyPromise) return nativeReadyPromise;

    nativeReadyPromise = new Promise(resolve => {
      const started = performance.now();
      const onStart = () => finish(true);
      let timer = null;

      function finish(ok) {
        window.removeEventListener('MMDStarted', onStart);
        if (timer) clearInterval(timer);
        nativeReadyPromise = null;
        resolve(ok);
      }

      function ensureGlobals() {
        try {
          window.System = window.System || {};
          window.System._browser = window.System._browser || {};
          window.System._browser.camera = window.System._browser.camera || {};
          if (!window.System._browser.camera.bodyPix) window.System._browser.camera.bodyPix = { enabled: false };
          if (!window.System._browser.camera.face_detection) window.System._browser.camera.face_detection = { enabled: false };
          if (window.System._browser.video_capture && !window.System._browser.video_capture.FFmpeg) {
            window.System._browser.video_capture.FFmpeg = { enabled: false };
          }
          window.MMD_SA = window.MMD_SA || {};
          if (!window.MMD_SA.motion_player_control) {
            window.MMD_SA.motion_player_control = { enabled: false, paused: false, pause() {}, play() {}, currentTime: 0, duration: 0 };
          }
        } catch (e) {}
      }

      window.addEventListener('MMDStarted', () => { ensureGlobals(); onStart(); }, { once: true });
      timer = setInterval(() => {
        ensureGlobals();
        if (window.System?._browser?.camera && window.MMD_SA_options) finish(true);
        else if (performance.now() - started > timeout) finish(false);
      }, 120);
    });

    return nativeReadyPromise;
  };

  XRA.toast = function toast(message, type = 'info', ms = 2500) {
    events.emit('toast', { message: String(message), type, ms });
  };

  window.XRA_OPT = {
    config,
    profile,
    save: requestSave,
    saveProfile: requestSave,
    loadProfile,
    get handsEnabled() { return XRA.tracking?.handsEnabled ?? true; },
    get bodyStable() { return XRA.tracking?.bodyStable ?? false; },
    applyHands(...args) { return XRA.tracking?.setHands?.(...args); },
    applyPerformance(...args) { return XRA.performance?.apply?.(...args); },
    applyTrackingPipeline(...args) { return XRA.performance?.applyPipeline?.(...args); },
    applyBackground(...args) { return XRA.background?.apply?.(...args); },
    setUIHidden(...args) { return XRA.ui?.setHidden?.(...args); },
    setBodyStable(...args) { return XRA.tracking?.setBodyStable?.(...args); },
    captureBodyPose(...args) { return XRA.tracking?.captureBodyPose?.(...args); }
  };

})();
