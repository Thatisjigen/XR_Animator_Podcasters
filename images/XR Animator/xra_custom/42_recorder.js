(() => {
  'use strict';

  const XRA = window.XRA;
  const { config, events } = XRA;
  const TAG = '[XRA RECORDER]';

  const PRESETS = {
    COMPACT:   { width: 1280, height: 720,  fps: 30, video_bps: 1500000, audio_bps: 96000 },
    PODCAST:   { width: 1280, height: 720,  fps: 30, video_bps: 2500000, audio_bps: 128000 },
    HIGH:      { width: 1920, height: 1080, fps: 30, video_bps: 5000000, audio_bps: 160000 },
    VERY_HIGH: { width: 1920, height: 1080, fps: 60, video_bps: 8000000, audio_bps: 192000 }
  };

  let recorder = null;
  let outputStream = null;
  let recordingCanvas = null;
  let recordingCtx = null;
  let sourceCanvas = null;
  let drawRAF = 0;
  let drawFrames = 0;
  let drawStartedAt = 0;
  let captureStrategy = 'composite';

  let gateTimer = null;
  let gateAnalyser = null;
  let gateGain = null;
  let gateDestination = null;
  let gateSamples = null;
  let gateCurrentDb = -120;
  let gateOpen = false;

  let monitorTimer = null;
  let monitorAnalyser = null;
  let monitorSamples = null;

  let mainSession = null;
  let rawSession = null;
  let rawRecorder = null;
  let segmentIndex = 0;
  let segmentTimer = null;
  let rotationPromise = null;
  let rotating = false;
  let stopRequested = false;
  let startTime = 0;
  let statusTimer = null;
  let wakeLock = null;
  let currentPath = '';
  let rawPath = '';
  let completedBytes = 0;
  let freeBytes = null;
  let finalizing = false;
  let hud = null;
  let backgroundImage = null;
  let backgroundImageSrc = '';
  let rendererRestore = null;
  let lastRenderResolutionCheck = 0;
  let sourceRenderWidth = 0;
  let sourceRenderHeight = 0;
  let sourceWasUpscaled = false;
  let chromaFxRestore = null;
  // V7.6.6 native-quality bridge. We let XR Animator render/record through its
  // original high-fidelity path, then intercept the generated video Blob and
  // hand it to the XRA server pipeline for folder/name/format/audio finalization.
  let nativeModeActive = false;
  let nativeAudioRecorder = null;
  let nativeAudioSession = null;
  let nativeBlobPromise = null;
  let nativeBlobResolve = null;
  let nativeBlobReject = null;
  let nativeBlobResult = null;
  let nativeOriginalAnchorClick = null;
  let nativeOriginalRevokeObjectURL = null;
  let nativeDocumentClickHandler = null;
  let nativeCapturedHref = '';

  function cfg() {
    config.recorder ||= {};
    return config.recorder;
  }

  function humanBytes(bytes) {
    bytes = Number(bytes || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(i === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
  }

  function humanTime(ms) {
    const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  // Reliability rule: WebM is the source container. MP4/MKV are finalized by the
  // local server after Stop. This avoids Chromium/Electron variants that report
  // an empty/unstable MP4 MediaRecorder mimeType and previously produced .bin.
  function chooseSourceMime(mode) {
    const candidates = mode === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
    for (const type of candidates) {
      if (!window.MediaRecorder?.isTypeSupported || MediaRecorder.isTypeSupported(type)) return type;
    }
    return mode === 'audio' ? 'audio/webm' : 'video/webm';
  }

  function isWebGLCanvas(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    try {
      // Asking for the already-created context type returns the existing context;
      // asking for 2D on a WebGL canvas returns null. We never accept a generic
      // 2D canvas here because XR Animator's webcam/debug preview also uses one.
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  function canvasLabel(canvas) {
    if (!canvas) return 'unknown';
    const bits = [canvas.id, canvas.className, canvas.dataset?.name, canvas.getAttribute?.('aria-label')]
      .filter(Boolean).map(String);
    return bits.join(' ') || `${canvas.width}x${canvas.height} WebGL canvas`;
  }

  function canvasLooksLikeWebcamOrDebug(canvas) {
    const text = `${canvas?.id || ''} ${canvas?.className || ''} ${canvas?.dataset?.name || ''}`.toLowerCase();
    return /(webcam|camera|mocap|pose|hand|face|debug|wire|landmark|preview)/.test(text);
  }

  function sceneCanvasCandidates() {
    const out = [];
    const add = value => {
      if (!(value instanceof HTMLCanvasElement)) return;
      if (value.dataset.xraRecorderCanvas) return;
      if (value.width < 160 || value.height < 120) return;
      if (!isWebGLCanvas(value)) return;
      if (!out.includes(value)) out.push(value);
    };
    try { add(window.MMD_SA?.THREEX?.renderer?.domElement); } catch (e) {}
    try { add(window.MMD_SA?.THREEX?._renderer?.domElement); } catch (e) {}
    try { add(window.MMD_SA?.THREEX?._THREE?.renderer?.domElement); } catch (e) {}
    document.querySelectorAll('canvas').forEach(add);
    return out;
  }

  function resolveSceneCanvas() {
    const preferred = [];
    const addPreferred = value => {
      if (value instanceof HTMLCanvasElement && isWebGLCanvas(value) && value.width >= 160 && value.height >= 120 && !preferred.includes(value)) preferred.push(value);
    };
    try { addPreferred(window.MMD_SA?.THREEX?.renderer?.domElement); } catch (e) {}
    try { addPreferred(window.MMD_SA?.THREEX?._renderer?.domElement); } catch (e) {}
    try { addPreferred(window.MMD_SA?.THREEX?._THREE?.renderer?.domElement); } catch (e) {}
    if (preferred.length) return preferred[0];

    const candidates = sceneCanvasCandidates().filter(c => !canvasLooksLikeWebcamOrDebug(c));
    if (!candidates.length) {
      throw new Error('3D scene output canvas not found. Recording was aborted rather than capturing the webcam/debug preview.');
    }
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const av = (ar.width * ar.height) || (a.width * a.height);
      const bv = (br.width * br.height) || (b.width * b.height);
      return bv - av;
    });
    if (candidates.length > 1) console.warn(TAG, 'multiple WebGL scene candidates; using', canvasLabel(candidates[0]), candidates);
    return candidates[0];
  }

  function drawCover(ctx, source, width, height) {
    const sw = Number(source?.videoWidth || source?.naturalWidth || source?.width || 0);
    const sh = Number(source?.videoHeight || source?.naturalHeight || source?.height || 0);
    if (!sw || !sh) return false;
    const scale = Math.max(width / sw, height / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
    return true;
  }

  function refreshBackgroundImage() {
    const path = config.background?.mode === 'image' ? String(config.background?.path || '') : '';
    if (!path || path === backgroundImageSrc) return;
    backgroundImageSrc = path;
    backgroundImage = new Image();
    backgroundImage.decoding = 'async';
    backgroundImage.src = new URL(path, location.href).href;
  }

  function drawBackdrop(ctx, width, height) {
    const bodyColor = config.background?.mode === 'color'
      ? (config.background?.color || '#202020')
      : (getComputedStyle(document.body).backgroundColor || config.background?.color || '#202020');
    ctx.fillStyle = bodyColor;
    ctx.fillRect(0, 0, width, height);
    const videoBg = document.getElementById('VdesktopBG');
    if (videoBg instanceof HTMLVideoElement && videoBg.readyState >= 2 && getComputedStyle(videoBg).visibility !== 'hidden') {
      try { if (drawCover(ctx, videoBg, width, height)) return; } catch (e) {}
    }
    refreshBackgroundImage();
    if (backgroundImage?.complete && backgroundImage.naturalWidth) {
      try { drawCover(ctx, backgroundImage, width, height); } catch (e) {}
    }
  }

  function resolveRenderer() {
    const candidates = [
      window.MMD_SA?.THREEX?.renderer,
      window.MMD_SA?.THREEX?._renderer,
      window.MMD_SA?.THREEX?._THREE?.renderer
    ];
    return candidates.find(r => r && r.domElement instanceof HTMLCanvasElement && typeof r.setSize === 'function') || null;
  }

  function ensureNativeRenderResolution(width, height, { initial = false } = {}) {
    if (cfg().force_render_resolution === false || !sourceCanvas) return false;
    if (sourceCanvas.width >= width && sourceCanvas.height >= height) {
      sourceRenderWidth = sourceCanvas.width;
      sourceRenderHeight = sourceCanvas.height;
      return true;
    }
    const renderer = resolveRenderer();
    if (!renderer) {
      sourceRenderWidth = sourceCanvas.width;
      sourceRenderHeight = sourceCanvas.height;
      sourceWasUpscaled = sourceCanvas.width < width || sourceCanvas.height < height;
      return false;
    }
    try {
      if (initial && !rendererRestore) {
        const pixelRatio = Math.max(.25, Number(renderer.getPixelRatio?.() || 1));
        rendererRestore = {
          renderer,
          pixelRatio,
          logicalWidth: Math.max(1, Math.round(sourceCanvas.width / pixelRatio)),
          logicalHeight: Math.max(1, Math.round(sourceCanvas.height / pixelRatio))
        };
      }
      const pr = Math.max(.25, Number(renderer.getPixelRatio?.() || 1));
      renderer.setSize(Math.ceil(width / pr), Math.ceil(height / pr), false);
      sourceRenderWidth = sourceCanvas.width;
      sourceRenderHeight = sourceCanvas.height;
      sourceWasUpscaled = sourceCanvas.width < width || sourceCanvas.height < height;
      return !sourceWasUpscaled;
    } catch (e) {
      console.warn(TAG, 'could not force renderer recording resolution', e);
      sourceRenderWidth = sourceCanvas.width;
      sourceRenderHeight = sourceCanvas.height;
      sourceWasUpscaled = sourceCanvas.width < width || sourceCanvas.height < height;
      return false;
    }
  }

  function restoreNativeRenderResolution() {
    const saved = rendererRestore;
    rendererRestore = null;
    if (!saved?.renderer) return;
    try { saved.renderer.setSize(saved.logicalWidth, saved.logicalHeight, false); }
    catch (e) { console.warn(TAG, 'could not restore renderer resolution', e); }
  }

  function beginChromaSafe() {
    chromaFxRestore = null;
    const c = cfg();
    if (!c.chroma_safe || config.background?.mode !== 'color') return;
    const ppe = window.MMD_SA?.THREEX?.PPE;
    if (!ppe) return;
    chromaFxRestore = {};
    for (const key of ['UnrealBloom', 'DOF']) {
      const fx = ppe?.[key];
      if (!fx || typeof fx.enabled !== 'boolean') continue;
      chromaFxRestore[key] = !!fx.enabled;
      fx.enabled = false;
    }
  }

  function restoreChromaSafe() {
    if (!chromaFxRestore) return;
    const ppe = window.MMD_SA?.THREEX?.PPE;
    for (const [key, enabled] of Object.entries(chromaFxRestore)) {
      try { if (ppe?.[key]) ppe[key].enabled = !!enabled; } catch (e) {}
    }
    chromaFxRestore = null;
  }

  function directCaptureIsSafe(width, height) {
    if (String(cfg().capture_strategy || 'auto') === 'composite') return false;
    if (!sourceCanvas || sourceCanvas.width !== width || sourceCanvas.height !== height) return false;
    // External wallpaper/video backgrounds live outside the WebGL canvas.
    if (config.background?.mode === 'image') return false;
    const videoBg = document.getElementById('VdesktopBG');
    if (videoBg instanceof HTMLVideoElement && getComputedStyle(videoBg).visibility !== 'hidden') return false;
    try {
      const renderer = window.MMD_SA?.THREEX?.renderer || window.MMD_SA?.THREEX?._renderer;
      if (Number(renderer?.getClearAlpha?.()) >= 0.999) return true;
    } catch (e) {}
    return false;
  }

  function captureSourceMode() {
    const raw = String(cfg().capture_source || 'classic_v74');
    // Retire both historical visible-output fallbacks. They either delegated all
    // settings to the legacy recorder or used getDisplayMedia + a 2D rescale,
    // which caused permission prompts and visibly softer output.
    if (raw === 'native_visible' || raw === 'browser_visible') {
      cfg().capture_source = 'classic_v74';
      return 'classic_v74';
    }
    return raw;
  }

  function useNativeXrCapture() {
    return captureSourceMode() === 'native_xr' && (cfg().mode || 'video_audio') !== 'audio';
  }

  function nativeVideoCapture() {
    const vc = window.System?._browser?.video_capture;
    if (!vc || typeof vc.start !== 'function' || typeof vc.stop !== 'function') {
      throw new Error('XR Animator native video recorder is not available in this runtime. Use Clean scene output instead.');
    }
    return vc;
  }

  function configureNativeVideoCapture() {
    const c = cfg();
    const vc = nativeVideoCapture();
    vc.target_width = Math.max(1, Number(c.width || 1280));
    vc.target_height = Math.max(1, Number(c.height || 720));
    vc.fps = Math.max(1, Number(c.fps || 30));
    // Capture a stable source container. MP4/MKV are finalized by our Linux
    // server so output path/name/audio processing remain under XRA control.
    vc.target_mime_type = 'video/webm';
    try {
      const specs = vc.get_specs?.() || {};
      sourceRenderWidth = Number(specs.width || vc.target_width || 0);
      sourceRenderHeight = Number(specs.height || vc.target_height || 0);
      sourceWasUpscaled = false;
      console.log(TAG, 'native XR recorder configured', { target_width: vc.target_width, target_height: vc.target_height, fps: vc.fps, target_mime_type: vc.target_mime_type, specs });
    } catch (e) {
      sourceRenderWidth = vc.target_width;
      sourceRenderHeight = vc.target_height;
      sourceWasUpscaled = false;
    }
    return vc;
  }

  function shouldInterceptNativeAnchor(anchor) {
    if (!nativeModeActive || !anchor) return false;
    const href = String(anchor.href || anchor.getAttribute?.('href') || '');
    if (!/^blob:/i.test(href)) return false;
    const name = String(anchor.download || anchor.getAttribute?.('download') || '');
    return !name || /\.(?:webm|mp4|mkv|mov|m4v)$/i.test(name) || /video/i.test(name);
  }

  async function captureNativeBlob(href, downloadName = '') {
    if (nativeBlobResult || !href) return;
    nativeCapturedHref = href;
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`Native recorder blob fetch failed (${response.status})`);
      const blob = await response.blob();
      if (!blob?.size) throw new Error('XR native recorder produced an empty video Blob');
      if (blob.type && !/^video\//i.test(blob.type) && !/webm|mp4|matroska/i.test(blob.type)) {
        throw new Error(`XR native recorder produced an unexpected Blob type: ${blob.type}`);
      }
      nativeBlobResult = { blob, downloadName: downloadName || '', mimeType: blob.type || 'video/webm' };
      nativeBlobResolve?.(nativeBlobResult);
      console.log(TAG, 'intercepted native XR video', { bytes: blob.size, type: blob.type, downloadName });
    } catch (e) {
      nativeBlobReject?.(e);
    }
  }

  function installNativeDownloadIntercept() {
    restoreNativeDownloadIntercept();
    nativeBlobResult = null;
    nativeCapturedHref = '';
    nativeBlobPromise = new Promise((resolve, reject) => { nativeBlobResolve = resolve; nativeBlobReject = reject; });

    nativeOriginalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(...args) {
      if (shouldInterceptNativeAnchor(this)) {
        captureNativeBlob(String(this.href || ''), String(this.download || '')).catch(() => {});
        return;
      }
      return nativeOriginalAnchorClick.apply(this, args);
    };

    nativeDocumentClickHandler = event => {
      const anchor = event.target?.closest?.('a');
      if (!shouldInterceptNativeAnchor(anchor)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      captureNativeBlob(String(anchor.href || ''), String(anchor.download || '')).catch(() => {});
    };
    document.addEventListener('click', nativeDocumentClickHandler, true);

    nativeOriginalRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = function(url) {
      if (nativeModeActive && nativeCapturedHref && String(url) === nativeCapturedHref) {
        setTimeout(() => { try { nativeOriginalRevokeObjectURL.call(URL, url); } catch (e) {} }, 30000);
        return;
      }
      return nativeOriginalRevokeObjectURL.call(URL, url);
    };
  }

  function restoreNativeDownloadIntercept() {
    if (nativeOriginalAnchorClick) {
      try { HTMLAnchorElement.prototype.click = nativeOriginalAnchorClick; } catch (e) {}
    }
    if (nativeDocumentClickHandler) {
      try { document.removeEventListener('click', nativeDocumentClickHandler, true); } catch (e) {}
    }
    if (nativeOriginalRevokeObjectURL) {
      try { URL.revokeObjectURL = nativeOriginalRevokeObjectURL; } catch (e) {}
    }
    nativeOriginalAnchorClick = null;
    nativeDocumentClickHandler = null;
    nativeOriginalRevokeObjectURL = null;
  }

  async function waitNativeBlob(timeoutMs = 20000) {
    if (nativeBlobResult) return nativeBlobResult;
    if (!nativeBlobPromise) throw new Error('Native recorder output interception was not initialized');
    let timer;
    try {
      return await Promise.race([
        nativeBlobPromise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('XR native recorder stopped, but its output file could not be intercepted. The browser may be using a non-download save path.')), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function uploadBlobSequential(state, blob, sliceBytes = 8 * 1024 * 1024) {
    for (let offset = 0; offset < blob.size; offset += sliceBytes) {
      await uploadChunk(state, blob.slice(offset, Math.min(blob.size, offset + sliceBytes), blob.type));
    }
  }

  async function startNativeProcessedAudio() {
    const c = cfg();
    if ((c.mode || 'video_audio') === 'video') return;
    const audio = await createAudioStream();
    const mimeType = chooseSourceMime('audio');
    nativeAudioRecorder = new MediaRecorder(audio, { mimeType, audioBitsPerSecond: Number(c.audio_bps || 128000) });
    nativeAudioSession = newSessionState('native_audio');
    await beginServerSession(nativeAudioSession, {
      mimeType: nativeAudioRecorder.mimeType || mimeType || 'audio/webm', mode: 'audio',
      outputFormat: 'webm', filename: expandedFilename('_audio_work'),
      audioBps: Number(c.audio_bps || 128000), temporary: true, forceSourceTemp: true
    });
    nativeAudioRecorder.ondataavailable = event => event.data?.size && queueChunk(nativeAudioSession, event.data);
    nativeAudioRecorder.onerror = event => events.emit('recording-error', event.error || event);
    nativeAudioRecorder.start(5000);
  }

  async function finalizeNativeSessions(videoBlob) {
    const c = cfg();
    mainSession = newSessionState('main');
    const nativeMime = videoBlob.mimeType || videoBlob.blob?.type || 'video/webm';
    await beginServerSession(mainSession, {
      mimeType: nativeMime, mode: c.mode || 'video_audio', outputFormat: String(c.output_format || 'webm').toLowerCase(),
      filename: expandedFilename(), forceSourceTemp: true
    });
    currentPath = mainSession.path;
    await uploadBlobSequential(mainSession, videoBlob.blob);
    await flushSession(mainSession);
    if (nativeAudioSession) await flushSession(nativeAudioSession);

    const response = await fetch('/__xra_recording/finalize-native', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_session: mainSession.id, audio_session: nativeAudioSession?.id || '' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const kept = [data.source_path, data.audio_source_path].filter(Boolean).join(' + ');
      throw new Error((data.error || 'Native recording finalization failed') + (kept ? ` Source kept at: ${kept}` : ''));
    }
    mainSession.id = null;
    if (nativeAudioSession) nativeAudioSession.id = null;
    mainSession.path = data.path || mainSession.path;
    mainSession.bytes = Number(data.bytes || mainSession.bytes || 0);
    events.emit('recording-file', { ...data, kind: 'main', native_xr: true });
    return data;
  }

  async function startNativeXrRecorder() {
    if (!window.MediaRecorder && (cfg().mode || 'video_audio') !== 'video') {
      throw new Error('MediaRecorder is required for XRA processed audio');
    }
    const vc = configureNativeVideoCapture();
    captureStrategy = 'native_xr';
    nativeModeActive = true;
    installNativeDownloadIntercept();
    await startNativeProcessedAudio();
    const result = vc.start();
    if (result?.then) await result;
    return true;
  }

  async function stopNativeXrRecorder() {
    const vc = nativeVideoCapture();
    let nativeStopError = null;
    try {
      const result = vc.stop();
      if (result?.then) await result;
    } catch (e) { nativeStopError = e; }
    try { await stopMediaRecorder(nativeAudioRecorder); } catch (e) { nativeStopError ||= e; }
    try { await flushSession(nativeAudioSession); } catch (e) { nativeStopError ||= e; }
    if (nativeStopError) throw nativeStopError;
    const nativeBlob = await waitNativeBlob();
    return finalizeNativeSessions(nativeBlob);
  }

  async function createSelectedVideoStream() {
    if (captureSourceMode() === 'classic_v74') return createClassicVideoStream();
    return createVideoStream();
  }

  // V7.6.7 - exact-style restoration of the first V7.4 compositor path.
  // External background + XR scene canvas -> recorder canvas. No screen share,
  // no native XR recorder, no renderer resize, no direct-capture shortcut.
  function resolveClassicSceneCanvas() {
    const preferred = [];
    const add = value => {
      if (value instanceof HTMLCanvasElement && value.width >= 160 && value.height >= 120 && !preferred.includes(value)) preferred.push(value);
    };
    try { add(window.MMD_SA?.THREEX?.renderer?.domElement); } catch (e) {}
    try { add(window.MMD_SA?.THREEX?._renderer?.domElement); } catch (e) {}
    try { add(window.MMD_SA?.THREEX?._THREE?.renderer?.domElement); } catch (e) {}
    if (preferred.length) return preferred[0];

    const candidates = [];
    document.querySelectorAll('canvas').forEach(node => {
      if (node instanceof HTMLCanvasElement && !node.dataset.xraRecorderCanvas && node.width >= 160 && node.height >= 120) candidates.push(node);
    });
    if (!candidates.length) throw new Error('Classic recorder: XR scene canvas not found');
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const av = (ar.width * ar.height) || (a.width * a.height);
      const bv = (br.width * br.height) || (b.width * b.height);
      return bv - av;
    });
    return candidates[0];
  }

  function createClassicVideoStream() {
    sourceCanvas = resolveClassicSceneCanvas();
    const c = cfg();
    const width = Number(c.width || sourceCanvas.width || 1280);
    const height = Number(c.height || sourceCanvas.height || 720);
    const fps = Math.max(1, Number(c.fps || 30));
    sourceRenderWidth = sourceCanvas.width;
    sourceRenderHeight = sourceCanvas.height;
    sourceWasUpscaled = sourceCanvas.width < width || sourceCanvas.height < height;
    captureStrategy = 'classic_v74';
    drawFrames = 0;
    drawStartedAt = performance.now();

    console.log(TAG, 'classic recording source:', canvasLabel(sourceCanvas), sourceCanvas.width + 'x' + sourceCanvas.height, '=>', width + 'x' + height);

    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = width;
    recordingCanvas.height = height;
    recordingCanvas.dataset.xraRecorderCanvas = '1';
    recordingCtx = recordingCanvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!recordingCtx) throw new Error('Classic recorder canvas context unavailable');

    let last = 0;
    const interval = 1000 / fps;
    const draw = now => {
      if (!recordingCanvas) return;
      if (now - last >= interval - 1) {
        last = now;
        try {
          drawBackdrop(recordingCtx, width, height);
          recordingCtx.drawImage(sourceCanvas, 0, 0, width, height);
          drawFrames++;
        } catch (e) {}
      }
      drawRAF = requestAnimationFrame(draw);
    };
    drawRAF = requestAnimationFrame(draw);
    return recordingCanvas.captureStream(fps);
  }

  function createVideoStream() {
    sourceCanvas = resolveSceneCanvas();
    console.log(TAG, 'recording scene source:', canvasLabel(sourceCanvas), sourceCanvas.width + 'x' + sourceCanvas.height);
    const c = cfg();
    const width = Number(c.width || sourceCanvas.width || 1280);
    const height = Number(c.height || sourceCanvas.height || 720);
    sourceRenderWidth = sourceCanvas.width; sourceRenderHeight = sourceCanvas.height; sourceWasUpscaled = false;
    ensureNativeRenderResolution(width, height, { initial: true });
    const fps = Math.max(1, Number(c.fps || 30));
    drawFrames = 0;
    drawStartedAt = performance.now();

    if (directCaptureIsSafe(width, height)) {
      captureStrategy = 'direct';
      return sourceCanvas.captureStream(fps);
    }

    captureStrategy = 'composite';
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = width;
    recordingCanvas.height = height;
    recordingCanvas.dataset.xraRecorderCanvas = '1';
    recordingCtx = recordingCanvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!recordingCtx) throw new Error('Recording canvas context unavailable');

    let last = 0;
    const interval = 1000 / fps;
    const draw = now => {
      if (!recordingCanvas) return;
      if (now - last >= interval - 1) {
        last = now;
        try {
          if (now - lastRenderResolutionCheck > 1000) {
            lastRenderResolutionCheck = now;
            ensureNativeRenderResolution(width, height);
          }
          drawBackdrop(recordingCtx, width, height);
          recordingCtx.drawImage(sourceCanvas, 0, 0, width, height);
          drawFrames++;
        } catch (e) {}
      }
      drawRAF = requestAnimationFrame(draw);
    };
    drawRAF = requestAnimationFrame(draw);
    return recordingCanvas.captureStream(fps);
  }

  async function createAudioStream() {
    const c = cfg();
    const engine = await XRA.audioEngine.ensure({ profile: c.audio_profile || 'podcast' });
    if (!c.noise_gate) return engine.stream;

    const { context, source } = engine;
    gateAnalyser = context.createAnalyser();
    gateAnalyser.fftSize = 1024;
    gateAnalyser.smoothingTimeConstant = 0.15;
    gateGain = context.createGain();
    gateDestination = context.createMediaStreamDestination();
    gateSamples = new Float32Array(gateAnalyser.fftSize);
    source.connect(gateAnalyser);
    source.connect(gateGain);
    gateGain.connect(gateDestination);

    let lastAbove = performance.now();
    gateOpen = true;
    gateTimer = setInterval(() => {
      if (!XRA.audioEngine.context || XRA.audioEngine.context.state === 'closed') return;
      gateAnalyser.getFloatTimeDomainData(gateSamples);
      let sum = 0;
      for (let i = 0; i < gateSamples.length; i++) sum += gateSamples[i] * gateSamples[i];
      const rms = Math.sqrt(sum / gateSamples.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-7));
      gateCurrentDb = db;
      const now = performance.now();
      const thresholdDb = Number(cfg().gate_threshold_db ?? -48);
      const holdMs = Math.max(0, Number(cfg().gate_hold_ms ?? 160));
      const releaseMs = Math.max(20, Number(cfg().gate_release_ms ?? 120));
      // Small hysteresis prevents the gate from chattering or chopping quiet
      // word endings around the exact threshold. Opening still requires the
      // configured threshold; once open, it is allowed to stay open down to
      // 4 dB below it until the normal hold/release timing expires.
      const keepOpenDb = thresholdDb - 4;
      const aboveOpen = db >= thresholdDb;
      const aboveHold = gateOpen && db >= keepOpenDb;
      if (aboveOpen || aboveHold) {
        lastAbove = now;
        if (!gateOpen && aboveOpen) {
          gateOpen = true;
          gateGain.gain.cancelScheduledValues(context.currentTime);
          gateGain.gain.setTargetAtTime(1, context.currentTime, 0.008);
        }
      } else if (gateOpen && now - lastAbove >= holdMs) {
        gateOpen = false;
        gateGain.gain.cancelScheduledValues(context.currentTime);
        gateGain.gain.setTargetAtTime(0.0001, context.currentTime, Math.max(0.015, releaseMs / 3000));
      }
      events.emit('recording-gate', { db, open: gateOpen, thresholdDb });
    }, 25);
    return gateDestination.stream;
  }

  function expandedFilename(extra = '') {
    const c = cfg();
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    let base = String(c.filename || 'XR_Animator_{date}_{time}').replaceAll('{date}', date).replaceAll('{time}', time);
    if (segmentIndex) base += `_part${String(segmentIndex + 1).padStart(2, '0')}`;
    if (extra) base += extra;
    return base;
  }

  function newSessionState(kind = 'main') {
    return { kind, id: null, path: '', writingPath: '', bytes: 0, chain: Promise.resolve(), error: null, pending: new Set() };
  }

  async function beginServerSession(state, { mimeType, mode, outputFormat, filename, audioBps = null, temporary = false, forceSourceTemp = false }) {
    const c = cfg();
    const response = await fetch('/__xra_recording/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename, mime_type: mimeType || (mode === 'audio' ? 'audio/webm' : 'video/webm'), source_format: 'webm',
        mode, output_format: outputFormat, output_dir: c.output_dir || '',
        video_bps: Number(c.video_bps || 0), audio_bps: Number(audioBps ?? c.audio_bps ?? 0),
        hardware_encode: c.hardware_encode || 'auto', temporary: !!temporary, force_source_temp: !!forceSourceTemp
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Recorder server start failed');
    state.id = data.session;
    state.path = data.path || '';
    state.writingPath = data.writing_path || '';
    return data;
  }

  async function uploadChunk(state, blob) {
    if (!state?.id || !blob?.size) return;
    const response = await fetch(`/__xra_recording/chunk?session=${encodeURIComponent(state.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Recording chunk write failed');
    state.bytes = Number(data.bytes || state.bytes + blob.size);
    if (state.kind === 'main') freeBytes = Number.isFinite(Number(data.free_bytes)) ? Number(data.free_bytes) : freeBytes;
  }

  function queueChunk(state, blob) {
    const task = state.chain.then(() => uploadChunk(state, blob)).catch(error => {
      state.error = error;
      console.error(TAG, `${state.kind} chunk upload failed`, error);
      events.emit('recording-error', error);
      XRA.toast('Recording write error: ' + error.message, 'error', 5000);
      throw error;
    });
    state.chain = task.catch(() => {});
    state.pending.add(task);
    task.finally(() => state.pending.delete(task));
    return task;
  }

  async function flushSession(state) {
    if (!state) return;
    await state.chain;
    if (state.pending.size) await Promise.allSettled([...state.pending]);
    if (state.error) throw state.error;
  }

  async function finishServerSession(state) {
    if (!state?.id) return null;
    const sid = state.id;
    const response = await fetch('/__xra_recording/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sid })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const suffix = data.source_path ? ` Source kept at: ${data.source_path}` : '';
      throw new Error((data.error || 'Recording finalization failed') + suffix);
    }
    state.id = null;
    state.path = data.path || state.path;
    state.bytes = Number(data.bytes || state.bytes);
    events.emit('recording-file', { ...data, kind: state.kind });
    return data;
  }

  function buildOutputStream(videoStream, audio) {
    const out = new MediaStream();
    videoStream?.getVideoTracks?.().forEach(track => out.addTrack(track));
    audio?.getAudioTracks?.().forEach(track => out.addTrack(track));
    return out;
  }

  async function buildMainRecorder({ reuseStream = false } = {}) {
    const c = cfg();
    const mode = c.mode || 'video_audio';
    const wantVideo = mode !== 'audio';
    const wantAudio = mode !== 'video';
    if (!reuseStream) {
      const videoStream = wantVideo ? await createSelectedVideoStream() : null;
      const audio = wantAudio ? await createAudioStream() : null;
      outputStream = buildOutputStream(videoStream, audio);
    }
    if (!outputStream?.getTracks?.().length) throw new Error('No recording tracks available');

    const requestedFormat = String(c.output_format || 'webm').toLowerCase();
    // Never refuse to START because a capability probe cannot see FFmpeg.
    // We always capture a valid WebM source first. The server resolves FFmpeg
    // again when finalizing MP4/MKV; if conversion really is unavailable, the
    // source recording is preserved instead of losing the session.

    const mimeType = chooseSourceMime(mode);
    const options = { mimeType };
    if (wantVideo) options.videoBitsPerSecond = Number(c.video_bps || 3000000);
    if (wantAudio) options.audioBitsPerSecond = Number(c.audio_bps || 128000);
    recorder = new MediaRecorder(outputStream, options);
    const actualMime = recorder.mimeType || mimeType || (mode === 'audio' ? 'audio/webm' : 'video/webm');

    mainSession = newSessionState('main');
    await beginServerSession(mainSession, {
      mimeType: actualMime, mode, outputFormat: requestedFormat, filename: expandedFilename()
    });
    currentPath = mainSession.path;
    recorder.ondataavailable = event => event.data?.size && queueChunk(mainSession, event.data);
    recorder.onerror = event => {
      const error = event.error || new Error('MediaRecorder error');
      events.emit('recording-error', error);
      XRA.toast('Recorder: ' + error.message, 'error', 5000);
    };
  }

  async function startRawBackup() {
    const c = cfg();
    if (!c.raw_audio_backup || c.mode === 'video') return;
    const rawFormat = String(c.raw_audio_format || 'flac').toLowerCase();
    // Same policy as the main recorder: capture first, finalize server-side.
    // A failed conversion keeps the source audio instead of blocking REC.
    const engine = await XRA.audioEngine.ensure({ profile: c.audio_profile || 'podcast' });
    const rawStream = new MediaStream(engine.stream.getAudioTracks());
    const mimeType = chooseSourceMime('audio');
    rawRecorder = new MediaRecorder(rawStream, { mimeType, audioBitsPerSecond: Number(c.audio_bps || 128000) });
    rawSession = newSessionState('raw');
    await beginServerSession(rawSession, {
      mimeType: rawRecorder.mimeType || mimeType || 'audio/webm', mode: 'audio',
      outputFormat: rawFormat, filename: expandedFilename('_mic_raw'), audioBps: Number(c.audio_bps || 128000)
    });
    rawPath = rawSession.path;
    rawRecorder.ondataavailable = event => event.data?.size && queueChunk(rawSession, event.data);
    rawRecorder.onerror = event => events.emit('recording-error', event.error || event);
    rawRecorder.start(5000);
  }

  async function stopMediaRecorder(instance) {
    if (!instance || instance.state === 'inactive') return;
    await new Promise((resolve, reject) => {
      instance.addEventListener('stop', resolve, { once: true });
      instance.addEventListener('error', e => reject(e.error || new Error('MediaRecorder stop failed')), { once: true });
      try { instance.stop(); } catch (e) { reject(e); }
    });
  }

  async function rotateSegment() {
    if (!recorder || recorder.state !== 'recording' || rotating || stopRequested) return false;
    rotating = true;
    rotationPromise = (async () => {
      const oldSession = mainSession;
      await stopMediaRecorder(recorder);
      await flushSession(oldSession);
      const closed = await finishServerSession(oldSession);
      completedBytes += Number(closed?.bytes || oldSession?.bytes || 0);
      if (stopRequested) return false;
      segmentIndex++;
      await buildMainRecorder({ reuseStream: true });
      recorder.start(5000);
      scheduleSegmentRotation();
      return true;
    })();
    try { return await rotationPromise; }
    finally { rotating = false; rotationPromise = null; }
  }

  function scheduleSegmentRotation() {
    if (segmentTimer) clearTimeout(segmentTimer);
    const minutes = Number(cfg().segment_minutes || 0);
    if (minutes > 0) {
      segmentTimer = setTimeout(() => rotateSegment().catch(async e => {
        console.error(TAG, 'segment rotation failed', e);
        XRA.toast('Recording segment error: ' + e.message, 'error', 5000);
        try { await stop(); } catch (stopError) {}
      }), minutes * 60 * 1000);
    }
  }

  async function requestWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request?.('screen'); }
    catch (e) { console.warn(TAG, 'wake lock unavailable', e); }
  }

  async function releaseWakeLock() {
    try { await wakeLock?.release?.(); } catch (e) {}
    wakeLock = null;
  }

  function ensureHud() {
    if (hud?.root?.isConnected) return hud;
    const root = document.createElement('div');
    root.className = 'xra-recording-hud';
    root.hidden = true;
    const head = document.createElement('div'); head.className = 'xra-recording-hud-head';
    const badge = document.createElement('div'); badge.className = 'xra-recording-hud-badge'; badge.textContent = '● REC';
    const time = document.createElement('div'); time.className = 'xra-recording-hud-time'; time.textContent = '00:00:00';
    head.append(badge, time);
    const info = document.createElement('div'); info.className = 'xra-recording-hud-info';
    const stopButton = document.createElement('button'); stopButton.type = 'button'; stopButton.className = 'xra-recording-hud-stop'; stopButton.textContent = '■ ' + (XRA.i18n?.t?.('STOP RECORDING') || 'STOP RECORDING');
    stopButton.onclick = async () => {
      stopButton.disabled = true;
      try { await stop(); }
      catch (e) { XRA.toast('Recorder stop: ' + e.message, 'error', 7000); }
      finally { stopButton.disabled = false; }
    };
    root.append(head, info, stopButton);
    document.body.appendChild(root);
    hud = { root, badge, time, info, stopButton };
    return hud;
  }

  function updateHud(state = status()) {
    const h = ensureHud();
    const visible = !!state.active || !!state.finalizing;
    h.root.hidden = !visible;
    if (!visible) return;
    h.badge.textContent = state.finalizing ? (XRA.i18n?.t?.('FINALIZING') || 'FINALIZING') : '● REC';
    h.root.classList.toggle('finalizing', !!state.finalizing);
    h.time.textContent = humanTime(state.elapsed_ms);
    const c = cfg();
    const nativeXr = state.capture_strategy === 'native_xr';
    const videoLine = c.mode === 'audio'
      ? 'Audio only'
      : `${c.width}×${c.height} @ ${c.fps} FPS · ${(Number(c.video_bps || 0) / 1e6).toFixed(1)} Mbps`;
    const audioLine = c.mode === 'video'
      ? 'No audio'
      : `Audio ${(Number(c.audio_bps || 0) / 1000).toFixed(0)} kbps · ${c.audio_profile === 'call' ? 'Call' : 'Podcast'}${c.noise_gate ? ` · Gate ${Number(c.gate_threshold_db ?? -48)} dB (${state.gate_open ? 'OPEN' : 'CLOSED'})` : ''}`;
    const free = state.free_bytes == null ? '' : ` · disk ${humanBytes(state.free_bytes)} free`;
    const raw = state.raw_path ? `\nRAW mic: ${state.raw_path}` : '';
    const sourceName = nativeXr ? 'XR native output' : (state.capture_strategy === 'classic_v74' ? 'Classic output' : 'Clean scene');
    const sourceLine = c.mode === 'audio' ? '' : `\nSource: ${sourceName} · ${state.source_render_width || sourceRenderWidth || '—'}×${state.source_render_height || sourceRenderHeight || '—'}${state.source_upscaled ? ' · ⚠ source below target' : ''}`;
    const formatHead = `${String(c.output_format || 'webm').toUpperCase()} · ${c.preset || 'CUSTOM'}`;
    const progressLine = nativeXr && state.active
      ? `Native high-quality capture · final size on STOP${free} · 30 min ≈ ${humanBytes(estimateBytes(30))}`
      : `Written ${humanBytes(state.bytes)}${free} · 30 min ≈ ${humanBytes(estimateBytes(30))}`;
    const targetPath = state.path || (nativeXr && state.active
      ? `Target: ${(String(c.output_dir || '').trim() || '[XR Animator]/recordings')} / ${expandedFilename()}.${String(c.output_format || 'webm').toLowerCase()}`
      : 'Preparing file…');
    h.info.textContent = `${formatHead} · ${videoLine}\n${audioLine}${sourceLine}\n${progressLine}\n${targetPath}${raw}`;
    h.stopButton.disabled = !!state.finalizing || !state.active;
  }

  function startStatusTimer() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      const s = status();
      events.emit('recording-progress', s);
      updateHud(s);
    }, 500);
  }

  async function start() {
    if ((recorder && recorder.state !== 'inactive') || nativeModeActive) return false;
    stopRequested = false; rotating = false; finalizing = false; segmentIndex = 0; completedBytes = 0; freeBytes = null;
    currentPath = ''; rawPath = ''; startTime = Date.now(); drawFrames = 0;
    await stopGateMonitor();
    await requestWakeLock();

    beginChromaSafe();
    try {
      if (useNativeXrCapture()) {
        if (Number(cfg().segment_minutes || 0) > 0) console.warn(TAG, 'segment rotation is disabled for XR native output');
        await startNativeXrRecorder();
      } else {
        if (!window.MediaRecorder) throw new Error('MediaRecorder is not supported by this browser');
        await buildMainRecorder();
        recorder.start(5000);
        scheduleSegmentRotation();
      }
      await startRawBackup();
      startStatusTimer();
      const s = status();
      events.emit('recording-start', s);
      updateHud(s);
      return true;
    } catch (error) {
      try { if (nativeModeActive) nativeVideoCapture().stop(); } catch (e) {}
      try { await stopMediaRecorder(recorder); } catch (e) {}
      try { await stopMediaRecorder(nativeAudioRecorder); } catch (e) {}
      try { await flushSession(mainSession); } catch (e) {}
      try { await flushSession(nativeAudioSession); } catch (e) {}
      try { if (mainSession?.id && !useNativeXrCapture()) await finishServerSession(mainSession); } catch (e) {}
      await cleanup();
      throw error;
    }
  }

  async function stop() {
    if (!recorder && !mainSession?.id && !rotating && !rawRecorder && !nativeModeActive && !nativeAudioRecorder) return false;
    stopRequested = true;
    finalizing = true;
    updateHud(status());
    if (segmentTimer) clearTimeout(segmentTimer);
    segmentTimer = null;
    let failure = null;
    let final = null;
    let rawFinal = null;

    if (rotationPromise) {
      try { await rotationPromise; } catch (e) { failure ||= e; }
    }

    if (nativeModeActive) {
      try { final = await stopNativeXrRecorder(); } catch (e) { failure ||= e; }
    } else {
      try { await stopMediaRecorder(recorder); } catch (e) { failure ||= e; }
      try { await flushSession(mainSession); } catch (e) { failure ||= e; }
      try { final = await finishServerSession(mainSession); } catch (e) { failure ||= e; }
    }

    try { await stopMediaRecorder(rawRecorder); } catch (e) { failure ||= e; }
    try { await flushSession(rawSession); } catch (e) { failure ||= e; }
    try { rawFinal = await finishServerSession(rawSession); } catch (e) { failure ||= e; }

    if (final?.bytes) completedBytes += Number(final.bytes);
    if (final?.path) currentPath = final.path;
    if (rawFinal?.path) rawPath = rawFinal.path;
    await cleanup();
    finalizing = false;
    const state = status();
    events.emit('recording-stop', { ...state, final, raw: rawFinal, error: failure || null });
    updateHud(state);
    if (failure) throw failure;
    return final || true;
  }

  async function cleanup() {
    if (statusTimer) clearInterval(statusTimer);
    if (segmentTimer) clearTimeout(segmentTimer);
    if (gateTimer) clearInterval(gateTimer);
    if (drawRAF) cancelAnimationFrame(drawRAF);
    statusTimer = segmentTimer = gateTimer = drawRAF = 0;
    try { outputStream?.getVideoTracks?.().forEach(track => track.stop()); } catch (e) {}
    // Stop only the processed gate-destination track; shared mic tracks belong
    // to XRA.audioEngine and stay alive for lip sync / meter reuse.
    try { gateDestination?.stream?.getAudioTracks?.().forEach(track => track.stop()); } catch (e) {}
    try { XRA.audioEngine.source?.disconnect?.(gateAnalyser); } catch (e) {}
    try { XRA.audioEngine.source?.disconnect?.(gateGain); } catch (e) {}
    try { gateGain?.disconnect?.(); gateAnalyser?.disconnect?.(); gateDestination?.disconnect?.(); } catch (e) {}
    outputStream = null; recorder = null; rawRecorder = null; nativeAudioRecorder = null;
    nativeModeActive = false;
    restoreNativeDownloadIntercept();
    nativeBlobPromise = nativeBlobResolve = nativeBlobReject = nativeBlobResult = null; nativeCapturedHref = '';
    mainSession = null; rawSession = null; nativeAudioSession = null;
    recordingCtx = null; recordingCanvas = null; sourceCanvas = null;
    gateAnalyser = gateGain = gateDestination = gateSamples = null;
    backgroundImage = null; backgroundImageSrc = '';
    restoreChromaSafe();
    restoreNativeRenderResolution();
    sourceRenderWidth = sourceRenderHeight = 0; sourceWasUpscaled = false;
    await releaseWakeLock();
  }

  async function chooseFolder(initial = cfg().output_dir || '') {
    const response = await fetch('/__xra_recording/choose-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initial })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Folder picker failed');
    if (data.path) {
      cfg().output_dir = data.path;
      await XRA.profileService.save();
      events.emit('recorder-config', cfg());
    }
    return data.path || '';
  }

  async function capabilities() {
    const response = await fetch('/__xra_recording/capabilities', { cache: 'no-store' });
    if (!response.ok) return { ffmpeg: false, default_dir: '', h264: [], recommended: 'libx264' };
    return response.json();
  }

  async function listRecoveries() {
    const response = await fetch('/__xra_recording/recoveries', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.ok && Array.isArray(data.items) ? data.items : [];
  }

  async function recover(session) {
    const response = await fetch('/__xra_recording/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Recovery failed');
    events.emit('recording-recovered', data);
    return data;
  }

  async function stopGateMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = 0;
    try { XRA.audioEngine.source?.disconnect?.(monitorAnalyser); } catch (e) {}
    try { monitorAnalyser?.disconnect?.(); } catch (e) {}
    monitorAnalyser = null; monitorSamples = null;
    events.emit('recording-gate-monitor-stop');
  }

  async function startGateMonitor() {
    if ((recorder && recorder.state === 'recording') || nativeModeActive) return true;
    await stopGateMonitor();
    const engine = await XRA.audioEngine.ensure({ profile: cfg().audio_profile || 'podcast' });
    monitorAnalyser = engine.context.createAnalyser();
    monitorAnalyser.fftSize = 1024;
    monitorAnalyser.smoothingTimeConstant = 0.20;
    monitorSamples = new Float32Array(monitorAnalyser.fftSize);
    engine.source.connect(monitorAnalyser);
    monitorTimer = setInterval(() => {
      if (!monitorAnalyser) return;
      monitorAnalyser.getFloatTimeDomainData(monitorSamples);
      let sum = 0;
      for (let i = 0; i < monitorSamples.length; i++) sum += monitorSamples[i] * monitorSamples[i];
      const db = 20 * Math.log10(Math.max(Math.sqrt(sum / monitorSamples.length), 1e-7));
      gateCurrentDb = db;
      const thresholdDb = Number(cfg().gate_threshold_db ?? -48);
      events.emit('recording-gate-monitor', { db, thresholdDb, open: db >= thresholdDb });
    }, 50);
    return true;
  }

  async function calibrateNoiseGate(seconds = 3) {
    const engine = await XRA.audioEngine.ensure({ profile: cfg().audio_profile || 'podcast' });
    const analyser = engine.context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.1;
    const samples = new Float32Array(analyser.fftSize);
    engine.source.connect(analyser);
    const values = [];
    const end = performance.now() + Math.max(1, Number(seconds || 3)) * 1000;
    try {
      while (performance.now() < end) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        values.push(20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-7)));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally {
      try { engine.source.disconnect(analyser); } catch (e) {}
      try { analyser.disconnect(); } catch (e) {}
    }
    if (!values.length) throw new Error('No microphone samples');
    values.sort((a, b) => a - b);
    // A high percentile + 8 dB made brief room-noise spikes dominate the
    // calibration and often slammed the old slider against -25 dB. Use the
    // median as the stable room floor and a gentler 5 dB margin instead.
    const noiseFloor = values[Math.min(values.length - 1, Math.floor(values.length * 0.50))];
    const threshold = Math.max(-55, Math.min(-5, Math.round((noiseFloor + 5) * 4) / 4));
    cfg().gate_noise_floor_db = Number(noiseFloor.toFixed(1));
    cfg().gate_threshold_db = threshold;
    await XRA.profileService.save();
    const result = { noise_floor_db: noiseFloor, threshold_db: threshold };
    events.emit('recording-gate-calibrated', result);
    events.emit('recorder-config', cfg());
    return result;
  }

  function applyPreset(name) {
    name = String(name || '').toUpperCase();
    const preset = PRESETS[name];
    if (!preset) return false;
    Object.assign(cfg(), preset, { preset: name });
    events.emit('recorder-config', cfg());
    XRA.profileService.save();
    return true;
  }

  function estimateBytes(minutes = 60) {
    const c = cfg();
    const video = c.mode === 'audio' ? 0 : Number(c.video_bps || 0);
    const audio = c.mode === 'video' ? 0 : Number(c.audio_bps || 0);
    return (video + audio) * Math.max(0, Number(minutes || 0)) * 60 / 8;
  }

  function estimateBytesPerHour() { return estimateBytes(60); }

  function status() {
    const active = !stopRequested && (((!!recorder && recorder.state === 'recording') || rotating) || nativeModeActive);
    const elapsed = startTime ? Math.max(0, Date.now() - startTime) : 0;
    const mainBytes = Number(mainSession?.bytes || 0);
    const expectedFrames = cfg().mode === 'audio' ? 0 : Math.floor(elapsed / 1000 * Number(cfg().fps || 30));
    const droppedEstimate = captureStrategy === 'composite' && expectedFrames ? Math.max(0, expectedFrames - drawFrames) : 0;
    return {
      active, finalizing, state: nativeModeActive ? 'native-recording' : (recorder?.state || 'inactive'), elapsed_ms: elapsed,
      bytes: completedBytes + mainBytes, path: currentPath || mainSession?.path || '', raw_path: rawPath || rawSession?.path || '',
      segment: segmentIndex + 1, preset: cfg().preset || 'PODCAST', output_format: cfg().output_format || 'webm',
      free_bytes: freeBytes, gate_db: gateCurrentDb, gate_open: gateOpen, capture_strategy: captureStrategy,
      draw_frames: drawFrames, dropped_frames_estimate: droppedEstimate,
      source_render_width: sourceRenderWidth, source_render_height: sourceRenderHeight, source_upscaled: sourceWasUpscaled,
      draw_fps: drawStartedAt && drawFrames ? drawFrames / Math.max(0.001, (performance.now() - drawStartedAt) / 1000) : 0
    };
  }

  events.on('recording-progress', updateHud);
  events.on('recording-start', updateHud);
  events.on('recording-stop', updateHud);

  XRA.recorder = {
    PRESETS, start, stop, status, applyPreset, estimateBytes, estimateBytesPerHour,
    resolveSceneCanvas, chooseFolder, capabilities, startGateMonitor, stopGateMonitor,
    calibrateNoiseGate, listRecoveries, recover, humanBytes, humanTime
  };
})();
