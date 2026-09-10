(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    myId: $('my-id'), copyId: $('copy-id-btn'), copyInvite: $('copy-invite-btn'),
    peerInput: $('peer-id-input'), connect: $('connect-btn'), connectHint: $('connect-hint'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    topbarFullscreen: $('topbar-fullscreen-btn'), sessionFullscreen: $('session-fullscreen-btn'),
    setup: $('setup-view'), session: $('session-view'), sessionPeer: $('session-peer'),
    sessionDevicesToggle: $('session-devices-toggle'), sessionDevicesPanel: $('session-devices-panel'),
    sessionDevicesClose: $('session-devices-close'),
    sessionAudioInput: $('session-audio-input-select'), sessionAudioOutput: $('session-audio-output-select'),
    sessionRefreshDevices: $('session-refresh-devices-btn'),
    disconnect: $('disconnect-btn'), muteBtn: $('mute-btn'),
    share: $('screenshare-btn'), stopShare: $('stop-share-btn'),
    syncBtn: $('sync-marker-btn'), chatSyncBtn: $('chat-sync-marker-btn'),
    mainVideo: $('main-video'), noVideo: $('no-video-msg'), shareLabel: $('share-label'), remoteAudio: $('remote-audio'),
    chatBox: $('chat-box'), chatEmpty: $('chat-empty'), chatInput: $('chat-input'), send: $('send-btn'), chatState: $('chat-state'),
    audioInput: $('audio-input-select'), audioOutput: $('audio-output-select'), refreshDevices: $('refresh-devices-btn')
  };

  let peer = null;
  let connection = null;
  let mediaCall = null;
  let localAudio = null;
  let displayStream = null;
  let remoteStream = null;
  let connectedPeerId = '';
  let isLocalSharePreview = false;
  let closingMedia = false;
  let autoConnectDone = false;
  let isMuted = false;

  function setNetworkState(kind, text) {
    ui.statusDot.className = 'status-dot' + (kind ? ` ${kind}` : '');
    ui.statusText.textContent = text;
  }

  function setHint(text, isError = false) {
    ui.connectHint.textContent = text;
    ui.connectHint.classList.toggle('error', isError);
  }

  function formatTime(date = new Date()) {
    return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function appendMessage(kind, text, time = new Date()) {
    const clean = String(text ?? '').slice(0, 4000);
    if (!clean) return;
    ui.chatEmpty?.remove();

    const item = document.createElement('article');
    item.className = `message ${kind}`;
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = clean;
    const meta = document.createElement('span');
    meta.className = 'message-meta';
    meta.textContent = kind === 'mine' ? `TU · ${formatTime(time)}` : `PEER · ${formatTime(time)}`;
    item.append(body, meta);
    ui.chatBox.appendChild(item);
    ui.chatBox.scrollTop = ui.chatBox.scrollHeight;
  }

  function setChatReady(ready) {
    ui.chatInput.disabled = !ready;
    ui.send.disabled = !ready;
    if (ui.syncBtn) ui.syncBtn.disabled = !ready;
    if (ui.chatSyncBtn) ui.chatSyncBtn.disabled = !ready;
    ui.chatState.textContent = ready ? 'online' : 'solo media';
    ui.chatState.classList.toggle('online', ready);
  }

  function isFullscreen() {
    if (typeof nw !== 'undefined' && nw?.Window?.get) {
      try { return !!nw.Window.get().isFullscreen; } catch (_) {}
    }
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenUi() {
    const active = isFullscreen();
    const label = active ? '🗗 Esci schermo intero' : '⛶ Schermo intero';
    if (ui.topbarFullscreen) ui.topbarFullscreen.textContent = label;
    if (ui.sessionFullscreen) ui.sessionFullscreen.textContent = label;
  }

  function toggleFullscreen() {
    if (typeof nw !== 'undefined' && nw?.Window?.get) {
      try {
        const win = nw.Window.get();
        win.toggleFullscreen();
        setTimeout(updateFullscreenUi, 100);
        return;
      } catch (_) {}
    }
    if (!isFullscreen()) {
      const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      req?.call(document.documentElement).catch(() => {});
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      exit?.call(document).catch(() => {});
    }
  }

  function isSharingScreenLocally() {
    return !!(displayStream && displayStream.getVideoTracks?.().some(track => track.readyState === 'live'));
  }

  function updateShareButtonsUi() {
    const isSharingLocally = isSharingScreenLocally();
    if (ui.stopShare) {
      ui.stopShare.hidden = !isSharingLocally;
      ui.stopShare.disabled = !isSharingLocally;
    }
    if (ui.share) {
      ui.share.hidden = isSharingLocally;
      ui.share.disabled = !activePeerId();
    }
  }

  function showSession(peerId) {
    connectedPeerId = String(peerId || connectedPeerId || '').trim();
    ui.sessionPeer.textContent = connectedPeerId || 'Peer remoto';
    ui.setup.hidden = true;
    ui.session.hidden = false;
    updateShareButtonsUi();
  }

  function showSetup() {
    connectedPeerId = '';
    ui.setup.hidden = false;
    ui.session.hidden = true;
    if (ui.sessionDevicesPanel) ui.sessionDevicesPanel.hidden = true;
    ui.sessionDevicesToggle?.classList.remove('active');
    setChatReady(false);
    ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
    updateShareButtonsUi();
  }

  function activePeerId() {
    return connection?.peer || connectedPeerId || ui.peerInput.value.trim();
  }

  async function copyText(text, successMessage) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    }
    catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setNetworkState('online', successMessage);
    setTimeout(() => {
      if (connection?.open) setNetworkState('online', `Connesso a ${connection.peer}`);
      else if (peer?.open) setNetworkState('online', 'Pronto a collegarsi');
    }, 1500);
  }

  function inviteUrl() {
    if (!peer?.id) return '';
    const url = new URL('/p2p_chat.html', location.href);
    url.searchParams.set('peer', peer.id);
    return url.href;
  }

  /* ============================================================
     P2P Recording Synchronization
     ============================================================ */
  let syncMarkerCount = 0;
  let lastSyncRecordingPath = '';
  const pendingSyncQueries = new Map();

  function formatPreciseTime(ms) {
    const totalMs = Math.max(0, Math.floor(Number(ms || 0)));
    const sec = Math.floor(totalMs / 1000);
    const millis = totalMs % 1000;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function probeBroadcastChannelStatus() {
    if (typeof BroadcastChannel === 'undefined') return Promise.resolve(null);
    return new Promise(resolve => {
      let resolved = false;
      const channel = new BroadcastChannel('xra-recorder-sync');
      const reqId = 'req_' + Math.random().toString(36).slice(2, 7);
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { channel.close(); } catch (_) {}
          resolve(null);
        }
      }, 150);

      channel.onmessage = e => {
        if (e.data?.type === 'pong-recorder-status' && e.data?.requestId === reqId) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try { channel.close(); } catch (_) {}
            const st = e.data.status || {};
            const filename = st.filename || (st.path ? st.path.replace(/^.*[\\/]/, '') : '');
            resolve({
              active: !!st.active,
              elapsed_ms: Number(st.elapsed_ms || 0),
              path: st.path || '',
              filename,
              base_name: st.base_name || '',
              output_dir: st.resolved_output_dir || ''
            });
          }
        }
      };

      channel.postMessage({ type: 'ping-recorder-status', requestId: reqId });
    });
  }

  async function getLocalRecorderStatus() {
    // 1. Direct window.opener access
    try {
      if (window.opener?.XRA?.recorder?.status) {
        const st = window.opener.XRA.recorder.status();
        const filename = st.filename || (st.path ? st.path.replace(/^.*[\\/]/, '') : '');
        return {
          active: !!st.active,
          elapsed_ms: Number(st.elapsed_ms || 0),
          path: st.path || '',
          filename,
          base_name: st.base_name || '',
          output_dir: st.resolved_output_dir || ''
        };
      }
    } catch (_) {}

    // 2. BroadcastChannel probe
    try {
      const bc = await probeBroadcastChannelStatus();
      if (bc) return bc;
    } catch (_) {}

    // 3. Local server endpoint probe
    try {
      const res = await fetch('/__xra_recording/active-status', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          const filename = data.filename || (data.path ? data.path.replace(/^.*[\\/]/, '') : '');
          return {
            active: !!data.active,
            elapsed_ms: Number(data.elapsed_ms || 0),
            path: data.path || '',
            filename,
            base_name: data.base_name || '',
            output_dir: data.output_dir || ''
          };
        }
      }
    } catch (_) {}

    return { active: false, elapsed_ms: 0, path: '', filename: '', base_name: '', output_dir: '' };
  }

  function setSyncButtonState(state) {
    const isSyncing = state === 'syncing';
    if (ui.syncBtn) {
      ui.syncBtn.disabled = isSyncing || !connection?.open;
      ui.syncBtn.classList.toggle('syncing', isSyncing);
      const label = ui.syncBtn.querySelector('span:last-child');
      if (label) label.textContent = isSyncing ? 'Sincronizzo…' : 'Sincronizza';
    }
    if (ui.chatSyncBtn) {
      ui.chatSyncBtn.disabled = isSyncing || !connection?.open;
      ui.chatSyncBtn.classList.toggle('syncing', isSyncing);
      ui.chatSyncBtn.textContent = isSyncing ? '…' : '⏱️ Sync';
    }
  }

  async function triggerSyncMarker() {
    if (!connection?.open) {
      appendMessage('system', '⚠️ Impossibile sincronizzare: nessun peer collegato.');
      return;
    }

    setSyncButtonState('syncing');

    // 1. Check local status
    const localStatus = await getLocalRecorderStatus();
    if (!localStatus.active) {
      setSyncButtonState('ready');
      appendMessage('system', '⚠️ Sincronizzazione fallita: la tua registrazione NON è attiva! Avvia prima la registrazione in XR Animator.');
      return;
    }

    // 2. Prepare query
    const queryId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const queryPromise = new Promise((resolve, reject) => {
      pendingSyncQueries.set(queryId, { resolve, reject, localStatus });
      setTimeout(() => {
        if (pendingSyncQueries.has(queryId)) {
          pendingSyncQueries.delete(queryId);
          reject(new Error('timeout'));
        }
      }, 4000);
    });

    connection.send({
      type: 'xra-sync-query',
      queryId,
      senderTime: localStatus.elapsed_ms,
      senderPath: localStatus.path,
      senderPeer: peer?.id || ''
    });

    try {
      const response = await queryPromise;
      // Both were recording! Write file ONLY on this machine (because I pressed the button).
      await saveSyncMarkerFile(localStatus, response.receiverTime, response.receiverPath);
    } catch (err) {
      if (err.message === 'remote_not_recording') {
        appendMessage('system', '⚠️ Sincronizzazione fallita: l\'altro utente NON sta registrando! Nessun marker salvato.');
      } else if (err.message === 'timeout') {
        appendMessage('system', '⚠️ Sincronizzazione fallita: il peer non ha risposto in tempo.');
      } else {
        appendMessage('system', `⚠️ Sincronizzazione fallita: ${err.message}`);
      }
    } finally {
      setSyncButtonState('ready');
    }
  }

  async function handleSyncProtocolMessage(payload) {
    if (!payload?.type) return;

    if (payload.type === 'xra-sync-query') {
      const { queryId, senderTime } = payload;
      const localStatus = await getLocalRecorderStatus();

      if (!localStatus.active) {
        connection.send({
          type: 'xra-sync-reject',
          queryId,
          reason: 'remote_not_recording',
          peerId: peer?.id || ''
        });
        appendMessage('system', '⚠️ L\'altro utente ha premuto Sincronizza, ma la tua registrazione è SPENTA! Avvia la registrazione in XR Animator.');
        return;
      }

      connection.send({
        type: 'xra-sync-confirm',
        queryId,
        receiverTime: localStatus.elapsed_ms,
        receiverPath: localStatus.path,
        receiverPeer: peer?.id || ''
      });

      const myTimeHuman = formatPreciseTime(localStatus.elapsed_ms);
      const otherTimeHuman = formatPreciseTime(senderTime);
      const mySec = (localStatus.elapsed_ms / 1000).toFixed(3);
      const otherSec = (Number(senderTime || 0) / 1000).toFixed(3);
      appendMessage('system', `📍 Sincronizzazione eseguita dal peer:\n• Tu: ${myTimeHuman} (${mySec}s)\n• Altro: ${otherTimeHuman} (${otherSec}s)\n(Il file è stato salvato sul PC del peer)`);
      return;
    }

    if (payload.type === 'xra-sync-confirm') {
      const query = pendingSyncQueries.get(payload.queryId);
      if (query) {
        pendingSyncQueries.delete(payload.queryId);
        query.resolve(payload);
      }
      return;
    }

    if (payload.type === 'xra-sync-reject') {
      const query = pendingSyncQueries.get(payload.queryId);
      if (query) {
        pendingSyncQueries.delete(payload.queryId);
        query.reject(new Error(payload.reason || 'remote_not_recording'));
      }
      return;
    }
  }

  async function saveSyncMarkerFile(localStatus, remoteTimeMs, remotePath) {
    if (localStatus.path !== lastSyncRecordingPath) {
      lastSyncRecordingPath = localStatus.path;
      syncMarkerCount = 0;
    }
    syncMarkerCount++;
    const markNum = syncMarkerCount;

    const myMs = Number(localStatus.elapsed_ms || 0);
    const otherMs = Number(remoteTimeMs || 0);
    const mySec = (myMs / 1000).toFixed(3);
    const otherSec = (otherMs / 1000).toFixed(3);
    const deltaMs = myMs - otherMs;
    const deltaSec = (Math.abs(deltaMs) / 1000).toFixed(3);
    const offsetStr = deltaMs >= 0
      ? `You is +${deltaSec}s ahead of Other`
      : `You is -${deltaSec}s behind Other`;

    const myTimeHuman = formatPreciseTime(myMs);
    const otherTimeHuman = formatPreciseTime(otherMs);
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);

    let content = '';
    if (markNum === 1) {
      content += `SYNC MARKERS\n`;
      content += `Data: ${dateStr}\n`;
      content += `File: ${localStatus.filename || localStatus.path || 'recording'}\n`;
      content += `--------------------------------------------------\n`;
    }

    content += `Mark #${markNum} - ${dateStr}\n`;
    content += `You:    ${myTimeHuman} (${mySec}s)\n`;
    content += `Other:  ${otherTimeHuman} (${otherSec}s)\n`;
    content += `Offset: ${offsetStr}\n`;
    content += `--------------------------------------------------\n\n`;

    const baseName = localStatus.base_name || (localStatus.filename ? localStatus.filename.replace(/\.[^.]+$/, '') : '');

    try {
      const res = await fetch('/__xra_recording/sync-marker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          recording_path: localStatus.path,
          output_dir: localStatus.output_dir,
          base_name: baseName
        })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (${res.statusText || 'Server non raggiungibile'})`);
      }

      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || 'Errore salvataggio server');
      }

      const chatMsg = `📍 MARK #${markNum} SALVATO!\n` +
        `• Tu (You):     ${myTimeHuman} (${mySec}s)\n` +
        `• Altro (Other): ${otherTimeHuman} (${otherSec}s)\n` +
        `• Offset:        ${offsetStr}\n` +
        `📁 File: ${data.filename}\n` +
        `📂 Percorso: ${data.path}`;
      appendMessage('system', chatMsg);
    } catch (err) {
      console.error('[Studio Link] Save sync marker error:', err);
      const chatMsg = `❌ ERRORE SALVATAGGIO MARK #${markNum}!\n` +
        `• Dettagli: ${err.message}\n` +
        `• Tu (You):     ${myTimeHuman} (${mySec}s)\n` +
        `• Altro (Other): ${otherTimeHuman} (${otherSec}s)\n` +
        `• Offset:        ${offsetStr}\n` +
        `(I timestamp restano annotati qui nella chat)`;
      appendMessage('system', chatMsg);
    }
  }

  function bindConnection(nextConnection) {
    if (!nextConnection) return;
    if (connection && connection !== nextConnection) {
      try { connection.close(); } catch (_) {}
    }
    connection = nextConnection;
    const peerId = nextConnection.peer;
    setNetworkState('connecting', `Collegamento a ${peerId}…`);
    setHint('Connessione in corso…');
    ui.connect.disabled = true;

    nextConnection.on('open', () => {
      if (connection !== nextConnection) return;
      showSession(peerId);
      setChatReady(true);
      setNetworkState('online', `Connesso a ${peerId}`);
      setHint('Connessione stabilita.');
      appendMessage('system', `Canale diretto aperto con ${peerId}`);
      ui.chatInput.focus();

      if (!mediaCall && peer?.id && peer.id.localeCompare(peerId) > 0) {
        startMedia('audio');
      }
      setTimeout(() => {
        if (connection === nextConnection && !mediaCall) {
          startMedia('audio');
        }
      }, 2500);
    });

    nextConnection.on('data', payload => {
      if (connection !== nextConnection) return;
      if (payload && typeof payload === 'object' && typeof payload.type === 'string' && payload.type.startsWith('xra-sync-')) {
        handleSyncProtocolMessage(payload);
        return;
      }
      if (payload && typeof payload === 'object' && payload.type === 'xra-screen-stop') {
        resetVideoStage(false);
        updateShareButtonsUi();
        appendMessage('system', 'L’altro partecipante ha interrotto la condivisione dello schermo (la voce prosegue).');
        return;
      }
      const text = typeof payload === 'string' ? payload : payload?.text;
      if (typeof text !== 'string') return;
      const sentAt = Number(payload?.sentAt || 0);
      appendMessage('theirs', text, sentAt ? new Date(sentAt) : new Date());
    });

    nextConnection.on('close', () => {
      if (connection !== nextConnection) return;
      connection = null;
      setChatReady(false);
      appendMessage('system', 'Il canale chat è stato chiuso');
      setNetworkState(peer?.open ? 'online' : '', peer?.open ? 'Pronto a collegarsi' : 'Rete non disponibile');
      if (!mediaCall) showSetup();
    });

    nextConnection.on('error', error => {
      console.error('[Studio Link] data connection', error);
      setNetworkState('error', 'Errore nella chat');
      appendMessage('system', 'Errore del canale chat. Riprova la connessione.');
    });
  }

  function connectToPeer(peerId) {
    const target = String(peerId || '').trim();
    if (!peer?.open || !target || target === peer.id) {
      setHint(target === peer?.id ? 'Non puoi collegarti al tuo stesso ID.' : 'Inserisci un ID valido.', true);
      return;
    }
    bindConnection(peer.connect(target, { reliable: true, serialization: 'json' }));
  }

  function stopTracks(stream) {
    stream?.getTracks?.().forEach(track => {
      try { track.stop(); } catch (_) {}
    });
  }

  function resetVideoStage(clearAudio = false) {
    if (clearAudio) {
      remoteStream = null;
      ui.remoteAudio.srcObject = null;
    }
    ui.mainVideo.srcObject = null;
    ui.mainVideo.style.display = 'none';
    ui.noVideo.hidden = false;
    ui.shareLabel.hidden = true;
    isLocalSharePreview = false;
  }

  function showVideo(stream, localPreview = false) {
    const videoTracks = stream?.getVideoTracks?.() || [];
    if (!videoTracks.length) {
      if (!isLocalSharePreview) resetVideoStage();
      return;
    }
    ui.mainVideo.srcObject = new MediaStream(videoTracks);
    ui.mainVideo.style.display = 'block';
    ui.noVideo.hidden = true;
    ui.shareLabel.hidden = !localPreview;
    isLocalSharePreview = localPreview;
    ui.mainVideo.play().catch(() => {});
  }

  function playRemote(stream) {
    remoteStream = stream;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      ui.remoteAudio.srcObject = new MediaStream(audioTracks);
      ui.remoteAudio.play().catch(() => {});
    }
    if (stream.getVideoTracks().length) showVideo(stream, false);
    else if (!displayStream) resetVideoStage();
  }

  function updateMuteButtonUi() {
    if (!ui.muteBtn) return;
    ui.muteBtn.disabled = !connection?.open && !mediaCall;
    ui.muteBtn.classList.toggle('is-muted', isMuted);
    const icon = ui.muteBtn.querySelector('.mute-icon');
    const text = ui.muteBtn.querySelector('.mute-text');
    if (icon) icon.textContent = isMuted ? '🔇' : '🎤';
    if (text) text.textContent = isMuted ? 'Smuta' : 'Muta';
  }

  function toggleMute() {
    isMuted = !isMuted;
    if (localAudio) {
      localAudio.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
    updateMuteButtonUi();
    appendMessage('system', isMuted ? '🔇 Microfono disattivato (Muto)' : '🎤 Microfono riattivato');
  }

  function bindMediaCall(call, mode) {
    if (mediaCall && mediaCall !== call) {
      try { mediaCall.close(); } catch (_) {}
    }
    mediaCall = call;
    closingMedia = false;
    showSession(call.peer);

    updateShareButtonsUi();
    ui.muteBtn.disabled = false;
    updateMuteButtonUi();

    call.on('stream', stream => {
      if (mediaCall !== call) return;
      playRemote(stream);
      appendMessage('system', stream.getVideoTracks().length ? 'Condivisione schermo ricevuta' : 'Audio collegato');
    });
    call.on('close', () => {
      if (mediaCall !== call) return;
      mediaCall = null;
      updateShareButtonsUi();
      updateMuteButtonUi();
      if (!displayStream) resetVideoStage(true);
      if (!closingMedia) appendMessage('system', 'Sessione voce/schermo terminata');
      closingMedia = false;
      if (!connection?.open) showSetup();
    });
    call.on('error', error => {
      console.error('[Studio Link] media call', error);
      appendMessage('system', 'Errore nella sessione audio/video');
    });
  }

  async function stopScreenShare(message = 'Condivisione schermo interrotta') {
    if (displayStream) {
      stopTracks(displayStream);
      displayStream = null;
    }
    updateShareButtonsUi();
    resetVideoStage(false);

    if (mediaCall?.peerConnection) {
      const senders = mediaCall.peerConnection.getSenders?.() || [];
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        try { await videoSender.replaceTrack(null); } catch (_) {}
      }
    }

    if (connection?.open) {
      try { connection.send({ type: 'xra-screen-stop' }); } catch (_) {}
    }
    updateMuteButtonUi();
    appendMessage('system', message);
  }

  function audioConstraints() {
    const deviceId = ui.audioInput.value;
    return deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  async function getLocalAudio() {
    const live = localAudio?.getAudioTracks?.().some(track => track.readyState === 'live');
    if (!live) {
      localAudio = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
      await refreshDevices();
    }
    localAudio.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });
    return localAudio;
  }

  async function startMedia(mode) {
    const target = activePeerId();
    if (!target) {
      appendMessage('system', 'Manca l’ID del peer remoto');
      return;
    }
    try {
      if (mediaCall) {
        closingMedia = true;
        mediaCall.close();
        mediaCall = null;
      }
      if (displayStream) {
        stopTracks(displayStream);
        displayStream = null;
      }

      const audio = await getLocalAudio();
      let outgoing = new MediaStream(audio.getAudioTracks());
      if (mode === 'screen') {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        outgoing = new MediaStream([...audio.getAudioTracks(), ...displayStream.getVideoTracks()]);
        showVideo(displayStream, true);
        updateShareButtonsUi();
        const screenTrack = displayStream.getVideoTracks()[0];
        screenTrack.addEventListener('ended', () => {
          if (!displayStream) return;
          stopScreenShare('Condivisione schermo interrotta');
        }, { once: true });
      }
      const call = peer.call(target, outgoing, { metadata: { mode } });
      bindMediaCall(call, mode);
      appendMessage('system', mode === 'screen' ? 'Condivisione schermo avviata' : 'Chiamata voce avviata');
    }
    catch (error) {
      console.error('[Studio Link] start media', error);
      appendMessage('system', error?.name === 'NotAllowedError' ? 'Permesso microfono/schermo non concesso' : `Impossibile avviare ${mode === 'screen' ? 'lo schermo' : 'la voce'}`);
      if (displayStream) {
        stopTracks(displayStream);
        displayStream = null;
      }
      updateShareButtonsUi();
      if (!mediaCall) {
        stopTracks(localAudio);
        localAudio = null;
      }
      if (!displayStream) resetVideoStage(true);
    }
  }

  async function answerCall(call) {
    try {
      const audio = await getLocalAudio();
      audio.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
      call.answer(new MediaStream(audio.getAudioTracks()));
    }
    catch (error) {
      console.warn('[Studio Link] answering without microphone', error);
      call.answer(new MediaStream());
      appendMessage('system', 'Chiamata accettata senza microfono locale');
    }
    bindMediaCall(call, call.metadata?.mode || 'audio');
    appendMessage('system', `Voce collegata con ${call.peer}`);
  }

  function endMedia(message = 'Sessione voce/schermo terminata') {
    closingMedia = true;
    const call = mediaCall;
    mediaCall = null;
    try { call?.close(); } catch (_) {}
    stopTracks(localAudio);
    stopTracks(displayStream);
    localAudio = null;
    displayStream = null;
    updateShareButtonsUi();
    updateMuteButtonUi();
    resetVideoStage(true);
    appendMessage('system', message);
    closingMedia = false;
    if (!connection?.open) showSetup();
  }

  function disconnectEverything() {
    endMedia('Sessione media chiusa');
    const oldConnection = connection;
    connection = null;
    try { oldConnection?.close(); } catch (_) {}
    ui.peerInput.value = '';
    showSetup();
    setNetworkState(peer?.open ? 'online' : '', peer?.open ? 'Pronto a collegarsi' : 'Rete non disponibile');
    setHint('Incolla un ID per aprire una nuova sessione.');
  }

  function sendMessage() {
    const text = ui.chatInput.value.trim();
    if (!text || !connection?.open) return;
    connection.send({ type: 'chat', text, sentAt: Date.now() });
    appendMessage('mine', text);
    ui.chatInput.value = '';
    ui.chatInput.style.height = '';
    ui.chatInput.focus();
  }

  function syncDeviceSelects(kind, value) {
    if (kind === 'audioinput') {
      if (ui.audioInput) ui.audioInput.value = value;
      if (ui.sessionAudioInput) ui.sessionAudioInput.value = value;
    } else if (kind === 'audiooutput') {
      if (ui.audioOutput) ui.audioOutput.value = value;
      if (ui.sessionAudioOutput) ui.sessionAudioOutput.value = value;
    }
  }

  function getDeviceLabel(selectElement, deviceId) {
    if (!selectElement) return 'Predefinito';
    const opt = [...selectElement.options].find(o => o.value === deviceId);
    return opt ? opt.text : 'Predefinito';
  }

  async function switchAudioInput(deviceId) {
    syncDeviceSelects('audioinput', deviceId);
    const label = getDeviceLabel(ui.audioInput, deviceId);

    // If call is active or localAudio exists, replace track live without dropping call
    if (localAudio) {
      stopTracks(localAudio);
      localAudio = null;
      try {
        const newAudio = await getLocalAudio();
        const newTrack = newAudio.getAudioTracks()[0];
        if (newTrack) {
          newTrack.enabled = !isMuted;
          if (mediaCall?.peerConnection) {
            const senders = mediaCall.peerConnection.getSenders?.() || [];
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (audioSender) {
              await audioSender.replaceTrack(newTrack);
            }
          }
        }
        appendMessage('system', `🎤 Microfono aggiornato: ${label}`);
      } catch (err) {
        console.error('switchAudioInput error', err);
        appendMessage('system', `⚠️ Errore cambio microfono: ${err.message || 'dispositivo non disponibile'}`);
      }
    } else {
      appendMessage('system', `🎤 Microfono impostato: ${label}`);
    }
  }

  async function switchAudioOutput(deviceId) {
    syncDeviceSelects('audiooutput', deviceId);
    const label = getDeviceLabel(ui.audioOutput, deviceId);
    if (typeof ui.remoteAudio?.setSinkId === 'function') {
      try {
        await ui.remoteAudio.setSinkId(deviceId || '');
        appendMessage('system', `🔊 Uscita audio aggiornata: ${label}`);
      } catch (err) {
        console.warn('[Studio Link] audio output sink error', err);
        appendMessage('system', `⚠️ Errore impostazione uscita audio: ${err.message}`);
      }
    }
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (select, kind, fallback) => {
        if (!select) return;
        const selected = select.value;
        select.replaceChildren(new Option(fallback, ''));
        devices.filter(device => device.kind === kind).forEach((device, index) => {
          select.add(new Option(device.label || `${kind === 'audioinput' ? 'Microfono' : 'Uscita'} ${index + 1}`, device.deviceId));
        });
        if ([...select.options].some(option => option.value === selected)) select.value = selected;
      };
      fill(ui.audioInput, 'audioinput', 'Predefinito');
      fill(ui.audioOutput, 'audiooutput', 'Predefinita');
      fill(ui.sessionAudioInput, 'audioinput', 'Predefinito');
      fill(ui.sessionAudioOutput, 'audiooutput', 'Predefinita');

      if (ui.sessionAudioInput && ui.audioInput) ui.sessionAudioInput.value = ui.audioInput.value;
      if (ui.sessionAudioOutput && ui.audioOutput) ui.sessionAudioOutput.value = ui.audioOutput.value;
    }
    catch (error) {
      console.warn('[Studio Link] devices', error);
    }
  }

  function initializePeer() {
    if (typeof window.Peer !== 'function') {
      setNetworkState('error', 'PeerJS non disponibile');
      setHint('Impossibile caricare il motore P2P.', true);
      return;
    }
    setNetworkState('connecting', 'Collegamento alla rete…');
    peer = new Peer({ debug: 1 });

    peer.on('open', id => {
      ui.myId.textContent = id;
      ui.copyInvite.disabled = false;
      ui.connect.disabled = !ui.peerInput.value.trim();
      setNetworkState('online', 'Pronto a collegarsi');
      setHint('Condividi il tuo ID oppure incolla quello ricevuto.');

      const requestedPeer = new URLSearchParams(location.search).get('peer');
      if (requestedPeer && requestedPeer !== id && !autoConnectDone) {
        autoConnectDone = true;
        ui.peerInput.value = requestedPeer;
        connectToPeer(requestedPeer);
      }
    });
    peer.on('connection', bindConnection);
    peer.on('call', answerCall);
    peer.on('disconnected', () => {
      setNetworkState('connecting', 'Riconnessione alla rete…');
      try { peer.reconnect(); } catch (_) {}
    });
    peer.on('close', () => setNetworkState('', 'Rete chiusa'));
    peer.on('error', error => {
      console.error('[Studio Link] peer', error);
      const messages = {
        'peer-unavailable': 'Peer non trovato. Controlla l’ID.',
        'network': 'Rete P2P non raggiungibile.',
        'server-error': 'Server di segnalazione non disponibile.',
        'ssl-unavailable': 'Connessione sicura non disponibile.'
      };
      const message = messages[error.type] || `Errore P2P: ${error.type || 'sconosciuto'}`;
      setNetworkState('error', message);
      setHint(message, true);
      ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
    });
  }

  ui.peerInput.addEventListener('input', () => {
    ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
    setHint('Premi Connetti per aprire la sessione.');
  });
  ui.peerInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !ui.connect.disabled) ui.connect.click();
  });
  ui.connect.addEventListener('click', () => connectToPeer(ui.peerInput.value));
  ui.copyId.addEventListener('click', () => copyText(peer?.id, 'ID copiato'));
  ui.copyInvite.addEventListener('click', () => copyText(inviteUrl(), 'Invito copiato'));
  ui.disconnect.addEventListener('click', disconnectEverything);
  ui.topbarFullscreen?.addEventListener('click', toggleFullscreen);
  ui.sessionFullscreen?.addEventListener('click', toggleFullscreen);
  ui.muteBtn?.addEventListener('click', toggleMute);
  ui.share.addEventListener('click', () => startMedia('screen'));
  ui.stopShare?.addEventListener('click', () => stopScreenShare('Condivisione schermo interrotta'));
  ui.syncBtn?.addEventListener('click', triggerSyncMarker);
  ui.chatSyncBtn?.addEventListener('click', triggerSyncMarker);
  ui.send.addEventListener('click', sendMessage);
  ui.chatInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  ui.chatInput.addEventListener('input', () => {
    ui.chatInput.style.height = 'auto';
    ui.chatInput.style.height = `${Math.min(110, ui.chatInput.scrollHeight)}px`;
  });
  ui.refreshDevices.addEventListener('click', refreshDevices);

  ui.sessionDevicesToggle?.addEventListener('click', () => {
    if (!ui.sessionDevicesPanel) return;
    const isHidden = ui.sessionDevicesPanel.hidden;
    ui.sessionDevicesPanel.hidden = !isHidden;
    ui.sessionDevicesToggle.classList.toggle('active', isHidden);
    if (isHidden) refreshDevices();
  });
  ui.sessionDevicesClose?.addEventListener('click', () => {
    if (!ui.sessionDevicesPanel) return;
    ui.sessionDevicesPanel.hidden = true;
    ui.sessionDevicesToggle?.classList.remove('active');
  });
  document.addEventListener('pointerdown', event => {
    if (!ui.sessionDevicesPanel || ui.sessionDevicesPanel.hidden) return;
    if (ui.sessionDevicesPanel.contains(event.target) || ui.sessionDevicesToggle?.contains(event.target)) return;
    ui.sessionDevicesPanel.hidden = true;
    ui.sessionDevicesToggle?.classList.remove('active');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui.sessionDevicesPanel && !ui.sessionDevicesPanel.hidden) {
      ui.sessionDevicesPanel.hidden = true;
      ui.sessionDevicesToggle?.classList.remove('active');
    }
  });
  ui.sessionRefreshDevices?.addEventListener('click', refreshDevices);

  ui.audioInput.addEventListener('change', () => switchAudioInput(ui.audioInput.value));
  ui.sessionAudioInput?.addEventListener('change', () => switchAudioInput(ui.sessionAudioInput.value));
  ui.audioOutput.addEventListener('change', () => switchAudioOutput(ui.audioOutput.value));
  ui.sessionAudioOutput?.addEventListener('change', () => switchAudioOutput(ui.sessionAudioOutput.value));
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  window.addEventListener('beforeunload', () => {
    try { connection?.close(); } catch (_) {}
    try { mediaCall?.close(); } catch (_) {}
    stopTracks(localAudio);
    stopTracks(displayStream);
    try { peer?.destroy(); } catch (_) {}
  });

  document.addEventListener('fullscreenchange', updateFullscreenUi);
  document.addEventListener('webkitfullscreenchange', updateFullscreenUi);
  document.addEventListener('keydown', event => {
    if (event.key === 'F11') {
      event.preventDefault();
      toggleFullscreen();
    }
  });

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
      if (!isNiri) {
        win.maximize();
      }
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
      win.on('enter-fullscreen', updateFullscreenUi);
      win.on('restore', () => {
        updateFullscreenUi();
        if (isNiri) restoreNiri();
      });
      win.on('leave-fullscreen', () => {
        updateFullscreenUi();
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

  refreshDevices();
  initializePeer();
})();
