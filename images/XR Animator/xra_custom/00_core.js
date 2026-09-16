(() => {
  'use strict';

  const TAG = '[XRA CORE]';
  const XRA = window.XRA = window.XRA || {};

  // Global patch for video paused state: ensures internal accumulators in XR Animator (e.g. calibration)
  // recognize the camera stream as active even when driven by the Python backend.
  try {
    Object.defineProperty(HTMLVideoElement.prototype, 'paused', {
      configurable: true,
      get() { return false; }
    });
  } catch (e) {}

  if (!window.XRA_DETECTED_GPU) {
    try {
      const _c = document.createElement('canvas');
      const _gl = _c.getContext('webgl2') || _c.getContext('webgl');
      if (_gl) {
        const _ext = _gl.getExtension('WEBGL_debug_renderer_info');
        if (_ext) {
          window.XRA_DETECTED_GPU = _gl.getParameter(_ext.UNMASKED_RENDERER_WEBGL);
        }
      }
    } catch (_) {}
  }

  const defaults = {
    camera: {
      optimized: true,
      width: 640,
      height: 480,
      fps: 30,
      mouse_locked: false
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
      tracker_backend: 'mediapipe-tasks-landmarker',
      min_tracking_confidence: 0.50,
      min_pose_confidence: 0.50,
      min_face_confidence: 0.50,
      min_joint_confidence: 0.25,
      disable_postfx: false,
      render_fps: 60,
      render_resolution: '1080p',
      shadows: 'auto',
      pose_fps: 30,
      hand_fps: 20,
      infer_mode: 'native',
      auto_last_result: null,
      runtime_adaptive: false,
      diagnostics_hud: false,
      spring_bone: 'full',       // 'full' | 'half' (15 Hz) | 'off'
      antialias: 'auto',         // 'auto' (MSAA hardware) | 'off'
      gpu_preference: 'default', // 'default' | 'high-performance' (RTX) | 'low-power' (iGPU)
      preserve_drawing_buffer: true
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
      stabilize_hand_percent: 0,
      stabilize_arm: 0,
      stabilize_arm_time: 0,
      constrain_tracking_region: false,
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
      freeze_recovery_ms: 350,
      arm_steady_hold: false,
      smart_arm_sync: true,
      desk_wrist_guard: true
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
      filename: '',
      pose_key: ''
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
  for (const key of ['body_fps', 'head_fps', 'dwpose_body_fps', 'mediapipe_head_fps', 'drishti_threads']) {
    delete config.performance[key];
  }
  // The quick-start card is mandatory on every launch. Remove the retired
  // preference from older profiles so no generic/legacy settings UI can bring
  // back a "skip startup" switch.
  if (config.ui) delete config.ui.show_startup;
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
  config.recorder.gate_threshold_db = Math.max(-80, Math.min(-5, Number(config.recorder.gate_threshold_db ?? -48)));
  if (!config.recorder.capture_source || ['browser_visible','native_visible','native_xr'].includes(config.recorder.capture_source)) {
    config.recorder.capture_source = 'classic_v74';
  }
  // Zero is the explicit "Unlimited / Monitor" value and must survive boot.
  window.XRA_render_fps_limit = Number(config.performance?.render_fps ?? 60);
  window.XRA_gpu_preference = String(config.performance?.gpu_preference || 'default');
  window.XRA_preserve_drawing_buffer = config.performance?.preserve_drawing_buffer !== false;
  window.XRA_antialias = config.performance?.antialias !== 'off';
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

  // V7.81: the old "boot in MediaPipe Vision Full Body, calibrate, then restore
  // the saved pipeline" workaround is retired. The native MediaPipe engine
  // now provides a full 3D structure and standard landmark
  // casing from the first frame, so there is no reason to force the WASM engine
  // at startup. We boot straight into the configured engine/pipeline.
  //
  // `startupCalibration` stays as a thin compatibility shim: it is marked
  // completed immediately so every legacy guard (assertStartupNativeOptions,
  // prepareStartupMocap, finishStartupNativeOverride) becomes a no-op and never
  // overrides the user's saved mocap_type again.
  const startupCalibration = XRA.startupCalibration ||= {
    active: false,
    completed: true,
    native: 'Full Body'
  };
  startupCalibration.active = false;
  startupCalibration.completed = true;

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

    nativeConfig.user_camera.pixel_limit.disabled = false;
    nativeConfig.user_camera.pixel_limit.current = [Number(config.camera.width) || 640, Number(config.camera.height) || 360];
    nativeConfig.user_camera.fps = { ideal: Number(config.camera.fps) || 30 };

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

  function ensureVideoCanvas(cam) {
    if (!cam || typeof cam !== 'object') return cam;
    if (!cam.video_canvas || typeof cam.video_canvas.width !== 'number') {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        const ctx = canvas.getContext?.('2d');
        if (ctx) {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        cam.video_canvas = canvas;
        if (!cam.video_canvas_context) cam.video_canvas_context = ctx;
      } catch (e) {
        console.warn(TAG, 'ensureVideoCanvas failed', e);
      }
    }
    return cam;
  }
  XRA.ensureVideoCanvas = ensureVideoCanvas;

  function makeCamPropertySafe(obj, prop, fallbackVal) {
    if (!obj || typeof obj !== 'object') return;
    try {
      const desc = Object.getOwnPropertyDescriptor(obj, prop);
      if (desc && !desc.configurable) return;
      if (!desc || (!desc.set && !desc.writable)) {
        let customVal = fallbackVal;
        const originalGet = desc?.get;
        Object.defineProperty(obj, prop, {
          configurable: true,
          enumerable: true,
          get() {
            return customVal !== undefined ? customVal : (originalGet ? originalGet.call(this) : fallbackVal);
          },
          set(v) {
            customVal = v;
          }
        });
      }
    } catch (_) {}
  }

  function installCameraGuard() {
    try {
      window.System = window.System || {};
      const browser = window.System._browser = window.System._browser || {};
      let cam = browser.camera || {};
      ensureVideoCanvas(cam);
      makeCamPropertySafe(cam, 'ML_enabled', false);
      makeCamPropertySafe(cam, 'mocap_enabled', false);
      makeCamPropertySafe(cam, 'running', false);

      let currentCam = cam;
      Object.defineProperty(browser, 'camera', {
        configurable: true,
        enumerable: true,
        get() {
          if (currentCam) {
            ensureVideoCanvas(currentCam);
            makeCamPropertySafe(currentCam, 'ML_enabled', false);
            makeCamPropertySafe(currentCam, 'mocap_enabled', false);
            makeCamPropertySafe(currentCam, 'running', false);
          }
          return currentCam;
        },
        set(val) {
          currentCam = val;
          if (currentCam) {
            ensureVideoCanvas(currentCam);
            makeCamPropertySafe(currentCam, 'ML_enabled', false);
            makeCamPropertySafe(currentCam, 'mocap_enabled', false);
            makeCamPropertySafe(currentCam, 'running', false);
          }
        }
      });
    } catch (e) {
      console.warn(TAG, 'installCameraGuard failed', e);
    }
  }
  installCameraGuard();

  function calibratePoseScores(pn) {
    if (!pn) return;
    const adjust = (list) => {
      if (!Array.isArray(list)) return;
      for (const kp of list) {
        if (!kp || typeof kp !== 'object') continue;
        const s = kp.score ?? kp.visibility;
        if (typeof s === 'number' && Number.isFinite(s)) {
          if (s < 0.25) {
            kp.score = 0.0;
            kp.visibility = 0.0;
          } else if (s < 0.85) {
            const mapped = 0.55 + 0.45 * Math.min(1.0, (s - 0.25) / 0.70);
            kp.score = mapped;
            kp.visibility = mapped;
          }
        }
      }
    };
    adjust(pn.keypoints);
    adjust(pn._keypoints);
    adjust(pn.landmarks);
  }

  function syncCameraCanvasesLayout(cam, cw, ch) {
    if (!cam) return;
    try {
      const opts = window.MMD_SA_options?.user_camera;
      if (!opts) return;
      const display = opts.display || {};
      const a = display.webcam_as_bg ? { scale: 1, top: 0 } : (display.video || {});
      const winW = window.innerWidth || 1280;
      const winH = window.innerHeight || 720;
      let o_w, o_h;
      if (!a.scale) {
        o_w = winW;
        o_h = winH;
      } else {
        const floatingScale = cam.display_floating
          ? (display.floating_scale || (display.floating && 1) || 0.5)
          : 1;
        const e = a.scale * floatingScale;
        o_w = ~~(winW * e);
        o_h = ~~(winH * e);
      }
      const left_e = (winW - o_w) / 2;
      const top_t = (winH - o_h) / 2;
      const v_left = left_e * (1 + (a.left != null ? a.left : -1));
      const v_top = top_t * (1 + (a.top != null ? a.top : 0));

      if (cam.video_canvas) {
        const vcStyle = cam.video_canvas.style;
        const wStr = `${o_w}px`;
        const hStr = `${o_h}px`;
        const lStr = `${v_left}px`;
        const tStr = `${v_top}px`;
        if (vcStyle.width !== wStr || vcStyle.height !== hStr || vcStyle.left !== lStr || vcStyle.top !== tStr) {
          vcStyle.width = wStr;
          vcStyle.height = hStr;
          vcStyle.left = lStr;
          vcStyle.top = tStr;
        }
        vcStyle.pixelWidth = o_w;
        vcStyle.pixelHeight = o_h;
      }

      if (cam.video_canvas_facemesh) {
        const wf = display.wireframe || {};
        const wf_scale = wf.align_with_video ? 1 : (wf.scale || (typeof is_mobile !== 'undefined' && is_mobile ? 0.25 : 1));
        const wf_w = ~~(o_w * wf_scale);
        const wf_h = ~~(o_h * wf_scale);
        let wf_left, wf_top;
        if (wf.align_with_video) {
          wf_left = v_left;
          wf_top = v_top;
        } else {
          const ew = (winW - wf_w) / 2;
          const th = (winH - wf_h) / 2;
          wf_left = ew * (1 + (wf.left != null ? wf.left : 1));
          wf_top = th * (1 + (wf.top != null ? wf.top : -1));
        }
        const fmStyle = cam.video_canvas_facemesh.style;
        const wStr = `${wf_w}px`;
        const hStr = `${wf_h}px`;
        const lStr = `${wf_left}px`;
        const tStr = `${wf_top}px`;
        if (fmStyle.width !== wStr || fmStyle.height !== hStr || fmStyle.left !== lStr || fmStyle.top !== tStr) {
          fmStyle.width = wStr;
          fmStyle.height = hStr;
          fmStyle.left = lStr;
          fmStyle.top = tStr;
        }
        fmStyle.pixelWidth = wf_w;
        fmStyle.pixelHeight = wf_h;
      }
    } catch (e) {}
  }

  function installWorkerPoseGuard() {
    try {
      if (window.Worker && !window.Worker._xra_wrapped) {
        const _origWorker = window.Worker;
        const WorkerProxy = function(scriptURL, options) {
          const w = new _origWorker(scriptURL, options);
          try {
            const urlStr = String(scriptURL || '');
            w._xra_url = urlStr;
            if (urlStr.includes('facemesh')) {
              window._xra_facemesh_worker = w;
            } else if (urlStr.includes('pose')) {
              window._xra_pose_worker = w;
            }
          } catch (e) {}
          return w;
        };
        WorkerProxy.prototype = _origWorker.prototype;
        WorkerProxy._xra_wrapped = true;
        window.Worker = WorkerProxy;
      }

      const origDesc = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
      if (!origDesc || !origDesc.set) return;
      Object.defineProperty(Worker.prototype, 'onmessage', {
        configurable: true,
        enumerable: true,
        get: origDesc.get,
        set(fn) {
          if (typeof fn !== 'function') return origDesc.set.call(this, fn);
          const workerInstance = this;
          if (workerInstance?._xra_url?.includes('facemesh')) {
            window._xra_facemesh_handler = fn;
          }
          const wrapped = function(event) {
            try {
              let data = event?.data;
              let parsed = null;
              if (typeof data === 'string' && data.charCodeAt(0) === 123) {
                if (data.includes('posenet') || data.includes('facemesh')) {
                  parsed = JSON.parse(data);
                }
              } else if (data && typeof data === 'object') {
                parsed = data;
              }

              if (parsed) {
                const cam = window.System?._browser?.camera;
                const cw = Number(parsed.capture_width) || Number(parsed.w) || 640;
                const ch = Number(parsed.capture_height) || Number(parsed.h) || 360;
                if (cam) {
                  cam.target_width = cw;
                  cam.target_height = ch;
                  if (cam.video_canvas && (cam.video_canvas.width !== cw || cam.video_canvas.height !== ch)) {
                    cam.video_canvas.width = cw;
                    cam.video_canvas.height = ch;
                  }
                  if (cam.video) {
                    if (cam.video.videoWidth !== cw || cam.video.videoHeight !== ch || cam.video.readyState < 2) {
                      try {
                        Object.defineProperty(cam.video, 'videoWidth', { configurable: true, get: () => cw });
                        Object.defineProperty(cam.video, 'videoHeight', { configurable: true, get: () => ch });
                        Object.defineProperty(cam.video, 'readyState', { configurable: true, get: () => 4 });
                      } catch (e) {}
                    }
                  }
                  syncCameraCanvasesLayout(cam, cw, ch);
                }

                if (parsed.facemesh) {
                  const fm = cam?.facemesh;
                  const faces = parsed.facemesh.faces || [];
                  const vw = cam?.video_canvas?.width || cw;
                  const vh = cam?.video_canvas?.height || ch;
                  const fallbackBB = parsed.facemesh.bb || faces[0]?.bb || { x: 0, y: 0, w: vw, h: vh };
                  if (faces[0]) {
                    if (!faces[0].bb) faces[0].bb = fallbackBB;
                    if (faces[0].faceInViewConfidence == null) faces[0].faceInViewConfidence = 0.95;
                  }
                  parsed.facemesh.bb = fallbackBB;

                  // XR Animator's calibration integrates `_t` until it reaches
                  // five seconds. On the WASM path `_t` was inference time;
                  // with the native backend the JS adapter itself takes only
                  // about 1 ms, which stretched calibration to nearly a minute.
                  // Use the actual frame cadence while the external backend is
                  // active, preserving the stock value for browser/WASM models.
                  const externalBackendActive = !!window.XRA?.xraBackend?.active;
                  let externalFps = 0;
                  if (externalBackendActive) {
                    try {
                      const capture = window.XRA_BACKEND_CAMERA?.status?.()?.backend?.capture
                        || window.XRA?.xraBackend?.snapshot?.()?.capture
                        || {};
                      externalFps = Number(
                        capture.measured_fps || capture.effective_fps || capture.target_fps
                      );
                    } catch (e) {}
                  }
                  if (externalBackendActive) {
                    // `facemesh.fps` from mocap_lib_module is processing
                    // throughput, not camera cadence, so it is deliberately
                    // not used as a fallback here.
                    const faceFps = Math.max(5, Math.min(60, externalFps || 30));
                    parsed.facemesh.fps = faceFps;
                    parsed.facemesh._t = Math.max(1, Math.min(75, 1000 / faceFps));
                  } else {
                    parsed.facemesh._t = Number(parsed.facemesh._t || parsed._t || parsed.ms || 33);
                  }

                  if (fm) {
                    fm.enabled = true;
                    fm.data_detected = Math.max(fm.data_detected || 0, 10);
                    fm.data_detected_timestamp = fm.data_detected_timestamp || performance.now();

                    if (cam?.video && cam.video.paused) {
                      try {
                        Object.defineProperty(cam.video, 'paused', { configurable: true, get: () => false });
                      } catch (e) {}
                    }

                    // The original pose-worker handler called below already
                    // forwards parsed.facemesh to fm.worker_onmessage and emits
                    // SA_camera_facemesh_update. Repeating either here doubles
                    // facial rig/calibration work and startup notifications.

                    // 2. Ensure wireframe canvas ALWAYS has face data for cyan mesh triangulation
                    if (fm.wireframe?._data) {
                      fm.wireframe._data.faces = faces;
                      fm.wireframe._data.facemesh = faces;
                      fm.wireframe._data.bb = fallbackBB;
                    }
                    const qe = window.System?._browser?.camera?.poseNet?.wireframe;
                    if (qe?._data) {
                      qe._data.faces = faces;
                      qe._data.facemesh = faces;
                      qe._data.bb = fallbackBB;
                    }
                  }
                }

                if (parsed.posenet) {
                  const pn = parsed.posenet;
                  pn._keypoints = pn._keypoints || pn.keypoints || [];
                  pn._keypoints3D = pn._keypoints3D || pn.keypoints3D || [];
                  calibratePoseScores(pn);
                  if (typeof data === 'string') {
                    Object.defineProperty(event, 'data', { configurable: true, value: parsed });
                  }
                }
              }
            } catch (_e) {}
            return fn.call(this, event);
          };
          return origDesc.set.call(this, wrapped);
        }
      });
    } catch (e) {
      console.warn(TAG, 'installWorkerPoseGuard failed', e);
    }
  }

  installWorkerPoseGuard();

  function installDataFilterGuard() {
    try {
      const df = window.System?._browser?.data_filter;
      if (!df || df._xra_guarded) return;
      const origFilter = df.prototype.filter;
      df.prototype.filter = function(t, o, i) {
        if (t != null) {
          const hasNaN = Array.isArray(t) ? t.some(e => Number.isNaN(e) || !Number.isFinite(e)) : (Number.isNaN(t) || !Number.isFinite(t));
          if (hasNaN) {
            return this.data !== undefined ? this.data : (Array.isArray(t) ? t.map(v => Number.isFinite(v) ? v : 0) : 0);
          }
        }
        return origFilter.call(this, t, o, i);
      };
      df._xra_guarded = true;
    } catch (e) {}
  }

  installDataFilterGuard();

  let nativeReadyPromise = null;
  XRA.whenNativeReady = function whenNativeReady(timeout = 15000) {
    const isReady = () => !!(
      window.System?._browser?.camera?.streamer_mode?.init_mocap &&
      window.MMD_SA_options
    );
    if (isReady()) return Promise.resolve(true);
    if (nativeReadyPromise) return nativeReadyPromise;

    nativeReadyPromise = new Promise(resolve => {
      const started = performance.now();
      let timer = null;

      function finish(ok) {
        window.removeEventListener('MMDStarted', onMMDStarted);
        if (timer) clearInterval(timer);
        nativeReadyPromise = null;
        resolve(ok);
      }

      function onMMDStarted() {
        ensureGlobals();
        if (isReady()) finish(true);
      }

      function ensureGlobals() {
        try {
          window.System = window.System || {};
          window.System._browser = window.System._browser || {};
          const cam = window.System._browser.camera;
          ensureVideoCanvas(cam);
          installCameraGuard();
          installDataFilterGuard();
          if (cam) {
            if (!cam.facemesh) cam.facemesh = { enabled: true };
            cam.facemesh.update_frame = function() {};
            if (!cam.poseNet) cam.poseNet = { enabled: true };
            cam.poseNet.update_frame = function() {};
          }
          if (window.MMD_SA_options?.user_camera?.ML_models?.facemesh) {
            window.MMD_SA_options.user_camera.ML_models.facemesh.worker_disabled = false;
          }
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

      window.addEventListener('MMDStarted', onMMDStarted, { once: true });
      timer = setInterval(() => {
        ensureGlobals();
        if (isReady()) finish(true);
        else if (performance.now() - started > timeout) finish(false);
      }, 120);
    });

    return nativeReadyPromise;
  };

  XRA.toast = function toast(message, type = 'info', ms = 2500) {
    events.emit('toast', { message: String(message), type, ms });
  };

  XRA.promptRestart = function promptRestart(reason) {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.querySelector('.xra-restart-dialog-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'xra-overlay xra-restart-dialog-overlay';

    const card = document.createElement('div');
    card.className = 'xra-start-card';

    const head = document.createElement('div');
    head.className = 'xra-start-head';
    const heading = document.createElement('div');
    heading.innerHTML = '<h2>⚠️ Chiusura Applicazione Richiesta</h2>';
    head.append(heading);

    const desc = document.createElement('div');
    desc.className = 'xra-sub';
    desc.style.margin = '10px 0 18px';
    desc.style.fontSize = '13px';
    desc.style.lineHeight = '1.5';
    desc.style.color = 'var(--xra-text)';
    const msg = (reason ? reason + '\n\n' : '') +
      'Per applicare le modifiche alla scheda video (GPU) o al rendering, chiudi l\'applicazione e riaprila.';
    desc.innerText = msg;

    const actions = document.createElement('div');
    actions.className = 'xra-start-foot';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '10px';
    actions.style.marginTop = '14px';

    const btnLater = document.createElement('button');
    btnLater.type = 'button';
    btnLater.className = 'xra-action';
    btnLater.textContent = 'Chiudi dopo';
    btnLater.onclick = () => overlay.remove();

    const btnQuit = document.createElement('button');
    btnQuit.type = 'button';
    btnQuit.className = 'xra-action primary';
    btnQuit.style.background = '#c0392b';
    btnQuit.style.borderColor = '#e74c3c';
    btnQuit.textContent = '❌ Chiudi applicazione';
    btnQuit.onclick = async () => {
      btnQuit.disabled = true;
      btnQuit.textContent = 'Chiusura…';
      overlay.remove();
      if (typeof XRA.nativeBridge?.quitApp === 'function') {
        await XRA.nativeBridge.quitApp();
      } else {
        const nwApp = typeof nw !== 'undefined' ? nw.App : (window.nw?.App);
        if (nwApp?.quit) nwApp.quit();
        else window.close();
      }
    };

    actions.append(btnLater, btnQuit);
    card.append(head, desc, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
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
