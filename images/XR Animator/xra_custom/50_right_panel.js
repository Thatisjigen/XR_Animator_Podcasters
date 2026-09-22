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
    const active = !!config.lip?.meter_visible && !UI.hidden && !body?.hidden && !!lipDetails?.open;
    if (!active) return;

    const fill = panel?.querySelector('[data-xra="meter-fill"]');
    const gateLip = panel?.querySelector('[data-xra="meter-gate-lip"]') || panel?.querySelector('[data-xra="meter-gate"]');
    const gateRec = panel?.querySelector('[data-xra="meter-gate-rec"]');
    const legend = panel?.querySelector('[data-xra="meter-legend"]');
    if (!fill) return;

    let last = 0;
    const maxLinear = 0.08;
    const draw = t => {
      if (!(config.lip?.meter_visible && !UI.hidden && !body?.hidden && lipDetails?.open)) return;
      if (t - last >= 45) {
        last = t;
        const envelope = Number(window.XR_LIP?.status?.().envelope || 0);
        const fillPct = Math.min(100, Math.max(0, (envelope / maxLinear) * 100));
        fill.style.width = fillPct.toFixed(1) + '%';

        const lipThresh = Number(config.lip?.threshold || 0.018);
        if (gateLip) {
          const lipPct = Math.min(100, Math.max(0, (lipThresh / maxLinear) * 100));
          gateLip.style.left = lipPct.toFixed(1) + '%';
        }

        const recGateOn = config.recorder?.noise_gate !== false;
        const recThreshDb = Number(config.recorder?.gate_threshold_db ?? -48);
        const recThreshLinear = Math.pow(10, recThreshDb / 20);
        if (gateRec) {
          if (!recGateOn) {
            gateRec.style.display = 'none';
          } else {
            gateRec.style.display = 'block';
            const recPct = Math.min(100, Math.max(0, (recThreshLinear / maxLinear) * 100));
            gateRec.style.left = recPct.toFixed(1) + '%';
          }
        }

        if (legend) {
          const lipSpeaking = envelope >= lipThresh;
          const recPassing = !recGateOn || (envelope >= recThreshLinear);
          legend.innerHTML =
            `<span style="color:${lipSpeaking ? '#68d391' : '#a0aec0'}">🟢 Lip-sync: <b>${lipThresh.toFixed(3)}</b> (${lipSpeaking ? 'VOCE' : 'MUTED'})</span>` +
            `<span style="color:${recPassing ? '#f6ad55' : '#718096'}">🟠 Gate REC: <b>${recGateOn ? `${recThreshDb.toFixed(1)} dB` : 'OFF'}</b> (${!recGateOn ? 'OFF' : (recPassing ? 'APERTO' : 'CHIUSO')})</span>`;
        }
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

    const w = window.screen.availWidth || 1280;
    const h = window.screen.availHeight || 800;
    studioWindow = window.open(
      '/p2p_chat.html',
      'xra-studio-link',
      `width=${w},height=${h},left=0,top=0,resizable=yes,scrollbars=yes`
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
    const open = button('APRI CHAT', 'xra-action primary');
    open.onclick = openStudioLink;
    bindRefresh(() => {
      const title = XRA.i18n?.t?.('Studio Link') || 'Studio Link';
      box.summary.textContent = `💬 ${title}`;
      note.textContent = XRA.i18n?.t?.('Apre chat, voce e condivisione schermo P2P in una finestra separata.') || 'Apre chat, voce e condivisione schermo P2P in una finestra separata.';
      open.textContent = (XRA.i18n?.t?.('Apri chat') || 'APRI CHAT').toUpperCase();
    });
    box.body.append(note, open);
  }

  function installCameraView(parent) {
    const box = details(parent, '📷 Camera & Viewport');
    const note = el('div', 'xra-note');
    note.textContent = 'Gestione dell\'inquadratura 3D, zoom e blocco dello spostamento con il mouse.';

    const lockWrap = el('div', 'xra-stack-control');
    const lockInput = document.createElement('input');
    lockInput.type = 'checkbox';
    const lockStatus = el('div', 'xra-sub');
    lockWrap.append(lockInput, lockStatus);

    const isUiElement = (target) => {
      if (!target || !(target instanceof Element)) return false;
      if (target.closest(`
        #XRA_CUSTOM_PANEL,
        #XRA_NATIVE_SETTINGS,
        .xra-right-panel,
        .xra-panel,
        [class*="xra-"],
        .lil-gui,
        .dg,
        #Ldrag_box,
        #Ltitle,
        #Lsettings,
        #Lsystem,
        #Lquick_menu,
        #Lside_menu,
        #Lmessage_box,
        #Lspeech_bubble_host,
        dialog,
        [role="dialog"],
        [role="button"],
        [role="menu"],
        [role="menuitem"],
        [role="tab"]
      `)) {
        return true;
      }
      const tag = target.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'a', 'option'].includes(tag)) {
        return true;
      }
      return false;
    };

    let isUiDragActive = false;
    window.addEventListener('pointerdown', (e) => {
      if (isUiElement(e.target)) isUiDragActive = true;
    }, true);
    window.addEventListener('mousedown', (e) => {
      if (isUiElement(e.target)) isUiDragActive = true;
    }, true);
    window.addEventListener('pointerup', () => { isUiDragActive = false; }, true);
    window.addEventListener('mouseup', () => { isUiDragActive = false; }, true);
    window.addEventListener('pointercancel', () => { isUiDragActive = false; }, true);

    const patchTrackball = (tb) => {
      if (!tb || tb._xra_lock_patched) return;
      tb._xra_lock_patched = true;
      const origUpdate = tb.update;
      tb.update = function() {
        if (config.camera?.mouse_locked) return;
        return origUpdate.apply(this, arguments);
      };
    };

    const applyLock = (locked) => {
      const tb = window.MMD_SA?._trackball_camera;
      if (tb) {
        patchTrackball(tb);
        tb.enabled = !locked;
        tb._enabled = !locked;
        tb.noRotate = !!locked;
        tb.noZoom = !!locked;
        tb.noPan = !!locked;
      }
      if (window.MMD_SA?.THREEX?.camera?.control) {
        window.MMD_SA.THREEX.camera.control.enabled = !locked;
      }
      try {
        window.System?.Gadget?.Settings?.writeString?.('MMDTrackballCamera', locked ? 'non_default' : '');
      } catch (e) {}
      lockStatus.textContent = locked ? 'Controlli mouse: BLOCCATI (inquadratura fissa)' : 'Controlli mouse: ATTIVI';
    };

    const shouldBlockEvent = (e) => {
      if (!config.camera?.mouse_locked) return false;
      if (isUiDragActive) return false;
      return !isUiElement(e.target);
    };

    const blockEvent = (e) => {
      if (shouldBlockEvent(e)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    const blockMoveEvent = (e) => {
      if (shouldBlockEvent(e) && (e.buttons > 0 || e.which > 0)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    window.addEventListener('mousedown', blockEvent, true);
    window.addEventListener('pointerdown', blockEvent, true);
    window.addEventListener('mousemove', blockMoveEvent, true);
    window.addEventListener('pointermove', blockMoveEvent, true);
    window.addEventListener('wheel', blockEvent, { capture: true, passive: false });
    window.addEventListener('touchstart', blockEvent, true);
    window.addEventListener('touchmove', blockEvent, true);
    window.addEventListener('contextmenu', blockEvent, true);

    bindRefresh(() => {
      const locked = !!config.camera?.mouse_locked;
      lockInput.checked = locked;
      applyLock(locked);
    });

    lockInput.onchange = async () => {
      config.camera ||= {};
      config.camera.mouse_locked = !!lockInput.checked;
      applyLock(config.camera.mouse_locked);
      await XRA.profileService.save();
    };

    row(box.body, 'Lock mouse camera controls', lockWrap, {
      reset: async () => {
        config.camera ||= {};
        config.camera.mouse_locked = false;
        applyLock(false);
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => !config.camera?.mouse_locked,
      sub: 'Disabilita rotazione, rotellina dello zoom e Ctrl+trascinamento per evitare modifiche involontarie all\'inquadratura.'
    });

    const resetBtn = button('Reset camera view', 'xra-action');
    resetBtn.onclick = () => {
      try {
        if (window.MMD_SA?._trackball_camera?.reset) {
          window.MMD_SA._trackball_camera.reset();
        }
        if (window.MMD_SA?.reset_camera) window.MMD_SA.reset_camera(true);
        if (window.System?._browser?.camera?._update_camera_reset) {
          window.System._browser.camera._update_camera_reset();
        }
        XRA.toast('Inquadratura ripristinata', 'info');
      } catch (e) {
        console.warn(TAG, 'camera reset failed', e);
        XRA.toast('Errore ripristino inquadratura', 'error');
      }
    };

    row(box.body, 'Reset camera framing', resetBtn, {
      sub: 'Azzera zoom, pan e rotazione della visuale tornando alle coordinate predefinite.'
    });

    window.addEventListener('MMDStarted', () => {
      applyLock(!!config.camera?.mouse_locked);
    });
    window.addEventListener('jThree_ready', () => {
      applyLock(!!config.camera?.mouse_locked);
    });
  }

  function installAudio(parent) {
    const box = details(parent, '🎙️ Audio & Lip-sync', { open: true });
    lipDetails = box.details;
    lipDetails.addEventListener('toggle', () => {
      if (lipDetails.open) refreshMicrophones();
      updateMeterLoop();
    });

    const note = el('div', 'xra-note');
    note.textContent = 'Gestione unificata microfono per la sincronizzazione labiale dell\'avatar e per la registrazione audio con soppressione rumore.';
    box.body.appendChild(note);

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
      isDefault: () => !(config.devices?.mic_device_id),
      sub: 'Microfono comune sia per la sincronizzazione labiale dell\'avatar sia per la registrazione.'
    });

    const audioProfile = select([
      ['podcast', 'Podcast / Natural voice (Highest quality)'],
      ['call', 'Call (Browser echo/noise filters)']
    ]);
    bindRefresh(() => {
      audioProfile.value = config.recorder?.audio_profile || 'podcast';
    });
    audioProfile.onchange = async () => {
      config.recorder ||= {};
      config.recorder.audio_profile = audioProfile.value;
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Recording audio profile', audioProfile, {
      reset: async () => {
        config.recorder ||= {};
        config.recorder.audio_profile = defaults.recorder?.audio_profile || 'podcast';
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.recorder?.audio_profile || 'podcast') === (defaults.recorder?.audio_profile || 'podcast'),
      sub: 'Podcast disattiva l\'elaborazione aggressiva del browser preservando il timbro naturale; Call attiva AGC ed eco-cancellation.'
    });

    // --- Sezione Lip-sync avatar ---
    const lipSecTitle = el('div', 'xra-section-title', '👄 Parametri Lip-sync (Bocca avatar)');
    lipSecTitle.style.cssText = 'margin:12px 0 6px;font-size:12px;font-weight:600;color:#88c0d0;';
    box.body.appendChild(lipSecTitle);

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
      isDefault: () => Math.abs((config.lip.mic_mix ?? .6) - defaults.lip.mic_mix) < 1e-9,
      sub: 'Bilanciamento tra volume microfono e movimento rilevato dalla camera per l\'apertura della bocca.'
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
    row(box.body, 'Mouth response (Volume)', responseWrap, {
      reset: async () => { config.lip.response_gain = defaults.lip.response_gain; },
      isDefault: () => Math.abs((config.lip.response_gain ?? 1) - defaults.lip.response_gain) < 1e-9,
      sub: 'Sensibilità all\'apertura della bocca quando parli ad intensità normale.'
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
    row(box.body, 'Vowel expression (AA/OU/EE)', vowelWrap, {
      reset: async () => { config.lip.vowel_emphasis = defaults.lip.vowel_emphasis; },
      isDefault: () => Math.abs((config.lip.vowel_emphasis ?? 1) - defaults.lip.vowel_emphasis) < 1e-9,
      sub: 'Esagera le forme delle vocali sulla bocca dell\'avatar.'
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
      isDefault: () => Math.abs((config.lip.threshold ?? .018) - defaults.lip.threshold) < 1e-9,
      sub: 'Volume minimo del microfono per muovere la bocca. Rappresentata dalla linea verde 🟢 sul VU-meter.'
    });

    // --- Sezione Noise Gate Registrazione ---
    const recSecTitle = el('div', 'xra-section-title', '🔇 Noise Gate (Registrazione audio)');
    recSecTitle.style.cssText = 'margin:14px 0 6px;font-size:12px;font-weight:600;color:#88c0d0;';
    box.body.appendChild(recSecTitle);

    const recGateToggle = document.createElement('input');
    recGateToggle.type = 'checkbox';
    bindRefresh(() => {
      recGateToggle.checked = config.recorder?.noise_gate !== false;
    });
    recGateToggle.onchange = async () => {
      config.recorder ||= {};
      config.recorder.noise_gate = recGateToggle.checked;
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Recording noise gate', recGateToggle, {
      reset: async () => {
        config.recorder ||= {};
        config.recorder.noise_gate = defaults.recorder?.noise_gate ?? true;
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.recorder?.noise_gate ?? true) === (defaults.recorder?.noise_gate ?? true),
      sub: 'Silenzia il microfono durante le pause per eliminare ronzii, respiro o rumori della stanza.'
    });

    const GATE_MIN_DB = -80;
    const GATE_MAX_DB = -5;
    const recGateWrap = el('div', 'xra-stack-control');
    const recGateSlider = document.createElement('input');
    recGateSlider.type = 'range';
    recGateSlider.min = String(GATE_MIN_DB);
    recGateSlider.max = String(GATE_MAX_DB);
    recGateSlider.step = '0.5';
    const recGateValue = el('div', 'xra-sub');
    recGateWrap.append(recGateSlider, recGateValue);
    const renderRecGate = () => {
      const val = Number(config.recorder?.gate_threshold_db ?? -48);
      recGateSlider.value = String(Math.max(GATE_MIN_DB, Math.min(GATE_MAX_DB, val)));
      recGateValue.textContent = `${Number(recGateSlider.value).toFixed(1)} dB`;
    };
    bindRefresh(renderRecGate);
    recGateSlider.oninput = () => {
      config.recorder ||= {};
      config.recorder.gate_threshold_db = Number(recGateSlider.value);
      recGateValue.textContent = `${Number(recGateSlider.value).toFixed(1)} dB`;
    };
    recGateSlider.onchange = async () => {
      config.recorder ||= {};
      config.recorder.gate_threshold_db = Number(recGateSlider.value);
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Recording gate threshold', recGateWrap, {
      reset: async () => {
        config.recorder ||= {};
        config.recorder.gate_threshold_db = defaults.recorder?.gate_threshold_db ?? -48;
        renderRecGate();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.recorder?.gate_threshold_db ?? -48) === (defaults.recorder?.gate_threshold_db ?? -48),
      sub: 'Soglia in dB per il passaggio voce. Rappresentata dalla linea arancione 🟠 sul VU-meter.'
    });

    const gateCalibrateBtn = button('🎚 Calibra rumore stanza (3s)');
    const gateCalInfo = el('div', 'xra-sub');
    bindRefresh(() => {
      const floor = Number(config.recorder?.gate_noise_floor_db);
      const thresh = Number(config.recorder?.gate_threshold_db);
      gateCalInfo.textContent = Number.isFinite(floor)
        ? `Rumore stanza: ${floor.toFixed(1)} dB (Soglia auto: ${Number.isFinite(thresh) ? thresh.toFixed(1) : (floor + 5).toFixed(1)} dB)`
        : 'Resta in silenzio per 3 secondi per calibrare.';
    });
    gateCalibrateBtn.onclick = async () => {
      gateCalibrateBtn.disabled = true;
      try {
        const result = await XRA.recorder.calibrateNoiseGate(3);
        gateCalInfo.textContent = `Rumore fondo ${result.noise_floor_db.toFixed(1)} dB → Soglia ${result.threshold_db.toFixed(1)} dB`;
        XRA.toast(`Noise Gate calibrato a ${result.threshold_db.toFixed(1)} dB (rumore: ${result.noise_floor_db.toFixed(1)} dB)`, 'success');
        refreshAll();
      } catch (e) {
        XRA.toast('Calibrazione fallita: ' + e.message, 'error', 4500);
      } finally {
        gateCalibrateBtn.disabled = false;
      }
    };
    const calWrap = el('div', 'xra-stack-control');
    calWrap.append(gateCalibrateBtn, gateCalInfo);
    row(box.body, 'Auto-calibrate gate threshold', calWrap, {
      sub: 'Misura il rumore di fondo della stanza e imposta automaticamente la soglia ideale.'
    });

    // --- Indicatore di livello unificato ---
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
      isDefault: () => !!config.lip.meter_visible === !!defaults.lip.meter_visible,
      sub: 'Unico indicatore di livello audio per verificare in tempo reale il volume e le soglie di attivazione.'
    });

    const meter = el('div', 'xra-meter');
    const fill = el('div', 'xra-meter-fill'); fill.dataset.xra = 'meter-fill';
    const gateLip = el('div', 'xra-meter-gate');
    gateLip.dataset.xra = 'meter-gate-lip';
    gateLip.style.background = '#48bb78';
    gateLip.style.zIndex = '2';
    gateLip.title = 'Soglia Lip-sync';

    const gateRec = el('div', 'xra-meter-gate');
    gateRec.dataset.xra = 'meter-gate-rec';
    gateRec.style.background = '#ed8936';
    gateRec.style.zIndex = '3';
    gateRec.title = 'Soglia Noise Gate REC';

    meter.append(fill, gateLip, gateRec);

    const meterLegend = el('div', 'xra-sub');
    meterLegend.dataset.xra = 'meter-legend';
    meterLegend.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;margin:3px 0 8px;';
    meterLegend.innerHTML = '<span>🟢 Lip-sync</span><span>🟠 Gate REC</span>';

    box.body.append(meter, meterLegend);

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
    });
    adaptiveSmooth.onchange = async () => {
      config.tracking ||= {}; config.tracking.adaptive_smoothing = adaptiveSmooth.checked;
      await XRA.profileService.save();
      refreshAll();
    };
    row(advanced.body, 'Adaptive smoothing', adaptiveSmooth, {
      sub: 'Adds extra torso rotation smoothing when movement is small. It does not alter hips translation.'
    });
    trackingSlider(advanced.body, 'Adaptive smoothing strength', 'adaptive_smoothing_strength',
      { min: 0, max: 100, step: 1, scale: 100, suffix: '%', defaultValue: .45, disabledWhenOff: false });

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

  function installArmsAndHands(parent) {
    const box = details(parent, '🖐️ Arms & Hands');
    const nativeHands = () => nativeCamera()?.handpose || null;

    // 1. Smart arm and hand sync
    const smartArmSync = document.createElement('input');
    smartArmSync.type = 'checkbox';
    bindRefresh(() => {
      smartArmSync.checked = config.tracking?.smart_arm_sync !== false;
    });
    smartArmSync.onchange = async () => {
      config.tracking ||= {};
      config.tracking.smart_arm_sync = smartArmSync.checked;
      XRA.performance?.sendConfidenceThresholds?.();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Smart arm and hand sync', smartArmSync, {
      reset: async () => {
        config.tracking ||= {};
        config.tracking.smart_arm_sync = defaults.tracking?.smart_arm_sync !== false;
        XRA.performance?.sendConfidenceThresholds?.();
      },
      isDefault: () => (config.tracking?.smart_arm_sync !== false) === (defaults.tracking?.smart_arm_sync !== false),
      sub: 'Naturally aligns forearm and hands downwards in a realistic neutral rest pose, and extends arms when raised even without visible fingers.'
    });

    // 2. Desk wrist occlusion guard
    const deskWristGuard = document.createElement('input');
    deskWristGuard.type = 'checkbox';
    bindRefresh(() => {
      deskWristGuard.checked = config.tracking?.desk_wrist_guard !== false;
    });
    deskWristGuard.onchange = async () => {
      config.tracking ||= {};
      config.tracking.desk_wrist_guard = deskWristGuard.checked;
      XRA.performance?.sendConfidenceThresholds?.();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Desk wrist occlusion guard', deskWristGuard, {
      reset: async () => {
        config.tracking ||= {};
        config.tracking.desk_wrist_guard = defaults.tracking?.desk_wrist_guard !== false;
        XRA.performance?.sendConfidenceThresholds?.();
      },
      isDefault: () => (config.tracking?.desk_wrist_guard !== false) === (defaults.tracking?.desk_wrist_guard !== false),
      sub: 'Filters phantom wrists when hands are covered by the desk or out of frame, preventing forearms from staying locked.'
    });

    // 3. Desk arm steady hold
    const armSteadyHold = document.createElement('input');
    armSteadyHold.type = 'checkbox';
    bindRefresh(() => {
      armSteadyHold.checked = !!config.tracking?.arm_steady_hold;
    });
    armSteadyHold.onchange = async () => {
      config.tracking ||= {};
      config.tracking.arm_steady_hold = armSteadyHold.checked;
      XRA.performance?.sendConfidenceThresholds?.();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Desk arm steady hold', armSteadyHold, {
      reset: async () => {
        config.tracking ||= {};
        config.tracking.arm_steady_hold = !!defaults.tracking?.arm_steady_hold;
        XRA.performance?.sendConfidenceThresholds?.();
      },
      isDefault: () => !!config.tracking?.arm_steady_hold === !!defaults.tracking?.arm_steady_hold,
      sub: 'Keeps forearms anchored and visible while elbows and shoulders remain still at the desk. Releases naturally when moving elbows.'
    });

    // 4. Optional CPU hand-only recovery after a confirmed Holistic dropout
    const handRecovery = document.createElement('input');
    handRecovery.type = 'checkbox';
    bindRefresh(() => {
      handRecovery.checked = !!config.tracking?.python_hand_recovery;
    });
    handRecovery.onchange = async () => {
      config.tracking ||= {};
      config.tracking.python_hand_recovery = handRecovery.checked;
      XRA.performance?.sendConfidenceThresholds?.();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Hand recovery', handRecovery, {
      reset: async () => {
        config.tracking ||= {};
        config.tracking.python_hand_recovery = !!defaults.tracking?.python_hand_recovery;
        XRA.performance?.sendConfidenceThresholds?.();
      },
      isDefault: () => !!config.tracking?.python_hand_recovery === !!defaults.tracking?.python_hand_recovery,
      sub: 'When a wrist is lost, periodically runs a full-frame hand search instead of waiting for body tracking.'
    });

    // 5. Arm stabilization (select: Off, Upper-body mocap, On)
    const armStab = select([[0, 'Off'], [1, 'Upper-body mocap'], [2, 'On']]);
    bindRefresh(() => {
      const guardMode = String(config.tracking?.guard_mode || '').toLowerCase();
      const configuredVal = Number(nativeHands()?.stabilize_arm ?? config.tracking?.stabilize_arm ?? 2);
      // Display the effective runtime value without writing to config:
      // If user has it ON (2) and we're in upper-body mode, show "Upper-body mocap" (1)
      const displayVal = (configuredVal === 2 && (guardMode === 'guard' || guardMode === 'desk')) ? 1 : configuredVal;
      armStab.value = String(displayVal);
    });
    armStab.onchange = async () => {
      const val = Number(armStab.value);
      const h = nativeHands(); if (h) h.stabilize_arm = val;
      config.tracking ||= {}; config.tracking.stabilize_arm = val;
      const mm = window.MMD_SA?.MMD?.motionManager;
      if (mm?.para_SA?.motion_tracking?.hand_tracking) {
        mm.para_SA.motion_tracking.hand_tracking.stabilize_arm_disabled = !val;
      }
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Arm stabilization', armStab, {
      reset: async () => {
        const h = nativeHands(); if (h) h.stabilize_arm = 0;
        if (config.tracking) config.tracking.stabilize_arm = 0;
        const mm = window.MMD_SA?.MMD?.motionManager;
        if (mm?.para_SA?.motion_tracking?.hand_tracking) {
          mm.para_SA.motion_tracking.hand_tracking.stabilize_arm_disabled = true;
        }
      },
      isDefault: () => Number(nativeHands()?.stabilize_arm ?? config.tracking?.stabilize_arm ?? 2) === 2,
      sub: 'Stabilizes arm movement and extension based on body kinematics.'
    });

    // 5. Time to stabilize (select: 0, 1 frame, 100 ms, 200 ms)
    const armStabTime = select([[0, '0'], [1, '1 frame'], [100, '100 ms'], [200, '200 ms']]);
    bindRefresh(() => {
      armStabTime.value = String(nativeHands()?.stabilize_arm_time ?? config.tracking?.stabilize_arm_time ?? 0);
    });
    armStabTime.onchange = async () => {
      const val = Number(armStabTime.value);
      const h = nativeHands(); if (h) h.stabilize_arm_time = val;
      config.tracking ||= {}; config.tracking.stabilize_arm_time = val;
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Time to stabilize', armStabTime, {
      reset: async () => {
        const h = nativeHands(); if (h) h.stabilize_arm_time = 0;
        if (config.tracking) config.tracking.stabilize_arm_time = 0;
      },
      isDefault: () => Number(nativeHands()?.stabilize_arm_time ?? config.tracking?.stabilize_arm_time ?? 0) === 0,
      sub: 'Response time or latency window to apply arm stabilization.'
    });

  }

  function installObjectTracking(parent) {
    const box = details(parent, '🎯 Webcam Prop Tracking (AI) / AR Props');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    bindRefresh(() => {
      toggle.checked = !!config.object_tracking?.enabled;
    });
    toggle.onchange = async () => {
      config.object_tracking ||= {};
      config.object_tracking.enabled = toggle.checked;
      XRA.stage?.setObjectTrackingEnabled?.(toggle.checked);
      XRA.xraBackend?.setObjectDetection(toggle.checked, {
        interval_ms: config.object_tracking.interval_ms ?? 350,
        min_score: config.object_tracking.min_score ?? 0.45,
      });
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Enable prop tracking', toggle, {
      reset: async () => {
        config.object_tracking ||= {};
        config.object_tracking.enabled = false;
        XRA.stage?.setObjectTrackingEnabled?.(false);
      },
      isDefault: () => !config.object_tracking?.enabled,
      sub: 'Detects real-world objects in your hands (phone, cup, microphone) and automatically binds 3D props to avatar hands. Zero cost when disabled.'
    });

    const confWrap = el('div', 'xra-stack-control');
    const confInput = document.createElement('input');
    confInput.type = 'range'; confInput.min = '0.20'; confInput.max = '0.90'; confInput.step = '0.01';
    const confText = el('div', 'xra-sub');
    confWrap.append(confInput, confText);
    bindRefresh(() => {
      const v = Number(config.object_tracking?.min_score ?? 0.45);
      confInput.value = String(v);
      confText.textContent = `Confidence: ${(v * 100).toFixed(0)}%`;
    });
    confInput.oninput = () => {
      config.object_tracking ||= {};
      config.object_tracking.min_score = Number(confInput.value);
      confText.textContent = `Confidence: ${(config.object_tracking.min_score * 100).toFixed(0)}%`;
    };
    confInput.onchange = async () => {
      XRA.xraBackend?.setObjectDetection(config.object_tracking?.enabled, {
        min_score: config.object_tracking.min_score,
      });
      await XRA.profileService.save();
    };
    row(box.body, 'Detection confidence', confWrap, {
      reset: async () => {
        config.object_tracking ||= {};
        config.object_tracking.min_score = 0.45;
      },
      isDefault: () => Number(config.object_tracking?.min_score ?? 0.45) === 0.45,
      sub: 'Higher threshold avoids false positives; lower threshold makes items easier to acquire.'
    });

    const intervalSelect = select([
      ['200', 'Fast (200 ms · ~5 FPS)'],
      ['350', 'Balanced (350 ms · ~3 FPS)'],
      ['500', 'Eco (500 ms · 2 FPS)'],
      ['1000', 'Minimal (1000 ms · 1 FPS)'],
    ]);
    bindRefresh(() => {
      intervalSelect.value = String(config.object_tracking?.interval_ms ?? 350);
    });
    intervalSelect.onchange = async () => {
      config.object_tracking ||= {};
      config.object_tracking.interval_ms = Number(intervalSelect.value);
      XRA.xraBackend?.setObjectDetection(config.object_tracking?.enabled, {
        interval_ms: config.object_tracking.interval_ms,
      });
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Scan interval', intervalSelect, {
      reset: async () => {
        config.object_tracking ||= {};
        config.object_tracking.interval_ms = 350;
      },
      isDefault: () => Number(config.object_tracking?.interval_ms ?? 350) === 350,
      sub: 'Controls background AI scans. A slower interval reduces CPU contention with mocap.'
    });

    const statusRow = el('div', 'xra-sub');
    statusRow.style.padding = '8px 12px';
    statusRow.style.marginTop = '6px';
    statusRow.style.background = 'rgba(255,255,255,0.05)';
    statusRow.style.borderRadius = '4px';
    statusRow.innerHTML = 'Anti-drop hold active: AI props stay in hand until lowered to desk.';
    box.body.appendChild(statusRow);

    const resetBtn = button('↺ Reset props to desk');
    resetBtn.style.marginTop = '8px';
    resetBtn.onclick = () => {
      XRA.stage?.resetAllProps?.();
      XRA.toast('Props returned to desk');
    };
    box.body.appendChild(resetBtn);

    const gripBox = details(box.body, '🖐️ AR Props & Calibration');
    gripBox.details.style.marginTop = '8px';

    const uploadPropBtn = button('+ Importa oggetto 3D (.glb / .gltf)', 'xra-action');
    uploadPropBtn.style.marginBottom = '12px';
    uploadPropBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.glb,.gltf';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const body = new Uint8Array(await file.arrayBuffer());
          const res = await fetch(`/__xra_prop?filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            body: body,
            headers: { 'Content-Length': String(body.byteLength) }
          });
          const json = await res.json();
          if (json.ok) {
            XRA.toast('Oggetto 3D caricato con successo', 'success');
            await refreshPropSelect();
            const key = json.filename.replace(/\.(glb|gltf)$/i, '');
            propSelect.value = key;
            await XRA.stage?.loadProp?.(key, `props/${json.filename}`);
            syncGripInputs();
          } else throw new Error(json.error);
        } catch(err) {
          XRA.toast('Errore caricamento: ' + err.message, 'error', 5000);
        }
      };
      input.click();
    };
    gripBox.body.appendChild(uploadPropBtn);

    const propSelect = select([]);
    row(gripBox.body, 'Prop to adjust', propSelect);

    async function refreshPropSelect() {
      const files = await XRA.stage?.listProps?.(true) || [];
      const current = propSelect.value;
      propSelect.innerHTML = '';
      const CLASS_TO_PROP = {
        'cell_phone': 'Smartphone', 'cup': 'Cup', 'microphone': 'Microphone',
        'bottle': 'Bottle', 'book': 'Book', 'knife': 'Knife', 'fork': 'Fork',
        'spoon': 'Spoon', 'scissors': 'Scissors', 'apple': 'Apple',
        'orange': 'Orange', 'banana': 'Banana', 'donut': 'Donut',
        'mouse': 'Mouse', 'laptop': 'Laptop', 'toothbrush': 'Toothbrush', 'vase': 'Vase'
      };
      for (const file of files) {
        const key = file.replace(/^props\//, '').replace(/\.(glb|gltf)$/i, '');
        const label = CLASS_TO_PROP[key] || key;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = label;
        propSelect.appendChild(opt);
      }
      if ([...propSelect.options].some(o => o.value === current)) propSelect.value = current;
      else if (propSelect.options.length) propSelect.selectedIndex = 0;
      syncGripInputs();
    }

    // Call once when panel renders
    setTimeout(refreshPropSelect, 500);

    const manualAttachSelect = select([
      ['auto', 'Auto (AI detection)'],
      ['right', 'Right Hand'],
      ['left', 'Left Hand'],
      ['desk', 'Static (On desk)'],
      ['hidden', 'Hidden']
    ]);
    row(gripBox.body, 'Manual attachment', manualAttachSelect, {
      sub: 'Forza la posizione dell\'oggetto ignorando l\'IA.'
    });

    const aiTriggerSelect = select([
      ['none', 'Default / None'],
      ['cell_phone', 'AI: Smartphone'],
      ['cup', 'AI: Cup'],
      ['microphone', 'AI: Microphone'],
      ['bottle', 'AI: Bottle'],
      ['book', 'AI: Book'],
      ['knife', 'AI: Knife'],
      ['fork', 'AI: Fork'],
      ['spoon', 'AI: Spoon'],
      ['scissors', 'AI: Scissors'],
      ['apple', 'AI: Apple'],
      ['orange', 'AI: Orange'],
      ['banana', 'AI: Banana'],
      ['donut', 'AI: Donut'],
      ['mouse', 'AI: Mouse'],
      ['laptop', 'AI: Laptop'],
      ['toothbrush', 'AI: Toothbrush'],
      ['vase', 'AI: Vase']
    ]);
    row(gripBox.body, 'Map to AI object', aiTriggerSelect, {
      sub: 'Quando la webcam rileva questo oggetto, verrà mostrato il prop selezionato (utile per oggetti custom).'
    });

    const posXWrap = el('div', 'xra-stack-control');
    const posXInput = document.createElement('input');
    posXInput.type = 'range'; posXInput.min = '-50.0'; posXInput.max = '50.0'; posXInput.step = '0.5';
    const posXText = el('div', 'xra-sub');
    posXWrap.append(posXInput, posXText);

    const posYWrap = el('div', 'xra-stack-control');
    const posYInput = document.createElement('input');
    posYInput.type = 'range'; posYInput.min = '-50.0'; posYInput.max = '50.0'; posYInput.step = '0.5';
    const posYText = el('div', 'xra-sub');
    posYWrap.append(posYInput, posYText);

    const posZWrap = el('div', 'xra-stack-control');
    const posZInput = document.createElement('input');
    posZInput.type = 'range'; posZInput.min = '-50.0'; posZInput.max = '50.0'; posZInput.step = '0.5';
    const posZText = el('div', 'xra-sub');
    posZWrap.append(posZInput, posZText);

    const rotXWrap = el('div', 'xra-stack-control');
    const rotXInput = document.createElement('input');
    rotXInput.type = 'range'; rotXInput.min = '-180'; rotXInput.max = '180'; rotXInput.step = '1';
    const rotXText = el('div', 'xra-sub');
    rotXWrap.append(rotXInput, rotXText);

    const rotYWrap = el('div', 'xra-stack-control');
    const rotYInput = document.createElement('input');
    rotYInput.type = 'range'; rotYInput.min = '-180'; rotYInput.max = '180'; rotYInput.step = '1';
    const rotYText = el('div', 'xra-sub');
    rotYWrap.append(rotYInput, rotYText);

    const rotZWrap = el('div', 'xra-stack-control');
    const rotZInput = document.createElement('input');
    rotZInput.type = 'range'; rotZInput.min = '-180'; rotZInput.max = '180'; rotZInput.step = '1';
    const rotZText = el('div', 'xra-sub');
    rotZWrap.append(rotZInput, rotZText);

    const scaleWrap = el('div', 'xra-stack-control');
    const scaleInput = document.createElement('input');
    scaleInput.type = 'range'; scaleInput.min = '0.2'; scaleInput.max = '3.0'; scaleInput.step = '0.05';
    const scaleText = el('div', 'xra-sub');
    scaleWrap.append(scaleInput, scaleText);

    function syncGripInputs() {
      const pKey = propSelect.value;
      if (!pKey) return;
      const g = config.object_tracking?.grip?.[pKey] || {};
      const ma = config.object_tracking?.manual_attach?.[pKey] || 'auto';
      manualAttachSelect.value = ma;
      const trig = config.object_tracking?.ai_trigger?.[pKey] || 'none';
      aiTriggerSelect.value = trig;
      
      posXInput.value = String(g.pos_x ?? 0);
      posXText.textContent = `Offset X (along palm): ${Number(posXInput.value).toFixed(1)} cm`;
      posYInput.value = String(g.pos_y ?? 0);
      posYText.textContent = `Offset Y (up / down): ${Number(posYInput.value).toFixed(1)} cm`;
      posZInput.value = String(g.pos_z ?? 0);
      posZText.textContent = `Offset Z (forward / back): ${Number(posZInput.value).toFixed(1)} cm`;
      
      rotXInput.value = String(g.rot_x ?? 0);
      rotXText.textContent = `Pitch (X): ${Number(rotXInput.value).toFixed(0)}°`;
      rotYInput.value = String(g.rot_y ?? 0);
      rotYText.textContent = `Yaw (Y): ${Number(rotYInput.value).toFixed(0)}°`;
      rotZInput.value = String(g.rot_z ?? 0);
      rotZText.textContent = `Roll (Z): ${Number(rotZInput.value).toFixed(0)}°`;
      
      scaleInput.value = String(g.scale ?? 1.0);
      scaleText.textContent = `Scale: ${Number(scaleInput.value).toFixed(2)}x`;
    }

    bindRefresh(syncGripInputs);
    propSelect.onchange = syncGripInputs;

    function applyGripTweak() {
      const pKey = propSelect.value;
      if (!pKey) return;
      config.object_tracking ||= {};
      config.object_tracking.grip ||= {};
      config.object_tracking.manual_attach ||= {};
      
      config.object_tracking.manual_attach[pKey] = manualAttachSelect.value;
      config.object_tracking.ai_trigger ||= {};
      config.object_tracking.ai_trigger[pKey] = aiTriggerSelect.value;
      config.object_tracking.grip[pKey] = {
        pos_x: Number(posXInput.value),
        pos_y: Number(posYInput.value),
        pos_z: Number(posZInput.value),
        rot_x: Number(rotXInput.value),
        rot_y: Number(rotYInput.value),
        rot_z: Number(rotZInput.value),
        scale: Number(scaleInput.value),
      };
      syncGripInputs();
      XRA.stage?.updateGripTransforms?.();
    }

    manualAttachSelect.onchange = applyGripTweak;
    posXInput.oninput = applyGripTweak;
    posYInput.oninput = applyGripTweak;
    posZInput.oninput = applyGripTweak;
    rotXInput.oninput = applyGripTweak;
    rotYInput.oninput = applyGripTweak;
    rotZInput.oninput = applyGripTweak;
    scaleInput.oninput = applyGripTweak;

    const saveGrip = async () => { await XRA.profileService.save(); };
    manualAttachSelect.addEventListener('change', saveGrip);
    aiTriggerSelect.addEventListener('change', applyGripTweak);
    aiTriggerSelect.addEventListener('change', saveGrip);
    posXInput.onchange = saveGrip;
    posYInput.onchange = saveGrip;
    posZInput.onchange = saveGrip;
    rotXInput.onchange = saveGrip;
    rotYInput.onchange = saveGrip;
    rotZInput.onchange = saveGrip;
    scaleInput.onchange = saveGrip;

    row(gripBox.body, 'Offset X', posXWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].pos_x = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.pos_x ?? 0) === 0,
      sub: 'Trasla oggetto sull\'asse X'
    });
    row(gripBox.body, 'Offset Y', posYWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].pos_y = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.pos_y ?? 0) === 0,
      sub: 'Trasla oggetto sull\'asse Y'
    });
    row(gripBox.body, 'Offset Z', posZWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].pos_z = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.pos_z ?? 0) === 0,
      sub: 'Trasla oggetto sull\'asse Z'
    });
    row(gripBox.body, 'Pitch (X)', rotXWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].rot_x = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.rot_x ?? 0) === 0,
      sub: 'Ruota oggetto sull\'asse X'
    });
    row(gripBox.body, 'Yaw (Y)', rotYWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].rot_y = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.rot_y ?? 0) === 0,
      sub: 'Ruota oggetto sull\'asse Y'
    });
    row(gripBox.body, 'Roll (Z)', rotZWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].rot_z = 0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.rot_z ?? 0) === 0,
      sub: 'Ruota oggetto sull\'asse Z'
    });
    row(gripBox.body, 'Scale', scaleWrap, {
      reset: async () => {
        const pKey = propSelect.value;
        if (config.object_tracking?.grip?.[pKey]) config.object_tracking.grip[pKey].scale = 1.0;
        syncGripInputs();
        XRA.stage?.updateGripTransforms?.();
        await saveGrip();
      },
      isDefault: () => (config.object_tracking?.grip?.[propSelect.value]?.scale ?? 1.0) === 1.0,
      sub: 'Modifica la dimensione dell\'oggetto'
    });
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

    const perfAdvanced = details(box.body, 'Advanced', { open: true });

    // -------------------------------------------------------------------------
    // 1. 📹 Acquisizione Webcam
    // -------------------------------------------------------------------------
    const secWebcam = details(perfAdvanced.body, '📹 Webcam Capture', { open: true });

    const OPTIMAL_RESOLUTIONS = [
      ['640x360', '640×360 (Consigliata · 30 FPS fluidi)'],
      ['640x480', '640×480 (Formato standard 4:3)'],
      ['1280x720', '1280×720 (HD 720p · Alta precisione)']
    ];

    const res = select(OPTIMAL_RESOLUTIONS);
    const updateDynamicResolutions = () => {
      const snap = XRA.xraBackend?.snapshot?.();
      const hwCam = snap?.hardware?.camera || snap?.capture?.hardware?.camera;
      const supported = hwCam?.supported_resolutions;
      let opts = [];
      if (Array.isArray(supported) && supported.length > 0) {
        // Filter out extreme sub-mocap (<300p) or saturating (>1080p) resolutions, keeping all valid hardware modes
        const valid = supported.filter(([w, h]) => w >= 480 && h >= 300 && w <= 1920 && h <= 1080);
        const list = valid.length > 0 ? valid : supported;
        const sorted = [...list].sort((a, b) => (a[0] * a[1]) - (b[0] * b[1]));
        opts = sorted.map(([w, h]) => {
          const key = `${w}x${h}`;
          let label = `${w}×${h}`;
          if (w === 640 && h === 360) label += ' (Consigliata · 30 FPS fluidi)';
          else if (w === 640 && h === 480) label += ' (Formato standard 4:3)';
          else if (w === 1280 && h === 720) label += ' (HD 720p · Alta precisione)';
          else if (w >= 1920) label += ' (Full HD 1080p · Pesante)';
          return [key, label];
        });
      } else {
        opts = OPTIMAL_RESOLUTIONS;
      }
      const existingKeys = [...res.options].map(o => o.value).join(',');
      const newKeys = opts.map(o => o[0]).join(',');
      if (existingKeys !== newKeys) {
        res.innerHTML = '';
        for (const [v, l] of opts) {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = l;
          res.appendChild(opt);
        }
      }
      const current = `${config.camera.width}x${config.camera.height}`;
      res.value = [...res.options].some(o => o.value === current) ? current : (res.options[0]?.value || '640x360');
    };
    bindRefresh(updateDynamicResolutions);

    res.onchange = async () => {
      const [w, h] = res.value.split('x').map(Number);
      config.camera.width = w;
      config.camera.height = h;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secWebcam.body, 'Webcam resolution', res, {
      reset: async () => {
        config.camera.width = defaults.camera.width;
        config.camera.height = defaults.camera.height;
        XRA.performance.apply();
      },
      isDefault: () => config.camera.width === defaults.camera.width && config.camera.height === defaults.camera.height,
      sub: 'Risoluzione hardware della webcam. Valori selezionati vengono applicati direttamente al sensore.'
    });

    const inferRes = select([
      ['native', 'Nativa (uguale alla webcam)'],
      ['640x360', '640×360 (Consigliata per iGPU/CPU)'],
      ['512x288', '512×288 (Ultra-leggera · Basso consumo CPU)'],
      ['424x240', '424×240 (Massimo risparmio CPU · Sistemi leggeri)'],
      ['640x480', '640×480 (Formato standard 4:3)']
    ]);
    inferRes.value = String(config.performance?.infer_mode || 'native');
    inferRes.onchange = async () => {
      if (!config.performance) config.performance = {};
      config.performance.infer_mode = inferRes.value;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secWebcam.body, 'MediaPipe AI resolution', inferRes, {
      reset: async () => {
        if (!config.performance) config.performance = {};
        config.performance.infer_mode = defaults.performance?.infer_mode || 'native';
        XRA.performance.apply();
      },
      isDefault: () => (config.performance?.infer_mode || 'native') === (defaults.performance?.infer_mode || 'native'),
      sub: 'Risoluzione elaborata dal motore MediaPipe. Valori ridotti (es. 640×360) risparmiano fino al 65% di CPU.'
    });

    const frameSkip = document.createElement('input'); frameSkip.type = 'checkbox';
    bindRefresh(() => { frameSkip.checked = !!config.performance?.adaptive_frame_skip; });
    frameSkip.onchange = async () => {
      config.performance ||= {};
      config.performance.adaptive_frame_skip = frameSkip.checked;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
    };
    row(secWebcam.body, 'Skip frames on overload', frameSkip, {
      sub: 'If inference spikes past the frame deadline, reuses the previous pose for 1 frame to prevent queue buildup.'
    });

    const headroom = select([
      [1.0, 'Maximum smoothness (no limit)'],
      [1.25, 'Balanced — 25% thermal margin (recommended)'],
      [1.5, 'Power saving — 50% thermal margin (low-spec systems)'],
    ]);
    bindRefresh(() => { headroom.value = String(config.performance?.inference_headroom ?? 1.0); });
    headroom.onchange = async () => {
      config.performance ||= {};
      config.performance.inference_headroom = Number(headroom.value);
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
    };
    row(secWebcam.body, 'Thermal headroom', headroom, {
      reset: async () => {
        if (!config.performance) config.performance = {};
        config.performance.inference_headroom = 1.0;
        XRA.performance.apply();
      },
      isDefault: () => (config.performance?.inference_headroom ?? 1.0) === 1.0,
      sub: 'Leaves headroom above average inference time to prevent thermal throttling. "Balanced" reduces heat spikes with no visual impact on rendering.'
    });

    const cpuAffinity = document.createElement('input'); cpuAffinity.type = 'checkbox';
    bindRefresh(() => { cpuAffinity.checked = config.performance?.cpu_affinity !== false; });
    cpuAffinity.onchange = async () => {
      config.performance ||= {};
      config.performance.cpu_affinity = cpuAffinity.checked;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
    };
    row(secWebcam.body, 'CPU affinity optimization', cpuAffinity, {
      sub: 'Binds MediaPipe to performance cores on Linux, eliminating latency spikes from E-cores or hyper-threading.'
    });

    const fps = select([[20, '20 FPS'], [24, '24 FPS'], [30, '30 FPS']]);
    let webcamFpsRow = null;
    const updateDynamicFps = () => {
      const snap = XRA.xraBackend?.snapshot?.();
      const hwCam = snap?.hardware?.camera || snap?.capture?.hardware?.camera;
      const maxHwFps = Math.max(15, Number(hwCam?.max_hardware_fps || 30));
      const candidates = [15, 20, 24, 30, 60, 90].filter(f => f <= maxHwFps);
      const existingKeys = [...fps.options].map(o => o.value).join(',');
      const newKeys = candidates.join(',');
      if (existingKeys !== newKeys) {
        fps.innerHTML = '';
        for (const f of candidates) {
          const opt = document.createElement('option');
          opt.value = String(f);
          opt.textContent = `${f} FPS` + (f === maxHwFps ? ' (Max Hardware)' : '');
          fps.appendChild(opt);
        }
      }
      if (Number(config.camera.fps) > maxHwFps) {
        config.camera.fps = maxHwFps;
      }
      fps.value = String(config.camera.fps);
      if (webcamFpsRow) webcamFpsRow.hidden = XRA.xraBackend?.active === true;
    };
    bindRefresh(updateDynamicFps);

    fps.onchange = async () => {
      config.camera.fps = Number(fps.value);
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    webcamFpsRow = row(secWebcam.body, 'Webcam FPS', fps, {
      reset: async () => { config.camera.fps = defaults.camera.fps; XRA.performance.apply(); },
      isDefault: () => Number(config.camera.fps) === defaults.camera.fps
    });

    const cameraTelemetry = el('div', 'xra-sub');
    cameraTelemetry.style.margin = '4px 0 10px 12px';
    cameraTelemetry.style.fontSize = '11px';
    cameraTelemetry.style.color = '#a0aec0';
    bindRefresh(() => {
      const snap = XRA.xraBackend?.snapshot?.();
      const cap = snap?.capture || {};
      const reqFps = Math.round(Number(config.performance?.pose_fps || cap.target_fps || 30));
      const cameraMeasuredFps = Number(cap.camera_measured_fps || 0);
      const cameraNegotiatedFps = Number(cap.camera_negotiated_fps || 0);
      const cameraFps = Number(cameraMeasuredFps || cameraNegotiatedFps || 0);
      const budgetFps = Number(cap.effective_fps || cap.target_fps || 0);
      const cameraMismatch = cameraMeasuredFps > 0 && cameraNegotiatedFps > 0 &&
        cameraMeasuredFps < cameraNegotiatedFps * 0.70;
      const cameraText = cameraFps > 0
        ? `${cameraFps.toFixed(1)}${cameraMismatch ? ` (negoziati ${cameraNegotiatedFps.toFixed(1)})` : ''}`
        : '—';
      const budgetText = budgetFps > 0 ? budgetFps.toFixed(1) : '—';
      const measFps = Number(cap.measured_fps) > 0 ? Number(cap.measured_fps).toFixed(1) : '—';
      const resStr = cap.capture_geometry && cap.capture_geometry[0] ? ` · Hardware: ${cap.capture_geometry[0]}×${cap.capture_geometry[1]}` : '';
      const v4l2 = cap.v4l2_optimization || {};
      const v4l2Text = v4l2.reason === 'tool_missing'
        ? ' · v4l2-ctl assente'
        : (v4l2.reason === 'control_unsupported' ? ' · controllo auto-FPS non supportato' : '');
      cameraTelemetry.textContent = `Target: ${reqFps} FPS · Camera: ${cameraText} FPS · Budget: ${budgetText} FPS · Tracking: ${measFps} FPS${resStr}${v4l2Text}`;
      cameraTelemetry.title = [
        cameraNegotiatedFps ? `Camera negotiated: ${cameraNegotiatedFps.toFixed(1)} FPS` : '',
        cap.camera_format ? `Format: ${cap.camera_format}` : '',
        v4l2.reason ? `V4L2: ${v4l2.reason}` : '',
      ].filter(Boolean).join(' · ');
    });
    secWebcam.body.appendChild(cameraTelemetry);

    // -------------------------------------------------------------------------
    // 2. 🤖 Motore Tracking (MediaPipe Tasks)
    // -------------------------------------------------------------------------
    const secTracking = details(perfAdvanced.body, '🤖 Tracking Engine (MediaPipe Tasks)', { open: true });

    const pipeline = select([
      ['Full Body', 'Full body'],
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
      try {
        await XRA.performance.setMocapMode(pipeline.value);
      }
      finally { pipeline.disabled = false; refreshAll(); }
    };
    row(secTracking.body, 'Tracking / mocap mode', pipeline, {
      sub: 'Full Body uses native Holistic on CPU, or parallel native Face/Pose/Hands when a GPU is explicitly selected.'
    });

    const hardware = select([
      ['Auto', 'Auto (Stable CPU in Full Body)'],
      ['high-performance', 'Dedicated GPU · Parallel split (Experimental)'],
      ['low-power', 'Integrated GPU · Parallel split (Experimental)'],
      ['cpu', 'CPU · Native Holistic (Stable)']
    ]);

    const updateDynamicHardwareGpus = () => {
      const snap = XRA.xraBackend?.snapshot?.();
      const hwGpus = snap?.hardware?.gpus || snap?.capture?.hardware?.gpus || [];
      const hasDedicated = hwGpus.some(g => g.is_dedicated);
      const isDual = hwGpus.length > 1 && hasDedicated;

      let opts = [];
      if (isDual) {
        const dedicated = hwGpus.find(g => g.is_dedicated);
        const integrated = hwGpus.find(g => !g.is_dedicated);
        opts = [
          ['Auto', 'Auto (Stable CPU in Full Body)'],
          ['high-performance', `Dedicated GPU · Split (${dedicated?.name || 'Dedicated'})`],
          ['low-power', `Integrated GPU · Split (${integrated?.name || 'iGPU'})`],
          ['cpu', 'CPU · Native Holistic (Stable)']
        ];
      } else if (hwGpus.length >= 1) {
        const single = hwGpus[0];
        opts = [
          ['Auto', 'Auto (Stable CPU in Full Body)'],
          ['low-power', `GPU · Split (${single?.name || 'Hardware'})`],
          ['cpu', 'CPU · Native Holistic (Stable)']
        ];
      } else {
        opts = [
          ['Auto', 'Auto (Stable CPU in Full Body)'],
          ['high-performance', 'Dedicated GPU · Parallel split (Experimental)'],
          ['low-power', 'Integrated GPU · Parallel split (Experimental)'],
          ['cpu', 'CPU · Native Holistic (Stable)']
        ];
      }

      const existingKeys = [...hardware.options].map(o => o.value).join(',');
      const newKeys = opts.map(o => o[0]).join(',');
      if (existingKeys !== newKeys) {
        hardware.innerHTML = '';
        for (const [val, label] of opts) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          hardware.appendChild(opt);
        }
      }
      const curPref = String(config.performance?.hardware_mode || config.performance?.ai_gpu_preference || 'Auto');
      hardware.value = [...hardware.options].some(o => o.value === curPref) ? curPref : 'Auto';
    };
    bindRefresh(updateDynamicHardwareGpus);

    hardware.onchange = async () => {
      config.performance = config.performance || {};
      config.performance.hardware_mode = hardware.value;
      config.performance.ai_gpu_preference = hardware.value;
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
      XRA.promptRestart(XRA.i18n?.t?.("Changing the MediaPipe CPU/GPU engine requires restarting the application.") || "Changing the MediaPipe CPU/GPU engine requires restarting the application.");
    };

    const activeHardwareGpuText = () => {
      const snap = XRA.xraBackend?.snapshot?.();
      const name = snap?.gpuName;
      const mode = String(config.performance?.hardware_mode || 'Auto').toLowerCase();
      if (name && name !== 'Unknown GPU' && mode !== 'cpu') {
        return `${XRA.i18n?.t?.('Active GPU') || 'Active GPU'}: ${name}. `;
      }
      return '';
    };

    const isPipelineFace = () => {
      const current = XRA.performance.currentNativeType?.() || pipeline.value || 'Full Body';
      return current === 'Face';
    };

    const hardwareHelpText = () => isPipelineFace()
      ? `${activeHardwareGpuText()}${XRA.i18n?.t?.('Face Only uses native FaceLandmarker on the selected device.') || 'Face Only uses native FaceLandmarker on the selected device.'}`
      : `${activeHardwareGpuText()}${XRA.i18n?.t?.('CPU uses stable native Holistic; iGPU/dGPU use parallel native Face, Pose, and Hands (experimental).') || 'CPU uses stable native Holistic; iGPU/dGPU use parallel native Face, Pose, and Hands (experimental).'}`;

    const rowHardware = row(secTracking.body, 'Hardware Acceleration', hardware, {
      reset: async () => {
        config.performance = config.performance || {};
        config.performance.hardware_mode = 'Auto';
        config.performance.ai_gpu_preference = 'Auto';
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
        XRA.promptRestart(XRA.i18n?.t?.("Resetting the MediaPipe engine requires restarting the application.") || "Resetting the MediaPipe engine requires restarting the application.");
      },
      isDefault: () => (config.performance?.hardware_mode || 'Auto') === 'Auto',
      sub: hardwareHelpText()
    });

    bindRefresh(() => {
      const sub = rowHardware.querySelector?.('.xra-sub');
      if (sub) {
        sub.textContent = hardwareHelpText();
      }
    });

    XRA.events?.on?.('backend_status_changed', (msg) => {
      const sub = rowHardware.querySelector?.('.xra-sub');
      if (sub) {
        sub.textContent = hardwareHelpText();
      }
      if (msg && msg.gpuAvailable === false) {
        for (const opt of hardware.options) {
          if (opt.value !== 'cpu') opt.disabled = true;
        }
        hardware.parentElement.title = "L'accelerazione GPU non è supportata dal sistema host.";
      } else {
        for (const opt of hardware.options) {
          opt.disabled = false;
        }
        hardware.parentElement.title = "";
      }
      if (msg && msg.hardwareMode && !hardware.value) {
        hardware.value = msg.hardwareMode;
      }
    });

    const backendLabel = (id) => {
      const mode = String(XRA.config?.performance?.tracking_pipeline || '').toUpperCase();
      const isFace = mode === 'FACE';
      const names = {
        'mediapipe-tasks-landmarker': isFace ? 'MediaPipe Tasks Face · native (52 blendshapes)' : 'MediaPipe Tasks Holistic · native (52 blendshapes)',
      };
      return names[id] || id;
    };

    const initialBackend = 'mediapipe-tasks-landmarker';
    const backendStatus = el('div', 'xra-sub', `Backend: ${backendLabel(initialBackend)}`);

    const renderBackendStatus = () => {
      const snapshot = XRA.xraBackend?.snapshot?.();
      if (!snapshot) {
        backendStatus.textContent = 'Backend: non disponibile';
        return;
      }
      if (snapshot.selected === 'mediapipe') {
        backendStatus.textContent = 'Backend: MediaPipe (built-in, WASM) — attivo';
        return;
      }
      const provider = snapshot.providerHuman || snapshot.provider || '—';

      const cap = snapshot.capture || {};
      const frames = Number(snapshot.framesReceived || 0);
      let phase;
      if (!snapshot.connected) phase = 'connessione…';
      else if (!snapshot.ready) phase = 'caricamento modello…';
      else if (cap.running && (cap.available || frames > 0)) phase = 'attivo';
      else if (cap.running) phase = 'camera in avvio…';
      else phase = 'pronto';

      const cam = cap.device ? ` · ${cap.device}` : '';
      const fps = cap.target_fps ? ` · ${Math.round(cap.target_fps)} fps` : '';
      backendStatus.textContent =
        `Backend: ${backendLabel(snapshot.selected)} — ${phase} · ${provider}${cam}${fps}` +
        (cap.last_error ? ` · ${cap.last_error}` : '') +
        (snapshot.lastError ? ` · errore: ${snapshot.lastError}` : '');
    };

    if (XRA.xraBackend?.onStatus) {
      XRA.xraBackend.onStatus(() => { renderBackendStatus(); });
    }
    bindRefresh(() => { renderBackendStatus(); });
    secTracking.body.appendChild(backendStatus);

    const poseHz = select([[15, '15 Hz (Eco)'], [20, '20 Hz (Risparmio CPU)'], [24, '24 Hz (Bilanciato)'], [30, '30 Hz (Consigliato / Max Webcam)'], [60, '60 Hz (Sensori High-FPS)']]);
    bindRefresh(() => { poseHz.value = String(config.performance.pose_fps || 30); });
    poseHz.onchange = async () => {
      config.performance.pose_fps = Number(poseHz.value);
      markCustomPreset();
      XRA.performance.sendInferenceRates();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secTracking.body, 'Tracking inference', poseHz, {
      reset: async () => { config.performance.pose_fps = defaults.performance.pose_fps; XRA.performance.sendInferenceRates(); },
      isDefault: () => Number(config.performance.pose_fps) === defaults.performance.pose_fps,
      sub: 'Frequenza MediaPipe nativa. La webcam USB opera a 30 FPS hardware.'
    });

    function confidenceSlider(parent, labelText, key, defVal = 0.50, min = 30, max = 90, step = 5) {
      const wrap = el('div', 'xra-stack-control');
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
      const text = el('div', 'xra-sub');
      wrap.append(input, text);
      let resetBtn = null;
      const isDefault = () => Math.abs(Number(config.performance?.[key] ?? defVal) - defVal) < 1e-4;
      bindRefresh(() => {
        const val = Number(config.performance?.[key] ?? defVal);
        input.value = String(Math.round(val * 100));
        text.textContent = `${input.value}%`;
        if (resetBtn) resetBtn.disabled = isDefault();
      });
      input.oninput = () => {
        config.performance ||= {};
        config.performance[key] = Number(input.value) / 100;
        text.textContent = `${input.value}%`;
        if (resetBtn) resetBtn.disabled = isDefault();
      };
      input.onchange = async () => {
        config.performance ||= {};
        config.performance[key] = Number(input.value) / 100;
        markCustomPreset();
        XRA.performance.sendConfidenceThresholds?.();
        await XRA.profileService.save();
        refreshAll();
      };
      const r = row(parent, labelText, wrap, {
        reset: async () => {
          config.performance ||= {};
          config.performance[key] = defVal;
          markCustomPreset();
          XRA.performance.sendConfidenceThresholds?.();
          await XRA.profileService.save();
        },
        isDefault,
        sub: `Soglia di confidenza minima (default ${Math.round(defVal * 100)}%). Valori più alti aumentano la stabilità ma richiedono migliore visibilità.`
      });
      resetBtn = r.querySelector('.xra-reset');
      return r;
    }

    const pose = select([
      ['Lite', 'Lite (veloce)'],
      ['Normal', 'Normal (bilanciato)'],
      ['Best', 'Best (alta precisione)']
    ]);
    let qualityRow = null;
    bindRefresh(() => {
      pose.value = config.pose_model || 'Normal';
      if (qualityRow) qualityRow.hidden = XRA.xraBackend?.active === true;
    });
    pose.onchange = async () => {
      config.pose_model = pose.value;
      markCustomPreset();
      XRA.performance.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    qualityRow = row(secTracking.body, 'Tracking quality', pose, {
      reset: async () => { config.pose_model = defaults.pose_model; XRA.performance.apply(); },
      isDefault: () => config.pose_model === defaults.pose_model,
      sub: 'Qualità ed accuratezza del modello di tracking (Lite per CPU leggere, Best per massima precisione).'
    });

    // -------------------------------------------------------------------------
    // Sottosezione: 🎯 Soglie di Confidenza AI
    // -------------------------------------------------------------------------
    const secConfidence = details(secTracking.body, '🎯 AI Confidence Thresholds', { open: false });

    confidenceSlider(secConfidence.body, 'Min joint confidence', 'min_joint_confidence', 0.25, 5, 50, 1);
    confidenceSlider(secConfidence.body, 'Min tracking confidence', 'min_tracking_confidence', 0.50, 30, 90, 5);
    confidenceSlider(secConfidence.body, 'Min pose detection confidence', 'min_pose_confidence', 0.50, 30, 90, 5);
    confidenceSlider(secConfidence.body, 'Min face detection confidence', 'min_face_confidence', 0.50, 30, 90, 5);

    // -------------------------------------------------------------------------
    // 3. 🎮 Rendering Grafico & GPU
    // -------------------------------------------------------------------------
    const secRendering = details(perfAdvanced.body, '🎮 Graphics Rendering & GPU', { open: true });

    const renderFps = select([[30, '30 FPS'], [60, '60 FPS'], [90, '90 FPS'], [120, '120 FPS'], [144, '144 FPS'], [0, 'Unlimited / Monitor']]);
    bindRefresh(() => { renderFps.value = String(config.performance.render_fps ?? 60); });
    renderFps.onchange = async () => {
      config.performance.render_fps = Number(renderFps.value);
      window.XRA_render_fps_limit = config.performance.render_fps;
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secRendering.body, 'Render FPS', renderFps, {
      reset: async () => {
        config.performance.render_fps = defaults.performance.render_fps || 60;
        window.XRA_render_fps_limit = config.performance.render_fps;
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => Number(config.performance.render_fps ?? 60) === (defaults.performance.render_fps || 60),
      sub: 'Limita la frequenza di rendering della viewport 3D per ridurre calore e ventole su monitor ad alto refresh.'
    });

    const renderRes = select([
      ['1080p', '1080p (Full HD · Recommended)'],
      ['720p', '720p (HD · GPU Saving)'],
      ['auto', 'Auto (Display resolution)'],
      ['1440p', '1440p (2K · High resolution)']
    ]);
    bindRefresh(() => { renderRes.value = String(config.performance.render_resolution || '1080p'); });
    renderRes.onchange = async () => {
      config.performance.render_resolution = renderRes.value;
      XRA.performance.applyRenderResolution(renderRes.value);
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secRendering.body, 'Output quality (Render & Rec)', renderRes, {
      reset: async () => {
        config.performance.render_resolution = defaults.performance.render_resolution || '1080p';
        XRA.performance.applyRenderResolution(config.performance.render_resolution);
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.performance.render_resolution || '1080p') === (defaults.performance.render_resolution || '1080p'),
      sub: 'Risoluzione interna del motore 3D e della registrazione. 1080p garantisce il Full HD nativo, 720p riduce drasticamente il consumo della scheda video.'
    });

    const gpuSelect = select([
      ['default', 'Auto / Sistema (default)'],
      ['high-performance', 'Dedicated GPU (High Performance)'],
      ['low-power', 'Integrated GPU (Low Power · iGPU Heat Saving)']
    ]);
    const updateDynamicGpus = () => {
      const snap = XRA.xraBackend?.snapshot?.();
      const hwGpus = snap?.hardware?.gpus || snap?.capture?.hardware?.gpus || [];
      const hasDedicated = hwGpus.some(g => g.is_dedicated);
      const isDual = hwGpus.length > 1 && hasDedicated;

      let opts = [];
      if (isDual) {
        const dedicated = hwGpus.find(g => g.is_dedicated);
        const integrated = hwGpus.find(g => !g.is_dedicated);
        opts = [
          ['default', 'Auto / Sistema (default)'],
          ['high-performance', `GPU Dedicata (${dedicated?.name || 'Dedicata'})`],
          ['low-power', `GPU Integrata (${integrated?.name || 'iGPU · Risparmio calore'})`]
        ];
      } else if (hwGpus.length >= 1) {
        const single = hwGpus[0];
        opts = [
          ['default', `GPU Sistema (${single?.name || 'Standard'})`]
        ];
      } else {
        opts = [
          ['default', 'Auto / Sistema (default)'],
          ['high-performance', 'Dedicated GPU (High Performance)'],
          ['low-power', 'Integrated GPU (Low Power · iGPU Heat Saving)']
        ];
      }
      const existingKeys = [...gpuSelect.options].map(o => o.value).join(',');
      const newKeys = opts.map(o => o[0]).join(',');
      if (existingKeys !== newKeys) {
        gpuSelect.innerHTML = '';
        for (const [val, label] of opts) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          gpuSelect.appendChild(opt);
        }
      }
      const curPref = String(config.performance.gpu_preference || 'default');
      gpuSelect.value = [...gpuSelect.options].some(o => o.value === curPref) ? curPref : 'default';
    };
    bindRefresh(updateDynamicGpus);

    gpuSelect.onchange = async () => {
      config.performance.gpu_preference = gpuSelect.value;
      window.XRA_gpu_preference = gpuSelect.value;
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
      XRA.promptRestart('Il cambio di scheda video (GPU) richiede il riavvio dell\'applicazione per essere applicato dal runtime.');
    };
    const activeGpuText = () => window.XRA_DETECTED_GPU ? `GPU attiva: ${window.XRA_DETECTED_GPU}. ` : '';
    const gpuRow = row(secRendering.body, 'Graphics card (GPU)', gpuSelect, {
      reset: async () => {
        config.performance.gpu_preference = 'default';
        window.XRA_gpu_preference = 'default';
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.performance.gpu_preference || 'default') === 'default',
      sub: `${activeGpuText()}Selezionare la GPU integrata riduce calore e ventole su laptop con doppia scheda video (richiede riavvio app).`
    });
    bindRefresh(() => {
      const sub = gpuRow.querySelector?.('.xra-sub');
      if (sub) {
        sub.textContent = `${activeGpuText()}Selezionare la GPU integrata riduce calore e ventole su laptop con doppia scheda video (richiede riavvio app).`;
      }
    });

    const shadowsSelect = select([
      ['auto', 'Auto (Disabled on Green Screen · Saving)'],
      ['off', 'Disabled (Maximum GPU saving)'],
      ['on', 'Enabled (For 3D stages with floor)']
    ]);
    bindRefresh(() => { shadowsSelect.value = String(config.performance.shadows || 'auto'); });
    shadowsSelect.onchange = async () => {
      config.performance.shadows = shadowsSelect.value;
      XRA.performance.applyShadows(shadowsSelect.value);
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secRendering.body, '3D dynamic shadows', shadowsSelect, {
      reset: async () => {
        config.performance.shadows = defaults.performance.shadows || 'auto';
        XRA.performance.applyShadows(config.performance.shadows);
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.performance.shadows || 'auto') === (defaults.performance.shadows || 'auto'),
      sub: 'Disattivare le ombre elimina il calcolo della mappa di profondità (2048×2048), risparmiando fino al 30% di GPU. Su sfondo green screen sono inutili.'
    });

    const springBoneSelect = select([
      ['full', 'Full (Every frame)'],
      ['half', 'Half (1 frame out of 2 · Saving)'],
      ['off', 'Off']
    ]);
    bindRefresh(() => {
      springBoneSelect.value = String(config.performance.spring_bone || 'full');
    });
    springBoneSelect.onchange = async () => {
      config.performance.spring_bone = springBoneSelect.value;
      XRA.performance.applySpringBone(springBoneSelect.value);
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
    };
    row(secRendering.body, 'Hair/cloth physics (Spring Bone)', springBoneSelect, {
      reset: async () => {
        config.performance.spring_bone = defaults.performance.spring_bone || 'full';
        XRA.performance.applySpringBone(config.performance.spring_bone);
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.performance.spring_bone || 'full') === (defaults.performance.spring_bone || 'full'),
      sub: 'Half aggiorna soltanto la fisica secondaria a frame alterni; volto, corpo ed espressioni restano fluidi.'
    });

    const aaSelect = select([
      ['auto', 'Enabled (Hardware MSAA · Recommended)'],
      ['off', 'Disabled (GPU saving)']
    ]);
    bindRefresh(() => {
      aaSelect.value = String(config.performance.antialias || 'auto');
    });
    aaSelect.onchange = async () => {
      config.performance.antialias = aaSelect.value;
      window.XRA_antialias = aaSelect.value !== 'off';
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
      XRA.promptRestart('La modifica dell\'Anti-Aliasing (MSAA hardware) richiede il riavvio dell\'applicazione per ricreare il contesto grafico WebGL.');
    };
    row(secRendering.body, 'Anti-Aliasing (AA)', aaSelect, {
      reset: async () => {
        config.performance.antialias = 'auto';
        window.XRA_antialias = true;
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => (config.performance.antialias || 'auto') === 'auto',
      sub: 'Smussa i bordi geometrici dell\'avatar 3D. Disattivarlo alleggerisce i pixel shader della scheda video (richiede riavvio app).'
    });

    const preserveBufSelect = select([
      ['true', 'Enabled (Default · Compatible with REC & Screenshot)'],
      ['false', 'Disabled (VRAM bandwidth saving)']
    ]);
    bindRefresh(() => {
      preserveBufSelect.value = config.performance.preserve_drawing_buffer !== false ? 'true' : 'false';
    });
    preserveBufSelect.onchange = async () => {
      config.performance.preserve_drawing_buffer = preserveBufSelect.value === 'true';
      window.XRA_preserve_drawing_buffer = config.performance.preserve_drawing_buffer;
      markCustomPreset();
      await XRA.profileService.save();
      refreshAll();
      XRA.promptRestart('La modifica del buffer GPU (preserveDrawingBuffer) richiede il riavvio dell\'applicazione per ricreare il contesto grafico WebGL.');
    };
    row(secRendering.body, 'GPU drawing buffer (preserveDrawingBuffer)', preserveBufSelect, {
      reset: async () => {
        config.performance.preserve_drawing_buffer = true;
        window.XRA_preserve_drawing_buffer = true;
        markCustomPreset();
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => config.performance.preserve_drawing_buffer !== false,
      sub: 'Disattivare preserveDrawingBuffer riduce il carico memoria VRAM e calore GPU. Verifica che registrazione video e screenshot continuino a funzionare correttamente.'
    });

    // -------------------------------------------------------------------------
    // 4. 📊 Diagnostica & Ottimizzazione
    // -------------------------------------------------------------------------
    const secDiagnostics = details(perfAdvanced.body, '📊 Diagnostics & Optimization', { open: false });

    const runtimeAdaptive = document.createElement('input'); runtimeAdaptive.type = 'checkbox';
    bindRefresh(() => { runtimeAdaptive.checked = !!config.performance?.runtime_adaptive; });
    runtimeAdaptive.onchange = async () => {
      XRA.performance.setRuntimeAdaptive(runtimeAdaptive.checked);
      await XRA.profileService.save();
      refreshAll();
    };
    row(secDiagnostics.body, 'Runtime adaptive performance', runtimeAdaptive, {
      reset: async () => {
        config.performance.runtime_adaptive = false;
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => !config.performance?.runtime_adaptive,
      sub: 'Lightweight governor: temporarily reduces inference rates only when render timing is under sustained stress. It never rewrites the selected performance preset.'
    });

    const diagnosticsHud = document.createElement('input'); diagnosticsHud.type = 'checkbox';
    bindRefresh(() => { diagnosticsHud.checked = !!config.performance?.diagnostics_hud; });
    diagnosticsHud.onchange = async () => {
      XRA.performance.setDiagnosticsHud(diagnosticsHud.checked);
      await XRA.profileService.save();
      refreshAll();
    };
    row(secDiagnostics.body, 'Performance / REC HUD', diagnosticsHud, {
      reset: async () => {
        XRA.performance.setDiagnosticsHud(false);
        await XRA.profileService.save();
        refreshAll();
      },
      isDefault: () => !config.performance?.diagnostics_hud,
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
    row(secDiagnostics.body, 'Debug session', debugSessionWrap, {
      reset: async () => {
        XRA.debug?.setEnabled(false);
        refreshDebugStatus();
        await XRA.profileService.save(0);
        refreshAll();
      },
      isDefault: () => !XRA.debug?.enabled,
      sub: 'Records tracking, stabilization and pose-change diagnostics in memory. Off by default; no camera frames or device IDs are saved.'
    });

    const debugWrap = el('div', 'xra-command-wrap');
    const debugTitle = el('div', 'xra-label', 'Debug log');
    const debugSub = el('div', 'xra-sub', 'Enable the session, reproduce the problem, then export the JSON file.');
    const debugActions = el('div', 'xra-actions');
    const exportDebug = button('Export debug log', 'xra-action');
    const clearDebug = button('Clear debug log', 'xra-action');
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
    debugWrap.append(debugTitle, debugSub, debugActions);
    secDiagnostics.body.appendChild(debugWrap);

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
    row(secDiagnostics.body, 'Disable heavy post FX', post, {
      reset: async () => { config.performance.disable_postfx = defaults.performance.disable_postfx; XRA.performance.apply(); },
      isDefault: () => !!config.performance.disable_postfx === !!defaults.performance.disable_postfx
    });

    // Native visual-effect fine tuning belongs here because Performance already
    // owns the quick "Disable heavy post FX" shortcut. Keep one logical home.
    const fxAdvanced = details(secDiagnostics.body, 'Visual effects');

    const audioViz = document.createElement('input');
    audioViz.type = 'checkbox';
    bindRefresh(() => {
      audioViz.checked = !!window.MMD_SA_options?.use_CircularSpectrum;
    });
    audioViz.onchange = async () => {
      if (window.MMD_SA_options) {
        MMD_SA_options.use_CircularSpectrum = !!audioViz.checked;
      }
      await XRA.profileService.save();
      refreshAll();
    };
    row(fxAdvanced.body, 'Audio visualizer', audioViz, {
      reset: async () => {
        if (window.MMD_SA_options) MMD_SA_options.use_CircularSpectrum = false;
        audioViz.checked = false;
      },
      isDefault: () => !window.MMD_SA_options?.use_CircularSpectrum
    });

    const fxMount = el('div', 'xra-native-fx-mount');
    const fxStatus = el('div', 'xra-note');
    fxStatus.textContent = 'Apri per caricare i parametri dettagliati (luci, bloom, DOF)...';
    fxMount.appendChild(fxStatus);
    fxAdvanced.body.appendChild(fxMount);

    const mountFxGui = async () => {
      try {
        if (window.MMD_SA?.THREEX?.PPE && !window.MMD_SA.THREEX.PPE.initialized) {
          await window.MMD_SA.THREEX.PPE.init?.();
        }
        if (window.MMD_SA?.THREEX?.GUI && !window.MMD_SA.THREEX.GUI.obj?.visual_effects) {
          await window.MMD_SA.THREEX.GUI.init?.();
        }
        const gui = window.MMD_SA?.THREEX?.GUI?.obj?.visual_effects;
        if (!gui) {
          fxStatus.textContent = 'Parametri avanzati non ancora pronti.';
          return;
        }
        const dom = gui.domElement || gui.__ul?.closest?.('.dg') || document.querySelector('.lil-gui.root') || document.querySelector('.dg.main');
        if (dom instanceof HTMLElement) {
          dom.classList.remove('xra-native-fx-centered');
          dom.classList.add('xra-native-fx-embedded');
          dom.style.position = 'static';
          dom.style.width = '100%';
          dom.style.maxWidth = '100%';
          dom.style.transform = 'none';
          dom.style.zIndex = 'auto';
          dom.style.top = 'auto';
          dom.style.left = 'auto';
          dom.style.right = 'auto';
          dom.style.bottom = 'auto';
          dom.querySelector('.xra-native-fx-close')?.remove();
          if (Array.isArray(gui.__controllers)) {
            const ctrl = gui.__controllers.find(c => /hide controls/i.test(c.property));
            if (ctrl) {
              try { gui.remove(ctrl); } catch (e) { ctrl.__li?.remove(); }
            }
          }
          dom.querySelectorAll('li.cr, .controller, .cr.function, .lil-gui-controller, .close-button, .close-top, .close-bottom, button').forEach(el => {
            if (/hide controls/i.test(el.textContent) || el.classList.contains('close-button') || el.classList.contains('close-bottom') || el.classList.contains('close-top')) {
              el.remove();
            }
          });
          fxStatus.remove();
          if (!fxMount.contains(dom)) {
            fxMount.appendChild(dom);
          }
          dom.style.display = '';
          gui.show?.();
        }
      }
      catch (e) {
        console.warn(TAG, 'mountFxGui failed', e);
        fxStatus.textContent = 'Impossibile caricare i parametri: ' + e.message;
      }
    };

    fxAdvanced.details.addEventListener('toggle', () => {
      if (fxAdvanced.details.open) {
        mountFxGui();
      }
    });

    window.addEventListener('MMDStarted', () => {
      if (fxAdvanced.details.open) {
        mountFxGui();
      }
    });
    window.addEventListener('jThree_ready', () => {
      if (fxAdvanced.details.open) {
        mountFxGui();
      }
    });

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

  let stageSelect = null;
  let stagesLoaded = false;

  async function refreshStages(force = false) {
    if (!stageSelect || !XRA.stage?.listStages) return;
    try {
      const files = await XRA.stage.listStages(force);
      const current = config.stage?.path || '';
      stageSelect.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '-- choose 3D stage --';
      stageSelect.appendChild(empty);
      if (current && !files.includes(current)) {
        const option = document.createElement('option');
        option.value = current;
        option.textContent = '[current] ' + current;
        stageSelect.appendChild(option);
      }
      for (const path of files) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path.replace(/^stages\//, '');
        stageSelect.appendChild(option);
      }
      stageSelect.value = [...stageSelect.options].some(o => o.value === current) ? current : '';
      stagesLoaded = true;
    }
    catch (e) {
      console.warn(TAG, 'stage list failed', e);
    }
  }

  function installStage(parent) {
    const box = details(parent, '🏛️ 3D Stage & Environment');
    box.details.addEventListener('toggle', () => {
      if (box.details.open && !stagesLoaded) refreshStages();
    });

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    bindRefresh(() => {
      enabled.checked = !!config.stage?.enabled;
    });
    enabled.onchange = async () => {
      config.stage ||= {};
      config.stage.enabled = enabled.checked;
      if (enabled.checked && !config.stage.path && stageSelect && stageSelect.options.length > 1) {
        config.stage.path = stageSelect.options[1].value;
        stageSelect.value = config.stage.path;
      }
      XRA.stage?.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Enable 3D stage', enabled, {
      reset: async () => {
        config.stage ||= {};
        config.stage.enabled = false;
        XRA.stage?.apply();
      },
      isDefault: () => !config.stage?.enabled,
      sub: 'Renders a 3D stage, studio or room (.glb / .gltf / .fbx) around the avatar. Zero cost when disabled.'
    });

    stageSelect = select([['', '-- choose 3D stage --']]);
    stageSelect.onchange = async () => {
      config.stage ||= {};
      config.stage.path = stageSelect.value;
      if (stageSelect.value) {
        config.stage.enabled = true;
        enabled.checked = true;
      }
      XRA.stage?.apply();
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Stage file', stageSelect, {
      reset: async () => {
        config.stage ||= {};
        config.stage.path = '';
        XRA.stage?.apply();
        stagesLoaded = false;
        await refreshStages();
      },
      isDefault: () => !config.stage?.path
    });

    const makeStageRow = (label, key, min, max, step, defVal, sub = '') => {
      const wrap = el('div', 'xra-stack-control');
      const flex = el('div');
      flex.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.style.flex = '1';

      const numInput = stopInputPropagation(document.createElement('input'));
      numInput.type = 'number';
      numInput.min = '-20000';
      numInput.max = '20000';
      numInput.step = String(step);
      numInput.style.cssText = 'width:68px;padding:2px 4px;font-size:12px;text-align:right;background:#181c20;color:#eee;border:1px solid #444;border-radius:4px;';

      flex.append(slider, numInput);
      wrap.appendChild(flex);

      bindRefresh(() => {
        const val = Number(config.stage?.[key] ?? defVal);
        slider.value = String(val);
        numInput.value = String(val);
      });

      const commit = (val) => {
        config.stage ||= {};
        config.stage[key] = val;
        slider.value = String(val);
        numInput.value = String(val);
        XRA.stage?.updateTransform();
      };

      slider.oninput = () => commit(Number(slider.value));
      slider.onchange = async () => { await XRA.profileService.save(); };

      numInput.oninput = () => {
        const val = parseFloat(numInput.value);
        if (!isNaN(val)) commit(val);
      };
      numInput.onchange = async () => { await XRA.profileService.save(); };

      row(box.body, label, wrap, {
        reset: async () => {
          config.stage ||= {};
          config.stage[key] = defVal;
          XRA.stage?.updateTransform();
        },
        isDefault: () => Number(config.stage?.[key] ?? defVal) === defVal,
        sub
      });
    };

    makeStageRow('Position X', 'offset_x', -3000, 3000, 2.0, 0.0, 'Spostamento laterale (sinistra/destra).');
    makeStageRow('Position Y', 'offset_y', -3000, 3000, 2.0, 0.0, 'Spostamento verticale (alto/basso).');
    makeStageRow('Position Z', 'offset_z', -3000, 3000, 2.0, 0.0, 'Spostamento in profondità (avanti/indietro).');
    makeStageRow('Stage scale', 'scale', 0.05, 50.0, 0.05, 1.0, 'Scala scenografia.');
    makeStageRow('Rotation Y', 'rotation_y', -180, 180, 1, 0, 'Rotazione orizzontale (yaw).');
    makeStageRow('Rotation X', 'rotation_x', -180, 180, 1, 0, 'Inclinazione avanti/dietro (pitch).');
    makeStageRow('Rotation Z', 'rotation_z', -180, 180, 1, 0, 'Inclinazione laterale (roll).');

    const btnRow = el('div', 'xra-actions');
    const resetCenterBtn = button('↺ Reset stage position');
    resetCenterBtn.onclick = async () => {
      config.stage ||= {};
      config.stage.offset_x = 0.0;
      config.stage.offset_y = 0.0;
      config.stage.offset_z = 0.0;
      config.stage.rotation_x = 0.0;
      config.stage.rotation_y = 0.0;
      config.stage.rotation_z = 0.0;
      config.stage.scale = 1.0;
      XRA.stage?.updateTransform();
      await XRA.profileService.save();
      refreshAll();
    };
    const refresh = button('↻ Refresh 3D stage files');
    refresh.onclick = () => { stagesLoaded = false; refreshStages(true); };
    btnRow.append(resetCenterBtn, refresh);
    box.body.appendChild(btnRow);
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

  function installRecordingMicIndicator() {
    const indicator = el('div', 'xra-rec-mic-indicator');
    indicator.style.display = 'none';

    const dot = el('span', 'xra-rec-mic-dot');
    const text = el('span', 'xra-rec-mic-text');
    text.textContent = 'REC · MIC LIVE';
    indicator.append(dot, text);
    document.body.appendChild(indicator);
    UI.registerHideable?.(indicator);

    let isRecording = false;
    let isAudioActive = true;

    function updateIndicator() {
      if (!isRecording) {
        indicator.style.display = 'none';
        return;
      }
      indicator.style.display = 'flex';
      const recCfg = config.recorder || {};
      const noAudio = recCfg.mode === 'video';
      if (noAudio) {
        indicator.classList.remove('mic-open');
        indicator.classList.add('mic-muted');
        text.textContent = 'REC · NO AUDIO';
      } else if (isAudioActive) {
        indicator.classList.remove('mic-muted');
        indicator.classList.add('mic-open');
        text.textContent = 'REC · MIC LIVE';
      } else {
        indicator.classList.remove('mic-open');
        indicator.classList.add('mic-muted');
        text.textContent = 'REC · MIC MUTED';
      }
    }

    events.on('recording-start', () => {
      isRecording = true;
      isAudioActive = true;
      updateIndicator();
    });

    events.on('recording-stop', () => {
      isRecording = false;
      updateIndicator();
    });

    events.on('recording-gate', ({ open }) => {
      isAudioActive = !!open;
      if (isRecording) updateIndicator();
    });

    if (XRA.recorder?.status?.()?.active) {
      isRecording = true;
      updateIndicator();
    }
  }

  function create() {
    if (panel) return panel;

    installRecordingMicIndicator();

    panel = el('div', 'xra-right-panel');
    panel.id = 'XRA_CUSTOM_PANEL';

    const header = el('div', 'xra-right-header');
    const hands = button('🖐 ON', 'xra-hands');
    bindRefresh(() => {
      hands.textContent = XRA.tracking.handsEnabled ? '🖐 ON' : '🧊 OFF';
      hands.classList.toggle('off', !XRA.tracking.handsEnabled);
      hands.title = XRA.tracking.handsEnabled ? 'Mani attive (clicca per disattivare)' : 'Mani disattivate (clicca per attivare)';
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

    const fs = button('⛶', 'xra-fullscreen-toggle');
    fs.title = 'Schermo intero (F11)';
    const updateFsIcon = () => {
      const isFs = typeof nw !== 'undefined' && nw?.Window?.get
        ? !!nw.Window.get().isFullscreen
        : !!(document.fullscreenElement || document.webkitFullscreenElement);
      fs.textContent = isFs ? '🗗' : '⛶';
      fs.title = isFs ? 'Esci da schermo intero (F11)' : 'Schermo intero (F11)';
    };
    fs.onclick = () => {
      if (typeof nw !== 'undefined' && nw?.Window?.get) {
        try {
          nw.Window.get().toggleFullscreen();
          setTimeout(updateFsIcon, 100);
          return;
        } catch (_) {}
      }
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement).catch(() => {});
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document).catch(() => {});
      }
    };
    document.addEventListener('fullscreenchange', updateFsIcon);
    document.addEventListener('webkitfullscreenchange', updateFsIcon);
    if (typeof nw !== 'undefined' && nw?.Window?.get) {
      try {
        const win = nw.Window.get();
        const isNiri = Boolean(
          (typeof process !== 'undefined' && (process?.env?.NIRI_SOCKET || process?.env?.XDG_CURRENT_DESKTOP === 'niri'))
        );
        let savedW = win.width || window.innerWidth || screen.availWidth || 1920;
        let savedH = win.height || window.innerHeight || screen.availHeight || 1080;
        win.on('resize', (w, h) => {
          if (!win.isFullscreen && w && h) {
            savedW = w;
            savedH = h;
          }
        });
        const restoreNiri = () => {
          if (!isNiri) return;
          try {
            const cp = typeof require !== 'undefined' ? require('child_process') : null;
            if (cp?.execFile) {
              const widthArg = (savedW && Number.isFinite(savedW) && savedW > 200)
                ? String(Math.round(savedW))
                : '100%';
              cp.execFile('niri', ['msg', 'action', 'set-column-width', widthArg], () => {});
            }
          } catch (_) {}
          if (savedW && savedH) {
            try { win.resizeTo(savedW, savedH); } catch (_) {}
          }
        };
        win.on('enter-fullscreen', updateFsIcon);
        win.on('restore', () => {
          updateFsIcon();
          if (isNiri) restoreNiri();
        });
        win.on('leave-fullscreen', () => {
          updateFsIcon();
          setTimeout(() => {
            try {
              if (isNiri) {
                restoreNiri();
              } else {
                win.maximize();
              }
            } catch (_) {}
          }, 50);
        });
      } catch (_) {}
    }
    window.addEventListener('keydown', e => {
      if (e.key === 'F11') {
        e.preventDefault();
        fs.click();
      }
    });

    header.append(hands, hide, totalHide, fs);

    let panelBodyOpen = false;

    function updatePanelState() {
      const isClosed = !panelBodyOpen;
      panel?.classList.toggle('panel-closed', isClosed);
      if (body) body.hidden = isClosed || UI.hidden;
      if (launcher) launcher.hidden = panelBodyOpen || UI.hidden;
      updateMeterLoop();
    }

    const launcher = button('📋 CONTROL PANEL', 'xra-right-launcher');
    launcher.hidden = false;
    launcher.dataset.xraRightLauncher = '1';
    bindRefresh(() => {
      const title = XRA.i18n?.t?.('Control panel') || 'Control panel';
      launcher.textContent = `📋 ${title.toUpperCase()}`;
      launcher.title = XRA.i18n?.t?.('Open control panel') || 'Open control panel';
    });
    launcher.onclick = () => {
      panelBodyOpen = true;
      updatePanelState();
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
      updatePanelState();
    };
    menuTop.append(menuClose, menuTitle);
    body.appendChild(menuTop);

    const content = el('div', 'xra-right-content');
    installHealth(content);
    installStudioLink(content);
    installCameraView(content);
    installAudio(content);
    installBody(content);
    installArmsAndHands(content);
    installObjectTracking(content);
    installCollider(content);
    installPerformance(content);
    installBackground(content);
    installStage(content);
    installProfile(content);
    body.appendChild(content);

    panel.append(header, launcher, body);
    document.body.appendChild(panel);

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshMicrophones);
    events.on('profile-loaded', () => {
      backgroundsLoaded = false;
      stagesLoaded = false;
      refreshMicrophones();
      refreshAll();
    });
    events.on('ui-hidden', () => {
      updatePanelState();
    });

    refreshMicrophones();
    refreshAll();
    updatePanelState();
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
