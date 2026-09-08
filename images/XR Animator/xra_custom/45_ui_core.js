(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA UI CORE]';
  const { events } = XRA;

  const refreshers = new Set();
  const hideables = new Set();
  let uiHidden = false;
  let nativeWasVisible = true;
  let toastHost = null;
  let nativeNoticeHost = null;
  const nativeNotices = new Map();

  function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== '') node.textContent = text;
    return node;
  }

  function button(text, cls = 'xra-action') {
    const node = el('button', cls, text);
    node.type = 'button';
    queueMicrotask(() => XRA.help?.attach?.(node, text));
    return node;
  }

  function select(options = []) {
    const node = el('select', 'xra-control');
    for (const [value, label] of options) {
      const option = document.createElement('option');
      option.value = String(value == null ? '__null__' : value);
      option.textContent = String(label);
      node.appendChild(option);
    }
    return node;
  }

  function bindRefresh(fn) {
    refreshers.add(fn);
    queueMicrotask(() => {
      try { fn(); }
      catch (e) { console.warn(TAG, 'initial refresh failed', e); }
    });
    return () => refreshers.delete(fn);
  }

  function refreshAll() {
    for (const fn of refreshers) {
      try { fn(); }
      catch (e) { console.warn(TAG, 'refresh failed', e); }
    }
  }

  function resetButton(reset, isDefault, title = 'Ripristina il valore predefinito') {
    const b = button('↺', 'xra-reset');
    b.title = title;
    const refresh = () => {
      let atDefault = false;
      try { atDefault = !!isDefault(); }
      catch (e) {}
      b.disabled = atDefault;
    };
    bindRefresh(refresh);
    // Expose the row-local reset-state refresher so sliders/selects can update
    // the ↺ button immediately, without forcing a full-panel refresh on every tick.
    b._xraRefreshReset = refresh;
    b.onclick = async event => {
      event.preventDefault();
      event.stopPropagation();
      await reset();
      await XRA.profileService.save();
      refreshAll();
    };
    return b;
  }

  function row(parent, labelText, control, options = {}) {
    const { reset = null, isDefault = null, sub = '', compact = false } = options;
    const r = el('div', 'xra-row' + (compact ? ' compact' : '') + (!reset ? ' no-reset' : ''));
    const label = el('div', 'xra-row-label');
    label.appendChild(el('div', 'xra-label', labelText));
    if (sub) label.appendChild(el('div', 'xra-sub', sub));
    r.append(label, control);
    queueMicrotask(() => XRA.help?.attach?.(r, labelText));
    if (reset) {
      const resetNode = resetButton(reset, isDefault || (() => false));
      r.appendChild(resetNode);
      const refreshReset = resetNode._xraRefreshReset;
      if (control?.addEventListener && typeof refreshReset === 'function') {
        // input covers live range dragging; change covers selects/checkboxes/text.
        // Events from controls nested in wrapper DIVs bubble here as well.
        control.addEventListener('input', () => queueMicrotask(refreshReset));
        control.addEventListener('change', () => queueMicrotask(refreshReset));
      }
    }
    parent.appendChild(r);
    return r;
  }

  function details(parent, title, { open = false, cls = '' } = {}) {
    const node = el('details', 'xra-details' + (cls ? ' ' + cls : ''));
    node.open = !!open;
    const summary = el('summary', '', title);
    queueMicrotask(() => XRA.help?.attach?.(summary, title));
    node.appendChild(summary);
    const body = el('div', 'xra-details-body');
    node.appendChild(body);
    parent.appendChild(node);
    return { details: node, body, summary };
  }

  function stopInputPropagation(node) {
    for (const name of ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown', 'click']) {
      node.addEventListener(name, e => e.stopPropagation());
    }
    return node;
  }

  function nativeUIVisible() {
    const target = document.querySelector('#Ldungeon_inventory, #Ldungeon_UI');
    if (!target) return true;
    const style = getComputedStyle(target);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function sendEscape() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }));
      return true;
    }
    catch (e) { return false; }
  }

  function registerHideable(node) {
    if (node) hideables.add(node);
    return node;
  }

  function setHidden(hidden) {
    hidden = !!hidden;
    if (hidden === uiHidden) return;
    uiHidden = hidden;

    if (hidden) {
      nativeWasVisible = nativeUIVisible();
      if (nativeWasVisible) sendEscape();
      document.body.classList.add('xra-native-ui-hidden');
      for (const node of hideables) node.hidden = true;
    }
    else {
      document.body.classList.remove('xra-native-ui-hidden');
      for (const node of hideables) node.hidden = false;
      requestAnimationFrame(() => {
        if (nativeWasVisible && !nativeUIVisible()) sendEscape();
      });
    }

    events.emit('ui-hidden', uiHidden);
    refreshAll();
  }

  function ensureToastHost() {
    if (toastHost?.isConnected) return toastHost;
    toastHost = el('div', 'xra-toast-host');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function ensureNativeNoticeHost() {
    if (nativeNoticeHost?.isConnected) return nativeNoticeHost;
    nativeNoticeHost = el('div', 'xra-native-notice-host');
    nativeNoticeHost.setAttribute('aria-live', 'polite');
    nativeNoticeHost.setAttribute('aria-atomic', 'false');
    if (uiHidden) nativeNoticeHost.hidden = true;
    registerHideable(nativeNoticeHost);
    document.body.appendChild(nativeNoticeHost);
    return nativeNoticeHost;
  }

  function showNativeNotice(id, message, { title = 'XR Animator', interactive = false, actions = [] } = {}) {
    id = String(id || 'system');
    message = String(message || '').trim();
    if (!message && !actions.length) return hideNativeNotice(id);

    const host = ensureNativeNoticeHost();
    let notice = nativeNotices.get(id);
    if (!notice?.isConnected) {
      notice = el('section', 'xra-native-notice');
      notice.dataset.noticeId = id;
      const heading = el('div', 'xra-native-notice-heading');
      heading.append(el('span', 'xra-native-notice-dot'), el('span', 'xra-native-notice-title'));
      notice.append(
        heading,
        el('div', 'xra-native-notice-message'),
        el('div', 'xra-native-notice-actions')
      );
      nativeNotices.set(id, notice);
      host.appendChild(notice);
    }
    notice.querySelector('.xra-native-notice-title').textContent = title;
    notice.querySelector('.xra-native-notice-message').textContent = message;
    const actionsNode = notice.querySelector('.xra-native-notice-actions');
    actionsNode.replaceChildren();
    for (const action of actions) {
      if (!action || typeof action.onClick !== 'function') continue;
      const control = button(action.label || action.key || 'OK', 'xra-action');
      control.onclick = action.onClick;
      if (action.key) {
        control.dataset.key = action.key;
        control.setAttribute('aria-keyshortcuts', action.key);
      }
      actionsNode.appendChild(control);
    }
    const hasActions = actionsNode.childElementCount > 0;
    actionsNode.hidden = !hasActions;
    notice.classList.toggle('interactive', !!interactive || hasActions);
    host.hidden = uiHidden;
    return notice;
  }

  function hideNativeNotice(id) {
    id = String(id || 'system');
    const notice = nativeNotices.get(id);
    if (notice) notice.remove();
    nativeNotices.delete(id);
    if (nativeNoticeHost && !nativeNotices.size) nativeNoticeHost.hidden = true;
  }

  events.on('toast', ({ message, type = 'info', ms = 2500 }) => {
    const host = ensureToastHost();
    const toast = el('div', 'xra-toast ' + type, message);
    host.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
  });

  events.on('profile-loaded', refreshAll);
  events.on('state', refreshAll);
  events.on('performance-applied', refreshAll);
  events.on('pipeline', refreshAll);
  events.on('preset', refreshAll);
  events.on('hands', refreshAll);
  events.on('body-stable', refreshAll);
  events.on('body-transition', refreshAll);
  events.on('body-transition-end', refreshAll);
  events.on('collider', refreshAll);
  events.on('background', refreshAll);

  XRA.uiCore = {
    el,
    button,
    select,
    row,
    details,
    resetButton,
    bindRefresh,
    refreshAll,
    stopInputPropagation,
    registerHideable,
    setHidden,
    sendEscape,
    nativeUIVisible,
    showNativeNotice,
    hideNativeNotice,
    get hidden() { return uiHidden; }
  };

  XRA.ui = Object.assign(XRA.ui || {}, {
    setHidden,
    refresh: refreshAll,
    get hidden() { return uiHidden; }
  });

})();
