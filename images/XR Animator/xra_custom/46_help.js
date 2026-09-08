(() => {
  'use strict';

  const XRA = window.XRA;
  const impactLabel = {
    none: 'Nessuno',
    tiny: 'Trascurabile',
    low: 'Basso',
    medium: 'Medio',
    high: 'Alto',
    very_high: 'Molto alto',
    variable: 'Dipende'
  };

  const H = {
    'Language': ['Cambia la lingua della UI XRA. Auto usa la lingua del browser/sistema e la preferenza viene salvata nel profilo.', 'none'],
    'Microphone': ['Sceglie il microfono usato dal lip sync. Cambiare device riavvia solo l\'analisi audio, non il mocap.', 'tiny'],
    'Mic / camera mix': ['Bilancia quanto la bocca segue il microfono rispetto al tracking facciale della webcam.', 'none'],
    'Voice gate': ['Soglia sotto cui il lip sync ignora il segnale audio. Più alto = meno rumore di fondo, ma serve parlare più forte.', 'none'],
    'Show VU meter': ['Mostra il livello del microfono e la soglia del voice gate. Il meter gira solo quando questa sezione è aperta.', 'tiny'],
    'Light lip analysis': ['Usa impostazioni audio più leggere per ridurre il costo dell\'analisi del microfono.', 'low'],
    'Lip FFT': ['Dimensione FFT dell\'analisi audio. Valori più alti distinguono meglio lo spettro ma richiedono più lavoro.', 'low'],
    'Lip analysis': ['Frequenza con cui il microfono viene analizzato per le vocali.', 'low'],
    'Anchor strength': ['Quanto BODY STABLE trattiene torso, bacino e gambe verso la posa catturata.', 'none'],
    'Transition': ['Durata del passaggio morbido tra BODY LIVE e BODY STABLE.', 'none'],
    'Native mocap smoothing': ['Smoothing nativo dei dati mocap. Più smoothing riduce il jitter ma aggiunge un po\' di inerzia.', 'tiny'],
    'Body bend reduction': ['Riduce quanto il busto può piegarsi in base al tracking.', 'tiny'],
    'Preset': ['Applica un preset rapido del body collider.', 'tiny'],
    'Mode': ['Attiva o disattiva il body collider e sceglie quanto corpo protegge.', 'low'],
    'Head reaction': ['Metodo con cui il collider reagisce quando la mano entra nella zona della testa.', 'low'],
    'Head': ['Dimensione del collider della testa.', 'low'],
    'Chest': ['Dimensione del collider del petto.', 'low'],
    'Waist': ['Dimensione del collider della vita.', 'low'],
    'Hip': ['Dimensione del collider dei fianchi.', 'low'],
    'Master preset': ['Imposta in blocco le opzioni performance principali. AUTO effettua il test solo quando lo lanci tu.', 'variable'],
    'Tracking pipeline': ['La modalità di tracking si seleziona da Tracking / mocap mode.', 'high'],
    'Tracking / mocap mode': ['Sceglie una delle modalità combinate utili: Face only, Face + Body Split, Full body MediaPipe Vision o Full body Legacy Holistic. Il cambio è sempre esplicito e può ricaricare i modelli ML.', 'high'],
    'Limit webcam': ['Applica un limite alla risoluzione della webcam usata dal tracking.', 'medium'],
    'Webcam resolution': ['Risoluzione dei frame webcam dati a MediaPipe. Più pixel = più dettaglio ma più costo ML.', 'high'],
    'Webcam FPS': ['Frame rate richiesto alla webcam. Più FPS = tracking più frequente ma più lavoro CPU/GPU.', 'high'],
    'Pose quality': ['Modello Pose Lite/Normal/Best. Lite è più leggero; Best è più costoso.', 'high'],
    'Pose inference': ['Limita quante inferenze Pose vengono eseguite al secondo.', 'high'],
    'Hands inference': ['Limita quante inferenze delle mani vengono eseguite al secondo.', 'high'],
    'Disable heavy post FX': ['Spegne gli effetti grafici pesanti come Bloom, AO e DOF.', 'high'],
    'Bloom': ['Aggiunge bagliore alle zone luminose. Può costare parecchio a risoluzioni alte.', 'medium'],
    'AO': ['Ambient Occlusion: aggiunge ombre di contatto e profondità, ma è tra gli effetti più pesanti.', 'high'],
    'DOF': ['Depth of Field: sfoca in base alla profondità. Richiede post-processing aggiuntivo.', 'medium'],
    'Background file': ['Sceglie il file di sfondo dalla cartella backgrounds.', 'none'],
    'Image path': ['Percorso del file immagine usato come sfondo.', 'none'],
    'Color': ['Colore di sfondo quando usi la modalità colore.', 'none'],
    'Webcam device': ['Sceglie la webcam. Se la webcam è OFF salva solo la preferenza; se è ON effettua lo switch. Non cambia il tipo di mocap.', 'tiny'],
    'Mirror webcam preview': ['Specchia solo la preview webcam. Le coordinate del tracking non vengono invertite.', 'none'],
    'Mocap mode': ['La modalità mocap si seleziona da Tracking / mocap mode.', 'high'],
    'Upper body blend': ['Regola come XR Animator miscela la posa del tracking con la posa base del personaggio.', 'tiny'],
    'Shoulder tracking': ['Auto usa il comportamento nativo di XR Animator; Off rimuove esplicitamente il contributo del tracking delle spalle.', 'tiny'],
    'Leg IK': ['Vincola la catena gamba/piede tramite IK. Per testarlo, alza un piede e piega il ginocchio: ON dovrebbe mantenere più coerenti piede, ginocchio e contatto col terreno.', 'low'],
    'Arm IK': ['Auto lascia decidere XR Animator; On forza l’IK delle braccia. Confronta soprattutto gomiti e polsi mentre allunghi le braccia lateralmente o verso la webcam.', 'low'],
    'Auto grounding': ['Compensa automaticamente l’altezza/root rispetto al pavimento virtuale. Prova accovacciata, ritorno in piedi e una gamba sollevata.', 'tiny'],
    'Hip camera': ['Abilita il riferimento del bacino nel comportamento nativo camera/tracking. È più evidente muovendo il torso lateralmente e avanti/indietro.', 'tiny'],
    'Arm horizontal offset': ['Correzione orizzontale applicata alle braccia tracciate.', 'none'],
    'Arm vertical offset': ['Correzione verticale applicata alle braccia tracciate.', 'none'],
    'Limb entry duration': ['Tempo con cui un arto rientra gradualmente nel tracking.', 'none'],
    'Limb return duration': ['Tempo con cui un arto torna gradualmente alla posa base.', 'none'],
    'Hip depth scale': ['Amplifica o riduce il movimento in profondità del bacino.', 'none'],
    'Hip Y offset': ['Offset verticale del bacino.', 'none'],
    'Hip Z offset': ['Offset in profondità del bacino.', 'none'],
    'Hand recovery': ['Quando una mano viene persa, esegue periodicamente una ricerca MediaPipe sull’intero frame invece di aspettare che PoseNet ritrovi il polso. Aggressive cerca più spesso e costa leggermente di più.', 'medium'],
    'Hand detection sensitivity': ['High usa il detector MediaPipe a soglia più permissiva, utile per mani piccole, laterali o parzialmente visibili. Può aumentare qualche falso positivo.', 'low'],
    'Hand stabilization': ['Stabilizza i landmark delle mani per ridurre il tremolio.', 'low'],
    'Arm stabilization': ['Stabilizza le braccia usando i dati hands/body.', 'low'],
    'Time to stabilize': ['Tempo prima che la stabilizzazione delle braccia venga applicata.', 'none'],
    'Hands worker': ['Sceglie come il tracking mani usa i worker. Parallel può migliorare la reattività ma usa più risorse concorrenti.', 'medium'],
    'Depth adjustment': ['Correzione della profondità stimata delle mani.', 'none'],
    'IRL hand / shoulder scale': ['Corregge il rapporto tra dimensione mano e spalle per la stima 3D.', 'none'],
    'Hand depth scale': ['Amplifica o riduce lo spostamento delle mani in profondità.', 'none'],
    'Constrain tracking region': ['Limita la regione in cui il tracker mani cerca le mani.', 'low'],
    'AI inference device': ['Sceglie GPU o CPU per il modello facciale quando supportato.', 'high'],
    'Eye tracking': ['Abilita il tracking dello sguardo.', 'low'],
    'Blink L/R sync': ['Sincronizza i blink dei due occhi.', 'none'],
    'Blink clarity': ['Aumenta la decisione con cui il blink viene interpretato.', 'tiny'],
    'Auto blink': ['Genera blink automatici quando il tracking non li fornisce bene.', 'none'],
    'Auto look at camera': ['Fa guardare automaticamente il personaggio verso la camera.', 'tiny'],
    'Eye bone rotation': ['Intensità con cui ruotano le ossa degli occhi.', 'none'],
    'Mouth tracking sensitivity': ['Sensibilità del tracking bocca nativo da webcam.', 'none'],
    'Lean tracking': ['Quanto il corpo segue l\'inclinazione rilevata.', 'tiny'],
    'Emotion weight': ['Peso generale delle espressioni/emozioni rilevate dal face tracking.', 'low'],
    'Vowel expression weight': ['Peso delle vocali rilevate dal face tracking nativo.', 'low'],
    'Show mocap wireframe': ['Disegna i landmark/scheletro di debug sopra la preview.', 'low'],
    'Portrait mode': ['Adatta il display della webcam a un layout verticale.', 'none'],
    'Selfie mode': ['Inverte/adegua la camera per un comportamento tipo selfie.', 'none'],
    'Hand camera FOV': ['Campo visivo della Hand Camera.', 'none'],
    'VRM joint stiffness': ['Rigidità aggiuntiva applicata alle articolazioni VRM.', 'tiny'],
    'Audio visualizer': ['Mostra il visualizzatore audio circolare.', 'medium'],
    'Recording preset': ['Preset del recorder pulito. Podcast usa 720p30 con bitrate contenuto; Custom permette di modificare i parametri singolarmente.', 'high'],
    'Resolution': ['Risoluzione del file registrato. È indipendente dalla risoluzione webcam usata dal tracking.', 'high'],
    'Capture FPS': ['Frame rate del file registrato. È indipendente dagli FPS richiesti alla webcam per il mocap.', 'high'],
    'Video bitrate': ['Bitrate target del video. È il parametro che incide di più su dimensione del file e qualità.', 'high'],
    'Audio bitrate': ['Bitrate Opus target dell’audio registrato.', 'low'],
    'Audio profile': ['Podcast/Natural disattiva echo cancellation, noise suppression e auto gain del browser; Voice/Call li abilita.', 'low'],
    'Noise gate': ['Attenua il microfono quando il livello scende sotto soglia. Riduce il rumore tra le frasi, ma non può eliminare il rumore che si sovrappone alla voce.', 'tiny'],
    'Freeze pose when face mesh disappears': ['Usa solo la mesh del viso mostrata nella preview tecnica: quando la mesh non viene più disegnata, l’intera posa scheletrica resta sull’ultimo frame valido. Il lip sync da microfono continua a muovere la bocca. È opzionale e parte OFF.', 'tiny'],
    'Gate threshold': ['Soglia del noise gate in dB. Più vicina a 0 = gate più aggressivo; troppo alta può tagliare parole deboli o finali.', 'none'],
    'Segment files': ['Opzionale: divide registrazioni lunghe in file WebM separati. Di default è OFF.', 'tiny'],
    'VMC sender': ['Invia dati VMC/OSC verso un altro programma.', 'low'],
    'Host': ['Host di destinazione per VMC/OSC.', 'none'],
    'Port': ['Porta UDP di destinazione per VMC/OSC.', 'none'],
    'Delay': ['Ritardo aggiunto all\'output VMC.', 'none'],
    'Legacy bottom toolbar': ['Mostra o nasconde la barra inferiore originale di XR Animator.', 'none'],
    '3D wallpaper': ['Attiva la conversione/visualizzazione 3D dello sfondo quando disponibile.', 'high'],
    '3D scale XY': ['Scala orizzontale/verticale del wallpaper 3D.', 'none'],
    '3D scale Z': ['Scala della profondità del wallpaper 3D.', 'none'],
    'Depth shift': ['Sposta il range di profondità del wallpaper 3D.', 'low'],
    'Depth contrast': ['Aumenta o riduce il contrasto della mappa di profondità.', 'low'],
    'Depth blur': ['Sfoca la profondità per ridurre artefatti.', 'medium'],
    'Depth smoothing': ['Leviga la mappa di profondità.', 'medium'],
    '3D X offset': ['Sposta il wallpaper 3D sull\'asse X.', 'none'],
    '3D Y offset': ['Sposta il wallpaper 3D sull\'asse Y.', 'none'],
    '3D Z offset': ['Sposta il wallpaper 3D sull\'asse Z.', 'none'],
    'Global hotkeys': ['Abilita le hotkey globali native quando supportate.', 'tiny'],
    'Disable native hotkeys': ['Disabilita le hotkey native di XR Animator.', 'none'],
    'Gamepad enabled': ['Abilita la gestione gamepad nativa.', 'tiny'],
    'Pose': ['Sceglie una posa nativa di XR Animator senza aprire il vecchio menu a fumetto.', 'none'],
    'Shoulder adjust': ['Correzione delle spalle applicata alle pose native. Alcuni cambi richiedono il riavvio per essere applicati alle pose già caricate.', 'none'],
    '🖐 HANDS ON': ['Attiva il tracking delle mani. Con HANDS OFF il nostro sistema congela braccia, polsi e dita nella posa corrente.', 'high'],
    '🙈': ['Nasconde l’interfaccia durante registrazione/streaming.', 'none'],
    '🧍 BODY LIVE': ['Passa tra tracking corpo live e BODY STABLE con transizione morbida.', 'none'],
    '🎯 Capture current body pose': ['Cattura la posa corrente come ancora per BODY STABLE.', 'none'],
    '🎯 CALIBRATE (3s)': ['Calibra la posa neutra usando alcuni secondi di tracking stabile.', 'tiny'],
    'Toggle Hand Camera': ['Cicla Hand Camera tra mano sinistra, mano destra e OFF.', 'low'],
    'Hand Camera: OFF': ['Cicla Hand Camera tra mano sinistra, mano destra e OFF.', 'low'],
    '▶ Start webcam': ['Avvia esplicitamente lo streamer webcam usando il device preferito, senza cambiare il mocap mode.', 'medium'],
    '■ Stop webcam': ['Ferma esplicitamente la webcam e i relativi video track. La preferenza del device resta salvata.', 'medium'],
    '↻ Refresh cameras': ['Rilegge l’elenco delle webcam disponibili. Può richiedere il permesso browser per mostrare i nomi.', 'tiny'],
    '↻ Restart webcam': ['Riavvia lo streamer webcam nativo senza cambiare automaticamente il tipo di mocap.', 'medium'],
    '⇄ Mirror pose': ['Specchia a sinistra/destra la posa corrente.', 'none'],
    '↺ Reset pose': ['Prova a riportare l’avatar a una posa neutra/default usando i comandi nativi disponibili, senza assumere che la posa #0 sia quella corretta.', 'none'],
    '↺ Reset pose order': ['Ripristina solo l’ordine predefinito della libreria pose; non resetta la posa dell’avatar.', 'none'],
    '● Record': ['Avvia il recorder clean: la UI resta visibile a te ma non viene inclusa nel file.', 'high'],
    '■ Stop': ['Ferma la registrazione video.', 'none'],
    '📷 Snapshot': ['Salva un fermo immagine della scena corrente.', 'low'],
    'VMD': ['Esporta la motion corrente in formato VMD.', 'medium'],
    'glTF': ['Esporta la motion corrente in glTF/GLB.', 'medium'],
    'BVH': ['Esporta la motion corrente in BVH.', 'medium'],
    'VRMA': ['Esporta la motion corrente in VRMA quando disponibile.', 'medium']
  };

  let host = null;
  let timer = 0;
  let active = null;

  function ensureHost() {
    if (host?.isConnected) return host;
    host = document.createElement('div');
    host.className = 'xra-help-popup';
    host.hidden = true;
    document.body.appendChild(host);
    return host;
  }

  function entry(key) {
    if (!key) return null;
    const e = H[key];
    return e ? { text: e[0], impact: e[1] } : null;
  }

  function render(key, data, x, y) {
    const popup = ensureHost();
    popup.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'xra-help-title';
    title.textContent = key;
    const text = document.createElement('div');
    text.className = 'xra-help-text';
    text.textContent = data.text;
    const perf = document.createElement('div');
    perf.className = 'xra-help-perf';
    const label = document.createElement('span');
    label.textContent = 'Impatto performance';
    const badge = document.createElement('span');
    badge.className = `xra-help-badge impact-${data.impact}`;
    badge.textContent = impactLabel[data.impact] || impactLabel.variable;
    perf.append(label, badge);
    popup.append(title, text, perf);
    popup.hidden = false;

    const pad = 12;
    const rect = popup.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + rect.width + pad > innerWidth) left = Math.max(pad, x - rect.width - 14);
    if (top + rect.height + pad > innerHeight) top = Math.max(pad, y - rect.height - 14);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    active = null;
    if (host) host.hidden = true;
  }

  function attach(node, key, override = null) {
    if (!node || node.dataset.xraHelpBound) return node;
    const data = override || entry(key);
    if (!data) return node;
    node.dataset.xraHelpBound = '1';
    let lastX = 0, lastY = 0;
    node.addEventListener('pointerenter', e => {
      lastX = e.clientX; lastY = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        active = node;
        render(key, data, lastX, lastY);
      }, 320);
    });
    node.addEventListener('pointermove', e => {
      lastX = e.clientX; lastY = e.clientY;
      if (active === node && host && !host.hidden) render(key, data, lastX, lastY);
    });
    node.addEventListener('pointerleave', hide);
    node.addEventListener('blur', hide, true);
    return node;
  }

  XRA.help = { attach, entry, data: H, hide };
})();
