/* XRA_BACKEND_CONTROL_V5: pose-only worker WebSocket. */
(function initXraBackendPoseBridge(scope) {
  'use strict';
  if (!scope) return;
  try { scope.XRA_NATIVE?.shutdown?.(); } catch (_ignored) {}

  const MEDIAPIPE_ID = 'mediapipe';
  const DEFAULT_MODEL = 'mediapipe-tasks-landmarker';
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
    selected: DEFAULT_MODEL,
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
    connectionAttempts: 0,
    duplicateSelections: 0,
    staleSocketEvents: 0,
    closeRequests: 0,
    socketState: 'idle',
    socketId: 0,
    lastPoseAt: 0,
    lastPoseFrameId: null,
    lastPoseSummary: null,
  };
  let socketSerial = 0;

  const now = () => scope.performance?.now?.() ?? Date.now();
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
  const active = () => state.selected !== MEDIAPIPE_ID;
  const normalizeModel = value => {
    const id = String(value ?? '').trim().toLowerCase();
    if (!id || ['wasm','browser','mp','mediapipe_wasm'].includes(id)) return MEDIAPIPE_ID;
    if (['onnx','external','native','dwpose'].includes(id)) return DEFAULT_MODEL; // legacy profile aliases
    return id;
  };
  const wsUrl = () => {
    const protocol = scope.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + (scope.location?.host || '127.0.0.1:8000') + '/__xra_backend/ws';
  };
  const sendOn = (socket, object) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(object)); return true; }
    catch (error) { state.lastError = String(error); return false; }
  };
  const send = object => sendOn(state.ws, object);

  function trace(name, detail = {}) {
    const payload = { name, at: Date.now(), ...detail };
    if (state.debug) console.info('[XRA POSE WS]', name, detail);
    if (state.debug && state.control) {
      try { state.control.postMessage({ type: 'xra_debug_event', source: 'pose_worker', ...payload }); }
      catch (_ignored) {}
    }
  }

  function poseSummary(message) {
    const body = Array.isArray(message?.keypoints) ? message.keypoints : [];
    const visible = body.reduce((count, point) => count + (finite(point?.score ?? point?.visibility) >= 0.25 ? 1 : 0), 0);
    return {
      frame_id: message?.frame_id ?? null,
      empty: !!message?.empty || body.length === 0,
      body_points: body.length,
      body_visible: visible,
      face_points: Array.isArray(message?.face?.landmarks) ? message.face.landmarks.length : 0,
      left_hand_points: Array.isArray(message?.leftHand) ? message.leftHand.length : 0,
      right_hand_points: Array.isArray(message?.rightHand) ? message.rightHand.length : 0,
      geometry: message?.geometry?.reason || null,
      provider: message?.provider || null,
    };
  }

  function notify(message) {
    if (!listeners.size) return;
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

  function handleMessage(event, socket) {
    if (state.ws !== socket) {
      state.staleSocketEvents++;
      return;
    }
    if (typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch (_ignored) { return; }
    if (message.type === 'status' || message.type === 'hardware_status') {
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
      if (message.capture_width) state.width = message.capture_width;
      if (message.capture_height) state.height = message.capture_height;
      if (typeof window !== 'undefined' && window.System?._browser?.camera?.video_canvas) {
        const vc = window.System._browser.camera.video_canvas;
        const cw = Number(message.capture_width) || 960;
        const ch = Number(message.capture_height) || 540;
        if (vc.width !== cw || vc.height !== ch) {
          vc.width = cw;
          vc.height = ch;
        }
      }
      state.face = message.face || null;
      state.leftHand = Array.isArray(message.leftHand) ? message.leftHand : [];
      state.rightHand = Array.isArray(message.rightHand) ? message.rightHand : [];
      if (message.empty || !Array.isArray(message.keypoints) || !message.keypoints.length) state.emptyFrames++;
      state.lastPoseAt = Date.now();
      state.lastPoseFrameId = message.frame_id ?? null;
      if (state.framesReceived === 1 || (state.debug && state.framesReceived % 150 === 0)) {
        state.lastPoseSummary = poseSummary(message);
        trace('pose.received', { frames_received: state.framesReceived, ...state.lastPoseSummary });
      }
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
    const socketId = ++socketSerial;
    const attempt = ++state.connectionAttempts;
    try { socket = new WebSocket(wsUrl()); }
    catch (error) {
      state.lastError = String(error);
      scheduleReconnect();
      return;
    }
    state.ws = socket;
    state.socketId = socketId;
    state.socketState = 'connecting';
    trace('socket.connecting', { socket_id: socketId, attempt, url: wsUrl() });
    socket.onopen = () => {
      if (state.ws !== socket) {
        state.staleSocketEvents++;
        try { socket.close(1000, 'stale_socket'); } catch (_ignored) {}
        return;
      }
      state.connected = true;
      state.socketState = 'open';
      state.lastError = '';
      // The main-window 11_backend.js socket is the only lifecycle/controller.
      // This worker only subscribes to landmark messages.
      sendOn(socket, { type: 'hello', role: 'pose' });
      sendOn(socket, { type: 'subscribe', poses: true });
      sendOn(socket, { type: 'status' });
      trace('socket.open', { socket_id: socketId, attempt });
    };
    socket.onmessage = event => handleMessage(event, socket);
    socket.onerror = () => {
      if (state.ws !== socket) {
        state.staleSocketEvents++;
        return;
      }
      state.lastError = 'websocket_error';
      trace('socket.error', { socket_id: socketId });
    };
    socket.onclose = event => {
      if (state.ws !== socket) {
        state.staleSocketEvents++;
        return;
      }
      state.ws = null;
      state.connected = state.ready = state.loading = false;
      state.socketState = 'closed';
      trace('socket.closed', {
        socket_id: socketId,
        code: event?.code ?? null,
        reason: event?.reason || '',
        clean: !!event?.wasClean,
      }, true);
      scheduleReconnect();
    };
  }

  function close(reason) {
    if (state.reconnect != null) {
      clearTimeout(state.reconnect);
      state.reconnect = null;
    }
    const socket = state.ws;
    state.closeRequests++;
    state.ws = null;
    state.connected = state.ready = false;
    state.loading = false;
    state.socketState = 'closed_by_client';
    if (socket) {
      try { socket.close(1000, reason || 'close'); } catch (_ignored) {}
    }
    trace('socket.close_requested', { socket_id: state.socketId, reason: reason || 'close' });
  }

  function selectBackend(value) {
    const next = normalizeModel(value);
    if (next === state.selected) {
      state.duplicateSelections++;
      trace('backend.duplicate_selection', {
        selected: next,
        duplicate_selections: state.duplicateSelections,
        socket_state: state.socketState,
      });
      const usable = state.ws && (
        state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING
      );
      if (next !== MEDIAPIPE_ID && !usable) connect();
      return;
    }
    state.selected = next;
    state.latest = null;
    state.sequence++;
    if (next === MEDIAPIPE_ID) close('mediapipe');
    else {
      close('model_change');
      connect();
    }
    trace('backend.selected', { selected: next });
  }

  function pointOf(value) { return value?.position || value || {}; }
  function scoreOf(value) {
    const raw = clamp(value?.score ?? value?.visibility ?? value?.confidence ?? 0.5, 0, 1);
    if (raw < 0.25) return 0.0;
    return 0.55 + 0.45 * Math.min(1.0, (raw - 0.25) / 0.70);
  }
  const _POOL_EMPTY_POSE = {
    score: 0,
    keypoints: [],
    keypoints3D: [],
    keypoints3D_raw: [],
    ea: [],
    has_pose: false,
    data_detected: 0,
    _xra_empty: true,
    _xra: { frame_id: 0, reason: 'no_detection' },
  };

  const _POOL_KP = Array.from({ length: 33 }, (_, i) => ({
    position: { x: 0, y: 0, z: 0 },
    x: 0, y: 0, z: 0,
    normX: 0, normY: 0, normZ: 0,
    score: 0, visibility: 0,
    name: NAMES[i], part: CAMEL[i],
  }));

  const _POOL_KP3D = Array.from({ length: 33 }, (_, i) => ({
    position: { x: 0, y: 0, z: 0 },
    x: 0, y: 0, z: 0,
    score: 0, visibility: 0,
    name: NAMES[i], part: CAMEL[i],
  }));

  const _POOL_KP3D_RAW = Array.from({ length: 33 }, (_, i) => ({
    position: { x: 0, y: 0, z: 0 },
    x: 0, y: 0, z: 0,
    score: 0, visibility: 0,
    name: NAMES[i], part: CAMEL[i],
  }));

  const _POOL_EA = Array.from({ length: 33 }, (_, i) => ({
    position: { x: 0, y: 0, z: 0 },
    x: 0, y: 0, z: 0,
    score: 0, visibility: 0,
    name: NAMES[i], part: CAMEL[i],
  }));

  const _POOL_XRA_META = {
    frame_id: 0,
    timestamp_ms: 0,
    geometry: null,
    provider: null,
    inference_ms: 0,
    source: 'backend_camera',
  };

  const _POOL_POSE = {
    score: 1,
    keypoints: _POOL_KP,
    _keypoints: _POOL_KP,
    landmarks: _POOL_KP,
    keypoints3D: _POOL_KP3D,
    _keypoints3D: _POOL_KP3D,
    keypoints3D_raw: _POOL_KP3D_RAW,
    ea: _POOL_EA,
    has_pose: true,
    data_detected: 1,
    _xra: _POOL_XRA_META,
  };

  function toPose(message, width, height) {
    if (!message) return null;
    if (message.empty || !Array.isArray(message.keypoints) || !message.keypoints.length) {
      _POOL_EMPTY_POSE._xra.frame_id = message.frame_id;
      _POOL_EMPTY_POSE._xra.reason = message.reason || 'no_detection';
      return _POOL_EMPTY_POSE;
    }
    if (message.keypoints.length !== 33) return null;
    const w = finite(width, message.capture_width || state.width || 1);
    const h = finite(height, message.capture_height || state.height || 1);
    for (let index = 0; index < 33; index++) {
      const entry = message.keypoints[index];
      const point = pointOf(entry);
      const score = scoreOf(entry);
      const px = finite(point.x);
      const py = finite(point.y);
      const pz = finite(point.z);
      const x = px * w;
      const y = py * h;
      const z = pz * w;
      const target = _POOL_KP[index];
      target.x = x; target.y = y; target.z = z;
      target.position.x = x; target.position.y = y; target.position.z = z;
      target.normX = px; target.normY = py; target.normZ = pz;
      target.score = score; target.visibility = score;
    }
    const source3D = Array.isArray(message.keypoints3D) && message.keypoints3D.length === 33
      ? message.keypoints3D
      : null;
    for (let index = 0; index < 33; index++) {
      let x = 0, y = 0, z = 0, score = 0;
      if (source3D) {
        const entry = source3D[index];
        const point = pointOf(entry);
        score = scoreOf(entry);
        x = clamp(point.x, -4, 4);
        y = clamp(point.y, -4, 4);
        z = clamp(point.z, -4, 4);
      }
      const t3 = _POOL_KP3D[index];
      t3.x = x; t3.y = y; t3.z = z;
      t3.position.x = x; t3.position.y = y; t3.position.z = z;
      t3.score = score; t3.visibility = score;

      const raw = _POOL_KP3D_RAW[index];
      raw.x = x; raw.y = y; raw.z = z;
      raw.position.x = x; raw.position.y = y; raw.position.z = z;
      raw.score = score; raw.visibility = score;

      const ea = _POOL_EA[index];
      ea.x = x; ea.y = y; ea.z = z;
      ea.position.x = x; ea.position.y = y; ea.position.z = z;
      ea.score = score; ea.visibility = score;
    }
    _POOL_XRA_META.frame_id = message.frame_id;
    _POOL_XRA_META.timestamp_ms = message.timestamp_ms;
    _POOL_XRA_META.geometry = message.geometry;
    _POOL_XRA_META.provider = message.provider;
    _POOL_XRA_META.inference_ms = message.ms;
    return _POOL_POSE;
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
    if (data.type === 'tracker_hardware') {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'hardware', mode: data.value }));
      }
      return;
    }
    if (data.type === 'tracker_model_complexity') {
      state.modelComplexity = data.value;
      return;
    }
    if (data.type === 'mocap_rates') return;
    if (data.type === 'xra_native_debug' || data.type === 'xra_debug') {
      state.debug = !!(data.enabled ?? data.value);
      return;
    }
    if (data.type === 'xra_native_reset') {
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
  scope.XRA_NATIVE = api;
  scope.XRA_BACKEND = api;
})(typeof self !== 'undefined' ? self : globalThis);
