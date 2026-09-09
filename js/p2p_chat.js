(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    myId: $('my-id'), copyId: $('copy-id-btn'), copyInvite: $('copy-invite-btn'),
    peerInput: $('peer-id-input'), connect: $('connect-btn'), connectHint: $('connect-hint'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    setup: $('setup-view'), session: $('session-view'), sessionPeer: $('session-peer'),
    disconnect: $('disconnect-btn'), call: $('call-btn'), share: $('screenshare-btn'), hangup: $('hangup-btn'),
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
    ui.chatState.textContent = ready ? 'online' : 'solo media';
    ui.chatState.classList.toggle('online', ready);
  }

  function showSession(peerId) {
    connectedPeerId = String(peerId || connectedPeerId || '').trim();
    ui.sessionPeer.textContent = connectedPeerId || 'Peer remoto';
    ui.setup.hidden = true;
    ui.session.hidden = false;
    ui.call.disabled = !connectedPeerId;
    ui.share.disabled = !connectedPeerId;
  }

  function showSetup() {
    connectedPeerId = '';
    ui.setup.hidden = false;
    ui.session.hidden = true;
    setChatReady(false);
    ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
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
    });

    nextConnection.on('data', payload => {
      if (connection !== nextConnection) return;
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

  function bindMediaCall(call, mode) {
    if (mediaCall && mediaCall !== call) {
      try { mediaCall.close(); } catch (_) {}
    }
    mediaCall = call;
    closingMedia = false;
    showSession(call.peer);
    ui.hangup.disabled = false;
    ui.call.disabled = true;
    ui.share.disabled = mode === 'screen';

    call.on('stream', stream => {
      if (mediaCall !== call) return;
      playRemote(stream);
      appendMessage('system', stream.getVideoTracks().length ? 'Condivisione schermo ricevuta' : 'Audio collegato');
    });
    call.on('close', () => {
      if (mediaCall !== call) return;
      mediaCall = null;
      ui.hangup.disabled = true;
      ui.call.disabled = !activePeerId();
      ui.share.disabled = !activePeerId();
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

  function audioConstraints() {
    const deviceId = ui.audioInput.value;
    return deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  async function getLocalAudio() {
    const live = localAudio?.getAudioTracks?.().some(track => track.readyState === 'live');
    if (live) return localAudio;
    localAudio = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
    await refreshDevices();
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
        const screenTrack = displayStream.getVideoTracks()[0];
        screenTrack.addEventListener('ended', () => {
          if (!displayStream) return;
          displayStream = null;
          endMedia('Condivisione schermo interrotta');
        }, { once: true });
      }
      const call = peer.call(target, outgoing, { metadata: { mode } });
      bindMediaCall(call, mode);
      appendMessage('system', mode === 'screen' ? 'Condivisione schermo avviata' : 'Chiamata voce avviata');
    }
    catch (error) {
      console.error('[Studio Link] start media', error);
      appendMessage('system', error?.name === 'NotAllowedError' ? 'Permesso microfono/schermo non concesso' : `Impossibile avviare ${mode === 'screen' ? 'lo schermo' : 'la voce'}`);
      ui.call.disabled = !activePeerId();
      ui.share.disabled = !activePeerId();
      ui.hangup.disabled = true;
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
      call.answer(new MediaStream(audio.getAudioTracks()));
    }
    catch (error) {
      console.warn('[Studio Link] answering without microphone', error);
      call.answer(new MediaStream());
      appendMessage('system', 'Chiamata accettata senza microfono locale');
    }
    bindMediaCall(call, call.metadata?.mode || 'audio');
    appendMessage('system', `Chiamata in arrivo da ${call.peer}`);
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
    ui.hangup.disabled = true;
    ui.call.disabled = !activePeerId();
    ui.share.disabled = !activePeerId();
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

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (select, kind, fallback) => {
        const selected = select.value;
        select.replaceChildren(new Option(fallback, ''));
        devices.filter(device => device.kind === kind).forEach((device, index) => {
          select.add(new Option(device.label || `${kind === 'audioinput' ? 'Microfono' : 'Uscita'} ${index + 1}`, device.deviceId));
        });
        if ([...select.options].some(option => option.value === selected)) select.value = selected;
      };
      fill(ui.audioInput, 'audioinput', 'Predefinito');
      fill(ui.audioOutput, 'audiooutput', 'Predefinita');
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
  ui.call.addEventListener('click', () => startMedia('audio'));
  ui.share.addEventListener('click', () => startMedia('screen'));
  ui.hangup.addEventListener('click', () => endMedia());
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
  ui.audioInput.addEventListener('change', () => {
    stopTracks(localAudio);
    localAudio = null;
    if (mediaCall) endMedia('Microfono cambiato: riavvia la chiamata');
  });
  ui.audioOutput.addEventListener('change', async () => {
    if (typeof ui.remoteAudio.setSinkId !== 'function') return;
    try { await ui.remoteAudio.setSinkId(ui.audioOutput.value); }
    catch (error) { console.warn('[Studio Link] audio output', error); }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  window.addEventListener('beforeunload', () => {
    try { connection?.close(); } catch (_) {}
    try { mediaCall?.close(); } catch (_) {}
    stopTracks(localAudio);
    stopTracks(displayStream);
    try { peer?.destroy(); } catch (_) {}
  });

  refreshDevices();
  initializePeer();
})();
