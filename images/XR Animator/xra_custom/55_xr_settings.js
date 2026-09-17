(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA XR SETTINGS]';
  const { config, defaults, events } = XRA;
  const UI = XRA.uiCore;
  const { el, button, select, row, details, bindRefresh, refreshAll, stopInputPropagation } = UI;

  let root = null;
  let drawer = null;
  let nativeJson = null;
  let opened = false;

  function camera() { return window.System?._browser?.camera || null; }
  function pose() { return camera()?.poseNet || null; }
  function hands() { return camera()?.handpose || null; }
  function face() { return camera()?.facemesh || null; }
  function poseOptions() { return window.MMD_SA_options?.user_camera?.ML_models?.pose || null; }
  function handOptions() { return window.MMD_SA_options?.user_camera?.ML_models?.hands || null; }

  function clone(value) {
    if (value && typeof value === 'object') {
      try { return structuredClone(value); }
      catch (e) { return JSON.parse(JSON.stringify(value)); }
    }
    return value;
  }

  const persistedLeftControls = new Map();
  function persistKey(parent, label) {
    const sections = [];
    let node = parent;
    while (node) {
      const d = node.closest?.('details');
      if (!d) break;
      const title = d.querySelector?.(':scope > summary')?.textContent?.trim();
      if (title) sections.unshift(title);
      node = d.parentElement;
    }
    return `${sections.join(' > ') || 'XR Settings'}::${label}`.replace(/\s+/g, ' ').trim();
  }
  function registerPersistentLeftControl(parent, label, get, set) {
    config.left_settings ||= {};
    const key = persistKey(parent, label);
    const adapter = { key, get, set };
    persistedLeftControls.set(key, adapter);
    if (Object.prototype.hasOwnProperty.call(config.left_settings, key)) {
      queueMicrotask(() => {
        try { set(clone(config.left_settings[key])); }
        catch (e) { console.warn(TAG, 'restore left setting failed:', key, e); }
      });
    }
    return () => {
      try { config.left_settings[key] = clone(get()); }
      catch (e) { console.warn(TAG, 'persist left setting failed:', key, e); }
    };
  }
  function snapshotPersistedLeftState() {
    config.left_settings ||= {};
    // Settings removed or moved to another section used to remain forever in
    // the profile. Besides being confusing during audits, some old profiles
    // contained duplicate copies of wireframe, hand-camera and VRM controls.
    for (const key of Object.keys(config.left_settings)) {
      if (!persistedLeftControls.has(key)) delete config.left_settings[key];
    }
    for (const [key, adapter] of persistedLeftControls) {
      try { config.left_settings[key] = clone(adapter.get()); }
      catch (e) { console.warn(TAG, 'snapshot left setting failed:', key, e); }
    }
    return config.left_settings;
  }

  function restorePersistedLeftState() {
    for (const [key, adapter] of persistedLeftControls) {
      if (!Object.prototype.hasOwnProperty.call(config.left_settings || {}, key)) continue;
      try { adapter.set(clone(config.left_settings[key])); }
      catch (e) { console.warn(TAG, 'restore left setting failed:', key, e); }
    }
    // Explicit custom states that are deliberately outside the native export.
    // Webcam selfie is restored by nativeBridge against user_camera.video_flipped.
    try { XRA.nativeBridge?.applyWebcamSelfie?.(); } catch (e) {}
    XRA.tracking?.restoreRuntime?.();
    refreshAll();
  }

  async function saveNative() {
    await XRA.profileService.save();
    refreshAll();
  }

  function sessionReset(get, set) {
    let captured = false;
    let baseline;
    const ensure = () => {
      if (!captured) {
        baseline = clone(get());
        captured = true;
      }
      return baseline;
    };
    queueMicrotask(ensure);
    return {
      reset: async () => { set(clone(ensure())); await saveNative(); },
      isDefault: () => {
        try { return XRA.util.same(get(), ensure()); }
        catch (e) { return false; }
      },
      title: 'Ripristina il valore presente all’apertura di XR Settings'
    };
  }

  function addToggle(parent, label, get, set, sub = '') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    bindRefresh(() => { input.checked = !!get(); });
    const persist = registerPersistentLeftControl(parent, label, get, set);
    input.onchange = async () => { set(!!input.checked); persist(); await saveNative(); };
    const resetInfo = sessionReset(get, set);
    const originalReset = resetInfo.reset; resetInfo.reset = async () => { await originalReset(); persist(); };
    const r = row(parent, label, input, { reset: resetInfo.reset, isDefault: resetInfo.isDefault, sub });
    r.querySelector('.xra-reset')?.setAttribute('title', resetInfo.title);
    r.classList.add('xra-native-row');
    return r;
  }

  function addSelect(parent, label, options, get, set, sub = '') {
    const input = select(options);
    bindRefresh(() => {
      const value = get();
      input.value = String(value == null ? '__null__' : value);
    });
    const persist = registerPersistentLeftControl(parent, label, get, set);
    input.onchange = async () => {
      const option = input.value === '__null__' ? null : input.value;
      const match = options.find(([v]) => String(v == null ? '__null__' : v) === input.value)?.[0];
      set(match === undefined ? option : match);
      persist();
      await saveNative();
    };
    const resetInfo = sessionReset(get, set);
    const originalReset = resetInfo.reset; resetInfo.reset = async () => { await originalReset(); persist(); };
    const r = row(parent, label, input, { reset: resetInfo.reset, isDefault: resetInfo.isDefault, sub });
    r.querySelector('.xra-reset')?.setAttribute('title', resetInfo.title);
    r.classList.add('xra-native-row');
    return r;
  }

  function addRange(parent, label, get, set, { min = 0, max = 100, step = 1, suffix = '%', sub = '' } = {}) {
    const wrap = el('div', 'xra-stack-control');
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    const text = el('div', 'xra-sub');
    wrap.append(input, text);
    bindRefresh(() => {
      const value = Number(get() ?? 0);
      input.value = String(value);
      text.textContent = `${value}${suffix}`;
    });
    input.oninput = () => {
      const value = Number(input.value);
      set(value);
      text.textContent = `${value}${suffix}`;
    };
    const persist = registerPersistentLeftControl(parent, label, get, set);
    input.onchange = async () => { persist(); await saveNative(); };
    const resetInfo = sessionReset(get, set);
    const originalReset = resetInfo.reset; resetInfo.reset = async () => { await originalReset(); persist(); };
    const r = row(parent, label, wrap, { reset: resetInfo.reset, isDefault: resetInfo.isDefault, sub });
    r.querySelector('.xra-reset')?.setAttribute('title', resetInfo.title);
    r.classList.add('xra-native-row');
    return r;
  }

  function addNumber(parent, label, get, set, { min = null, max = null, step = 1, sub = '' } = {}) {
    const input = document.createElement('input');
    input.type = 'number'; input.className = 'xra-control';
    if (min != null) input.min = String(min);
    if (max != null) input.max = String(max);
    input.step = String(step);
    bindRefresh(() => { input.value = String(get() ?? ''); });
    const persist = registerPersistentLeftControl(parent, label, get, set);
    input.onchange = async () => { set(input.value === '' ? null : Number(input.value)); persist(); await saveNative(); };
    const resetInfo = sessionReset(get, set);
    const originalReset = resetInfo.reset; resetInfo.reset = async () => { await originalReset(); persist(); };
    const r = row(parent, label, input, { reset: resetInfo.reset, isDefault: resetInfo.isDefault, sub });
    r.querySelector('.xra-reset')?.setAttribute('title', resetInfo.title);
    r.classList.add('xra-native-row');
    return r;
  }

  function addText(parent, label, get, set, sub = '') {
    const input = stopInputPropagation(document.createElement('input'));
    input.type = 'text'; input.className = 'xra-control';
    bindRefresh(() => { input.value = String(get() ?? ''); });
    const persist = registerPersistentLeftControl(parent, label, get, set);
    input.onchange = async () => { set(input.value); persist(); await saveNative(); };
    const resetInfo = sessionReset(get, set);
    const originalReset = resetInfo.reset; resetInfo.reset = async () => { await originalReset(); persist(); };
    const r = row(parent, label, input, { reset: resetInfo.reset, isDefault: resetInfo.isDefault, sub });
    r.querySelector('.xra-reset')?.setAttribute('title', resetInfo.title);
    r.classList.add('xra-native-row');
    return r;
  }


  function commandButton(parent, label, fn, { danger = false, sub = '' } = {}) {
    const wrap = el('div', 'xra-command-wrap');
    const b = button(label, 'xra-action' + (danger ? ' danger' : ''));
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); }
      catch (e) {
        console.error(TAG, label, e);
        XRA.toast(`${label}: ${e.message}`, 'error', 4500);
      }
      finally { b.disabled = false; refreshAll(); }
    };
    wrap.appendChild(b);
    if (sub) wrap.appendChild(el('div', 'xra-sub', sub));
    parent.appendChild(wrap);
    return b;
  }

  function addAvatarApp(content) {
    const box = details(content, '👤 Avatar / app', { open: true });
    box.body.appendChild(el('div', 'xra-note', 'The selected VRM is saved in the app avatars/ folder. Use this button whenever you want to change avatar.'));

    commandButton(box.body, 'Load / change VRM…', async () => {
      await XRA.nativeBridge?.openVrmPicker?.();
    }, { sub: 'Opens the VRM model picker directly.' });

    addRange(box.body, 'VRM joint stiffness',
      () => Number(window.MMD_SA?.THREEX?.VRM?.joint_stiffness_percent || 0),
      value => { if (window.MMD_SA?.THREEX?.VRM) MMD_SA.THREEX.VRM.joint_stiffness_percent = value; },
      { min: 0, max: 200, step: 5 });

    const actions = el('div', 'xra-actions');
    const restart = button('↻ Restart XR Animator');
    restart.onclick = () => XRA.nativeBridge?.restartApp?.();
    const about = button('About');
    about.onclick = () => XRA.nativeBridge?.showAbout?.();
    actions.append(restart, about);
    box.body.appendChild(actions);
  }

  function addUIAndOverlays(content) {
    const box = details(content, '🖥 UI & overlays', { open: true });

    const language = select(XRA.i18n?.LANGUAGES || [['auto', 'Auto / System'], ['en', 'English'], ['it', 'Italiano']]);
    bindRefresh(() => { language.value = config.ui?.language || 'auto'; });
    language.onchange = async () => {
      XRA.i18n?.setLanguage?.(language.value);
      await XRA.profileService.save();
      refreshAll();
    };
    row(box.body, 'Language', language, {
      reset: async () => XRA.i18n?.setLanguage?.(defaults.ui.language || 'auto'),
      isDefault: () => (config.ui?.language || 'auto') === (defaults.ui.language || 'auto'),
      sub: 'Auto follows the browser/system language. Unsupported strings fall back safely to English/source text.'
    });

    const note = el('div', 'xra-note',
      'Controls are available directly in this panel for a clean, immediate setup.');
    box.body.appendChild(note);
  }

  function addPose(content) {
    const box = details(content, '🎭 Pose', { open: true });
    const current = el('div', 'xra-status');
    const poseSelect = select([['', 'Loading poses…']]);
    let poseBusy = false;
    let poseRequestSequence = 0;
    let restoringSavedPose = false;

    function poseList() {
      const useTracked = !!(
        window.System?._browser?.camera?.poseNet?.enabled ||
        window.System?._browser?.camera?.VMC_receiver?.mocap_enabled ||
        window.System?._browser?.camera?.VMC_receiver?.bone_enabled
      );
      return window.MMD_SA_options?._XRA_pose_list?.[useTracked ? 2 : 1] || [];
    }

    // Never use the visible array index as the persistent identity. XR Animator
    // can reorder the native pose lists. stand_simple also exists twice (full /
    // upper body), so name alone is not sufficient either.
    function poseKey(m) {
      if (!m) return '';
      return [
        String(m.name || ''),
        m.is_full_body ? 'full' : 'upper',
        Number.isFinite(Number(m.index_default)) ? String(m.index_default) : '',
        String(m.path || '')
      ].join('::');
    }

    function isCurrentPose(m) {
      const mm = window.MMD_SA?.MMD?.motionManager;
      if (!mm || !m || mm.filename !== m.name) return false;
      if (m.name !== 'stand_simple') return true;
      const upper = !!mm.para_SA?.motion_tracking_upper_body_only;
      return m.is_full_body ? !upper : upper;
    }

    function resolvePoseByKey(key) {
      const list = poseList();
      let index = list.findIndex(m => poseKey(m) === key);
      if (index >= 0) return { list, index, pose: list[index] };

      // Backward/fallback identity for custom poses that may get a late
      // index_default when loaded.
      const [name, bodyKind] = String(key || '').split('::');
      index = list.findIndex(m => m?.name === name && ((m?.is_full_body ? 'full' : 'upper') === bodyKind));
      return { list, index, pose: index >= 0 ? list[index] : null };
    }

    async function waitForPose(target, timeout = 2200) {
      const started = performance.now();
      while (performance.now() - started < timeout) {
        if (isCurrentPose(target)) return true;
        await XRA.util.sleep(50);
      }
      return isCurrentPose(target);
    }

    function preparePoseVariant(target) {
      if (!target || target.name !== 'stand_simple') return;
      const motion = window.MMD_SA_options?.motion_para?.stand_simple;
      if (motion) motion.center_view_enforced = !target.is_full_body;

      // stand_simple exposes upper/full through a getter which also checks this
      // native scene flag. Our direct dropdown bypasses the legacy _POSE_ menu
      // that normally sets it, so the full-body entry otherwise reloads the
      // same filename but remains upper-body forever.
      if (target.is_full_body && window.MMD_SA_options?.Dungeon_options) {
        MMD_SA_options.Dungeon_options.character_movement_disabled = true;
      }
    }

    async function changePoseByKey(key, { remember = true } = {}) {
      const requestId = `pose-${Date.now().toString(36)}-${++poseRequestSequence}`;
      const started = performance.now();
      const item = window.MMD_SA_options?.Dungeon_options?.item_base?.pose;
      let resolved = null;
      let suspended = false;
      const debugContext = () => {
        let mesh = null;
        let modelX = null;
        try { mesh = window.MMD_SA?.THREEX?._THREE?.MMD?.getModels?.()?.[0]?.mesh || null; }
        catch (e) {}
        try { modelX = window.MMD_SA?.THREEX?.get_model?.(0) || window.MMD_SA?.THREEX?.models?.[0] || null; }
        catch (e) {}
        return {
          request_id:requestId,
          selected_key:key,
          active_list_size:poseList().length,
          native_change_ready:typeof item?._change_motion_ === 'function',
          current_motion:window.MMD_SA?.MMD?.motionManager?.filename || null,
          pipeline:config.performance?.tracking_pipeline || null,
          camera_initialized:!!window.System?._browser?.camera?.initialized,
          pose_tracking_enabled:!!window.System?._browser?.camera?.poseNet?.enabled,
          upper_body_only:!!window.MMD_SA?.MMD?.motionManager?.para_SA?.motion_tracking_upper_body_only,
          character_movement_disabled:window.MMD_SA_options?.Dungeon_options?.character_movement_disabled ?? null,
          mmd_mesh_present:!!mesh,
          mmd_mesh_visible:mesh?.visible ?? null,
          avatar_type:modelX?.type || modelX?.constructor?.name || null
        };
      };

      XRA.debug?.record('pose.change.request', debugContext());

      try {
        if (typeof item?._change_motion_ !== 'function') throw new Error('Pose engine not ready');
        resolved = resolvePoseByKey(key);
        if (resolved.index < 0 || !resolved.pose) throw new Error('Selected pose is no longer in the active native list');
        XRA.debug?.record('pose.change.resolved', {
          request_id:requestId, index:resolved.index, name:resolved.pose.name,
          info:resolved.pose.info, full_body:!!resolved.pose.is_full_body
        });

        XRA.tracking?.suspendForPoseChange?.();
        suspended = true;
        // Re-resolve immediately before the native call. This protects against a
        // list reorder between rendering the dropdown and clicking it.
        preparePoseVariant(resolved.pose);
        const nativeResult = await item._change_motion_(resolved.index, true);
        XRA.debug?.record('pose.change.native-return', {
          request_id:requestId, attempt:1, index:resolved.index,
          return_type:typeof nativeResult,
          return_value:['string','number','boolean'].includes(typeof nativeResult) ? nativeResult : null
        });
        let ok = await waitForPose(resolved.pose);

        // A late native list refresh/load can race the first request. Retry once
        // by identity, never by the old dropdown index.
        if (!ok) {
          const retry = resolvePoseByKey(key);
          XRA.debug?.record('pose.change.retry', {
            request_id:requestId, first_index:resolved.index, retry_index:retry.index,
            list_size:retry.list.length, target_found:!!retry.pose
          });
          if (retry.index >= 0) {
            preparePoseVariant(retry.pose);
            const retryResult = await item._change_motion_(retry.index, true);
            XRA.debug?.record('pose.change.native-return', {
              request_id:requestId, attempt:2, index:retry.index,
              return_type:typeof retryResult,
              return_value:['string','number','boolean'].includes(typeof retryResult) ? retryResult : null
            });
            ok = await waitForPose(retry.pose, 1800);
          }
        }
        if (!ok) throw new Error(`XR Animator did not switch to “${resolved.pose.info || resolved.pose.name}”`);
        XRA.debug?.record('pose.change.success', {
          request_id:requestId, name:resolved.pose.name,
          elapsed_ms:Math.round((performance.now() - started) * 10) / 10,
          context:debugContext()
        });
        if (remember) {
          config.avatar ||= {};
          config.avatar.pose_key = poseKey(resolved.pose);
          await XRA.profileService.save(0);
        }
        return resolved.pose;
      }
      catch (error) {
        XRA.debug?.record('pose.change.failure', {
          request_id:requestId,
          elapsed_ms:Math.round((performance.now() - started) * 10) / 10,
          error,
          resolved:resolved ? { index:resolved.index, name:resolved.pose?.name || null } : null,
          context:debugContext()
        });
        throw error;
      }
      finally {
        if (suspended) XRA.tracking?.resumeAfterPoseChange?.();
      }
    }

    let poseOptionsSignature = '';

    async function restoreSavedPose() {
      const key = String(config.avatar?.pose_key || '');
      if (!key || restoringSavedPose || poseBusy) return false;
      const resolved = resolvePoseByKey(key);
      if (!resolved.pose) return false;
      if (isCurrentPose(resolved.pose)) {
        return true;
      }

      restoringSavedPose = true;
      poseBusy = true;
      poseSelect.disabled = true;
      try {
        await changePoseByKey(key, { remember: false });
        return true;
      }
      catch (e) {
        return false;
      }
      finally {
        restoringSavedPose = false;
        poseBusy = false;
        refreshPoseList();
      }
    }

    function refreshPoseList() {
      const list = poseList();
      const filename = window.MMD_SA?.MMD?.motionManager?.filename || '';
      const selectedKey = poseSelect.value;
      const entries = list.length
        ? list.map(m => ({ value: poseKey(m), label: m.info || m.name, motionName: m.name }))
        : [{ value: '', label: 'Pose list not ready', motionName: '' }];
      const signature = entries.map(entry => `${entry.value}\u0000${entry.label}\u0000${entry.motionName}`).join('\u0001');

      // XR Animator emits motionchange continuously while mocap is active. The
      // pose catalogue normally stays identical, so rebuilding all 32 OPTIONs
      // on every event only creates thousands of detached Blink nodes and event
      // wrappers for the garbage collector. Rebuild solely when the catalogue
      // itself changes; selecting the current pose remains a cheap value update.
      if (signature !== poseOptionsSignature) {
        const fragment = document.createDocumentFragment();
        entries.forEach(entry => {
          const o = document.createElement('option');
          o.value = entry.value;
          o.textContent = entry.label;
          if (entry.motionName) o.dataset.motionName = entry.motionName;
          fragment.appendChild(o);
        });
        poseSelect.replaceChildren(fragment);
        poseOptionsSignature = signature;
      }

      if (list.length) {
        const currentPose = list.find(isCurrentPose);
        const currentKey = currentPose ? poseKey(currentPose) : '';
        if (currentKey) poseSelect.value = currentKey;
        else if (selectedKey && entries.some(entry => entry.value === selectedKey)) poseSelect.value = selectedKey;
      }

      const currentText = `Current pose: ${filename || 'not ready'}`;
      if (current.textContent !== currentText) current.textContent = currentText;
      poseSelect.disabled = poseBusy || !list.length;
    }

    bindRefresh(refreshPoseList);
    poseSelect.onchange = async () => {
      const key = poseSelect.value;
      if (!key || poseBusy) return;
      poseBusy = true;
      poseSelect.disabled = true;
      try {
        const applied = await changePoseByKey(key);
        XRA.toast(`Pose: ${applied.info || applied.name}`);
      }
      catch (e) { XRA.toast('Pose: ' + e.message, 'error', 4500); }
      finally { poseBusy = false; refreshPoseList(); }
    };
    row(box.body, 'Pose', poseSelect, {
      reset: async () => {
        if (poseBusy) return;
        poseBusy = true; poseSelect.disabled = true;
        try { await resetAvatarPose(); }
        catch (e) { XRA.toast('Reset pose: ' + e.message, 'error', 4500); }
        finally { poseBusy = false; poseSelect.disabled = false; refreshPoseList(); }
      },
      sub: 'Selezione per identità nativa della posa (non per indice): resta corretta anche se XR Animator riordina la libreria.'
    });
    box.body.appendChild(current);

    async function resetAvatarPose() {
      const list = poseList();
      const tracked = !!(
        window.System?._browser?.camera?.poseNet?.enabled ||
        window.System?._browser?.camera?.VMC_receiver?.mocap_enabled ||
        window.System?._browser?.camera?.VMC_receiver?.bone_enabled
      );

      let target;
      if (!tracked) {
        target = list.find(m => m?.name === 'standmix2_modified');
      }
      else {
        const mocapType = String(window.MMD_SA_options?.user_camera?.streamer_mode?.mocap_type || '');
        const wantsFull = /full\s*body/i.test(mocapType);
        target = list.find(m => m?.name === 'stand_simple' && (!!m.is_full_body === wantsFull));
        target ||= list.find(m => m?.name === 'stand_simple');
      }
      if (!target) throw new Error('Native neutral pose is not available in the active pose list');
      await changePoseByKey(poseKey(target));
    }

    const actions = el('div', 'xra-inline-grid xra-three-actions');
    const mirror = button('⇄ Mirror pose');
    mirror.onclick = () => {
      const fn = window.MMD_SA_options?._XRA_mirror_pose;
      if (typeof fn === 'function') fn();
    };
    const resetPose = button('↺ Reset pose');
    resetPose.onclick = async () => {
      if (poseBusy) return;
      poseBusy = true; resetPose.disabled = true; poseSelect.disabled = true;
      try { await resetAvatarPose(); }
      catch (e) { XRA.toast('Reset pose: ' + e.message, 'error', 4500); }
      finally { poseBusy = false; resetPose.disabled = false; refreshPoseList(); }
    };
    const resetOrder = button('↺ Reset pose order');
    resetOrder.onclick = () => {
      const fn = window.MMD_SA_options?._XRA_pose_reset;
      if (typeof fn === 'function') fn();
      refreshPoseList();
    };
    actions.append(mirror, resetPose, resetOrder);
    box.body.appendChild(actions);

    const shoulder = select([
      ['', 'Default'],
      ['Full', 'Full'],
      ['Upper half', 'Upper half'],
      ['None', 'None']
    ]);
    const persistShoulder = registerPersistentLeftControl(box.body, 'Shoulder adjust',
      () => String(window.MMD_SA?.THREEX?.shoulder_adjust || ''),
      value => { if (window.MMD_SA?.THREEX) MMD_SA.THREEX.shoulder_adjust = String(value || ''); });
    bindRefresh(() => { shoulder.value = String(window.MMD_SA?.THREEX?.shoulder_adjust || ''); });
    shoulder.onchange = async () => {
      if (window.MMD_SA?.THREEX) MMD_SA.THREEX.shoulder_adjust = shoulder.value;
      persistShoulder();
      await saveNative();
    };
    row(box.body, 'Shoulder adjust', shoulder, {
      reset: async () => {
        if (window.MMD_SA?.THREEX) MMD_SA.THREEX.shoulder_adjust = '';
        shoulder.value = '';
        persistShoulder();
        await saveNative();
        refreshAll();
      },
      isDefault: () => !(window.MMD_SA?.THREEX?.shoulder_adjust),
      sub: 'La correzione delle spalle è nativa; per pose già caricate può richiedere un riavvio.'
    });

    const onMotionChange = () => setTimeout(() => {
      refreshPoseList();
      restoreSavedPose();
    }, 0);
    window.addEventListener('SA_MMD_model0_onmotionchange', onMotionChange);
    events.on('camera-started', () => {
      // Starting mocap swaps from the idle pose catalogue to the tracked one
      // and can select its own neutral pose. Restore again against that final
      // catalogue even if the idle pose was already restored before START.
      for (const delay of [250, 900, 1800]) setTimeout(restoreSavedPose, delay);
    });
    events.on('profile-loaded', () => {
      setTimeout(restoreSavedPose, 250);
    });
    for (const delay of [0, 500, 1500, 3000]) setTimeout(restoreSavedPose, delay);
    box.details.addEventListener('toggle', () => {
      if (box.details.open) refreshPoseList();
    });
  }

  function addWebcamMedia(content) {
    const box = details(content, '📹 Webcam / media', { open: true });
    const cameraSelect = select([['', 'Refresh cameras…']]);
    const status = el('div', 'xra-status', 'Camera list not loaded.');
    let loading = false;

    function renderStatus() {
      const active = XRA.nativeBridge.activeCamera();
      const isLive = XRA.nativeBridge.cameraRunning?.() ?? (active.readyState === 'live');
      status.textContent = isLive
        ? `Webcam: ON · ${active.label || 'unknown'} · ${active.readyState}`
        : `Webcam: OFF${active.label ? ` · ${active.label}` : ''}`;
      try { updateToggleState(); } catch (_) {}
    }

    async function refreshCameras(requestPermission = false) {
      if (loading) return;
      loading = true;
      cameraSelect.disabled = true;
      try {
        const cameras = await XRA.nativeBridge.enumerateCameras({ requestPermission });
        const active = XRA.nativeBridge.activeCamera();
        cameraSelect.innerHTML = '';

        if (!cameras.length) {
          const o = document.createElement('option');
          o.value = ''; o.textContent = 'No cameras found';
          cameraSelect.appendChild(o);
        }
        else {
          for (const cam of cameras) {
            const o = document.createElement('option');
            o.value = cam.deviceId;
            o.dataset.label = cam.label;
            const activeMatch = (active.deviceId && cam.deviceId === active.deviceId) ||
              (active.label && cam.label === active.label);
            o.textContent = cam.label + (activeMatch && (XRA.nativeBridge.cameraRunning?.() ?? (active.readyState === 'live')) ? '  ● ACTIVE' : '');
            cameraSelect.appendChild(o);
          }
          const wanted = active.deviceId || config.devices?.camera_device_id || '';
          if ([...cameraSelect.options].some(o => o.value === wanted)) cameraSelect.value = wanted;
        }
        renderStatus();
      }
      catch (e) { status.textContent = 'Camera error: ' + e.message; }
      finally { cameraSelect.disabled = false; loading = false; }
    }

    cameraSelect.onchange = async () => {
      const option = cameraSelect.selectedOptions[0];
      if (!option?.value) return;
      cameraSelect.disabled = true;
      status.textContent = `Switching to ${option.dataset.label || option.textContent}…`;
      try {
        const label = option.dataset.label || option.textContent.replace(/\s+● ACTIVE$/, '');
        // If webcam is off, only remember the device. Start remains explicit.
        if (XRA.nativeBridge.cameraRunning?.()) {
          await XRA.nativeBridge.switchCamera({ deviceId: option.value, label });
        }
        else {
          await XRA.nativeBridge.setCameraPreference({ deviceId: option.value, label });
        }
      }
      catch (e) { status.textContent = 'Switch failed: ' + e.message; }
      finally { await refreshCameras(false); }
    };

    row(box.body, 'Webcam device', cameraSelect, {
      reset: async () => {
        await XRA.nativeBridge.setCameraPreference({ deviceId: '', label: '' });
        await refreshCameras(false);
      },
      isDefault: () => !(config.devices?.camera_device_id || config.devices?.camera_label),
      sub: 'Changing device while OFF only saves the preference. Start/Stop never changes mocap mode.'
    });
    box.body.appendChild(status);


    const selfie = document.createElement('input');
    selfie.type = 'checkbox';
    // The native XR Animator flag uses the opposite convention from the label
    // exposed here. Keep that quirk at the UI boundary instead of stacking
    // multiple CSS/backend flips throughout the camera pipeline.
    bindRefresh(() => { selfie.checked = !config.devices?.selfie_mode; XRA.nativeBridge.applyWebcamSelfie?.(); });
    selfie.onchange = async () => {
      selfie.disabled = true;
      try { await XRA.nativeBridge.setWebcamSelfie(!selfie.checked); }
      catch (e) { XRA.toast('Selfie mode: ' + e.message, 'error', 4000); }
      finally { selfie.disabled = false; refreshAll(); }
    };
    row(box.body, 'Selfie mode', selfie, {
      reset: async () => XRA.nativeBridge.setWebcamSelfie(!!defaults.devices?.selfie_mode),
      isDefault: () => !!config.devices?.selfie_mode === !!defaults.devices?.selfie_mode,
      sub: 'Inverte orizzontalmente il tracking della webcam. Non modifica la modalità selfie della Hand Camera.'
    });

    addToggle(box.body, 'Show mocap wireframe',
      () => XRA.nativeBridge?.getPreviewVisibility?.('wireframe') ?? !window.MMD_SA_options?.user_camera?.display?.wireframe?.hidden,
      value => XRA.nativeBridge?.setPreviewVisibility?.('wireframe', value),
      'Mostra lo scheletro di tracciamento sopra la scena.');

    const actions = el('div', 'xra-inline-grid');
    const toggleButton = button('▶ Start webcam');

    function updateToggleState() {
      const live = !!(XRA.nativeBridge.cameraRunning?.() ?? (XRA.nativeBridge.activeCamera().readyState === 'live'));
      toggleButton.textContent = live ? '■ Stop webcam' : '▶ Start webcam';
      toggleButton.classList.toggle('active', live);
    }

    toggleButton.onclick = async () => {
      toggleButton.disabled = true;
      const live = !!(XRA.nativeBridge.cameraRunning?.() ?? (XRA.nativeBridge.activeCamera().readyState === 'live'));
      try {
        if (live) {
          status.textContent = 'Stopping webcam…';
          await XRA.nativeBridge.stopNativeStreamer();
        } else {
          status.textContent = 'Starting webcam…';
          if (typeof XRA.whenNativeReady === 'function') {
            await XRA.whenNativeReady(15000);
          }
          if (XRA.xraBackend?.waitUntilReady) {
            await XRA.xraBackend.waitUntilReady(6000).catch(() => {});
          }
          await XRA.nativeBridge?.startNativeStreamer?.();
          XRA.ui?.refresh?.();
        }
      } catch (e) {
        if (!globalThis.XRA_CAMERA_OWNERSHIP?.isOwnershipError?.(e)) {
          status.textContent = (live ? 'Stop' : 'Start') + ' failed: ' + e.message;
          XRA.toast?.('Avvio telecamera: ' + e.message, 'warn', 5000);
        }
      } finally {
        toggleButton.disabled = false;
        await refreshCameras(false);
        updateToggleState();
      }
    };

    const restart = button('↻ Restart webcam');
    restart.onclick = async () => {
      restart.disabled = true;
      try {
        status.textContent = 'Restarting webcam…';
        if (typeof XRA.whenNativeReady === 'function') {
          await XRA.whenNativeReady(15000);
        }
        if (XRA.xraBackend?.waitUntilReady) {
          await XRA.xraBackend.waitUntilReady(6000).catch(() => {});
        }
        await XRA.nativeBridge.restartNativeStreamer();
        XRA.ui?.refresh?.();
      } catch (e) {
        if (!globalThis.XRA_CAMERA_OWNERSHIP?.isOwnershipError?.(e)) {
          status.textContent = 'Restart failed: ' + e.message;
          XRA.toast?.('Riavvio telecamera: ' + e.message, 'warn', 5000);
        }
      } finally {
        restart.disabled = false;
        await refreshCameras(false);
        updateToggleState();
      }
    };
    restart.classList.add('xra-secondary-action');
    actions.append(toggleButton, restart);
    box.body.appendChild(actions);

    box.details.addEventListener('toggle', () => { if (box.details.open) refreshCameras(false); });
    events.on('camera-switched', () => refreshCameras(false));
    events.on('camera-started', () => refreshCameras(false));
    events.on('camera-stopped', () => refreshCameras(false));
  }

  function addMiscNative(content) {
    const box = details(content, '🔧 Miscellaneous / native tools');

    addToggle(box.body, 'Disable native hotkeys',
      () => !!window.System?._browser?.hotkeys?.disabled,
      value => { if (window.System?._browser?.hotkeys) System._browser.hotkeys.disabled = value; },
      'Disattiva tutte le scorciatoie da tastiera dell’applicazione.');

    addToggle(box.body, 'Global hotkeys',
      () => !!window.System?._browser?.hotkeys?.is_global,
      value => {
        const h = window.System?._browser?.hotkeys;
        if (!h) return;
        h.is_global = !!value;
        if (typeof h.register_global === 'function') {
          try { h.register_global(value); } catch (e) {}
        }
      },
      'Scorciatoie di sistema registrate a livello di OS (funzionalità per app desktop).');

    addToggle(box.body, 'Gamepad enabled',
      () => !!window.MMD_SA_options?.gamepad?.enabled,
      value => {
        if (!window.MMD_SA_options?.gamepad) return;
        MMD_SA_options.gamepad.enabled = value;
      });

    box.body.appendChild(el('div', 'xra-note',
      'I parametri di configurazione avanzata sono modificabili direttamente nell’editor JSON in fondo al pannello.'));
  }

  function addMotion(content) {
    const box = details(content, '🧍 Motion capture', { open: true });

    box.body.appendChild(el('div', 'xra-note', 'La modalità di tracciamento (Corpo intero o Solo viso) si seleziona dal pannello rapido a destra sotto Prestazioni → Avanzate.'));

    addSelect(box.body, 'Upper body blend', [[0, 'Auto'], [1, 'Simple'], [2, 'Normal']],
      () => camera()?.upper_body_blend_mode_raw ?? 0,
      value => { const c = camera(); if (c) c.upper_body_blend_mode = Number(value); });

    addSelect(box.body, 'Shoulder tracking', [[null, 'Auto'], [0, 'Off']],
      () => {
        const value = pose()?.shoulder_tracking;
        // Native XR Animator may materialize its default/auto value as true.
        // Only an explicit 0/false means Off; every other state is Auto.
        return (value === 0 || value === false) ? 0 : null;
      },
      value => { const p = pose(); if (p) p.shoulder_tracking = value == null ? null : 0; },
      "Auto uses XR Animator\'s normal shoulder contribution. Off removes shoulder tracking.");

    addToggle(box.body, 'Leg IK',
      () => !!poseOptions()?.use_legIK,
      value => { const p = poseOptions(); if (p) p.use_legIK = value; },
      'Test: lift a foot / bend a knee and watch whether the planted foot and knee chain stay constrained rather than following only raw bone rotation.');

    addSelect(box.body, 'Arm IK', [[null, 'Auto'], [true, 'On']],
      () => poseOptions()?.use_armIK ? true : null,
      value => { const p = poseOptions(); if (p) p.use_armIK = value === true || value === 'true' ? true : null; },
      'Auto lets XR Animator decide when arm IK is appropriate. On forces arm IK; compare elbows/wrists while reaching sideways or toward the camera.');

    addToggle(box.body, 'Auto grounding',
      () => !!pose()?.auto_grounding,
      value => { const p = pose(); if (p) p.auto_grounding = value; },
      'Test: crouch, stand and raise one leg. ON should compensate the avatar root height so the body stays referenced to the virtual floor.');

    addToggle(box.body, 'Hip camera',
      () => !!pose()?.hip_camera,
      value => { const p = pose(); if (p) p.hip_camera = value; },
      "Uses the hip/body tracking reference in XR Animator\'s camera/tracking behavior. Compare while moving your torso left/right and toward/away from the webcam.");

    // XRA tracking-loss avatar hiding removed: runtime signal was not reliable enough.
    addRange(box.body, 'Arm horizontal offset',
      () => Number(pose()?.arm_horizontal_offset_percent || 0),
      value => { const p = pose(); if (p) p.arm_horizontal_offset_percent = value; },
      { min: -200, max: 200, step: 1 });

    addRange(box.body, 'Arm vertical offset',
      () => Number(pose()?.arm_vertical_offset_percent || 0),
      value => { const p = pose(); if (p) p.arm_vertical_offset_percent = value; },
      { min: -100, max: 100, step: 1 });

    addRange(box.body, 'Limb entry duration',
      () => Number(pose()?.limb_entry_duration_percent || 0),
      value => { const p = pose(); if (p) p.limb_entry_duration_percent = value; },
      { min: 0, max: 200, step: 5 });

    addRange(box.body, 'Limb return duration',
      () => Number(pose()?.limb_return_duration_percent || 0),
      value => { const p = pose(); if (p) p.limb_return_duration_percent = value; },
      { min: 0, max: 200, step: 5 });

    addRange(box.body, 'Hip depth scale',
      () => Number(pose()?.hip_depth_scale_percent || 100),
      value => { const p = pose(); if (p) p.hip_depth_scale_percent = value; },
      { min: 0, max: 200, step: 5 });

    addRange(box.body, 'Hip Y offset',
      () => Number(pose()?.hip_y_position_offset_percent || 0),
      value => { const p = pose(); if (p) p.hip_y_position_offset_percent = value; },
      { min: -100, max: 100, step: 5 });

    addRange(box.body, 'Hip Z offset',
      () => Number(pose()?.hip_z_position_offset_percent || 0),
      value => { const p = pose(); if (p) p.hip_z_position_offset_percent = value; },
      { min: -100, max: 100, step: 5 });
  }

  function addHands(content) {
    const box = details(content, '🖐 Native hand tracking');

    const note = el('div', 'xra-note');
    note.textContent = 'Le impostazioni di stabilizzazione, sensibilità e recupero mani sono configurabili nel pannello principale «🖐️ Arms & Hands».';
    box.body.appendChild(note);

    addRange(box.body, 'Depth adjustment',
      () => Number(handOptions()?.depth_adjustment_percent || 0),
      value => { const h = handOptions(); if (h) h.depth_adjustment_percent = value; },
      { min: 0, max: 100, step: 1 });

    addRange(box.body, 'IRL hand / shoulder scale',
      () => Number(handOptions()?.palm_shoulder_scale_percent || 30),
      value => { const h = handOptions(); if (h) h.palm_shoulder_scale_percent = value; },
      { min: 10, max: 50, step: 1 });

    addRange(box.body, 'Hand depth scale',
      () => Number(handOptions()?.depth_scale_percent || 50),
      value => { const h = handOptions(); if (h) h.depth_scale_percent = value; },
      { min: 10, max: 90, step: 1 });

    const handCameraButton = button('Toggle Hand Camera');
    bindRefresh(() => {
      const hc = window.MMD_SA_options?.Dungeon_options?.item_base?.hand_camera;
      const side = hc?._hand_camera_side;
      handCameraButton.textContent = !hc?._hand_camera_enabled
        ? 'Hand Camera: OFF'
        : `Hand Camera: ${side === '右' ? 'LEFT' : 'RIGHT'}`;
    });
    handCameraButton.onclick = async () => {
      try {
        await XRA.nativeBridge?.invokeItem?.('hand_camera');
        await saveNative();
        setTimeout(refreshAll, 0);
        setTimeout(refreshAll, 120);
      }
      catch (e) {
        console.warn(TAG, 'Hand Camera native action failed', e);
        XRA.toast('Hand Camera not ready: ' + (e?.message || e), 'error');
      }
    };
    box.body.appendChild(handCameraButton);

    addNumber(box.body, 'Hand camera FOV',
      () => window.MMD_SA_options?.Dungeon_options?.item_base?.hand_camera?.fov ?? 50,
      value => { const hc = window.MMD_SA_options?.Dungeon_options?.item_base?.hand_camera; if (hc && value != null) hc.fov = value; },
      { min: 10, max: 140, step: 1 });
  }

  function addFace(content) {
    const box = details(content, '🙂 Face tracking');

    addToggle(box.body, 'Eye tracking',
      () => !!face()?.eye_tracking,
      value => { const f = face(); if (f) f.eye_tracking = value; });

    addToggle(box.body, 'Blink L/R sync',
      () => !!face()?.blink_sync,
      value => { const f = face(); if (f) f.blink_sync = value; });

    addSelect(box.body, 'Blink clarity', [[0, 'Normal'], [2, 'High'], [3, 'Very high']],
      () => Number(face()?.blink_clarity || 0),
      value => { const f = face(); if (f) f.blink_clarity = Number(value); });

    addToggle(box.body, 'Auto blink',
      () => !!face()?.auto_blink,
      value => { const f = face(); if (f) f.auto_blink = value; });

    addToggle(box.body, 'Auto look at camera',
      () => !!face()?.auto_look_at_camera,
      value => { const f = face(); if (f) f.auto_look_at_camera = value; });

    addRange(box.body, 'Eye bone rotation',
      () => Number(face()?.eye_bone_rotation_percent || 0),
      value => { const f = face(); if (f) f.eye_bone_rotation_percent = value; },
      { min: 0, max: 200, step: 2 });

    addSelect(box.body, 'Mouth tracking sensitivity', [[0, 'Normal'], [1, 'High'], [2, 'Very high'], [3, 'Max']],
      () => Number(face()?.mouth_tracking_sensitivity || 0),
      value => { const f = face(); if (f) f.mouth_tracking_sensitivity = Number(value); },
      'È la sensibilità nativa webcam; non sostituisce il nostro lip-sync microfono.');

    addSelect(box.body, 'Lean tracking', [[0, 'Off'], [1, 'Min'], [2, 'Normal'], [3, 'Max']],
      () => Number(face()?.lean_tracking || 0),
      value => { const f = face(); if (f) f.lean_tracking = Number(value); });

    addRange(box.body, 'Emotion weight',
      () => Number(face()?.emotion_weight_percent || 0),
      value => { const f = face(); if (f) f.emotion_weight_percent = value; },
      { min: 0, max: 200, step: 5 });

    addRange(box.body, 'Vowel expression weight',
      () => Number(face()?.emotion_vowel_percent || 0),
      value => { const f = face(); if (f) f.emotion_vowel_percent = value; },
      { min: 0, max: 200, step: 5, sub: 'Peso nativo facemesh; il mix microfono/camera resta nel pannello a destra.' });
  }


  function addCaptureVMC(content) {
    const capture = details(content, '🎬 Recording / capture', { open: true });
    const rc = () => config.recorder || (config.recorder = XRA.util.clone(defaults.recorder));

    const recorderBox = details(capture.body, 'Recorder', { open: true });
    recorderBox.body.appendChild(el('div', 'xra-note',
      'Consigliato l\'output integrato ad alta fedeltà: registra direttamente la scena senza richiedere la condivisione dello schermo nel browser.'));

    const preset = select([
      ['COMPACT', 'Compact'], ['PODCAST', 'Podcast'], ['HIGH', 'High'], ['VERY_HIGH', 'Very High'], ['CUSTOM', 'Custom']
    ]);
    bindRefresh(() => { preset.value = rc().preset || 'PODCAST'; });
    preset.onchange = async () => {
      if (preset.value === 'CUSTOM') rc().preset = 'CUSTOM';
      else XRA.recorder.applyPreset(preset.value);
      await XRA.profileService.save(); refreshAll();
    };
    row(recorderBox.body, 'Recording preset', preset, {
      reset: async () => XRA.recorder.applyPreset(defaults.recorder.preset),
      isDefault: () => (rc().preset || 'PODCAST') === defaults.recorder.preset
    });

    function saveRec(key, value, quality = false) {
      rc()[key] = value;
      if (quality) rc().preset = 'CUSTOM';
      XRA.profileService.save();
      events.emit('recorder-config', rc());
      refreshAll();
    }

    const mode = select([['video_audio', 'Video + Audio'], ['video', 'Video only'], ['audio', 'Audio only']]);
    bindRefresh(() => { mode.value = rc().mode || 'video_audio'; });
    mode.onchange = () => saveRec('mode', mode.value, false);
    row(recorderBox.body, 'Mode', mode, {
      reset: () => saveRec('mode', defaults.recorder.mode, false),
      isDefault: () => (rc().mode || 'video_audio') === defaults.recorder.mode
    });

    const captureSource = select([
      ['classic_v74', 'Classic output · recommended'],
      ['clean_scene', 'Clean scene output · experimental (no UI)'],
      ['native_xr', 'XR native video only · fallback (no external background)']
    ]);
    bindRefresh(() => {
      let v = rc().capture_source || 'classic_v74';
      if (v === 'native_visible' || v === 'browser_visible') v = 'classic_v74';
      captureSource.value = v;
    });
    captureSource.onchange = () => saveRec('capture_source', captureSource.value, false);
    row(recorderBox.body, 'Recording source', captureSource, {
      reset: () => saveRec('capture_source', defaults.recorder.capture_source, false),
      isDefault: () => (rc().capture_source || 'classic_v74') === defaults.recorder.capture_source,
      sub: "XR native output uses the original XR Animator recorder for video fidelity, then XRA intercepts/finalizes the file using your name, Linux folder, MP4/WebM/MKV choice and processed audio. It does not use Chrome screen sharing."
    });

    const outputFormat = select([['webm', 'WebM (native / fastest)'], ['mp4', 'MP4 (H.264/AAC)'], ['mkv', 'MKV']]);
    bindRefresh(() => { outputFormat.value = rc().output_format || 'webm'; });
    outputFormat.onchange = () => saveRec('output_format', outputFormat.value, false);
    row(recorderBox.body, 'Output format', outputFormat, {
      reset: () => saveRec('output_format', defaults.recorder.output_format, false),
      isDefault: () => (rc().output_format || 'webm') === defaults.recorder.output_format,
      sub: 'Reliability mode: XR Animator always captures a valid WebM source, then finalizes MP4 (H.264/AAC) or MKV on the local server after Stop. This avoids .bin/mislabeled MP4 files.'
    });

    const filename = stopInputPropagation(document.createElement('input'));
    filename.type = 'text'; filename.className = 'xra-control'; filename.placeholder = 'XR_Animator_{date}_{time}';
    bindRefresh(() => { if (document.activeElement !== filename) filename.value = rc().filename || 'XR_Animator_{date}_{time}'; });
    filename.onchange = () => saveRec('filename', filename.value || 'XR_Animator_{date}_{time}', false);
    row(recorderBox.body, 'Default file name', filename, {
      reset: () => saveRec('filename', defaults.recorder.filename, false),
      isDefault: () => (rc().filename || defaults.recorder.filename) === defaults.recorder.filename,
      sub: 'Supports {date} and {time}. You can change it again in the Record popup.'
    });

    const folderWrap = el('div', 'xra-stack-control');
    const folder = stopInputPropagation(document.createElement('input'));
    folder.type = 'text'; folder.className = 'xra-control'; folder.placeholder = '/home/user/Videos/podcast';
    folder.autocomplete = 'off'; folder.spellcheck = false;
    bindRefresh(() => { if (document.activeElement !== folder) folder.value = rc().output_dir || ''; });
    folder.onchange = () => saveRec('output_dir', folder.value.trim(), false);
    folderWrap.append(folder);
    row(recorderBox.body, 'Recording folder', folderWrap, {
      reset: () => saveRec('output_dir', defaults.recorder.output_dir, false),
      isDefault: () => (rc().output_dir || '') === defaults.recorder.output_dir,
      sub: 'Type or paste an absolute Linux path. Leave empty to use XR Animator / recordings.'
    });

    const resolution = select([['1280x720', '1280×720'], ['1920x1080', '1920×1080']]);
    bindRefresh(() => { resolution.value = `${rc().width || 1280}x${rc().height || 720}`; });
    resolution.onchange = () => {
      const [w,h] = resolution.value.split('x').map(Number); rc().width=w; rc().height=h; rc().preset='CUSTOM';
      // Resolution and bitrate are independent. Do not silently jump to 8-12 Mbps;
      // the visible 30-minute estimate should reflect exactly what the user chose.
      XRA.profileService.save(); events.emit('recorder-config', rc()); refreshAll();
    };
    row(recorderBox.body, 'Resolution', resolution, {
      reset: () => {
        rc().width = defaults.recorder.width;
        rc().height = defaults.recorder.height;
        rc().preset = 'CUSTOM';
        XRA.profileService.save(); events.emit('recorder-config', rc()); refreshAll();
      },
      isDefault: () => (rc().width || defaults.recorder.width) === defaults.recorder.width && (rc().height || defaults.recorder.height) === defaults.recorder.height
    });

    const recFps = select([[24, '24 FPS'], [30, '30 FPS'], [60, '60 FPS'], [90, '90 FPS']]);
    bindRefresh(() => { recFps.value = String(rc().fps || 30); });
    recFps.onchange = () => {
      rc().fps = Number(recFps.value); rc().preset = 'CUSTOM';
      XRA.profileService.save(); events.emit('recorder-config', rc()); refreshAll();
    };
    row(recorderBox.body, 'Capture FPS', recFps, {
      reset: () => {
        rc().fps = defaults.recorder.fps;
        rc().preset = 'CUSTOM';
        XRA.profileService.save(); events.emit('recorder-config', rc()); refreshAll();
      },
      isDefault: () => (rc().fps || defaults.recorder.fps) === defaults.recorder.fps
    });

    const videoBitrate = select([[1500000, '1.5 Mbps'], [2000000, '2 Mbps'], [2500000, '2.5 Mbps'], [3000000, '3 Mbps'], [4000000, '4 Mbps'], [5000000, '5 Mbps'], [6000000, '6 Mbps'], [8000000, '8 Mbps'], [10000000, '10 Mbps']]);
    bindRefresh(() => { videoBitrate.value = String(rc().video_bps || 3000000); });
    videoBitrate.onchange = () => saveRec('video_bps', Number(videoBitrate.value), true);
    row(recorderBox.body, 'Video bitrate', videoBitrate, {
      reset: () => saveRec('video_bps', defaults.recorder.video_bps, true),
      isDefault: () => (rc().video_bps || defaults.recorder.video_bps) === defaults.recorder.video_bps,
      sub: '1080p30: 4-5 Mbps is the balanced range for this avatar/podcast use case. Higher values mainly increase file size.'
    });

    const trueResolution = document.createElement('input'); trueResolution.type = 'checkbox';
    bindRefresh(() => { trueResolution.checked = rc().force_render_resolution !== false; });
    trueResolution.onchange = () => saveRec('force_render_resolution', trueResolution.checked, false);
    row(recorderBox.body, 'Render at recording resolution', trueResolution, {
      reset: () => saveRec('force_render_resolution', defaults.recorder.force_render_resolution, false),
      isDefault: () => (rc().force_render_resolution !== false) === defaults.recorder.force_render_resolution,
      sub: 'Recommended. If XR Animator is rendering below 1080p, temporarily raises the WebGL render buffer during REC instead of merely upscaling a smaller canvas.'
    });

    const chromaSafe = document.createElement('input'); chromaSafe.type = 'checkbox';
    bindRefresh(() => { chromaSafe.checked = rc().chroma_safe !== false; chromaSafe.disabled = (rc().mode || 'video_audio') === 'audio'; });
    chromaSafe.onchange = () => saveRec('chroma_safe', chromaSafe.checked, false);
    row(recorderBox.body, 'Chroma-safe recording', chromaSafe, {
      reset: () => saveRec('chroma_safe', defaults.recorder.chroma_safe, false),
      isDefault: () => (rc().chroma_safe !== false) === defaults.recorder.chroma_safe,
      sub: 'For solid-color backgrounds: uses the exact background color and temporarily disables Bloom / Depth of Field while recording to reduce halos around the avatar. The switch stays editable; on non-color backgrounds it is simply ignored. Restores the effects at Stop.'
    });

    const audioBitrate = select([[96000, '96 kbps'], [128000, '128 kbps'], [160000, '160 kbps'], [192000, '192 kbps'], [256000, '256 kbps']]);
    bindRefresh(() => { audioBitrate.value = String(rc().audio_bps || 128000); });
    audioBitrate.onchange = () => saveRec('audio_bps', Number(audioBitrate.value), true);
    row(recorderBox.body, 'Audio bitrate', audioBitrate, {
      reset: () => saveRec('audio_bps', defaults.recorder.audio_bps, true),
      isDefault: () => (rc().audio_bps || defaults.recorder.audio_bps) === defaults.recorder.audio_bps
    });

    const audioNote = el('div', 'xra-note');
    audioNote.textContent = 'Profilo microfono e Noise Gate sono configurabili nel pannello principale «🎙️ Audio & Lip-sync».';
    recorderBox.body.appendChild(audioNote);

    const rawBackup = document.createElement('input'); rawBackup.type = 'checkbox';
    bindRefresh(() => { rawBackup.checked = !!rc().raw_audio_backup; rawBackup.disabled = (rc().mode || 'video_audio') === 'video'; });
    rawBackup.onchange = () => saveRec('raw_audio_backup', rawBackup.checked, false);
    row(recorderBox.body, 'RAW microphone backup', rawBackup, {
      reset: () => saveRec('raw_audio_backup', defaults.recorder.raw_audio_backup, false),
      isDefault: () => !!rc().raw_audio_backup === defaults.recorder.raw_audio_backup,
      sub: 'Records a second, un-gated microphone track so a bad gate/compressor choice never ruins the podcast source.'
    });

    const rawFormat = select([['flac','FLAC (lossless)'],['opus','Opus'],['wav','WAV (large)']]);
    bindRefresh(() => { rawFormat.value = rc().raw_audio_format || 'flac'; rawFormat.disabled = !rc().raw_audio_backup || (rc().mode || 'video_audio') === 'video'; });
    rawFormat.onchange = () => saveRec('raw_audio_format', rawFormat.value, false);
    row(recorderBox.body, 'RAW backup format', rawFormat, {
      reset: () => saveRec('raw_audio_format', defaults.recorder.raw_audio_format, false),
      isDefault: () => (rc().raw_audio_format || defaults.recorder.raw_audio_format) === defaults.recorder.raw_audio_format
    });

    const ENCODER_LABELS = {
      'h264_nvenc': 'NVIDIA NVENC (Hardware)',
      'h264_qsv': 'Intel Quick Sync (Hardware)',
      'h264_amf': 'AMD AMF (Hardware)',
      'h264_videotoolbox': 'Apple VideoToolbox (Hardware)',
      'libx264': 'CPU · libx264'
    };

    const hwEncode = select([
      ['auto', 'Auto hardware / CPU fallback'],
      ['libx264', 'CPU · libx264']
    ]);
    bindRefresh(() => { hwEncode.value = rc().hardware_encode || 'auto'; });
    hwEncode.onchange = () => saveRec('hardware_encode', hwEncode.value, false);

    async function refreshHwEncoders() {
      try {
        const caps = await XRA.recorder?.capabilities?.();
        const available = caps?.h264 || [];
        const opts = [['auto', 'Auto hardware / CPU fallback']];
        for (const enc of available) {
          if (enc === 'libx264') continue;
          opts.push([enc, ENCODER_LABELS[enc] || enc]);
        }
        opts.push(['libx264', 'CPU · libx264']);
        const currentVal = rc().hardware_encode || 'auto';
        hwEncode.innerHTML = '';
        for (const [val, label] of opts) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          hwEncode.appendChild(opt);
        }
        hwEncode.value = opts.some(([v]) => v === currentVal) ? currentVal : 'auto';
      } catch (e) {}
    }
    refreshHwEncoders();

    row(recorderBox.body, 'MP4 encoder', hwEncode, {
      reset: () => saveRec('hardware_encode', defaults.recorder.hardware_encode, false),
      isDefault: () => (rc().hardware_encode || defaults.recorder.hardware_encode) === defaults.recorder.hardware_encode,
      sub: 'Auto tries available hardware encoding first and falls back to libx264 if the hardware path fails.'
    });

    const segment = select([[0, 'Off'], [30, 'Every 30 min'], [60, 'Every 60 min']]);
    bindRefresh(() => { segment.value = String(rc().segment_minutes || 0); });
    segment.onchange = () => saveRec('segment_minutes', Number(segment.value), false);
    row(recorderBox.body, 'Segment files', segment, {
      reset: () => saveRec('segment_minutes', defaults.recorder.segment_minutes, false),
      isDefault: () => Number(rc().segment_minutes || 0) === defaults.recorder.segment_minutes,
      sub: 'Available for Clean scene. XR native output currently keeps one continuous native file so video fidelity is not interrupted.'
    });

    bindRefresh(() => {
      const currentMode = rc().mode || 'video_audio';
      const noVideo = currentMode === 'audio';
      const noAudio = currentMode === 'video';
      resolution.disabled = recFps.disabled = videoBitrate.disabled = noVideo;
      outputFormat.disabled = filename.disabled = folder.disabled = false;
      trueResolution.disabled = noVideo || rc().capture_source === 'native_xr' || rc().capture_source === 'browser_visible' || rc().capture_source === 'native_visible';
      segment.disabled = rc().capture_source === 'native_xr';
      chromaSafe.disabled = noVideo;
      audioBitrate.disabled = noAudio;
    });

    const recStatus = el('div', 'xra-status', 'Ready.');
    const humanBytes = bytes => {
      bytes = Number(bytes || 0); if (bytes < 1024) return `${bytes} B`;
      const units = ['KB','MB','GB']; let v = bytes / 1024, i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
    };
    const humanTime = ms => { const sec = Math.floor(Number(ms || 0)/1000); const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), ss=sec%60; return [h,m,ss].map(v=>String(v).padStart(2,'0')).join(':'); };
    function updateRecStatus(state = XRA.recorder.status()) {
      const estimate30 = humanBytes(XRA.recorder.estimateBytes(30));
      const estimateHour = humanBytes(XRA.recorder.estimateBytesPerHour());
      recStatus.classList.toggle('recording', !!state.active);
      const nativeXr = state.capture_strategy === 'native_xr' || rc().capture_source === 'native_xr' || rc().capture_source === 'browser_visible' || rc().capture_source === 'native_visible';
      const sourceName = nativeXr ? 'XR NATIVE OUTPUT' : 'CLEAN SCENE';
      recStatus.textContent = state.active
        ? (nativeXr
          ? `● REC ${humanTime(state.elapsed_ms)} · ${sourceName} · ${state.preset || rc().preset || 'CUSTOM'} · native high-quality capture\nFinal size/path available on STOP`
          : `● REC ${humanTime(state.elapsed_ms)} · ${sourceName} · ${state.preset || rc().preset || 'CUSTOM'} · ${humanBytes(state.bytes)} · part ${state.segment}\n${state.path || 'writing…'}`)
        : `Ready · ${sourceName} · 30 min ≈ ${estimate30} · 1 h ≈ ${estimateHour} · ${(rc().output_format || 'webm').toUpperCase()}${state.path ? `\nLast: ${state.path}` : ''}`;
      startRec.disabled = !!state.active;
      stopRec.disabled = !state.active;
    }

    function confirmRecordingStart() {
      return new Promise(resolve => {
        const overlay = el('div', 'xra-overlay'); overlay.dataset.xraRecordingConfirm = '1';
        const card = el('div', 'xra-start-card');
        card.appendChild(el('h2', '', 'Start recording?'));
        card.appendChild(el('div', 'xra-sub', `Current quality: ${rc().width}×${rc().height} @ ${rc().fps} FPS · 30 min ≈ ${humanBytes(XRA.recorder.estimateBytes(30))}`));

        const nameLabel = el('label', 'xra-sub', 'File name');
        const nameInput = stopInputPropagation(document.createElement('input')); nameInput.className = 'xra-control'; nameInput.type = 'text'; nameInput.value = rc().filename || 'XR_Animator_{date}_{time}';
        const dirLabel = el('label', 'xra-sub', 'Folder (absolute Linux path)');
        const dirInput = stopInputPropagation(document.createElement('input')); dirInput.className = 'xra-control'; dirInput.type = 'text'; dirInput.value = rc().output_dir || ''; dirInput.placeholder = '/home/user/Videos/podcast'; dirInput.autocomplete = 'off'; dirInput.spellcheck = false;
        const sourceLabel = el('label', 'xra-sub', 'Recording source');
        const sourceInput = select([['classic_v74','Classic output · recommended'],['clean_scene','Clean scene output · experimental (no UI)'],['native_xr','XR native video only · fallback (no external background)']]); { let v = rc().capture_source || 'classic_v74'; if (v === 'native_visible' || v === 'browser_visible') v = 'classic_v74'; sourceInput.value = v; }
        const fmtLabel = el('label', 'xra-sub', 'Format');
        const fmtInput = select([['webm','WebM'],['mp4','MP4'],['mkv','MKV']]); fmtInput.value = rc().output_format || 'webm';
        const summary = el('div', 'xra-status');
        const refreshSummary = () => {
          const nativeXr = sourceInput.value === 'native_xr';
          const classic = sourceInput.value === 'classic_v74';
          summary.textContent = `Source: ${nativeXr ? 'XR native video-only output' : (classic ? 'Classic compositor (recommended)' : 'clean internal scene (experimental)')}\nDestination: ${dirInput.value || '[XR Animator]/recordings'}\n${nameInput.value || 'recording'} · ${fmtInput.value.toUpperCase()} · ${rc().width}×${rc().height} @ ${rc().fps} FPS · ${(Number(rc().video_bps || 0)/1e6).toFixed(1)} Mbps · 30 min ≈ ${humanBytes(XRA.recorder.estimateBytes(30))}${nativeXr ? '\nNo Chrome screen-sharing permission. Native video + XRA processed podcast audio.' : ''}`;
        };
        [nameInput, dirInput, fmtInput, sourceInput].forEach(n => n.addEventListener('input', refreshSummary)); sourceInput.addEventListener('change', refreshSummary); refreshSummary();
        const actions = el('div', 'xra-actions');
        const cancel = button('Cancel'); const go = button('● Start recording', 'xra-action primary');
        const close = value => { overlay.remove(); resolve(value); };
        cancel.onclick = () => close(false);
        go.onclick = () => {
          rc().capture_source = sourceInput.value;
          rc().filename = nameInput.value.trim() || 'XR_Animator_{date}_{time}';
          rc().output_dir = dirInput.value.trim();
          rc().output_format = fmtInput.value;
          XRA.profileService.save().catch(e => console.warn('[XRA RECORDER] profile save before REC failed', e));
          close(true);
        };
        actions.append(cancel, go);
        card.append(sourceLabel, sourceInput, nameLabel, nameInput, dirLabel, dirInput, fmtLabel, fmtInput, summary, actions);
        overlay.appendChild(card); document.body.appendChild(overlay); nameInput.focus(); nameInput.select();
      });
    }

    const recActions = el('div', 'xra-actions');
    const startRec = button('● Record', 'xra-action primary');
    startRec.onclick = async () => {
      if (!await confirmRecordingStart()) return;
      startRec.disabled = true;
      try { await XRA.recorder.start(); updateRecStatus(); }
      catch (e) { XRA.toast('Recorder start: ' + e.message, 'error', 5000); }
      finally { updateRecStatus(); }
    };
    const stopRec = button('■ Stop');
    stopRec.onclick = async () => {
      stopRec.disabled = true;
      try {
        const result = await XRA.recorder.stop();
        if (result?.path) XRA.toast(`Saved: ${result.path}`, 'info', 5000);
      }
      catch (e) { XRA.toast('Recorder stop: ' + e.message, 'error', 5000); }
      finally { updateRecStatus(); }
    };
    recActions.append(startRec, stopRec);
    recorderBox.body.append(recActions, recStatus);

    const recoveryBox = details(recorderBox.body, 'Interrupted recording recovery');
    const recoveryStatus = el('div', 'xra-status', 'No scan yet.');
    const scanRecovery = button('Scan unfinished recordings');
    const recoverLatest = button('Recover latest'); recoverLatest.disabled = true;
    let recoveryItems = [];
    scanRecovery.onclick = async () => {
      scanRecovery.disabled = true;
      try {
        recoveryItems = await XRA.recorder.listRecoveries();
        recoverLatest.disabled = !recoveryItems.length;
        recoveryStatus.textContent = recoveryItems.length
          ? `${recoveryItems.length} unfinished recording(s). Latest: ${recoveryItems[0].final_path || recoveryItems[0].path}`
          : 'No unfinished recordings found.';
      } catch (e) { recoveryStatus.textContent = 'Recovery scan error: ' + e.message; }
      finally { scanRecovery.disabled = false; }
    };
    recoverLatest.onclick = async () => {
      const item = recoveryItems[0]; if (!item?.session) return;
      recoverLatest.disabled = true;
      recoveryStatus.textContent = 'Recovering / finalizing…';
      try {
        const result = await XRA.recorder.recover(item.session);
        recoveryStatus.textContent = `Recovered: ${result.path}`;
        XRA.toast('Recovered recording: ' + result.path, 'info', 7000);
        await scanRecovery.onclick();
      } catch (e) { recoveryStatus.textContent = 'Recovery failed: ' + e.message; }
      finally { recoverLatest.disabled = !recoveryItems.length; }
    };
    const recoveryActions = el('div', 'xra-actions'); recoveryActions.append(scanRecovery, recoverLatest);
    recoveryBox.body.append(recoveryStatus, recoveryActions);
    bindRefresh(updateRecStatus);
    events.on('recording-progress', updateRecStatus);
    events.on('recording-start', updateRecStatus);
    events.on('recording-stop', updateRecStatus);
    events.on('recorder-config', updateRecStatus);
    // Best effort: once the shared mic engine is already available (normally via
    // lip sync), show live dB without opening a second microphone capture.
    setTimeout(() => {
      if (XRA.audioEngine?.status?.().active && !XRA.recorder.status().active) {
        XRA.recorder.startGateMonitor().then(() => { monitorStart.disabled = true; monitorStop.disabled = false; }).catch(() => {});
      }
    }, 1800);

    const exportBox = details(capture.body, 'Export motion');
    const motionSource = () => window.System?._browser?.camera?.motion_recorder?.vmd ||
      window.MMD_SA?.vmd_by_filename?.[window.MMD_SA?.MMD?.motionManager?.filename];
    const motionName = () => window.MMD_SA?.MMD?.motionManager?.filename || `motion_${Date.now()}`;

    async function exportMotion(format) {
      const vmd = motionSource();
      if (!vmd) throw new Error('No motion available for export');
      const baseName = motionName();
      if (format === 'vmd') {
        await window.MMD_SA?.VMD_FileWriter?.();
        if (typeof window.VMD_FileWriter !== 'function') throw new Error('VMD writer not ready');
        VMD_FileWriter(`${baseName}.vmd`, vmd.boneKeys, vmd.morphKeys);
      }
      else if (format === 'glb') {
        const fn = window.MMD_SA?.THREEX?.utils?.export_GLTF_motion;
        if (typeof fn !== 'function') throw new Error('glTF exporter not ready');
        fn(`${baseName}.glb`, vmd);
      }
      else if (format === 'bvh') {
        await window.System?._browser?.load_script?.(toFileProtocol(System.Gadget.path + '/js/BVH_filewriter.js'));
        if (typeof window.BVH_FileWriter !== 'function') throw new Error('BVH writer not ready');
        BVH_FileWriter(`${baseName}.bvh`, vmd.boneKeys);
      }
      else if (format === 'vrma') {
        const fn = window.MMD_SA?.THREEX?.utils?.export_VRMA;
        if (typeof fn !== 'function') throw new Error('VRMA exporter not ready');
        fn();
      }
    }

    const exportGrid = el('div', 'xra-inline-grid');
    for (const [fmt, label] of [['vmd','VMD'],['glb','glTF'],['bvh','BVH'],['vrma','VRMA']]) {
      const b = button(label);
      b.onclick = async () => {
        b.disabled = true;
        try { await exportMotion(fmt); }
        catch (e) { XRA.toast(`Export ${label}: ${e.message}`, 'error', 4500); }
        finally { b.disabled = false; }
      };
      exportGrid.appendChild(b);
    }
    exportBox.body.appendChild(exportGrid);

    const vmc = details(content, '📡 VMC / OSC');
    vmc.body.appendChild(el('div', 'xra-note',
      'Consente la trasmissione in tempo reale dei dati di movimento via protocollo VMC/OSC verso software esterni compatibili.'));
    addToggle(vmc.body, 'VMC sender',
      () => !!window.MMD_SA?.OSC?.VMC?.sender_enabled,
      value => {
        if (window.MMD_SA?.OSC?.VMC) MMD_SA.OSC.VMC.sender_enabled = value;
        if (window.MMD_SA_options?.user_camera?.streamer_mode) MMD_SA_options.user_camera.streamer_mode.VMC_sender_enabled = value;
      });

    addText(vmc.body, 'Host',
      () => window.MMD_SA?.OSC?.VMC?.options?.plugin?.send?.host || 'localhost',
      value => { const send = window.MMD_SA?.OSC?.VMC?.options?.plugin?.send; if (send) send.host = value; });

    addNumber(vmc.body, 'Port',
      () => Number(window.MMD_SA?.OSC?.VMC?.options?.plugin?.send?.port || 39539),
      value => { const send = window.MMD_SA?.OSC?.VMC?.options?.plugin?.send; if (send && value != null) send.port = value; },
      { min: 1, max: 65535, step: 1 });

    addNumber(vmc.body, 'Delay',
      () => Number(window.MMD_SA?.OSC?.VMC?.delay || 0),
      value => { if (window.MMD_SA?.OSC?.VMC && value != null) MMD_SA.OSC.VMC.delay = value; },
      { min: 0, max: 5000, step: 1 });
  }

  function addAdvanced(content) {
    const box = details(content, '🧪 Advanced native settings');
    box.body.appendChild(el('div', 'xra-note', 'Visualizzatore ed editor completo per esportare e importare la configurazione dei parametri in formato JSON.'));

    nativeJson = stopInputPropagation(document.createElement('textarea'));
    nativeJson.className = 'xra-native-json';
    nativeJson.spellcheck = false;
    box.body.appendChild(nativeJson);

    const actions = el('div', 'xra-actions');
    const refresh = button('Refresh JSON');
    refresh.onclick = () => refreshNativeJSON();
    const apply = button('Apply JSON');
    apply.onclick = async () => {
      try {
        const object = JSON.parse(nativeJson.value);
        if (typeof window.MMD_SA_options?._XRA_settings_import !== 'function') throw new Error('Native importer not ready');
        await MMD_SA_options._XRA_settings_import(object);
        XRA.profile.XR_Animator_settings = object;
        await XRA.profileService.save(0);
        XRA.toast('Native settings applied');
        refreshAll();
      }
      catch (e) { XRA.toast('Native JSON error: ' + e.message, 'error', 4500); }
    };
    actions.append(refresh, apply);
    box.body.appendChild(actions);
  }

  function refreshNativeJSON() {
    if (!nativeJson) return;
    try {
      const object = window.MMD_SA_options?._XRA_settings_export?.();
      nativeJson.value = JSON.stringify(object || {}, null, 2);
    }
    catch (e) {
      nativeJson.value = '// Native settings exporter not ready';
    }
  }

  function setOpen(value) {
    opened = !!value;
    root?.classList.toggle('open', opened);
    const launcher = root?.querySelector('[data-xra-native-launcher]');
    if (launcher) {
      // The drawer already has an explicit × close button. Hide the launcher
      // while open instead of showing a redundant ‹ arrow beside the panel.
      launcher.hidden = opened;
      launcher.textContent = '⚙ IMPOSTAZIONI XRP';
    }
    if (opened) {
      refreshAll();
      setTimeout(refreshNativeJSON, 0);
    }
  }

  async function create() {
    if (root) return root;
    await XRA.whenNativeReady();

    root = el('div', 'xra-native-root');
    root.id = 'XRA_NATIVE_SETTINGS';
    UI.registerHideable(root);

    const leftHeader = el('div', 'xra-left-header');
    const quitBtn = button('✕ CHIUDI', 'xra-app-quit');
    quitBtn.title = 'Chiudi applicazione';
    quitBtn.onclick = async () => {
      if (window.XRA_RECORDING_ACTIVE) {
        if (!confirm('Una registrazione è in corso. Vuoi davvero interrompere e chiudere XR Animator?')) return;
      }
      await XRA.nativeBridge?.quitApp?.();
    };
    leftHeader.appendChild(quitBtn);

    const launcher = button('⚙ IMPOSTAZIONI XRP', 'xra-native-launcher');
    launcher.dataset.xraNativeLauncher = '1';
    launcher.onclick = () => setOpen(!opened);

    drawer = el('div', 'xra-native-drawer');
    const header = el('div', 'xra-native-header');
    header.appendChild(el('div', 'xra-native-title', '⚙ IMPOSTAZIONI XRP'));
    const close = button('×', 'xra-native-close');
    close.title = 'Close panel';
    close.onclick = () => setOpen(false);
    header.appendChild(close);

    const content = el('div', 'xra-native-content');
    content.appendChild(el('div', 'xra-note', 'XR SETTINGS includes advanced avatar and scene settings not present in the quick panel.'));
    addAvatarApp(content);
    addUIAndOverlays(content);
    addPose(content);
    addWebcamMedia(content);
    addMotion(content);
    addHands(content);
    addFace(content);
    addCaptureVMC(content);
    addMiscNative(content);
    addAdvanced(content);

    drawer.append(header, content);
    root.append(leftHeader, launcher, drawer);
    document.body.appendChild(root);

    events.on('profile-loaded', () => { XRA.nativeBridge?.hideNativeShellChrome?.(); restorePersistedLeftState(); refreshNativeJSON(); });
    XRA.nativeBridge?.hideNativeShellChrome?.();
    restorePersistedLeftState();
    refreshAll();
    setOpen(false);
    return root;
  }

  XRA.xrSettings = { create, setOpen, refresh: refreshAll, refreshNativeJSON, restorePersistedLeftState, snapshotPersistedLeftState };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => create(), { once: true });
  else create();

})();
