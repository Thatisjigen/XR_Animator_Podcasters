(() => {
  'use strict';

  const XRA = window.XRA;
  const { config, events } = XRA;
  const TAG = '[XRA AUDIO]';

  let stream = null;
  let context = null;
  let source = null;
  let profile = null;
  let deviceId = null;
  let startPromise = null;

  function liveTrack() {
    return stream?.getAudioTracks?.().find(track => track.readyState === 'live') || null;
  }

  function constraintsFor(nextProfile = 'podcast') {
    const call = String(nextProfile || 'podcast') === 'call';
    const selected = config.devices?.mic_device_id || '';
    return {
      ...(selected ? { deviceId: { ideal: selected } } : {}),
      echoCancellation: call,
      noiseSuppression: call,
      autoGainControl: call,
      channelCount: { ideal: 1 }
    };
  }

  async function create(nextProfile = 'podcast') {
    const selected = config.devices?.mic_device_id || '';
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsFor(nextProfile), video: false });
    context = new (window.AudioContext || window.webkitAudioContext)();
    await context.resume();
    source = context.createMediaStreamSource(stream);
    profile = String(nextProfile || 'podcast');
    deviceId = selected;
    events.emit('audio-engine', status());
    return api();
  }

  async function ensure({ profile: requested = null } = {}) {
    const nextProfile = String(requested || config.recorder?.audio_profile || 'podcast');
    const selected = config.devices?.mic_device_id || '';
    if (startPromise) return startPromise;

    if (!liveTrack() || !context || context.state === 'closed' || selected !== deviceId) {
      startPromise = (async () => {
        await shutdown();
        return create(nextProfile);
      })();
      try { return await startPromise; }
      finally { startPromise = null; }
    }

    if (context.state === 'suspended') {
      try { await context.resume(); } catch (e) {}
    }

    if (profile !== nextProfile) {
      try {
        await liveTrack()?.applyConstraints?.(constraintsFor(nextProfile));
        profile = nextProfile;
        events.emit('audio-engine-profile', status());
      }
      catch (e) {
        console.warn(TAG, 'audio processing constraints update failed; keeping current capture', e);
      }
    }
    return api();
  }

  async function restart(options = {}) {
    await shutdown();
    return ensure(options);
  }

  async function shutdown() {
    try { stream?.getTracks?.().forEach(track => track.stop()); } catch (e) {}
    try { await context?.close?.(); } catch (e) {}
    stream = null;
    context = null;
    source = null;
    profile = null;
    deviceId = null;
    events.emit('audio-engine-stop');
  }

  function makeAnalyser({ fftSize = 1024, smoothing = 0.2 } = {}) {
    if (!context || !source) throw new Error('Audio engine is not ready');
    const analyser = context.createAnalyser();
    analyser.fftSize = Math.max(32, Number(fftSize) || 1024);
    analyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, Number(smoothing) || 0));
    source.connect(analyser);
    return analyser;
  }

  function disconnect(node) {
    try { source?.disconnect?.(node); } catch (e) {}
    try { node?.disconnect?.(); } catch (e) {}
  }

  function status() {
    const track = liveTrack();
    return {
      active: !!track,
      profile: profile || null,
      device_id: deviceId || '',
      label: track?.label || '',
      sample_rate: context?.sampleRate || 0,
      context_state: context?.state || 'closed'
    };
  }

  function api() {
    return { stream, context, source, profile, deviceId };
  }

  XRA.audioEngine = { ensure, restart, shutdown, makeAnalyser, disconnect, status, get stream() { return stream; }, get context() { return context; }, get source() { return source; } };
})();
