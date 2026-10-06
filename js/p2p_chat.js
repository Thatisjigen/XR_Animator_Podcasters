(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    myId: $('my-id'), copyId: $('copy-id-btn'), copyInvite: $('copy-invite-btn'),
    peerInput: $('peer-id-input'), connect: $('connect-btn'), connectHint: $('connect-hint'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    topbarFullscreen: $('topbar-fullscreen-btn'),
    topbarClose: $('topbar-close-btn'),
    setup: $('setup-view'), session: $('session-view'), sessionPeer: $('session-peer'),
    sessionDevicesToggle: $('session-devices-toggle'), sessionDevicesPanel: $('session-devices-panel'),
    sessionDevicesClose: $('session-devices-close'),
    sessionAudioInput: $('session-audio-input-select'), sessionAudioOutput: $('session-audio-output-select'),
    sessionRefreshDevices: $('session-refresh-devices-btn'),
    disconnect: $('disconnect-btn'), muteBtn: $('mute-btn'),
    share: $('screenshare-btn'), stopShare: $('stop-share-btn'),
    avatarBtn: $('send-avatar-btn'), ecoBtn: $('eco-mode-btn'),
    syncBtn: $('sync-marker-btn'), chatSyncBtn: $('chat-sync-marker-btn'),
    mainVideo: $('main-video'), localCanvas: $('local-preview-canvas'), noVideo: $('no-video-msg'), shareLabel: $('share-label'), remoteAudio: $('remote-audio'),
    chatBox: $('chat-box'), chatEmpty: $('chat-empty'), chatInput: $('chat-input'), send: $('send-btn'), chatState: $('chat-state'),
    chatMinimizeBtn: $('chat-minimize-btn'), chatRestoreBtn: $('chat-restore-btn'), chatUnreadBadge: $('chat-unread-badge'),
    audioInput: $('audio-input-select'), audioOutput: $('audio-output-select'), refreshDevices: $('refresh-devices-btn'),
    enginePeerjsBtn: $('engine-peerjs-btn'), engineNostrBtn: $('engine-nostr-btn'), engineDescription: $('engine-description'),
    peerjsIdentityView: $('peerjs-identity-view'), nostrIdentityView: $('nostr-identity-view'),
    peerjsConnectView: $('peerjs-connect-view'), nostrConnectView: $('nostr-connect-view'),
    identitySubheading: $('identity-subheading'), connectSubheading: $('connect-subheading'),
    copyTokenBox: $('copy-token-box'),
    myTokenDisplay: $('my-token-display'), copyTokenBtn: $('copy-token-btn'), copyNostrInviteBtn: $('copy-nostr-invite-btn'),
    regenTokenBtn: $('regen-token-btn'), nostrRelayInfo: $('nostr-relay-info'),
    nostrTokenInput: $('nostr-token-input'), pasteTokenBtn: $('paste-token-btn'), connectNostrBtn: $('connect-nostr-btn'),
    footerEngineInfo: $('footer-engine-info')
  };

  let currentEngine = localStorage.getItem('xra_p2p_engine') || 'peerjs';
  let nostrAdapter = null;
  let nostrToken = '';
  let peer = null;
  let connection = null;
  let mediaCall = null;
  let localAudio = null;
  let displayStream = null;
  let remoteStream = null;
  let remoteVideoStream = null;
  let isRemoteSharingScreen = false;
  let connectedPeerId = '';
  let isLocalSharePreview = false;
  let closingMedia = false;
  let autoConnectDone = false;
  let isMuted = false;
  let isChatMinimized = false;
  let unreadChatCount = 0;
  let unreadDividerInserted = false;
  // Audio output (sink) selected by the user. Kept separately from the <select> value so we
  // can detect when the device disappears (e.g. PipeWire switching Speaker <-> Headphones profile).
  let desiredOutputId = '';
  let desiredOutputLabel = '';
  let outputSwitchChain = Promise.resolve();
  let deviceChangeTimer = null;
  const AVATAR_POSE_VERSION = 2;
  const AVATAR_FRAME_INTERVAL_MS = 33;
  const AVATAR_MAX_BUFFERED_BYTES = 128 * 1024;
  const AVATAR_STOP_QUERY_TIMEOUT_MS = 2500;
  const AVATAR_START_HEARTBEAT_MS = 2000;
  const AVATAR_LOCAL_POSE_GRACE_MS = 2000;
  const AVATAR_REALTIME_NEGOTIATION_GRACE_MS = 10000;
  const AVATAR_REALTIME_FAILURE_GRACE_MS = 4000;
  const REMOTE_AVATAR_ACTIVITY_TIMEOUT_MS = 6500;
  let isStreamingAvatar = false;
  let avatarStreamTimer = null;
  let avatarStreamId = '';
  let avatarSequence = 0;
  let avatarLastStartSentAt = 0;
  let avatarMissingPoseSince = 0;
  let avatarRealtimeFailureSince = 0;
  let avatarRealtimeNegotiationStartedAt = 0;
  let avatarRealtimeEverReady = false;
  let motionConnection = null;
  let motionChannelNegotiated = false;
  let incomingAvatarStreamId = '';
  let incomingAvatarLastPoseAt = 0;
  let remoteReceiverRecording = false;
  let remoteReceiverRecorderKnown = false;
  let isAvatarStopPending = false;
  let pendingAvatarStopQuery = null;
  let recorderStateTimer = null;
  let recorderStateUnsubscribers = [];
  let lastLocalReceiverRecording = null;

  function animatorWindow() {
    try {
      const opener = window.opener;
      if (!opener || opener.closed || !opener.XRA) return null;
      return opener;
    } catch (_) {
      return null;
    }
  }

  function dataTransportReady() {
    if (currentEngine === 'nostr') {
      return nostrAdapter?.dataChannel?.readyState === 'open';
    }
    return !!connection?.open;
  }

  function updateAvatarButtonUi() {
    if (!ui.avatarBtn) return;
    const hasAnimator = !!animatorWindow();
    const isReceiving = !!incomingAvatarStreamId;
    const recordingLocked = isStreamingAvatar && remoteReceiverRecording;
    const recorderUnknownLocked = isStreamingAvatar && !remoteReceiverRecorderKnown;
    if (ui.disconnect) {
      ui.disconnect.disabled = recordingLocked;
      ui.disconnect.title = recordingLocked
        ? 'Il peer sta registrando: non puoi chiudere la sessione mentre riceve il mocap'
        : 'Disconnetti';
    }
    if (ui.topbarClose) {
      ui.topbarClose.disabled = recordingLocked;
      ui.topbarClose.title = recordingLocked
        ? 'Il peer sta registrando: chiusura bloccata per non interrompere il mocap'
        : 'Chiudi';
    }
    ui.avatarBtn.disabled = !dataTransportReady()
      || !hasAnimator
      || isReceiving
      || recordingLocked
      || recorderUnknownLocked
      || isAvatarStopPending;
    const textNode = ui.avatarBtn.querySelector('.avatar-text');
    const iconNode = ui.avatarBtn.querySelector('.avatar-icon');
    ui.avatarBtn.classList.toggle('is-receiving', isReceiving);
    ui.avatarBtn.classList.toggle('is-recording-locked', recordingLocked || recorderUnknownLocked);
    ui.avatarBtn.setAttribute('aria-pressed', isStreamingAvatar ? 'true' : 'false');

    if (isStreamingAvatar) {
      ui.avatarBtn.classList.add('is-streaming');
      if (isAvatarStopPending) {
        if (textNode) textNode.textContent = 'Verifica REC…';
        if (iconNode) iconNode.textContent = '⏳';
        ui.avatarBtn.title = 'Verifico che il peer non stia registrando';
      } else if (recordingLocked) {
        if (textNode) textNode.textContent = 'REC remoto';
        if (iconNode) iconNode.textContent = '🔒';
        ui.avatarBtn.title = 'Il peer sta registrando: la condivisione mocap non può essere interrotta';
      } else if (recorderUnknownLocked) {
        if (textNode) textNode.textContent = 'Verifica REC…';
        if (iconNode) iconNode.textContent = '🔒';
        ui.avatarBtn.title = 'Stato registrazione del peer non ancora verificato: stop bloccato';
      } else {
        if (textNode) textNode.textContent = 'Ferma avatar';
        if (iconNode) iconNode.textContent = '⏹️';
        ui.avatarBtn.title = 'Interrompi lo streaming mocap del tuo avatar';
      }
    } else if (isReceiving) {
      ui.avatarBtn.classList.remove('is-streaming');
      if (textNode) textNode.textContent = 'Avatar ricevuto';
      if (iconNode) iconNode.textContent = '🔒';
      ui.avatarBtn.title = 'L’altro partecipante sta già condividendo il mocap';
    } else {
      ui.avatarBtn.classList.remove('is-streaming');
      if (textNode) textNode.textContent = 'Invia avatar';
      if (iconNode) iconNode.textContent = '🎭';
      ui.avatarBtn.title = hasAnimator
        ? 'Invia il mocap del tuo avatar in tempo reale'
        : 'Apri Studio Link dal pannello di XR Animator per inviare il mocap';
    }
    updateEcoButtonUi();
  }

  let isEcoMode = Boolean(animatorWindow()?.XRA?.getEcoMode?.());

  function updateEcoButtonUi() {
    if (!ui.ecoBtn) return;
    const hasAnimator = !!animatorWindow();
    ui.ecoBtn.disabled = !hasAnimator;
    const textNode = ui.ecoBtn.querySelector('.eco-text');
    if (isEcoMode) {
      ui.ecoBtn.classList.add('is-active');
      if (textNode) textNode.textContent = 'Scena 3D OFF';
      ui.ecoBtn.title = 'Rendering locale di avatar e scena disattivato (clicca per riattivare)';
    } else {
      ui.ecoBtn.classList.remove('is-active');
      if (textNode) textNode.textContent = 'Risparmio 3D';
      ui.ecoBtn.title = hasAnimator
        ? 'Ferma il rendering locale di avatar e scena; il mocap continua a essere inviato'
        : 'Disponibile quando Studio Link è aperto da XR Animator';
    }
  }

  function setEcoMode(active, { announce = false } = {}) {
    isEcoMode = !!active;
    const animator = animatorWindow();
    if (animator?.XRA?.setEcoMode) {
      isEcoMode = !!animator.XRA.setEcoMode(isEcoMode);
    } else if (animator?.System?._browser) {
      animator.System._browser.skip_rendering = isEcoMode;
      animator.XRA?.events?.emit?.('eco-mode-changed', { active: isEcoMode });
    }
    updateEcoButtonUi();
    if (announce) {
      appendMessage(
        'system',
        isEcoMode
          ? 'Risparmio 3D attivo: avatar e scena locali non vengono renderizzati; il mocap continua.'
          : 'Risparmio 3D disattivato: rendering locale ripristinato.'
      );
    }
  }

  function toggleEcoMode() {
    if (!animatorWindow()) return;
    setEcoMode(!isEcoMode, { announce: true });
  }

  window.XRAStudioLink = {
    setEcoMode(active) {
      setEcoMode(active);
    },
    status() {
      return {
        connected: dataTransportReady(),
        sendingAvatar: isStreamingAvatar,
        receivingAvatar: !!incomingAvatarStreamId,
        remoteReceiverRecording,
        remoteReceiverRecorderKnown,
        stopPending: isAvatarStopPending,
        streamId: avatarStreamId || incomingAvatarStreamId || '',
        realtimeReady: currentEngine === 'nostr'
          ? nostrAdapter?.realtimeChannel?.readyState === 'open'
          : !!motionConnection?.open
      };
    }
  };
  window.addEventListener('focus', () => {
    const active = animatorWindow()?.XRA?.getEcoMode?.();
    if (typeof active === 'boolean') setEcoMode(active);
  });

  function peerBufferedAmount(target) {
    const channel = target?.dataChannel || target?._dc || null;
    return Number(channel?.bufferedAmount || 0);
  }

  function realtimeTransportReady() {
    return currentEngine === 'nostr'
      ? nostrAdapter?.realtimeChannel?.readyState === 'open'
      : !!motionConnection?.open;
  }

  function avatarStopSafetyLocked() {
    return isStreamingAvatar && (!remoteReceiverRecorderKnown || remoteReceiverRecording);
  }

  function sendRealtimePayload(payload) {
    if (currentEngine === 'nostr') {
      // If the lossy channel exists, congestion means "drop this frame".
      // Never put stale motion frames back into the reliable chat queue.
      if (nostrAdapter?.realtimeChannelNegotiated) {
        const sent = !!nostrAdapter.sendRealtime?.(payload);
        if (sent || avatarRealtimeEverReady) return sent;
      }
      if (peerBufferedAmount(nostrAdapter) > AVATAR_MAX_BUFFERED_BYTES) return false;
      return !!nostrAdapter?.send?.(payload);
    }

    if (motionConnection?.open) {
      if (peerBufferedAmount(motionConnection) > AVATAR_MAX_BUFFERED_BYTES) return false;
      try {
        motionConnection.send(payload);
        return true;
      } catch (_) {
        return false;
      }
    }
    if (motionChannelNegotiated && avatarRealtimeEverReady) return false;
    if (connection?.open && peerBufferedAmount(connection) <= AVATAR_MAX_BUFFERED_BYTES) {
      try {
        connection.send(payload);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function makeAvatarStreamId() {
    try {
      return crypto.randomUUID();
    } catch (_) {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
  }

  function announceAvatarStream(streamId = avatarStreamId) {
    if (!streamId) return false;
    const sent = sendDataPayload({
      type: 'xra-avatar-start',
      version: AVATAR_POSE_VERSION,
      streamId,
      sentAt: Date.now()
    });
    if (sent) avatarLastStartSentAt = Date.now();
    return sent;
  }

  function sendAvatarPose(pose) {
    if (!pose || !isStreamingAvatar || !avatarStreamId) return false;
    return sendRealtimePayload({
      type: 'xra-avatar-pose',
      version: AVATAR_POSE_VERSION,
      streamId: avatarStreamId,
      seq: ++avatarSequence,
      rig: pose.rig,
      bones: pose.bones,
      hips: pose.hips,
      expressions: pose.expressions,
      sentAt: Date.now()
    });
  }

  function settleAvatarStopQuery(allowed, reason = '') {
    const pending = pendingAvatarStopQuery;
    if (!pending) return;
    pendingAvatarStopQuery = null;
    clearTimeout(pending.timer);
    isAvatarStopPending = false;
    updateAvatarButtonUi();
    pending.resolve({ allowed: !!allowed, reason });
  }

  function stopAvatarStreaming({ notifyPeer = true, force = false, announce = true } = {}) {
    if (!isStreamingAvatar) return false;
    if (!force && avatarStopSafetyLocked()) {
      appendMessage(
        'system',
        remoteReceiverRecording
          ? '🔒 Il peer sta registrando: la condivisione mocap deve restare attiva.'
          : '🔒 Stato REC del peer non verificabile: lo stop del mocap è bloccato.'
      );
      updateAvatarButtonUi();
      return false;
    }
    if (force && pendingAvatarStopQuery) settleAvatarStopQuery(false, 'cancelled');
    const stoppedStreamId = avatarStreamId;
    isStreamingAvatar = false;
    avatarStreamId = '';
    avatarSequence = 0;
    avatarLastStartSentAt = 0;
    avatarMissingPoseSince = 0;
    avatarRealtimeFailureSince = 0;
    avatarRealtimeNegotiationStartedAt = 0;
    avatarRealtimeEverReady = false;
    remoteReceiverRecording = false;
    remoteReceiverRecorderKnown = false;
    if (avatarStreamTimer) {
      clearInterval(avatarStreamTimer);
      avatarStreamTimer = null;
    }
    if (notifyPeer && stoppedStreamId) {
      sendDataPayload({
        type: 'xra-avatar-stop',
        version: AVATAR_POSE_VERSION,
        streamId: stoppedStreamId,
        sentAt: Date.now()
      });
    }
    updateAvatarButtonUi();
    if (announce) appendMessage('system', 'Trasmissione avatar interrotta.');
    return true;
  }

  function startAvatarStreaming() {
    if (isStreamingAvatar) return;
    if (incomingAvatarStreamId) {
      appendMessage('system', 'L’altro partecipante sta già condividendo il mocap. Solo un avatar può essere inviato alla volta.');
      updateAvatarButtonUi();
      return;
    }
    const animator = animatorWindow();
    const firstPose = animator?.XRA?.stage?.getLocalAvatarPose?.() || null;
    if (!firstPose || Number(firstPose.version) !== AVATAR_POSE_VERSION) {
      appendMessage('system', '⚠️ Mocap avatar non disponibile. Avvia XR Animator e attendi il caricamento del modello.');
      updateAvatarButtonUi();
      return;
    }

    const nextStreamId = makeAvatarStreamId();
    const started = announceAvatarStream(nextStreamId);
    if (!started) {
      appendMessage('system', '⚠️ Canale dati non disponibile: avatar non avviato.');
      updateAvatarButtonUi();
      return;
    }

    avatarStreamId = nextStreamId;
    avatarSequence = 0;
    avatarMissingPoseSince = 0;
    avatarRealtimeFailureSince = 0;
    avatarRealtimeNegotiationStartedAt = Date.now();
    avatarRealtimeEverReady = realtimeTransportReady();
    remoteReceiverRecording = false;
    remoteReceiverRecorderKnown = false;
    isStreamingAvatar = true;
    updateAvatarButtonUi();
    appendMessage('system', 'Trasmissione mocap avatar avviata.');
    sendAvatarPose(firstPose);

    avatarStreamTimer = setInterval(() => {
      if (!isStreamingAvatar) return;
      const now = Date.now();
      if (realtimeTransportReady()) {
        avatarRealtimeEverReady = true;
      } else if (!avatarRealtimeEverReady
        && now - avatarRealtimeNegotiationStartedAt >= AVATAR_REALTIME_NEGOTIATION_GRACE_MS) {
        if (!avatarStopSafetyLocked()) {
          const failedStreamId = avatarStreamId;
          sendDataPayload({
            type: 'xra-avatar-transport-error',
            version: AVATAR_POSE_VERSION,
            streamId: failedStreamId,
            sentAt: now
          });
          stopAvatarStreaming({ notifyPeer: false, force: true, announce: false });
          appendMessage('system', 'Trasmissione mocap interrotta: il canale realtime non è stato aperto. Riprova la condivisione.');
          return;
        }
      }
      if (now - avatarLastStartSentAt >= AVATAR_START_HEARTBEAT_MS) {
        announceAvatarStream();
      }
      const pose = animatorWindow()?.XRA?.stage?.getLocalAvatarPose?.() || null;
      if (pose) {
        avatarMissingPoseSince = 0;
        if (sendAvatarPose(pose)) {
          avatarRealtimeFailureSince = 0;
        } else if (avatarRealtimeEverReady) {
          avatarRealtimeFailureSince ||= now;
          if (now - avatarRealtimeFailureSince >= AVATAR_REALTIME_FAILURE_GRACE_MS) {
            if (avatarStopSafetyLocked()) return;
            const failedStreamId = avatarStreamId;
            sendDataPayload({
              type: 'xra-avatar-transport-error',
              version: AVATAR_POSE_VERSION,
              streamId: failedStreamId,
              sentAt: Date.now()
            });
            stopAvatarStreaming({ notifyPeer: false, force: true, announce: false });
            appendMessage('system', 'Trasmissione mocap interrotta: il canale realtime non risponde. Riprova la condivisione.');
          }
        }
      } else {
        avatarMissingPoseSince ||= Date.now();
        if (Date.now() - avatarMissingPoseSince >= AVATAR_LOCAL_POSE_GRACE_MS) {
          if (avatarStopSafetyLocked()) return;
          stopAvatarStreaming({ notifyPeer: true, force: true, announce: false });
          appendMessage('system', 'Trasmissione mocap interrotta: XR Animator o l’avatar locale non sono più disponibili.');
        }
      }
    }, AVATAR_FRAME_INTERVAL_MS);
  }

  async function requestAvatarStopPermission() {
    if (!isStreamingAvatar || !avatarStreamId) return false;
    if (!remoteReceiverRecorderKnown) {
      appendMessage('system', '🔒 Stato REC del peer non verificabile: la condivisione mocap resta attiva.');
      updateAvatarButtonUi();
      return false;
    }
    if (remoteReceiverRecording) {
      appendMessage('system', '🔒 Il peer sta registrando: la condivisione mocap non può essere interrotta.');
      updateAvatarButtonUi();
      return false;
    }
    if (pendingAvatarStopQuery) return (await pendingAvatarStopQuery.promise).allowed;

    const requestId = 'avatar_stop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const streamId = avatarStreamId;
    let resolveQuery;
    const promise = new Promise(resolve => { resolveQuery = resolve; });
    const timer = setTimeout(() => {
      settleAvatarStopQuery(false, 'timeout');
    }, AVATAR_STOP_QUERY_TIMEOUT_MS);
    pendingAvatarStopQuery = { requestId, streamId, promise, resolve: resolveQuery, timer };
    isAvatarStopPending = true;
    updateAvatarButtonUi();

    const sent = sendDataPayload({
      type: 'xra-avatar-stop-query',
      version: AVATAR_POSE_VERSION,
      requestId,
      streamId,
      sentAt: Date.now()
    });
    if (!sent) settleAvatarStopQuery(false, 'transport-unavailable');

    const result = await promise;
    if (!result.allowed) {
      const message = result.reason === 'recording'
        ? '🔒 Il peer sta registrando: la condivisione mocap resta attiva.'
        : '⚠️ Il peer non ha autorizzato lo stop del mocap; la condivisione resta attiva.';
      appendMessage('system', message);
    }
    return result.allowed;
  }

  async function toggleAvatarStreaming() {
    if (!isStreamingAvatar) {
      startAvatarStreaming();
      return;
    }
    if (await requestAvatarStopPermission()) {
      stopAvatarStreaming({ notifyPeer: false });
    }
  }

  function stopRemoteAvatarSession(reason = 'disconnected') {
    incomingAvatarStreamId = '';
    incomingAvatarLastPoseAt = 0;
    lastLocalReceiverRecording = null;
    try {
      animatorWindow()?.XRA?.secondAvatar?.stopSession?.({ force: true, reason });
    } catch (_) {}
    updateAvatarButtonUi();
  }

  function handleIncomingAvatarMessage(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.type === 'xra-avatar-receiver-state') {
      if (String(payload.streamId || '') !== avatarStreamId || !isStreamingAvatar) return true;
      const wasRecording = remoteReceiverRecording;
      const wasKnown = remoteReceiverRecorderKnown;
      const stopWasPending = !!pendingAvatarStopQuery;
      remoteReceiverRecorderKnown = payload.recorderKnown !== false;
      remoteReceiverRecording = remoteReceiverRecorderKnown && !!payload.recording;
      if ((!remoteReceiverRecorderKnown || remoteReceiverRecording) && pendingAvatarStopQuery) {
        settleAvatarStopQuery(false, remoteReceiverRecording ? 'recording' : 'recorder-status-unavailable');
      }
      updateAvatarButtonUi();
      if (!wasRecording && remoteReceiverRecording && !stopWasPending) {
        appendMessage('system', '🔒 Il peer ha avviato la registrazione: lo stop del mocap è bloccato.');
      } else if (wasRecording && !remoteReceiverRecording) {
        appendMessage('system', 'Il peer ha terminato la registrazione: ora puoi fermare il mocap.');
      } else if (wasKnown && !remoteReceiverRecorderKnown) {
        appendMessage('system', '🔒 Stato REC del peer non verificabile: lo stop del mocap è bloccato.');
      }
      return true;
    }
    if (payload.type === 'xra-avatar-stop-query') {
      const streamId = String(payload.streamId || '');
      const requestId = String(payload.requestId || '');
      const matchesActiveStream = !!streamId && streamId === incomingAvatarStreamId;
      const recorderState = localRecorderStateDirect();
      const recorderKnown = matchesActiveStream && recorderState.known;
      const recording = recorderKnown && recorderState.active;
      const allowed = matchesActiveStream && recorderKnown && !recording;
      // Approve and tear down in the same event turn. A recording-start event
      // cannot interleave between this status check and the remote teardown.
      if (allowed) stopRemoteAvatarSession('peer-stop-approved');
      sendDataPayload({
        type: 'xra-avatar-stop-result',
        version: AVATAR_POSE_VERSION,
        requestId,
        streamId,
        allowed,
        recording,
        recorderKnown,
        reason: !matchesActiveStream
          ? 'stale-stream'
          : (!recorderKnown ? 'recorder-status-unavailable' : (recording ? 'recording' : '')),
        sentAt: Date.now()
      });
      if (recording) sendReceiverRecordingState(true);
      return true;
    }
    if (payload.type === 'xra-avatar-stop-result') {
      const pending = pendingAvatarStopQuery;
      if (!pending
        || String(payload.requestId || '') !== pending.requestId
        || String(payload.streamId || '') !== pending.streamId) return true;
      remoteReceiverRecorderKnown = payload.recorderKnown !== false;
      remoteReceiverRecording = remoteReceiverRecorderKnown && !!payload.recording;
      settleAvatarStopQuery(!!payload.allowed, String(payload.reason || ''));
      return true;
    }
    if (payload.type === 'xra-avatar-reject') {
      if (isStreamingAvatar && String(payload.streamId || '') === avatarStreamId) {
        stopAvatarStreaming({ notifyPeer: false, force: true, announce: false });
        appendMessage('system', 'L’altro partecipante ha già ottenuto il controllo della condivisione mocap.');
      }
      return true;
    }
    if (payload.type === 'xra-avatar-start') {
      if (Number(payload.version) !== AVATAR_POSE_VERSION) {
        appendMessage('system', '⚠️ Versione stream avatar non compatibile.');
        return true;
      }
      const streamId = String(payload.streamId || '');
      if (!streamId) return true;
      if (isStreamingAvatar && avatarStreamId !== streamId) {
        // Simultaneous clicks converge on the lexicographically smaller UUID.
        // Both peers make the same decision without a central coordinator.
        if (streamId.localeCompare(avatarStreamId) < 0) {
          stopAvatarStreaming({ notifyPeer: true, force: true, announce: false });
          appendMessage('system', 'Avvio simultaneo: il controllo mocap è passato all’altro partecipante.');
        } else {
          sendDataPayload({
            type: 'xra-avatar-reject',
            version: AVATAR_POSE_VERSION,
            streamId,
            activeStreamId: avatarStreamId,
            reason: 'sender-already-active',
            sentAt: Date.now()
          });
          return true;
        }
      }
      const isNewStream = incomingAvatarStreamId !== streamId;
      if (isNewStream) {
        incomingAvatarStreamId = streamId;
        incomingAvatarLastPoseAt = performance.now();
        lastLocalReceiverRecording = null;
        appendMessage('system', 'L’altro partecipante sta inviando il proprio avatar.');
      }
      // The start heartbeat can arrive while the animator window is still
      // booting. Keep the stream id, but retry once its 3D manager exists;
      // otherwise every later pose is rejected because the manager is idle.
      const manager = animatorWindow()?.XRA?.secondAvatar;
      const managerStatus = manager?.status;
      if (typeof manager?.startSession === 'function'
        && (isNewStream || managerStatus?.active !== true || managerStatus?.streamId !== streamId)) {
        try {
          const start = manager.startSession(payload);
          start?.catch?.(() => {});
        } catch (_) {}
      }
      sendReceiverRecordingState(true);
      updateAvatarButtonUi();
      return true;
    }
    if (payload.type === 'xra-avatar-transport-error') {
      if (String(payload.streamId || '') !== incomingAvatarStreamId) return true;
      const recorderState = localRecorderStateDirect();
      if (!recorderState.known || recorderState.active) {
        sendReceiverRecordingState(true);
        return true;
      }
      appendMessage('system', 'Stream mocap remoto interrotto: il canale realtime non risponde.');
      stopRemoteAvatarSession('transport-error');
      return true;
    }
    if (payload.type === 'xra-avatar-stream-timeout') {
      if (!isStreamingAvatar || String(payload.streamId || '') !== avatarStreamId) return true;
      if (payload.recorderKnown !== true || payload.recording === true) return true;
      remoteReceiverRecorderKnown = true;
      remoteReceiverRecording = false;
      stopAvatarStreaming({ notifyPeer: false, force: true, announce: false });
      appendMessage('system', 'Trasmissione mocap interrotta: il peer non riceve più i frame realtime. Riprova la condivisione.');
      return true;
    }
    if (payload.type === 'xra-avatar-pose') {
      if (String(payload.streamId || '') !== incomingAvatarStreamId) return true;
      incomingAvatarLastPoseAt = performance.now();
      try { animatorWindow()?.XRA?.secondAvatar?.applyRemotePose?.(payload); } catch (_) {}
      return true;
    }
    if (payload.type === 'xra-avatar-stop') {
      if (String(payload.streamId || '') !== incomingAvatarStreamId) return true;
      const recorderState = localRecorderStateDirect();
      if (!recorderState.known || recorderState.active) {
        appendMessage('system', '🔒 Stop mocap ignorato: la registrazione locale è ancora attiva.');
        sendReceiverRecordingState(true);
        return true;
      }
      appendMessage('system', 'L’altro partecipante ha interrotto la trasmissione avatar.');
      stopRemoteAvatarSession('peer-stopped');
      return true;
    }
    return false;
  }

  function isRemoteSharingActive() {
    return Boolean(isRemoteSharingScreen);
  }

  function isScreenShareActive() {
    const localHasVideo = Boolean(displayStream?.getVideoTracks().some(t => t.readyState === 'live'));
    const remoteHasVideo = isRemoteSharingActive();
    return localHasVideo || remoteHasVideo;
  }

  function updateSessionLayout() {
    if (!ui.session || ui.session.hidden) return;
    const hasScreen = isScreenShareActive();
    ui.session.classList.toggle('has-screen', hasScreen);
    ui.session.classList.toggle('no-screen', !hasScreen);
    ui.session.classList.toggle('chat-minimized', isChatMinimized);

    if (ui.chatRestoreBtn) {
      ui.chatRestoreBtn.hidden = !isChatMinimized;
    }
  }

  function updateUnreadBadge() {
    if (!ui.chatUnreadBadge) return;
    if (isChatMinimized && unreadChatCount > 0) {
      ui.chatUnreadBadge.textContent = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
      ui.chatUnreadBadge.hidden = false;
      document.title = `(${unreadChatCount > 99 ? '99+' : unreadChatCount}) Studio Link · XR Animator`;
    } else {
      ui.chatUnreadBadge.hidden = true;
      ui.chatUnreadBadge.textContent = '';
      document.title = 'Studio Link · XR Animator';
    }
  }

  function setChatMinimized(minimized) {
    isChatMinimized = Boolean(minimized);
    if (!isChatMinimized) {
      unreadChatCount = 0;
    } else {
      document.getElementById('chat-unread-divider')?.remove();
      unreadDividerInserted = false;
    }
    updateUnreadBadge();
    updateSessionLayout();
  }

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

    if ((kind === 'theirs' || kind === 'peer') && isChatMinimized && !unreadDividerInserted) {
      const divider = document.createElement('div');
      divider.className = 'chat-unread-divider';
      divider.id = 'chat-unread-divider';
      divider.innerHTML = '<span>Nuovi messaggi non letti</span>';
      ui.chatBox.appendChild(divider);
      unreadDividerInserted = true;
    }

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

    if ((kind === 'theirs' || kind === 'peer') && isChatMinimized) {
      unreadChatCount++;
      updateUnreadBadge();
    }
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
    const icon = active ? '🗗' : '⛶';
    const title = active ? 'Esci da schermo intero (F11)' : 'Attiva schermo intero (F11)';
    if (ui.topbarFullscreen) {
      ui.topbarFullscreen.textContent = icon;
      ui.topbarFullscreen.title = title;
      ui.topbarFullscreen.setAttribute('aria-label', title);
    }
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
    const isRemoteSharing = isRemoteSharingActive();

    if (ui.stopShare) {
      ui.stopShare.hidden = !isSharingLocally;
      ui.stopShare.disabled = !isSharingLocally;
    }
    if (ui.share) {
      ui.share.hidden = isSharingLocally;
      if (isRemoteSharing) {
        ui.share.disabled = true;
        ui.share.title = 'L’altro partecipante sta già condividendo lo schermo.';
      } else {
        ui.share.disabled = !activePeerId();
        ui.share.title = 'Condividi schermo';
      }
    }
  }

  function isSessionConnected() {
    if (currentEngine === 'nostr') {
      return Boolean(nostrAdapter && !ui.session.hidden);
    }
    return Boolean(connection?.open || mediaCall);
  }

  function showSession(peerId) {
    connectedPeerId = String(peerId || connectedPeerId || '').trim();
    ui.sessionPeer.textContent = connectedPeerId || 'Peer remoto';
    ui.setup.hidden = true;
    ui.session.hidden = false;
    isChatMinimized = false;
    unreadChatCount = 0;
    updateUnreadBadge();
    updateShareButtonsUi();
    updateMuteButtonUi();
    updateAvatarButtonUi();
    startRecorderStateMonitor();
    setSyncButtonState('ready');
    updateSessionLayout();
  }

  function showSetup() {
    stopAvatarStreaming({ notifyPeer: false, force: true });
    stopRemoteAvatarSession('setup');
    stopRecorderStateMonitor();
    remoteReceiverRecording = false;
    remoteReceiverRecorderKnown = false;
    if (pendingAvatarStopQuery) settleAvatarStopQuery(false, 'session-ended');
    connectedPeerId = '';
    isRemoteSharingScreen = false;
    remoteVideoStream = null;
    isChatMinimized = false;
    unreadChatCount = 0;
    updateUnreadBadge();
    ui.setup.hidden = false;
    ui.session.hidden = true;
    ui.session.classList.remove('has-screen', 'no-screen', 'chat-minimized');
    if (ui.chatRestoreBtn) ui.chatRestoreBtn.hidden = true;
    if (ui.sessionDevicesPanel) ui.sessionDevicesPanel.hidden = true;
    ui.sessionDevicesToggle?.classList.remove('active');
    setChatReady(false);
    if (currentEngine === 'peerjs') {
      ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
    } else {
      ui.connectNostrBtn.disabled = !ui.nostrTokenInput.value.trim();
    }
    updateShareButtonsUi();
    updateMuteButtonUi();
    updateAvatarButtonUi();
    setSyncButtonState('ready');
  }

  function activePeerId() {
    if (currentEngine === 'nostr') {
      return connectedPeerId || '';
    }
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
      else if (currentEngine === 'nostr' && nostrAdapter) setNetworkState('online', 'Pronto su Nostr');
    }, 1500);
  }

  function inviteUrl() {
    if (currentEngine === 'nostr') {
      if (!nostrToken) return '';
      const url = new URL('/p2p_chat.html', location.href);
      url.searchParams.set('nostr', nostrToken);
      return url.href;
    }
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
    const isConnected = currentEngine === 'nostr' ? Boolean(connectedPeerId && !ui.session.hidden) : Boolean(connection?.open);
    if (ui.syncBtn) {
      ui.syncBtn.disabled = isSyncing || !isConnected;
      ui.syncBtn.classList.toggle('syncing', isSyncing);
      const label = ui.syncBtn.querySelector('span:last-child');
      if (label) label.textContent = isSyncing ? 'Sincronizzo…' : 'Sincronizza';
    }
    if (ui.chatSyncBtn) {
      ui.chatSyncBtn.disabled = isSyncing || !isConnected;
      ui.chatSyncBtn.classList.toggle('syncing', isSyncing);
      ui.chatSyncBtn.textContent = isSyncing ? '…' : '⏱️ Sync';
    }
  }

  function sendDataPayload(payload) {
    if (currentEngine === 'nostr' && nostrAdapter) {
      return nostrAdapter.send(payload);
    }
    if (connection?.open) {
      try {
        connection.send(payload);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function localRecorderStateDirect() {
    try {
      const status = animatorWindow()?.XRA?.recorder?.status;
      if (typeof status !== 'function') return { known: false, active: false };
      const result = status();
      if (!result || typeof result.active !== 'boolean') {
        return { known: false, active: false };
      }
      return { known: true, active: result.active };
    } catch (_) {
      return { known: false, active: false };
    }
  }

  function sendReceiverRecordingState(force = false) {
    if (!incomingAvatarStreamId) return false;
    const recorderState = localRecorderStateDirect();
    const stateKey = recorderState.known ? (recorderState.active ? 'recording' : 'idle') : 'unknown';
    if (!force && stateKey === lastLocalReceiverRecording) return true;
    const sent = sendDataPayload({
      type: 'xra-avatar-receiver-state',
      version: AVATAR_POSE_VERSION,
      streamId: incomingAvatarStreamId,
      recording: recorderState.active,
      recorderKnown: recorderState.known,
      sentAt: Date.now()
    });
    if (sent) lastLocalReceiverRecording = stateKey;
    return sent;
  }

  function stopRecorderStateMonitor() {
    if (recorderStateTimer) {
      clearInterval(recorderStateTimer);
      recorderStateTimer = null;
    }
    for (const unsubscribe of recorderStateUnsubscribers) {
      try { unsubscribe?.(); } catch (_) {}
    }
    recorderStateUnsubscribers = [];
    lastLocalReceiverRecording = null;
  }

  function startRecorderStateMonitor() {
    stopRecorderStateMonitor();
    const events = animatorWindow()?.XRA?.events;
    if (events?.on) {
      const notify = () => sendReceiverRecordingState(true);
      recorderStateUnsubscribers.push(events.on('recording-start', notify));
      recorderStateUnsubscribers.push(events.on('recording-stop', notify));
    }

    const tick = () => {
      if (!incomingAvatarStreamId) return;
      if (incomingAvatarLastPoseAt
        && performance.now() - incomingAvatarLastPoseAt > REMOTE_AVATAR_ACTIVITY_TIMEOUT_MS) {
        const recorderState = localRecorderStateDirect();
        if (!recorderState.known || recorderState.active) {
          sendReceiverRecordingState(false);
          return;
        }
        const expiredStreamId = incomingAvatarStreamId;
        appendMessage('system', 'Stream mocap remoto scaduto: controllo liberato.');
        stopRemoteAvatarSession('timeout');
        sendDataPayload({
          type: 'xra-avatar-stream-timeout',
          version: AVATAR_POSE_VERSION,
          streamId: expiredStreamId,
          recording: false,
          recorderKnown: true,
          sentAt: Date.now()
        });
        return;
      }
      sendReceiverRecordingState(false);
    };
    tick();
    recorderStateTimer = setInterval(tick, 500);
  }

  async function triggerSyncMarker() {
    const isConnected = currentEngine === 'nostr' ? Boolean(connectedPeerId && !ui.session.hidden) : Boolean(connection?.open);
    if (!isConnected) {
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

    sendDataPayload({
      type: 'xra-sync-query',
      queryId,
      senderTime: localStatus.elapsed_ms,
      senderPath: localStatus.path,
      senderPeer: peer?.id || 'Nostr'
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
        sendDataPayload({
          type: 'xra-sync-reject',
          queryId,
          reason: 'remote_not_recording',
          peerId: peer?.id || 'Nostr'
        });
        appendMessage('system', '⚠️ L\'altro utente ha premuto Sincronizza, ma la tua registrazione è SPENTA! Avvia la registrazione in XR Animator.');
        return;
      }

      sendDataPayload({
        type: 'xra-sync-confirm',
        queryId,
        receiverTime: localStatus.elapsed_ms,
        receiverPath: localStatus.path,
        receiverPeer: peer?.id || 'Nostr'
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

  function bindMotionConnection(nextConnection) {
    if (!nextConnection) return;
    const expectedPeer = connection?.peer || connectedPeerId;
    if (!expectedPeer || nextConnection.peer !== expectedPeer) {
      console.warn('[Studio Link] rejected avatar channel from unexpected peer', nextConnection.peer);
      try { nextConnection.close(); } catch (_) {}
      return;
    }
    if (motionConnection && motionConnection !== nextConnection) {
      try { motionConnection.close(); } catch (_) {}
    }
    motionConnection = nextConnection;
    motionChannelNegotiated = true;

    nextConnection.on('open', () => {
      if (motionConnection !== nextConnection) return;
      updateAvatarButtonUi();
    });
    nextConnection.on('data', payload => {
      if (motionConnection !== nextConnection) return;
      handleIncomingAvatarMessage(payload);
    });
    nextConnection.on('close', () => {
      if (motionConnection !== nextConnection) return;
      motionConnection = null;
      updateAvatarButtonUi();
      if (connection?.open) {
        setTimeout(() => ensureMotionConnection(connection?.peer), 400);
      }
    });
    nextConnection.on('error', error => {
      console.warn('[Studio Link] avatar realtime channel', error);
      setTimeout(() => {
        if (motionConnection !== nextConnection || nextConnection.open) return;
        motionConnection = null;
        try { nextConnection.close(); } catch (_) {}
        updateAvatarButtonUi();
        if (connection?.open) ensureMotionConnection(connection.peer);
      }, 400);
    });
  }

  function ensureMotionConnection(peerId) {
    const target = String(peerId || '').trim();
    if (currentEngine !== 'peerjs' || !peer?.open || !connection?.open || !target) return;
    if (motionConnection?.open || motionConnection?.peer === target) return;
    // Exactly one side creates the unordered channel, avoiding duplicate
    // streams when both Studio Link windows observe the main connection.
    if (String(peer.id).localeCompare(target) >= 0) return;
    bindMotionConnection(peer.connect(target, {
      label: 'xra-avatar-realtime',
      metadata: { kind: 'xra-avatar-realtime' },
      reliable: false,
      serialization: 'json'
    }));
  }

  function bindConnection(nextConnection) {
    if (!nextConnection) return;
    if (connection && connection !== nextConnection) {
      const oldMotionConnection = motionConnection;
      motionConnection = null;
      motionChannelNegotiated = false;
      try { oldMotionConnection?.close(); } catch (_) {}
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
      ensureMotionConnection(peerId);

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
      if (payload && typeof payload === 'object' && payload.type === 'xra-session-end') {
        finishPeerSession('L’altro partecipante si è disconnesso');
        return;
      }
      if (payload && typeof payload === 'object' && typeof payload.type === 'string' && payload.type.startsWith('xra-sync-')) {
        handleSyncProtocolMessage(payload);
        return;
      }
      if (handleIncomingAvatarMessage(payload)) {
        return;
      }
      if (payload && typeof payload === 'object' && payload.type === 'xra-screen-start') {
        isRemoteSharingScreen = true;
        updateShareButtonsUi();
        appendMessage('system', 'L’altro partecipante ha avviato la condivisione dello schermo.');
        return;
      }
      if (payload && typeof payload === 'object' && payload.type === 'xra-screen-stop') {
        isRemoteSharingScreen = false;
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
      finishPeerSession('L’altro partecipante si è disconnesso');
    });

    nextConnection.on('error', error => {
      console.error('[Studio Link] data connection', error);
      setNetworkState('error', 'Errore nella chat');
      appendMessage('system', 'Errore del canale chat. Riprova la connessione.');
    });
  }

  function extractPeerId(input) {
    if (!input) return '';
    const trimmed = String(input).trim();
    try {
      if (trimmed.includes('?')) {
        const url = new URL(trimmed, 'http://localhost');
        const param = url.searchParams.get('peer');
        if (param) return param.trim();
      }
    } catch (_) {}
    return trimmed;
  }

  function connectToPeer(peerId) {
    const target = extractPeerId(peerId);
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

  function clearSessionMedia() {
    const oldMotionConnection = motionConnection;
    motionConnection = null;
    motionChannelNegotiated = false;
    try { oldMotionConnection?.close(); } catch (_) {}
    stopTracks(localAudio);
    stopTracks(displayStream);
    localAudio = null;
    displayStream = null;
    remoteStream = null;
    remoteVideoStream = null;
    isRemoteSharingScreen = false;
    stopAvatarStreaming({ notifyPeer: false, force: true });
    stopRemoteAvatarSession('disconnected');
    stopRecorderStateMonitor();
    remoteReceiverRecording = false;
    remoteReceiverRecorderKnown = false;
    resetVideoStage(true);
    updateShareButtonsUi();
    updateMuteButtonUi();
    updateAvatarButtonUi();
  }

  function finishPeerSession(message, { notifyPeer = false } = {}) {
    const oldConnection = connection;
    const oldCall = mediaCall;

    if (notifyPeer && oldConnection?.open) {
      try { oldConnection.send({ type: 'xra-session-end' }); } catch (_) {}
    }

    connection = null;
    mediaCall = null;
    closingMedia = true;
    try { oldCall?.close(); } catch (_) {}
    try { oldConnection?.close(); } catch (_) {}
    clearSessionMedia();
    closingMedia = false;
    ui.peerInput.value = '';
    showSetup();
    setNetworkState(peer?.open ? 'online' : '', peer?.open ? 'Pronto a collegarsi' : 'Rete non disponibile');
    setHint('Incolla un ID per aprire una nuova sessione.');
    if (message) appendMessage('system', message);
  }

  function finishNostrSession(message, { notifyPeer = false, restart = true } = {}) {
    const oldAdapter = nostrAdapter;
    if (notifyPeer) oldAdapter?.send({ type: 'xra-session-end' });

    // Null this first: callbacks raised while closing the old transport must
    // not tear down the fresh waiting room created just below.
    nostrAdapter = null;
    oldAdapter?.disconnect();
    nostrToken = '';
    if (ui.myTokenDisplay) ui.myTokenDisplay.textContent = 'generazione-token…';
    if (ui.copyTokenBtn) ui.copyTokenBtn.disabled = true;
    if (ui.copyNostrInviteBtn) ui.copyNostrInviteBtn.disabled = true;
    ui.nostrTokenInput.value = '';
    clearSessionMedia();
    showSetup();
    if (message) appendMessage('system', message);

    if (restart && currentEngine === 'nostr') {
      initNostrHost();
    }
  }

  // --- Fractal Breaker Engine for Local Screen Share Preview ---
  // When sharing screen locally, displaying raw 1080p 30fps capture inside the same window
  // generates an infinite geometric recursion (fractal noise) that chokes software video encoders.
  // The Fractal Breaker renders the local preview onto a smoothed, downsampled canvas at a clamped ~12.5 FPS.
  // Reflections drop below 1 pixel within 3 levels, eliminating 60% of encoder frame load and 100% of the freeze.
  const localPreviewSourceVideo = document.createElement('video');
  localPreviewSourceVideo.autoplay = true;
  localPreviewSourceVideo.muted = true;
  localPreviewSourceVideo.playsInline = true;
  let localPreviewTimer = null;
  let localPreviewActive = false;

  function startLocalPreviewCanvas(stream) {
    stopLocalPreviewCanvas();
    localPreviewActive = true;
    localPreviewSourceVideo.srcObject = stream;
    localPreviewSourceVideo.play().catch(() => {});

    if (!ui.localCanvas) return;
    const canvas = ui.localCanvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    canvas.hidden = false;
    canvas.style.display = 'block';

    const render = () => {
      if (!localPreviewActive) return;
      if (localPreviewSourceVideo.readyState >= 2 && localPreviewSourceVideo.videoWidth > 0) {
        const vw = localPreviewSourceVideo.videoWidth;
        const vh = localPreviewSourceVideo.videoHeight;
        // Downsample to max width 640px to bound spatial frequency
        const maxDim = 640;
        let cw = vw;
        let ch = vh;
        if (cw > maxDim) {
          ch = Math.round((vh * maxDim) / cw);
          cw = maxDim;
        }
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(localPreviewSourceVideo, 0, 0, cw, ch);
      }
    };

    localPreviewTimer = setInterval(render, 80); // ~12.5 FPS
    render();
  }

  function stopLocalPreviewCanvas() {
    localPreviewActive = false;
    if (localPreviewTimer) {
      clearInterval(localPreviewTimer);
      localPreviewTimer = null;
    }
    try {
      localPreviewSourceVideo.pause();
      localPreviewSourceVideo.srcObject = null;
    } catch (_) {}
    if (ui.localCanvas) {
      ui.localCanvas.hidden = true;
      ui.localCanvas.style.display = 'none';
      const ctx = ui.localCanvas.getContext('2d');
      if (ctx && ui.localCanvas.width && ui.localCanvas.height) {
        ctx.clearRect(0, 0, ui.localCanvas.width, ui.localCanvas.height);
      }
    }
  }

  function resetVideoStage(clearAudio = false) {
    stopLocalPreviewCanvas();
    if (clearAudio) {
      remoteStream = null;
      ui.remoteAudio.srcObject = null;
    } else if (remoteStream) {
      remoteStream.getVideoTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
        try { remoteStream.removeTrack(track); } catch (_) {}
      });
    }
    remoteVideoStream = null;
    isRemoteSharingScreen = false;
    ui.mainVideo.srcObject = null;
    ui.mainVideo.style.display = 'none';
    ui.noVideo.hidden = false;
    ui.shareLabel.hidden = true;
    isLocalSharePreview = false;
    updateShareButtonsUi();
    updateSessionLayout();
  }

  function showVideo(stream, localPreview = false) {
    const videoTracks = stream?.getVideoTracks?.() || [];
    if (!videoTracks.length) {
      if (!isLocalSharePreview) resetVideoStage();
      return;
    }
    if (!localPreview) {
      stopLocalPreviewCanvas();
      isRemoteSharingScreen = true;
      videoTracks.forEach(track => {
        track.addEventListener('ended', () => {
          if (isRemoteSharingScreen) {
            resetVideoStage(false);
          }
        }, { once: true });
      });
      ui.mainVideo.srcObject = new MediaStream(videoTracks);
      ui.mainVideo.style.display = 'block';
      ui.shareLabel.hidden = true;
      ui.mainVideo.play().catch(() => {});
    } else {
      ui.mainVideo.srcObject = null;
      ui.mainVideo.style.display = 'none';
      ui.shareLabel.hidden = false;
      startLocalPreviewCanvas(stream);
    }
    ui.noVideo.hidden = true;
    isLocalSharePreview = localPreview;
    updateShareButtonsUi();
    updateSessionLayout();
  }

  function playRemote(stream) {
    remoteStream = stream;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      ui.remoteAudio.srcObject = new MediaStream(audioTracks);
      ui.remoteAudio.play().catch(() => {});
      logAudioOutput('remote audio attached (PeerJS)');
    }
    if (stream.getVideoTracks().length) {
      if (displayStream) {
        stopTracks(displayStream);
        displayStream = null;
        updateShareButtonsUi();
        appendMessage('system', 'La condivisione locale dello schermo è stata interrotta per visualizzare lo schermo remoto.');
      }
      showVideo(stream, false);
    } else if (!displayStream) {
      resetVideoStage();
    }
  }

  function updateMuteButtonUi() {
    if (!ui.muteBtn) return;
    const connected = isSessionConnected();
    ui.muteBtn.disabled = !connected;
    ui.muteBtn.classList.toggle('is-muted', isMuted);
    const icon = ui.muteBtn.querySelector('.mute-icon');
    const text = ui.muteBtn.querySelector('.mute-text');
    if (icon) icon.textContent = isMuted ? '🔇' : '🎤';
    if (text) text.textContent = isMuted ? 'Smuta' : 'Muta';
    updateAvatarButtonUi();
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

    if (currentEngine === 'nostr') {
      await nostrAdapter?.stopLocalScreen();
      updateMuteButtonUi();
      appendMessage('system', message);
      return;
    }

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

  function screenShareConstraints() {
    return {
      video: {
        frameRate: { ideal: 30, max: 30 },
        displaySurface: 'window'
      },
      audio: false,
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude'
    };
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
    if (mode === 'screen' && isRemoteSharingActive()) {
      appendMessage('system', 'L’altro partecipante sta già condividendo lo schermo. Solo chi ha avviato la condivisione può gestirla.');
      return;
    }

    if (currentEngine === 'nostr') {
      try {
        if (mode === 'audio') {
          const audio = await getLocalAudio();
          await nostrAdapter?.setLocalAudio(audio);
          ui.muteBtn.disabled = false;
          updateMuteButtonUi();
        } else if (mode === 'screen') {
          displayStream = await navigator.mediaDevices.getDisplayMedia(screenShareConstraints());
          await nostrAdapter?.setLocalScreen(displayStream);
          showVideo(displayStream, true);
          updateShareButtonsUi();
          const screenTrack = displayStream.getVideoTracks()[0];
          screenTrack.addEventListener('ended', () => {
            if (!displayStream) return;
            stopScreenShare('Condivisione schermo interrotta');
          }, { once: true });
          appendMessage('system', 'Condivisione schermo avviata');
        }
      } catch (error) {
        console.error('[Studio Link Nostr media]', error);
        appendMessage('system', error?.name === 'NotAllowedError' ? 'Permesso microfono/schermo non concesso' : `Impossibile avviare ${mode === 'screen' ? 'lo schermo' : 'la voce'}`);
        if (displayStream) {
          stopTracks(displayStream);
          displayStream = null;
        }
        updateShareButtonsUi();
      }
      return;
    }

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
        displayStream = await navigator.mediaDevices.getDisplayMedia(screenShareConstraints());
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
      if (mode === 'screen' && connection?.open) {
        try { connection.send({ type: 'xra-screen-start' }); } catch (_) {}
      }
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
    if (isStreamingAvatar && remoteReceiverRecording) {
      appendMessage('system', '🔒 Il peer sta registrando: disconnessione bloccata per non interrompere il mocap.');
      updateAvatarButtonUi();
      return;
    }
    if (currentEngine === 'nostr') {
      finishNostrSession('Sessione Nostr terminata', { notifyPeer: true });
      return;
    }

    finishPeerSession('Sessione terminata', { notifyPeer: true });
  }

  function sendMessage() {
    const text = ui.chatInput.value.trim();
    if (!text) return;
    document.getElementById('chat-unread-divider')?.remove();
    unreadDividerInserted = false;
    const sent = sendDataPayload({ type: 'chat', text, sentAt: Date.now() });
    if (!sent) return;
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
          if (currentEngine === 'nostr' && nostrAdapter) {
            await nostrAdapter.setLocalAudio(newAudio);
          } else if (mediaCall?.peerConnection) {
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

  function logAudioOutput(event, extra = {}) {
    console.info('[Studio Link][audio-out]', event, {
      desiredOutputId,
      desiredOutputLabel,
      elementSinkId: ui.remoteAudio?.sinkId ?? '(n/a)',
      hasRemoteAudio: Boolean(ui.remoteAudio?.srcObject),
      remoteAudioPaused: ui.remoteAudio?.paused,
      ...extra,
    });
  }

  async function applySinkId(deviceId) {
    const el = ui.remoteAudio;
    try {
      await el.setSinkId(deviceId);
      return;
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
      logAudioOutput('setSinkId AbortError, retrying with detached stream', { deviceId });
    }
    // Chromium may abort while moving a live WebRTC stream to another device (typically while
    // PipeWire is recreating the sink). Detach the stream, set the sink, then reattach it so the
    // output device is opened from scratch.
    const src = el.srcObject;
    el.srcObject = null;
    try {
      await el.setSinkId(deviceId);
    } finally {
      if (src) {
        el.srcObject = src;
        el.play().catch(() => {});
      }
    }
  }

  // Updates the desired output synchronously (so a concurrent devicechange reconciliation sees
  // the latest user choice) and applies it through a serialized chain, so rapid repeated
  // selections never run setSinkId concurrently.
  function switchAudioOutput(deviceId, { reason = 'user' } = {}) {
    desiredOutputId = deviceId || '';
    desiredOutputLabel = desiredOutputId ? getDeviceLabel(ui.audioOutput, desiredOutputId) : '';
    syncDeviceSelects('audiooutput', desiredOutputId);
    const run = () => applyDesiredOutput(reason);
    outputSwitchChain = outputSwitchChain.then(run, run);
    return outputSwitchChain;
  }

  async function applyDesiredOutput(reason) {
    const targetId = desiredOutputId;
    const label = targetId ? (desiredOutputLabel || 'Uscita selezionata') : getDeviceLabel(ui.audioOutput, '');
    if (typeof ui.remoteAudio?.setSinkId !== 'function') {
      logAudioOutput('setSinkId not supported by this browser');
      if (reason === 'user') appendMessage('system', '⚠️ Questo browser non permette di scegliere l’uscita audio: usa le impostazioni audio di sistema.');
      return;
    }
    if (reason !== 'user' && ui.remoteAudio.sinkId === targetId) return;
    try {
      await applySinkId(targetId);
      logAudioOutput('applied', { reason, targetId });
      if (reason === 'user') appendMessage('system', `🔊 Uscita audio aggiornata: ${label}`);
    } catch (err) {
      console.warn('[Studio Link] audio output sink error', err);
      logAudioOutput('failed', { reason, targetId, error: `${err?.name}: ${err?.message}` });
      if (!targetId) {
        appendMessage('system', `⚠️ Errore impostazione uscita audio predefinita: ${err?.message || err}`);
        return;
      }
      // A newer choice was made meanwhile: let that one win.
      if (desiredOutputId !== targetId) return;
      // Fall back to the system default so the remote voice stays audible somewhere,
      // instead of leaving the element bound to a dead/unopenable device.
      desiredOutputId = '';
      desiredOutputLabel = '';
      syncDeviceSelects('audiooutput', '');
      try {
        await applySinkId('');
        logAudioOutput('fallback to default applied');
      } catch (fallbackErr) {
        console.warn('[Studio Link] audio output fallback error', fallbackErr);
      }
      appendMessage('system', `⚠️ Uscita "${label}" non disponibile (${err?.name || 'errore'}): torno all’uscita predefinita di sistema.`);
    }
  }

  // Called after every device enumeration: makes sure the <audio> element is really bound to
  // an existing device. Handles sinks that vanish or are recreated with a new id (e.g. plugging
  // headphones on laptops where Speaker and Headphones live in mutually exclusive profiles).
  function reconcileAudioOutput(outputs) {
    logAudioOutput('devices', {
      outputs: outputs.map(device => `${device.label || '?'} [${device.deviceId.slice(0, 8)}]`),
    });
    if (typeof ui.remoteAudio?.setSinkId !== 'function') return;
    if (!desiredOutputId) {
      // Default requested: make sure the element is not stuck on a stale explicit sink.
      if (ui.remoteAudio.sinkId) void switchAudioOutput('', { reason: 'reconcile' });
      return;
    }
    if (outputs.some(device => device.deviceId === desiredOutputId)) {
      if (ui.remoteAudio.sinkId !== desiredOutputId) void switchAudioOutput(desiredOutputId, { reason: 'reconcile' });
      return;
    }
    const sameLabel = desiredOutputLabel && outputs.find(device => device.label === desiredOutputLabel);
    if (sameLabel) {
      logAudioOutput('device id changed, re-binding by label', { newId: sameLabel.deviceId });
      void switchAudioOutput(sameLabel.deviceId, { reason: 'reconcile' });
      return;
    }
    appendMessage('system', `⚠️ Uscita "${desiredOutputLabel || 'selezionata'}" scollegata o non più disponibile: passo all’uscita predefinita di sistema.`);
    void switchAudioOutput('', { reason: 'reconcile' });
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (select, kind, fallback) => {
        if (!select) return;
        const selected = kind === 'audiooutput' ? desiredOutputId : select.value;
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

      reconcileAudioOutput(devices.filter(device => device.kind === 'audiooutput'));
    }
    catch (error) {
      console.warn('[Studio Link] devices', error);
    }
  }

  function createNostrCallbacks(isCurrent = () => true) {
    return {
      onStatus: (msg) => {
        if (currentEngine !== 'nostr' || !isCurrent()) return;
        setNetworkState('connecting', msg);
        setHint(msg);
      },
      onOpen: (peerLabel) => {
        if (currentEngine !== 'nostr' || !isCurrent()) return;
        showSession(peerLabel);
        setChatReady(true);
        setNetworkState('online', `Connesso via Nostr (${peerLabel})`);
        setHint('Connessione P2P decentralizzata stabilita.');
        appendMessage('system', `Canale P2P diretto aperto (via Nostr) con ${peerLabel}`);
        ui.chatInput.focus();
        void startMedia('audio');
      },
      onData: (payload) => {
        if (currentEngine !== 'nostr' || !isCurrent()) return;
        if (payload && typeof payload === 'object' && payload.type === 'xra-session-end') {
          finishNostrSession('L’altro partecipante si è disconnesso');
          return;
        }
        if (payload && typeof payload === 'object' && typeof payload.type === 'string' && payload.type.startsWith('xra-sync-')) {
          handleSyncProtocolMessage(payload);
          return;
        }
        if (handleIncomingAvatarMessage(payload)) {
          return;
        }
        if (payload && typeof payload === 'object' && payload.type === 'xra-screen-start') {
          isRemoteSharingScreen = true;
          if (remoteVideoStream) showVideo(remoteVideoStream, false);
          appendMessage('system', 'L’altro partecipante ha avviato la condivisione dello schermo.');
          updateShareButtonsUi();
          return;
        }
        if (payload && typeof payload === 'object' && payload.type === 'xra-screen-stop') {
          isRemoteSharingScreen = false;
          resetVideoStage(false);
          updateShareButtonsUi();
          appendMessage('system', 'L’altro partecipante ha interrotto la condivisione dello schermo (la voce prosegue).');
          return;
        }
        const text = typeof payload === 'string' ? payload : payload?.text;
        if (typeof text !== 'string') return;
        const sentAt = Number(payload?.sentAt || 0);
        appendMessage('theirs', text, sentAt ? new Date(sentAt) : new Date());
      },
      onRemoteAudio: (stream) => {
        if (!isCurrent()) return;
        remoteStream = stream;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length) {
          ui.remoteAudio.srcObject = new MediaStream(audioTracks);
          ui.remoteAudio.play().catch(() => {});
          logAudioOutput('remote audio attached (Nostr)');
        }
        appendMessage('system', 'Audio Nostr collegato');
        ui.muteBtn.disabled = false;
        updateMuteButtonUi();
        updateShareButtonsUi();
      },
      onRemoteVideo: (stream) => {
        if (!isCurrent()) return;
        remoteVideoStream = stream;
        if (isRemoteSharingScreen) {
          showVideo(stream, false);
        }
        updateShareButtonsUi();
      },
      onClose: () => {
        if (!isCurrent()) return;
        finishNostrSession('L’altro partecipante si è disconnesso');
      },
      onError: (err) => {
        if (!isCurrent()) return;
        console.error('[Studio Link Nostr]', err);
        setNetworkState('error', 'Errore Nostr');
        setHint(`⚠️ ${err?.message || err}`, true);
        appendMessage('system', `⚠️ Errore Nostr: ${err?.message || err}`);
        if (ui.connectNostrBtn) ui.connectNostrBtn.disabled = !ui.nostrTokenInput.value.trim();
      }
    };
  }

  async function initNostrHost(forceNew = false) {
    if (nostrAdapter && !forceNew) return;
    if (nostrAdapter) {
      const oldAdapter = nostrAdapter;
      nostrAdapter = null;
      oldAdapter.disconnect();
    }
    if (typeof window.NostrSignalingAdapter === 'undefined') {
      setNetworkState('error', 'Modulo Nostr non disponibile');
      setHint('Impossibile caricare il modulo Nostr.', true);
      return;
    }
    setNetworkState('connecting', 'Connessione al relay Nostr…');
    let adapter = null;
    adapter = new window.NostrSignalingAdapter(createNostrCallbacks(() => nostrAdapter === adapter));
    nostrAdapter = adapter;

    try {
      const token = await adapter.initHost();
      if (nostrAdapter !== adapter) {
        adapter.disconnect();
        return;
      }
      nostrToken = token;
      if (ui.myTokenDisplay) ui.myTokenDisplay.textContent = token;
      if (ui.copyTokenBtn) ui.copyTokenBtn.disabled = false;
      if (ui.copyNostrInviteBtn) ui.copyNostrInviteBtn.disabled = false;
      if (ui.nostrRelayInfo) {
        const relayDomain = (adapter.relayUrl || '').replace(/^wss?:\/\//, '');
        const reserveCount = Math.max(0, (window.NOSTR_RELAYS?.length || 1) - 1);
        ui.nostrRelayInfo.textContent = `${relayDomain} · +${reserveCount} riserve · E2E`;
      }
      setNetworkState('online', 'Pronto su Nostr (Token generato)');
      setHint('Condividi il tuo Token o incolla quello ricevuto.');
    } catch (err) {
      if (nostrAdapter !== adapter) return;
      console.error('[Studio Link] initNostrHost error', err);
      setNetworkState('error', 'Errore relay Nostr');
      setHint(`Errore connessione Nostr: ${err.message}`, true);
    }
  }

  async function connectWithNostrToken(tokenStr) {
    const token = String(tokenStr || '').trim();
    if (!token) {
      setHint('Incolla un Token Nostr valido.', true);
      return;
    }
    if (nostrAdapter) {
      const oldAdapter = nostrAdapter;
      nostrAdapter = null;
      oldAdapter.disconnect();
    }
    if (typeof window.NostrSignalingAdapter === 'undefined') {
      setNetworkState('error', 'Modulo Nostr non disponibile');
      return;
    }
    setNetworkState('connecting', 'Connessione al relay Nostr del peer…');
    setHint('Connessione in corso via Nostr…');
    if (ui.connectNostrBtn) ui.connectNostrBtn.disabled = true;

    let adapter = null;
    adapter = new window.NostrSignalingAdapter(createNostrCallbacks(() => nostrAdapter === adapter));
    nostrAdapter = adapter;

    try {
      await adapter.connectWithToken(token);
      if (nostrAdapter !== adapter) adapter.disconnect();
    } catch (err) {
      if (nostrAdapter !== adapter) return;
      console.error('[Studio Link] connectWithNostrToken error', err);
      setNetworkState('error', 'Errore token Nostr');
      setHint(`⚠️ Token non valido o relay irraggiungibile: ${err.message}`, true);
      if (ui.connectNostrBtn) ui.connectNostrBtn.disabled = false;
    }
  }

  function setEngine(engine) {
    if (engine !== 'peerjs' && engine !== 'nostr') engine = 'peerjs';
    currentEngine = engine;
    localStorage.setItem('xra_p2p_engine', engine);

    const isPeerjs = engine === 'peerjs';

    if (ui.enginePeerjsBtn) {
      ui.enginePeerjsBtn.classList.toggle('active', isPeerjs);
      ui.enginePeerjsBtn.setAttribute('aria-selected', isPeerjs ? 'true' : 'false');
    }
    if (ui.engineNostrBtn) {
      ui.engineNostrBtn.classList.toggle('active', !isPeerjs);
      ui.engineNostrBtn.setAttribute('aria-selected', !isPeerjs ? 'true' : 'false');
    }

    if (ui.peerjsIdentityView) ui.peerjsIdentityView.hidden = !isPeerjs;
    if (ui.nostrIdentityView) ui.nostrIdentityView.hidden = isPeerjs;
    if (ui.peerjsConnectView) ui.peerjsConnectView.hidden = !isPeerjs;
    if (ui.nostrConnectView) ui.nostrConnectView.hidden = isPeerjs;

    if (isPeerjs) {
      if (nostrAdapter) {
        const oldAdapter = nostrAdapter;
        nostrAdapter = null;
        try { oldAdapter.disconnect(); } catch (_) {}
      }
      if (ui.engineDescription) ui.engineDescription.textContent = "Connessione standard basata su ID corto. Usa il cloud PeerJS per l'handshake iniziale.";
      if (ui.identitySubheading) ui.identitySubheading.textContent = 'Invia questo ID all’altro partecipante.';
      if (ui.connectSubheading) ui.connectSubheading.textContent = 'Incolla l’ID ricevuto e collegati.';
      if (ui.connectHint) ui.connectHint.textContent = 'L’ID appare appena il collegamento alla rete è pronto.';
      if (ui.footerEngineInfo) ui.footerEngineInfo.textContent = "Il server PeerJS viene usato solo per trovare l'altro peer";

      if (!peer) {
        initializePeer();
      } else {
        setNetworkState(peer.open ? 'online' : 'connecting', peer.open ? 'Pronto a collegarsi' : 'Connessione a PeerJS...');
        setHint(peer.open ? 'Condividi il tuo ID oppure incolla quello ricevuto.' : 'In attesa di connessione a PeerJS...');
      }
      if (ui.connect) ui.connect.disabled = !(peer?.open && ui.peerInput.value.trim());
    } else {
      if (ui.engineDescription) ui.engineDescription.textContent = 'Relay pubblici decentralizzati & crittografia E2E (AES-256-GCM). A prova di censura o spegnimento.';
      if (ui.identitySubheading) ui.identitySubheading.textContent = 'Invia questo Token cifrato all’altro partecipante:';
      if (ui.connectSubheading) ui.connectSubheading.textContent = 'Incolla il Token ricevuto dal peer e collegati:';
      if (ui.connectHint) ui.connectHint.textContent = 'Incolla il token xra1_... per avviare il collegamento decentralizzato.';
      if (ui.footerEngineInfo) ui.footerEngineInfo.textContent = 'Handshake decentralizzato tramite Relay Nostr (E2E AES-256-GCM)';

      if (!nostrAdapter || !nostrToken) {
        initNostrHost();
      } else {
        setNetworkState('online', 'Pronto su Nostr (Token generato)');
        setHint('Condividi il tuo Token o incolla quello ricevuto.');
      }
      if (ui.connectNostrBtn) ui.connectNostrBtn.disabled = !ui.nostrTokenInput.value.trim();
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
      if (connection?.open) ensureMotionConnection(connection.peer);

      const requestedPeer = new URLSearchParams(location.search).get('peer');
      if (requestedPeer && requestedPeer !== id && !autoConnectDone) {
        autoConnectDone = true;
        ui.peerInput.value = requestedPeer;
        connectToPeer(requestedPeer);
      }
    });
    peer.on('connection', nextConnection => {
      const isMotion = nextConnection?.metadata?.kind === 'xra-avatar-realtime'
        || nextConnection?.label === 'xra-avatar-realtime';
      if (isMotion) bindMotionConnection(nextConnection);
      else bindConnection(nextConnection);
    });
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
  ui.copyInvite.addEventListener('click', () => copyText(peer?.id, 'ID copiato'));
  ui.enginePeerjsBtn?.addEventListener('click', () => setEngine('peerjs'));
  ui.engineNostrBtn?.addEventListener('click', () => setEngine('nostr'));

  ui.copyTokenBtn?.addEventListener('click', () => {
    if (nostrToken) copyText(nostrToken, 'Token Nostr copiato');
  });
  ui.copyTokenBox?.addEventListener('click', () => {
    if (nostrToken) copyText(nostrToken, 'Token Nostr copiato');
  });
  ui.copyTokenBox?.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && nostrToken) {
      event.preventDefault();
      copyText(nostrToken, 'Token Nostr copiato');
    }
  });
  ui.copyNostrInviteBtn?.addEventListener('click', () => {
    const inv = inviteUrl();
    if (inv) copyText(inv, 'Link di invito Nostr copiato');
  });
  ui.regenTokenBtn?.addEventListener('click', () => {
    initNostrHost(true);
  });

  ui.nostrTokenInput?.addEventListener('input', () => {
    ui.connectNostrBtn.disabled = !ui.nostrTokenInput.value.trim();
  });
  ui.nostrTokenInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !ui.connectNostrBtn.disabled) {
      event.preventDefault();
      connectWithNostrToken(ui.nostrTokenInput.value);
    }
  });
  ui.connectNostrBtn?.addEventListener('click', () => {
    connectWithNostrToken(ui.nostrTokenInput.value);
  });
  ui.pasteTokenBtn?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ui.nostrTokenInput.value = text.trim();
        ui.connectNostrBtn.disabled = !ui.nostrTokenInput.value.trim();
        ui.nostrTokenInput.focus();
      }
    } catch (_) {
      ui.nostrTokenInput.focus();
    }
  });

  ui.disconnect.addEventListener('click', disconnectEverything);
  ui.topbarFullscreen?.addEventListener('click', toggleFullscreen);
  ui.topbarClose?.addEventListener('click', () => {
    if (isStreamingAvatar && remoteReceiverRecording) {
      appendMessage('system', '🔒 Il peer sta registrando: chiusura bloccata per non interrompere il mocap.');
      updateAvatarButtonUi();
      return;
    }
    if (typeof nw !== 'undefined' && nw?.Window?.get) {
      try {
        nw.Window.get().close();
        return;
      } catch (_) {}
    }
    window.close();
  });
  ui.muteBtn?.addEventListener('click', toggleMute);
  ui.avatarBtn?.addEventListener('click', toggleAvatarStreaming);
  ui.ecoBtn?.addEventListener('click', toggleEcoMode);
  ui.share.addEventListener('click', () => startMedia('screen'));
  ui.noVideo?.addEventListener('click', () => {
    if (!isSharingScreenLocally() && !isRemoteSharingActive()) {
      ui.share?.click();
    }
  });
  ui.noVideo?.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !isSharingScreenLocally() && !isRemoteSharingActive()) {
      event.preventDefault();
      ui.share?.click();
    }
  });
  ui.stopShare?.addEventListener('click', () => stopScreenShare('Condivisione schermo interrotta'));
  ui.syncBtn?.addEventListener('click', triggerSyncMarker);
  ui.chatSyncBtn?.addEventListener('click', triggerSyncMarker);
  ui.chatMinimizeBtn?.addEventListener('click', () => setChatMinimized(true));
  ui.chatRestoreBtn?.addEventListener('click', () => setChatMinimized(false));
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
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    // PipeWire profile switches (e.g. headphones plugged) emit bursts of devicechange events:
    // re-enumerate once they settle.
    clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(() => { void refreshDevices(); }, 400);
  });
  window.addEventListener('beforeunload', event => {
    if (isStreamingAvatar && remoteReceiverRecording) {
      event.preventDefault();
      event.returnValue = '';
      return;
    }
    stopAvatarStreaming({ notifyPeer: true, force: true });
    stopRemoteAvatarSession('window-closed');
    stopRecorderStateMonitor();
    try { motionConnection?.close(); } catch (_) {}
    try { connection?.close(); } catch (_) {}
    try { mediaCall?.close(); } catch (_) {}
    try { nostrAdapter?.disconnect(); } catch (_) {}
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

  const urlParams = new URLSearchParams(location.search);
  const nostrParam = urlParams.get('nostr');
  const peerParam = urlParams.get('peer');

  if (nostrParam) {
    setEngine('nostr');
    ui.nostrTokenInput.value = nostrParam;
    connectWithNostrToken(nostrParam);
  } else if (peerParam) {
    setEngine('peerjs');
    initializePeer();
  } else {
    setEngine(currentEngine);
  }
})();
