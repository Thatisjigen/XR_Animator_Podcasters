/* XRA_BACKEND_CONTROL_V5: pose-only worker WebSocket. */
(function initXraBackendPoseBridge(scope) {
  'use strict';
  if (!scope) return;
  try { scope.XRA_ONNX?.shutdown?.(); } catch (_ignored) {}

  const MEDIAPIPE_ID = 'mediapipe';
  const DEFAULT_MODEL = 'dwpose-s';
  const CHANNEL = 'XRA_CONTROL';
  const RECONNECT_MS = 1000;
  const NAMES = [
    'nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer',
    'left_ear','right_ear','mouth_left','mouth_right','left_shoulder','right_shoulder','left_elbow',
    'right_elbow','left_wrist','right_wrist','left_pinky','right_pinky','left_index','right_index',
    'left_thumb','right_thumb','left_hip','right_hip','left_knee','right_knee','left_ankle',
    'right_ankle','left_heel','right_heel','left_foot_index','right_foot_index'
  ];
  const CAMEL = NAMES.map(name => name.replace(/_([a-z])/g, (_, char) => char.toUpperCase()));
  const listeners = new Set();
  const state = {
    selected: MEDIAPIPE_ID,
    modelComplexity: null,
    width: 384,
    height: 216,
    ws: null,
    connected: false,
    ready: false,
    loading: false,
    provider: null,
    accelerated: false,
    latest: null,
    sequence: 0,
    consumed: 0,
    face: null,
    leftHand: [],
    rightHand: [],
    reconnect: null,
    framesReceived: 0,
    emptyFrames: 0,
    errors: 0,
    lastError: '',
    lastStatus: null,
    configured: false,
    frontendReady: false,
    control: null,
    debug: false,
  };

  const now = () => scope.performance?.now?.() ?? Date.now();
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
  const active = () => state.selected !== MEDIAPIPE_ID;
  const normalizeModel = value => {
    const id = String(value ?? '').trim().toLowerCase();
    if (!id || ['wasm','browser','mp','mediapipe_wasm'].includes(id)) return MEDIAPIPE_ID;
    if (['onnx','external','native','dwpose'].includes(id)) return DEFAULT_MODEL;
    return id;
  };
  const wsUrl = () => {
    const protocol = scope.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + (scope.location?.host || '127.0.0.1:8000') + '/__xra_backend/ws';
  };
  const send = object => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    try { state.ws.send(JSON.stringify(object)); return true; }
    catch (error) { state.lastError = String(error); return false; }
  };

  function notify(message) {
    const info = {
      sequence: state.sequence,
      width: finite(message?.capture_width, state.width),
      height: finite(message?.capture_height, state.height),
      frame_id: message?.frame_id,
      empty: !!message?.empty || !Array.isArray(message?.keypoints) || !message.keypoints.length,
    };
    for (const listener of listeners) {
      try { listener(info); }
      catch (error) { console.error('[XRA POSE WS] listener', error); }
    }
  }

  function handleMessage(event) {
    if (typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch (_ignored) { return; }
    if (message.type === 'status') {
      state.lastStatus = message;
      state.ready = !!message.ready;
      state.loading = !!message.loading;
      state.provider = message.provider || null;
      state.accelerated = !!message.accelerated;
      return;
    }
    if (message.type === 'pose') {
      state.framesReceived++;
      state.latest = message;
      state.sequence++;
      state.face = message.face || null;
      state.leftHand = Array.isArray(message.leftHand) ? message.leftHand : [];
      state.rightHand = Array.isArray(message.rightHand) ? message.rightHand : [];
      if (message.empty || !Array.isArray(message.keypoints) || !message.keypoints.length) state.emptyFrames++;
      notify(message);
      return;
    }
    if (message.type === 'error' || message.type === 'protocol_error') {
      state.errors++;
      state.lastError = message.error || message.type;
      if (state.debug) console.warn('[XRA POSE WS]', message);
    }
  }

  function scheduleReconnect() {
    if (!active() || state.reconnect != null) return;
    state.reconnect = setTimeout(() => {
      state.reconnect = null;
      connect();
    }, RECONNECT_MS);
  }

  function connect() {
    if (!active()) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    let socket;
    try { socket = new WebSocket(wsUrl()); }
    catch (error) {
      state.lastError = String(error);
      scheduleReconnect();
      return;
    }
    state.ws = socket;
    socket.onopen = () => {
      state.connected = true;
      state.lastError = '';
      // The main-window 11_backend.js socket is the only lifecycle/controller.
      // This worker only subscribes to landmark messages.
      send({ type: 'hello', role: 'pose' });
      send({ type: 'subscribe', poses: true });
      send({ type: 'status' });
    };
    socket.onmessage = handleMessage;
    socket.onerror = () => { state.lastError = 'websocket_error'; };
    socket.onclose = () => {
      if (state.ws === socket) state.ws = null;
      state.connected = state.ready = state.loading = false;
      scheduleReconnect();
    };
  }

  function close(reason) {
    if (state.reconnect != null) {
      clearTimeout(state.reconnect);
      state.reconnect = null;
    }
    const socket = state.ws;
    state.ws = null;
    state.connected = state.ready = false;
    if (socket) {
      try { socket.close(1000, reason || 'close'); } catch (_ignored) {}
    }
  }

  function selectBackend(value) {
    const next = normalizeModel(value);
    if (next === state.selected && (next === MEDIAPIPE_ID || state.connected)) return;
    state.selected = next;
    state.latest = null;
    state.sequence++;
    if (next === MEDIAPIPE_ID) close('mediapipe');
    else {
      close('model_change');
      connect();
    }
  }

  function pointOf(value) { return value?.position || value || {}; }
  function scoreOf(value) { return clamp(value?.score ?? value?.visibility ?? value?.confidence ?? 0.5, 0, 1); }
  function toPose(message, width, height) {
    if (!message) return null;
    if (message.empty || !Array.isArray(message.keypoints) || !message.keypoints.length) {
      return {
        score: 0,
        keypoints: [],
        keypoints3D: [],
        keypoints3D_raw: [],
        ea: [],
        has_pose: false,
        data_detected: 0,
        _xra_empty: true,
        _xra: { frame_id: message.frame_id, reason: message.reason || 'no_detection' },
      };
    }
    if (message.keypoints.length !== 33) return null;
    const w = finite(width, message.capture_width || state.width || 1);
    const h = finite(height, message.capture_height || state.height || 1);
    const keypoints = message.keypoints.map((entry, index) => {
      const point = pointOf(entry);
      const score = scoreOf(entry);
      const x = finite(point.x) * w;
      const y = finite(point.y) * h;
      const z = finite(point.z) * w;
      return {
        position: { x, y, z }, x, y, z,
        normX: finite(point.x), normY: finite(point.y), normZ: finite(point.z),
        score, visibility: score, name: NAMES[index], part: CAMEL[index],
      };
    });
    const source3D = Array.isArray(message.keypoints3D) && message.keypoints3D.length === 33
      ? message.keypoints3D
      : [];
    const keypoints3D = source3D.map((entry, index) => {
      const point = pointOf(entry);
      const score = scoreOf(entry);
      const x = clamp(point.x, -4, 4);
      const y = clamp(point.y, -4, 4);
      const z = clamp(point.z, -4, 4);
      return {
        position: { x, y, z }, x, y, z,
        score, visibility: score, name: NAMES[index], part: CAMEL[index],
      };
    });
    return {
      score: 1,
      keypoints,
      landmarks: keypoints,
      keypoints3D,
      keypoints3D_raw: keypoints3D.map(point => ({ ...point, position: { ...point.position } })),
      ea: keypoints3D.map(point => ({ ...point, position: { ...point.position } })),
      has_pose: true,
      data_detected: 1,
      _xra: {
        frame_id: message.frame_id,
        timestamp_ms: message.timestamp_ms,
        geometry: message.geometry,
        provider: message.provider,
        inference_ms: message.ms,
        source: 'backend_camera',
      },
    };
  }

  function consumeLatestPose(width, height) {
    if (state.consumed === state.sequence) return null;
    state.consumed = state.sequence;
    return toPose(state.latest, width, height);
  }

  function handleControl(event) {
    const data = event.data || {};
    if (data.type === 'tracker_backend' || data.type === 'tracker_model') {
      state.configured = true;
      selectBackend(data.value ?? data.backend ?? data.model);
      return;
    }
    if (data.type === 'tracker_model_complexity') {
      state.modelComplexity = data.value;
      return;
    }
    if (data.type === 'mocap_rates') return;
    if (data.type === 'xra_onnx_debug' || data.type === 'xra_debug') {
      state.debug = !!(data.enabled ?? data.value);
      return;
    }
    if (data.type === 'xra_onnx_reset') {
      close('reset');
      if (active()) connect();
    }
  }

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      state.control = new BroadcastChannel(CHANNEL);
      state.control.onmessage = handleControl;
      state.control.postMessage({ type: 'tracker_backend_request' });
    }
  } catch (_ignored) {}

  const api = {
    backendCameraVersion: 5,
    get active() { return active(); },
    get selected() { return state.selected; },
    get face() { return state.face; },
    get leftHand() { return state.leftHand; },
    get rightHand() { return state.rightHand; },
    get status() {
      return {
        ...state,
        ws: undefined,
        control: undefined,
        reconnect: undefined,
        latest: undefined,
      };
    },
    maybeReplaceFrame(_rgba, width, height) { return consumeLatestPose(width, height); },
    consumeLatestPose,
    setPoseListener(listener) {
      if (typeof listener === 'function') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    frontendReady(width, height) {
      state.frontendReady = true;
      if (Number.isFinite(Number(width))) state.width = Number(width);
      if (Number.isFinite(Number(height))) state.height = Number(height);
    },
    // Compatibility only. Camera commands are intentionally main-window only.
    cameraControl() { return false; },
    waitUntilConfigured(timeout = 1500) {
      if (state.configured) return Promise.resolve(state.selected);
      return new Promise(resolve => {
        const started = now();
        const poll = () => {
          if (state.configured || now() - started >= timeout) resolve(state.selected);
          else setTimeout(poll, 10);
        };
        poll();
      });
    },
    shutdown() {
      close('shutdown');
      state.control?.close?.();
      listeners.clear();
    },
  };
  scope.XRA_ONNX = api;
})(typeof self !== 'undefined' ? self : globalThis);
