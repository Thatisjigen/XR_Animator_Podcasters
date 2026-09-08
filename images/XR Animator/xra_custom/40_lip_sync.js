// XR Animator - microphone lip sync
// Injects vowels immediately before expressionManager.update()
// ============================================================

(() => {

  const lip = {
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0
  };

  const config = {
    threshold: 0.018,
    gain: 8.0,

    attack: 0.45,
    release: 0.78,

    enabled: true
  };


  let audioContext = null;
  let analyser = null;
  let stream = null;
  let sourceNode = null;

  let timeData = null;
  let freqData = null;

  let running = false;
  let envelope = 0;

  let patchedManager = null;
  let lastAudioAnalysis = 0;

  // ==========================================================
  // Expression manager patch
  // ==========================================================

  function getExpressionManager() {

    return (
      window.MMD_SA &&
      MMD_SA.THREEX &&
      MMD_SA.THREEX.models &&
      MMD_SA.THREEX.models[0] &&
      MMD_SA.THREEX.models[0].model &&
      MMD_SA.THREEX.models[0].model.expressionManager
    ) || null;

  }


  function patchExpressionManager() {

    const em = getExpressionManager();

    if (!em)
      return false;


    if (em === patchedManager)
      return true;


    if (em.__XR_MIC_LIP_PATCHED__) {

      patchedManager = em;
      return true;

    }


    const originalUpdate = em.update.bind(em);
    const originalSetValue = em.setValue.bind(em);


    em.update = function (...args) {
      if (config.enabled) {
        const names = ["aa", "ih", "ou", "ee", "oh"];
        const vowelEmphasis = Math.max(0.25, Math.min(2.5,
          window.XRA_OPT?.config?.lip?.vowel_emphasis ?? 1
        ));
        const micActivity = Math.min(1, Math.max(
          lip.aa,
          lip.ih,
          lip.ou,
          lip.ee,
          lip.oh
        ) * vowelEmphasis);
        const maxMicBlend = window.XRA_OPT?.config?.lip?.mic_mix ?? 0.60;
        const micBlend = micActivity * maxMicBlend;

        for (const name of names) {
          const cameraValue = em.getValue(name) || 0;
          const micValue = Math.min(1, (lip[name] || 0) * vowelEmphasis);
          const finalValue = cameraValue * (1 - micBlend) + micValue * micBlend;
          originalSetValue(name, Math.max(0, Math.min(1, finalValue)));
        }
      }

      return originalUpdate(...args);
    };

    em.__XR_MIC_LIP_PATCHED__ = true;

    patchedManager = em;
    return true;

  }


  // Model may be loaded/reloaded later. A low-frequency identity check is enough;
  // the old 500 ms permanent poll was unnecessary work.
  let expressionWatchTimer = null;
  function startExpressionWatch() {
    patchExpressionManager();
    if (expressionWatchTimer) return;
    expressionWatchTimer = setInterval(() => {
      const em = getExpressionManager();
      if (em && em !== patchedManager) patchExpressionManager();
    }, 2500);
  }
  startExpressionWatch();
  window.addEventListener("MMDStarted", () => setTimeout(startExpressionWatch, 500));


  // ==========================================================
  // Audio
  // ==========================================================

  function calculateRMS() {

    analyser.getByteTimeDomainData(timeData);

    let sum = 0;


    for (let i = 0; i < timeData.length; i++) {

      const x =
        (timeData[i] - 128) / 128;

      sum += x * x;

    }


    return Math.sqrt(
      sum / timeData.length
    );

  }


  function spectralCentroid() {

    analyser.getByteFrequencyData(freqData);


    const binHz =
      audioContext.sampleRate /
      analyser.fftSize;


    let weighted = 0;
    let total = 0;


    for (let i = 0; i < freqData.length; i++) {

      const hz = i * binHz;


      // ignore rumble + useless very high frequencies
      if (hz < 80 || hz > 4000)
        continue;


      const a =
        freqData[i] / 255;


      total += a;
      weighted += hz * a;

    }


    if (total <= 0)
      return 0;


    return weighted / total;

  }


  function decayLip() {

    lip.aa *= config.release;
    lip.ih *= config.release;
    lip.ou *= config.release;
    lip.ee *= config.release;
    lip.oh *= config.release;

  }


  function setVowel(name, amount) {

    for (const key of [
      "aa",
      "ih",
      "ou",
      "ee",
      "oh"
    ]) {

      const target =
        key === name
          ? amount
          : 0;


      const smoothing =
        target > lip[key]
          ? config.attack
          : config.release;


      lip[key] =
        lip[key] * smoothing +
        target * (1 - smoothing);

    }

  }


  function analyseAudio(now = performance.now()) {

    if (!running)
      return;


    const lipPerf =
      window.XRA_OPT
        ?.config
        ?.lip;


    const targetFPS =
      lipPerf?.optimized
        ? (lipPerf.analysis_fps || 30)
        : 60;


    const interval =
      1000 / targetFPS;


    if (
      now - lastAudioAnalysis <
      interval
    ) {

      requestAnimationFrame(
        analyseAudio
      );

      return;

    }


    lastAudioAnalysis = now;


    if (!running)
      return;


    const rms =
      calculateRMS();


    if (rms > envelope) {

      envelope =
        envelope * 0.45 +
        rms * 0.55;

    }

    else {

      envelope =
        envelope * 0.82 +
        rms * 0.18;

    }


    const threshold =
      window.XRA_OPT
        ?.config
        ?.lip
        ?.threshold ?? config.threshold;


    if (envelope < threshold) {

      decayLip();

      requestAnimationFrame(
        analyseAudio
      );

      return;

    }


    const strength =
      Math.min(
        1,
        Math.max(
          0,
          (envelope - threshold) *
          config.gain * Math.max(0.5, Math.min(2.5,
            window.XRA_OPT?.config?.lip?.response_gain ?? 1
          ))
        )
      );


    const centroid =
      spectralCentroid();


    let vowel;


    if (centroid < 650) {

      vowel = "ou";

    }

    else if (centroid < 1050) {

      vowel = "oh";

    }

    else if (centroid < 1650) {

      vowel = "aa";

    }

    else if (centroid < 2400) {

      vowel = "ee";

    }

    else {

      vowel = "ih";

    }


    setVowel(
      vowel,
      strength
    );


    requestAnimationFrame(
      analyseAudio
    );

  }


  // ==========================================================
  // Start
  // ==========================================================

  async function start() {

    if (running) {

      if (
        audioContext &&
        audioContext.state === "suspended"
      ) {
        await audioContext.resume();
      }

      return;
    }


    // Lip-sync deliberately keeps the old/expressive microphone path.
    // Recorder audio remains on XRA.audioEngine, so Podcast/Natural settings do
    // not make the mouth less reactive. This matches the behaviour of the
    // known-good pre-shared-audio lip sync: browser AGC + denoise are used only
    // for ANALYSIS, never written into the raw/podcast recording track.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(window.XRA_OPT?.config?.devices?.mic_device_id
          ? { deviceId: { ideal: window.XRA_OPT.config.devices.mic_device_id } }
          : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();


    const lipPerf =
      window.XRA_OPT
        ?.config
        ?.lip;


    analyser.fftSize =
      lipPerf?.optimized
        ? (lipPerf.fft_size || 512)
        : 2048;
    analyser.smoothingTimeConstant = 0.35;


    timeData =
      new Uint8Array(
        analyser.fftSize
      );


    freqData =
      new Uint8Array(
        analyser.frequencyBinCount
      );


    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyser);


    running = true;
    analyseAudio();

  }


  function stop() {

    running = false;


    lip.aa = 0;
    lip.ih = 0;
    lip.ou = 0;
    lip.ee = 0;
    lip.oh = 0;


    try { sourceNode?.disconnect?.(analyser); } catch (e) {}
    try { analyser?.disconnect?.(); } catch (e) {}
    try { stream?.getTracks?.().forEach(track => track.stop()); } catch (e) {}
    try { audioContext?.close?.(); } catch (e) {}

    stream = null;
    audioContext = null;
    sourceNode = null;
    analyser = null;

  }


  // Public lip-sync API.

  window.XR_LIP = {

    lip,
    config,

    start,
    stop,

    status() {

      return {
        running,
        envelope,
        lip: { ...lip },
        patched:
          !!patchedManager
      };

    }

  };


  // F8 = start/resume microphone
  window.addEventListener(
    "keydown",
    e => {

      if (e.key === "F8") {

        e.preventDefault();

        start().catch(
          console.error
        );

      }

    }
  );


  // AudioContext might require a gesture.
  // Try automatically first.
  setTimeout(
    () => {

      patchExpressionManager();

      start().catch(err => {

        console.warn(
          "[XR LIP] press F8 to start microphone",
          err
        );

      });

    },
    3000
  );

})();

// Clean namespace alias for the V7 modules/UI.
if (window.XRA && window.XR_LIP) {
  window.XRA.lip = window.XR_LIP;
}
