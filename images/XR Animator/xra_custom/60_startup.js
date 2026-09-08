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
    if (!config.ui?.show_startup || document.querySelector('[data-xra-startup]')) return;

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
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'xra-start-close';
    close.textContent = '×';
    close.title = tr('Close');
    close.setAttribute('aria-label', tr('Close'));
    head.append(heading, close);

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

    const cameraActions = document.createElement('div');
    cameraActions.className = 'xra-start-camera-actions';
    const cameraToggle = document.createElement('button');
    cameraToggle.type = 'button';
    cameraToggle.className = 'xra-action primary';
    const cameraRefresh = document.createElement('button');
    cameraRefresh.type = 'button';
    cameraRefresh.className = 'xra-action';
    cameraRefresh.textContent = '↻';
    cameraRefresh.title = tr('Refresh cameras');
    cameraRefresh.setAttribute('aria-label', tr('Refresh cameras'));
    cameraActions.append(cameraToggle, cameraRefresh);
    camera.append(cameraHead, cameraSelect, cameraActions);

    function renderCameraState(message = '') {
      const active = XRA.nativeBridge?.activeCamera?.() || {};
      const running = !!XRA.nativeBridge?.cameraRunning?.();
      cameraState.classList.toggle('on', running);
      cameraState.textContent = message || (running
        ? `${tr('ON')} · ${active.label || tr('Default camera')}`
        : tr('OFF'));
      cameraToggle.textContent = running ? tr('Disable camera') : tr('Enable camera');
      cameraToggle.classList.toggle('primary', !running);
      cameraToggle.classList.toggle('danger', running);
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

    cameraToggle.onclick = async () => {
      cameraToggle.disabled = true;
      cameraSelect.disabled = true;
      try {
        if (XRA.nativeBridge.cameraRunning()) {
          renderCameraState(tr('Stopping…'));
          await XRA.nativeBridge.stopNativeStreamer();
        }
        else {
          const option = cameraSelect.selectedOptions[0];
          if (option?.value) await XRA.nativeBridge.setCameraPreference({
            deviceId: option.value,
            label: option.dataset.label || option.textContent
          });
          renderCameraState(tr('Starting…'));
          await XRA.nativeBridge.startNativeStreamer();
        }
      }
      catch (e) { renderCameraState('Error · ' + e.message); }
      finally {
        cameraToggle.disabled = false;
        cameraSelect.disabled = false;
        await refreshCameras(false);
      }
    };
    cameraRefresh.onclick = () => refreshCameras(true);

    const show = document.createElement('label');
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!config.ui.show_startup;
    const showText = document.createElement('span');
    showText.className = 'xra-sub';
    showText.textContent = 'Show this screen on startup';
    show.append(chk, showText);
    chk.onchange = async () => {
      config.ui.show_startup = chk.checked;
      await XRA.profileService.save(0);
    };

    const foot = document.createElement('div');
    foot.className = 'xra-start-foot';
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'xra-action primary xra-start-confirm';
    start.textContent = 'START';
    foot.append(show, start);

    let closing = false;
    async function closeOverlay() {
      if (closing) return;
      closing = true;
      document.removeEventListener('keydown', onKeyDown);
      config.ui.show_startup = chk.checked;
      try { await XRA.profileService.save(0); } catch (e) {}
      overlay.remove();
      XRA.ui?.refresh?.();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeOverlay(); }
    }
    close.onclick = closeOverlay;
    start.onclick = closeOverlay;
    overlay.addEventListener('pointerdown', event => {
      if (event.target === overlay) closeOverlay();
    });
    document.addEventListener('keydown', onKeyDown);

    card.append(head, grid, status, camera, bg, avatar, foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    renderCameraState();
    setTimeout(() => refreshCameras(false), 100);
    const nativeReady = XRA.whenNativeReady?.();
    nativeReady?.then(() => {
      if (overlay.isConnected) refreshCameras(false);
    });
    for (const name of ['camera-started', 'camera-stopped', 'camera-switched']) {
      events.on(name, () => { if (overlay.isConnected) refreshCameras(false); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createOverlay, { once: true });
  else createOverlay();

})();
