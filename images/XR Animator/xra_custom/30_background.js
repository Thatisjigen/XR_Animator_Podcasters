(() => {
  'use strict';

  const XRA = window.XRA;
  const TAG = '[XRA BG]';
  const { config, events } = XRA;

  function apply() {
    const bg = config.background || XRA.defaults.background;

    try {
      const videoBg = document.getElementById('VdesktopBG');
      if (videoBg) {
        videoBg.pause?.();
        videoBg.style.visibility = 'hidden';
      }

      if (bg.mode === 'image' && bg.path) {
        const src = new URL(bg.path, location.href);
        src.searchParams.set('_xra_bg', Date.now().toString());
        document.body.style.backgroundColor = bg.color || '#000000';

        if (window.LdesktopBG) {
          LdesktopBG.style.backgroundImage = `url("${src.href}")`;
          LdesktopBG.style.backgroundSize = 'cover';
          LdesktopBG.style.backgroundPosition = 'center center';
          LdesktopBG.style.backgroundRepeat = 'no-repeat';
        }
        if (window.LdesktopBG_host) LdesktopBG_host.style.display = 'block';
        try { window.wallpaper_src = bg.path; } catch (e) {}
      }
      else {
        try { window.wallpaper_src = null; } catch (e) {}
        if (window.LdesktopBG) LdesktopBG.style.backgroundImage = 'none';
        if (window.LdesktopBG_host) LdesktopBG_host.style.display = 'none';
        document.body.style.backgroundColor = bg.color || '#202020';
      }

      events.emit('background', bg);
      return true;
    }
    catch (e) {
      console.warn(TAG, 'apply failed', e);
      return false;
    }
  }

  async function list(force = false) {
    try {
      const r = await fetch('/__xra_backgrounds?' + (force ? 'refresh=1&' : '') + '_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      return Array.isArray(data.files) ? data.files : [];
    }
    catch (e) {
      console.warn(TAG, 'list failed', e);
      return [];
    }
  }

  window.addEventListener('SA_Dungeon_onstart', () => setTimeout(apply, 100));
  window.addEventListener('load', () => setTimeout(apply, 500));
  window.addEventListener('MMDStarted', () => setTimeout(apply, 500));
  events.on('profile-loaded', () => apply());

  XRA.background = { apply, list };
})();
