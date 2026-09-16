/* XRA_BACKEND_CONTROL_V5 */
(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA START]';
  const { config, events } = XRA;

  async function startWithPreset(name, status) {
    name = String(name || 'CUSTOM').toUpperCase();

    if (name === 'CUSTOM') {
      config.performance.master_preset = 'CUSTOM';
      await XRA.profileService.save(0);
      status.textContent = 'CUSTOM · ready';
      return;
    }

    if (name === 'AUTO') {
      status.textContent = 'Benchmarking…';
      const result = await XRA.performance.benchmarkHardwareOnly();
      status.textContent = `AUTO → ${result.preset} (${result.fps.toFixed(1)} fps)`;
      await XRA.performance.applyPresetSafe(result.preset);
      config.performance.master_preset = 'AUTO';
      config.performance.auto_last_result = result;
      await XRA.profileService.save(0);
      return;
    }

    status.textContent = `${name}: applying…`;
    await XRA.performance.applyPresetSafe(name);
    status.textContent = `${name} · applied`;
  }

  function createOverlay() {
    if (document.querySelector('[data-xra-startup]')) return;

    const tr = source => XRA.i18n?.t?.(source) || source;

    const overlay = document.createElement('div');
    overlay.className = 'xra-overlay';
    overlay.dataset.xraStartup = '1';

    const card = document.createElement('div');
    card.className = 'xra-start-card';
    const head = document.createElement('div');
    head.className = 'xra-start-head';
    const heading = document.createElement('div');
    heading.innerHTML = `<h2>XR Animator</h2><div class="xra-sub">${tr('Quick setup · changes apply immediately.')}</div>`;
    head.append(heading);

    const grid = document.createElement('div');
    grid.className = 'xra-start-grid';

    const languageWrap = document.createElement('label');
    languageWrap.className = 'xra-start-field';
    const languageText = document.createElement('div');
    languageText.className = 'xra-sub';
    languageText.textContent = 'Language';
    const language = document.createElement('select');
    for (const [code, label] of (XRA.i18n?.LANGUAGES || [['auto','Auto / System'],['en','English'],['it','Italiano']])) {
      const o = document.createElement('option'); o.value = code; o.textContent = label; language.appendChild(o);
    }
    language.value = config.ui?.language || 'auto';
    language.onchange = () => XRA.i18n?.setLanguage?.(language.value);
    languageWrap.append(languageText, language);

    const presetWrap = document.createElement('label');
    presetWrap.className = 'xra-start-field';
    const presetText = document.createElement('div');
    presetText.className = 'xra-sub';
    presetText.textContent = 'Master preset';
    const preset = document.createElement('select');
    for (const name of ['AUTO','ECO','LOW','BALANCED','QUALITY','HIGH','MAX','CUSTOM']) {
      const o = document.createElement('option'); o.value = name; o.textContent = name; preset.appendChild(o);
    }
    preset.value = (config.performance?.master_preset === 'MINIMAL' ? 'ECO' : (config.performance?.master_preset || 'CUSTOM'));
    presetWrap.append(presetText, preset);
    grid.append(languageWrap, presetWrap);

    const status = document.createElement('div');
    status.className = 'xra-status';
    status.textContent = tr('Ready.');
    preset.onchange = async () => {
      preset.disabled = true;
      try {
        await startWithPreset(preset.value, status);
        events.emit('state', { path: 'performance.master_preset', value: config.performance.master_preset });
      }
      catch (e) {
        console.error(TAG, e);
        status.textContent = 'Preset error: ' + e.message;
      }
      finally { preset.disabled = false; XRA.ui?.refresh?.(); }
    };

    const bg = document.createElement('div');
    bg.className = 'xra-sub';
    bg.style.margin = '8px 0';
    bg.textContent = 'Background: ' + (config.background?.path || config.background?.color || 'default');

    const avatar = document.createElement('div');
    avatar.className = 'xra-start-avatar';
    const avatarText = document.createElement('div');
    avatarText.className = 'xra-sub';
    avatarText.textContent = 'Avatar: l’ultimo VRM scelto viene copiato in avatars/ e ripristinato all’avvio.';
    const avatarButton = document.createElement('button');
    avatarButton.type = 'button';
    avatarButton.className = 'xra-action';
    avatarButton.textContent = 'Load / change VRM…';
    avatarButton.onclick = async () => {
      try { await XRA.nativeBridge?.openVrmPicker?.(); }
      catch (e) { XRA.toast('VRM loader: ' + e.message, 'error', 4500); }
    };
    avatar.append(avatarText, avatarButton);

    const camera = document.createElement('section');
    camera.className = 'xra-start-camera';
    const cameraHead = document.createElement('div');
    cameraHead.className = 'xra-start-camera-head';
    const cameraTitle = document.createElement('div');
    cameraTitle.className = 'xra-start-camera-title';
    cameraTitle.textContent = tr('Webcam');
    const cameraState = document.createElement('div');
    cameraState.className = 'xra-start-camera-state';
    cameraHead.append(cameraTitle, cameraState);

    const cameraSelect = document.createElement('select');
    const loadingOption = document.createElement('option');
    loadingOption.value = '';
    loadingOption.textContent = tr('Loading cameras…');
    cameraSelect.appendChild(loadingOption);

    const cameraRow = document.createElement('div');
    cameraRow.className = 'xra-start-camera-row';
    const cameraRefresh = document.createElement('button');
    cameraRefresh.type = 'button';
    cameraRefresh.className = 'xra-action';
    cameraRefresh.textContent = '↻';
    cameraRefresh.title = tr('Refresh cameras');
    cameraRefresh.setAttribute('aria-label', tr('Refresh cameras'));
    cameraRow.append(cameraSelect, cameraRefresh);
    camera.append(cameraHead, cameraRow);

    function renderCameraState(message = '') {
      const active = XRA.nativeBridge?.activeCamera?.() || {};
      const running = !!XRA.nativeBridge?.cameraRunning?.();
      cameraState.classList.toggle('on', running);
      cameraState.textContent = message || (running
        ? `${tr('ON')} · ${active.label || tr('Default camera')}`
        : tr('OFF'));
    }

    async function refreshCameras(requestPermission = false) {
      if (!XRA.nativeBridge?.enumerateCameras) return;
      cameraSelect.disabled = true;
      try {
        const cameras = await XRA.nativeBridge.enumerateCameras({ requestPermission });
        const active = XRA.nativeBridge.activeCamera();
        cameraSelect.innerHTML = '';
        if (!cameras.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = tr('No cameras found');
          cameraSelect.appendChild(option);
        }
        else for (const device of cameras) {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.dataset.label = device.label;
          option.textContent = device.label;
          cameraSelect.appendChild(option);
        }
        const wanted = active.deviceId || config.devices?.camera_device_id || '';
        if ([...cameraSelect.options].some(option => option.value === wanted)) cameraSelect.value = wanted;
        renderCameraState();
      }
      catch (e) { renderCameraState(tr('Camera unavailable')); }
      finally { cameraSelect.disabled = false; }
    }

    cameraSelect.onchange = async () => {
      const option = cameraSelect.selectedOptions[0];
      if (!option?.value) return;
      cameraSelect.disabled = true;
      try {
        const preference = { deviceId: option.value, label: option.dataset.label || option.textContent };
        if (XRA.nativeBridge.cameraRunning()) await XRA.nativeBridge.switchCamera(preference);
        else await XRA.nativeBridge.setCameraPreference(preference);
        renderCameraState();
      }
      catch (e) { renderCameraState('Error · ' + e.message); }
      finally { cameraSelect.disabled = false; }
    };

    cameraRefresh.onclick = () => refreshCameras(true);

    const cameraWarning = document.createElement('div');
    cameraWarning.className = 'xra-start-camera-warning';
    cameraWarning.style.display = 'none';
    cameraWarning.style.marginTop = '8px';
    cameraWarning.style.padding = '8px 10px';
    cameraWarning.style.borderRadius = '6px';
    cameraWarning.style.background = 'rgba(230, 80, 0, 0.18)';
    cameraWarning.style.border = '1px solid rgba(230, 80, 0, 0.45)';
    cameraWarning.style.color = '#ffb380';
    cameraWarning.style.fontSize = '11px';
    cameraWarning.style.lineHeight = '1.4';
    camera.append(cameraWarning);

    const foot = document.createElement('div');
    foot.className = 'xra-start-foot';
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'xra-action primary xra-start-confirm';
    start.textContent = tr('Caricamento avatar…');
    start.disabled = true;
    foot.append(start);

    let closing = false;
    let readinessTimer = 0;

    function isAvatarReady() {
      if (typeof XRA.nativeBridge?.isAvatarReady === 'function') {
        return XRA.nativeBridge.isAvatarReady();
      }
      if (window.MMD_SA?.MMD_started) {
        const model = window.MMD_SA?.THREEX?.get_model?.(0);
        if (model && !model.loading && !window.MMD_SA?.THREEX?._loading_model && (model.mesh || model.model || model.scene)) {
          if (model.mesh && model.mesh.visible === false) return false;
          return true;
        }
      }
      return false;
    }

    function isBackendReady() {
      if (!XRA.xraBackend || !XRA.xraBackend.active) return true;
      const snap = XRA.xraBackend.snapshot?.();
      return !!snap?.ready;
    }

    function getCameraBusyInfo() {
      const snap = XRA.xraBackend?.snapshot?.();
      const cap = snap?.capture || window.XRA_BACKEND_CAMERA?.status?.()?.backend?.capture;
      if (cap?.camera_busy) {
        const procs = (cap.busy_processes && cap.busy_processes.length)
          ? cap.busy_processes.join(', ')
          : (cap.busy_process || 'un\'altra applicazione');
        return { busy: true, proc: procs };
      }
      if (cap?.last_error && cap.last_error.includes('Webcam occupata')) {
        return { busy: true, proc: cap.last_error };
      }
      return { busy: false, proc: '' };
    }

    function updateReadiness() {
      if (closing || !overlay.isConnected) return;
      const busyInfo = getCameraBusyInfo();
      if (busyInfo.busy) {
        cameraWarning.style.display = 'block';
        cameraWarning.textContent = `⚠️ Webcam in uso da un'altra applicazione (${busyInfo.proc}). Chiudila per avviare il tracking.`;
      } else {
        cameraWarning.style.display = 'none';
      }

      const avatarReady = isAvatarReady();
      const backendReady = isBackendReady();

      if (!avatarReady) {
        start.disabled = true;
        start.textContent = tr('Caricamento avatar…');
      } else if (!backendReady) {
        start.disabled = true;
        start.textContent = tr('Connessione backend…');
      } else if (busyInfo.busy) {
        start.disabled = true;
        start.textContent = tr('Webcam occupata…');
      } else {
        start.disabled = false;
        start.textContent = 'START';
      }
    }

    async function closeOverlay(autoStartCamera = false) {
      if (closing || start.disabled) return;
      closing = true;
      if (readinessTimer) { clearInterval(readinessTimer); readinessTimer = 0; }
      start.disabled = true;
      start.textContent = 'Avvio in corso…';
      try { await XRA.profileService.save(0); } catch (e) {}
      overlay.remove();
      XRA.ui?.refresh?.();
      if (autoStartCamera) {
        try {
          if (typeof XRA.whenNativeReady === 'function') {
            await XRA.whenNativeReady(15000);
          }
          if (XRA.xraBackend?.waitUntilReady) {
            await XRA.xraBackend.waitUntilReady(6000).catch(() => {});
          }
          await XRA.nativeBridge?.startNativeStreamer?.();
        } catch (e) {
          if (!globalThis.XRA_CAMERA_OWNERSHIP?.isOwnershipError?.(e)) {
            console.warn(TAG, 'Auto-starting camera on START failed', e);
          }
        }
      }
    }
    start.onclick = () => closeOverlay(true);

    try {
      const bStatus = window.XRA_BACKEND_CAMERA?.status?.();
      const cam = window.System?._browser?.camera;
      if (bStatus?.backend?.capture?.running && !cam?.running) {
        window.XRA_BACKEND_CAMERA?.stop?.().catch(() => {});
      }
    } catch (_) {}

    card.append(head, grid, status, camera, bg, avatar, foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    renderCameraState();
    setTimeout(() => refreshCameras(false), 100);

    readinessTimer = setInterval(updateReadiness, 300);
    window.addEventListener('MMDStarted', updateReadiness);
    if (XRA.xraBackend?.onStatus) {
      XRA.xraBackend.onStatus(updateReadiness);
    }
    updateReadiness();

    const nativeReady = XRA.whenNativeReady?.();
    nativeReady?.then(() => {
      if (overlay.isConnected) refreshCameras(false);
    });
    for (const name of ['camera-started', 'camera-stopped', 'camera-switched']) {
      events.on(name, () => { if (overlay.isConnected) refreshCameras(false); });
    }
    for (const name of ['avatar-loading', 'avatar-changed', 'avatar-ready']) {
      events.on(name, () => { if (overlay.isConnected) updateReadiness(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createOverlay, { once: true });
  else createOverlay();

})();
