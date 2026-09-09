(() => {
  'use strict';

  const XRA = window.XRA;
  const { config, events } = XRA;
  const CHANNEL_NAME = 'XRA_CONTROL';
  const DEFAULT_MAX_EVENTS = 12000;
  const EVENT_NAMES = [
    'body-stable', 'body-captured', 'body-transition', 'body-transition-end',
    'motion-hysteresis', 'upper-body-guard-reject', 'upper-body-guard-reacquired',
    'head-loss-guard', 'calibrated', 'startup-calibration-boost', 'pipeline',
    'profile-loaded', 'avatar-changed', 'camera-started', 'camera-stopped'
  ];

  config.debug ||= {};
  if (typeof config.debug.session_enabled !== 'boolean') config.debug.session_enabled = false;
  if (!Number.isFinite(Number(config.debug.max_events))) config.debug.max_events = DEFAULT_MAX_EVENTS;

  let enabled = !!config.debug.session_enabled;
  let entries = [];
  let sequence = 0;
  let sessionId = makeSessionId();
  let startedAt = new Date().toISOString();
  let channel = null;
  let lastCountEventAt = 0;
  const sampleTimes = new Map();

  function makeSessionId() {
    const random = Math.random().toString(36).slice(2, 8);
    return `${Date.now().toString(36)}-${random}`;
  }

  function assetVersion() {
    try {
      const source = document.currentScript?.src || '';
      return new URL(source, location.href).searchParams.get('v') || 'unknown';
    }
    catch (e) { return 'unknown'; }
  }

  const buildVersion = assetVersion();

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function serializable(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
      return { name:value.name, message:value.message, stack:String(value.stack || '').slice(0, 8000) };
    }
    if (depth >= 5) return '[max-depth]';
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const out = value.slice(0, 100).map(item => serializable(item, depth + 1, seen));
      if (value.length > 100) out.push(`[${value.length - 100} more]`);
      return out;
    }

    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/device_id|deviceid/i.test(key)) {
        out[key] = item ? '[redacted]' : '';
        continue;
      }
      try { out[key] = serializable(item, depth + 1, seen); }
      catch (e) { out[key] = `[unavailable: ${e?.message || e}]`; }
    }
    return out;
  }

  function maxEvents() {
    return Math.max(500, Math.min(50000, Number(config.debug?.max_events) || DEFAULT_MAX_EVENTS));
  }

  function record(type, data = null) {
    if (!enabled) return false;
    const now = performance.now();
    entries.push({
      seq: ++sequence,
      at_ms: Math.round(now * 1000) / 1000,
      wall_time: new Date().toISOString(),
      type: String(type || 'event'),
      data: serializable(data)
    });
    const overflow = entries.length - maxEvents();
    if (overflow > 0) entries.splice(0, overflow);
    if (now - lastCountEventAt >= 500) {
      lastCountEventAt = now;
      events.emit('debug-count', { entries:entries.length });
    }
    return true;
  }

  function sample(key, type, data, intervalMs = 250) {
    if (!enabled) return false;
    const now = performance.now();
    const previous = sampleTimes.get(key) || 0;
    if (now - previous < Math.max(0, Number(intervalMs) || 0)) return false;
    sampleTimes.set(key, now);
    return record(type, typeof data === 'function' ? data() : data);
  }

  function broadcastState() {
    try { channel?.postMessage({ type:'debug_trace', value:enabled }); }
    catch (e) {}
  }

  function clear() {
    entries = [];
    sequence = 0;
    sampleTimes.clear();
    lastCountEventAt = 0;
    sessionId = makeSessionId();
    startedAt = new Date().toISOString();
    if (enabled) record('debug.session.started', { reason:'clear', build:buildVersion });
    events.emit('debug-log', { action:'clear', entries:entries.length });
  }

  function setEnabled(value, options = {}) {
    const next = !!value;
    config.debug ||= {};
    config.debug.session_enabled = next;
    if (next === enabled) {
      broadcastState();
      return enabled;
    }
    if (next) {
      enabled = true;
      if (options.clear !== false) clear();
      else record('debug.session.started', { reason:options.reason || 'enabled', build:buildVersion });
    }
    else {
      record('debug.session.stopped', { reason:options.reason || 'disabled' });
      enabled = false;
    }
    broadcastState();
    events.emit('debug-session', { enabled, entries:entries.length });
    return enabled;
  }

  function runtimeSummary() {
    let model = null;
    try {
      const modelX = window.MMD_SA?.THREEX?.get_model?.(0) || window.MMD_SA?.THREEX?.models?.[0];
      model = modelX?.type || modelX?.constructor?.name || null;
    }
    catch (e) {}
    return {
      pipeline: config.performance?.tracking_pipeline || null,
      pose_model: config.pose_model || null,
      model,
      motion: window.MMD_SA?.MMD?.motionManager?.filename || null,
      camera_active: !!window.System?._browser?.camera?.initialized,
      body_stable: !!XRA.tracking?.bodyStable,
      anchor_strength: finite(config.body?.anchor_strength),
      motion_hysteresis: !!XRA.tracking?.motionHysteresis
    };
  }

  function snapshot() {
    return {
      schema: 'xra-debug-session/v1',
      session_id: sessionId,
      started_at: startedAt,
      generated_at: new Date().toISOString(),
      build: { asset_version:buildVersion, profile_version:XRA.profile?.version || null },
      environment: {
        origin: location.origin,
        pathname: location.pathname,
        user_agent: navigator.userAgent,
        language: navigator.language,
        viewport: { width:window.innerWidth, height:window.innerHeight, pixel_ratio:window.devicePixelRatio || 1 }
      },
      runtime: runtimeSummary(),
      config: serializable({
        pose_model: config.pose_model,
        performance: config.performance,
        body: config.body,
        tracking: config.tracking,
        debug: config.debug
      }),
      event_count: entries.length,
      events: entries.slice()
    };
  }

  async function saveWithFilePicker(name, content) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName:name,
        types:[{
          description:'XR Animator debug log',
          accept:{ 'application/json':['.json'] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return { ok:true, path:handle.name || name, method:'file-system-picker' };
    }
    catch (error) {
      if (error?.name === 'AbortError') return { ok:false, cancelled:true, method:'file-system-picker' };
      record('debug.export.picker-failure', { error });
      return null;
    }
  }

  async function saveWithNativeServer(name, content) {
    try {
      const response = await fetch('/__xra_debug/save', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ suggested_name:name, content })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `Debug save failed (${response.status})`);
      if (!data.path) return { ok:false, cancelled:true, method:'native-server-picker' };
      return { ok:true, path:data.path, method:'native-server-picker' };
    }
    catch (error) {
      record('debug.export.native-picker-failure', { error });
      return null;
    }
  }

  function downloadFallback(name, content) {
    const blob = new Blob([content], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok:true, path:name, method:'browser-download' };
  }

  async function exportLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `xra-debug-${stamp}.json`;
    record('debug.export.requested', { events:entries.length });
    const count = entries.length;
    const content = JSON.stringify(snapshot(), null, 2) + '\n';
    let result = await saveWithFilePicker(name, content);
    if (!result) result = await saveWithNativeServer(name, content);
    if (!result) result = downloadFallback(name, content);
    events.emit('debug-log', { action:'export', entries:entries.length, ...result });
    return { ...result, count };
  }

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'debug_state_request') broadcastState();
      if (data.type === 'xra_debug_event') {
        record(`worker.${data.name || 'event'}`, { source:data.source || 'worker', worker_at_ms:data.at_ms, ...data.data });
      }
    };
  }
  catch (e) {}

  for (const name of EVENT_NAMES) events.on(name, payload => record(`xra.${name}`, payload));
  window.addEventListener('error', event => record('window.error', {
    message:event.message, filename:event.filename, line:event.lineno, column:event.colno, error:event.error
  }));
  window.addEventListener('unhandledrejection', event => record('window.unhandledrejection', { reason:event.reason }));
  events.on('profile-loaded', () => {
    // A profile load can finish after the user has clicked the switch. Debug is
    // session state: never let that late refresh silently turn recording off.
    config.debug ||= {};
    config.debug.session_enabled = enabled;
    broadcastState();
  });

  XRA.debug = {
    record, sample, clear, setEnabled, snapshot, exportLog,
    get enabled() { return enabled; },
    get eventCount() { return entries.length; },
    get sessionId() { return sessionId; }
  };

  if (enabled) record('debug.session.started', { reason:'startup', build:buildVersion });
  broadcastState();
  setTimeout(broadcastState, 500);
  setTimeout(broadcastState, 1500);
  setTimeout(broadcastState, 3000);
})();
