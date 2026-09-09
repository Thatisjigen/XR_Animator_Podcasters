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
    'Native mocap smoothing': ['Filtro di fluidità per i movimenti tracciati. Rende i movimenti più morbidi riducendo gli scatti.', 'tiny'],
    'Body bend reduction': ['Limita la curvatura eccessiva della colonna vertebrale.', 'tiny'],
    'Preset': ['Applica un profilo rapido per le zone di collisione del corpo.', 'tiny'],
    'Mode': ['Attiva o disattiva le zone protette per evitare che le braccia compenetrino il corpo.', 'low'],
    'Head reaction': ['Comportamento delle mani quando toccano o sfiorano la testa.', 'low'],
    'Head': ['Raggio di protezione per la testa.', 'low'],
    'Chest': ['Raggio di protezione per il busto.', 'low'],
    'Waist': ['Raggio di protezione per la vita.', 'low'],
    'Hip': ['Raggio di protezione per i fianchi.', 'low'],
    'Master preset': ['Configura automaticamente tutte le opzioni grafiche e di tracciamento in base alle prestazioni desiderate.', 'variable'],
    'Tracking pipeline': ['Pipeline di tracciamento.', 'high'],
    'Tracking / mocap mode': ['Sceglie tra tracciamento Completo (Full Body MediaPipe Vision) o Solo Viso (Face only).', 'high'],
    'Limit webcam': ['Limita la risoluzione massima della webcam per alleggerire il carico di calcolo.', 'medium'],
    'Webcam resolution': ['Risoluzione video inviata al modello di intelligenza artificiale per il tracciamento.', 'high'],
    'Webcam FPS': ['Frequenza di acquisizione della webcam. Più FPS = tracciamento più reattivo.', 'high'],
    'Pose quality': ['Precisione del modello neurale per il corpo (Lite: leggero, Normal: bilanciato, Best: massima fedeltà).', 'high'],
    'Pose inference': ['Frequenza massima di analisi del corpo al secondo.', 'high'],
    'Hands inference': ['Frequenza massima di analisi delle mani al secondo.', 'high'],
    'Disable heavy post FX': ['Disattiva effetti grafici pesanti come Bloom, Occlusione Ambientale e Profondità di Campo.', 'high'],
    'Bloom': ['Aggiunge un effetto bagliore attorno alle zone molto luminose.', 'medium'],
    'AO': ['Occlusione Ambientale: calcola ombreggiature realistiche nelle pieghe e nei contatti.', 'high'],
    'DOF': ['Profondità di campo: sfoca lo sfondo per mettere a fuoco l\'avatar.', 'medium'],
    'Background file': ['Immagine o video di sfondo.', 'none'],
    'Image path': ['Percorso del file immagine caricato come sfondo.', 'none'],
    'Color': ['Colore a tinta unita per lo sfondo (ottimo per trasparenza o chroma key).', 'none'],
    'Webcam device': ['Seleziona quale telecamera utilizzare per il tracciamento.', 'tiny'],
    'Mirror webcam preview': ['Specchia l\'anteprima della webcam orizzontalmente come in uno specchio.', 'none'],
    'Mocap mode': ['Modalità di tracciamento.', 'high'],
    'Upper body blend': ['Miscela la posa naturale di riposo con i movimenti tracciati.', 'tiny'],
    'Shoulder tracking': ['Attiva o disattiva il tracciamento del movimento delle spalle.', 'tiny'],
    'Leg IK': ['Cinematica inversa per gambe e piedi (mantiene i piedi stabili a terra evitando slittamenti).', 'low'],
    'Arm IK': ['Cinematica inversa per le braccia (migliora la flessione naturale di gomiti e polsi).', 'low'],
    'Auto grounding': ['Compensa l\'altezza del personaggio per mantenerlo appoggiato al suolo.', 'tiny'],
    'Hip camera': ['Adatta l\'inquadratura ai movimenti del bacino.', 'tiny'],
    'Arm horizontal offset': ['Regola la distanza orizzontale delle braccia dal corpo.', 'none'],
    'Arm vertical offset': ['Regola l\'altezza verticale delle braccia.', 'none'],
    'Limb entry duration': ['Velocità con cui un arto rientra nel tracciamento quando torna visibile.', 'none'],
    'Limb return duration': ['Velocità con cui un arto torna in posa neutra quando esce dal campo visivo.', 'none'],
    'Hip depth scale': ['Sensibilità dello spostamento avanti/indietro del corpo.', 'none'],
    'Hip Y offset': ['Regola l\'altezza complessiva dell\'avatar.', 'none'],
    'Hip Z offset': ['Regola la posizione dell\'avatar in profondità.', 'none'],
    'Hand recovery': ['Recupero intelligente delle mani quando escono parzialmente dall\'inquadratura.', 'medium'],
    'Hand detection sensitivity': ['Sensibilità di rilevamento delle dita e delle mani.', 'low'],
    'Hand stabilization': ['Filtro anti-tremolio per mani e dita.', 'low'],
    'Arm stabilization': ['Filtro anti-tremolio per le braccia.', 'low'],
    'Time to stabilize': ['Tempo di risposta del filtro di stabilizzazione braccia.', 'none'],
    'Hands worker': ['Elaborazione delle mani in parallelo (migliora la fluidità su computer multi-core).', 'medium'],
    'Depth adjustment': ['Correzione della profondità stimata per le mani.', 'none'],
    'IRL hand / shoulder scale': ['Proporzione tra mani e spalle per calcolare la distanza 3D.', 'none'],
    'Hand depth scale': ['Sensibilità dei movimenti delle mani verso la telecamera.', 'none'],
    'Constrain tracking region': ['Concentra il rilevamento delle mani nell\'area attorno al corpo.', 'low'],
    'AI inference device': ['Dispositivo di calcolo per l\'intelligenza artificiale (GPU accelerata o CPU).', 'high'],
    'Eye tracking': ['Traccia la direzione dello sguardo degli occhi.', 'low'],
    'Blink L/R sync': ['Sincronizza la chiusura degli occhi per evitare ammiccamenti asimmetrici involontari.', 'none'],
    'Blink clarity': ['Rende più netta la chiusura e l\'apertura delle palpebre.', 'tiny'],
    'Auto blink': ['Ammiccamento naturale automatico quando il tracciamento non rileva battiti di ciglia.', 'none'],
    'Auto look at camera': ['Mantiene lo sguardo dell\'avatar orientato verso la telecamera.', 'tiny'],
    'Eye bone rotation': ['Ampiezza di rotazione delle pupille.', 'none'],
    'Mouth tracking sensitivity': ['Sensibilità con cui la webcam rileva i movimenti della bocca.', 'none'],
    'Lean tracking': ['Traccia l\'inclinazione del busto a destra e a sinistra.', 'tiny'],
    'Emotion weight': ['Intensità delle espressioni facciali (sorrisi, sopracciglia, stupore).', 'low'],
    'Vowel expression weight': ['Intensità con cui le vocali aprono e modellano la bocca.', 'low'],
    'Show mocap wireframe': ['Mostra lo scheletro e i punti di tracciamento sopra l\'anteprima video.', 'low'],
    'Portrait mode': ['Ottimizza l\'interfaccia e la visuale per video verticali (TikTok, YouTube Shorts, Reels).', 'none'],
    'Selfie mode': ['Inverte i movimenti orizzontali per simulare uno specchio.', 'none'],
    'Hand camera FOV': ['Campo visivo della telecamera virtuale per le mani.', 'none'],
    'VRM joint stiffness': ['Rigidità delle articolazioni del modello per evitare pose innaturali.', 'tiny'],
    'Audio visualizer': ['Mostra un anello reattivo che pulsa con il suono della voce.', 'medium'],
    'Recording preset': ['Profili preimpostati per la registrazione video e audio.', 'high'],
    'Resolution': ['Risoluzione del video registrato (es. 1080p, 720p).', 'high'],
    'Capture FPS': ['Fotogrammi al secondo del video registrato (30 o 60 FPS).', 'high'],
    'Video bitrate': ['Qualità visiva del file registrato (più alto = qualità migliore ma file più grande).', 'high'],
    'Audio bitrate': ['Qualità del flusso audio registrato.', 'low'],
    'Audio profile': ['Profilo audio: "Podcast" disattiva i filtri aggressivi preservando la dinamica naturale della voce.', 'low'],
    'Noise gate': ['Silenzia il microfono quando non parli per eliminare fruscii e rumori di fondo.', 'tiny'],
    'Freeze pose when face mesh disappears': ['Mantiene l\'ultima posa corporea se il viso esce momentaneamente dal campo visivo.', 'tiny'],
    'Gate threshold': ['Soglia di volume sotto la quale il microfono viene silenziato.', 'none'],
    'Segment files': ['Suddivide automaticamente registrazioni molto lunghe in file separati.', 'tiny'],
    'VMC sender': ['Invia i dati del movimento in tempo reale via protocollo VMC/OSC ad altre applicazioni.', 'low'],
    'Host': ['Indirizzo IP di rete verso cui trasmettere i dati VMC.', 'none'],
    'Port': ['Porta UDP per la trasmissione dei dati VMC.', 'none'],
    'Delay': ['Ritardo intenzionale per sincronizzare i dati VMC.', 'none'],
    'Legacy bottom toolbar': ['Mostra o nasconde la barra inferiore dei comandi.', 'none'],
    '3D wallpaper': ['Converte lo sfondo in un ambiente con parallasse e profondità 3D.', 'high'],
    '3D scale XY': ['Dimensione orizzontale e verticale dell\'ambiente 3D.', 'none'],
    '3D scale Z': ['Intensità dell\'effetto di profondità tridimensionale.', 'none'],
    'Depth shift': ['Distanza focale della profondità 3D.', 'low'],
    'Depth contrast': ['Contrasto della mappa di profondità.', 'low'],
    'Depth blur': ['Sfocatura per ammorbidire la transizione di profondità.', 'medium'],
    'Depth smoothing': ['Levigatura della mappa di profondità per ridurre artefatti.', 'medium'],
    '3D X offset': ['Spostamento orizzontale dello sfondo 3D.', 'none'],
    '3D Y offset': ['Spostamento verticale dello sfondo 3D.', 'none'],
    '3D Z offset': ['Spostamento in avanti o indietro dello sfondo 3D.', 'none'],
    'Global hotkeys': ['Attiva le scorciatoie di sistema anche quando l’app è in secondo piano (funzione per app desktop).', 'tiny'],
    'Disable native hotkeys': ['Disabilita le scorciatoie da tastiera integrate.', 'none'],
    'Gamepad enabled': ['Consente di muovere la telecamera o cambiare pose tramite gamepad o controller.', 'tiny'],
    'Pose': ['Applica una posa predefinita al modello.', 'none'],
    'Shoulder adjust': ['Regola la posizione naturale delle spalle per le pose statiche.', 'none'],
    '🖐 HANDS ON': ['Attiva o disattiva il tracciamento di mani e dita. Disattivato, braccia e dita mantengono la posa.', 'high'],
    '🙈': ['Nasconde i menu per avere una visuale più pulita.', 'none'],
    '🎬': ['Nascondi completamente l\'interfaccia (Premi Esc per ripristinare)', 'none'],
    '🧍 BODY LIVE': ['Alterna tra tracciamento corpo in tempo reale e posa statica stabilizzata.', 'none'],
    '🎯 Capture current body pose': ['Memorizza la posa attuale del corpo come posa statica di riferimento.', 'none'],
    '🎯 CALIBRATE (3s)': ['Calibra la postura neutra rimanendo fermi davanti alla telecamera per 3 secondi.', 'tiny'],
    'Toggle Hand Camera': ['Attiva una telecamera virtuale ancorata alla mano per inquadrature dinamiche.', 'low'],
    'Hand Camera: OFF': ['Attiva una telecamera virtuale ancorata alla mano per inquadrature dinamiche.', 'low'],
    '▶ Start webcam': ['Accende la webcam selezionata per il tracciamento.', 'medium'],
    '■ Stop webcam': ['Spegne la webcam e interrompe il flusso video.', 'medium'],
    '↻ Refresh cameras': ['Rileva nuove telecamere collegate al computer.', 'tiny'],
    '↻ Restart webcam': ['Riavvia la telecamera selezionata.', 'medium'],
    '⇄ Mirror pose': ['Inverte a specchio la posa dell\'avatar.', 'none'],
    '↺ Reset pose': ['Riporta l\'avatar alla postura eretta iniziale.', 'none'],
    '↺ Reset pose order': ['Ripristina l\'elenco originale delle pose disponibili.', 'none'],
    '● Record': ['Avvia la registrazione video pulita: i menu a schermo non saranno visibili nel video salvato.', 'high'],
    '■ Stop': ['Ferma e finalizza la registrazione salvando il file.', 'none'],
    '📷 Snapshot': ['Salva un\'immagine ad alta risoluzione della scena corrente.', 'low'],
    'VMD': ['Esporta l\'animazione in formato MMD Motion (VMD).', 'medium'],
    'glTF': ['Esporta la scena o l\'animazione in formato 3D glTF / GLB.', 'medium'],
    'BVH': ['Esporta l\'animazione scheletrica in formato BioVision Hierarchy (BVH).', 'medium'],
    'VRMA': ['Esporta l\'animazione in formato VRM Animation (VRMA).', 'medium']
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
