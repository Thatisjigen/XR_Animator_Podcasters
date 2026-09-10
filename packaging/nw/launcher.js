'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8000;
const APP_ROOT = path.dirname(process.execPath);
const SERVER_PATH = path.join(APP_ROOT, process.platform === 'win32' ? 'xra_server.exe' : 'xra_server');

let serverProcess = null;
let mainWindow = null;
let shuttingDown = false;

function probeXra(port) {
  return new Promise(resolve => {
    const request = http.get({ host: HOST, port, path: '/__xra_profile', timeout: 900 }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (data.length < 8192) data += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(false);
        try {
          const profile = JSON.parse(data);
          resolve(!!profile && typeof profile === 'object' && !!profile.custom);
        }
        catch (_) { resolve(false); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function canBind(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.listen(port, HOST, () => tester.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', reject);
    tester.listen(0, HOST, () => {
      const address = tester.address();
      tester.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await probeXra(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function stopOwnedServer() {
  if (!serverProcess || serverProcess.killed) return;
  try { serverProcess.kill('SIGTERM'); } catch (_) {}
  const processToStop = serverProcess;
  setTimeout(() => {
    if (processToStop.exitCode == null) {
      try { processToStop.kill('SIGKILL'); } catch (_) {}
    }
  }, 1400).unref();
  serverProcess = null;
}

function quit() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopOwnedServer();
  nw.App.quit();
}

function showError(message) {
  const safe = String(message).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const page = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <html><head><meta charset="utf-8"><title>XR Animator</title>
    <style>body{margin:0;padding:34px;background:#111;color:#eee;font:14px/1.55 system-ui}h1{font-size:20px}code{color:#7cdda7}</style>
    </head><body><h1>XR Animator non può partire</h1><p>${safe}</p><p><code>${SERVER_PATH}</code></p></body></html>`);
  nw.Window.open(page, { title: 'XR Animator · errore', width: 620, height: 310, position: 'center' }, win => {
    mainWindow = win;
    win.on('closed', quit);
  });
}

function configureChildWindows(win, port) {
  win.on('new-win-policy', (_frame, requestedUrl, policy) => {
    let target;
    try { target = new URL(requestedUrl); }
    catch (_) { return; }

    const isStudioLink = target.hostname === HOST
      && Number(target.port || 80) === port
      && target.pathname === '/p2p_chat.html';
    if (!isStudioLink) return;

    const size = getWorkAreaSize();
    policy.setNewWindowManifest({
      id: 'xra-studio-link',
      title: 'Studio Link · XR Animator',
      width: size.width,
      height: size.height,
      min_width: 720,
      min_height: 540,
      position: 'center',
      frame: true,
      resizable: true,
      focus: true
    });
    policy.forceNewWindow();
    if (IS_NIRI) {
      expandWindowOnNiri();
    }
  });
}

function getWorkAreaSize() {
  try {
    if (nw.Screen) {
      nw.Screen.Init();
      const screens = nw.Screen.screens;
      const primary = (screens && screens.length > 0) ? screens[0] : null;
      if (primary && primary.work_area) {
        return {
          width: Math.max(1280, primary.work_area.width || 1920),
          height: Math.max(720, primary.work_area.height || 1080)
        };
      }
    }
  } catch (_) {}
  return { width: 1920, height: 1080 };
}

const IS_NIRI = Boolean(process.env.NIRI_SOCKET || process.env.XDG_CURRENT_DESKTOP === 'niri');

function expandWindowOnNiri() {
  if (!IS_NIRI) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (attempts > 15) {
      clearInterval(timer);
      return;
    }
    childProcess.execFile('niri', ['msg', '-j', 'focused-window'], (err, stdout) => {
      if (err || !stdout) return;
      try {
        const info = JSON.parse(stdout);
        if (info.app_id === 'xr-animator-podcasters-bundled' || info.pid === process.pid) {
          childProcess.execFile('niri', ['msg', 'action', 'set-column-width', '100%'], () => {});
          clearInterval(timer);
        }
      } catch (_) {}
    });
  }, 150);
}

function restoreWindowOnNiri(savedWidth) {
  if (!IS_NIRI) return;
  const widthArg = (savedWidth && Number.isFinite(savedWidth) && savedWidth > 200)
    ? String(Math.round(savedWidth))
    : '100%';
  childProcess.execFile('niri', ['msg', 'action', 'set-column-width', widthArg], () => {});
}

function openAnimator(port) {
  const url = `http://${HOST}:${port}/XR_Animator.html`;
  const size = getWorkAreaSize();

  nw.Window.open(url, {
    id: 'xr-animator-main',
    title: 'XR Animator · Podcasters',
    width: size.width,
    height: size.height,
    min_width: 800,
    min_height: 560,
    position: 'center',
    frame: true,
    resizable: true,
    focus: true
  }, win => {
    mainWindow = win;
    configureChildWindows(win, port);

    let savedWidth = size.width;
    let savedHeight = size.height;

    win.on('resize', (w, h) => {
      if (!win.isFullscreen && w && h) {
        savedWidth = w;
        savedHeight = h;
      }
    });

    win.on('leave-fullscreen', () => {
      setTimeout(() => {
        try {
          if (IS_NIRI) {
            restoreWindowOnNiri(savedWidth);
            if (savedWidth && savedHeight) {
              win.resizeTo(savedWidth, savedHeight);
            }
          } else {
            win.maximize();
          }
        } catch (_) {}
      }, 50);
    });

    win.show();
    if (!IS_NIRI) {
      try { win.maximize(); } catch (_) {}
    } else {
      expandWindowOnNiri();
    }
    win.focus();
    win.on('closed', quit);
  });
}

async function start() {
  if (!fs.existsSync(SERVER_PATH)) {
    throw new Error('Il server incluso nel pacchetto non è stato trovato. Ricrea il bundle dalla root del progetto.');
  }

  // Always spawn the bundled server so that the package uses its own isolated
  // runtime and clean profile. If DEFAULT_PORT is occupied by another process,
  // pick a free port.
  const port = await canBind(DEFAULT_PORT) ? DEFAULT_PORT : await freePort();
  serverProcess = childProcess.spawn(SERVER_PATH, ['--port', String(port), '--no-browser'], {
    cwd: APP_ROOT,
    stdio: 'ignore',
    windowsHide: true
  });
  serverProcess.once('error', error => showError(`Avvio del server fallito: ${error.message}`));

  if (!await waitForServer(port)) {
    stopOwnedServer();
    throw new Error(`Il server locale non risponde sulla porta ${port}.`);
  }
  openAnimator(port);
}

nw.App.on('open', () => {
  try { mainWindow?.show(); mainWindow?.focus(); } catch (_) {}
});
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', stopOwnedServer);

start().catch(error => showError(error?.message || error));
