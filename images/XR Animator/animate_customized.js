// XR Animator custom UI and unified body-stabilization bootstrap.
// Stability rule: startup/LOAD never restart the mocap pipeline via init_mocap.
// Right side = our custom controls. Left side = native XR settings not duplicated on the right.

MMD_SA_options.OSC = {
  VMC: {
    send: {
      port: 39539,
      host: 'localhost'
    }
  }
};

// XR Animator's legacy startup screen owns the large blue START button and
// writes its instructions into Ldebug. Our startup card replaces that flow;
// disabling it here lets the native loader initialise immediately, without a
// synthetic click or a flash of the old UI.
MMD_SA_options.startup_screen = false;

(() => {
  const base = toFileProtocol(Settings.f_path + '/xra_custom');
  const assetVersion = '7.80';

  // Tiny boot assignment keeps startup ordering deterministic without synchronous XHR.
  document.write('<script src="/__xra_boot_profile.js"></scr' + 'ipt>');
  document.write('<link rel="stylesheet" href="' + base + '/xra.css?v=' + assetVersion + '">');

  const scripts = [
    '00_core.js',
    '05_i18n.js',
    '10_performance.js',
    '20_tracking.js',
    '30_background.js',
    '39_audio_engine.js',
    '40_lip_sync.js',
    '42_recorder.js',
    '45_ui_core.js',
    '46_help.js',
    '50_right_panel.js',
    '52_native_bridge.js',
    '55_xr_settings.js',
    '60_startup.js'
  ];

  for (const file of scripts) {
    document.write('<script src="' + base + '/' + file + '?v=' + assetVersion + '"></scr' + 'ipt>');
  }
})();
