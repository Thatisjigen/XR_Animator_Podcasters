(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA NATIVE BRIDGE]';
  const { config, events, util } = XRA;

  // Serialize every camera mutation. XR Animator's native streamer is not
  // re-entrant: overlapping restart/applyConstraints/device-switch calls are
  // a common cause of black/vanishing previews.
  let cameraChain = Promise.resolve();
  let cameraBusy = '';
  let cameraSoftStopped = false;
  function cameraDebugState() {
    const active = activeCamera();
    const health = previewHealth();
    return {
      initialized:!!window.System?._browser?.camera?.initialized,
      ready_state:active.readyState || '',
      label:active.label || '',
      healthy:!!health.healthy,
      live:!!health.live,
      muted:!!health.muted
    };
  }

  function runCameraOp(label, fn) {
    const task = cameraChain.catch(() => {}).then(async () => {
      const started = performance.now();
      cameraBusy = label;
      events.emit('camera-operation', { busy: true, label });
      XRA.debug?.record('camera.operation.started', { label, state:cameraDebugState() });
      try {
        const result = await fn();
        XRA.debug?.record('camera.operation.succeeded', {
          label,
          elapsed_ms:Math.round((performance.now() - started) * 10) / 10,
          state:cameraDebugState()
        });
        return result;
      }
      catch (error) {
        XRA.debug?.record('camera.operation.failed', {
          label,
          elapsed_ms:Math.round((performance.now() - started) * 10) / 10,
          error,
          state:cameraDebugState()
        });
        throw error;
      }
      finally {
        cameraBusy = '';
        events.emit('camera-operation', { busy: false, label });
      }
    });
    cameraChain = task.catch(() => {});
    return task;
  }

  function itemBase() {
    return window.MMD_SA_options?.Dungeon_options?.item_base || null;
  }

  function item(name) {
    return itemBase()?.[name] || null;
  }

  async function invokeItem(name) {
    await XRA.whenNativeReady();
    const target = item(name);
    const fn = target?.action?.func;
    if (typeof fn !== 'function') throw new Error(`Native command not ready: ${name}`);

    try {
      // Native inventory actions sometimes expect the item itself as argument.
      return await fn.call(target.action, target);
    }
    catch (e) {
      console.error(TAG, 'native command failed', name, e);
      throw e;
    }
  }

  function nodeLabel(node) {
    if (!node) return '';
    return [node.textContent, node.value, node.title, node.getAttribute?.('aria-label'), node.getAttribute?.('alt'), node.id, node.className]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function nativeClickable(rx) {
    const nodes = document.querySelectorAll('button, a, input[type="button"], input[type="submit"], input[type="image"], [role="button"]');
    for (const node of nodes) {
      if (node.closest?.('#XRA_CUSTOM_PANEL, #XRA_NATIVE_SETTINGS, .xra-overlay, .xra-recording-hud')) continue;
      if (rx.test(nodeLabel(node))) return node;
    }
    return null;
  }

  // V7.6.24: VRM loading must go through XR Animator's drag/drop pipeline.
  // Merely clicking its generic <input type=file> opens a picker but does not
  // perform the "OK -> SA_DragDropEMU(file)" step, which is why V7.6.23 let
  // the user select a model while the old avatar remained active.
  let xraVrmInput = null;
  let vrmLoadBusy = false;
  let vrmRestoreInFlight = null;

  function modelList() {
    const list = window.MMD_SA?.THREEX?.models;
    return Array.isArray(list) ? list : [];
  }

  function extraModelPaths() {
    const list = window.MMD_SA_options?.THREEX_options?.model_path_extra;
    return Array.isArray(list) ? list.slice() : [];
  }

  function basename(value) {
    return String(value || '').replace(/[?#].*$/, '').split(/[\\/]/).pop().toLowerCase();
  }

  function modelSearchText(model) {
    if (!model || typeof model !== 'object') return '';
    const out = [];
    for (const [key, value] of Object.entries(model)) {
      if (!/(name|file|path|url|src)/i.test(key)) continue;
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
      else if (value && typeof value === 'object') {
        for (const subKey of ['name','fileName','filename','path','url','src']) {
          const v = value[subKey];
          if (typeof v === 'string') out.push(v);
        }
      }
    }
    return out.join(' ').toLowerCase();
  }

  function findModelByFilename(filename) {
    const wanted = basename(filename);
    const stem = wanted.replace(/\.(vrm|glb|gltf)$/i, '');
    if (!wanted) return -1;
    const models = modelList();
    for (let i = models.length - 1; i >= 0; i--) {
      const text = modelSearchText(models[i]);
      if (text.includes(wanted) || (stem.length >= 3 && text.includes(stem))) return i;
    }
    return -1;
  }

  function findLoadedModelIndex(file, beforeModels, beforePaths) {
    const models = modelList();
    if (!models.length) return -1;

    // Best signal: a brand-new model object appeared in the VRM model list.
    for (let i = models.length - 1; i >= 0; i--) {
      if (!beforeModels.includes(models[i])) return i;
    }

    // XR Animator stores extra avatars in model_path_extra. Map a newly filled
    // slot back to the model's index_default, matching its own hot-swap logic.
    const paths = extraModelPaths();
    for (let slot = paths.length - 1; slot >= 0; slot--) {
      if (!paths[slot] || paths[slot] === beforePaths[slot]) continue;
      const wantedDefault = slot + 1;
      const idx = models.findIndex(m => Number(m?.index_default) === wantedDefault);
      if (idx >= 0) return idx;
    }

    // Re-selecting a model that XR Animator already has loaded may not append a
    // new object. In that case use the filename/path metadata if available.
    const wanted = basename(file?.name || file?.path);
    if (wanted) {
      for (let i = models.length - 1; i >= 0; i--) {
        const text = modelSearchText(models[i]);
        if (text.includes(wanted)) return i;
        const stem = wanted.replace(/\.(vrm|glb|gltf)$/i, '');
        if (stem.length >= 3 && text.includes(stem)) return i;
      }
    }
    return -1;
  }

  async function swapToModel(index) {
    const vrm = window.MMD_SA?.THREEX?.VRM;
    const fn = vrm?.swap_model;
    if (typeof fn !== 'function' || index < 0) return false;
    const result = fn.call(vrm, index);
    if (result && typeof result.then === 'function') await result;
    return true;
  }

  function dragDropLoader() {
    if (typeof window.SA_DragDropEMU === 'function') return window.SA_DragDropEMU.bind(window);
    try {
      if (window.parent && typeof window.parent.SA_DragDropEMU === 'function') return window.parent.SA_DragDropEMU.bind(window.parent);
    } catch (e) {}
    return null;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function uploadAvatarCopy(file) {
    const filename = file?.name || basename(file?.path) || 'avatar.vrm';
    const response = await fetch(`/__xra_avatar?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': filename
      },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.filename) {
      throw new Error(data.error || `Impossibile copiare “${filename}” nella libreria avatar`);
    }
    return String(data.filename);
  }

  async function persistAvatar(file) {
    try {
      const stored = await uploadAvatarCopy(file);
      config.avatar ||= {};
      config.avatar.filename = stored;
      const saved = await XRA.profileService.save(0);
      if (!saved) XRA.toast('Avatar copiato, ma il profilo non è stato salvato', 'error', 6000);
      return saved;
    }
    catch (error) {
      console.error(TAG, 'avatar library save failed', error);
      XRA.toast('Avatar attivo, ma non è stato salvato in avatars/: ' + (error.message || error), 'error', 6000);
      return false;
    }
  }

  async function loadVrmFile(file, { persist = true, quiet = false } = {}) {
    if (!file) return false;
    if (vrmLoadBusy) throw new Error('A VRM is already being loaded');
    const loader = dragDropLoader();
    if (!loader) throw new Error('XR Animator drag/drop loader is not ready');

    vrmLoadBusy = true;
    const beforeModels = modelList().slice();
    const beforePaths = extraModelPaths();
    const filename = file.name || basename(file.path) || 'VRM';
    if (!quiet) XRA.toast(`Caricamento avatar: ${filename}…`, 'info', 2500);

    try {
      // This mirrors XR Animator's own file-dialog confirmation path.
      let result = loader(file);
      if (result && typeof result.then === 'function') await result;

      // Loading/parsing VRM is asynchronous even when SA_DragDropEMU itself
      // returns immediately. Wait for the new model to enter THREEX.models and
      // then explicitly hot-swap to it; otherwise XR Animator can keep showing
      // the previously active avatar.
      let candidate = -1;
      const deadline = performance.now() + 20000;
      while (performance.now() < deadline) {
        candidate = findLoadedModelIndex(file, beforeModels, beforePaths);
        if (candidate >= 0) {
          // Give the loader a short moment to finish attaching the VRM scene.
          await sleep(350);
          try {
            if (await swapToModel(candidate)) {
              if (persist) await persistAvatar(file);
              if (!quiet) XRA.toast(`Avatar attivo: ${filename}`);
              events.emit('avatar-changed', { name: filename, modelIndex: candidate });
              return true;
            }
          } catch (swapError) {
            // The model object can appear a little before its scene is fully
            // ready. Keep polling instead of failing the whole load immediately.
            console.debug(TAG, 'VRM detected but not ready to swap yet', candidate, swapError);
          }
        }
        await sleep(150);
      }

      // Some builds replace the active/default model in-place rather than add
      // an extra model. If the list itself changed, accept that as success.
      const afterModels = modelList();
      if (afterModels.length && (afterModels.length !== beforeModels.length || afterModels.some((m,i) => m !== beforeModels[i]))) {
        if (persist) await persistAvatar(file);
        if (!quiet) XRA.toast(`Avatar caricato: ${filename}`);
        events.emit('avatar-changed', { name: filename, modelIndex: -1 });
        return true;
      }

      throw new Error(`XR Animator ha ricevuto “${filename}”, ma non ha creato un nuovo modello entro 20 s`);
    }
    finally {
      vrmLoadBusy = false;
    }
  }

  function savedAvatarFilename() {
    return String(config.avatar?.filename || '').trim();
  }

  async function restoreSavedVrm() {
    if (vrmRestoreInFlight) return vrmRestoreInFlight;
    const filename = savedAvatarFilename();
    if (!filename) return false;

    vrmRestoreInFlight = (async () => {
      await XRA.whenNativeReady();
      if (vrmLoadBusy) return false;

      const existing = findModelByFilename(filename);
      if (existing >= 0 && await swapToModel(existing)) return true;

      const response = await fetch(`/__xra_avatar/${encodeURIComponent(filename)}`, { cache:'no-store' });
      if (!response.ok) throw new Error(`Avatar non trovato in avatars/: ${filename}. Caricalo di nuovo una volta: verrà copiato nella cartella dell’app e riusato agli avvii successivi.`);
      const blob = await response.blob();
      const file = new File([blob], filename, { type:blob.type || 'model/gltf-binary' });
      return loadVrmFile(file, { persist:false, quiet:true });
    })().catch(error => {
      console.error(TAG, 'saved VRM restore failed', error);
      XRA.toast(error.message || String(error), 'error', 6000);
      return false;
    }).finally(() => { vrmRestoreInFlight = null; });

    return vrmRestoreInFlight;
  }

  function ensureVrmInput() {
    if (xraVrmInput?.isConnected) return xraVrmInput;
    let input = document.getElementById('XRA_VRM_FILE_INPUT');
    if (!(input instanceof HTMLInputElement)) {
      input = document.createElement('input');
      input.id = 'XRA_VRM_FILE_INPUT';
      input.type = 'file';
      input.accept = '.vrm,.glb,.gltf,model/gltf-binary,model/gltf+json';
      input.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
      input.tabIndex = -1;
      document.body.appendChild(input);
    }
    input.onchange = async () => {
      const file = input.files?.[0] || null;
      try { if (file) await loadVrmFile(file); }
      catch (e) {
        console.error(TAG, 'VRM load failed', e);
        XRA.toast('VRM loader: ' + e.message, 'error', 6000);
      }
      finally { input.value = ''; }
    };
    xraVrmInput = input;
    return input;
  }

  async function openVrmPicker() {
    // Keep the file dialog on the original user click. The actual selected File
    // is then passed into SA_DragDropEMU by the onchange handler above.
    const input = ensureVrmInput();
    input.value = '';
    input.click();
    return true;
  }

  // The stock avatar medallion has a stable upstream id. The native quick menu
  // is the compact Restart/About/Folder/File strip. Hide those exact elements
  // rather than guessing based on dimensions/labels.
  function markAvatarBadge() {
    const node = document.getElementById('Cdungeon_status_bar');
    if (!node) return false;
    node.classList.add('xra-retired-avatar-badge');
    return true;
  }

  function markNativeTopBar() {
    const exact = [
      document.getElementById('Lquick_menu'),
      document.getElementById('Ldungeon_inventory'),
      document.getElementById('Ldungeon_inventory_backpack')
    ].filter(Boolean);
    exact.forEach(node => node.classList.add('xra-retired-native-topbar'));

    // Fallback for XR builds that render the model/restart/about strip in a
    // wrapper with no stable id. Find the smallest native container whose own
    // text/title contains the three concepts, and never touch our panels.
    let semantic = false;
    const nodes = document.querySelectorAll('div,nav,section,header,aside');
    for (const node of nodes) {
      if (node.closest?.('#XRA_CUSTOM_PANEL, #XRA_NATIVE_SETTINGS, .xra-overlay, .xra-recording-hud')) continue;
      const r = node.getBoundingClientRect?.();
      if (!r || r.width < 100 || r.height < 18 || r.height > 160 || r.top > 220) continue;
      const text = nodeLabel(node);
      const hasModel = /VRM\s*\/\s*MMD|\bVRM\b.*\bModel\b|\bMMD\b.*\bModel\b/i.test(text);
      const hasRestart = /restart|reload/i.test(text);
      const hasAbout = /about|info/i.test(text);
      if (hasModel && (hasRestart || hasAbout)) {
        node.classList.add('xra-retired-native-topbar');
        semantic = true;
        break;
      }
    }
    return exact.length > 0 || semantic;
  }

  function hideNativeShellChrome() {
    const top = markNativeTopBar();
    const badge = markAvatarBadge();
    return { top, badge };
  }

  // Keep XR Animator's native speech-bubble state machine alive (timers,
  // calibration progress and keyboard branches), but replace its 3D cloud art
  // with the same lightweight DOM language used by our side panels.
  function hideSpeechBubbleMesh(bubble) {
    if (!bubble) return;
    try {
      const mesh = window.MMD_SA?.THREEX?.mesh_obj
        ?.get?.('SpeechBubbleMESH' + (bubble.index || ''));
      if (typeof mesh?.hide === 'function') mesh.hide();
      else if (bubble._mesh) bubble._mesh.visible = false;
    }
    catch (e) {
      try { if (bubble._mesh) bubble._mesh.visible = false; } catch (ignore) {}
    }
  }

  function speechBubbleInteractive(bubble) {
    if (bubble?._branch_key_ != null) return true;
    return (bubble?.msg_obj || []).some(line => line?.branch_key != null || line?.b_list?.length);
  }

  function dispatchNativeKey(key) {
    key = String(key || '').trim().toUpperCase();
    if (!key) return false;
    const isDigit = /^\d$/.test(key);
    const code = isDigit ? `Digit${key}` : `Key${key}`;
    const keyCode = isDigit ? 48 + Number(key) : key.charCodeAt(0);
    try {
      const event = new KeyboardEvent('keydown', {
        key, code, bubbles: true, cancelable: true
      });
      // The legacy dungeon handler checks both modern `code` and the old
      // numeric fields depending on the selected branch type.
      for (const name of ['keyCode', 'which']) {
        if (!event[name]) Object.defineProperty(event, name, { value: keyCode });
      }
      document.dispatchEvent(event);
      return true;
    }
    catch (e) {
      console.warn(TAG, 'dialogue choice dispatch failed', key, e);
      return false;
    }
  }

  function speechBubbleContent(bubble) {
    const raw = String(bubble?.msg || '').trim();
    const branchPattern = /^([\dA-Z])\.\s*(.*)$/;
    const body = [];
    const actions = [];

    for (const line of raw.split(/\r?\n/)) {
      const match = branchPattern.exec(line.trim());
      if (!match) {
        body.push(line);
        continue;
      }
      const key = String(match[1] || '').toUpperCase();
      const label = String(match[2] || line).trim();
      actions.push({
        key,
        label: `${key} · ${label}`,
        onClick: () => dispatchNativeKey(key)
      });
    }

    return {
      message: body.join('\n').trim(),
      actions
    };
  }

  let calibrationNoticeSuppressedUntil = 0;

  function isCalibrationNotice(message) {
    return /(calibrat|mocap\s+initializ|face\s+data|press\s+x\s+to\s+abort)/i.test(String(message || ''));
  }

  function dismissCalibrationNotices() {
    // The native calibration uses bubbles 0 and 1. At 100% its final message
    // can be queued after the completion event, so suppress only calibration
    // text for a short grace period instead of hiding future generic notices.
    calibrationNoticeSuppressedUntil = performance.now() + 3500;
    const root = window.MMD_SA?.SpeechBubble;
    const list = Array.isArray(root?.list) ? root.list : (root ? [root] : []);
    list.forEach((bubble, index) => {
      const content = speechBubbleContent(bubble);
      if (index <= 1 || isCalibrationNotice(content.message)) {
        hideSpeechBubbleMesh(bubble);
        XRA.uiCore?.hideNativeNotice?.(`native-speech-${index}`);
      }
    });
    // Also covers a stale DOM notice left behind after the native object was
    // replaced and is no longer present in SpeechBubble.list.
    XRA.uiCore?.hideNativeNotice?.('native-speech-0');
    XRA.uiCore?.hideNativeNotice?.('native-speech-1');
    return true;
  }

  function syncSpeechBubbleNotice(bubble, index) {
    const id = `native-speech-${index}`;
    const content = speechBubbleContent(bubble);
    if (performance.now() < calibrationNoticeSuppressedUntil && (index <= 1 || isCalibrationNotice(content.message))) {
      hideSpeechBubbleMesh(bubble);
      XRA.uiCore?.hideNativeNotice?.(id);
      return;
    }
    if (!bubble?.visible || (!content.message && !content.actions.length)) {
      XRA.uiCore?.hideNativeNotice?.(id);
      return;
    }
    hideSpeechBubbleMesh(bubble);
    XRA.uiCore?.showNativeNotice?.(id, content.message, {
      title: 'XR Animator',
      interactive: speechBubbleInteractive(bubble),
      actions: content.actions
    });
  }

  function patchSpeechBubble(bubble, index) {
    if (!bubble || bubble._xraNoticePatched) return;
    bubble._xraNoticePatched = true;

    for (const method of ['show', 'message', 'hide']) {
      const original = bubble[method];
      if (typeof original !== 'function') continue;
      bubble[method] = function (...args) {
        const result = original.apply(this, args);
        if (method === 'show' || method === 'message') hideSpeechBubbleMesh(this);
        syncSpeechBubbleNotice(this, index);
        return result;
      };
    }
    syncSpeechBubbleNotice(bubble, index);
  }

  function installSpeechBubbleAdapter() {
    const root = window.MMD_SA?.SpeechBubble;
    const list = root?.list;
    if (!root) return false;
    if (Array.isArray(list) && list.length) list.forEach((bubble, index) => patchSpeechBubble(bubble, index));
    else patchSpeechBubble(root, 0);
    return true;
  }

  // The event is dispatched immediately before the native mesh is shown. A
  // microtask runs after that show() call but before paint, so even a newly
  // created/unpatched bubble never flashes for a visible frame.
  const onNativeSpeechChange = () => queueMicrotask(installSpeechBubbleAdapter);
  for (const suffix of ['', '0', '1', '2', '3']) {
    window.addEventListener(`SA_SpeechBubble_show${suffix}`, onNativeSpeechChange);
    window.addEventListener(`SA_SpeechBubble_hide${suffix}`, onNativeSpeechChange);
  }

  async function restartApp() {
    const control = nativeClickable(/\brestart\b|\breload\b/i);
    if (control) { control.click(); return true; }
    location.reload();
    return true;
  }

  function showAbout() {
    const control = nativeClickable(/\babout\b/i);
    if (control) { control.click(); return true; }
    XRA.toast('XR Animator · XRA');
    return true;
  }

  function openEvent(id, branch = 0) {
    const dungeon = window.MMD_SA_options?.Dungeon;
    if (!dungeon?.run_event) throw new Error('XR Animator event system not ready');
    return dungeon.run_event(id, branch);
  }

  function activeVideoTrack() {
    const c = window.System?._browser?.camera;
    const candidates = [
      c?.video_track,
      c?.video?.srcObject?.getVideoTracks?.()[0],
      c?.stream?.getVideoTracks?.()[0],
      window.MMD_SA?.WebXR?.user_camera?.stream?.getVideoTracks?.()[0],
      window.MMD_SA?.WebXR?.user_camera?.video?.srcObject?.getVideoTracks?.()[0]
    ].filter(Boolean);
    // After an explicit Stop, XR Animator can keep a reference to the ended
    // track while a newly started live track already exists elsewhere.
    return candidates.find(track => track.readyState === 'live') || candidates[0] || null;
  }

  function activeCamera() {
    const track = activeVideoTrack();
    const settings = track?.getSettings?.() || {};
    return {
      label: track?.label || '',
      deviceId: settings.deviceId || '',
      readyState: track?.readyState || ''
    };
  }

  function cameraRunning() {
    const track = activeVideoTrack();
    return !cameraSoftStopped && !!track && track.readyState === 'live' && track.enabled !== false;
  }

  function persistNativeCameraPreference(label = '') {
    label = String(label || '').trim();
    const options = window.MMD_SA_options;
    if (!options) return false;

    options.user_camera ||= {};
    options.user_camera.streamer_mode ||= {};
    options.user_camera.streamer_mode.camera_preference ||= {};
    options.user_camera.streamer_mode.camera_preference.label = label;

    // Keep the imported/exported native profile in sync when it already
    // exists. It may not be available yet while the startup card is open.
    const imported = options._XRA_settings_imported;
    if (imported) {
      imported.user_camera ||= {};
      imported.user_camera.streamer_mode ||= {};
      imported.user_camera.streamer_mode.camera_preference ||= {};
      imported.user_camera.streamer_mode.camera_preference.label = label;
    }
    return true;
  }

  function sortNativeCameraList(label = '') {
    label = String(label || '').trim().toLocaleLowerCase();
    const camera = window.System?._browser?.camera;
    const list = camera?.camera_list;
    if (!label || !Array.isArray(list) || list.length < 2) return false;

    // Native streamer mode opens the first matching entry. Stable ordering
    // preserves the browser's device order for every non-selected camera.
    const ranked = list.map((device, index) => ({
      device,
      index,
      selected: String(device?.label || '').toLocaleLowerCase().includes(label)
    }));
    ranked.sort((a, b) => Number(b.selected) - Number(a.selected) || a.index - b.index);
    camera.camera_list = ranked.map(entry => entry.device);
    return ranked[0]?.selected === true;
  }


  function isWebGLCanvas(node) {
    if (!(node instanceof HTMLCanvasElement)) return false;
    try { return !!(node.getContext('webgl2') || node.getContext('webgl') || node.getContext('experimental-webgl')); }
    catch (e) { return false; }
  }

  function previewVideos() {
    const out = [];
    const activeTrack = activeVideoTrack();
    const push = value => {
      if (!(value instanceof HTMLVideoElement) || out.includes(value)) return;
      out.push(value);
    };
    try { push(window.System?._browser?.camera?.video); } catch (e) {}
    try { push(window.System?._browser?.camera?.video_element); } catch (e) {}
    try { push(window.MMD_SA?.WebXR?.user_camera?.video); } catch (e) {}

    // Some XR Animator builds create the webcam <video> dynamically and do not
    // expose it through the objects above. Match the active MediaStream first;
    // fall back to camera-labelled video nodes only.
    document.querySelectorAll('video').forEach(video => {
      try {
        const tracks = video.srcObject?.getVideoTracks?.() || [];
        if (activeTrack && tracks.some(t => t === activeTrack || (t.id && t.id === activeTrack.id))) return push(video);
      } catch (e) {}
      const label = `${video.id || ''} ${video.className || ''} ${video.getAttribute?.('name') || ''}`;
      if (/(webcam|user.?camera|camera.?video|camera.?preview)/i.test(label)) push(video);
    });
    return out;
  }

  function nativeDisplayNode(kind) {
    const display = window.MMD_SA_options?.user_camera?.display;
    const value = display?.[kind];
    return value instanceof HTMLElement ? value : null;
  }

  function setElementVisible(node, visible, parentRx = null) {
    if (!(node instanceof HTMLElement)) return;
    node.hidden = !visible;
    if (!visible) {
      node.style.setProperty('display', 'none', 'important');
      return;
    }
    node.style.removeProperty('display');
    node.style.removeProperty('visibility');
    node.style.removeProperty('opacity');
    if (!parentRx) return;

    // Only reveal parents belonging to the same preview layer. The old broad
    // camera/debug matcher made enabling ML debug accidentally unhide webcam.
    let parent = node.parentElement;
    for (let i = 0; parent && i < 2; i++, parent = parent.parentElement) {
      const label = `${parent.id || ''} ${parent.className || ''}`;
      if (!parentRx.test(label)) continue;
      parent.hidden = false;
      parent.style.removeProperty('display');
      parent.style.removeProperty('visibility');
      parent.style.removeProperty('opacity');
    }
  }

  function overlayCanvasCandidates(kind) {
    const out = [];
    const push = value => {
      if (!(value instanceof HTMLCanvasElement) || out.includes(value) || isWebGLCanvas(value)) return;
      out.push(value);
    };
    const c = window.System?._browser?.camera;
    const uc = window.MMD_SA?.WebXR?.user_camera;
    for (const value of [
      c?.canvas, c?.canvas_debug, c?.poseNet?.canvas, c?.poseNet?.canvas_debug,
      c?.facemesh?.canvas, c?.handpose?.canvas,
      uc?.canvas, uc?.canvas_debug, uc?.poseNet?.canvas, uc?.facemesh?.canvas, uc?.handpose?.canvas
    ]) push(value);
    const rx = kind === 'wireframe' ? /(wire|pose|mocap|landmark)/i : /(debug|ml|pose|face|hand|landmark)/i;
    document.querySelectorAll('canvas').forEach(canvas => {
      const label = `${canvas.id || ''} ${canvas.className || ''}`;
      if (rx.test(label)) push(canvas);
    });
    return out;
  }

  // XR Animator's own Overlay & UI menu is the source of truth for preview
  // controls. In the native _SETTINGS_ event, keys 2/3/4 dispatch Camera,
  // Wireframe and Mocap Debug respectively. Calling the native action matters:
  // Mocap Debug also runs DEBUG_show(), which a bare debug_hidden assignment
  // does not do.
  function nativeOverlayAction(key, fallbackBranch) {
    const dungeon = window.MMD_SA_options?.Dungeon;
    const settings = dungeon?.events?._SETTINGS_;
    if (!settings) return null;

    let branchIndex = null;
    try {
      const menu = settings?.[11]?.[0]?.message;
      const branches = menu?.branch_list;
      const spec = Array.isArray(branches)
        ? branches.find(entry => String(entry?.key) === String(key))
        : null;
      branchIndex = spec?.branch_index ?? null;
    }
    catch (e) {}

    if (branchIndex == null) branchIndex = fallbackBranch;
    const event = settings?.[branchIndex]?.[0];
    return (typeof event?.func === 'function') ? event : null;
  }

  function invokeNativeOverlayAction(key, fallbackBranch) {
    const event = nativeOverlayAction(key, fallbackBranch);
    if (!event) return false;
    try {
      event.func.call(event);
      return true;
    }
    catch (e) {
      console.warn(TAG, 'native overlay action failed', key, e);
      return false;
    }
  }

  // The native "Camera display" flag is real, but in the current desktop
  // XR Animator renderer it is not a reliable visible webcam preview: the
  // renderer can overwrite/hide the native node on its next update.  Reuse the
  // *existing* live camera track in a small DOM video instead.  This does not
  // request a second webcam stream and never stops/clones the tracking track.
  let webcamPreviewVideo = null;

  function webcamPreviewNode() {
    if (webcamPreviewVideo?.isConnected) return webcamPreviewVideo;
    const existing = document.getElementById('XRA_WEBCAM_PREVIEW');
    if (existing instanceof HTMLVideoElement) {
      webcamPreviewVideo = existing;
      return existing;
    }

    const video = document.createElement('video');
    video.id = 'XRA_WEBCAM_PREVIEW';
    video.className = 'xra-webcam-preview';
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    try { video.disablePictureInPicture = true; } catch (e) {}
    video.setAttribute('aria-label', 'XR Animator webcam preview');
    video.hidden = true;
    document.body.appendChild(video);
    webcamPreviewVideo = video;
    return video;
  }

  function suppressNativeCameraPreview() {
    // Avoid a duplicate native preview if a future/native renderer happens to
    // honour the legacy flag. Our DOM preview is the single source of truth.
    try {
      const display = window.MMD_SA_options?.user_camera?.display;
      if (display?.video && !(display.video instanceof HTMLElement)) display.video.hidden = true;
    } catch (e) {}
  }

  function bindWebcamPreviewStream() {
    const video = webcamPreviewNode();
    const track = activeVideoTrack();
    if (!track || track.readyState !== 'live' || track.enabled === false || cameraSoftStopped) {
      video.hidden = true;
      try { video.pause(); } catch (e) {}
      return false;
    }

    let currentTrack = null;
    try { currentTrack = video.srcObject?.getVideoTracks?.()[0] || null; } catch (e) {}
    if (!currentTrack || currentTrack !== track || currentTrack.readyState !== 'live') {
      // Prefer an already-existing native MediaStream so audio/video ownership
      // and browser device state remain entirely with XR Animator.
      let stream = null;
      for (const source of previewVideos()) {
        if (source === video) continue;
        try {
          const sourceTrack = source.srcObject?.getVideoTracks?.()[0];
          if (sourceTrack === track || (sourceTrack?.id && sourceTrack.id === track.id)) {
            stream = source.srcObject;
            break;
          }
        } catch (e) {}
      }
      if (!stream) {
        try { stream = new MediaStream([track]); }
        catch (e) { console.warn(TAG, 'cannot bind webcam preview stream', e); }
      }
      if (stream) {
        try { video.srcObject = stream; } catch (e) { console.warn(TAG, 'cannot set webcam preview srcObject', e); }
      }
    }

    video.hidden = false;
    video.classList.toggle('xra-webcam-mirrored', !!config.devices?.mirror_preview);
    try {
      const play = video.play?.();
      if (play?.catch) play.catch(e => console.debug(TAG, 'webcam preview play deferred', e));
    } catch (e) {}
    suppressNativeCameraPreview();
    return true;
  }

  function setWebcamPreviewVisible(visible) {
    visible = !!visible;
    const video = webcamPreviewNode();
    suppressNativeCameraPreview();
    if (!visible) {
      video.hidden = true;
      try { video.pause(); } catch (e) {}
      return false;
    }

    // The native stream can become available a little after the UI toggle or
    // after a camera restart. Retry binding without opening a second capture.
    if (bindWebcamPreviewStream()) return true;
    for (const delay of [120, 450, 1000, 1800]) {
      setTimeout(() => {
        if (config.ui?.preview_video === true) bindWebcamPreviewStream();
      }, delay);
    }
    return true;
  }

  function getPreviewVisibility(kind) {
    const display = window.MMD_SA_options?.user_camera?.display;
    if (kind === 'video') return config.ui?.preview_video === true;
    if (kind === 'wireframe') return !display?.wireframe?.hidden;
    if (kind === 'debug') return !window.MMD_SA_options?.user_camera?.ML_models?.debug_hidden;
    return false;
  }

  function setNativeMocapDebug(visible, { forceRefresh = false } = {}) {
    const ml = window.MMD_SA_options?.user_camera?.ML_models;
    if (!ml) return false;
    const targetHidden = !visible;
    document.body?.classList.toggle('xra-native-debug-visible', !!visible);

    if (!!ml.debug_hidden !== targetHidden) {
      // Native branch 15 toggles debug_hidden AND calls DEBUG_show(). The
      // missing DEBUG_show() call is why the old custom OFF switch could leave
      // Hand-FPS / Face-FPS text stuck on screen.
      if (!invokeNativeOverlayAction(4, 15)) {
        ml.debug_hidden = targetHidden;
        try { window.DEBUG_show?.(); } catch (e) {}
      }
    }
    else if (forceRefresh) {
      // Re-run the debug renderer without changing the final state. Most
      // builds expose DEBUG_show globally; if not, a native double-toggle is a
      // safe fallback and ends on the same value.
      if (typeof window.DEBUG_show === 'function') {
        try { window.DEBUG_show(); } catch (e) {}
      }
      else {
        const first = invokeNativeOverlayAction(4, 15);
        if (first) invokeNativeOverlayAction(4, 15);
      }
    }

    return !!ml.debug_hidden === targetHidden;
  }

  function setPreviewVisibility(kind, visible, { remember = true, forceRefresh = false } = {}) {
    visible = !!visible;
    config.ui ||= {};

    if (kind === 'video') {
      if (remember) config.ui.preview_video = visible;
      setWebcamPreviewVisible(visible);
    }
    else if (kind === 'wireframe') {
      if (remember) config.ui.preview_wireframe = visible;
      // Wireframe was already verified working in our panel. Keep its proven
      // path untouched rather than introducing a regression here.
      const display = window.MMD_SA_options?.user_camera?.display;
      if (display?.wireframe && !(display.wireframe instanceof HTMLElement)) {
        try { display.wireframe.hidden = !visible; } catch (e) {}
      }
      const nativeNode = nativeDisplayNode('wireframe');
      if (nativeNode) setElementVisible(nativeNode, visible, /(wire|pose|mocap|landmark|preview)/i);
      for (const node of overlayCanvasCandidates('wireframe')) setElementVisible(node, visible, /(wire|pose|mocap|landmark)/i);
    }
    else if (kind === 'debug') {
      if (remember) config.ui.preview_debug = visible;
      setNativeMocapDebug(visible, { forceRefresh });
    }

    events.emit('preview-visibility', { kind, visible: getPreviewVisibility(kind) });
    return getPreviewVisibility(kind);
  }

  function restorePreviewVisibility({ forceRefresh = false } = {}) {
    const ui = config.ui || {};
    const display = window.MMD_SA_options?.user_camera?.display;

    const video = typeof ui.preview_video === 'boolean'
      ? ui.preview_video
      : false;
    const wire = typeof ui.preview_wireframe === 'boolean'
      ? ui.preview_wireframe
      : !display?.wireframe?.hidden;
    const debug = typeof ui.preview_debug === 'boolean'
      ? ui.preview_debug
      : false;

    setPreviewVisibility('video', video, { remember: false, forceRefresh });
    setPreviewVisibility('wireframe', wire, { remember: false });
    setPreviewVisibility('debug', debug, { remember: false, forceRefresh });
    return { video: getPreviewVisibility('video'), wireframe: getPreviewVisibility('wireframe'), debug: getPreviewVisibility('debug') };
  }

  function schedulePreviewRestore() {
    // Reconcile after camera startup/restart without CSS forcing. Native camera
    // initialization can overwrite display flags once while the stream comes up.
    for (const [index, delay] of [100, 600, 1500].entries()) setTimeout(() => {
      try { restorePreviewVisibility({ forceRefresh: index === 1 }); } catch (e) {}
    }, delay);
  }

  function applyWebcamMirror(value = config.devices?.mirror_preview) {
    value = !!value;
    for (const video of previewVideos()) video.classList.toggle('xra-webcam-mirrored', value);
    try { webcamPreviewNode().classList.toggle('xra-webcam-mirrored', value); } catch (e) {}
    return value;
  }

  async function setWebcamMirror(value) {
    config.devices ||= {};
    config.devices.mirror_preview = !!value;
    applyWebcamMirror(value);
    await XRA.profileService.save();
    events.emit('camera-mirror', !!value);
    return !!value;
  }

  function applyWebcamSelfie(value = config.devices?.selfie_mode) {
    value = !!value;
    const uc = window.MMD_SA?.WebXR?.user_camera;
    if (uc) uc.video_flipped = value;
    return value;
  }

  async function setWebcamSelfie(value) {
    return runCameraOp('selfie', async () => {
      config.devices ||= {};
      config.devices.selfie_mode = !!value;
      const uc = window.MMD_SA?.WebXR?.user_camera;
      if (uc) {
        // video_flipped is live; calling user_camera.start() here also opens
        // XR Animator's legacy webcam-selection/calibration speech bubble.
        // The flip is already effective without restarting the camera.
        uc.video_flipped = !!value;
      }
      applyWebcamMirror();
      schedulePreviewRestore();
      await XRA.profileService.save();
      events.emit('camera-selfie', !!value);
      return !!value;
    });
  }

  function cameraVideoTracks() {
    const tracks = new Set();
    const addStream = stream => stream?.getVideoTracks?.().forEach(track => tracks.add(track));
    const c = window.System?._browser?.camera;
    if (c?.video_track) tracks.add(c.video_track);
    addStream(c?.video?.srcObject);
    addStream(c?.stream);
    addStream(window.MMD_SA?.WebXR?.user_camera?.stream);
    addStream(window.MMD_SA?.WebXR?.user_camera?.video?.srcObject);
    return [...tracks];
  }

  function previewHealth() {
    const track = activeVideoTrack();
    const videos = previewVideos();
    const live = !!track && track.readyState === 'live' && track.enabled !== false && !cameraSoftStopped;
    const playing = videos.some(video => {
      try {
        const streamTrack = video.srcObject?.getVideoTracks?.()[0];
        const sameOrLive = !streamTrack || streamTrack.readyState === 'live';
        return sameOrLive && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      } catch (e) { return false; }
    });
    // Some XR Animator layouts do not expose a visible HTMLVideoElement even
    // though the camera track is healthy. In that case a live, unmuted track
    // is sufficient.
    const healthy = live && (playing || (!videos.length && !track.muted));
    return { healthy, live, playing, muted: !!track?.muted, readyState: track?.readyState || '', track };
  }

  async function waitForHealthyCamera(label = '', timeout = 6500) {
    const started = performance.now();
    let last = activeCamera();
    let health = previewHealth();
    while (performance.now() - started < timeout) {
      last = activeCamera();
      health = previewHealth();
      const labelOk = !label || String(last.label || '').includes(label);
      if (last.readyState === 'live' && labelOk && health.healthy) return { ...last, healthy: true };
      // A live camera with valid track but video element not painted yet is
      // accepted after a short grace period to avoid false restart loops.
      if (last.readyState === 'live' && labelOk && performance.now() - started > 1800 && !health.muted) {
        return { ...last, healthy: true };
      }
      await util.sleep(120);
    }
    return { ...last, healthy: false, health };
  }

  async function startNativeUntilCameraReady(camera, timeout = 6500) {
    const label = config.devices?.camera_label || '';
    const healthPromise = waitForHealthyCamera(label, timeout);
    const nativeOutcome = Promise.resolve()
      .then(() => camera.streamer_mode.start())
      .then(() => ({ kind:'native' }), error => ({ kind:'error', error }));
    const first = await Promise.race([
      nativeOutcome,
      healthPromise.then(active => ({ kind:'camera', active }))
    ]);
    if (first.kind === 'error') throw first.error;

    // Native start intentionally waits for the first face/body detections, not
    // merely for the webcam. Let the UI continue as soon as the video track is
    // healthy while mocap initialization finishes in the background.
    const active = first.kind === 'camera' ? first.active : await healthPromise;
    if (!active.healthy) throw new Error('Webcam did not start');
    if (first.kind === 'camera') {
      XRA.debug?.record('camera.native-start-pending-mocap', { state:cameraDebugState() });
    }
    return active;
  }

  async function _stopNativeStreamer() {
    const c = window.System?._browser?.camera;
    if (!c?.streamer_mode) throw new Error('Native streamer mode not ready');

    // IMPORTANT: do not call MediaStreamTrack.stop(). XR Animator keeps native
    // references to that track; ending it makes a later Start unreliable/black.
    // enabled=false is reversible and normally releases camera capture work while
    // preserving the native stream graph.
    cameraSoftStopped = true;
    for (const track of cameraVideoTracks()) {
      try { track.enabled = false; } catch (e) {}
    }
    for (const video of previewVideos()) {
      try { video.pause?.(); } catch (e) {}
    }
    await util.sleep(80);
    events.emit('camera-stopped');
    return activeCamera();
  }

  async function stopNativeStreamer() {
    return runCameraOp('stop', () => _stopNativeStreamer());
  }

  async function resumeExistingCamera() {
    const tracks = cameraVideoTracks().filter(track => track?.readyState === 'live');
    if (!tracks.length) return null;
    for (const track of tracks) {
      try { track.enabled = true; } catch (e) {}
    }
    cameraSoftStopped = false;
    for (const video of previewVideos()) {
      try { await video.play?.(); } catch (e) {}
    }
    const active = await waitForHealthyCamera(config.devices?.camera_label || '', 2200);
    if (active.healthy) {
      applyWebcamMirror();
      applyWebcamSelfie();
      schedulePreviewRestore();
      return active;
    }
    return null;
  }

  async function _restartNativeStreamer({ recovery = false } = {}) {
    const c = window.System?._browser?.camera;
    if (!c?.streamer_mode) throw new Error('Native streamer mode not ready');
    XRA.performance?.prepareStartupMocap?.('native-bridge-restart');

    if (window.MMD_SA_options?.Dungeon?.event_mode) {
      try { XRA.uiCore?.sendEscape?.(); } catch (e) {}
      await util.sleep(50);
    }

    // If XR Animator exposes its own stop(), use that for an explicit Restart;
    // never manually end MediaStreamTracks.
    try {
      if (typeof c.streamer_mode.stop === 'function') {
        await c.streamer_mode.stop();
        await util.sleep(180);
      }
      else {
        cameraSoftStopped = true;
        for (const track of cameraVideoTracks()) {
          try { track.enabled = false; } catch (e) {}
        }
        await util.sleep(100);
      }
    } catch (e) { console.warn(TAG, 'native restart stop failed', e); }

    cameraSoftStopped = false;
    let directError = null;
    if (typeof c.streamer_mode.start === 'function') {
      try {
        const active = await startNativeUntilCameraReady(c, recovery ? 5000 : 6500);
        // A native start can reuse the old live track; make sure it is enabled.
        for (const track of cameraVideoTracks()) {
          if (track?.readyState === 'live') { try { track.enabled = true; } catch (e) {} }
        }
        if (active.healthy) {
          applyWebcamMirror();
          applyWebcamSelfie();
          schedulePreviewRestore();
          return active;
        }
      } catch (e) { directError = e; }
    }

    // Compatibility fallback: invoke the native streamer inventory action once.
    try {
      const inv = window.MMD_SA_options?.Dungeon?.inventory?.find?.('streamer_mode');
      if (inv) {
        const actionable = await inv.action_check?.();
        if (actionable !== false && typeof inv.item?.action?.func === 'function') {
          await inv.item.action.func(inv.item);
          for (const track of cameraVideoTracks()) {
            if (track?.readyState === 'live') { try { track.enabled = true; } catch (e) {} }
          }
          const active = await waitForHealthyCamera(config.devices?.camera_label || '', 6500);
          if (active.healthy) {
            applyWebcamMirror();
            applyWebcamSelfie();
            schedulePreviewRestore();
            return active;
          }
        }
      }
    } catch (e) {
      console.warn(TAG, 'inventory restart fallback failed', e);
      directError ||= e;
    }

    throw directError || new Error('Webcam restart did not produce a healthy video stream');
  }

  async function restartNativeStreamer() {
    return runCameraOp('restart', async () => {
      const active = await _restartNativeStreamer();
      events.emit('camera-started', active);
      return active;
    });
  }

  async function _startNativeStreamer() {
    await XRA.whenNativeReady();
    XRA.performance?.prepareStartupMocap?.('native-bridge-start');
    XRA.performance?.installStartupMocapStartGuard?.();
    XRA.performance?.ensureStartupCalibrationBoost?.();

    // Fast/reliable path after our Stop: revive the exact same native stream.
    const resumed = await resumeExistingCamera();
    if (resumed) return resumed;

    cameraSoftStopped = false;
    const active = activeCamera();
    if (active.readyState === 'live') {
      for (const track of cameraVideoTracks()) {
        if (track?.readyState === 'live') { try { track.enabled = true; } catch (e) {} }
      }
      for (const video of previewVideos()) { try { await video.play?.(); } catch (e) {} }
      const healthy = await waitForHealthyCamera(config.devices?.camera_label || '', 1800);
      if (healthy.healthy) {
        applyWebcamMirror(); applyWebcamSelfie(); schedulePreviewRestore();
        return healthy;
      }
    }

    // Cold start: use XR Animator's intended native entry point directly.
    const c = window.System?._browser?.camera;
    if (!c?.streamer_mode || typeof c.streamer_mode.start !== 'function') throw new Error('Native streamer start is not ready');
    const started = await startNativeUntilCameraReady(c, 6500);
    for (const track of cameraVideoTracks()) {
      if (track?.readyState === 'live') { try { track.enabled = true; } catch (e) {} }
    }
    applyWebcamMirror();
    applyWebcamSelfie();
    schedulePreviewRestore();
    return started;
  }

  async function startNativeStreamer() {
    return runCameraOp('start', async () => {
      const active = await _startNativeStreamer();
      events.emit('camera-started', active);
      return active;
    });
  }

  async function enumerateCameras({ requestPermission = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return [];

    let devices = await navigator.mediaDevices.enumerateDevices();
    let cameras = devices.filter(d => d.kind === 'videoinput');

    // Do not open a second temporary camera stream while XR Animator already
    // owns a webcam. Some Linux/V4L2 devices expose only one capture handle and
    // the permission probe can blank the existing stream.
    if (requestPermission && cameras.length && cameras.every(d => !d.label) && activeCamera().readyState !== 'live') {
      let temp = null;
      try { temp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      finally { temp?.getTracks?.().forEach(t => t.stop()); }
      devices = await navigator.mediaDevices.enumerateDevices();
      cameras = devices.filter(d => d.kind === 'videoinput');
    }

    return cameras.map((d, i) => ({
      deviceId: d.deviceId,
      groupId: d.groupId,
      label: d.label || `Camera ${i + 1}`
    }));
  }

  function constraintsMatchSettings(constraints, settings) {
    if (!constraints || !settings) return false;
    const val = x => (x && typeof x === 'object') ? (x.exact ?? x.ideal ?? x.max ?? x.min) : x;
    const pairs = [
      ['width', Number(settings.width || 0)],
      ['height', Number(settings.height || 0)],
      ['frameRate', Number(settings.frameRate || 0)]
    ];
    let compared = 0;
    for (const [key, current] of pairs) {
      const requested = Number(val(constraints[key]) || 0);
      if (!requested || !current) continue;
      compared++;
      const tolerance = key === 'frameRate' ? 1.5 : 2;
      if (Math.abs(requested - current) > tolerance) return false;
    }
    return compared > 0;
  }

  async function _applyCameraConstraintsSafe(constraints, { recover = true } = {}) {
    const track = activeVideoTrack();
    if (!track || track.readyState !== 'live' || typeof track.applyConstraints !== 'function' || !constraints) return false;
    const before = track.getSettings?.() || {};
    if (constraintsMatchSettings(constraints, before)) return true;

    try {
      await track.applyConstraints(constraints);
      const healthy = await waitForHealthyCamera('', 1800);
      if (healthy.healthy) {
        events.emit('camera-constraints', { ok: true, settings: track.getSettings?.() || {} });
        return true;
      }
      throw new Error('Camera became unhealthy after applying constraints');
    }
    catch (error) {
      console.warn(TAG, 'camera constraints failed/unhealthy; rolling back', error);
      try {
        const rollback = {};
        if (before.width) rollback.width = { ideal: before.width };
        if (before.height) rollback.height = { ideal: before.height };
        if (before.frameRate) rollback.frameRate = { ideal: before.frameRate };
        if (Object.keys(rollback).length && track.readyState === 'live') await track.applyConstraints(rollback);
      } catch (rollbackError) { console.warn(TAG, 'camera constraint rollback failed', rollbackError); }

      if (recover) {
        try {
          const recovered = await _restartNativeStreamer({ recovery: true });
          events.emit('camera-recovered', { reason: 'constraints', camera: recovered });
          XRA.toast('Webcam recovered after an unsupported/unstable setting.', 'info', 3500);
          return true;
        } catch (recoveryError) {
          events.emit('camera-recovery-error', recoveryError);
          throw recoveryError;
        }
      }
      throw error;
    }
  }

  async function applyCameraConstraintsSafe(constraints, options = {}) {
    return runCameraOp('constraints', () => _applyCameraConstraintsSafe(constraints, options));
  }

  async function ensureCameraHealthy({ recover = false } = {}) {
    const health = previewHealth();
    if (health.healthy) return true;
    if (!recover || activeCamera().readyState !== 'live') return false;
    return runCameraOp('health-recovery', async () => {
      const again = previewHealth();
      if (again.healthy) return true;
      await _restartNativeStreamer({ recovery: true });
      events.emit('camera-recovered', { reason: 'health-check', camera: activeCamera() });
      return true;
    });
  }


  async function setCameraPreference({ deviceId = '', label = '' } = {}) {
    config.devices ||= {};
    config.devices.camera_device_id = deviceId || '';
    config.devices.camera_label = label || '';
    persistNativeCameraPreference(label);
    sortNativeCameraList(label);
    await XRA.profileService.save(0);
    events.emit('camera-preference', { deviceId, label });
    return { deviceId, label };
  }

  async function switchCamera({ deviceId = '', label = '' } = {}) {
    return runCameraOp('switch-device', async () => {
      await XRA.whenNativeReady();

      config.devices ||= {};
      config.devices.camera_device_id = deviceId || '';
      config.devices.camera_label = label || '';
      persistNativeCameraPreference(label);
      sortNativeCameraList(label);
      await XRA.profileService.save(0);
      events.emit('camera-switching', { deviceId, label });

      try {
        const active = await _restartNativeStreamer();
        const ok = active.readyState === 'live' && (!label || String(active.label || '').includes(label));
        if (!ok) throw new Error(`Requested “${label || 'default'}”, active camera is “${active.label || 'unknown'}”`);

        config.devices.camera_device_id = active.deviceId || deviceId || '';
        config.devices.camera_label = active.label || label || '';
        applyWebcamMirror();
        await XRA.profileService.save(0);
        events.emit('camera-switched', active);
        XRA.toast(`Webcam attiva: ${active.label || 'default'}`);
        return active;
      }
      catch (e) {
        events.emit('camera-switch-error', e);
        XRA.toast('Cambio webcam fallito: ' + e.message, 'error', 5000);
        throw e;
      }
    });
  }


  XRA.nativeBridge = {
    item,
    invokeItem,
    openEvent,
    activeCamera,
    enumerateCameras,
    switchCamera,
    setCameraPreference,
    restartNativeStreamer,
    startNativeStreamer,
    stopNativeStreamer,
    setWebcamMirror,
    applyWebcamMirror,
    setWebcamSelfie,
    applyWebcamSelfie,
    cameraRunning,
    getPreviewVisibility,
    setPreviewVisibility,
    restorePreviewVisibility,
    applyCameraConstraintsSafe,
    ensureCameraHealthy,
    cameraHealth: previewHealth,
    cameraBusy: () => cameraBusy,
    openVrmPicker,
    restoreSavedVrm,
    hideNativeShellChrome,
    dismissCalibrationNotices,
    restartApp,
    showAbout
  };

  window.addEventListener('MMDStarted', () => setTimeout(() => {
    applyWebcamMirror();
    applyWebcamSelfie();
    restorePreviewVisibility({ forceRefresh: true });
    restoreSavedVrm();
  }, 900));
  window.addEventListener('MMDStarted', () => {
    for (const delay of [0, 120, 500, 1500]) setTimeout(installSpeechBubbleAdapter, delay);
  });
  events.on('camera-stopped', () => {
    try {
      const video = webcamPreviewNode();
      video.hidden = true;
      video.pause?.();
    } catch (e) {}
  });
  events.on('camera-started', () => {
    if (config.ui?.preview_video === true) setWebcamPreviewVisible(true);
  });
  events.on('calibrated', dismissCalibrationNotices);

  events.on('profile-loaded', () => {
    setTimeout(() => { applyWebcamMirror(); applyWebcamSelfie(); }, 250);
    setTimeout(() => restorePreviewVisibility({ forceRefresh: true }), 500);
    setTimeout(restoreSavedVrm, 900);
  });

  const refreshNativeShell = () => { try { return hideNativeShellChrome(); } catch (e) { return { top:false, badge:false }; } };
  function watchNativeShell() {
    refreshNativeShell();
    if (!document.body || typeof MutationObserver !== 'function') return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const state = refreshNativeShell();
        if (state.top && state.badge) observer.disconnect();
      }, 60);
    });
    observer.observe(document.body, { childList:true, subtree:true });
    setTimeout(() => observer.disconnect(), 15000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(watchNativeShell, 80), { once:true });
  else setTimeout(watchNativeShell, 80);
  window.addEventListener('MMDStarted', () => setTimeout(refreshNativeShell, 250));

})();
