(() => {
  'use strict';

  // ============================================================
  // SignalingCrypto: AES-256-GCM + Base64URL
  // ============================================================
  const SignalingCrypto = {
    bytesToBase64Url(bytes) {
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    base64UrlToBytes(str) {
      let base64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) {
        base64 += '=';
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    },

    generateRandomBytes(length = 32) {
      return crypto.getRandomValues(new Uint8Array(length));
    },

    async generateAesKey() {
      const raw = this.generateRandomBytes(32);
      const key = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      return { raw, key };
    },

    async importAesKey(rawBytes) {
      return crypto.subtle.importKey(
        'raw',
        rawBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    },

    async encrypt(aesKey, payload) {
      const iv = this.generateRandomBytes(12);
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        encoded
      );
      return this.bytesToBase64Url(iv) + '.' + this.bytesToBase64Url(new Uint8Array(ciphertext));
    },

    async decrypt(aesKey, cipherStr) {
      const [ivPart, dataPart] = String(cipherStr || '').split('.');
      if (!ivPart || !dataPart) throw new Error('Cifratura non valida: formato non conforme.');
      const iv = this.base64UrlToBytes(ivPart);
      const ciphertext = this.base64UrlToBytes(dataPart);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        ciphertext
      );
      return JSON.parse(new TextDecoder().decode(decrypted));
    },

    encodeToken(desc) {
      const json = JSON.stringify(desc);
      return 'xra1_' + this.bytesToBase64Url(new TextEncoder().encode(json));
    },

    decodeToken(tokenStr) {
      const clean = String(tokenStr || '').trim().replace(/^xra1_/, '').replace(/^xra_/, '');
      const bytes = this.base64UrlToBytes(clean);
      const json = new TextDecoder().decode(bytes);
      const obj = JSON.parse(json);
      if (!obj || !obj.r || !obj.d || !obj.k) {
        throw new Error('Token Nostr non valido o corrotto.');
      }
      return obj;
    }
  };

  // ============================================================
  // Default Configs
  // ============================================================
  const DEFAULT_STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  const NOSTR_RELAYS = [
    'wss://nos.lol',
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://relay.nostr.band'
  ];

  const getNostrTools = () => {
    if (typeof window !== 'undefined' && window.NostrTools) return window.NostrTools;
    if (typeof NostrTools !== 'undefined') return NostrTools;
    if (typeof globalThis !== 'undefined' && globalThis.NostrTools) return globalThis.NostrTools;
    return undefined;
  };

  // ============================================================
  // NostrSignalingAdapter
  // ============================================================
  class NostrSignalingAdapter {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.pc = null;
      this.dataChannel = null;
      this.relay = null;
      this.sub = null;
      this.aesKey = null;
      this.rawKey = null;
      this.roomId = '';
      this.relayUrl = '';
      this.mySk = null;
      this.myPk = '';
      this.remotePk = '';
      this.isHost = false;
      this.earlyCandidates = [];
      this.localAudio = null;
      this.localScreen = null;
      this.token = '';
      this.isClosed = false;
    }

    async initHost(relayChoice) {
      const Nostr = getNostrTools();
      if (!Nostr) {
        throw new Error('Libreria NostrTools non trovata.');
      }
      this.isHost = true;
      this.relayUrl = relayChoice || NOSTR_RELAYS[0];
      this.roomId = 'xra-' + SignalingCrypto.bytesToBase64Url(SignalingCrypto.generateRandomBytes(9));
      
      const { raw, key } = await SignalingCrypto.generateAesKey();
      this.rawKey = raw;
      this.aesKey = key;

      this.mySk = Nostr.generateSecretKey();
      this.myPk = Nostr.getPublicKey(this.mySk);

      const desc = {
        v: 1,
        r: this.relayUrl,
        d: this.roomId,
        k: SignalingCrypto.bytesToBase64Url(this.rawKey),
        hpk: this.myPk
      };
      this.token = SignalingCrypto.encodeToken(desc);

      // Connect to relay and subscribe
      this.callbacks.onStatus?.('Connessione al relay Nostr…');
      this.relay = await Nostr.Relay.connect(this.relayUrl);

      this.sub = this.relay.subscribe([
        { kinds: [20000], '#d': [this.roomId], since: Math.floor(Date.now() / 1000) - 10 }
      ], {
        onevent: event => this._handleRelayEvent(event)
      });

      this.callbacks.onStatus?.('Pronto su relay Nostr (in attesa del peer)');
      return this.token;
    }

    async connectWithToken(tokenStr) {
      const Nostr = getNostrTools();
      if (!Nostr) {
        throw new Error('Libreria NostrTools non trovata.');
      }
      this.isHost = false;
      const desc = SignalingCrypto.decodeToken(tokenStr);
      this.relayUrl = desc.r;
      this.roomId = desc.d;
      this.remotePk = desc.hpk || '';
      this.rawKey = SignalingCrypto.base64UrlToBytes(desc.k);
      this.aesKey = await SignalingCrypto.importAesKey(this.rawKey);

      this.mySk = Nostr.generateSecretKey();
      this.myPk = Nostr.getPublicKey(this.mySk);

      this.callbacks.onStatus?.(`Connessione a ${this.relayUrl}…`);
      this.relay = await Nostr.Relay.connect(this.relayUrl);

      this.sub = this.relay.subscribe([
        { kinds: [20000], '#d': [this.roomId], since: Math.floor(Date.now() / 1000) - 10 }
      ], {
        onevent: event => this._handleRelayEvent(event)
      });

      // Send join announcement to host
      this.callbacks.onStatus?.('Invio richiesta di handshake WebRTC…');
      await this._sendSignalingMessage({
        type: 'join',
        sender: this.myPk,
        target: this.remotePk
      });
    }

    async _sendSignalingMessage(payload) {
      if (!this.relay || !this.relay.connected || !this.aesKey) return;
      const Nostr = getNostrTools();
      if (!Nostr) return;
      try {
        const encrypted = await SignalingCrypto.encrypt(this.aesKey, payload);
        const event = Nostr.finalizeEvent({
          kind: 20000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['d', this.roomId]],
          content: encrypted
        }, this.mySk);
        await this.relay.publish(event);
      } catch (err) {
        console.error('[NostrAdapter] publish error', err);
      }
    }

    async _handleRelayEvent(event) {
      if (!event || event.pubkey === this.myPk) return;
      let msg = null;
      try {
        msg = await SignalingCrypto.decrypt(this.aesKey, event.content);
      } catch (_) {
        return; // Ignore events not decryptable with our room key
      }

      if (!msg || typeof msg !== 'object') return;

      if (msg.target && msg.target !== this.myPk) return; // Directed to another pubkey

      switch (msg.type) {
        case 'join':
          if (this.isHost) {
            this.remotePk = msg.sender || event.pubkey;
            this.callbacks.onStatus?.('Peer rilevato su Nostr. Negoziazione WebRTC…');
            await this._initiatePeerConnection();
          }
          break;

        case 'offer':
          if (!this.isHost) {
            this.remotePk = msg.sender || event.pubkey;
            this.callbacks.onStatus?.('Ricevuta offerta WebRTC. Invio risposta…');
            await this._handleOffer(msg.sdp);
          }
          break;

        case 'answer':
          if (this.isHost && this.pc) {
            this.callbacks.onStatus?.('Ricevuta risposta WebRTC. Stabilizzazione canale…');
            await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
            this._flushEarlyCandidates();
          }
          break;

        case 'candidate':
          if (msg.candidate) {
            if (this.pc && this.pc.remoteDescription) {
              try {
                await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              } catch (_) {}
            } else {
              this.earlyCandidates.push(msg.candidate);
            }
          }
          break;
      }
    }

    _createPeerConnection() {
      const pc = new RTCPeerConnection({ iceServers: DEFAULT_STUN_SERVERS });

      // Pre-add transceivers for audio and video to allow dynamic track replacement without renegotiation
      try {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        pc.addTransceiver('video', { direction: 'sendrecv' });
      } catch (e) {
        console.warn('[NostrSignalingAdapter] addTransceiver fallback', e);
      }

      pc.onicecandidate = event => {
        if (event.candidate) {
          this._sendSignalingMessage({
            type: 'candidate',
            candidate: event.candidate,
            sender: this.myPk,
            target: this.remotePk
          });
        }
      };

      pc.ontrack = event => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        if (event.track.kind === 'audio') {
          this.callbacks.onRemoteAudio?.(stream);
        } else if (event.track.kind === 'video') {
          this.callbacks.onRemoteVideo?.(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          this.callbacks.onStatus?.('Connesso P2P diretto');
          this._closeRelayConnection();
        } else if (state === 'failed' || state === 'closed') {
          this.callbacks.onClose?.();
        }
      };

      // Attach any local tracks already configured
      if (this.localAudio) {
        this.localAudio.getAudioTracks().forEach(t => pc.addTrack(t, this.localAudio));
      }
      if (this.localScreen) {
        this.localScreen.getVideoTracks().forEach(t => pc.addTrack(t, this.localScreen));
      }

      this.pc = pc;
      return pc;
    }

    async _initiatePeerConnection() {
      const pc = this._createPeerConnection();

      // Create data channel
      const dc = pc.createDataChannel('xra-p2p-channel', { ordered: true });
      this._bindDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await this._sendSignalingMessage({
        type: 'offer',
        sdp: offer.sdp,
        sender: this.myPk,
        target: this.remotePk
      });
    }

    async _handleOffer(sdp) {
      const pc = this._createPeerConnection();

      pc.ondatachannel = event => {
        this._bindDataChannel(event.channel);
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      this._flushEarlyCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await this._sendSignalingMessage({
        type: 'answer',
        sdp: answer.sdp,
        sender: this.myPk,
        target: this.remotePk
      });
    }

    _flushEarlyCandidates() {
      if (!this.pc || !this.pc.remoteDescription) return;
      while (this.earlyCandidates.length) {
        const c = this.earlyCandidates.shift();
        try { this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
    }

    _bindDataChannel(dc) {
      this.dataChannel = dc;
      dc.onopen = () => {
        this.callbacks.onOpen?.(this.isHost ? 'Guest (Nostr)' : 'Host (Nostr)');
        this._closeRelayConnection();
      };
      dc.onmessage = event => {
        let data = event.data;
        try {
          data = JSON.parse(event.data);
        } catch (_) {}
        this.callbacks.onData?.(data);
      };
      dc.onclose = () => {
        this.callbacks.onClose?.();
      };
      dc.onerror = err => {
        this.callbacks.onError?.(err);
      };
    }

    _closeRelayConnection() {
      if (this.sub) {
        try { this.sub.close(); } catch (_) {}
        this.sub = null;
      }
      if (this.relay) {
        try { this.relay.close(); } catch (_) {}
        this.relay = null;
      }
    }

    send(payload) {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
      const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
      this.dataChannel.send(str);
      return true;
    }

    setLocalAudio(stream) {
      this.localAudio = stream;
      if (!this.pc) return;
      const audioTrack = stream?.getAudioTracks()?.[0] || null;
      const t = this.pc.getTransceivers?.().find(tr => tr.receiver?.track?.kind === 'audio');
      if (t?.sender) {
        t.sender.replaceTrack(audioTrack);
      } else {
        const senders = this.pc.getSenders().filter(s => s.track && s.track.kind === 'audio');
        if (senders.length > 0) {
          senders[0].replaceTrack(audioTrack);
        } else if (audioTrack) {
          this.pc.addTrack(audioTrack, stream);
        }
      }
    }

    setLocalScreen(stream) {
      this.localScreen = stream;
      if (!this.pc) return;
      const videoTrack = stream?.getVideoTracks()?.[0] || null;
      const t = this.pc.getTransceivers?.().find(tr => tr.receiver?.track?.kind === 'video');
      if (t?.sender) {
        t.sender.replaceTrack(videoTrack);
      } else {
        const senders = this.pc.getSenders().filter(s => s.track && s.track.kind === 'video');
        if (senders.length > 0) {
          senders[0].replaceTrack(videoTrack);
        } else if (videoTrack) {
          this.pc.addTrack(videoTrack, stream);
        }
      }
      this.send({ type: 'xra-screen-start' });
    }

    stopLocalScreen() {
      this.localScreen = null;
      if (this.pc) {
        const t = this.pc.getTransceivers?.().find(tr => tr.receiver?.track?.kind === 'video');
        if (t?.sender) {
          t.sender.replaceTrack(null);
        } else {
          const senders = this.pc.getSenders().filter(s => s.track && s.track.kind === 'video');
          senders.forEach(s => {
            try { s.replaceTrack(null); } catch (_) {}
          });
        }
      }
      this.send({ type: 'xra-screen-stop' });
    }

    disconnect() {
      this.isClosed = true;
      this._closeRelayConnection();
      if (this.dataChannel) {
        try { this.dataChannel.close(); } catch (_) {}
        this.dataChannel = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch (_) {}
        this.pc = null;
      }
    }
  }

  // Export to window
  window.SignalingCrypto = SignalingCrypto;
  window.NostrSignalingAdapter = NostrSignalingAdapter;
  window.NOSTR_RELAYS = NOSTR_RELAYS;
})();
