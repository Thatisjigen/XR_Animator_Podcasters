// XRA_V9_1_PROVIDER_DISPLAY_FIX
// XRA_UNIVERSAL_RUNTIME_V9
// XRA_PERFORMANCE_RUNTIME_V7
(() => {
  'use strict';

  // XR Animator · ONNX mocap backend client.
  //
  // The Python server (xr_server.py -> xra_backends) provisions ONNX Runtime +
  // a pose model on first boot and exposes:
  //   GET  /__xra_backend/status   -> runtime + provisioning + active model
  //   GET  /__xra_backend/list     -> available + installed backends
  //   WS   /__xra_backend/ws       -> control (load/status) + landmark stream
  //
  // The server captures from the local camera and runs inference itself, then
  // streams NORMALIZED landmark JSON. This client sends control messages only.
  //
  // This module owns the control WebSocket, keeps a live status snapshot for the
  // UI, and mirrors the selected backend to the pose worker. The camera and the
  // inference both live in the Python process (xra_backends.capture): the browser
  // NEVER uploads a frame. It deliberately does NOT mutate the MediaPipe
  // pipeline: switching the active rig source is an explicit action
  // (see XRA.xraBackend.select) so calibration/restore keeps working as before.

  const XRA = window.XRA;
  if (!XRA) {
    console.warn('[XRA BACKEND] XRA core not ready; backend client not installed');
    return;
  }

  const TAG = '[XRA BACKEND]';
  const STATUS_URL = '/__xra_backend/status';
  const WS_URL = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/__xra_backend/ws`;
  };

  // Active tracker: 'mediapipe' (default) or an ONNX backend id like 'rtmpose-m'.
  const MEDIAPIPE_ID = 'mediapipe';

  const state = {
    selected: XRA.profile?.custom?.performance?.tracker_backend || MEDIAPIPE_ID,
    modelComplexity: null,      // 0 or 1, only meaningful for mediapipe-holistic
    connected: false,
    ready: false,
    provider: null,
    providerHuman: null,
    model: null,
    capture: null,              // server-side capture source status
    serverStatus: null,
    lastPose: null,
    lastPoseAt: 0,
    framesReceived: 0,
    errors: 0,
    lastError: '',
  };

  let ws = null;
  let reconnectTimer = 0;
  let statusTimer = 0;
  let statusListeners = new Set();
  let poseListeners = new Set();
  let controlChannel = null;

  // The pose worker (a separate classic worker) listens on the same
  // BroadcastChannel the rest of the custom UI uses. We mirror the selected
  // backend there so the in-worker ONNX bridge (js/xra_onnx_bridge.js) knows
  // whether to source keypoints from the WS backend or keep MediaPipe.
  function initControlChannel() {
    try {
      if (typeof BroadcastChannel === 'undefined') return;
      controlChannel = new BroadcastChannel('XRA_CONTROL');
      controlChannel.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'tracker_backend_request') broadcastBackend();
      };
    }
    catch (e) { controlChannel = null; }
  }

  function broadcastBackend() {
    if (!controlChannel) return;
    try {
      controlChannel.postMessage({ type: 'tracker_backend', value: state.selected, current: state.selected });
    }
    catch (e) {}
  }

  function emitStatus() {
    // NB: name this local `snap`, not `snapshot`. A local `const snapshot`
    // would shadow the outer snapshot() function and throw a TDZ
    // "Cannot access 'snapshot' before initialization" here, which silently
    // broke every status update (and, with it, the backend dropdown).
    const snap = snapshot();
    for (const fn of statusListeners) {
      try { fn(snap); } catch (e) { console.warn(TAG, e); }
    }
  }

  function emitPose(pose) {
    for (const fn of poseListeners) {
      try { fn(pose); } catch (e) { console.warn(TAG, e); }
    }
  }

  function snapshot() {
    return {
      selected: state.selected,
      active: state.selected !== MEDIAPIPE_ID,
      connected: state.connected,
      ready: state.ready,
      provider: state.provider,
      providerHuman: state.providerHuman,
      model: state.model,
      modelComplexity: state.modelComplexity,
      capture: state.capture,
      serverStatus: state.serverStatus,
      framesReceived: state.framesReceived,
      errors: state.errors,
      lastError: state.lastError,
    };
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    fn(snapshot());
    return () => statusListeners.delete(fn);
  }

  function onPose(fn) {
    poseListeners.add(fn);
    return () => poseListeners.delete(fn);
  }

  // -- server status polling (Performance tab / provisioning progress) --------

  async function refreshStatus() {
    try {
      const statusSignal = globalThis.AbortSignal?.timeout?.(2500);
      const response = await fetch(STATUS_URL, { cache: 'no-store', ...(statusSignal ? { signal: statusSignal } : {}) });
      if (!response.ok) throw new Error('status ' + response.status);
      state.serverStatus = await response.json();
// The HTTP poll also reports the capture source, so the panel can show a
      // live camera phase even before/without the control WebSocket.
      if (state.serverStatus?.capture) state.capture = state.serverStatus.capture;
      emitStatus();
      return state.serverStatus;
    }
    catch (e) {
      state.serverStatus = { ok: false, error: String(e) };
      emitStatus();
      return null;
    }
  }

  function startStatusPolling() {
    if (statusTimer) return;
    refreshStatus();
    statusTimer = setInterval(refreshStatus, 4000);
  }

  function stopStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = 0;
  }

  // -- WebSocket transport ----------------------------------------------------

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(WS_URL());
      ws.binaryType = 'arraybuffer';
    }
    catch (e) {
      state.lastError = String(e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      state.connected = true;
      state.errors = 0;
      state.lastError = '';
      // This is the single control/lifecycle socket. The worker opens a
      // separate pose-only subscription and never loads/stops engines.
      sendControl({ type: 'hello', role: 'control' });
      sendControl({ type: 'subscribe', poses: false });
      const load = { type: 'load', model: state.selected };
      if (state.modelComplexity != null) load.model_complexity = state.modelComplexity;
      sendControl(load);
      emitStatus();
    };

    ws.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'pose') {
        state.lastPose = msg;
        state.lastPoseAt = performance.now();
        state.framesReceived++;
        emitPose(msg);
      }
      else if (msg.type === 'status') {
        state.ready = !!msg.ready;
        const statusError = msg.error || msg.last_engine_error || '';
        if (msg.ok === false || statusError) {
          state.errors++;
          state.lastError = String(statusError || 'backend model load failed');
        }
        else if (state.ready) {
          state.lastError = '';
        }
        state.model = msg.model || state.model;
        state.provider = msg.provider || state.provider;
        state.providerHuman = msg.provider || state.providerHuman;
        if (msg.capture) state.capture = msg.capture;
        if (msg.model_complexity === 0 || msg.model_complexity === 1) {
          state.modelComplexity = msg.model_complexity;
        }
        emitStatus();
      }
      else if (msg.type === 'capture_status') {
        if (msg.capture) state.capture = msg.capture;
        if (msg.ok === false) {
          state.errors++;
          state.lastError = msg.error || 'capture command failed';
        } else if (state.lastError === 'engine_not_ready') {
          state.lastError = '';
        }
        emitStatus();
      }
      else if (msg.type === 'error') {
        state.errors++;
        state.lastError = msg.error || 'unknown';
        emitStatus();
      }
    };

    ws.onclose = () => {
      state.connected = false;
      state.ready = false;
      emitStatus();
      scheduleReconnect();
    };

    ws.onerror = () => {
      state.lastError = 'websocket error';
      emitStatus();
    };
  }

  function scheduleReconnect() {
    if (state.selected === MEDIAPIPE_ID || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      connect();
    }, 3000);
  }

  function sendControl(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; }
    catch (e) { state.lastError = String(e); return false; }
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    state.connected = false;
    state.ready = false;
    emitStatus();
  }

  // -- selection --------------------------------------------------------------

  async function select(backendId, { modelComplexity = null } = {}) {
    const previous = state.selected;
    state.selected = backendId || MEDIAPIPE_ID;
    if (modelComplexity === 0 || modelComplexity === 1) state.modelComplexity = modelComplexity;
    if (state.selected === MEDIAPIPE_ID) {
      // Release Python resources before closing the only control socket.
      sendControl({ type: 'capture', action: 'stop' });
      sendControl({ type: 'unload' });
      disconnect();
      state.model = null;
      state.ready = false;
    }
    else if (state.connected && ws && ws.readyState === WebSocket.OPEN) {
      // Already connected: switch the live session immediately.
      const load = { type: 'load', model: state.selected };
      if (state.modelComplexity != null) load.model_complexity = state.modelComplexity;
      sendControl(load);
    }
    else {
      // connect() issues the {type:'load'} control message once the socket
      // handshake completes (see ws.onopen), so we don't race the load before
      // the connection is open. connect() is a no-op if already connected.
      connect();
    }
    broadcastBackend();
    emitStatus();
    eventsEmit('tracker-backend', { previous, current: state.selected });
    return state.selected;
  }

  // Live-switch the legacy holistic Lite(0)/Full(1) complexity without swapping
  // the model. The worker bridge mirrors this to the server load message.
  async function setModelComplexity(value) {
    const c = Number(value);
    if (c !== 0 && c !== 1) return;
    state.modelComplexity = c;
    if (state.selected !== MEDIAPIPE_ID && state.connected && ws && ws.readyState === WebSocket.OPEN) {
      sendControl({ type: 'load', model: state.selected, model_complexity: c });
    }
    if (controlChannel) {
      try { controlChannel.postMessage({ type: 'tracker_model_complexity', value: c }); } catch (e) {}
    }
    emitStatus();
  }

  function eventsEmit(name, detail) {
    try { XRA.events?.emit?.(name, detail); } catch (e) {}
  }

  async function listBackends() {
    try {
      const response = await fetch('/__xra_backend/list', { cache: 'no-store' });
      if (!response.ok) throw new Error('list ' + response.status);
      const data = await response.json();
      return data.backends || [];
    }
    catch (e) {
      state.lastError = String(e);
      return [];
    }
  }

  XRA.xraBackend = {
    MEDIAPIPE_ID,
    snapshot,
    onStatus,
    onPose,
    refreshStatus,
    startStatusPolling,
    stopStatusPolling,
    connect,
    disconnect,
    select,
    setModelComplexity,
    listBackends,
    // Main-window camera API uses the existing control socket. Keeping
    // this transport here avoids a third WebSocket and duplicate loads.
    __sendControl: sendControl,
    get selected() { return state.selected; },
    get active() { return state.selected !== MEDIAPIPE_ID; },
    get lastPose() { return state.lastPose; },
  };

  // Kick off status polling immediately so the Performance tab shows
  // provisioning progress from first paint.
  initControlChannel();
  broadcastBackend();
  startStatusPolling();
  // If a non-MediaPipe backend was saved in the profile, open the control socket
  // now so the server can warm up its model and start its own camera capture
  // before the UI first polls for status.
  if (state.selected !== MEDIAPIPE_ID) connect();
  eventsEmit('tracker-backend', { current: state.selected });
})();

/* XRA_BACKEND_CONTROL_V5: main-window camera ownership and control plane. */
;(() => {
  'use strict';
  if (globalThis.__XRA_BACKEND_CONTROL_V5__) return;
  globalThis.__XRA_BACKEND_CONTROL_V5__ = true;

  const TAG = '[XRA CAMERA V5]';
  const CHANNEL = 'XRA_CONTROL';
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  const mediaDevices = globalThis.navigator?.mediaDevices;
  const originalGetUserMedia = typeof mediaDevices?.getUserMedia === 'function'
    ? mediaDevices.getUserMedia.bind(mediaDevices)
    : null;
  const syntheticStreams = new Set();
  const syntheticTracks = new WeakSet();

  let pythonOwnsCamera = !!globalThis.XRA?.xraBackend?.active;
  let guardInstalled = false;
  let stoppedTracksTotal = 0;
  let lastReason = 'startup';
  let browserReleased = false;

  const cameraState = {
    index: 0,
    device: null,
    width: 384,
    height: 216,
    fps: 20,
    wanted: false,
    paused: false,
    lastCommand: '',
    lastError: '',
    lastCommandAt: 0,
  };

  function externalBackendActive() {
    return globalThis.XRA?.xraBackend?.active === true;
  }

  function isExternalBackend(value) {
    const id = String(value ?? '').trim().toLowerCase();
    return !!id && !['mediapipe', 'mediapipe-wasm', 'mediapipe_wasm',
      'browser', 'wasm', 'mp'].includes(id);
  }

  function requestsVideo(constraints) {
    if (constraints === true) return true;
    if (!constraints || typeof constraints !== 'object') return false;
    return constraints.video !== undefined && constraints.video !== false;
  }

  function isOwnershipError(error) {
    const text = String(error?.message || error || '');
    return error?.name === 'NotAllowedError' && /Python backend owns the camera/i.test(text);
  }

  function newSyntheticVideoStream() {
    if (typeof MediaStream !== 'function') throw new Error('MediaStream is unavailable');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 9;
    const context = canvas.getContext?.('2d');
    if (context) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    let stream;
    if (typeof canvas.captureStream === 'function') {
      const tickFps = Math.max(5, Math.min(30, Number(cameraState.fps) || 20));
      stream = canvas.captureStream(tickFps);
      // A static canvas is not guaranteed to emit a frame at every
      // captureStream interval. Pulse one pixel so the legacy pose-worker
      // request/reply clock really runs at the selected mocap rate.
      if (context) {
        let pulse = 0;
        const tickTimer = setInterval(() => {
          context.fillStyle = (pulse++ & 1) ? '#000000' : '#010000';
          context.fillRect(0, 0, 1, 1);
        }, Math.max(16, Math.round(1000 / tickFps)));
        try { Object.defineProperty(stream, '__xraTickTimer', { value: tickTimer }); } catch (_ignored) {}
        for (const track of stream.getVideoTracks?.() || []) {
          track.addEventListener?.('ended', () => clearInterval(tickTimer), { once: true });
        }
      }
    } else {
      stream = new MediaStream();
    }
    try {
      Object.defineProperty(stream, '__xraSyntheticCanvas', { value: canvas });
      Object.defineProperty(stream, '__xraBackendPlaceholder', { value: true });
    } catch (_ignored) {}
    syntheticStreams.add(stream);
    for (const track of stream.getVideoTracks?.() || []) syntheticTracks.add(track);
    return stream;
  }

  async function syntheticGetUserMedia(constraints) {
    const video = newSyntheticVideoStream();
    const wantsAudio = !!(constraints && typeof constraints === 'object' && constraints.audio);
    if (!wantsAudio || !originalGetUserMedia) return video;
    try {
      const audio = await originalGetUserMedia({ audio: constraints.audio, video: false });
      const combined = new MediaStream([
        ...(video.getVideoTracks?.() || []),
        ...(audio.getAudioTracks?.() || []),
      ]);
      try {
        Object.defineProperty(combined, '__xraSyntheticCanvas', {
          value: video.__xraSyntheticCanvas,
        });
        Object.defineProperty(combined, '__xraBackendPlaceholder', { value: true });
      } catch (_ignored) {}
      syntheticStreams.add(combined);
      for (const track of combined.getVideoTracks?.() || []) syntheticTracks.add(track);
      return combined;
    } catch (error) {
      console.warn(TAG, 'audio-only getUserMedia failed; returning video placeholder', error);
      return video;
    }
  }

  function guardedGetUserMedia(constraints) {
    if (pythonOwnsCamera && requestsVideo(constraints)) {
      // Do not reject: XR Animator's legacy startup treats getUserMedia failure
      // as a fatal camera initialization error. A tiny canvas track at the mocap tick rate keeps
      // that state machine alive without opening the physical webcam.
      return syntheticGetUserMedia(constraints);
    }
    if (!originalGetUserMedia) return Promise.reject(new Error('getUserMedia is unavailable'));
    return originalGetUserMedia(constraints);
  }

  function installGuard() {
    if (!mediaDevices || !originalGetUserMedia || guardInstalled) return;
    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        writable: true,
        value: guardedGetUserMedia,
      });
      guardInstalled = mediaDevices.getUserMedia === guardedGetUserMedia;
    } catch (error) {
      try {
        mediaDevices.getUserMedia = guardedGetUserMedia;
        guardInstalled = mediaDevices.getUserMedia === guardedGetUserMedia;
      } catch (_ignored) {}
      if (!guardInstalled) console.warn(TAG, 'cannot install getUserMedia guard', error);
    }
  }

  function restoreGuard() {
    if (!mediaDevices || !originalGetUserMedia || !guardInstalled) return;
    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        writable: true,
        value: originalGetUserMedia,
      });
    } catch (_ignored) {
      try { mediaDevices.getUserMedia = originalGetUserMedia; } catch (_ignored2) {}
    }
    guardInstalled = false;
  }

  function addStream(streams, value) {
    if (value && typeof value.getTracks === 'function') streams.add(value);
  }

  function primaryVideo() {
    return globalThis.System?._browser?.camera?.video || null;
  }

  function releaseBrowserVideoTracks(reason = 'external-backend', acknowledge = true) {
    if (!pythonOwnsCamera) return 0;
    lastReason = reason;
    const streams = new Set();
    const camera = globalThis.System?._browser?.camera;
    addStream(streams, camera);
    addStream(streams, camera?.stream);
    addStream(streams, camera?._stream);
    addStream(streams, camera?.mediaStream);
    addStream(streams, camera?._mediaStream);
    addStream(streams, camera?.videoStream);
    addStream(streams, camera?.video_stream);
    addStream(streams, camera?.video?.srcObject);
    addStream(streams, globalThis.MMD_SA?.WebXR?.user_camera?.video?.srcObject);
    for (const video of document.querySelectorAll('video')) addStream(streams, video.srcObject);

    let stopped = 0;
    for (const stream of streams) {
      if (syntheticStreams.has(stream) || stream?.__xraBackendPlaceholder === true) continue;
      let tracks = [];
      try { tracks = stream.getVideoTracks?.() || []; } catch (_ignored) {}
      for (const track of tracks) {
        if (!track || syntheticTracks.has(track) || track.readyState === 'ended') continue;
        try { track.stop(); stopped++; }
        catch (error) { console.warn(TAG, 'track.stop failed', error); }
      }
    }

    const video = primaryVideo();
    const stream = video?.srcObject;
    if (video && !syntheticStreams.has(stream) && stream?.__xraBackendPlaceholder !== true) {
      try { video.pause(); } catch (_ignored) {}
      try { video.srcObject = null; } catch (_ignored) {}
    }
    if (video?.style) {
      video.dataset.xraHiddenByBackend = '1';
      video.style.visibility = 'hidden';
    }

    stoppedTracksTotal += stopped;
    browserReleased = true;
    if (acknowledge) {
      channel?.postMessage({
        type: 'xra_browser_camera_released',
        reason,
        stopped_tracks: stopped,
      });
    }
    return stopped;
  }

  function stopSyntheticStreams() {
    for (const stream of syntheticStreams) {
      try { stream.getTracks?.().forEach(track => track.stop()); } catch (_ignored) {}
    }
    syntheticStreams.clear();
  }

  function restoreBrowserVideoElement() {
    const video = primaryVideo();
    if (video?.dataset?.xraHiddenByBackend === '1') {
      delete video.dataset.xraHiddenByBackend;
      if (video.style) video.style.visibility = '';
    }
  }

  function setPythonOwnership(next, reason = 'control') {
    pythonOwnsCamera = !!next;
    lastReason = reason;
    if (pythonOwnsCamera) {
      installGuard();
      releaseBrowserVideoTracks(reason, true);
      setTimeout(() => releaseBrowserVideoTracks('late-stream-100ms', false), 100);
      setTimeout(() => releaseBrowserVideoTracks('late-stream-500ms', true), 500);
    } else {
      browserReleased = false;
      restoreGuard();
      stopSyntheticStreams();
      restoreBrowserVideoElement();
    }
  }

  function backend() {
    return globalThis.XRA?.xraBackend || null;
  }

  function backendSnapshot() {
    try { return backend()?.snapshot?.() || {}; } catch (_ignored) { return {}; }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitFor(test, timeout, label) {
    const deadline = performance.now() + timeout;
    let last;
    while (performance.now() < deadline) {
      try {
        last = test();
        if (last) return last;
      } catch (_ignored) {}
      await sleep(25);
    }
    const error = new Error(`${label} timed out after ${timeout} ms`);
    error.name = 'TimeoutError';
    throw error;
  }

  async function ensureControlConnected() {
    const api = backend();
    if (!api) throw new Error('XRA.xraBackend is unavailable');
    api.connect?.();
    await waitFor(() => api.snapshot?.().connected, 7000, 'backend WebSocket');
    return api;
  }

  async function ensureEngineReady() {
    const api = await ensureControlConnected();
    const result = await waitFor(() => {
      const snap = api.snapshot?.() || {};
      if (snap.ready) return snap;
      if (snap.lastError && !/websocket/i.test(snap.lastError)) {
        throw new Error(snap.lastError);
      }
      return null;
    }, 20000, 'backend model load');
    return result;
  }

  function sendControl(message) {
    const api = backend();
    if (!api || typeof api.__sendControl !== 'function') {
      throw new Error('11_backend.js control transport is unavailable');
    }
    if (!api.__sendControl(message)) throw new Error('backend WebSocket is not open');
  }

  function normalizedConfig(extra = {}) {
    if (Number.isFinite(Number(extra.index))) cameraState.index = Number(extra.index);
    if (extra.device != null) cameraState.device = String(extra.device);
    if (Number.isFinite(Number(extra.width))) cameraState.width = Math.max(160, Math.min(1920, Number(extra.width)));
    if (Number.isFinite(Number(extra.height))) cameraState.height = Math.max(120, Math.min(1080, Number(extra.height)));
    if (Number.isFinite(Number(extra.fps))) cameraState.fps = Math.max(5, Math.min(30, Number(extra.fps)));
    return {
      type: 'capture',
      action: 'configure',
      index: cameraState.index,
      device: cameraState.device,
      width: cameraState.width,
      height: cameraState.height,
      fps: cameraState.fps,
    };
  }

  async function configure(extra = {}) {
    cameraState.lastCommand = 'configure';
    cameraState.lastCommandAt = Date.now();
    await ensureControlConnected();
    sendControl(normalizedConfig(extra));
    return status();
  }

  async function start(extra = {}) {
    if (!externalBackendActive()) throw new Error('Select an external mocap backend before starting Python camera');
    cameraState.wanted = true;
    cameraState.paused = false;
    cameraState.lastError = '';
    cameraState.lastCommand = 'start';
    cameraState.lastCommandAt = Date.now();
    setPythonOwnership(true, 'camera-start');
    releaseBrowserVideoTracks('camera-start', true);
    await ensureEngineReady();
    sendControl(normalizedConfig(extra));
    sendControl({ type: 'capture', action: 'start' });
    try {
      await waitFor(() => {
        const snap = backendSnapshot();
        if (snap.capture?.running) return snap.capture;
        if (snap.lastError && /camera|capture|engine_not_ready/i.test(snap.lastError)) {
          throw new Error(snap.lastError);
        }
        return null;
      }, 10000, 'Python camera start');
    } catch (error) {
      cameraState.lastError = String(error?.message || error);
      throw error;
    }
    return status();
  }

  async function stop() {
    cameraState.wanted = false;
    cameraState.paused = false;
    cameraState.lastCommand = 'stop';
    cameraState.lastCommandAt = Date.now();
    await ensureControlConnected();
    sendControl({ type: 'capture', action: 'stop' });
    return status();
  }

  async function pause() {
    cameraState.paused = true;
    cameraState.lastCommand = 'pause';
    cameraState.lastCommandAt = Date.now();
    await ensureControlConnected();
    sendControl({ type: 'capture', action: 'pause' });
    return status();
  }

  async function resume(extra = {}) {
    cameraState.wanted = true;
    cameraState.paused = false;
    cameraState.lastCommand = 'resume';
    cameraState.lastCommandAt = Date.now();
    setPythonOwnership(true, 'camera-resume');
    await ensureEngineReady();
    sendControl(normalizedConfig(extra));
    sendControl({ type: 'capture', action: 'resume' });
    return status();
  }

  async function requestStatus() {
    await ensureControlConnected();
    sendControl({ type: 'status' });
    sendControl({ type: 'capture', action: 'status' });
    return status();
  }

  function status() {
    return {
      ...cameraState,
      pythonOwnsCamera,
      guardInstalled,
      browserReleased,
      stoppedTracksTotal,
      backend: backendSnapshot(),
    };
  }

  const cameraApi = Object.freeze({
    start,
    stop,
    pause,
    resume,
    configure,
    setIndex: index => configure({ index }),
    requestStatus,
    status,
  });
  globalThis.XRA_BACKEND_CAMERA = cameraApi;

  globalThis.XRA_CAMERA_OWNERSHIP = Object.freeze({
    release: () => releaseBrowserVideoTracks('manual', true),
    setPythonOwnership,
    isOwnershipError,
    status: () => ({
      pythonOwnsCamera,
      guardInstalled,
      browserReleased,
      stoppedTracksTotal,
      lastReason,
      syntheticStreams: syntheticStreams.size,
      primaryTrackStates: (() => {
        const stream = primaryVideo()?.srcObject;
        if (!stream?.getVideoTracks) return [];
        return stream.getVideoTracks().map(track => ({
          label: track.label,
          readyState: track.readyState,
          enabled: track.enabled,
          synthetic: syntheticTracks.has(track),
        }));
      })(),
    }),
  });

  channel?.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'tracker_backend' || data.type === 'tracker_model') {
      setPythonOwnership(isExternalBackend(data.value ?? data.backend ?? data.model), data.type);
      return;
    }
    if (data.type === 'xra_camera_owner') {
      setPythonOwnership(data.owner === 'python' || data.active === true, 'owner-message');
      return;
    }
    if (data.type === 'xra_camera_release_request' && externalBackendActive()) {
      setPythonOwnership(true, 'release-request');
      releaseBrowserVideoTracks('release-request', true);
      return;
    }
    const invoke = promise => Promise.resolve(promise).catch(error => {
      cameraState.lastError = String(error?.message || error);
      console.error(TAG, error);
    });
    if (data.type === 'mocap_rates' && externalBackendActive()) {
      const fps = Number(data.pose_fps);
      if (Number.isFinite(fps) && fps > 0) invoke(configure({ fps }));
      return;
    }
    if (data.type === 'xra_camera_control' || data.type === 'camera_control') {
      const action = String(data.action || 'status').toLowerCase();
      if (action === 'start' || action === 'on') invoke(start(data));
      else if (action === 'stop' || action === 'off') invoke(stop());
      else if (action === 'pause') invoke(pause());
      else if (action === 'resume') invoke(resume(data));
      else if (action === 'configure' || action === 'config' || action === 'select') invoke(configure(data));
      else invoke(requestStatus());
      return;
    }
    if (data.type === 'camera_enabled') invoke(data.value ? start(data) : stop());
    if (data.type === 'camera_paused') invoke(data.value ? pause() : resume(data));
    if (data.type === 'camera_index') invoke(configure({ index: data.value ?? data.index }));
  });

  setPythonOwnership(externalBackendActive(), 'initial-backend-state');
})();

