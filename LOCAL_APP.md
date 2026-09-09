# XR Animator Podcasters · avvio locale

Il runtime supportato resta HTTP locale. Non aprire `XR_Animator.html` come
`file://` e non usarlo direttamente come pagina principale di NW.js: in quei
casi i percorsi, il profilo e la UI personalizzata non vengono inizializzati
correttamente.

## Avvio quotidiano

Per aprire senza ambiguità il pacchetto con Chromium incluso fai doppio clic su
`XR_Animator` nella root del progetto, oppure esegui:

```bash
./XR_Animator
```

Il vecchio nome `webview_app` resta come collegamento di compatibilità e apre lo
stesso pacchetto; non avvia più la vecchia WebView rosa.

### Browser di sistema

```bash
python3 xr_launcher.py
```

Il launcher avvia `xr_server.py` e apre automaticamente:

```text
http://127.0.0.1:8000/XR_Animator.html
```

In alternativa, il vecchio flusso continua a funzionare:

```bash
python3 xr_server.py
```

Poi apri manualmente lo stesso URL. Nel pannello destro di XR Animator resta il
pulsante `APRI CHAT`; Studio Link viene aperto in una finestra separata.

## Pacchetto Linux

### Browser incluso (consigliato)

```bash
python3 tools/build_bundled_browser.py
```

Il risultato è `release/XR_Animator_Bundled/XR_Animator`. Include un runtime
Chromium/NW.js senza la UI di un browser tradizionale: l'eseguibile avvia il
server incluso e carica XR Animator dal suo URL HTTP locale. Non richiede che
Chrome o un altro browser siano installati. Il launcher usa un profilo Chromium
dedicato e avvia sempre il server contenuto nello stesso pacchetto: non può più
agganciarsi per errore a una vecchia istanza o a un vecchio server sulla porta
8000.

### Browser di sistema

```bash
python3 tools/build_release.py
```

Il risultato è `release/XR_Animator/XR_Animator`. È un bundle `onedir`: evita
di estrarre circa 700 MB a ogni avvio e continua a servire l'app tramite HTTP.
Il profilo, gli avatar e le registrazioni restano accanto all'eseguibile.
