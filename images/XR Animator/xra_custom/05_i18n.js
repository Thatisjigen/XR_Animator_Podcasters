(() => {
  'use strict';

  const XRA = window.XRA;
  const { config, events } = XRA;

  const LANGUAGES = [
    ['auto', 'Auto / System'],
    ['en', 'English'],
    ['it', 'Italiano'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['pt-BR', 'Português (Brasil)'],
    ['zh-CN', '简体中文'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['ru', 'Русский']
  ];

  // Source strings intentionally use the current UI wording. Missing entries
  // fall back to English/source text, so localization can grow without risking UI code.
  const D = {
    it: {
      'Auto / System':'Automatico / Sistema','Language':'Lingua','UI & overlays':'UI e overlay','Legacy bottom toolbar':'Toolbar inferiore legacy',
      'Pose':'Posa','Current pose:':'Posa attuale:','Mirror pose':'Specchia posa','Reset pose':'Reset posa','Reset pose order':'Reset ordine pose',
      'Webcam / media':'Webcam / media','Webcam device':'Dispositivo webcam','Refresh cameras':'Aggiorna webcam','Start webcam':'Avvia webcam','Stop webcam':'Spegni webcam','Restart webcam':'Riavvia webcam','Mirror webcam preview':'Specchia anteprima webcam',
      'Motion capture':'Motion capture','Tracking / mocap mode':'Tracking / modalità mocap','Face only':'Solo viso','Face + Body (Split)':'Viso + corpo (Split)','Full body (MediaPipe Vision)':'Corpo completo (MediaPipe Vision)','Full body (Legacy Holistic)':'Corpo completo (Legacy Holistic)',
      'Performance':'Prestazioni','Advanced':'Avanzate','Master preset':'Preset principale','Webcam resolution':'Risoluzione webcam','Webcam FPS':'FPS webcam','Pose quality':'Qualità posa','Pose inference':'Inferenza posa','Hands inference':'Inferenza mani','Disable heavy post FX':'Disabilita post FX pesanti',
      'Visual effects':'Effetti visivi','Open advanced visual effects':'Apri effetti visivi avanzati',
      'Recording / capture':'Registrazione / cattura','Recorder':'Registratore','Recording preset':'Preset registrazione','Mode':'Modalità','Video + Audio':'Video + Audio','Video only':'Solo video','Audio only':'Solo audio','Resolution':'Risoluzione','Video bitrate':'Bitrate video','Audio bitrate':'Bitrate audio','Audio profile':'Profilo audio','Podcast / Natural':'Podcast / Naturale','Voice / Call':'Voce / Call','Noise gate':'Noise gate','Gate threshold':'Soglia gate','Segment files':'Segmenta file','Off':'Off','Every 30 min':'Ogni 30 min','Every 60 min':'Ogni 60 min','Record':'Registra','Stop':'Stop','Snapshot':'Snapshot','Native recorder fallback':'Recorder nativo di fallback',
      'Compact':'Compatto','Podcast':'Podcast','High':'Alta','Very High':'Molto alta','Custom':'Personalizzato','Ready.':'Pronto.','Show this screen on startup':'Mostra questa schermata all’avvio',
      'Quick setup · changes apply immediately.':'Configurazione rapida · le modifiche si applicano subito.','Close':'Chiudi','Webcam':'Webcam','Loading cameras…':'Caricamento webcam…','No cameras found':'Nessuna webcam trovata','Default camera':'Webcam predefinita','Camera unavailable':'Webcam non disponibile','Enable camera':'Attiva webcam','Disable camera':'Spegni webcam','Starting…':'Avvio…','Stopping…':'Arresto…',
      'Background':'Sfondo','Color':'Colore','Image':'Immagine','Microphone':'Microfono','Default microphone':'Microfono predefinito','Audio visualizer':'Visualizzatore audio','Preview / debug':'Anteprima / debug','Camera / avatar view':'Camera / vista avatar'
    },
    es: {
      'Auto / System':'Automático / Sistema','Language':'Idioma','UI & overlays':'UI y superposiciones','Legacy bottom toolbar':'Barra inferior heredada','Pose':'Pose','Mirror pose':'Reflejar pose','Reset pose':'Restablecer pose','Reset pose order':'Restablecer orden de poses','Webcam / media':'Webcam / medios','Webcam device':'Dispositivo webcam','Refresh cameras':'Actualizar cámaras','Start webcam':'Iniciar webcam','Stop webcam':'Apagar webcam','Restart webcam':'Reiniciar webcam','Mirror webcam preview':'Reflejar vista previa','Motion capture':'Captura de movimiento','Tracking / mocap mode':'Tracking / modo mocap','Face only':'Solo cara','Face + Body (Split)':'Cara + cuerpo (Split)','Full body (MediaPipe Vision)':'Cuerpo completo (MediaPipe Vision)','Full body (Legacy Holistic)':'Cuerpo completo (Legacy Holistic)','Performance':'Rendimiento','Advanced':'Avanzado','Master preset':'Preset principal','Visual effects':'Efectos visuales','Open advanced visual effects':'Abrir efectos visuales avanzados','Recording / capture':'Grabación / captura','Recorder':'Grabador','Recording preset':'Preset de grabación','Mode':'Modo','Video + Audio':'Vídeo + Audio','Video only':'Solo vídeo','Audio only':'Solo audio','Resolution':'Resolución','Video bitrate':'Bitrate de vídeo','Audio bitrate':'Bitrate de audio','Audio profile':'Perfil de audio','Podcast / Natural':'Podcast / Natural','Voice / Call':'Voz / Llamada','Noise gate':'Puerta de ruido','Gate threshold':'Umbral de puerta','Segment files':'Segmentar archivos','Every 30 min':'Cada 30 min','Every 60 min':'Cada 60 min','Record':'Grabar','Stop':'Detener','Background':'Fondo','Microphone':'Micrófono','Default microphone':'Micrófono predeterminado','Ready.':'Listo.'
    },
    fr: {
      'Auto / System':'Auto / Système','Language':'Langue','UI & overlays':'Interface et overlays','Legacy bottom toolbar':'Barre inférieure héritée','Pose':'Pose','Mirror pose':'Miroir de pose','Reset pose':'Réinitialiser la pose','Reset pose order':'Réinitialiser l’ordre des poses','Webcam / media':'Webcam / média','Webcam device':'Périphérique webcam','Refresh cameras':'Actualiser les caméras','Start webcam':'Démarrer la webcam','Stop webcam':'Arrêter la webcam','Restart webcam':'Redémarrer la webcam','Mirror webcam preview':'Miroir de l’aperçu webcam','Motion capture':'Capture de mouvement','Tracking / mocap mode':'Tracking / mode mocap','Face only':'Visage uniquement','Face + Body (Split)':'Visage + corps (Split)','Full body (MediaPipe Vision)':'Corps entier (MediaPipe Vision)','Full body (Legacy Holistic)':'Corps entier (Legacy Holistic)','Performance':'Performances','Advanced':'Avancé','Master preset':'Preset principal','Visual effects':'Effets visuels','Open advanced visual effects':'Ouvrir les effets visuels avancés','Recording / capture':'Enregistrement / capture','Recorder':'Enregistreur','Recording preset':'Preset d’enregistrement','Mode':'Mode','Video + Audio':'Vidéo + Audio','Video only':'Vidéo uniquement','Audio only':'Audio uniquement','Resolution':'Résolution','Video bitrate':'Débit vidéo','Audio bitrate':'Débit audio','Audio profile':'Profil audio','Podcast / Natural':'Podcast / Naturel','Voice / Call':'Voix / Appel','Noise gate':'Noise gate','Gate threshold':'Seuil du gate','Segment files':'Segmenter les fichiers','Every 30 min':'Toutes les 30 min','Every 60 min':'Toutes les 60 min','Record':'Enregistrer','Stop':'Arrêter','Background':'Arrière-plan','Microphone':'Microphone','Default microphone':'Microphone par défaut','Ready.':'Prêt.'
    },
    de: {
      'Auto / System':'Auto / System','Language':'Sprache','UI & overlays':'UI & Overlays','Legacy bottom toolbar':'Legacy-Unterleiste','Pose':'Pose','Mirror pose':'Pose spiegeln','Reset pose':'Pose zurücksetzen','Reset pose order':'Posenreihenfolge zurücksetzen','Webcam / media':'Webcam / Medien','Webcam device':'Webcam-Gerät','Refresh cameras':'Kameras aktualisieren','Start webcam':'Webcam starten','Stop webcam':'Webcam stoppen','Restart webcam':'Webcam neu starten','Mirror webcam preview':'Webcam-Vorschau spiegeln','Motion capture':'Motion Capture','Tracking / mocap mode':'Tracking / Mocap-Modus','Face only':'Nur Gesicht','Face + Body (Split)':'Gesicht + Körper (Split)','Full body (MediaPipe Vision)':'Ganzkörper (MediaPipe Vision)','Full body (Legacy Holistic)':'Ganzkörper (Legacy Holistic)','Performance':'Leistung','Advanced':'Erweitert','Master preset':'Haupt-Preset','Visual effects':'Visuelle Effekte','Open advanced visual effects':'Erweiterte visuelle Effekte öffnen','Recording / capture':'Aufnahme / Capture','Recorder':'Recorder','Recording preset':'Aufnahme-Preset','Mode':'Modus','Video + Audio':'Video + Audio','Video only':'Nur Video','Audio only':'Nur Audio','Resolution':'Auflösung','Video bitrate':'Video-Bitrate','Audio bitrate':'Audio-Bitrate','Audio profile':'Audioprofil','Podcast / Natural':'Podcast / Natürlich','Voice / Call':'Sprache / Call','Noise gate':'Noise Gate','Gate threshold':'Gate-Schwelle','Segment files':'Dateien segmentieren','Every 30 min':'Alle 30 Min','Every 60 min':'Alle 60 Min','Record':'Aufnehmen','Stop':'Stoppen','Background':'Hintergrund','Microphone':'Mikrofon','Default microphone':'Standardmikrofon','Ready.':'Bereit.'
    },
    'pt-BR': {
      'Auto / System':'Automático / Sistema','Language':'Idioma','UI & overlays':'UI e sobreposições','Legacy bottom toolbar':'Barra inferior legada','Pose':'Pose','Mirror pose':'Espelhar pose','Reset pose':'Redefinir pose','Reset pose order':'Redefinir ordem das poses','Webcam / media':'Webcam / mídia','Webcam device':'Dispositivo de webcam','Refresh cameras':'Atualizar câmeras','Start webcam':'Iniciar webcam','Stop webcam':'Desligar webcam','Restart webcam':'Reiniciar webcam','Mirror webcam preview':'Espelhar prévia da webcam','Motion capture':'Captura de movimento','Tracking / mocap mode':'Tracking / modo mocap','Face only':'Somente rosto','Face + Body (Split)':'Rosto + corpo (Split)','Full body (MediaPipe Vision)':'Corpo inteiro (MediaPipe Vision)','Full body (Legacy Holistic)':'Corpo inteiro (Legacy Holistic)','Performance':'Desempenho','Advanced':'Avançado','Master preset':'Preset principal','Visual effects':'Efeitos visuais','Open advanced visual effects':'Abrir efeitos visuais avançados','Recording / capture':'Gravação / captura','Recorder':'Gravador','Recording preset':'Preset de gravação','Mode':'Modo','Video + Audio':'Vídeo + Áudio','Video only':'Somente vídeo','Audio only':'Somente áudio','Resolution':'Resolução','Video bitrate':'Bitrate de vídeo','Audio bitrate':'Bitrate de áudio','Audio profile':'Perfil de áudio','Podcast / Natural':'Podcast / Natural','Voice / Call':'Voz / Chamada','Noise gate':'Noise gate','Gate threshold':'Limite do gate','Segment files':'Segmentar arquivos','Every 30 min':'A cada 30 min','Every 60 min':'A cada 60 min','Record':'Gravar','Stop':'Parar','Background':'Fundo','Microphone':'Microfone','Default microphone':'Microfone padrão','Ready.':'Pronto.'
    },
    'zh-CN': {
      'Auto / System':'自动 / 系统','Language':'语言','UI & overlays':'界面与叠加层','Legacy bottom toolbar':'旧版底部工具栏','Pose':'姿势','Mirror pose':'镜像姿势','Reset pose':'重置姿势','Reset pose order':'重置姿势顺序','Webcam / media':'摄像头 / 媒体','Webcam device':'摄像头设备','Refresh cameras':'刷新摄像头','Start webcam':'启动摄像头','Stop webcam':'关闭摄像头','Restart webcam':'重启摄像头','Mirror webcam preview':'镜像摄像头预览','Motion capture':'动作捕捉','Tracking / mocap mode':'追踪 / 动捕模式','Face only':'仅面部','Face + Body (Split)':'面部 + 身体（Split）','Full body (MediaPipe Vision)':'全身（MediaPipe Vision）','Full body (Legacy Holistic)':'全身（Legacy Holistic）','Performance':'性能','Advanced':'高级','Master preset':'主预设','Visual effects':'视觉效果','Open advanced visual effects':'打开高级视觉效果','Recording / capture':'录制 / 捕获','Recorder':'录制器','Recording preset':'录制预设','Mode':'模式','Video + Audio':'视频 + 音频','Video only':'仅视频','Audio only':'仅音频','Resolution':'分辨率','Video bitrate':'视频码率','Audio bitrate':'音频码率','Audio profile':'音频配置','Podcast / Natural':'播客 / 自然','Voice / Call':'语音 / 通话','Noise gate':'噪声门','Gate threshold':'噪声门阈值','Segment files':'分段文件','Every 30 min':'每 30 分钟','Every 60 min':'每 60 分钟','Record':'录制','Stop':'停止','Background':'背景','Microphone':'麦克风','Default microphone':'默认麦克风','Ready.':'就绪。'
    },
    ja: {
      'Auto / System':'自動 / システム','Language':'言語','UI & overlays':'UI とオーバーレイ','Legacy bottom toolbar':'旧ボトムツールバー','Pose':'ポーズ','Mirror pose':'ポーズを反転','Reset pose':'ポーズをリセット','Reset pose order':'ポーズ順をリセット','Webcam / media':'Webカメラ / メディア','Webcam device':'Webカメラ','Refresh cameras':'カメラを更新','Start webcam':'Webカメラ開始','Stop webcam':'Webカメラ停止','Restart webcam':'Webカメラ再起動','Mirror webcam preview':'Webカメラプレビューを反転','Motion capture':'モーションキャプチャ','Tracking / mocap mode':'トラッキング / Mocap モード','Face only':'顔のみ','Face + Body (Split)':'顔 + 体（Split）','Full body (MediaPipe Vision)':'全身（MediaPipe Vision）','Full body (Legacy Holistic)':'全身（Legacy Holistic）','Performance':'パフォーマンス','Advanced':'詳細','Master preset':'メインプリセット','Visual effects':'視覚効果','Open advanced visual effects':'高度な視覚効果を開く','Recording / capture':'録画 / キャプチャ','Recorder':'レコーダー','Recording preset':'録画プリセット','Mode':'モード','Video + Audio':'映像 + 音声','Video only':'映像のみ','Audio only':'音声のみ','Resolution':'解像度','Video bitrate':'映像ビットレート','Audio bitrate':'音声ビットレート','Audio profile':'音声プロファイル','Podcast / Natural':'ポッドキャスト / ナチュラル','Voice / Call':'音声 / 通話','Noise gate':'ノイズゲート','Gate threshold':'ゲートしきい値','Segment files':'ファイル分割','Every 30 min':'30分ごと','Every 60 min':'60分ごと','Record':'録画','Stop':'停止','Background':'背景','Microphone':'マイク','Default microphone':'既定のマイク','Ready.':'準備完了。'
    },
    ko: {
      'Auto / System':'자동 / 시스템','Language':'언어','UI & overlays':'UI 및 오버레이','Legacy bottom toolbar':'레거시 하단 툴바','Pose':'포즈','Mirror pose':'포즈 미러','Reset pose':'포즈 초기화','Reset pose order':'포즈 순서 초기화','Webcam / media':'웹캠 / 미디어','Webcam device':'웹캠 장치','Refresh cameras':'카메라 새로고침','Start webcam':'웹캠 시작','Stop webcam':'웹캠 끄기','Restart webcam':'웹캠 재시작','Mirror webcam preview':'웹캠 미리보기 미러','Motion capture':'모션 캡처','Tracking / mocap mode':'트래킹 / 모캡 모드','Face only':'얼굴만','Face + Body (Split)':'얼굴 + 몸 (Split)','Full body (MediaPipe Vision)':'전신 (MediaPipe Vision)','Full body (Legacy Holistic)':'전신 (Legacy Holistic)','Performance':'성능','Advanced':'고급','Master preset':'마스터 프리셋','Visual effects':'시각 효과','Open advanced visual effects':'고급 시각 효과 열기','Recording / capture':'녹화 / 캡처','Recorder':'레코더','Recording preset':'녹화 프리셋','Mode':'모드','Video + Audio':'비디오 + 오디오','Video only':'비디오만','Audio only':'오디오만','Resolution':'해상도','Video bitrate':'비디오 비트레이트','Audio bitrate':'오디오 비트레이트','Audio profile':'오디오 프로필','Podcast / Natural':'팟캐스트 / 자연스러움','Voice / Call':'음성 / 통화','Noise gate':'노이즈 게이트','Gate threshold':'게이트 임계값','Segment files':'파일 분할','Every 30 min':'30분마다','Every 60 min':'60분마다','Record':'녹화','Stop':'중지','Background':'배경','Microphone':'마이크','Default microphone':'기본 마이크','Ready.':'준비됨.'
    },
    ru: {
      'Auto / System':'Авто / Система','Language':'Язык','UI & overlays':'Интерфейс и оверлеи','Legacy bottom toolbar':'Старая нижняя панель','Pose':'Поза','Mirror pose':'Отразить позу','Reset pose':'Сбросить позу','Reset pose order':'Сбросить порядок поз','Webcam / media':'Веб-камера / медиа','Webcam device':'Устройство камеры','Refresh cameras':'Обновить камеры','Start webcam':'Запустить камеру','Stop webcam':'Выключить камеру','Restart webcam':'Перезапустить камеру','Mirror webcam preview':'Зеркалить превью камеры','Motion capture':'Захват движения','Tracking / mocap mode':'Трекинг / режим mocap','Face only':'Только лицо','Face + Body (Split)':'Лицо + тело (Split)','Full body (MediaPipe Vision)':'Полное тело (MediaPipe Vision)','Full body (Legacy Holistic)':'Полное тело (Legacy Holistic)','Performance':'Производительность','Advanced':'Расширенные','Master preset':'Главный пресет','Visual effects':'Визуальные эффекты','Open advanced visual effects':'Открыть расширенные визуальные эффекты','Recording / capture':'Запись / захват','Recorder':'Рекордер','Recording preset':'Пресет записи','Mode':'Режим','Video + Audio':'Видео + аудио','Video only':'Только видео','Audio only':'Только аудио','Resolution':'Разрешение','Video bitrate':'Битрейт видео','Audio bitrate':'Битрейт аудио','Audio profile':'Аудиопрофиль','Podcast / Natural':'Подкаст / Натуральный','Voice / Call':'Голос / Звонок','Noise gate':'Шумовой гейт','Gate threshold':'Порог гейта','Segment files':'Разбивать файлы','Every 30 min':'Каждые 30 мин','Every 60 min':'Каждые 60 мин','Record':'Запись','Stop':'Стоп','Background':'Фон','Microphone':'Микрофон','Default microphone':'Микрофон по умолчанию','Ready.':'Готово.'
    }
  };

  // V7.5 additions. Kept separate so the base dictionaries stay readable.
  const V75 = {
    it: {
      'Selfie mode':'Modalità selfie','Output format':'Formato output','Default file name':'Nome file predefinito','Recording folder':'Cartella registrazione','Choose folder':'Scegli cartella','Live gate level':'Livello gate in tempo reale','Monitor mic':'Monitora microfono','Stop monitor':'Ferma monitor','Start recording?':'Avviare la registrazione?','File name':'Nome file','Folder':'Cartella','Format':'Formato','Shoulders-up mocap / Torso Guard':'Mocap dalle spalle in su / Torso Guard','Torso guard strength':'Forza Torso Guard','Recapture torso neutral':'Ricattura neutro torso'
    },
    es: {
      'Selfie mode':'Modo selfie','Output format':'Formato de salida','Default file name':'Nombre de archivo predeterminado','Recording folder':'Carpeta de grabación','Choose folder':'Elegir carpeta','Live gate level':'Nivel del gate en vivo','Monitor mic':'Monitorizar micrófono','Stop monitor':'Detener monitor','Start recording?':'¿Iniciar grabación?','File name':'Nombre de archivo','Folder':'Carpeta','Format':'Formato','Shoulders-up mocap / Torso Guard':'Mocap desde hombros / Torso Guard','Torso guard strength':'Fuerza de Torso Guard'
    },
    fr: {
      'Selfie mode':'Mode selfie','Output format':'Format de sortie','Default file name':'Nom de fichier par défaut','Recording folder':'Dossier d’enregistrement','Choose folder':'Choisir un dossier','Live gate level':'Niveau du gate en direct','Monitor mic':'Surveiller le micro','Stop monitor':'Arrêter le moniteur','Start recording?':'Démarrer l’enregistrement ?','File name':'Nom du fichier','Folder':'Dossier','Format':'Format','Shoulders-up mocap / Torso Guard':'Mocap épaules et haut / Torso Guard','Torso guard strength':'Force du Torso Guard'
    },
    de: {
      'Selfie mode':'Selfie-Modus','Output format':'Ausgabeformat','Default file name':'Standard-Dateiname','Recording folder':'Aufnahmeordner','Choose folder':'Ordner wählen','Live gate level':'Live-Gate-Pegel','Monitor mic':'Mikrofon überwachen','Stop monitor':'Monitoring stoppen','Start recording?':'Aufnahme starten?','File name':'Dateiname','Folder':'Ordner','Format':'Format','Shoulders-up mocap / Torso Guard':'Mocap ab Schultern / Torso Guard','Torso guard strength':'Torso-Guard-Stärke'
    },
    'pt-BR': {
      'Selfie mode':'Modo selfie','Output format':'Formato de saída','Default file name':'Nome de arquivo padrão','Recording folder':'Pasta de gravação','Choose folder':'Escolher pasta','Live gate level':'Nível do gate ao vivo','Monitor mic':'Monitorar microfone','Stop monitor':'Parar monitor','Start recording?':'Iniciar gravação?','File name':'Nome do arquivo','Folder':'Pasta','Format':'Formato','Shoulders-up mocap / Torso Guard':'Mocap dos ombros para cima / Torso Guard','Torso guard strength':'Força do Torso Guard'
    },
    'zh-CN': {
      'Selfie mode':'自拍模式','Output format':'输出格式','Default file name':'默认文件名','Recording folder':'录制文件夹','Choose folder':'选择文件夹','Live gate level':'实时噪声门电平','Monitor mic':'监听麦克风','Stop monitor':'停止监听','Start recording?':'开始录制？','File name':'文件名','Folder':'文件夹','Format':'格式','Shoulders-up mocap / Torso Guard':'肩部以上动捕 / 躯干保护','Torso guard strength':'躯干保护强度'
    },
    ja: {
      'Selfie mode':'セルフィーモード','Output format':'出力形式','Default file name':'既定のファイル名','Recording folder':'録画フォルダー','Choose folder':'フォルダーを選択','Live gate level':'ライブゲートレベル','Monitor mic':'マイクをモニター','Stop monitor':'モニター停止','Start recording?':'録画を開始しますか？','File name':'ファイル名','Folder':'フォルダー','Format':'形式','Shoulders-up mocap / Torso Guard':'肩から上のMocap / Torso Guard','Torso guard strength':'Torso Guard 強度'
    },
    ko: {
      'Selfie mode':'셀피 모드','Output format':'출력 형식','Default file name':'기본 파일 이름','Recording folder':'녹화 폴더','Choose folder':'폴더 선택','Live gate level':'실시간 게이트 레벨','Monitor mic':'마이크 모니터','Stop monitor':'모니터 중지','Start recording?':'녹화를 시작할까요?','File name':'파일 이름','Folder':'폴더','Format':'형식','Shoulders-up mocap / Torso Guard':'어깨 위 모캡 / Torso Guard','Torso guard strength':'Torso Guard 강도'
    },
    ru: {
      'Selfie mode':'Режим селфи','Output format':'Формат вывода','Default file name':'Имя файла по умолчанию','Recording folder':'Папка записи','Choose folder':'Выбрать папку','Live gate level':'Текущий уровень гейта','Monitor mic':'Мониторить микрофон','Stop monitor':'Остановить монитор','Start recording?':'Начать запись?','File name':'Имя файла','Folder':'Папка','Format':'Формат','Shoulders-up mocap / Torso Guard':'Mocap от плеч / Torso Guard','Torso guard strength':'Сила Torso Guard'
    }
  };
  for (const [lang, additions] of Object.entries(V75)) Object.assign(D[lang] ||= {}, additions);

  // V7.6 Stability + Creator additions. Missing translations still fall back to
  // the source English text, but the main creator controls are localized.
  const V76 = {
    it: {
      'Torso Guard / Podcast Desk':'Torso Guard / Podcast Desk','Torso Guard':'Torso Guard','Podcast / Desk mocap':'Mocap Podcast / Scrivania',
      'Torso Guard / Desk Advanced':'Torso Guard / Scrivania avanzato','Recapture neutral torso':'Ricattura torso neutro','Guard strength':'Forza Guard',
      'Desk torso lock':'Blocco torso scrivania','Desk hips lock':'Blocco bacino scrivania','Desk legs lock':'Blocco gambe scrivania',
      'Max torso yaw':'Yaw massimo torso','Max torso pitch':'Pitch massimo torso','Max torso roll':'Roll massimo torso','Reject jump above':'Rifiuta salto oltre',
      'Hold last valid pose':'Mantieni ultima posa valida','Reacquire near neutral':'Riaggancia vicino al neutro','Min landmark confidence':'Confidenza minima landmark',
      'Adaptive smoothing':'Smoothing adattivo','Adaptive smoothing strength':'Forza smoothing adattivo','Runtime adaptive performance':'Performance adattive runtime',
      'Performance / REC HUD':'HUD Performance / REC','Camera transform':'Trasformazione camera','Avatar position':'Posizione personaggio','Advanced target / look-at':'Target / look-at avanzato',
      'Camera X':'Camera X','Camera Y':'Camera Y','Camera Z':'Camera Z','Camera FOV':'FOV camera','Target X':'Target X','Target Y':'Target Y','Target Z':'Target Z',
      'Avatar X':'Personaggio X','Avatar Y':'Personaggio Y','Avatar Z':'Personaggio Z','Avatar rotation Y':'Rotazione Y personaggio',
      'Reset camera':'Reset camera','Reset avatar position':'Reset posizione personaggio','Reset camera + avatar':'Reset camera + personaggio',
      'Gate calibration':'Calibrazione gate','Auto calibrate gate (3 s)':'Calibra gate automaticamente (3 s)','RAW microphone backup':'Backup microfono RAW',
      'RAW backup format':'Formato backup RAW','MP4 encoder':'Encoder MP4','Interrupted recording recovery':'Recupero registrazioni interrotte',
      'Scan unfinished recordings':'Cerca registrazioni incomplete','Recover latest':'Recupera ultima','STOP RECORDING':'STOP REGISTRAZIONE','FINALIZING':'FINALIZZAZIONE'
    },
    es: {
      'Podcast / Desk mocap':'Mocap Podcast / Escritorio','Adaptive smoothing':'Suavizado adaptativo','Runtime adaptive performance':'Rendimiento adaptativo en ejecución',
      'Camera transform':'Transformación de cámara','Avatar position':'Posición del avatar','Reset camera':'Restablecer cámara','Reset avatar position':'Restablecer posición del avatar',
      'RAW microphone backup':'Copia RAW del micrófono','Gate calibration':'Calibración del gate','Interrupted recording recovery':'Recuperación de grabación interrumpida','STOP RECORDING':'DETENER GRABACIÓN'
    },
    fr: {
      'Podcast / Desk mocap':'Mocap Podcast / Bureau','Adaptive smoothing':'Lissage adaptatif','Runtime adaptive performance':'Performance adaptative à l’exécution',
      'Camera transform':'Transformation caméra','Avatar position':'Position avatar','Reset camera':'Réinitialiser caméra','Reset avatar position':'Réinitialiser position avatar',
      'RAW microphone backup':'Sauvegarde micro RAW','Gate calibration':'Calibration du gate','Interrupted recording recovery':'Récupération d’enregistrement interrompu','STOP RECORDING':'ARRÊTER ENREGISTREMENT'
    },
    de: {
      'Podcast / Desk mocap':'Podcast / Schreibtisch Mocap','Adaptive smoothing':'Adaptives Smoothing','Runtime adaptive performance':'Adaptive Laufzeitleistung',
      'Camera transform':'Kamera-Transformation','Avatar position':'Avatar-Position','Reset camera':'Kamera zurücksetzen','Reset avatar position':'Avatar-Position zurücksetzen',
      'RAW microphone backup':'RAW-Mikrofon-Backup','Gate calibration':'Gate-Kalibrierung','Interrupted recording recovery':'Wiederherstellung unterbrochener Aufnahme','STOP RECORDING':'AUFNAHME STOPPEN'
    },
    'pt-BR': {
      'Podcast / Desk mocap':'Mocap Podcast / Mesa','Adaptive smoothing':'Suavização adaptativa','Runtime adaptive performance':'Desempenho adaptativo em runtime',
      'Camera transform':'Transformação da câmera','Avatar position':'Posição do avatar','Reset camera':'Redefinir câmera','Reset avatar position':'Redefinir posição do avatar',
      'RAW microphone backup':'Backup RAW do microfone','Gate calibration':'Calibração do gate','Interrupted recording recovery':'Recuperação de gravação interrompida','STOP RECORDING':'PARAR GRAVAÇÃO'
    },
    'zh-CN': {'Podcast / Desk mocap':'播客 / 桌面动捕','Adaptive smoothing':'自适应平滑','Camera transform':'相机变换','Avatar position':'角色位置','RAW microphone backup':'RAW 麦克风备份','STOP RECORDING':'停止录制'},
    ja: {'Podcast / Desk mocap':'ポッドキャスト / デスク Mocap','Adaptive smoothing':'適応スムージング','Camera transform':'カメラ変換','Avatar position':'アバター位置','RAW microphone backup':'RAW マイクバックアップ','STOP RECORDING':'録画停止'},
    ko: {'Podcast / Desk mocap':'팟캐스트 / 데스크 모캡','Adaptive smoothing':'적응형 스무딩','Camera transform':'카메라 변환','Avatar position':'아바타 위치','RAW microphone backup':'RAW 마이크 백업','STOP RECORDING':'녹화 중지'},
    ru: {'Podcast / Desk mocap':'Mocap Подкаст / Стол','Adaptive smoothing':'Адаптивное сглаживание','Camera transform':'Положение камеры','Avatar position':'Положение аватара','RAW microphone backup':'RAW-бэкап микрофона','STOP RECORDING':'ОСТАНОВИТЬ ЗАПИСЬ'}
  };
  for (const [lang, additions] of Object.entries(V76)) Object.assign(D[lang] ||= {}, additions);

  // V7.6.20: fill the remaining Italian gaps in the active custom UI.
  // Other languages still fall back safely to the source string.
  Object.assign(D.it ||= {}, {
    'Advanced stability / tracking':'Stabilità / tracking avanzati',
    'Anchor strength':'Forza ancoraggio',
    'Transition':'Transizione',
    'Freeze head when face mesh disappears':'Blocca testa quando scompare la mesh del viso',
    'Freeze pose when face mesh disappears':'Blocca la posa quando scompare la mesh del viso',
    'Head tracking: live':'Tracking testa: live',
    'Head tracking: FROZEN · lip sync remains live':'Tracking testa: BLOCCATO · lip sync ancora live',
    'Pose tracking: live':'Tracking posa: live',
    'Pose tracking: FROZEN · lip sync remains live':'Tracking posa: BLOCCATO · lip sync ancora live',
    'Body / Head stability':'Corpo / stabilità testa',
    'Body':'Corpo',
    'Body tracking':'Tracking corpo',
    'Torso protection':'Protezione torso',
    'Tracking loss protection':'Protezione perdita tracking',
    'Guard strength':'Forza stabilizzazione',
    'Desk torso lock':'Stabilizzazione torso scrivania',
    'Shoulder adjust':'Correzione spalle',
    'Shoulder tracking':'Tracking spalle',
    'Upper body blend':'Mix parte superiore',
    'Native mocap smoothing':'Smoothing mocap nativo',
    'Body bend reduction':'Riduzione piegamento corpo',
    'Limit webcam':'Limita webcam',
    'Light lip analysis':'Analisi labiale leggera',
    'Lip FFT':'FFT labiale',
    'Lip analysis':'Analisi labiale',
    'Mic / camera mix':'Mix microfono / camera',
    'Mouth response':'Risposta bocca',
    'Vowel emphasis':'Enfasi vocali',
    'Voice gate':'Gate voce',
    'Show VU meter':'Mostra VU meter',
    'Recording source':'Sorgente registrazione',
    'Capture FPS':'FPS cattura',
    'Chroma-safe recording':'Registrazione chroma-safe',
    'Render at recording resolution':'Render alla risoluzione di registrazione',
    'Folder (absolute Linux path)':'Cartella (percorso Linux assoluto)',
    'Image path':'Percorso immagine',
    'Background file':'File sfondo',
    'Close advanced visual effects':'Chiudi effetti visivi avanzati',
    'Startup screen':'Schermata iniziale',
    'Profile':'Profilo',
    'Apply JSON':'Applica JSON',
    'Refresh JSON':'Aggiorna JSON',
    'Export motion':'Esporta movimento',
    'Toggle Hand Camera':'Cambia Hand Camera',
    'Native hand tracking':'Tracking mani nativo',
    'Face tracking':'Tracking viso',
    'Scene / 3D':'Scena / 3D',
    'Miscellaneous / native tools':'Varie / strumenti nativi',
    'Advanced native settings':'Impostazioni native avanzate',
    'Camera list not loaded.':'Elenco webcam non caricato.',
    'No scan yet.':'Nessuna scansione eseguita.',
    'Cancel':'Annulla',
    'Head reaction':'Reazione testa',
    'EXPORT':'ESPORTA',
    'IMPORT':'IMPORTA',
    'LOAD':'CARICA',
    'SAVE':'SALVA',
    'CALIBRATE (3s)':'CALIBRA (3s)',
    'Capture current body pose':'Cattura posa corpo attuale',
    'HANDS ON':'MANI ON',
    'HANDS OFF':'MANI OFF',
    'BODY LIVE':'CORPO LIVE',
    'BODY STABLE':'CORPO STABILE',
    'Start recording':'Avvia registrazione',
    'Refresh background files':'Aggiorna file sfondo',
    'Body collider':'Collider corpo',
    'Uses the same face-mesh signal as the technical preview: while that mesh is absent, neck/head stay on the last mesh-visible pose. Microphone lip sync keeps driving the mouth. OFF by default.':'Usa lo stesso segnale della mesh viso della preview tecnica: quando la mesh manca, collo e testa restano sull’ultima posa in cui la mesh era visibile. Il lip sync da microfono continua a muovere la bocca. Di default è OFF.',
    'Uses only the face-mesh signal from the technical preview. While the mesh is absent, the whole tracked skeletal pose is held on the last mesh-visible frame; microphone lip sync keeps driving the mouth. OFF by default.':'Usa solo il segnale della mesh viso della preview tecnica. Quando la mesh manca, l’intera posa scheletrica resta bloccata sull’ultimo frame con mesh visibile; il lip sync da microfono continua a muovere la bocca. Di default è OFF.',
    'Torso Guard rejects implausible twists and can add neutral-torso stabilization. Podcast / Desk stabilizes torso, hips and legs; shoulder bones stay tracked, but a strong chest lock can make them look rigid.':'Torso Guard respinge torsioni implausibili e può aggiungere stabilizzazione verso il torso neutro. Podcast / Scrivania stabilizza torso, bacino e gambe; le ossa delle spalle restano tracciate, ma un blocco forte del petto può farle sembrare rigide.',
    '0% leaves valid torso motion live but still keeps the hard reject/hold protection on tracking loss. Raise it only if you want more neutral-torso stabilization.':'0% lascia live il movimento valido del torso ma mantiene la protezione rigida reject/hold quando il tracking si perde. Aumentalo solo se vuoi più stabilizzazione verso il torso neutro.',
    'This stabilizes the chest/torso parent, not the shoulder bones themselves. Try 20–35% if Podcast / Desk feels too rigid in the shoulders.':'Stabilizza il parent petto/torso, non direttamente le ossa delle spalle. Prova 20–35% se Podcast / Scrivania rende le spalle troppo rigide.',
    'Mic level':'Livello microfono',
    'threshold':'soglia',
    'OPEN':'APERTO',
    'CLOSED':'CHIUSO',
    'Noise floor not calibrated yet.':'Rumore di fondo non ancora calibrato.',
    'Saved room noise floor':'Rumore di fondo salvato',
    'Practical range -70 to -5 dB, in 0.5 dB steps. Values below about -70 dB are rarely useful as a voice gate threshold.':'Intervallo pratico da -70 a -5 dB, a passi di 0,5 dB. Valori sotto circa -70 dB sono raramente utili come soglia del gate voce.',
    'The meter is zoomed to the useful voice-gate range (-70 to -5 dB), so room noise, quiet speech and the threshold are easier to compare.':'Il meter è ingrandito sulla fascia utile del gate voce (-70 / -5 dB), così è più facile confrontare rumore ambiente, voce bassa e soglia.',
    'Focused voice-gate range -55 to -5 dB, in 0.25 dB steps. This trades extreme low-end range for much finer control around normal room noise and quiet speech.':'Intervallo mirato del gate voce da -55 a -5 dB, a passi di 0,25 dB. Riduce la fascia estrema in basso per dare un controllo molto più fine attorno al rumore ambiente e alla voce bassa.',
    'The meter is zoomed to -55 to -5 dB, with 10 dB reference marks, so room noise, quiet speech and the threshold are easier to compare.':'Il meter è ingrandito da -55 a -5 dB, con riferimenti ogni 10 dB, così è più facile confrontare rumore ambiente, voce bassa e soglia.',
    'Stay silent for 3 seconds. Uses the median room-noise level plus about 5 dB and rounds to 0.25 dB, avoiding brief noise spikes while matching the finer gate slider.':'Resta in silenzio per 3 secondi. Usa la mediana del rumore ambiente più circa 5 dB e arrotonda a 0,25 dB, evitando i picchi brevi e seguendo la regolazione più fine dello slider.',
    'For solid-color backgrounds: uses the exact background color and temporarily disables Bloom / Depth of Field while recording to reduce halos around the avatar. The switch stays editable; on non-color backgrounds it is simply ignored. Restores the effects at Stop.':'Per sfondi a colore pieno usa il colore esatto e disattiva temporaneamente Bloom / Depth of Field durante la registrazione per ridurre gli aloni attorno all’avatar. Lo switch resta modificabile; con sfondi non a colore viene semplicemente ignorato. Gli effetti vengono ripristinati allo Stop.',
    'Avatar / app':'Avatar / app',
    'Load / change VRM…':'Carica / cambia VRM…',
    'Restart XR Animator':'Riavvia XR Animator',
    'Body mode':'Modalità corpo',
    'Live':'Live',
    'Stable':'Stabile',
    'Podcast / Desk':'Podcast / Scrivania',
    'Recovery speed':'Velocità recupero',
    'Instant':'Istantaneo',
    'Fast':'Rapido',
    'Normal':'Normale',
    'Smooth':'Fluido',
    'Very smooth':'Molto fluido',
    'Torso Guard / Podcast Desk':'Torso Guard / Podcast Scrivania',
    'Body stabilization':'Stabilizzazione corpo',
    'Body stabilization: ON':'Stabilizzazione corpo: ON',
    'Body stabilization: OFF':'Stabilizzazione corpo: OFF',
    'OFF keeps body tracking fully live. ON captures the current body pose and stabilizes it with Anchor strength; an internal anti-glitch guard rejects implausible torso jumps.':'OFF lascia il tracking del corpo completamente live. ON cattura la posa attuale e la stabilizza con Forza ancoraggio; una protezione anti-glitch interna respinge i salti implausibili del torso.',
    '0% is almost live while keeping anti-glitch rejection available when stabilization is ON. 100% holds the captured body pose as strongly as possible.':'0% resta quasi live mantenendo disponibile la protezione anti-glitch quando la stabilizzazione è ON. 100% mantiene la posa catturata con la massima forza.',
    'Tracking loss protection: ready':'Protezione perdita tracking: pronta',
    'Tracking loss protection: automatic with stabilization':'Protezione perdita tracking: automatica con stabilizzazione',
    'Tracking loss protection: FROZEN · lip sync remains live':'Protezione perdita tracking: BLOCCATA · lip sync ancora live',
    'Tracking loss protection: RECOVERING':'Protezione perdita tracking: RECUPERO',
    'Automatic while Body stabilization is ON. Enable it here to keep the last valid full pose even with stabilization OFF; microphone lip sync remains active.':'Automatica quando Stabilizzazione corpo è ON. Attivala qui per mantenere l’ultima posa completa valida anche con la stabilizzazione OFF; il lip sync da microfono resta attivo.',
    'Uses the technical face-mesh signal. If the mesh disappears, the body returns to a recent stable pose and stays frozen while microphone lip sync keeps the mouth active.':'Usa il segnale della mesh tecnica del viso. Se la mesh scompare, il corpo torna a una posa stabile recente e resta bloccato mentre il lip sync da microfono continua a muovere la bocca.',
    'Controls how quickly the avatar blends from the frozen pose back to live tracking after the face mesh is stable again.':'Regola la velocità con cui l’avatar passa dalla posa bloccata al tracking live quando la mesh del viso è di nuovo stabile.',
    'Controls how quickly the avatar blends from the frozen pose back to live tracking after the detector is stable again.':'Regola la velocità con cui l’avatar passa dalla posa bloccata al tracking live quando il rilevatore è di nuovo stabile.',
    'Recapture reference pose':'Ricattura posa di riferimento',
    'Reference pose captured':'Posa di riferimento catturata',
    'Blend time when body stabilization is enabled or disabled.':'Tempo di transizione quando la stabilizzazione corpo viene attivata o disattivata.',
    'Rejects implausibly large torso rotation jumps while body stabilization is active.':'Respinge i salti di rotazione del torso troppo grandi e implausibili mentre la stabilizzazione corpo è attiva.',
    'Rejects implausibly large tracked-pose rotation jumps while body stabilization is active.':'Respinge i salti di rotazione troppo grandi e implausibili dell’intera posa mentre la stabilizzazione corpo è attiva.',
    'How long the anti-glitch safety holds the last valid torso pose after a rejected tracking jump.':'Per quanto tempo la protezione anti-glitch mantiene l’ultima posa valida del torso dopo aver respinto un salto di tracking.',
    'How long the anti-glitch safety holds the last valid full pose after a rejected tracking jump.':'Per quanto tempo la protezione anti-glitch mantiene l’ultima posa completa valida dopo aver respinto un salto di tracking.',
    'Adds extra torso rotation smoothing when movement is small. It does not alter hips translation.':'Aggiunge smoothing alla rotazione del torso quando il movimento è ridotto. Non modifica la traslazione del bacino.',
    'Body stabilization is off':'Stabilizzazione corpo disattivata',
    'Classic output · recommended':'Output classico · consigliato',
    'Classic output':'Output classico',
    'Classic compositor (recommended)':'Compositore classico (consigliato)',
    'XR SETTINGS contains native controls that are not duplicated in the right panel. The original XR Animator shell stays hidden while useful controls remain available here.':'XR SETTINGS contiene i controlli nativi non duplicati nel pannello a destra. L’interfaccia originale di XR Animator resta nascosta, mentre i comandi utili rimangono disponibili qui.',
    'Native settings are available directly in this panel without opening XR Animator speech-bubble menus.':'Le impostazioni native sono disponibili direttamente in questo pannello, senza aprire i menu a fumetto di XR Animator.'
  });

  function systemLanguage() {
    const raw = String(navigator.language || 'en');
    if (/^pt/i.test(raw)) return 'pt-BR';
    if (/^zh/i.test(raw)) return 'zh-CN';
    const short = raw.split('-')[0].toLowerCase();
    return LANGUAGES.some(([code]) => code === short) ? short : 'en';
  }

  function language() {
    const wanted = config.ui?.language || 'auto';
    return wanted === 'auto' ? systemLanguage() : wanted;
  }

  function t(source) {
    source = String(source ?? '');
    const lang = language();
    if (lang === 'en') return source;
    const direct = D[lang]?.[source];
    if (direct) return direct;
    const cut = source.indexOf(' ');
    if (cut > 0) {
      const tail = source.slice(cut + 1);
      const translatedTail = D[lang]?.[tail];
      if (translatedTail) return source.slice(0, cut + 1) + translatedTail;
    }
    return source;
  }

  let translating = false;
  const TARGET = 'button, option, summary, .xra-label, .xra-sub, .xra-note, .xra-start-card h2, .xra-start-camera-title';

  function translateElement(node, preserveSource = true) {
    if (!(node instanceof Element) || !node.matches(TARGET)) return;
    if (node.children.length && !node.matches('button, option, summary')) return;
    const current = String(node.textContent || '');
    if (!current.trim()) return;

    let source = node.dataset.xraI18nSource || '';
    const lastRendered = node.dataset.xraI18nLast || '';
    if (!source || !preserveSource) {
      source = current;
    }
    else if (lastRendered && current !== lastRendered) {
      // A refresher changed a dynamic label (for example BODY LIVE -> STABLE).
      // Treat that new text as the new source instead of restoring stale wording
      // on the next language switch.
      source = current;
    }
    node.dataset.xraI18nSource = source;
    const translated = t(source);
    node.dataset.xraI18nLast = translated;
    if (node.textContent !== translated) node.textContent = translated;
  }

  function apply(root = document) {
    translating = true;
    try {
      if (root instanceof Element && root.matches(TARGET)) translateElement(root, true);
      root.querySelectorAll?.(TARGET).forEach(node => translateElement(node, true));
      document.documentElement.lang = language();
    }
    finally { translating = false; }
  }

  function setLanguage(code) {
    if (!LANGUAGES.some(([v]) => v === code)) code = 'auto';
    config.ui ||= {};
    config.ui.language = code;
    events.emit('language', { configured: code, resolved: language() });
    apply(document);
    XRA.profileService.save();
  }

  const observer = new MutationObserver(records => {
    if (translating) return;
    for (const record of records) {
      if (record.type === 'childList') {
        if (record.target instanceof Element) translateElement(record.target, true);
        record.addedNodes.forEach(node => {
          if (node instanceof Element) apply(node);
        });
      }
      else if (record.type === 'characterData' && record.target?.parentElement) {
        translateElement(record.target.parentElement, true);
      }
    }
  });

  const startObserver = () => {
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    apply(document);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();

  events.on('profile-loaded', () => apply(document));

  XRA.i18n = { LANGUAGES, language, systemLanguage, t, setLanguage, apply };
})();
