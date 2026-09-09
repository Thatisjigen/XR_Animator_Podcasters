(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA RIGHT]';
  const { config, defaults, events, util } = XRA;
  const UI = XRA.uiCore;
  const { el, button, select, row, details, bindRefresh, refreshAll, stopInputPropagation } = UI;

  let panel = null;
  let body = null;
  let micSelect = null;
  let bgSelect = null;
  let meterRAF = 0;
  let lipDetails = null;
  let backgroundsLoaded = false;
  let healthTimer = 0;
  let studioWindow = null;

  function markCustomPreset() {
    if (config.performance?.master_preset && config.performance.master_preset !== 'CUSTOM') {
      config.performance.master_preset = 'CUSTOM';
      events.emit('preset', { name: 'CUSTOM', reason: 'manual-change' });
    }
  }

  function nativeCamera() { return window.System?._browser?.camera || null; }
  function nativeCollider() { return XRA.tracking?.bodyCollider?.() || null; }

  async function restartLip() {
    try {
      window.XR_LIP?.stop?.();
      await util.sleep(120);
      await window.XR_LIP?.start?.();
    }
    catch (e) {
      console.warn(TAG, 'lip restart failed', e);
      XRA.toast('Microfono: riavvio fallito', 'error');
    }
  }

  async function refreshMicrophones() {
    if (!micSelect || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const current = config.devices?.mic_device_id || '';
      micSelect.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Default microphone';
      micSelect.appendChild(def);
      devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
        const option = document.createElement('option');
        option.value = d.deviceId;
        option.textContent = d.label || `Microphone ${i + 1}`;
        micSelect.appendChild(option);
      });
      micSelect.value = [...micSelect.options].some(o => o.value === current) ? current : '';
    }
    catch (e) {
      console.warn(TAG, 'enumerate microphones failed', e);
    }
  }

  async function refreshBackgrounds(force = false) {
    if (!bgSelect) return;
    try {
      const files = await XRA.background.list(force);
      const current = config.background.path || '';
      bgSelect.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '-- choose background --';
      bgSelect.appendChild(empty);
      if (current && !files.includes(current)) {
        const option = document.createElement('option');
        option.value = current;
        option.textContent = '[current] ' + current;
        bgSelect.appendChild(option);
      }
      for (const path of files) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path.replace(/^backgrounds\//, '');
        bgSelect.appendChild(option);
      }
      bgSelect.value = [...bgSelect.options].some(o => o.value === current) ? current : '';
      backgroundsLoaded = true;
    }
    catch (e) {
      console.warn(TAG, 'background list failed', e);
    }
  }

  function updateMeterLoop() {
    if (meterRAF) {
      cancelAnimationFrame(meterRAF);
      meterRAF = 0;
    }
    const active = !!config.lip?.meter_visible && !UI.hidden && !!lipDetails?.open;
    if (!active) return;

    const fill = panel?.querySelector('[data-xra="meter-fill"]');
    const gate = panel?.querySelector('[data-xra="meter-gate"]');
    if (!fill || !gate) return;

    let last = 0;
    const draw = t => {
      if (!(config.lip?.meter_visible && !UI.hidden && lipDetails?.open)) return;
      if (t - last >= 66) {
        last = t;
        const envelope = Number(window.XR_LIP?.status?.().envelope || 0);
        const max = 0.08;
        fill.style.width = Math.min(100, envelope / max * 100) + '%';
        gate.style.left = Math.min(100, Number(config.lip.threshold || .018) / max * 100) + '%';
      }
      meterRAF = requestAnimationFrame(draw);
    };
    meterRAF = requestAnimationFrame(draw);
  }

  function installHealth(parent) {
    const strip = el('div', 'xra-health-strip');
    const names = ['CAM','FACE','HANDS','MIC'];
    const nodes = Object.fromEntries(names.map(name => {
      const node = el('div', 'xra-health-item');
      node.dataset.state = 'off';
      node.innerHTML = `<span class="xra-health-dot"></span><span>${name}</span>`;
      strip.appendChild(node);
      return [name, node];
    }));
    parent.appendChild(strip);

    const setState = (name, state, title = '') => {
      const node = nodes[name]; if (!node) return;
      node.dataset.state = state;
      node.title = title;
    };
    const update = () => {
      if (UI.hidden || !panel?.isConnected) return;
      const cam = !!XRA.nativeBridge?.cameraRunning?.();
      setState('CAM', cam ? 'ok' : 'off', cam ? 'Webcam attiva' : 'Webcam spenta');

      const face = XRA.tracking?.faceTrackingState?.() || { enabled:false };
      setState('FACE', !face.enabled ? 'off' : ((face.available && !face.present) ? 'warn' : 'ok'),
        !face.enabled ? 'Face tracking disattivato' : ((face.available && !face.present) ? 'Face tracking perso/degradato' : 'Face tracking attivo'));

      setState('HANDS', XRA.tracking?.handsEnabled ? 'ok' : 'off', XRA.tracking?.handsEnabled ? 'Hands attive' : 'Hands disattivate');
      const mic = !!(XRA.audioEngine?.status?.().active || window.XR_LIP?.status?.().running);
      setState('MIC', mic ? 'ok' : 'off', mic ? 'Microfono attivo' : 'Microfono non attivo');
    };
    update();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(update, 1000);
    events.on('camera-started', update); events.on('camera-stopped', update);
    events.on('hands', update); events.on('audio-engine', update); events.on('audio-engine-stop', update);
  }

  function openStudioLink() {
    if (studioWindow && !studioWindow.closed) {
      studioWindow.focus();
      return;
    }

    studioWindow = window.open(
      '/p2p_chat.html',
      'xra-studio-link',
      'popup=yes,width=980,height=760,resizable=yes,scrollbars=yes'
    );
    if (!studioWindow) {
      XRA.toast('Il browser ha bloccato la finestra della chat.', 'error', 4500);
      return;
    }
    studioWindow.focus();
  }

  function installStudioLink(parent) {
    const box = details(parent, '💬 Studio Link');
    const note = el('div', 'xra-note');
    note.textContent = 'Apre chat, voce e condivisione schermo P2P in una finestra separata.';
    const open = button('APRI CHAT', 'xra-action primary');
    open.onclick = openStudioLink;
    box.body.append(note, open);
  }

  function installLip(parent) {
    const box = details(parent, '🎙 Lip sync', { open: true });
    lipDetails = box.details;
    lipDetails.addEventListener('toggle', () => {
      if (lipDetails.open) refreshMicrophones();
      updateMeterLoop();
    });

    micSelect = select([['', 'Default microphone']]);
    bindRefresh(() => {
      const wanted = config.devices?.mic_device_id || '';
      if ([...micSelect.options].some(o => o.value === wanted)) micSelect.value = wanted;
    });
    micSelect.onchange = async () => {
      config.devices ||= {};
      config.devices.mic_device_id = micSelect.value;
      await XRA.profileService.save(0);
      await restartLip();
      await refreshMicrophones();
      refreshAll();
    };
    row(box.body, 'Microphone', micSelect, {
      reset: async () => {
        config.devices.mic_device_id = '';
        await restartLip();
        await refreshMicrophones();
      },
      isDefault: () => !(config.devices?.mic_device_id)
    });

    const mixWrap = el('div', 'xra-stack-control');
    const mix = document.createElement('input');
    mix.type = 'range'; mix.min = '0'; mix.max = '100'; mix.step = '1';
    const mixText = el('div', 'xra-sub');
    mixWrap.append(mix, mixText);
    bindRefresh(() => {
      mix.value = String(Math.round((config.lip.mic_mix ?? .6) * 100));
      mixText.textContent = `Mic ${mix.value}% · Camera ${100 - Number(mix.value)}%`;
    });
    mix.oninput = () => {
      config.lip.mic_mix = Number(mix.value) / 100;
      mixText.textContent = `Mic ${mix.value}% · Camera ${100 - Number(mix.value)}%`;
    };
    mix.onchange = () => XRA.profileService.save();
    row(box.body, 'Mic / camera mix', mixWrap, {
      reset: async () => { config.lip.mic_mix = defaults.lip.mic_mix; },
      isDefault: () => Math.abs((config.lip.mic_mix ?? .6) - defaults.lip.mic_mix) < 1e-9
    });

    const responseWrap = el('div', 'xra-stack-control');
    const response = document.createElement('input');
    response.type = 'range'; response.min = '50'; response.max = '250'; response.step = '5';
    const responseText = el('div', 'xra-sub'); responseWrap.append(response, responseText);
    bindRefresh(() => {
      response.value = String(Math.round((config.lip.response_gain ?? 1) * 100));
      responseText.textContent = `${response.value}%`;
    });
    response.oninput = () => { config.lip.response_gain = Number(response.value) / 100; responseText.textContent = `${response.value}%`; };
    response.onchange = () => XRA.profileService.save();
    row(box.body, 'Mouth response', responseWrap, {
      reset: async () => { config.lip.response_gain = defaults.lip.response_gain; },
      isDefault: () => Math.abs((config.lip.response_gain ?? 1) - defaults.lip.response_gain) < 1e-9,
      sub: 'Quanto il volume sopra la soglia apre la bocca. Aumentalo se parli ma la bocca reagisce poco.'
    });

    const vowelWrap = el('div', 'xra-stack-control');
    const vowel = document.createElement('input');
    vowel.type = 'range'; vowel.min = '50'; vowel.max = '250'; vowel.step = '5';
    const vowelText = el('div', 'xra-sub'); vowelWrap.append(vowel, vowelText);
    bindRefresh(() => {
      vowel.value = String(Math.round((config.lip.vowel_emphasis ?? 1) * 100));
      vowelText.textContent = `${vowel.value}%`;
    });
    vowel.oninput = () => { config.lip.vowel_emphasis = Number(vowel.value) / 100; vowelText.textContent = `${vowel.value}%`; };
    vowel.onchange = () => XRA.profileService.save();
    row(box.body, 'Vowel emphasis', vowelWrap, {
      reset: async () => { config.lip.vowel_emphasis = defaults.lip.vowel_emphasis; },
      isDefault: () => Math.abs((config.lip.vowel_emphasis ?? 1) - defaults.lip.vowel_emphasis) < 1e-9,
      sub: 'Esagera AA / IH / OU / EE / OH senza cambiare la soglia del microfono.'
    });

    const gateWrap = el('div', 'xra-stack-control');
    const gate = document.createElement('input');
    gate.type = 'range'; gate.min = '2'; gate.max = '80'; gate.step = '1';
    const gateText = el('div', 'xra-sub');
    gateWrap.append(gate, gateText);
    bindRefresh(() => {
      gate.value = String(Math.round((config.lip.threshold ?? .018) * 1000));
      gateText.textContent = Number(config.lip.threshold ?? .018).toFixed(3);
    });
    gate.oninput = () => {
      config.lip.threshold = Number(gate.value) / 1000;
      gateText.textContent = config.lip.threshold.toFixed(3);
    };
    gate.onchange = () => XRA.profileService.save();
    row(box.body, 'Voice gate', gateWrap, {
      reset: async () => { config.lip.threshold = defaults.lip.threshold; },
      isDefault: () => Math.abs((config.lip.threshold ?? .018) - defaults.lip.threshold) < 1e-9
    });

    const meterToggle = document.createElement('input');
    meterToggle.type = 'checkbox';
    bindRefresh(() => { meterToggle.checked = !!config.lip.meter_visible; });
    meterToggle.onchange = async () => {
      config.lip.meter_visible = meterToggle.checked;
      await XRA.profileService.save();
      updateMeterLoop();
      refreshAll();
    };
    row(box.body, 'Show VU meter', meterToggle, {
      reset: async () => { config.lip.meter_visible = defaults.lip.meter_visible; updateMeterLoop(); },
      isDefault: () => !!config.lip.meter_visible === !!defaults.lip.meter_visible
    });

    const meter = el('div', 'xra-meter');
    const fill = el('div', 'xra-meter-fill'); fill.dataset.xra = 'meter-fill';
    const gateLine = el('div', 'xra-meter-gate'); gateLine.dataset.xra = 'meter-gate';
    meter.append(fill, gateLine);
    box.body.appendChild(meter);

    const lipAdvanced = details(box.body, 'Advanced');

    const lightLip = document.createElement('input');
    lightLip.type = 'checkbox';
    bindRefresh(() => { lightLip.checked = !!config.lip.optimized; });
    lightLip.onchange = async () => {
      config.lip.optimized = lightLip.checked;
      markCustomPreset();
      await XRA.profileService.save();
      await restartLip();
      refreshAll();
    };
    row(lipAdvanced.body, 'Light lip analysis', lightLip, {
      reset: async () => { config.lip.optimized = defaults.lip.optimized; await restartLip(); },
      isDefault: () => !!config.lip.optimized === !!defaults.lip.optimized
    });

    const fft = select([[512, '512'], [1024, '1024'], [2048, '2048']]);
    bindRefresh(() => { fft.value = String(config.lip.fft_size || 512); });
    fft.onchange = async () => {
      config.lip.fft_size = Number(fft.value);
      markCustomPreset();
      await XRA.profileService.save();
      await restartLip();
      refreshAll();
    };
    row(lipAdvanced.body, 'Lip FFT', fft, {
      reset: async () => { config.lip.fft_size = defaults.lip.fft_size; await restartLip(); },
      isDefault: () => Number(config.lip.fft_size) === defaults.lip.fft_size
    });

    const hz = select([[20, '20 Hz'], [30, '30 Hz'], [60, '60 Hz']]);
    bindRefresh(() => { hz.value = String(config.lip.analysis_fps || 30); });
    hz.onchange = async () => {
      config.lip.analysis_fps = Number(hz.value);
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
    };
    row(lipAdvanced.body, 'Lip analysis', hz, {
      reset: async () => { config.lip.analysis_fps = defaults.lip.analysis_fps; },
      isDefault: () => Number(config.lip.analysis_fps) === defaults.lip.analysis_fps
    });
  }

  function installBody(parent) {
    const box = details(parent, '🧍 Body');

    const stabilization = document.createElement('input');
    stabilization.type = 'checkbox';
    const stabilizationWrap = el('div', 'xra-stack-control');
    const stabilizationStatus = el('div', 'xra-sub');
    stabilizationWrap.append(stabilization, stabilizationStatus);
    bindRefresh(() => {
      stabilization.checked = !!XRA.tracking.bodyStable;
      stabilizationStatus.textContent = stabilization.checked ? 'Body stabilization: ON' : 'Body stabilization: OFF';
    });
    stabilization.onchange = async () => {
      XRA.tracking.setBodyStabilization(stabilization.checked, stabilization.checked);
      refreshAll();
    };
    row(box.body, 'Body stabilization', stabilizationWrap, {
      reset: async () => XRA.tracking.setBodyStabilization(false, false),
      isDefault: () => !XRA.tracking.bodyStable,
      sub: 'OFF keeps body tracking fully live. ON captures the current pose; Anchor strength blends both avatar root translation and body rotation.'
    });

    const hysteresis = document.createElement('input');
    hysteresis.type = 'checkbox';
    const hysteresisWrap = el('div', 'xra-stack-control');
    const hysteresisStatus = el('div', 'xra-sub');
    hysteresisWrap.append(hysteresis, hysteresisStatus);
    bindRefresh(() => {
      hysteresis.checked = !!XRA.tracking.motionHysteresis;
      hysteresisStatus.textContent = XRA.tracking.guardHoldActive
        ? 'Motion hysteresis: HOLDING LAST VALID'
        : (hysteresis.checked ? 'Motion hysteresis: ON' : 'Motion hysteresis: OFF');
    });
    hysteresis.onchange = () => {
      XRA.tracking.setMotionHysteresis(hysteresis.checked, hysteresis.checked);
      refreshAll();
    };
    events.on('upper-body-guard-reject', () => {
      if (XRA.tracking.motionHysteresis) hysteresisStatus.textContent = 'Motion hysteresis: HOLDING LAST VALID';
    });
    events.on('upper-body-guard-reacquired', () => {
      if (XRA.tracking.motionHysteresis) hysteresisStatus.textContent = 'Motion hysteresis: ON';
    });
    row(box.body, 'Motion hysteresis (anti-jerk)', hysteresisWrap, {
      reset: async () => XRA.tracking.setMotionHysteresis(false, false),
      isDefault: () => !config.tracking?.motion_hysteresis_enabled,
      sub: 'Detects rapid pose bursts across a short multi-frame window, holds the last valid pose, then resumes after coherent frames. Independent from body stabilization and tracking-loss protection.'
    });

    const strengthWrap = el('div', 'xra-stack-control');
    const strength = document.createElement('input');
    strength.type = 'range'; strength.min = '0'; strength.max = '100'; strength.step = '1';
    const strengthText = el('div', 'xra-sub');
    strengthWrap.append(strength, strengthText);
    bindRefresh(() => {
      strength.value = String(Math.round((config.body.anchor_strength ?? defaults.body.anchor_strength ?? .80) * 100));
      strengthText.textContent = `${strength.value}%`;
    });
    const anchorIsDefault = () => Math.abs(Number(config.body.anchor_strength ?? .80) - Number(defaults.body.anchor_strength ?? .80)) < 1e-9;
    let anchorReset = null;
    strength.oninput = () => {
      config.body.anchor_strength = Number(strength.value) / 100;
      strengthText.textContent = `${strength.value}%`;
      if (anchorReset) anchorReset.disabled = anchorIsDefault();
    };
    strength.onchange = async () => {
      await XRA.profileService.save();
      if (anchorReset) anchorReset.disabled = anchorIsDefault();
    };
    const anchorRow = row(box.body, 'Anchor strength', strengthWrap, {
      reset: async () => { config.body.anchor_strength = defaults.body.anchor_strength; },
      isDefault: anchorIsDefault,
      sub: '0% keeps body rotation and translation live. 100% locks the captured body pose and root position; intermediate values blend both.'
    });
    anchorReset = anchorRow.querySelector('.xra-reset');

    const freezePose = document.createElement('input');
    freezePose.type = 'checkbox';
    const freezePoseWrap = el('div', 'xra-stack-control');
    const freezePoseStatus = el('div', 'xra-sub', 'Tracking loss protection: ready');
    freezePoseWrap.append(freezePose, freezePoseStatus);
    bindRefresh(() => {
      freezePose.checked = !!(XRA.tracking.bodyStable || config.tracking?.freeze_head_on_face_loss);
      freezePose.disabled = !!XRA.tracking.bodyStable;
      freezePoseStatus.textContent = XRA.tracking?.headFrozenOnLoss
        ? 'Tracking loss protection: FROZEN · lip sync remains live'
        : (XRA.tracking.bodyStable ? 'Tracking loss protection: automatic with stabilization' : 'Tracking loss protection: ready');
    });
    freezePose.onchange = async () => {
      XRA.tracking.setFreezeHeadOnFaceLoss(freezePose.checked);
      refreshAll();
    };
    events.on('head-loss-guard', data => {
      if (!XRA.tracking.bodyStable && !config.tracking?.freeze_head_on_face_loss) return;
      freezePoseStatus.textContent = data?.active
        ? (data?.recovering ? 'Tracking loss protection: RECOVERING' : 'Tracking loss protection: FROZEN · lip sync remains live')
        : 'Tracking loss protection: ready';
    });
    row(box.body, 'Tracking loss protection', freezePoseWrap, {
      reset: async () => XRA.tracking.setFreezeHeadOnFaceLoss(false),
      isDefault: () => !config.tracking?.freeze_head_on_face_loss,
      sub: 'Automatic while Body stabilization is ON. Enable it here to keep the last valid full pose even with stabilization OFF; microphone lip sync remains active.'
    });

    const recovery = select([[0, 'Instant'], [150, 'Fast'], [350, 'Normal'], [700, 'Smooth'], [1200, 'Very smooth']]);
    bindRefresh(() => { recovery.value = String(Number(config.tracking?.freeze_recovery_ms ?? defaults.tracking?.freeze_recovery_ms ?? 350)); });
    recovery.onchange = async () => {
      config.tracking ||= {};
      config.tracking.freeze_recovery_ms = Number(recovery.value);
      XRA.tracking.broadcastTrackingState?.();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Recovery speed', recovery, {
      reset: async () => {
        config.tracking.freeze_recovery_ms = defaults.tracking?.freeze_recovery_ms ?? 350;
        XRA.tracking.broadcastTrackingState?.();
      },
      isDefault: () => Number(config.tracking?.freeze_recovery_ms ?? 350) === Number(defaults.tracking?.freeze_recovery_ms ?? 350),
      sub: 'Controls how quickly the avatar blends from the frozen pose back to live tracking after the detector is stable again.'
    });

    const advanced = details(box.body, 'Advanced stability / tracking');

    const recapture = button('🎯 Recapture reference pose');
    bindRefresh(() => { recapture.disabled = !XRA.tracking.bodyStable; });
    recapture.onclick = async () => {
      if (!XRA.tracking.bodyStable) return;
      const body = XRA.tracking.captureBodyPose();
      const guard = XRA.tracking.motionHysteresis ? XRA.tracking.captureGuardPose() : 0;
      XRA.toast(body || guard ? 'Reference pose captured' : 'Avatar bones not ready', body || guard ? 'info' : 'error');
    };
    advanced.body.appendChild(recapture);

    const transition = select([[250, '250 ms'], [450, '450 ms'], [700, '700 ms'], [1000, '1000 ms']]);
    bindRefresh(() => { transition.value = String(config.body.transition_ms ?? 450); });
    transition.onchange = async () => {
      config.body.transition_ms = Number(transition.value);
      await XRA.profileService.save();
      refreshAll();
    };
    row(advanced.body, 'Transition', transition, {
      reset: async () => { config.body.transition_ms = defaults.body.transition_ms; },
      isDefault: () => Number(config.body.transition_ms) === defaults.body.transition_ms,
      sub: 'Blend time when body stabilization is enabled or disabled.'
    });

    function trackingSlider(parent, label, key, {
      min = 0, max = 100, step = 1, scale = 1, suffix = '', defaultValue = null, disabledWhenOff = true, sub = ''
    } = {}) {
      const wrap = el('div', 'xra-stack-control');
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
      const text = el('div', 'xra-sub');
      wrap.append(input, text);
      const def = defaultValue ?? defaults.tracking?.[key] ?? 0;
      let resetButton = null;
      const isDefault = () => Math.abs(Number(config.tracking?.[key] ?? def) - Number(def)) < 1e-9;
      bindRefresh(() => {
        const value = Number(config.tracking?.[key] ?? def);
        input.value = String(value * scale);
        text.textContent = `${Number(input.value).toFixed(step < 1 ? 1 : 0)}${suffix}`;
        if (disabledWhenOff) input.disabled = !XRA.tracking.motionHysteresis;
        if (resetButton) resetButton.disabled = isDefault();
      });
      input.oninput = () => {
        config.tracking ||= {};
        config.tracking[key] = Number(input.value) / scale;
        text.textContent = `${Number(input.value).toFixed(step < 1 ? 1 : 0)}${suffix}`;
        if (resetButton) resetButton.disabled = isDefault();
      };
      input.onchange = async () => {
        await XRA.profileService.save();
        events.emit('upper-body-guard-config', config.tracking);
        if (resetButton) resetButton.disabled = isDefault();
      };
      const r = row(parent, label, wrap, {
        reset: async () => { config.tracking[key] = def; },
        isDefault,
        sub
      });
      resetButton = r.querySelector('.xra-reset');
      return input;
    }

    trackingSlider(advanced.body, 'Reject jump above', 'guard_jump_deg',
      { min: 15, max: 100, step: 1, suffix: '°', defaultValue: 42,
        sub: 'Sets the rapid-rotation threshold used across the motion hysteresis multi-frame window.' });
    trackingSlider(advanced.body, 'Hold last valid pose', 'guard_hold_ms',
      { min: 100, max: 2000, step: 50, suffix: ' ms', defaultValue: 650,
        sub: 'How long the anti-glitch safety holds the last valid full pose after a rejected tracking jump.' });
    trackingSlider(advanced.body, 'Reacquire near neutral', 'guard_reacquire_deg',
      { min: 25, max: 120, step: 1, suffix: '°', defaultValue: 60 });
    trackingSlider(advanced.body, 'Min landmark confidence', 'guard_confidence_min',
      { min: 5, max: 95, step: 1, scale: 100, suffix: '%', defaultValue: .35 });
    trackingSlider(advanced.body, 'Smooth release when disabling', 'guard_release_ms',
      { min: 100, max: 1500, step: 50, suffix: ' ms', defaultValue: 450, disabledWhenOff: false });

    const adaptiveSmooth = document.createElement('input'); adaptiveSmooth.type = 'checkbox';
    bindRefresh(() => {
      adaptiveSmooth.checked = config.tracking?.adaptive_smoothing !== false;
      adaptiveSmooth.disabled = !XRA.tracking.motionHysteresis;
    });
    adaptiveSmooth.onchange = async () => {
      config.tracking ||= {}; config.tracking.adaptive_smoothing = adaptiveSmooth.checked;
      await XRA.profileService.save();
    };
    row(advanced.body, 'Adaptive smoothing', adaptiveSmooth, {
      sub: 'Adds extra torso rotation smoothing when movement is small. It does not alter hips translation.'
    });
    trackingSlider(advanced.body, 'Adaptive smoothing strength', 'adaptive_smoothing_strength',
      { min: 0, max: 100, step: 1, scale: 100, suffix: '%', defaultValue: .45 });

    const confidenceStatus = el('div', 'xra-status', 'Tracking confidence: —');
    advanced.body.appendChild(confidenceStatus);
    let confidenceTimer = 0;
    advanced.details.addEventListener('toggle', () => {
      if (confidenceTimer) clearInterval(confidenceTimer);
      confidenceTimer = 0;
      if (!advanced.details.open) return;
      confidenceTimer = setInterval(() => {
        if (!XRA.tracking.motionHysteresis) {
          confidenceStatus.textContent = 'Motion hysteresis is off';
          return;
        }
        const measured = XRA.tracking?.guardMeasuredConfidence;
        const effective = Number(XRA.tracking?.guardConfidence ?? 1);
        const jump = Number(XRA.tracking?.guardLastJumpDegrees ?? 0);
        confidenceStatus.textContent =
          `Tracking confidence: ${measured == null ? `heuristic ${Math.round(effective * 100)}%` : `${Math.round(Number(measured) * 100)}%`} · max jump ${jump.toFixed(1)}°` +
          (XRA.tracking?.guardHoldActive ? ' · HOLDING LAST VALID' : '');
      }, 750);
    });

    const smoothing = select([[0, 'Min'], [1, 'Small'], [2, 'Normal']]);
    bindRefresh(() => { smoothing.value = String(config.tracking?.native_smoothing ?? nativeCamera()?.mocap_data_smoothing ?? 0); });
    smoothing.onchange = async () => {
      config.tracking ||= {}; config.tracking.native_smoothing = Number(smoothing.value);
      const c = nativeCamera(); if (c) c.mocap_data_smoothing = Number(smoothing.value);
      await XRA.profileService.save(); refreshAll();
    };
    row(advanced.body, 'Native mocap smoothing', smoothing, {
      reset: async () => { config.tracking.native_smoothing = defaults.tracking?.native_smoothing ?? 0; const c = nativeCamera(); if (c) c.mocap_data_smoothing = config.tracking.native_smoothing; },
      isDefault: () => Number(config.tracking?.native_smoothing ?? 0) === Number(defaults.tracking?.native_smoothing ?? 0)
    });

    const bend = select([[0, 'Off'], [0.25, 'Small'], [0.5, 'Medium'], [0.75, 'Large'], [1, 'Full']]);
    bindRefresh(() => { bend.value = String(config.tracking?.body_bend_reduction ?? nativeCamera()?.poseNet?.body_bend_reduction_power ?? 0); });
    bend.onchange = async () => {
      config.tracking ||= {}; config.tracking.body_bend_reduction = Number(bend.value);
      const p = nativeCamera()?.poseNet; if (p) p.body_bend_reduction_power = Number(bend.value);
      await XRA.profileService.save(); refreshAll();
    };
    row(advanced.body, 'Body bend reduction', bend, {
      reset: async () => { config.tracking.body_bend_reduction = defaults.tracking?.body_bend_reduction ?? 0; const p = nativeCamera()?.poseNet; if (p) p.body_bend_reduction_power = config.tracking.body_bend_reduction; },
      isDefault: () => Number(config.tracking?.body_bend_reduction ?? 0) === Number(defaults.tracking?.body_bend_reduction ?? 0)
    });

    const calibrate = button('🎯 CALIBRATE (3s)');
    calibrate.onclick = async () => {
      calibrate.disabled = true;
      await XRA.tracking.calibrate(n => { calibrate.textContent = `Calibrate in ${n}…`; });
      calibrate.textContent = 'Calibration OK';
      setTimeout(() => { calibrate.textContent = '🎯 CALIBRATE (3s)'; calibrate.disabled = false; }, 1000);
    };
    advanced.body.appendChild(calibrate);
  }

  function installCollider(parent) {
    const box = details(parent, '🛡 Body collider');

    const preset = select([['OFF', 'Off'], ['SOFT', 'Soft'], ['NORMAL', 'Normal'], ['STRONG', 'Strong'], ['CUSTOM', 'Custom']]);
    bindRefresh(() => { preset.value = config.collider?.preset || 'CUSTOM'; });
    preset.onchange = async () => {
      XRA.tracking.applyColliderPreset(preset.value);
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Preset', preset, {
      reset: async () => { config.collider.preset = defaults.collider.preset; },
      isDefault: () => (config.collider?.preset || 'CUSTOM') === defaults.collider.preset
    });

    const colliderAdvanced = details(box.body, 'Advanced');

    const mode = select([[0, 'Off'], [1, 'Upper body'], [2, 'Full']]);
    bindRefresh(() => { mode.value = String(nativeCollider()?.mode ?? 0); });
    mode.onchange = () => XRA.tracking.setColliderField('root', 'mode', Number(mode.value));
    row(colliderAdvanced.body, 'Mode', mode, {
      reset: async () => XRA.tracking.setColliderField('root', 'mode', 0),
      isDefault: () => Number(nativeCollider()?.mode ?? 0) === 0
    });

    const reaction = select([['z_push', 'Z push'], ['sphere', 'Sphere']]);
    bindRefresh(() => { reaction.value = nativeCollider()?.head?.reaction_type || 'z_push'; });
    reaction.onchange = () => XRA.tracking.setColliderField('head', 'reaction_type', reaction.value);
    row(colliderAdvanced.body, 'Head reaction', reaction, {
      reset: async () => XRA.tracking.setColliderField('head', 'reaction_type', 'z_push'),
      isDefault: () => (nativeCollider()?.head?.reaction_type || 'z_push') === 'z_push'
    });

    for (const [part, label] of [['head', 'Head'], ['chest', 'Chest'], ['waist', 'Waist'], ['hip', 'Hip']]) {
      const wrap = el('div', 'xra-stack-control');
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '300'; input.step = '5';
      const text = el('div', 'xra-sub');
      wrap.append(input, text);
      bindRefresh(() => {
        const value = Number(nativeCollider()?.[part]?.size_percent ?? 0);
        input.value = String(value);
        text.textContent = `${value}%`;
      });
      input.oninput = () => {
        let value = Number(input.value);
        if (value > 0 && value < 50) value = 50;
        input.value = String(value);
        text.textContent = `${value}%`;
        const collider = nativeCollider();
        if (collider?.[part]) collider[part].size_percent = value;
        config.collider.preset = 'CUSTOM';
      };
      input.onchange = () => XRA.profileService.save();
      row(colliderAdvanced.body, label, wrap, {
        reset: async () => {
          const collider = nativeCollider();
          if (collider?.[part]) collider[part].size_percent = 100;
          config.collider.preset = 'CUSTOM';
        },
        isDefault: () => Number(nativeCollider()?.[part]?.size_percent ?? 100) === 100
      });
    }
  }

  function installPerformance(parent) {
    const box = details(parent, '⚡ Performance');
    const status = el('div', 'xra-status', 'Ready.');

    const master = select(['AUTO', 'ECO', 'LOW', 'BALANCED', 'QUALITY', 'HIGH', 'MAX', 'CUSTOM'].map(x => [x, x]));
    bindRefresh(() => { const p = config.performance.master_preset || 'CUSTOM'; master.value = p === 'MINIMAL' ? 'ECO' : p; });
    master.onchange = async () => {
      master.disabled = true;
      try {
        if (master.value === 'AUTO') {
          await XRA.performance.autoRuntime(message => { status.textContent = message; });
        }
        else if (master.value !== 'CUSTOM') {
          status.textContent = `${master.value}: applying…`;
          await XRA.performance.applyMasterPreset(master.value, { switchPipeline: true });
          status.textContent = `${master.value}: applied`;
        }
        else {
          config.performance.master_preset = 'CUSTOM';
          await XRA.profileService.save();
          status.textContent = 'CUSTOM';
        }
      }
      catch (e) {
        console.error(TAG, e);
        status.textContent = 'ERROR: ' + e.message;
      }
      finally {
        master.disabled = false;
        refreshAll();
      }
    };
    row(box.body, 'Master preset', master, {
      reset: async () => { config.performance.master_preset = 'CUSTOM'; },
      isDefault: () => (config.performance.master_preset || 'CUSTOM') === 'CUSTOM'
    });
    box.body.appendChild(status);

    const perfAdvanced = details(box.body, 'Advanced');

    const pipeline = select([
      ['Full Body', 'Full body (MediaPipe Vision)'],
      ['Face', 'Face only']
    ]);
    bindRefresh(() => {
      let current = XRA.performance.currentNativeType() || 'Full Body';
      if (current === 'Face+Body' || current === 'Full Body Holistic') current = 'Full Body';
      pipeline.querySelector('option[data-xra-legacy-current]')?.remove();
      if ([...pipeline.options].some(o => o.value === current)) {
        pipeline.value = current;
      }
      else {
        pipeline.value = 'Full Body';
      }
    });
    pipeline.onchange = async () => {
      pipeline.disabled = true;
      try { await XRA.performance.setMocapMode(pipeline.value); }
      finally { pipeline.disabled = false; refreshAll(); }
    };
    row(perfAdvanced.body, 'Tracking / mocap mode', pipeline, {
      sub: 'Only useful combined modes are shown here. Startup/LOAD never changes this automatically.'
    });

    const camOpt = document.createElement('input');
    camOpt.type = 'checkbox';
    bindRefresh(() => { camOpt.checked = !!config.camera.optimized; });
    camOpt.onchange = async () => {
      config.camera.optimized = camOpt.checked;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Limit webcam', camOpt, {
      reset: async () => { config.camera.optimized = defaults.camera.optimized; XRA.performance.apply(); },
      isDefault: () => config.camera.optimized === defaults.camera.optimized
    });

    const res = select([
      ['424x240', '424×240'], ['640x360', '640×360'], ['640x480', '640×480'],
      ['1280x720', '1280×720'], ['1280x960', '1280×960'], ['1920x1080', '1920×1080']
    ]);
    bindRefresh(() => { res.value = `${config.camera.width}x${config.camera.height}`; });
    res.onchange = async () => {
      const [w, h] = res.value.split('x').map(Number);
      config.camera.width = w;
      config.camera.height = h;
      config.camera.optimized = true;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Webcam resolution', res, {
      reset: async () => {
        config.camera.width = defaults.camera.width;
        config.camera.height = defaults.camera.height;
        XRA.performance.apply();
      },
      isDefault: () => config.camera.width === defaults.camera.width && config.camera.height === defaults.camera.height
    });

    const fps = select([[20, '20 FPS'], [24, '24 FPS'], [30, '30 FPS'], [60, '60 FPS']]);
    bindRefresh(() => { fps.value = String(config.camera.fps); });
    fps.onchange = async () => {
      config.camera.fps = Number(fps.value);
      config.camera.optimized = true;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Webcam FPS', fps, {
      reset: async () => { config.camera.fps = defaults.camera.fps; XRA.performance.apply(); },
      isDefault: () => Number(config.camera.fps) === defaults.camera.fps
    });

    const pose = select([['Lite', 'Lite'], ['Normal', 'Normal'], ['Best', 'Best']]);
    bindRefresh(() => { pose.value = config.pose_model || 'Normal'; });
    pose.onchange = async () => {
      config.pose_model = pose.value;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Pose quality', pose, {
      reset: async () => { config.pose_model = defaults.pose_model; XRA.performance.apply(); },
      isDefault: () => config.pose_model === defaults.pose_model,
      sub: 'Usa il Pose Landmarker standalone quando la pipeline lo supporta.'
    });

    const poseHz = select([[15, '15 Hz'], [20, '20 Hz'], [24, '24 Hz'], [30, '30 Hz'], [60, '60 Hz']]);
    bindRefresh(() => { poseHz.value = String(config.performance.pose_fps || 30); });
    poseHz.onchange = async () => {
      config.performance.pose_fps = Number(poseHz.value);
      markCustomPreset();
      XRA.performance.sendInferenceRates();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Pose inference', poseHz, {
      reset: async () => { config.performance.pose_fps = defaults.performance.pose_fps; XRA.performance.sendInferenceRates(); },
      isDefault: () => Number(config.performance.pose_fps) === defaults.performance.pose_fps
    });

    const handHz = select([[10, '10 Hz'], [15, '15 Hz'], [20, '20 Hz'], [30, '30 Hz'], [60, '60 Hz']]);
    bindRefresh(() => { handHz.value = String(config.performance.hand_fps || 20); });
    handHz.onchange = async () => {
      config.performance.hand_fps = Number(handHz.value);
      markCustomPreset();
      XRA.performance.sendInferenceRates();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Hands inference', handHz, {
      reset: async () => { config.performance.hand_fps = defaults.performance.hand_fps; XRA.performance.sendInferenceRates(); },
      isDefault: () => Number(config.performance.hand_fps) === defaults.performance.hand_fps
    });

    const runtimeAdaptive = document.createElement('input'); runtimeAdaptive.type = 'checkbox';
    bindRefresh(() => { runtimeAdaptive.checked = !!config.performance?.runtime_adaptive; });
    runtimeAdaptive.onchange = async () => {
      XRA.performance.setRuntimeAdaptive(runtimeAdaptive.checked);
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Runtime adaptive performance', runtimeAdaptive, {
      sub: 'Lightweight governor: temporarily reduces inference rates only when render timing is under sustained stress. It never rewrites the selected performance preset.'
    });

    const diagnosticsHud = document.createElement('input'); diagnosticsHud.type = 'checkbox';
    bindRefresh(() => { diagnosticsHud.checked = !!config.performance?.diagnostics_hud; });
    diagnosticsHud.onchange = async () => {
      XRA.performance.setDiagnosticsHud(diagnosticsHud.checked);
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Performance / REC HUD', diagnosticsHud, {
      sub: 'Diagnostic overlay with render FPS, inference targets, recorder frame estimate, mic/gate and Torso Guard confidence. Cost is near-zero when disabled.'
    });

    const debugSession = document.createElement('input'); debugSession.type = 'checkbox';
    const debugSessionWrap = el('div', 'xra-stack-control');
    const debugStatus = el('div', 'xra-sub');
    debugSessionWrap.append(debugSession, debugStatus);
    const refreshDebugStatus = () => {
      const active = !!XRA.debug?.enabled;
      debugSession.checked = active;
      debugStatus.textContent = active
        ? `Debug session: ON · ${XRA.debug?.eventCount || 0} events`
        : `Debug session: OFF · ${XRA.debug?.eventCount || 0} events in memory`;
    };
    bindRefresh(refreshDebugStatus);
    events.on('debug-count', refreshDebugStatus);
    events.on('debug-session', refreshDebugStatus);
    events.on('debug-log', refreshDebugStatus);
    debugSession.onchange = async () => {
      XRA.debug?.setEnabled(debugSession.checked);
      refreshDebugStatus();
      await XRA.profileService.save(0);
      refreshAll();
    };
    row(perfAdvanced.body, 'Debug session', debugSessionWrap, {
      sub: 'Records tracking, stabilization and pose-change diagnostics in memory. Off by default; no camera frames or device IDs are saved.'
    });

    const debugActions = el('div', 'xra-actions');
    const exportDebug = button('Export debug log');
    const clearDebug = button('Clear debug log');
    exportDebug.onclick = async () => {
      exportDebug.disabled = true;
      try {
        const result = await XRA.debug?.exportLog?.();
        if (result?.cancelled) XRA.toast('Debug log save cancelled');
        else if (result?.ok) XRA.toast(`Debug log saved: ${result.path} (${result.count} events)`);
        else XRA.toast('Debug log save failed', 'error');
      }
      catch (error) {
        XRA.toast(`Debug log save failed: ${error?.message || error}`, 'error', 5000);
      }
      finally {
        exportDebug.disabled = false;
        refreshDebugStatus();
      }
    };
    clearDebug.onclick = () => {
      XRA.debug?.clear?.();
      XRA.toast('Debug log cleared');
      refreshAll();
    };
    debugActions.append(exportDebug, clearDebug);
    row(perfAdvanced.body, 'Debug log', debugActions, {
      sub: 'Enable the session, reproduce the problem, then export the JSON file.'
    });

    const post = document.createElement('input');
    post.type = 'checkbox';
    bindRefresh(() => { post.checked = !!config.performance.disable_postfx; });
    post.onchange = async () => {
      config.performance.disable_postfx = post.checked;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(perfAdvanced.body, 'Disable heavy post FX', post, {
      reset: async () => { config.performance.disable_postfx = defaults.performance.disable_postfx; XRA.performance.apply(); },
      isDefault: () => !!config.performance.disable_postfx === !!defaults.performance.disable_postfx
    });

    // Native visual-effect fine tuning belongs here because Performance already
    // owns the quick "Disable heavy post FX" shortcut. Keep one logical home.
    const fxAdvanced = details(perfAdvanced.body, 'Visual effects');
    for (const [key, label] of [
      ['UnrealBloom', 'Bloom'],
      ['N8AO', 'Ambient occlusion'],
      ['DOF', 'Depth of field']
    ]) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      const safeGetFx = () => {
        try {
          const fx = window.MMD_SA?.THREEX?.PPE?.[key];
          if (!fx) return false;
          return !!fx.enabled;
        } catch (e) {
          return false;
        }
      };
      const safeSetFx = val => {
        try {
          const fx = window.MMD_SA?.THREEX?.PPE?.[key];
          if (fx) fx.enabled = !!val;
        } catch (e) {}
      };
      let baselineCaptured = false;
      let baseline = false;
      const captureBaseline = () => {
        if (!baselineCaptured) {
          try {
            const fx = window.MMD_SA?.THREEX?.PPE?.[key];
            if (fx) {
              baseline = safeGetFx();
              baselineCaptured = true;
            }
          } catch (e) {}
        }
        return baseline;
      };
      bindRefresh(() => {
        captureBaseline();
        const saved = config.visual_effects?.[key];
        input.checked = saved == null ? safeGetFx() : !!saved;
        if (saved != null) safeSetFx(saved);
      });
      input.onchange = async () => {
        config.visual_effects ||= {};
        config.visual_effects[key] = !!input.checked;
        safeSetFx(input.checked);
        await XRA.profileService.save();
      };
      row(fxAdvanced.body, label, input, {
        reset: async () => {
          safeSetFx(captureBaseline());
        },
        isDefault: () => safeGetFx() === captureBaseline()
      });
    }
    const nativeFx = button('Open advanced visual effects');
    const closeNativeFx = button('Close advanced visual effects');
    const closeFxGui = () => {
      const gui = window.MMD_SA?.THREEX?.GUI?.obj?.visual_effects;
      const dom = gui?.domElement || gui?.__ul?.closest?.('.dg') || document.querySelector('.dg.main.xra-native-fx-centered');
      try { gui?.hide?.(); } catch (e) {}
      if (dom instanceof HTMLElement) {
        dom.classList.remove('xra-native-fx-centered');
        if (!gui?.hide) dom.style.display = 'none';
        dom.querySelector('.xra-native-fx-close')?.remove();
      }
    };
    nativeFx.onclick = async () => {
      try {
        const gui = window.MMD_SA?.THREEX?.GUI?.obj?.visual_effects;
        if (!gui) throw new Error('Visual Effects GUI not ready');
        if (window.MMD_SA?.THREEX?.PPE && !MMD_SA.THREEX.PPE.initialized) await MMD_SA.THREEX.PPE.init?.();
        gui.show?.();
        requestAnimationFrame(() => {
          const dom = gui.domElement || gui.__ul?.closest?.('.dg') || document.querySelector('.dg.main');
          if (dom instanceof HTMLElement) {
            dom.style.display = '';
            dom.classList.add('xra-native-fx-centered');
            let x = dom.querySelector('.xra-native-fx-close');
            if (!x) {
              x = document.createElement('button'); x.type = 'button'; x.className = 'xra-native-fx-close'; x.textContent = '×'; x.title = 'Close advanced visual effects';
              x.onclick = event => { event.preventDefault(); event.stopPropagation(); closeFxGui(); };
              dom.appendChild(x);
            }
          }
        });
      }
      catch (e) { XRA.toast(e.message, 'error'); }
    };
    closeNativeFx.onclick = closeFxGui;
    const nativeFxActions = el('div', 'xra-actions'); nativeFxActions.append(nativeFx, closeNativeFx);
    fxAdvanced.body.appendChild(nativeFxActions);

    const native = el('div', 'xra-status');
    bindRefresh(() => {
      const state = XRA.performance.nativeSummary();
      native.textContent = `${state.mocap}\n${state.width}×${state.height} @ ${state.fps} · ${state.pose}`;
    });
    box.body.appendChild(native);
  }

  function installBackground(parent) {
    const box = details(parent, '🖼 Background');
    box.details.addEventListener('toggle', () => {
      if (box.details.open && !backgroundsLoaded) refreshBackgrounds();
    });

    const mode = select([['color', 'Color'], ['image', 'Image']]);
    bindRefresh(() => { mode.value = config.background.mode || 'color'; });
    mode.onchange = async () => {
      config.background.mode = mode.value;
      XRA.background.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Mode', mode, {
      reset: async () => { config.background.mode = defaults.background.mode; XRA.background.apply(); },
      isDefault: () => config.background.mode === defaults.background.mode
    });

    const color = document.createElement('input');
    color.type = 'color';
    bindRefresh(() => { color.value = config.background.color || '#202020'; });
    color.oninput = () => { config.background.color = color.value; XRA.background.apply(); };
    color.onchange = () => XRA.profileService.save();
    row(box.body, 'Color', color, {
      reset: async () => { config.background.color = defaults.background.color; XRA.background.apply(); },
      isDefault: () => config.background.color === defaults.background.color
    });

    bgSelect = select([['', '-- choose background --']]);
    bgSelect.onchange = async () => {
      if (!bgSelect.value) return;
      config.background.mode = 'image';
      config.background.path = bgSelect.value;
      XRA.background.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Background file', bgSelect, {
      reset: async () => {
        config.background.path = defaults.background.path;
        config.background.mode = defaults.background.mode;
        XRA.background.apply();
        backgroundsLoaded = false;
        await refreshBackgrounds();
      },
      isDefault: () => config.background.path === defaults.background.path && config.background.mode === defaults.background.mode
    });

    const path = stopInputPropagation(document.createElement('input'));
    path.type = 'text';
    path.className = 'xra-control';
    path.placeholder = 'backgrounds/podcast.png';
    bindRefresh(() => { path.value = config.background.path || ''; });
    path.oninput = () => { config.background.path = path.value.trim(); };
    path.onchange = async () => {
      config.background.path = path.value.trim();
      config.background.mode = 'image';
      XRA.background.apply();
      backgroundsLoaded = false;
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Image path', path, {
      reset: async () => { config.background.path = defaults.background.path; config.background.mode = defaults.background.mode; XRA.background.apply(); },
      isDefault: () => config.background.path === defaults.background.path
    });

    const refresh = button('↻ Refresh background files');
    refresh.onclick = () => { backgroundsLoaded = false; refreshBackgrounds(true); };
    box.body.appendChild(refresh);
  }

  function downloadJSON(name, object) {
    const blob = new Blob([JSON.stringify(object, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function installProfile(parent) {
    const box = details(parent, '💾 Profile');

    const startup = document.createElement('input');
    startup.type = 'checkbox';
    bindRefresh(() => { startup.checked = !!config.ui.show_startup; });
    startup.onchange = async () => {
      config.ui.show_startup = startup.checked;
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Startup screen', startup, {
      reset: async () => { config.ui.show_startup = defaults.ui.show_startup; },
      isDefault: () => !!config.ui.show_startup === !!defaults.ui.show_startup
    });

    const actions = el('div', 'xra-actions');
    const save = button('💾 SAVE');
    save.onclick = async () => XRA.toast(await XRA.profileService.save(0) ? 'Profile saved' : 'Save failed');
    const load = button('↻ LOAD');
    load.onclick = async () => {
      const ok = await XRA.profileService.load();
      XRA.toast(ok ? 'Profile loaded' : 'Load failed', ok ? 'info' : 'error');
      backgroundsLoaded = false;
      refreshAll();
    };
    actions.append(save, load);
    box.body.appendChild(actions);

    const transfer = el('div', 'xra-actions');
    const exp = button('EXPORT');
    exp.onclick = async () => {
      await XRA.profileService.save(0);
      const response = await fetch('/__xra_profile', { cache: 'no-store' });
      if (response.ok) downloadJSON('xra_profile.json', await response.json());
    };
    const imp = button('IMPORT');
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    imp.onclick = () => file.click();
    file.onchange = async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        const object = JSON.parse(await selected.text());
        if (!object?.custom) throw new Error('Invalid profile');
        const response = await fetch('/__xra_profile', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(object)
        });
        if (!response.ok) throw new Error(await response.text());
        await XRA.profileService.load();
        XRA.toast('Profile imported');
      }
      catch (e) {
        XRA.toast('Import failed: ' + e.message, 'error', 4000);
      }
      file.value = '';
    };
    transfer.append(exp, imp, file);
    box.body.appendChild(transfer);
  }

  function create() {
    if (panel) return panel;

    panel = el('div', 'xra-right-panel');
    panel.id = 'XRA_CUSTOM_PANEL';

    const header = el('div', 'xra-right-header');
    const hands = button('🖐 HANDS ON', 'xra-hands');
    bindRefresh(() => {
      hands.textContent = XRA.tracking.handsEnabled ? '🖐 HANDS ON' : '🧊 HANDS OFF';
      hands.classList.toggle('off', !XRA.tracking.handsEnabled);
    });
    hands.onclick = () => XRA.tracking.setHands(!XRA.tracking.handsEnabled);

    const hide = button('🙈', 'xra-hide');
    hide.title = 'Nascondi i menu';
    bindRefresh(() => {
      hide.textContent = UI.hidden ? '👁️' : '🙈';
      hide.title = UI.hidden ? 'Mostra i menu' : 'Nascondi i menu';
    });
    hide.onclick = () => UI.setHidden(!UI.hidden);

    const totalHide = button('🎬', 'xra-total-hide');
    totalHide.title = "Nascondi completamente l'interfaccia (Premi Esc per ripristinare)";
    totalHide.onclick = () => UI.setTotalHidden(true);

    header.append(hands, hide, totalHide);

    let panelBodyOpen = true;

    const launcher = button('📋 CONTROL PANEL', 'xra-right-launcher');
    launcher.hidden = true;
    launcher.dataset.xraRightLauncher = '1';
    bindRefresh(() => {
      const title = XRA.i18n?.t?.('Control panel') || 'Control panel';
      launcher.textContent = `📋 ${title.toUpperCase()}`;
      launcher.title = XRA.i18n?.t?.('Open control panel') || 'Open control panel';
    });
    launcher.onclick = () => {
      panelBodyOpen = true;
      body.hidden = false;
      launcher.hidden = true;
      updateMeterLoop();
    };

    body = el('div', 'xra-right-body');

    const menuTop = el('div', 'xra-menu-top');
    const menuTitle = el('div', 'xra-menu-title', 'Control panel');
    bindRefresh(() => {
      const title = XRA.i18n?.t?.('Control panel') || 'Control panel';
      menuTitle.textContent = `📋 ${title.toUpperCase()}`;
    });
    const menuClose = button('×', 'xra-menu-close');
    menuClose.title = 'Close panel';
    bindRefresh(() => {
      menuClose.title = XRA.i18n?.t?.('Close panel') || 'Close panel';
    });
    menuClose.onclick = () => {
      panelBodyOpen = false;
      body.hidden = true;
      if (!UI.hidden) launcher.hidden = false;
      updateMeterLoop();
    };
    menuTop.append(menuTitle, menuClose);
    body.appendChild(menuTop);

    const content = el('div', 'xra-right-content');
    installHealth(content);
    installStudioLink(content);
    installLip(content);
    installBody(content);
    installCollider(content);
    installPerformance(content);
    installBackground(content);
    installProfile(content);
    body.appendChild(content);

    panel.append(header, launcher, body);
    document.body.appendChild(panel);

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshMicrophones);
    events.on('profile-loaded', () => {
      backgroundsLoaded = false;
      refreshMicrophones();
      refreshAll();
    });
    events.on('ui-hidden', hidden => {
      if (hidden) {
        body.hidden = true;
        launcher.hidden = true;
      } else {
        body.hidden = !panelBodyOpen;
        launcher.hidden = panelBodyOpen;
      }
      updateMeterLoop();
    });

    refreshMicrophones();
    refreshAll();
    updateMeterLoop();
    return panel;
  }

  XRA.rightPanel = { create, refreshMicrophones, refreshBackgrounds, updateMeterLoop };
  XRA.ui = Object.assign(XRA.ui || {}, {
    create,
    refresh: refreshAll,
    refreshMicrophones,
    refreshBackgrounds,
    setHidden: UI.setHidden,
    setTotalHidden: UI.setTotalHidden
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', create, { once: true });
  else create();

})();
