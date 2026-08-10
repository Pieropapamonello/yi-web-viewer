'use strict';

(() => {
  const defaults = window.APP_CONFIG || {};
  const gatewayBase = String(defaults.apiBaseUrl || 'https://control.nelloonrender.duckdns.org').replace(/\/$/, '');
  const AUTH_KEY = 'fredi-auth-v2';
  const LAST_USER_KEY = 'fredi-last-user';
  const $ = (id) => document.getElementById(id);
  const player = $('player');

  let auth = safeJson(localStorage.getItem(AUTH_KEY), null);
  let account = null;
  let cameras = [];
  let events = [];
  let preferences = { theme:'dark', cameraView:'focus', workspaceView:'live', compact:false, cameraSort:'custom', favoritesOnly:false };
  let activeId = '';
  let editingId = '';
  let authMode = 'login';
  let searchText = '';
  let hls = null;
  let hlsReconnectTimer = 0;
  let hlsRecoveryAttempts = 0;
  let hlsRecovering = false;
  let lastPlaybackTime = -1;
  let lastPlaybackProgressAt = Date.now();
  let lastStallRecoveryAt = 0;
  let peerConnection = null;
  let whepResourceUrl = '';
  let whepAuthorization = '';
  let streamGeneration = 0;
  let liveTransport = '';
  let mediaRecorder = null;
  let chunks = [];
  let recordingAnimation = 0;
  let recordingStream = null;
  let recordingStartedAt = 0;
  let recordingDestination = 'local';
  let recordingStopTimer = 0;
  let toastTimer = null;
  let deferredInstallPrompt = null;
  let draggedId = '';
  let recordingUrls = [];
  let ptzStep = 12;
  let ptzHold = null;
  let ptzHoldRequest = Promise.resolve(false);
  let ptzReleaseTimer = 0;
  let selectedQuality = 'auto';
  let gestureStart = null;
  let motionTimer = null;
  let previousMotionFrame = null;
  let motionCooldownUntil = 0;
  let suppressMotionUntil = 0;
  let archiveClips = [];
  let selectedArchiveClip = null;
  let archivePlayback = false;
  let archiveSource = 'local';
  let sdRecording = false;
  let sdAvailable = false;
  let sdStorage = { total:0, free:0, max:0, reserve:0 };
  let mediaFilter = 'all';
  let timelineFilter = 'all';
  let timelineSearch = '';
  let mediaViewerClip = null;
  let cloud = null;
  let aiReady = false;
  let personDetector = null;
  let personDetectorPromise = null;
  let notificationDetectionBusy = false;
  let notificationCooldownUntil = 0;
  let trackingEnabled = false;
  let trackingStarting = false;
  let trackingTimer = 0;
  let trackingDetections = [];
  let trackingTarget = null;
  let trackingMisses = 0;
  let trackingCommandInFlight = false;
  let trackingLastCommandAt = 0;
  let trackingLastVideoTime = -1;
  let trackingFrameCanvas = null;
  let trackingFrameContext = null;
  let trackingInferenceDelay = 900;
  let trackingSlowInferences = 0;
  const healthByCamera = new Map();
  let streamConnectStarted = 0;
  let talkStream = null;
  let talkContext = null;
  let talkProcessor = null;
  let talkSamples = [];
  let talkQueue = Promise.resolve();
  let talking = false;
  let talkRequested = false;
  let talkSessionStarted = false;
  let deviceFeatures = {};
  let deviceState = { light:'unknown', nightVision:'unknown', alarm:'unknown', tracking:'unknown', zoom:'stop', sdRecording:'unknown' };
  let deviceActionBusy = false;
  let zoomStopRequested = false;

  function safeJson(value, fallback) {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
  }

  function icon(name) {
    return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  function toast(message, type = '') {
    const node = $('toast');
    node.textContent = message;
    node.className = `toast show ${type}`.trim();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = 'toast'; }, 3800);
  }

  function setLoading(show, text = 'Sincronizzazione vault…') {
    $('loadingOverlay').hidden = !show;
    $('loadingOverlay').querySelector('p').textContent = text;
  }

  function setConnection(state, text) {
    $('connectionPill').className = `connection-pill ${state || ''}`.trim();
    $('statusText').textContent = text;
  }

  function authHeaders(extra = {}) {
    return auth?.token ? { ...extra, Authorization:`Bearer ${auth.token}` } : extra;
  }

  async function fetchGateway(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      return await fetch(`${gatewayBase}${path}`, {
        ...options,
        cache:'no-store',
        signal:controller.signal,
      });
    } catch (error) {
      const unavailable = new Error('Gateway domestico non raggiungibile. Verifica che il PC, Docker Desktop e l\'inoltro HTTPS della porta 443 siano attivi, poi riprova.');
      unavailable.cause = error;
      throw unavailable;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function gatewayFetch(path, options = {}) {
    const response = await fetchGateway(path, {
      ...options,
      headers:authHeaders(options.headers || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && result.error === 'Unauthorized' && !path.startsWith('/api/auth/')) {
      logout(false);
      throw new Error('Sessione scaduta. Accedi nuovamente.');
    }
    if (!response.ok) throw new Error(result.detail || result.error || `Errore gateway (${response.status})`);
    return result;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const register = mode === 'register';
    $('authEyebrow').textContent = register ? 'Registrazione pubblica' : 'Bentornato';
    document.querySelector('label[for="loginUsername"]').textContent = register ? 'Username' : 'Username o email';
    $('authTitle').textContent = register ? 'Crea il tuo spazio' : 'Accedi al tuo spazio';
    $('authSubtitle').textContent = register ? 'Il tuo vault sarà separato da quello degli altri utenti.' : 'Inserisci username o email e la tua password.';
    $('registerEmailField').hidden = !register;
    $('registerConfirmField').hidden = !register;
    $('termsRow').hidden = !register;
    $('registerEmail').required = register;
    $('registerConfirm').required = register;
    $('termsInput').required = register;
    $('loginPassword').autocomplete = register ? 'new-password' : 'current-password';
    $('passwordMeter').hidden = !register;
    $('loginButton').textContent = register ? 'Crea account' : 'Accedi';
    $('authModeButton').textContent = register ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati';
    $('loginError').textContent = '';
  }

  function updatePasswordMeter() {
    const password = $('loginPassword').value;
    let strength = 0;
    if (password.length >= 12) strength += 35;
    if (password.length >= 16) strength += 20;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) strength += 15;
    if (/\d/.test(password)) strength += 15;
    if (/[^A-Za-z0-9]/.test(password)) strength += 15;
    const level = strength < 35 ? 0 : strength < 55 ? 25 : strength < 75 ? 50 : strength < 95 ? 75 : 100;
    $('passwordMeter').className = `password-meter strength-${level}`;
    $('passwordMeter').querySelector('span').textContent = strength < 50 ? 'Debole: usa almeno 12 caratteri' : strength < 80 ? 'Buona password' : 'Password robusta';
  }

  async function submitAuth(event) {
    event.preventDefault();
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const button = $('loginButton');
    $('loginError').textContent = '';
    if (authMode === 'register') {
      if (!$('termsInput').checked) return void ($('loginError').textContent = 'Accetta le condizioni di archiviazione per continuare.');
      if (password.length < 12) return void ($('loginError').textContent = 'La password deve contenere almeno 12 caratteri.');
      if (password !== $('registerConfirm').value) return void ($('loginError').textContent = 'Le password non coincidono.');
    }
    button.disabled = true;
    button.textContent = authMode === 'register' ? 'Creazione account…' : 'Accesso…';
    try {
      const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload = authMode === 'register' ? { username, email:$('registerEmail').value.trim(), password } : { username, password };
      const response = await fetchGateway(path, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Accesso non riuscito.');
      auth = { token:result.token, expiresAt:result.expiresAt };
      account = result.account;
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      localStorage.setItem(LAST_USER_KEY, username);
      $('loginPassword').value = '';
      $('registerConfirm').value = '';
      await enterDashboard();
    } catch (error) {
      $('loginError').textContent = translateError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = authMode === 'register' ? 'Crea account' : 'Accedi';
    }
  }

  function translateError(message) {
    const translations = {
      'Invalid username or password':'Username/email o password non validi.',
      'Username already registered':'Username già registrato.',
      'Email already registered':'Email già registrata.',
      'Too many login attempts. Try again later.':'Troppi tentativi. Riprova più tardi.',
      'Too many registrations. Try again later.':'Troppe registrazioni dalla rete. Riprova più tardi.',
      'Failed to fetch':'Gateway domestico non raggiungibile. Verifica che il PC, Docker Desktop e l\'inoltro HTTPS della porta 443 siano attivi, poi riprova.',
    };
    return translations[message] || message;
  }

  async function enterDashboard() {
    setLoading(true, 'Apertura del vault…');
    try {
      const session = await gatewayFetch('/api/auth/session');
      account = session.account;
      auth.expiresAt = session.expiresAt;
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      const vault = await gatewayFetch('/api/cameras');
      cameras = Array.isArray(vault.cameras) ? vault.cameras : [];
      events = Array.isArray(vault.events) ? vault.events : [];
      preferences = { ...preferences, ...(vault.preferences || {}) };
      const migrated = migrateLegacyCamera();
      if (!cameras.length && migrated) {
        cameras = [migrated];
        await persistCameras('Configurazione precedente importata.');
      }
      activeId = cameras.some((camera) => camera.id === activeId) ? activeId : cameras[0]?.id || '';
      applyPreferences();
      renderAccount();
      renderAll();
      $('authGate').hidden = true;
      $('appShell').hidden = false;
      setConnection('', 'Vault sincronizzato');
      const cloudResult = new URLSearchParams(location.search).get('cloud');
      if (cloudResult) {
        history.replaceState({}, '', location.pathname);
        if (cloudResult === 'dropbox-connected') toast('Dropbox collegato correttamente.', 'success');
        else toast(cloudResult === 'dropbox-expired' ? 'Collegamento Dropbox scaduto: riprova.' : 'Collegamento Dropbox non riuscito.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  function migrateLegacyCamera() {
    const legacyText = localStorage.getItem('camera-control-v2');
    if (!legacyText) return null;
    const legacy = safeJson(legacyText, {});
    localStorage.removeItem('camera-control-v2');
    return {
      id:crypto.randomUUID(), name:legacy.cameraName || 'Camera importata', model:'Configurazione precedente',
      streamUrl:legacy.streamUrl || '', streamUsername:legacy.streamUsername || '', streamPassword:sessionStorage.getItem('camera-stream-password') || '',
      apiBaseUrl:legacy.apiBaseUrl || '', apiToken:sessionStorage.getItem('camera-api-token') || '', ptz:Boolean(legacy.apiBaseUrl),
    };
  }

  function logout(showMessage = true) {
    disconnectStream();
    auth = null; account = null; cameras = []; events = []; activeId = '';
    localStorage.removeItem(AUTH_KEY);
    $('appShell').hidden = true;
    $('authGate').hidden = false;
    $('accountDialog').open && $('accountDialog').close();
    if (showMessage) $('loginError').textContent = 'Sessione chiusa correttamente.';
  }

  function renderAccount() {
    const initial = account.username.slice(0, 1).toUpperCase();
    $('accountInitial').textContent = initial;
    $('accountName').textContent = account.username;
    $('profileInitial').textContent = initial;
    $('profileUsername').textContent = account.username;
    $('profileEmail').textContent = account.email;
    $('welcomeTitle').textContent = `Ciao ${account.username}, tutto sotto controllo.`;
  }

  function filteredCameras() {
    let result = cameras.filter((camera) => !preferences.favoritesOnly || camera.favorite);
    if (searchText) result = result.filter((camera) => `${camera.name} ${camera.model} ${camera.location || ''} ${camera.notes || ''}`.toLowerCase().includes(searchText));
    if (preferences.cameraSort === 'name') result = [...result].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity:'base' }));
    if (preferences.cameraSort === 'location') result = [...result].sort((a, b) => (a.location || '').localeCompare(b.location || '', 'it', { sensitivity:'base' }) || a.name.localeCompare(b.name, 'it'));
    return result;
  }

  function currentCamera() {
    return cameras.find((camera) => camera.id === activeId) || null;
  }

  function applyOrientation(camera = currentCamera()) {
    const rotated = camera?.rotation === 180;
    const zoom = Math.min(4, Math.max(1, Number(camera?.digitalZoom) || 1));
    player.classList.remove('rotated');
    player.style.transform = `${rotated ? 'rotate(180deg) ' : ''}scale(${zoom})`;
    $('zoomReset').textContent = `${zoom.toFixed(zoom % 1 ? 1 : 0)}x`;
    $('orientationState').textContent = rotated ? 'Ruotata 180°' : 'Normale';
    $('rotateButton').classList.toggle('active', rotated);
  }

  async function setDigitalZoom(value) {
    const camera = currentCamera(); if (!camera) return;
    camera.digitalZoom = Math.min(4, Math.max(1, Math.round(Number(value) * 4) / 4));
    applyOrientation(camera);
    try { await persistCameras(); } catch (error) { toast(error.message, 'error'); }
  }

  function updateNotificationControls(camera = currentCamera()) {
    const enabled = Boolean(camera?.notificationsEnabled);
    $('notificationMaster').classList.toggle('active', enabled);
    $('notificationMaster').setAttribute('aria-pressed', String(enabled));
    $('notificationMaster').textContent = enabled ? 'Disattiva' : 'Attiva';
    $('notifyPerson').checked = camera?.notifyPerson !== false;
    $('notifyAnimal').checked = camera?.notifyAnimal !== false;
    $('notifyVehicle').checked = camera?.notifyVehicle !== false;
    $('notificationHint').textContent = enabled ? 'Monitoraggio attivo: gli avvisi selezionati sono abilitati.' : 'Gli avvisi di questa camera sono disattivati.';
  }

  async function toggleNotifications() {
    const camera = currentCamera(); if (!camera) return;
    if (!camera.notificationsEnabled && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return toast('Autorizza le notifiche nelle impostazioni del browser.', 'error');
    }
    camera.notificationsEnabled = !camera.notificationsEnabled;
    updateNotificationControls(camera);
    try { await persistCameras(); toast(camera.notificationsEnabled ? 'Notifiche intelligenti attivate.' : 'Notifiche disattivate.', 'success'); }
    catch (error) { camera.notificationsEnabled = !camera.notificationsEnabled; updateNotificationControls(camera); toast(error.message, 'error'); }
  }

  async function saveNotificationTypes() {
    const camera = currentCamera(); if (!camera) return;
    camera.notifyPerson = $('notifyPerson').checked; camera.notifyAnimal = $('notifyAnimal').checked; camera.notifyVehicle = $('notifyVehicle').checked;
    try { await persistCameras(); } catch (error) { toast(error.message, 'error'); }
  }

  async function toggleOrientation() {
    const camera = currentCamera(); if (!camera) return;
    camera.rotation = camera.rotation === 180 ? 0 : 180;
    applyOrientation(camera);
    try { await persistCameras(); toast(`Prospettiva ${camera.rotation === 180 ? 'ruotata' : 'normale'}.`, 'success'); }
    catch (error) { camera.rotation = camera.rotation === 180 ? 0 : 180; applyOrientation(camera); toast(error.message, 'error'); }
  }

  async function shareCurrentCamera() {
    const camera = currentCamera(); if (!camera) return;
    const data = { title:`${camera.name} · FREDI Control`, text:'Apri FREDI Control. Le credenziali della camera non sono incluse.', url:location.origin };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); toast('Link app copiato. Nessuna credenziale condivisa.', 'success'); }
    } catch (error) { if (error.name !== 'AbortError') toast('Condivisione non disponibile.', 'error'); }
  }

  async function toggleFavorite() {
    const camera = currentCamera(); if (!camera) return;
    camera.favorite = !camera.favorite;
    $('favoriteCurrent').classList.toggle('active', camera.favorite);
    renderSwitcher(); renderGrid();
    try { await persistCameras(); toast(camera.favorite ? 'Camera aggiunta ai preferiti.' : 'Camera rimossa dai preferiti.', 'success'); }
    catch (error) { camera.favorite = !camera.favorite; renderAll(); toast(error.message, 'error'); }
  }

  async function recordActivity(type, title, detail) {
    try {
      const result = await gatewayFetch('/api/events', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ type, title, detail }) });
      events = result.events || events; renderEvents();
    } catch { /* Operational actions must not fail because timeline sync failed. */ }
  }

  function updateDeviceControls() {
    const labels = { off:'Spenta', on:'Accesa', auto:'Automatica', unknown:'Stato da leggere' };
    const configure = (id, value, enabled, activeValue = 'on') => {
      const button = $(id); if (!button) return;
      button.disabled = !enabled || deviceActionBusy;
      button.classList.toggle('active', enabled && value === activeValue);
      button.querySelector('small').textContent = enabled ? (labels[value] || value) : 'Non configurata';
    };
    configure('lightFeature', deviceState.light, deviceFeatures.light);
    configure('nightVisionFeature', deviceState.nightVision, deviceFeatures.nightVision);
    configure('guardFeature', deviceState.alarm, deviceFeatures.guard);
    if (deviceFeatures.guardMomentary) {
      $('guardFeature').classList.remove('active');
      $('guardFeature').querySelector('small').textContent = 'Riproduci allarme';
    }
    configure('nativeTrackingFeature', deviceState.tracking, deviceFeatures.nativeTracking);
    $('opticalZoom').hidden = !deviceFeatures.opticalZoom;
    $('opticalZoom').querySelectorAll('button').forEach((button) => { button.disabled = !deviceFeatures.opticalZoom || deviceActionBusy; });
    $('nativeSdMode').disabled = !deviceFeatures.nativeSdRecording || deviceActionBusy;
    if (['off', 'continuous', 'event'].includes(deviceState.sdRecording)) $('nativeSdMode').value = deviceState.sdRecording;
  }

  async function deviceFetch(path, options = {}) {
    const camera = currentCamera();
    if (!camera?.apiBaseUrl || !camera.apiToken) throw new Error('Gateway dispositivo non configurato.');
    const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}${path}`, {
      cache:'no-store',
      ...options,
      headers:{ ...(options.headers || {}), Authorization:`Bearer ${camera.apiToken}` },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || result.error || 'Comando dispositivo rifiutato');
    return result;
  }

  async function loadDeviceState(cameraId) {
    if (!Object.values(deviceFeatures).some(Boolean)) return updateDeviceControls();
    try {
      const result = await deviceFetch('/api/device/state');
      if (cameraId !== activeId) return;
      deviceFeatures = { ...deviceFeatures, ...(result.features || {}) };
      deviceState = { ...deviceState, ...(result.state || {}) };
    } catch { /* Capabilities stay usable; state remains explicitly unknown. */ }
    updateDeviceControls();
  }

  async function sendDeviceAction(feature, value, quiet = false) {
    if (deviceActionBusy) return;
    deviceActionBusy = true; updateDeviceControls();
    try {
      const result = await deviceFetch('/api/device/action', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ feature, value }) });
      deviceState = { ...deviceState, ...(result.state || {}), ...(value === 'trigger' ? {} : { [feature]:value }) };
      if (!quiet) toast(value === 'trigger' ? 'Allarme inviato alla camera.' : `${feature}: ${value}. Comando confermato dalla camera.`, 'success');
      recordActivity('device', 'Comando dispositivo', `${feature}: ${value}`);
      return result;
    } catch (error) {
      if (!quiet) toast(error.message, 'error');
      throw error;
    } finally { deviceActionBusy = false; updateDeviceControls(); }
  }

  function cycleDeviceFeature(feature) {
    if (feature === 'alarm' && deviceFeatures.guardMomentary) {
      return sendDeviceAction('alarm', 'trigger').catch(() => {});
    }
    if (feature === 'light' || feature === 'nightVision') {
      const supportsAuto = feature === 'light' ? deviceFeatures.lightAuto : deviceFeatures.nightVisionAuto;
      const values = supportsAuto ? ['off', 'on', 'auto'] : ['off', 'on'];
      const current = values.indexOf(deviceState[feature]);
      return sendDeviceAction(feature, values[(current + 1) % values.length]).catch(() => {});
    }
    return sendDeviceAction(feature, deviceState[feature] === 'on' ? 'off' : 'on').catch(() => {});
  }

  async function sendOpticalZoom(value) {
    if (!deviceFeatures.opticalZoom) return;
    if (value === 'stop' && deviceActionBusy) { zoomStopRequested = true; return; }
    try { await sendDeviceAction('zoom', value, value === 'stop'); }
    catch { return; }
    if (value !== 'stop' && zoomStopRequested) {
      zoomStopRequested = false;
      sendDeviceAction('zoom', 'stop', true).catch(() => {});
    }
  }

  function changeNativeSdMode() {
    const previous = deviceState.sdRecording;
    sendDeviceAction('sdRecording', $('nativeSdMode').value).catch(() => { if (['off', 'continuous', 'event'].includes(previous)) $('nativeSdMode').value = previous; });
  }

  async function loadCapabilities(camera) {
    $('capabilityState').textContent = 'Verifica…';
    $('talkFeature').disabled = true;
    $('talkFeature').querySelector('small').textContent = 'Verifica gateway';
    deviceFeatures = {}; deviceState = { light:'unknown', nightVision:'unknown', alarm:'unknown', tracking:'unknown', zoom:'stop', sdRecording:'unknown' }; updateDeviceControls();
    if (!camera?.apiBaseUrl || !camera.apiToken) { $('capabilityState').textContent = 'Locale'; return; }
    try {
      const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/capabilities`, { cache:'no-store', headers:{ Authorization:`Bearer ${camera.apiToken}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gateway non raggiungibile');
      $('capabilityState').textContent = result.protocol === 'ipc365-local' ? 'IPC365' : 'Gateway';
      $('talkFeature').disabled = !result.features?.talk;
      $('talkFeature').querySelector('small').textContent = result.features?.talk ? 'Tieni premuto per parlare' : 'Non disponibile';
      $('capabilityHint').textContent = result.features?.talk ? 'Live, audio, PTZ, snapshot, registrazione e audio bidirezionale disponibili.' : 'Live, PTZ, snapshot e registrazione disponibili. Il microfono dipende dal driver della camera.';
      deviceFeatures = result.features || {}; updateDeviceControls(); loadDeviceState(camera.id);
      const sdReady = Boolean(result.features?.sdPlayback); sdAvailable = sdReady;
      $('sdSource').disabled = !sdReady; $('sdRecordToggle').disabled = !sdReady; $('sdRefresh').disabled = !sdReady; $('sdRetention').disabled = !sdReady; $('sdSnapshotStore').disabled = !sdReady;
      $('sdRecordingState').textContent = sdReady ? 'Pronta' : 'Non disponibile';
    } catch { $('capabilityState').textContent = 'Non verificato'; }
  }

  function encodePcm(samples) {
    const bytes = new Uint8Array(samples.length * 2); const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => view.setInt16(index * 2, Math.max(-32768, Math.min(32767, sample)), true));
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function sendTalk(action, pcm = '') {
    const camera = currentCamera();
    if (!camera?.apiBaseUrl || !camera.apiToken) return Promise.reject(new Error('Gateway audio non configurato.'));
    return fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/talk`, { method:'POST', cache:'no-store', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${camera.apiToken}` }, body:JSON.stringify({ action, ...(pcm ? { pcm } : {}) }) }).then(async (response) => {
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.detail || result.error || 'Audio rifiutato'); return result;
    });
  }

  async function startTalking(event) {
    event?.preventDefault(); if (talking || $('talkFeature').disabled) return;
    event?.currentTarget?.setPointerCapture?.(event.pointerId);
    talkRequested = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Il browser non consente l’accesso al microfono. Apri la pagina in HTTPS con Chrome o Safari.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      talkStream = stream;
      if (!talkRequested) { stream.getTracks().forEach((track) => track.stop()); if (talkStream === stream) talkStream = null; return; }
      await sendTalk('start');
      talkSessionStarted = true;
      if (!talkRequested || !stream.getAudioTracks().some((track) => track.readyState === 'live')) { await sendTalk('stop').catch(() => {}); talkSessionStarted = false; stream.getTracks().forEach((track) => track.stop()); if (talkStream === stream) talkStream = null; return; }
      const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
      if (!BrowserAudioContext) throw new Error('Audio in tempo reale non supportato da questo browser.');
      talkContext = new BrowserAudioContext({ latencyHint:'interactive' });
      await talkContext.resume();
      const source = talkContext.createMediaStreamSource(stream);
      talkProcessor = talkContext.createScriptProcessor(2048, 1, 1);
      const inputRate = talkContext.sampleRate; talkSamples = []; talking = true;
      talkProcessor.onaudioprocess = (audioEvent) => {
        if (!talking) return;
        const input = audioEvent.inputBuffer.getChannelData(0); const ratio = inputRate / 8000;
        for (let outputIndex = 0; outputIndex < input.length / ratio; outputIndex += 1) talkSamples.push(Math.round(input[Math.min(input.length - 1, Math.floor(outputIndex * ratio))] * 32767));
        const count = Math.floor(talkSamples.length / 320) * 320;
        if (count >= 320) { const packet = talkSamples.splice(0, count); talkQueue = talkQueue.then(() => sendTalk('data', encodePcm(packet))).catch((error) => toast(error.message, 'error')); }
      };
      source.connect(talkProcessor); talkProcessor.connect(talkContext.destination);
      $('talkFeature').classList.add('active'); $('talkFeature').querySelector('small').textContent = 'Parla ora...'; navigator.vibrate?.(20);
    } catch (error) { stopTalking(); toast(`Microfono: ${error.message}`, 'error'); }
  }

  async function stopTalking() {
    talkRequested = false;
    const hadSession = talkSessionStarted; talkSessionStarted = false; talking = false;
    talkProcessor?.disconnect(); talkProcessor = null; talkStream?.getTracks().forEach((track) => track.stop()); talkStream = null;
    if (talkContext) { await talkContext.close().catch(() => {}); talkContext = null; }
    $('talkFeature').classList.remove('active'); if (!$('talkFeature').disabled) $('talkFeature').querySelector('small').textContent = 'Tieni premuto per parlare';
    if (hadSession) talkQueue = talkQueue.then(() => sendTalk('stop')).catch(() => {});
  }

  async function loadAiStatus() {
    aiReady = false;
    $('aiAnalyze').disabled = true;
    $('aiState').textContent = 'Verifica…';
    try {
      const result = await gatewayFetch('/api/ai/status');
      aiReady = Boolean(result.configured);
      $('aiState').textContent = aiReady ? 'Pronta' : 'Non configurata';
      $('aiAnalyze').disabled = !aiReady;
      if (!aiReady) $('aiResult').innerHTML = '<span>Aggiungi una nuova chiave IA nelle variabili protette del gateway.</span>';
    } catch {
      $('aiState').textContent = 'Non disponibile';
    }
  }

  async function analyzeCurrentFrame() {
    const camera = currentCamera();
    if (!aiReady) return toast('Smart Vision non è configurata sul gateway.', 'error');
    if (!camera || player.readyState < 2 || !player.videoWidth) return toast('Avvia il live prima dell’analisi.', 'error');
    const button = $('aiAnalyze');
    button.disabled = true;
    $('aiState').textContent = 'Analisi…';
    $('aiResult').classList.add('loading');
    $('aiResult').textContent = 'Il modello sta osservando il fotogramma corrente…';
    try {
      const maximumWidth = 960;
      const scale = Math.min(1, maximumWidth / player.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(player.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(player.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (camera.rotation === 180) {
        context.translate(canvas.width, canvas.height);
        context.rotate(Math.PI);
      }
      context.drawImage(player, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', .72);
      const preset = $('aiPromptPreset').value;
      const questions = {
        security:'Controlla la sicurezza della scena: accessi aperti, persone, animali, veicoli, pacchi o possibili anomalie visibili.',
        describe:'Descrivi con precisione la scena e gli elementi realmente visibili.',
        objects:'Conta esclusivamente persone, animali e veicoli chiaramente visibili.',
      };
      const question = preset === 'custom' ? $('aiQuestion').value.trim() : questions[preset];
      if (preset === 'custom' && !question) throw new Error('Scrivi prima una domanda per Smart Vision.');
      const result = await gatewayFetch('/api/ai/analyze', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ cameraId:camera.id, image, question }),
      });
      $('aiResult').textContent = `${result.analysis}\n\nAnalizzato: ${new Date(result.analyzedAt).toLocaleString('it-IT')}`;
      $('aiState').textContent = 'Completata';
      recordActivity('ai', 'Analisi Smart Vision', `${camera.name}: fotogramma analizzato senza archiviare l’immagine.`);
    } catch (error) {
      $('aiState').textContent = 'Errore';
      $('aiResult').textContent = error.message === 'Smart Vision analysis failed' ? 'Il provider IA non ha completato l’analisi. Verifica chiave, credito e modello.' : error.message;
      toast('Analisi IA non riuscita.', 'error');
    } finally {
      $('aiResult').classList.remove('loading');
      button.disabled = !aiReady;
    }
  }

  async function loadPersonDetector() {
    if (personDetector) return personDetector;
    if (personDetectorPromise) return personDetectorPromise;
    personDetectorPromise = (async () => {
      const version = '0.10.35';
      const mediaPipe = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/+esm`);
      const files = await mediaPipe.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/wasm`);
      const options = {
        baseOptions:{ modelAssetPath:'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite', delegate:'GPU' },
        runningMode:'VIDEO', maxResults:8, scoreThreshold:.48,
        categoryAllowlist:['person', 'cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'bear', 'elephant', 'zebra', 'giraffe', 'car', 'motorcycle', 'bus', 'truck'],
      };
      try { personDetector = await mediaPipe.ObjectDetector.createFromOptions(files, options); }
      catch { personDetector = await mediaPipe.ObjectDetector.createFromOptions(files, { ...options, baseOptions:{ ...options.baseOptions, delegate:'CPU' } }); }
      return personDetector;
    })().catch((error) => { personDetectorPromise = null; throw error; });
    return personDetectorPromise;
  }

  function trackingAvailable() {
    const camera = currentCamera();
    return Boolean(camera?.ptz && camera.apiBaseUrl && camera.apiToken && ['WebRTC', 'HLS'].includes(liveTransport) && !archivePlayback && !player.paused && player.readyState >= 2);
  }

  function detectionKind(category) {
    if (category === 'person') return 'person';
    if (['cat','dog','bird','horse','sheep','cow','bear','elephant','zebra','giraffe'].includes(category)) return 'animal';
    if (['car','motorcycle','bus','truck'].includes(category)) return 'vehicle';
    return '';
  }

  async function notifyDetectedObjects() {
    const camera = currentCamera();
    if (!camera?.notificationsEnabled || notificationDetectionBusy || trackingEnabled || trackingStarting || Date.now() < notificationCooldownUntil || player.readyState < 2) return;
    notificationDetectionBusy = true;
    try {
      const detector = await loadPersonDetector();
      const frame = prepareDetectionFrame();
      const result = detector.detectForVideo(frame, performance.now());
      const found = new Set((result?.detections || []).filter((item) => Number(item.categories?.[0]?.score || 0) >= .55).map((item) => detectionKind(item.categories?.[0]?.categoryName || '')).filter(Boolean));
      const selected = [...found].filter((kind) => kind === 'person' ? camera.notifyPerson !== false : kind === 'animal' ? camera.notifyAnimal !== false : camera.notifyVehicle !== false);
      if (!selected.length) return;
      notificationCooldownUntil = Date.now() + 30000;
      const labels = { person:'persona', animal:'animale', vehicle:'veicolo' };
      const detail = selected.map((kind) => labels[kind]).join(', ');
      recordActivity('motion', 'Rilevamento intelligente', `${camera.name}: ${detail}.`);
      const registration = await navigator.serviceWorker?.ready;
      if (registration && Notification.permission === 'granted') await registration.showNotification(`${camera.name}: rilevamento`, { body:`Rilevato: ${detail}`, icon:'./icon.svg', tag:`camera-${camera.id}`, renotify:true, data:{ cameraId:camera.id } });
    } catch (error) { console.warn('Rilevamento notifiche non disponibile:', error); }
    finally { notificationDetectionBusy = false; }
  }

  function updateTrackingAvailability() {
    const button = $('trackingToggle');
    if (trackingEnabled) {
      button.disabled = false; $('trackingHint').textContent = 'Inseguimento attivo · tocca un riquadro';
    } else if (trackingStarting) {
      button.disabled = true; $('trackingHint').textContent = 'Caricamento modello locale…';
    } else {
      const available = trackingAvailable(); button.disabled = !available;
      $('trackingHint').textContent = available ? liveTransport === 'WebRTC' ? 'Pronto · WebRTC a bassa latenza' : 'Pronto su HLS · risposta più lenta' : 'Richiede live video e PTZ';
    }
  }

  function clearTrackingOverlay() {
    trackingDetections = [];
    $('trackingOverlay').replaceChildren();
    $('trackingOverlay').hidden = true;
    $('trackingLiveState').hidden = true;
  }

  function stopPersonTracking(reason = 'Inseguimento disattivato', announce = false) {
    const wasEnabled = trackingEnabled || trackingStarting;
    trackingEnabled = false; trackingStarting = false;
    clearTimeout(trackingTimer); trackingTimer = 0;
    trackingTarget = null; trackingMisses = 0; trackingCommandInFlight = false; trackingLastVideoTime = -1;
    trackingInferenceDelay = 900; trackingSlowInferences = 0;
    clearTrackingOverlay();
    $('trackingToggle').classList.remove('active'); $('trackingToggle').setAttribute('aria-pressed', 'false'); $('trackingToggle').textContent = 'Attiva';
    updateTrackingAvailability();
    if (wasEnabled && announce) toast(reason, 'success');
  }

  async function togglePersonTracking() {
    if (trackingEnabled || trackingStarting) { stopPersonTracking('Inseguimento persona interrotto.', true); return; }
    if (!trackingAvailable()) return toast('Per seguire una persona servono un live attivo e il PTZ configurato.', 'error');
    trackingStarting = true; updateTrackingAvailability(); $('trackingToggle').textContent = 'Caricamento…';
    try {
      await loadPersonDetector();
      if (!trackingStarting || !trackingAvailable()) { stopPersonTracking('Live cambiato durante il caricamento.'); return; }
      trackingStarting = false; trackingEnabled = true; trackingTarget = null; trackingMisses = 0; trackingLastVideoTime = -1;
      trackingInferenceDelay = liveTransport === 'WebRTC' ? 650 : 950; trackingSlowInferences = 0;
      $('trackingToggle').disabled = false; $('trackingToggle').classList.add('active'); $('trackingToggle').setAttribute('aria-pressed', 'true'); $('trackingToggle').textContent = 'Ferma';
      $('trackingLiveState').hidden = false; $('trackingLiveState').querySelector('span').textContent = 'Ricerca persona…';
      updateTrackingAvailability(); recordActivity('ai', 'Inseguimento persona attivato', `${currentCamera().name}: rilevamento locale senza riconoscimento facciale.`);
      schedulePersonTracking(0);
    } catch (error) {
      stopPersonTracking();
      toast(`Modello di inseguimento non disponibile: ${error.message}`, 'error');
    }
  }

  function schedulePersonTracking(delay = trackingInferenceDelay) {
    clearTimeout(trackingTimer);
    if (trackingEnabled) trackingTimer = window.setTimeout(runPersonTracking, delay);
  }

  function prepareDetectionFrame() {
    const videoWidth = player.videoWidth || 640; const videoHeight = player.videoHeight || 360;
    const width = Math.min(384, videoWidth);
    const height = Math.max(1, Math.round(width * videoHeight / videoWidth));
    if (!trackingFrameCanvas) {
      trackingFrameCanvas = document.createElement('canvas');
      trackingFrameContext = trackingFrameCanvas.getContext('2d', { alpha:false });
    }
    if (trackingFrameCanvas.width !== width || trackingFrameCanvas.height !== height) {
      trackingFrameCanvas.width = width; trackingFrameCanvas.height = height;
    }
    trackingFrameContext.drawImage(player, 0, 0, width, height);
    return trackingFrameCanvas;
  }

  function normalizedPeople(result, width = player.videoWidth || 1, height = player.videoHeight || 1) {
    return (result?.detections || []).filter((detection) => detection.categories?.[0]?.categoryName === 'person').map((detection) => {
      const box = detection.boundingBox || {}; const category = detection.categories?.[0] || {};
      const x = Math.max(0, Number(box.originX || 0) / width); const y = Math.max(0, Number(box.originY || 0) / height);
      const w = Math.min(1 - x, Math.max(0, Number(box.width || 0) / width)); const h = Math.min(1 - y, Math.max(0, Number(box.height || 0) / height));
      return { x, y, w, h, cx:x + w / 2, cy:y + h / 2, score:Number(category.score || 0), target:false, view:null };
    }).filter((detection) => detection.w > .02 && detection.h > .04);
  }

  function chooseTrackingTarget(detections) {
    if (!detections.length) return null;
    if (!trackingTarget) return detections.reduce((best, item) => item.w * item.h > best.w * best.h ? item : best);
    const ordered = [...detections].sort((left, right) => Math.hypot(left.cx - trackingTarget.cx, left.cy - trackingTarget.cy) - Math.hypot(right.cx - trackingTarget.cx, right.cy - trackingTarget.cy));
    return Math.hypot(ordered[0].cx - trackingTarget.cx, ordered[0].cy - trackingTarget.cy) < .38 ? ordered[0] : null;
  }

  function renderTrackingDetections(detections, target) {
    const overlay = $('trackingOverlay'); overlay.replaceChildren(); overlay.hidden = false;
    const stageRect = $('stage').getBoundingClientRect();
    const frameWidth = player.videoWidth || 1; const frameHeight = player.videoHeight || 1;
    const scale = Math.min(stageRect.width / frameWidth, stageRect.height / frameHeight);
    const renderedWidth = frameWidth * scale; const renderedHeight = frameHeight * scale;
    const offsetX = (stageRect.width - renderedWidth) / 2; const offsetY = (stageRect.height - renderedHeight) / 2;
    const rotated = currentCamera()?.rotation === 180;
    detections.forEach((detection) => {
      const displayX = rotated ? 1 - detection.x - detection.w : detection.x;
      const displayY = rotated ? 1 - detection.y - detection.h : detection.y;
      detection.view = { left:offsetX + displayX * renderedWidth, top:offsetY + displayY * renderedHeight, width:detection.w * renderedWidth, height:detection.h * renderedHeight };
      const box = document.createElement('div'); box.className = `tracking-box${detection === target ? ' target' : ''}`;
      box.dataset.label = detection === target ? `Seguita · ${Math.round(detection.score * 100)}%` : `Persona · ${Math.round(detection.score * 100)}%`;
      Object.assign(box.style, { left:`${detection.view.left}px`, top:`${detection.view.top}px`, width:`${detection.view.width}px`, height:`${detection.view.height}px` });
      overlay.append(box);
    });
    trackingDetections = detections;
  }

  function selectTrackingTargetAt(clientX, clientY) {
    if (!trackingEnabled) return false;
    const stageRect = $('stage').getBoundingClientRect(); const x = clientX - stageRect.left; const y = clientY - stageRect.top;
    const selected = trackingDetections.filter((item) => item.view && x >= item.view.left && x <= item.view.left + item.view.width && y >= item.view.top && y <= item.view.top + item.view.height).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (!selected) return false;
    trackingTarget = { cx:selected.cx, cy:selected.cy }; trackingMisses = 0;
    toast('Persona selezionata per l’inseguimento.', 'success'); return true;
  }

  function steerTowardPerson(target) {
    const hlsMode = liveTransport === 'HLS';
    if (!target || trackingCommandInFlight || Date.now() - trackingLastCommandAt < (hlsMode ? 720 : 360)) return;
    const deadZones = { relaxed:.18, normal:.13, precise:.09 }; const dead = deadZones[$('trackingSensitivity').value] || .13;
    const effectiveDead = hlsMode ? Math.max(.17, dead) : dead;
    const errorX = target.cx - .5; const errorY = target.cy - .5;
    if (Math.abs(errorX) <= effectiveDead && Math.abs(errorY) <= effectiveDead) { $('trackingLiveState').querySelector('span').textContent = 'Persona centrata'; return; }
    const horizontal = Math.abs(errorX) >= Math.abs(errorY);
    const action = horizontal ? (errorX < 0 ? 'left' : 'right') : (errorY < 0 ? 'up' : 'down');
    const magnitude = horizontal ? Math.abs(errorX) : Math.abs(errorY);
    const step = magnitude > .32 ? 8 : magnitude > .2 ? 5 : 3;
    const durationMs = hlsMode ? (magnitude > .32 ? 150 : magnitude > .2 ? 110 : 80) : (magnitude > .32 ? 180 : magnitude > .2 ? 140 : 100);
    trackingCommandInFlight = true; trackingLastCommandAt = Date.now();
    $('trackingLiveState').querySelector('span').textContent = `Segue · ${action}`;
    sendPtz(action, step, { tracking:true, quiet:true, durationMs }).finally(() => { trackingCommandInFlight = false; });
  }

  function runPersonTracking() {
    if (!trackingEnabled) return;
    if (!trackingAvailable() || document.hidden) { stopPersonTracking('Inseguimento fermato: live non disponibile.', true); return; }
    try {
      if (player.currentTime === trackingLastVideoTime) { schedulePersonTracking(120); return; }
      trackingLastVideoTime = player.currentTime;
      const frame = prepareDetectionFrame();
      const inferenceStarted = performance.now();
      const result = personDetector.detectForVideo(frame, inferenceStarted);
      const inferenceDuration = performance.now() - inferenceStarted;
      const baseDelay = liveTransport === 'WebRTC' ? 650 : 950;
      trackingInferenceDelay = Math.min(3000, Math.max(baseDelay, Math.round(inferenceDuration * 4)));
      trackingSlowInferences = inferenceDuration > 1200 ? trackingSlowInferences + 1 : 0;
      if (trackingSlowInferences >= 2) {
        stopPersonTracking();
        toast('Inseguimento arrestato: il rilevamento locale è troppo lento su questo dispositivo.', 'error');
        return;
      }
      const detections = normalizedPeople(result, frame.width, frame.height); const target = chooseTrackingTarget(detections);
      if (!target) {
        trackingMisses += 1; renderTrackingDetections(detections, null); $('trackingLiveState').querySelector('span').textContent = detections.length ? 'Soggetto perso · tocca una persona' : 'Ricerca persona…';
        if (trackingMisses >= 16) { stopPersonTracking('Persona persa: inseguimento arrestato.', true); return; }
      } else {
        trackingMisses = 0; target.target = true;
        trackingTarget = trackingTarget ? { cx:trackingTarget.cx * .3 + target.cx * .7, cy:trackingTarget.cy * .3 + target.cy * .7 } : { cx:target.cx, cy:target.cy };
        renderTrackingDetections(detections, target); steerTowardPerson(trackingTarget);
      }
    } catch (error) { stopPersonTracking(); toast(`Inseguimento interrotto: ${error.message}`, 'error'); return; }
    schedulePersonTracking();
  }

  function derivedLowStreamUrl(camera) {
    if (camera?.streamLowUrl) return camera.streamLowUrl;
    return String(camera?.streamUrl || '')
      .replace('/ipc365/', '/ipc365-low/')
      .replace('/yi/', '/yi-low/');
  }

  function renderQualityLevels(camera = currentCamera()) {
    const select = $('qualitySelect');
    const low = derivedLowStreamUrl(camera);
    select.innerHTML = '<option value="auto">Auto</option><option value="high">Alta · 1080p</option>';
    if (low && low !== camera?.streamUrl) select.insertAdjacentHTML('beforeend', '<option value="low">Bassa · 480p</option>');
    if (![...select.options].some((option) => option.value === selectedQuality)) selectedQuality = 'auto';
    select.value = selectedQuality;
    select.disabled = select.options.length < 3;
  }

  function renderAll() {
    renderStats();
    renderSwitcher();
    renderGrid();
    renderEvents();
    renderView();
    const camera = currentCamera();
    if (camera) updateFocusedCamera(camera); else showEmptyWorkspace();
  }

  function renderStats() {
    const configured = cameras.filter((camera) => camera.streamUrl).length;
    const ptz = cameras.filter((camera) => camera.ptz && camera.apiBaseUrl && camera.apiToken).length;
    $('statCameras').textContent = cameras.length;
    $('statConfigured').textContent = configured;
    $('statPtz').textContent = ptz;
    const visible = filteredCameras().length;
    $('cameraCountLabel').textContent = visible === cameras.length ? (cameras.length === 1 ? '1 camera nel vault' : `${cameras.length} camere nel vault`) : `${visible} di ${cameras.length} camere visibili`;
    $('activeCameraMetric').textContent = currentCamera()?.name || '—';
    $('cameraSort').value = preferences.cameraSort || 'custom';
    $('favoriteFilter').setAttribute('aria-pressed', String(Boolean(preferences.favoritesOnly)));
    updateStorageEstimate();
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 MB';
    if (value < 1024 ** 3) return `${Math.max(1, Math.round(value / 1024 / 1024))} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  async function updateStorageEstimate() {
    if (!navigator.storage?.estimate) { $('storageMetric').textContent = 'Non disponibile'; return; }
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const percent = quota ? Math.min(100, usage / quota * 100) : 0;
      $('storageMetric').textContent = `${formatBytes(usage)} / ${formatBytes(quota)}`;
      $('recordingStorage').textContent = `${percent.toFixed(0)}% locale`;
      $('storageProgress').style.width = `${percent}%`;
    } catch { $('storageMetric').textContent = 'Non disponibile'; }
  }

  function renderSwitcher() {
    const container = $('cameraSwitcher');
    container.innerHTML = '';
    const visible = filteredCameras();
    for (const camera of visible) {
      const wrap = document.createElement('div');
      wrap.className = `camera-chip-wrap${camera.favorite ? ' favorite' : ''}`;
      wrap.draggable = true;
      wrap.dataset.id = camera.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `camera-chip${camera.id === activeId ? ' active' : ''}`;
      button.innerHTML = `<b>${camera.streamUrl ? '●' : '○'} ${escapeHtml(camera.name)}</b><span>${escapeHtml(camera.location || camera.model || 'Posizione non indicata')}</span>`;
      button.addEventListener('click', () => selectCamera(camera.id));
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'camera-chip-edit'; edit.title = `Modifica ${camera.name}`; edit.innerHTML = icon('edit');
      edit.addEventListener('click', () => openCameraDialog(camera.id));
      bindDrag(wrap);
      wrap.append(button, edit); container.append(wrap);
    }
    if (!visible.length) container.innerHTML = '<div class="filter-empty">Nessuna camera corrisponde ai filtri.</div>';
  }

  function renderGrid() {
    const container = $('gridView');
    container.innerHTML = '';
    const visible = filteredCameras();
    for (const camera of visible) {
      const card = document.createElement('article');
      card.className = `grid-card${camera.favorite ? ' favorite' : ''}`; card.draggable = preferences.cameraSort === 'custom'; card.dataset.id = camera.id;
      card.innerHTML = `<div class="grid-preview">${icon('camera')}</div><div class="grid-card-body"><div class="grid-card-head"><div><h3>${camera.favorite ? '★ ' : ''}${escapeHtml(camera.name)}</h3><p>${escapeHtml(camera.model || 'Modello non indicato')}</p></div><span class="live-badge">${camera.streamUrl ? 'PRONTA' : 'SETUP'}</span></div><p class="grid-location">${icon('pin')}${escapeHtml(camera.location || 'Posizione non indicata')}</p><div class="grid-tags"><span class="tag ${camera.streamUrl ? 'ok' : ''}">${camera.streamUrl ? 'HLS' : 'NO VIDEO'}</span><span class="tag ${camera.ptz && camera.apiToken ? 'ok' : ''}">${camera.ptz ? 'PTZ' : 'SOLO VIDEO'}</span><span class="tag">VAULT</span></div><div class="grid-actions"><button class="button secondary" data-open="${camera.id}">${icon('focus')} Apri</button><button class="button ghost" data-edit="${camera.id}">${icon('edit')} Modifica</button><button class="button ghost" data-copy="${camera.id}" title="Duplica">Copia</button></div></div>`;
      card.querySelector('[data-open]').addEventListener('click', () => { setView('focus'); selectCamera(camera.id); });
      card.querySelector('[data-edit]').addEventListener('click', () => openCameraDialog(camera.id));
      card.querySelector('[data-copy]').addEventListener('click', () => duplicateCamera(camera.id));
      bindDrag(card); container.append(card);
    }
    if (!visible.length) container.innerHTML = '<div class="filter-empty grid-filter-empty">Nessuna camera corrisponde ai filtri attivi.</div>';
  }

  function bindDrag(node) {
    node.addEventListener('dragstart', () => { draggedId = node.dataset.id; });
    node.addEventListener('dragover', (event) => event.preventDefault());
    node.addEventListener('drop', async (event) => {
      event.preventDefault();
      const targetId = node.dataset.id;
      if (!draggedId || draggedId === targetId) return;
      const from = cameras.findIndex((camera) => camera.id === draggedId);
      const to = cameras.findIndex((camera) => camera.id === targetId);
      const [moved] = cameras.splice(from, 1); cameras.splice(to, 0, moved);
      draggedId = ''; renderAll();
      try { await persistCameras('Ordine camere aggiornato.'); } catch (error) { toast(error.message, 'error'); }
    });
  }

  function renderView() {
    const empty = cameras.length === 0;
    $('emptyWorkspace').hidden = !empty;
    $('focusView').hidden = empty || preferences.cameraView !== 'focus';
    $('gridView').hidden = empty || preferences.cameraView !== 'grid';
    $('viewFocus').classList.toggle('active', preferences.cameraView === 'focus');
    $('viewGrid').classList.toggle('active', preferences.cameraView === 'grid');
  }

  function showEmptyWorkspace() {
    disconnectStream();
    $('focusView').hidden = true;
    $('gridView').hidden = true;
    $('emptyWorkspace').hidden = false;
  }

  function selectCamera(id) {
    if (!cameras.some((camera) => camera.id === id)) return;
    activeId = id;
    renderSwitcher();
    updateFocusedCamera(currentCamera());
  }

  function updateFocusedCamera(camera) {
    disconnectStream();
    archiveSource = 'local'; sdRecording = false; sdAvailable = false; sdStorage = { total:0, free:0, max:0, reserve:0 };
    $('sdSource').classList.remove('active'); $('localSource').classList.add('active'); $('sdSource').disabled = true; $('sdRecordToggle').disabled = true; $('sdRefresh').disabled = true; $('sdRetention').disabled = true; $('nativeSdMode').disabled = true; $('sdSnapshotStore').disabled = true; $('sdDeleteClip').disabled = true;
    selectedQuality = 'auto';
    $('cameraName').textContent = camera.name;
    $('cameraMeta').textContent = [camera.model, camera.location].filter(Boolean).join(' · ') || 'Modello e posizione non specificati';
    $('detailVideo').textContent = camera.webrtcUrl || derivedWebRtcUrl(camera) ? 'WebRTC + HLS fallback' : camera.streamUrl ? 'HLS configurato' : 'Non configurato';
    $('detailLocation').textContent = camera.location || 'Non indicata';
    $('detailNotes').textContent = camera.notes || 'Nessuna';
    $('detailPtz').textContent = camera.ptz && camera.apiBaseUrl && camera.apiToken ? 'Attivo' : 'Non configurato';
    $('detailCredentials').textContent = camera.streamUsername ? 'Basic Auth' : 'Nessuna';
    const ptzReady = camera.ptz && camera.apiBaseUrl && camera.apiToken;
    $('ptzState').textContent = ptzReady ? 'Pronto' : 'Non configurato';
    $('favoriteCurrent').classList.toggle('active', Boolean(camera.favorite));
    $('favoriteCurrent').title = camera.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
    const health = healthByCamera.get(camera.id);
    $('healthBadge').className = `health-badge${health?.ok ? ' ok' : health ? ' error' : ''}`;
    $('healthBadge').textContent = health?.ok ? `${health.latency} MS` : health ? 'ERRORE' : 'NON VERIFICATA';
    $('detailHealth').textContent = health ? new Date(health.checkedAt).toLocaleTimeString('it-IT') : '—';
    $('healthMetric').textContent = health ? new Date(health.checkedAt).toLocaleTimeString('it-IT') : '—';
    $('activeCameraMetric').textContent = camera.name;
    $('operationsTitle').textContent = health?.ok ? 'Sistema operativo' : health ? 'Controllo richiesto' : 'Sistema in osservazione';
    $('operationsDetail').textContent = health?.ok ? `${camera.name} raggiungibile` : health ? `${camera.name} non raggiungibile` : `Avvio monitoraggio di ${camera.name}`;
    document.querySelectorAll('[data-ptz]').forEach((button) => { button.disabled = !ptzReady; });
    updateTrackingAvailability();
    applyOrientation(camera);
    updateNotificationControls(camera);
    loadCapabilities(camera);
    loadRecordings(camera.id);
    loadArchive(camera.id);
    loadCloudStatus();
    loadAiStatus();
    renderQualityLevels(camera);
    if (camera.streamUrl) connectStream(camera); else offline('Sorgente video non configurata.', 'Apri le impostazioni e inserisci un URL HLS HTTPS.');
  }

  function setVideoLoading(show) {
    $('videoLoading').hidden = !show;
  }

  function disconnectStream() {
    streamGeneration += 1;
    clearTimeout(hlsReconnectTimer);
    hlsReconnectTimer = 0;
    hlsRecoveryAttempts = 0;
    hlsRecovering = false;
    lastPlaybackTime = -1;
    lastPlaybackProgressAt = Date.now();
    lastStallRecoveryAt = 0;
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    stopPersonTracking();
    stopMotionDetection();
    hls?.destroy(); hls = null;
    stopWebRtc();
    player.pause(); player.srcObject = null; player.removeAttribute('src'); player.load();
    liveTransport = '';
    $('stage').classList.remove('playing', 'archive');
    $('cameraStatusDot').classList.remove('live');
    $('liveTag').className = 'live-badge'; $('liveTag').textContent = 'OFFLINE';
    setVideoLoading(false);
    updateTrackingAvailability();
  }

  function connectStream(camera) {
    archivePlayback = false;
    const generation = ++streamGeneration;
    streamConnectStarted = performance.now();
    setVideoLoading(true);
    $('emptyTitle').textContent = 'Connessione in corso';
    $('emptyText').textContent = 'Il gateway sta preparando il flusso live.';
    const webrtcUrl = camera.webrtcUrl || derivedWebRtcUrl(camera);
    if (selectedQuality === 'auto' && webrtcUrl && window.RTCPeerConnection) {
      connectWebRtc(camera, webrtcUrl, generation).catch((error) => {
        if (generation !== streamGeneration) return;
        console.warn('WebRTC non disponibile, fallback HLS:', error);
        stopWebRtc();
        connectHls(camera, generation);
      });
      return;
    }
    connectHls(camera, generation);
  }

  function derivedWebRtcUrl(camera) {
    if (!camera?.streamUrl) return '';
    try {
      const url = new URL(camera.streamUrl);
      if (url.hostname === 'camera.nelloonrender.duckdns.org') {
        url.hostname = 'rtc.nelloonrender.duckdns.org';
        const stream = url.pathname.split('/').filter(Boolean)[0]?.replace(/-low$/, '') || 'ipc365';
        url.pathname = `/${stream}-webrtc/whep`;
        url.search = '';
        return url.toString();
      }
    } catch { /* custom HLS URL: WebRTC must be entered manually */ }
    return '';
  }

  function basicAuthorization(camera) {
    return camera.streamUsername && camera.streamPassword ? `Basic ${btoa(unescape(encodeURIComponent(`${camera.streamUsername}:${camera.streamPassword}`)))}` : '';
  }

  function waitForIceGathering(connection, timeout = 2500) {
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { connection.removeEventListener('icegatheringstatechange', changed); clearTimeout(timer); resolve(); };
      const changed = () => { if (connection.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, timeout);
      connection.addEventListener('icegatheringstatechange', changed);
    });
  }

  async function connectWebRtc(camera, url, generation) {
    const connection = new RTCPeerConnection();
    peerConnection = connection;
    liveTransport = 'WebRTC';
    const media = new MediaStream();
    player.srcObject = media;
    connection.addTransceiver('video', { direction:'recvonly' });
    connection.addTransceiver('audio', { direction:'recvonly' });
    connection.addEventListener('track', (event) => {
      if (generation !== streamGeneration) return;
      if (!media.getTracks().some((track) => track.id === event.track.id)) media.addTrack(event.track);
      player.play().catch(() => { setVideoLoading(false); toast('Tocca il video per avviare il live.'); });
    });
    connection.addEventListener('connectionstatechange', () => {
      if (generation !== streamGeneration) return;
      if (connection.connectionState === 'failed') {
        stopWebRtc();
        connectHls(camera, generation);
      }
    });
    await connection.setLocalDescription(await connection.createOffer());
    await waitForIceGathering(connection);
    if (generation !== streamGeneration) return;
    const authorization = basicAuthorization(camera);
    whepAuthorization = authorization;
    const response = await fetch(url, {
      method:'POST', cache:'no-store',
      headers:{ 'Content-Type':'application/sdp', ...(authorization ? { Authorization:authorization } : {}) },
      body:connection.localDescription.sdp,
    });
    if (!response.ok) throw new Error(`WHEP ${response.status}`);
    const answer = await response.text();
    const location = response.headers.get('Location');
    whepResourceUrl = location ? new URL(location, url).toString() : '';
    await connection.setRemoteDescription({ type:'answer', sdp:answer });
    setTimeout(() => {
      if (generation === streamGeneration && connection.connectionState !== 'connected') {
        stopWebRtc();
        connectHls(camera, generation);
      }
    }, 6000);
  }

  function stopWebRtc() {
    const resource = whepResourceUrl;
    const authorization = whepAuthorization;
    const connection = peerConnection;
    whepResourceUrl = '';
    whepAuthorization = '';
    peerConnection = null;
    connection?.close();
    if (resource) fetch(resource, { method:'DELETE', keepalive:true, headers:authorization ? { Authorization:authorization } : {} }).catch(() => {});
  }

  function connectHls(camera, generation = streamGeneration) {
    if (generation !== streamGeneration) return;
    clearTimeout(hlsReconnectTimer);
    hlsReconnectTimer = 0;
    hls?.destroy();
    hls = null;
    liveTransport = 'HLS';
    player.srcObject = null;
    const authorization = basicAuthorization(camera);
    const sourceUrl = selectedQuality === 'low' ? derivedLowStreamUrl(camera) : camera.streamUrl;
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode:true,
        liveSyncDurationCount:2,
        liveMaxLatencyDurationCount:10,
        maxLiveSyncPlaybackRate:1.5,
        maxBufferLength:12,
        maxMaxBufferLength:24,
        backBufferLength:12,
        manifestLoadingMaxRetry:6,
        manifestLoadingRetryDelay:500,
        manifestLoadingMaxRetryTimeout:5000,
        levelLoadingMaxRetry:6,
        levelLoadingRetryDelay:500,
        fragLoadingMaxRetry:6,
        fragLoadingRetryDelay:500,
        xhrSetup:(xhr) => { if (authorization) xhr.setRequestHeader('Authorization', authorization); },
      });
      hls.loadSource(sourceUrl); hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation !== streamGeneration) return;
        hlsRecoveryAttempts = 0;
        hlsRecovering = false;
        renderQualityLevels(camera);
        player.play().catch(() => { setVideoLoading(false); toast('Tocca il video per avviare il live.'); });
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || generation !== streamGeneration) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRecoveryAttempts < 2) {
          hlsRecoveryAttempts += 1;
          hlsRecovering = true;
          hls?.recoverMediaError();
          return;
        }
        scheduleHlsReconnect(camera, generation, data.details || data.type);
      });
    } else if (player.canPlayType('application/vnd.apple.mpegurl') && !authorization) {
      player.src = sourceUrl; player.play().catch(() => setVideoLoading(false));
    } else {
      setVideoLoading(false); offline('HLS autenticato non supportato.', 'Prova un browser compatibile con hls.js.');
    }
  }

  function scheduleHlsReconnect(camera, generation, reason = 'stream interrupted') {
    if (generation !== streamGeneration || archivePlayback || hlsReconnectTimer) return;
    hlsRecovering = true;
    hlsRecoveryAttempts += 1;
    const delay = Math.min(6000, 500 * (2 ** Math.min(4, hlsRecoveryAttempts - 1)));
    console.warn(`HLS interrotto (${reason}); nuovo tentativo tra ${delay} ms`);
    hls?.destroy();
    hls = null;
    setVideoLoading(true);
    $('liveTag').className = 'live-badge';
    $('liveTag').textContent = 'RIPRISTINO';
    $('emptyTitle').textContent = 'Riconnessione automatica';
    $('emptyText').textContent = 'La telecamera ha interrotto brevemente il flusso. Riprovo senza interventi.';
    hlsReconnectTimer = setTimeout(() => {
      hlsReconnectTimer = 0;
      if (generation === streamGeneration) connectHls(camera, generation);
    }, delay);
  }

  function notePlaybackProgress() {
    if (Math.abs(player.currentTime - lastPlaybackTime) < .02) return;
    lastPlaybackTime = player.currentTime;
    lastPlaybackProgressAt = Date.now();
  }

  function recoverStalledPlayback() {
    if (archivePlayback || document.hidden || player.paused || !$('stage').classList.contains('playing')) return;
    const now = Date.now();
    if (now - lastPlaybackProgressAt < 5000 || now - lastStallRecoveryAt < 7000) return;
    const camera = currentCamera();
    if (!camera) return;
    lastStallRecoveryAt = now;
    if (liveTransport === 'WebRTC') {
      console.warn('WebRTC fermo: passaggio automatico al flusso HLS di continuità.');
      stopWebRtc();
      connectHls(camera, streamGeneration);
      return;
    }
    scheduleHlsReconnect(camera, streamGeneration, 'watchdog: fotogrammi fermi');
  }

  function offline(title, detail) {
    stopPersonTracking();
    $('stage').classList.remove('playing');
    $('emptyTitle').textContent = title;
    $('emptyText').textContent = detail;
    $('liveTag').className = 'live-badge'; $('liveTag').textContent = 'OFFLINE';
    $('cameraStatusDot').classList.remove('live');
  }

  function renderEvents() {
    const container = $('events');
    if (!events.length) container.innerHTML = '<div class="recording-empty"><p>Nessuna attività recente.</p></div>';
    else container.innerHTML = events.slice(0, 8).map((item) => {
        const date = new Date(item.createdAt);
        return `<div class="event-row"><i class="event-dot ${escapeHtml(item.type)}"></i><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div><time title="${escapeHtml(date.toLocaleString('it-IT'))}">${escapeHtml(relativeTime(date))}</time></div>`;
      }).join('');
    renderPlaybackTimeline();
  }

  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function renderPlaybackTimeline() {
    const rail = $('timelineRail');
    if (!rail) return;
    const selected = $('timelineDate').value || localDateKey();
    const cameraName = currentCamera()?.name?.toLowerCase() || '';
    const dayEventsAll = events.filter((item) => localDateKey(new Date(item.createdAt)) === selected && (!cameraName || `${item.title} ${item.detail}`.toLowerCase().includes(cameraName) || !item.detail));
    const dayEvents = dayEventsAll.filter((item) => {
      const haystack = `${item.title} ${item.detail}`.toLowerCase();
      const matchesSearch = !timelineSearch || haystack.includes(timelineSearch);
      const type = String(item.type || '').toLowerCase();
      const matchesType = timelineFilter === 'all' || (timelineFilter === 'motion' && /motion|movimento|detect/.test(`${type} ${haystack}`)) || (timelineFilter === 'ai' && /ai|analisi|rilev/.test(`${type} ${haystack}`)) || (timelineFilter === 'clip' && /clip|snapshot|registr/.test(`${type} ${haystack}`)) || (timelineFilter === 'error' && /error|errore/.test(`${type} ${haystack}`));
      return matchesSearch && matchesType;
    });
    const clipMarkup = archiveClips.flatMap((clip, index) => {
      if (clip.kind === 'snapshot') return [];
      const start = new Date(clip.start);
      const seconds = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds();
      const left = seconds / 86400 * 100;
      const width = Math.max(.28, Number(clip.duration || 60) / 86400 * 100);
      return [`<button class="archive-segment" style="left:${left}%;width:${width}%" data-archive-index="${index}" title="Registrazione ${escapeHtml(start.toLocaleTimeString('it-IT'))}"></button>`];
    }).join('');
    const eventMarkup = dayEvents.map((item, index) => {
      const date = new Date(item.createdAt);
      const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
      const left = Math.min(99.4, Math.max(.6, seconds / 86400 * 100));
      return `<button class="timeline-dot ${escapeHtml(item.type)}" style="left:${left}%" data-timeline-index="${index}" title="${escapeHtml(date.toLocaleTimeString('it-IT'))} · ${escapeHtml(item.title)}"></button>`;
    }).join('');
    rail.innerHTML = clipMarkup + eventMarkup;
    rail.querySelectorAll('[data-archive-index]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation(); selectArchiveClip(archiveClips[Number(button.dataset.archiveIndex)], 0);
    }));
    rail.querySelectorAll('[data-timeline-index]').forEach((button) => button.addEventListener('click', () => {
      const item = dayEvents[Number(button.dataset.timelineIndex)];
      const date = new Date(item.createdAt);
      $('timelineSelection').innerHTML = `<b>${escapeHtml(date.toLocaleTimeString('it-IT'))} · ${escapeHtml(item.title)}</b><br>${escapeHtml(item.detail)}`;
    }));
    renderTimelineInsights(dayEventsAll);
    if (!dayEvents.length && !archiveClips.length) $('timelineSelection').textContent = 'Nessuna registrazione o evento in questa giornata.';
  }

  function renderTimelineInsights(dayEvents = []) {
    const snapshots = archiveClips.filter((clip) => clip.kind === 'snapshot').length;
    const videos = archiveClips.length - snapshots;
    const hourly = Array(24).fill(0);
    dayEvents.forEach((item) => { const date = new Date(item.createdAt); if (!Number.isNaN(date.getTime())) hourly[date.getHours()] += 1; });
    archiveClips.forEach((clip) => { const date = new Date(clip.start); if (!Number.isNaN(date.getTime())) hourly[date.getHours()] += 1; });
    const peakCount = Math.max(...hourly);
    const peakHour = peakCount ? hourly.indexOf(peakCount) : -1;
    $('insightEvents').textContent = String(dayEvents.length);
    $('insightClips').textContent = String(videos);
    $('insightSnapshots').textContent = String(snapshots);
    $('insightPeak').textContent = peakHour >= 0 ? `${String(peakHour).padStart(2, '0')}:00` : '—';
    $('insightPeak').disabled = peakHour < 0;
    const notable = dayEvents.filter((item) => /motion|ai|error|movimento|rilev|errore/i.test(`${item.type} ${item.title}`)).length;
    const pieces = [`${dayEvents.length} eventi`, `${videos} clip`, `${snapshots} snapshot`];
    if (notable) pieces.push(`${notable} rilevamenti o anomalie`);
    if (peakHour >= 0) pieces.push(`picco tra le ${String(peakHour).padStart(2, '0')}:00 e le ${String(peakHour + 1).padStart(2, '0')}:00`);
    $('timelineSummary').querySelector('span').textContent = `${pieces.join(' · ')}. Riepilogo calcolato localmente: nessun filmato è stato inviato all’IA.`;
    $('insightPeak').dataset.seconds = peakHour >= 0 ? String(peakHour * 3600) : '';
  }

  function setWorkspaceView(view, persist = true) {
    const allowed = ['live','timeline','ai','archive'];
    const selected = allowed.includes(view) ? view : 'live';
    preferences.workspaceView = selected;
    document.body.classList.remove(...allowed.map((item) => `workspace-view-${item}`));
    document.body.classList.add(`workspace-view-${selected}`);
    document.querySelectorAll('[data-workspace-view]').forEach((button) => button.classList.toggle('active', button.dataset.workspaceView === selected));
    if (selected === 'timeline' || selected === 'archive') loadArchive(activeId);
    if (persist) persistPreferences();
  }

  async function applyScene(scene) {
    const camera = currentCamera(); if (!camera) return;
    if (scene === 'home') {
      if ('Notification' in window && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') return toast('Autorizza le notifiche nel browser.', 'error');
      camera.notificationsEnabled = true; camera.notifyPerson = true; camera.notifyAnimal = true; camera.notifyVehicle = true; stopPersonTracking();
    } else if (scene === 'quiet') {
      camera.notificationsEnabled = false; stopPersonTracking();
    } else if (scene === 'follow') {
      camera.notificationsEnabled = true; camera.notifyPerson = true; camera.notifyAnimal = false; camera.notifyVehicle = false;
    }
    updateNotificationControls(camera);
    try {
      await persistCameras();
      if (scene === 'follow' && !trackingEnabled) await togglePersonTracking();
      await recordActivity('scene', 'Scenario applicato', `${camera.name}: ${scene === 'home' ? 'Casa' : scene === 'quiet' ? 'Privacy' : 'Segui persona'}. Nessuna registrazione automatica avviata.`);
      toast('Scenario applicato. Le registrazioni restano manuali.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  function archiveUrl(clip) {
    return `${gatewayBase}${clip.source === 'sd' ? '/api/sd/file' : '/api/archive/file'}?access=${encodeURIComponent(clip.access)}`;
  }

  function updateSdStorage(recordingBytes = 0) {
    const total = Number(sdStorage.total || 0); const free = Number(sdStorage.free || 0); const used = Math.max(0, total - free); const percent = total ? Math.min(100, used / total * 100) : 0;
    $('sdStorageBar').style.width = `${percent}%`; $('sdStoragePercent').textContent = total ? `${percent.toFixed(1)}%` : '--%';
    $('sdStorageText').textContent = total ? `${formatBytes(free)} liberi su ${formatBytes(total)} · archivio ${formatBytes(recordingBytes)}` : 'Spazio non disponibile';
    const values = [...$('sdRetention').options].map((option) => Number(option.value)); $('sdRetention').value = String(values.includes(Number(sdStorage.max || 0)) ? Number(sdStorage.max || 0) : 0);
  }

  function mediaThumbnailUrl(clip) {
    if (clip.source !== 'sd') return '';
    if (clip.kind === 'snapshot') return archiveUrl(clip);
    return `${gatewayBase}/api/sd/thumbnail?access=${encodeURIComponent(clip.access)}`;
  }

  function renderMediaLibrary() {
    const items = archiveClips.filter((clip) => mediaFilter === 'all' || (clip.kind || 'video') === mediaFilter);
    const videos = archiveClips.filter((clip) => (clip.kind || 'video') === 'video').length; const snapshots = archiveClips.filter((clip) => clip.kind === 'snapshot').length;
    $('mediaLibrarySummary').textContent = archiveSource === 'sd' ? `${videos} video · ${snapshots} snapshot · ${formatBytes(archiveClips.reduce((sum, clip) => sum + Number(clip.size || 0), 0))}` : `${archiveClips.length} registrazioni nell'archivio locale`;
    if (!items.length) { $('mediaLibraryGrid').innerHTML = '<div class="media-library-empty">Nessun contenuto per questo filtro e questa data.</div>'; return; }
    $('mediaLibraryGrid').innerHTML = items.map((clip) => {
      const start = new Date(clip.start); const kind = clip.kind || 'video'; const thumbnail = mediaThumbnailUrl(clip);
      return `<button class="media-card" data-media-name="${escapeHtml(clip.name)}"><span class="media-card-preview">${thumbnail ? `<img src="${escapeHtml(thumbnail)}" loading="lazy" alt="">` : icon(kind === 'snapshot' ? 'snapshot' : 'record')}<span>${kind === 'snapshot' ? 'FOTO' : `${Math.round(clip.duration || 60)} SEC`}</span></span><span class="media-card-info"><b>${escapeHtml(start.toLocaleTimeString('it-IT'))}</b><small>${escapeHtml(start.toLocaleDateString('it-IT'))} · ${escapeHtml(formatBytes(clip.size || 0))}</small></span></button>`;
    }).join('');
    $('mediaLibraryGrid').querySelectorAll('[data-media-name]').forEach((button) => button.addEventListener('click', () => openMediaViewer(archiveClips.find((clip) => clip.name === button.dataset.mediaName))));
  }

  function updateTrimControls(changed = '') {
    let start = Number($('trimStart').value); let end = Number($('trimEnd').value); const maximum = Math.max(1, Math.round(mediaViewerClip?.duration || 60));
    if (changed === 'start' && start >= end) end = Math.min(maximum, start + 1);
    if (changed === 'end' && end <= start) start = Math.max(0, end - 1);
    $('trimStart').value = String(start); $('trimEnd').value = String(end); $('trimStartValue').textContent = `${start} s`; $('trimEndValue').textContent = `${end} s`; $('trimDuration').textContent = `${start} - ${end} secondi · durata ${end - start} s`;
  }

  function openMediaViewer(clip) {
    if (!clip) return; mediaViewerClip = clip; selectedArchiveClip = clip;
    const isSnapshot = clip.kind === 'snapshot'; const source = archiveUrl(clip); const date = new Date(clip.start);
    const location = clip.source === 'sd' ? 'MicroSD' : 'Archivio locale'; $('mediaViewerType').textContent = `${isSnapshot ? 'Snapshot' : 'Registrazione'} · ${location}`; $('mediaViewerTitle').textContent = isSnapshot ? 'Snapshot' : 'Clip video'; $('mediaViewerMeta').textContent = `${date.toLocaleString('it-IT')} · ${formatBytes(clip.size || 0)}`;
    $('mediaDelete').hidden = clip.source !== 'sd';
    $('mediaViewerImage').hidden = !isSnapshot; $('mediaViewerVideo').hidden = isSnapshot; $('trimEditor').hidden = isSnapshot || clip.source !== 'sd'; $('mediaTrimExport').hidden = isSnapshot || clip.source !== 'sd';
    if (isSnapshot) { $('mediaViewerVideo').pause(); $('mediaViewerVideo').removeAttribute('src'); $('mediaViewerImage').src = source; }
    else { $('mediaViewerImage').removeAttribute('src'); $('mediaViewerVideo').src = source; $('mediaViewerVideo').play().catch(() => {}); const maximum = Math.max(1, Math.round(clip.duration || 60)); $('trimStart').max = String(maximum - 1); $('trimEnd').max = String(maximum); $('trimStart').value = '0'; $('trimEnd').value = String(maximum); updateTrimControls(); }
    $('mediaDialog').showModal();
  }

  async function shareMediaBlob(blob, name, title = 'Archivio FREDI Control') {
    const file = new File([blob], name, { type:blob.type || (name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4') });
    if (navigator.canShare?.({ files:[file] })) return navigator.share({ title, files:[file] });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1500); toast('File scaricato sul dispositivo.', 'success');
  }

  async function shareViewedMedia() {
    if (!mediaViewerClip) return;
    try { const response = await fetch(archiveUrl(mediaViewerClip)); if (!response.ok) throw new Error('Contenuto non raggiungibile'); const blob = await response.blob(); const name = mediaViewerClip.source === 'sd' ? mediaViewerClip.name.replace(/\.h264$/i, '.mp4') : mediaViewerClip.name; await shareMediaBlob(blob, name); }
    catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); }
  }

  async function exportTrimmedMedia() {
    const clip = mediaViewerClip; if (!clip || clip.source !== 'sd' || clip.kind === 'snapshot') return;
    const start = Number($('trimStart').value); const end = Number($('trimEnd').value); $('mediaTrimExport').disabled = true;
    try { const url = `${gatewayBase}/api/sd/export?access=${encodeURIComponent(clip.access)}&start=${start}&duration=${end - start}`; const response = await fetch(url); if (!response.ok) throw new Error('Esportazione intervallo non riuscita'); const blob = await response.blob(); const name = clip.name.replace(/\.h264$/i, `_da-${start}s_a-${end}s.mp4`); await shareMediaBlob(blob, name, 'Estratto FREDI Control'); }
    catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); }
    finally { $('mediaTrimExport').disabled = false; }
  }

  async function loadArchive(cameraId = activeId) {
    if (!cameraId || !$('timelineDate').value) return;
    $('archiveState').textContent = 'Caricamento…';
    try {
      const endpoint = archiveSource === 'sd' ? '/api/sd' : '/api/archive';
      const result = await gatewayFetch(`${endpoint}?cameraId=${encodeURIComponent(cameraId)}&date=${encodeURIComponent($('timelineDate').value)}`);
      if (cameraId !== activeId) return;
      archiveClips = result.clips || [];
      if (archiveSource === 'sd') {
        sdRecording = Boolean(result.recording); $('sdRecordingState').textContent = sdRecording ? 'REGISTRA' : 'Pronta'; $('sdRecordToggle').textContent = sdRecording ? 'Ferma registrazione' : 'Avvia registrazione'; document.querySelector('.sd-panel').classList.toggle('recording', sdRecording);
        sdStorage = result.storage || { total:0, free:0, max:0, reserve:0 }; updateSdStorage(result.usage || 0);
      }
      $('archiveState').textContent = archiveClips.length ? `${archiveClips.length} clip · ${formatBytes(result.usage || 0)}` : 'Nessuna clip';
      if (archiveSource === 'local') $('localArchiveState').textContent = `${result.retentionDays || 7} giorni · ${archiveClips.length} clip nel giorno`;
    } catch (error) {
      archiveClips = []; $('archiveState').textContent = 'Archivio non raggiungibile'; if (archiveSource === 'local') $('localArchiveState').textContent = error.message;
    }
    selectedArchiveClip = null; $('uploadDropbox').disabled = true; $('sdDeleteClip').disabled = true; renderPlaybackTimeline(); renderMediaLibrary();
  }

  function selectArchiveClip(clip, offsetSeconds = 0) {
    if (!clip) return;
    const camera = currentCamera(); if (!camera) return;
    selectedArchiveClip = clip; archivePlayback = true;
    $('sdDeleteClip').disabled = clip.source !== 'sd';
    disconnectStream(); archivePlayback = true;
    player.src = archiveUrl(clip);
    player.addEventListener('loadedmetadata', () => { player.currentTime = Math.min(Math.max(0, offsetSeconds), Math.max(0, player.duration - .2)); player.play().catch(() => {}); }, { once:true });
    $('stage').classList.add('playing', 'archive'); $('qualitySelect').disabled = true; $('returnLive').hidden = false; $('uploadDropbox').disabled = clip.source === 'sd' || !cloud?.dropbox?.connected;
    const start = new Date(clip.start);
    $('timelineSelection').innerHTML = `<b>Riproduzione ${escapeHtml(start.toLocaleString('it-IT'))}</b><br>${Math.round(clip.duration || 60)} secondi · ${escapeHtml(formatBytes(clip.size || 0))}`;
  }

  function returnToLive() {
    const camera = currentCamera(); archivePlayback = false; selectedArchiveClip = null; $('stage').classList.remove('archive'); $('returnLive').hidden = true; $('uploadDropbox').disabled = true; renderQualityLevels(camera);
    disconnectStream(); if (camera?.streamUrl) connectStream(camera);
  }

  async function selectSdArchive() {
    if ($('sdSource').disabled) return;
    archiveSource = 'sd'; $('sdSource').classList.add('active'); $('localSource').classList.remove('active');
    await loadArchive(activeId);
    toast('Timeline MicroSD caricata.', 'success');
  }

  async function toggleSdRecording() {
    const camera = currentCamera(); if (!camera) return;
    $('sdRecordToggle').disabled = true;
    try {
      const result = await gatewayFetch('/api/sd/record', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, enabled:!sdRecording }) });
      sdRecording = Boolean(result.recording); archiveSource = 'sd'; $('sdSource').classList.add('active'); $('localSource').classList.remove('active');
      $('sdRecordingState').textContent = sdRecording ? 'REGISTRA' : 'Pronta'; $('sdRecordToggle').textContent = sdRecording ? 'Ferma registrazione' : 'Avvia registrazione'; document.querySelector('.sd-panel').classList.toggle('recording', sdRecording);
      toast(sdRecording ? 'Registrazione diretta sulla microSD avviata.' : 'Registrazione fermata; il segmento viene chiuso.', 'success');
      if (!sdRecording) setTimeout(() => loadArchive(activeId), 1200);
    } catch (error) { toast(error.message, 'error'); }
    finally { $('sdRecordToggle').disabled = false; }
  }

  async function saveSdRetention() {
    const camera = currentCamera(); if (!camera || !sdAvailable) return;
    $('sdRetention').disabled = true;
    try {
      const maxBytes = Number($('sdRetention').value); await gatewayFetch('/api/sd/config', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, maxBytes }) });
      sdStorage.max = maxBytes; toast(maxBytes ? `Limite circolare impostato a ${formatBytes(maxBytes)}.` : 'La registrazione usera tutta la microSD mantenendo 512 MB liberi.', 'success'); await loadArchive(camera.id);
    } catch (error) { toast(error.message, 'error'); }
    finally { $('sdRetention').disabled = false; }
  }

  async function deleteSelectedSdClip() {
    const camera = currentCamera(); const clip = selectedArchiveClip;
    if (!camera || clip?.source !== 'sd' || !confirm(`Eliminare ${clip.name} dalla microSD?`)) return;
    try {
      await gatewayFetch('/api/sd/file', { method:'DELETE', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, name:clip.name }) });
      if ($('mediaDialog').open) $('mediaDialog').close(); mediaViewerClip = null; selectedArchiveClip = null; archivePlayback = false; $('sdDeleteClip').disabled = true; await loadArchive(camera.id); returnToLive(); toast('Contenuto eliminato dalla microSD.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  function seekTimeline(event) {
    if (event.target.closest('button')) return;
    const rect = $('timelineRail').getBoundingClientRect();
    const seconds = Math.max(0, Math.min(86399, (event.clientX - rect.left) / rect.width * 86400));
    $('timelineScrubber').value = String(Math.round(seconds)); updateTimelineTime(seconds);
    seekArchiveSeconds(seconds);
  }

  function updateTimelineTime(seconds = Number($('timelineScrubber').value)) {
    const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const secs = Math.floor(seconds % 60);
    $('timelineTime').textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function seekArchiveSeconds(seconds) {
    const clip = archiveClips.find((item) => {
      const date = new Date(item.start); const start = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
      return seconds >= start && seconds < start + Number(item.duration || 60);
    });
    const label = $('timelineTime').textContent;
    if (!clip) { $('timelineSelection').innerHTML = `<b>${escapeHtml(label)}</b><br>Nessuna registrazione disponibile in questo punto.`; return; }
    const start = new Date(clip.start); const startSeconds = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds();
    selectArchiveClip(clip, seconds - startSeconds);
  }

  function relativeTime(date) {
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'ora'; if (seconds < 3600) return `${Math.floor(seconds / 60)} min`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`; return `${Math.floor(seconds / 86400)} g`;
  }

  function openCameraDialog(id = '') {
    editingId = id;
    const camera = cameras.find((item) => item.id === id) || { name:'', model:'', location:'', notes:'', favorite:false, webrtcUrl:'', streamUrl:'', streamLowUrl:'', streamUsername:'', streamPassword:'', apiBaseUrl:'', apiToken:'', ptz:false, motionDetection:true, digitalZoom:1, notificationsEnabled:false, notifyPerson:true, notifyAnimal:true, notifyVehicle:true };
    $('settingsTitle').textContent = id ? `Modifica ${camera.name}` : 'Aggiungi camera';
    $('nameInput').value = camera.name; $('modelInput').value = camera.model || ''; $('locationInput').value = camera.location || ''; $('notesInput').value = camera.notes || ''; $('favoriteInput').checked = Boolean(camera.favorite);
    $('motionInput').checked = camera.motionDetection !== false;
    $('webrtcInput').value = camera.webrtcUrl || derivedWebRtcUrl(camera); $('streamInput').value = camera.streamUrl || ''; $('streamLowInput').value = camera.streamLowUrl || ''; $('streamUsernameInput').value = camera.streamUsername || ''; $('streamPasswordInput').value = camera.streamPassword || '';
    $('ptzInput').checked = Boolean(camera.ptz); $('apiInput').value = camera.apiBaseUrl || ''; $('apiTokenInput').value = camera.apiToken || '';
    $('deleteCamera').hidden = !id;
    updatePtzFields(); setCameraStep('general'); $('settingsDialog').showModal();
  }

  function setCameraStep(step) {
    document.querySelectorAll('[data-step]').forEach((button) => button.classList.toggle('active', button.dataset.step === step));
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === step));
  }

  function updatePtzFields() {
    const enabled = $('ptzInput').checked;
    $('ptzFields').classList.toggle('fields-disabled', !enabled);
    $('apiInput').disabled = !enabled; $('apiTokenInput').disabled = !enabled;
  }

  async function saveCamera() {
    const name = $('nameInput').value.trim();
    if (!name) { setCameraStep('general'); $('nameInput').focus(); return toast('Inserisci un nome per la camera.', 'error'); }
    if ($('ptzInput').checked && (!$('apiInput').value.trim() || !$('apiTokenInput').value)) { setCameraStep('control'); return toast('Per il PTZ servono URL gateway e token.', 'error'); }
    const previous = cameras.find((item) => item.id === editingId);
    const camera = {
      id:editingId || crypto.randomUUID(), name, model:$('modelInput').value.trim(), location:$('locationInput').value.trim(), notes:$('notesInput').value.trim(), favorite:$('favoriteInput').checked, motionDetection:$('motionInput').checked, webrtcUrl:$('webrtcInput').value.trim(), streamUrl:$('streamInput').value.trim(), streamLowUrl:$('streamLowInput').value.trim(),
      streamUsername:$('streamUsernameInput').value.trim(), streamPassword:$('streamPasswordInput').value,
      apiBaseUrl:$('ptzInput').checked ? $('apiInput').value.trim() : '', apiToken:$('ptzInput').checked ? $('apiTokenInput').value : '', ptz:$('ptzInput').checked,
      rotation:previous?.rotation === 180 ? 180 : 0,
      digitalZoom:previous?.digitalZoom || 1,
      notificationsEnabled:Boolean(previous?.notificationsEnabled),
      notifyPerson:previous?.notifyPerson !== false,
      notifyAnimal:previous?.notifyAnimal !== false,
      notifyVehicle:previous?.notifyVehicle !== false,
    };
    const backup = [...cameras];
    const index = cameras.findIndex((item) => item.id === camera.id);
    if (index >= 0) cameras[index] = camera; else cameras.push(camera);
    activeId = camera.id;
    setLoading(true, 'Salvataggio camera…');
    try {
      await persistCameras();
      $('settingsDialog').close(); renderAll(); selectCamera(activeId);
      toast(previous ? 'Camera aggiornata nel vault.' : 'Camera aggiunta al vault.', 'success');
    } catch (error) { cameras = backup; toast(error.message, 'error'); }
    finally { setLoading(false); }
  }

  async function persistCameras() {
    setConnection('busy', 'Sincronizzazione…');
    const result = await gatewayFetch('/api/cameras', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameras }) });
    cameras = result.cameras || cameras; events = result.events || events; preferences = { ...preferences, ...(result.preferences || {}) };
    setConnection('', 'Vault sincronizzato'); renderStats(); renderEvents();
  }

  async function deleteCamera() {
    const camera = cameras.find((item) => item.id === editingId);
    if (!camera || !confirm(`Eliminare definitivamente “${camera.name}”?`)) return;
    const backup = [...cameras]; cameras = cameras.filter((item) => item.id !== camera.id); activeId = cameras[0]?.id || '';
    setLoading(true, 'Eliminazione camera…');
    try { await persistCameras(); $('settingsDialog').close(); renderAll(); toast('Camera eliminata.', 'success'); }
    catch (error) { cameras = backup; toast(error.message, 'error'); }
    finally { setLoading(false); }
  }

  async function duplicateCamera(id) {
    const source = cameras.find((camera) => camera.id === id); if (!source) return;
    const duplicate = { ...source, id:crypto.randomUUID(), name:`${source.name} copia` };
    cameras.push(duplicate); activeId = duplicate.id;
    try { await persistCameras(); renderAll(); toast('Camera duplicata.', 'success'); }
    catch (error) { cameras.pop(); toast(error.message, 'error'); }
  }

  async function testStreamValues(url, username, password) {
    if (!url) throw new Error('Inserisci prima un URL HLS.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const headers = username && password ? { Authorization:`Basic ${btoa(`${username}:${password}`)}` } : {};
      const response = await fetch(url, { method:'GET', headers, cache:'no-store', signal:controller.signal });
      if (!response.ok) throw new Error(`Il server video risponde HTTP ${response.status}.`);
      const text = await response.text();
      if (!text.includes('#EXTM3U')) throw new Error('La risposta non sembra una playlist HLS.');
      return true;
    } finally { clearTimeout(timeout); }
  }

  async function testCurrentCamera() {
    const camera = currentCamera(); if (!camera) return;
    setLoading(true, 'Verifica collegamenti…');
    const startedAt = performance.now();
    try {
      if (camera.streamUrl) await testStreamValues(camera.streamUrl, camera.streamUsername, camera.streamPassword);
      if (camera.ptz && camera.apiBaseUrl) {
        const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/health`, { cache:'no-store' });
        if (!response.ok) throw new Error(`Gateway PTZ non raggiungibile (${response.status}).`);
      }
      const latency = Math.max(1, Math.round(performance.now() - startedAt));
      healthByCamera.set(camera.id, { ok:true, latency, checkedAt:Date.now() }); updateFocusedCameraStatus(camera);
      recordActivity('success', 'Camera verificata', `${camera.name}: video e gateway raggiungibili in ${latency} ms.`);
      toast(`Configurazione raggiungibile in ${latency} ms.`, 'success');
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Verifica scaduta: gateway troppo lento.' : error.message;
      healthByCamera.set(camera.id, { ok:false, latency:0, checkedAt:Date.now() }); updateFocusedCameraStatus(camera);
      recordActivity('error', 'Verifica camera fallita', `${camera.name}: ${message}`); toast(message, 'error');
    }
    finally { setLoading(false); }
  }

  function updateFocusedCameraStatus(camera) {
    if (camera.id !== activeId) return;
    const health = healthByCamera.get(camera.id);
    $('healthBadge').className = `health-badge${health?.ok ? ' ok' : ' error'}`;
    $('healthBadge').textContent = health?.ok ? `${health.latency} MS` : 'ERRORE';
    $('detailHealth').textContent = new Date(health.checkedAt).toLocaleTimeString('it-IT');
    $('healthMetric').textContent = $('detailHealth').textContent;
    $('operationsTitle').textContent = health.ok ? 'Sistema operativo' : 'Controllo richiesto';
    $('operationsDetail').textContent = health.ok ? `${camera.name} raggiungibile` : `${camera.name} non raggiungibile`;
  }

  async function sendPtz(action, step = ptzStep, options = {}) {
    const camera = currentCamera();
    if (!camera?.ptz || !camera.apiBaseUrl || !camera.apiToken) return toast('PTZ non configurato per questa camera.', 'error');
    if (!options.tracking && trackingEnabled) stopPersonTracking('Controllo manuale: inseguimento interrotto.', true);
    try {
      suppressMotionUntil = Date.now() + 6000;
      if (!options.quiet) navigator.vibrate?.(18);
      snapToLiveEdge();
      [150, 450, 900, 1600].forEach((delay) => setTimeout(snapToLiveEdge, delay));
      const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/ptz`, { method:'POST', cache:'no-store', keepalive:true, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${camera.apiToken}` }, body:JSON.stringify({ action, step, ...(options.durationMs ? { durationMs:options.durationMs } : {}), ...(options.continuous ? { continuous:true } : {}) }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || result.error || 'Comando rifiutato.');
      if (!options.quiet) toast(`Movimento ${action} · intensità ${result.step || step}.`, 'success');
      return true;
    } catch (error) { if (!options.quiet) toast(error.message, 'error'); return false; }
  }

  function startPtzHold(event, button) {
    event.preventDefault();
    if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) return;
    const action = button.dataset.ptz;
    if (action === 'stop') { stopPtzHold(); sendPtz('stop', ptzStep, { continuous:true, quiet:true }); return; }
    if (ptzHold) return;
    clearTimeout(ptzReleaseTimer);
    button.setPointerCapture?.(event.pointerId);
    ptzHold = { pointerId:event.pointerId, action, step:ptzStep, button, startedAt:performance.now() };
    button.classList.add('holding');
    navigator.vibrate?.(12);
    ptzHoldRequest = sendPtz(action, ptzStep, { continuous:true, quiet:true });
  }

  function stopPtzHold(event) {
    const hold = ptzHold;
    if (!hold || (event?.pointerId !== undefined && event.pointerId !== hold.pointerId)) return;
    ptzHold = null;
    hold.button.classList.remove('holding');
    const remaining = Math.max(0, 110 - (performance.now() - hold.startedAt));
    clearTimeout(ptzReleaseTimer);
    ptzReleaseTimer = setTimeout(() => {
      Promise.resolve(ptzHoldRequest).finally(() => sendPtz('stop', hold.step, { continuous:true, quiet:true }));
    }, remaining);
  }

  function snapToLiveEdge() {
    const hlsEdge = Number(hls?.liveSyncPosition);
    const bufferedEdge = player.buffered.length ? player.buffered.end(player.buffered.length - 1) - .08 : NaN;
    const liveEdge = Number.isFinite(hlsEdge) ? hlsEdge : bufferedEdge;
    if (Number.isFinite(liveEdge) && Math.abs(player.currentTime - liveEdge) > .22) player.currentTime = liveEdge;
  }

  function updateLiveClock() {
    const now = new Date();
    $('liveTime').textContent = now.toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    $('liveDate').textContent = now.toLocaleDateString('it-IT', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
  }

  function beginGesture(event) {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('button,select,label')) return;
    if (!$('stage').classList.contains('playing')) return;
    gestureStart = { x:event.clientX, y:event.clientY, pointerId:event.pointerId };
    $('stage').setPointerCapture?.(event.pointerId);
    $('gestureHint').hidden = false;
  }

  function finishGesture(event) {
    if (!gestureStart || event.pointerId !== gestureStart.pointerId) return;
    const dx = event.clientX - gestureStart.x;
    const dy = event.clientY - gestureStart.y;
    const distance = Math.hypot(dx, dy);
    gestureStart = null; $('gestureHint').hidden = true;
    if (distance < 34) { selectTrackingTargetAt(event.clientX, event.clientY); return; }
    const action = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const step = distance > 180 ? 22 : distance > 90 ? 12 : 6;
    sendPtz(action, step);
  }

  function moveGesture(event) {
    if (!gestureStart || event.pointerId !== gestureStart.pointerId) return;
    const dx = event.clientX - gestureStart.x;
    const dy = event.clientY - gestureStart.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 34) return;
    const action = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    const step = distance > 180 ? 22 : distance > 90 ? 12 : 6;
    gestureStart = null; $('gestureHint').hidden = true;
    sendPtz(action, step);
  }

  function stopMotionDetection() {
    clearInterval(motionTimer); motionTimer = null; previousMotionFrame = null;
  }

  function startMotionDetection() {
    stopMotionDetection();
    if (currentCamera()?.motionDetection === false) return;
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 45;
    const context = canvas.getContext('2d', { willReadFrequently:true });
    motionTimer = setInterval(() => {
      if (player.paused || player.readyState < 2 || Date.now() < suppressMotionUntil) return;
      try {
        context.drawImage(player, 0, 0, canvas.width, canvas.height);
        const current = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (previousMotionFrame) {
          let changed = 0; let sampled = 0;
          for (let index = 0; index < current.length; index += 16) {
            const brightness = (current[index] + current[index + 1] + current[index + 2]) / 3;
            const previous = (previousMotionFrame[index] + previousMotionFrame[index + 1] + previousMotionFrame[index + 2]) / 3;
            if (Math.abs(brightness - previous) > 28) changed += 1;
            sampled += 1;
          }
          const ratio = changed / sampled;
          if (ratio > .16 && Date.now() > motionCooldownUntil) {
            motionCooldownUntil = Date.now() + 20000;
            const camera = currentCamera();
            if (camera) recordActivity('motion', 'Movimento rilevato', `${camera.name}: variazione dell'immagine ${Math.round(ratio * 100)}%.`);
            notifyDetectedObjects();
          }
        }
        previousMotionFrame = new Uint8ClampedArray(current);
      } catch { stopMotionDetection(); }
    }, 1000);
  }

  function snapshot() {
    const camera = currentCamera();
    if (!camera || !player.videoWidth) return toast('Avvia il live prima dello snapshot.', 'error');
    const canvas = document.createElement('canvas'); canvas.width = player.videoWidth; canvas.height = player.videoHeight;
    const capturedAt = new Date();
    drawStampedFrame(canvas, capturedAt, camera);
    canvas.toBlob(async (blob) => {
      if (!blob) return toast('Impossibile creare lo snapshot.', 'error');
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${slug(camera.name)}-${fileTimestamp(capturedAt)}.jpg`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000); $('snapshotState').textContent = capturedAt.toLocaleString('it-IT'); recordActivity('snapshot', 'Snapshot acquisito', `${camera.name}: immagine del ${capturedAt.toLocaleString('it-IT')} salvata sul dispositivo.`);
      let sdSaved = false;
      if (sdAvailable && $('sdSnapshotStore').checked) {
        try {
          const query = new URLSearchParams({ cameraId:camera.id, stamp:fileTimestamp(capturedAt) });
          await gatewayFetch(`/api/sd/snapshot?${query}`, { method:'POST', headers:{ 'Content-Type':'image/jpeg' }, body:blob }); sdSaved = true;
          if (archiveSource === 'sd' && $('timelineDate').value === localDateKey(capturedAt)) await loadArchive(camera.id);
        } catch (error) { toast(`Snapshot scaricato; microSD: ${error.message}`, 'error'); }
      }
      if (cloud?.dropbox?.connected && cloud.dropbox.snapshotBackup) {
        try {
          const query = new URLSearchParams({ cameraId:camera.id, stamp:fileTimestamp(capturedAt) });
          await gatewayFetch(`/api/cloud/dropbox/snapshot?${query}`, { method:'POST', headers:{ 'Content-Type':'image/jpeg' }, body:blob });
          toast(`Snapshot salvato${sdSaved ? ' su microSD e' : ''} su Dropbox.`, 'success');
        } catch (error) { toast(`Snapshot locale salvato; Dropbox: ${error.message}`, 'error'); }
      } else if (sdSaved) toast('Snapshot scaricato e archiviato sulla microSD.', 'success');
      else toast('Snapshot con data e ora scaricato.', 'success');
    }, 'image/jpeg', .92);
  }

  function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'camera'; }

  function fileTimestamp(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
  }

  function drawStampedFrame(canvas, date = new Date(), camera = currentCamera()) {
    const context = canvas.getContext('2d');
    context.save();
    if (camera?.rotation === 180) {
      context.translate(canvas.width, canvas.height); context.rotate(Math.PI);
    }
    context.drawImage(player, 0, 0, canvas.width, canvas.height);
    context.restore();
    const stamp = date.toLocaleString('it-IT', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    const fontSize = Math.max(18, Math.round(canvas.width / 48));
    const padding = Math.max(10, Math.round(fontSize * .55));
    context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    context.textBaseline = 'middle';
    const textWidth = context.measureText(stamp).width;
    const boxHeight = fontSize + padding * 1.25;
    const x = padding; const y = canvas.height - boxHeight - padding;
    context.fillStyle = 'rgba(0,0,0,.72)'; context.fillRect(x, y, textWidth + padding * 2, boxHeight);
    context.fillStyle = '#fff'; context.fillText(stamp, x + padding, y + boxHeight / 2);
  }

  function toggleRecording() {
    if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); return; }
    startRecording('local');
  }

  function startRecording(destination = 'local', maximumSeconds = 0) {
    if (!HTMLCanvasElement.prototype.captureStream || player.paused) return toast('Avvia il live in un browser compatibile prima di registrare.', 'error');
    if (mediaRecorder?.state === 'recording') return toast('È già in corso una registrazione.', 'error');
    try {
      const camera = currentCamera();
      const canvas = document.createElement('canvas'); canvas.width = player.videoWidth; canvas.height = player.videoHeight;
      const renderFrame = () => { drawStampedFrame(canvas, new Date(), camera); recordingAnimation = requestAnimationFrame(renderFrame); };
      renderFrame();
      recordingStream = canvas.captureStream(25);
      const sourceStream = player.captureStream?.();
      sourceStream?.getAudioTracks().forEach((track) => recordingStream.addTrack(track.clone()));
      const preferredMime = MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
      chunks = []; recordingDestination = destination; mediaRecorder = new MediaRecorder(recordingStream, { mimeType:preferredMime });
      mediaRecorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      mediaRecorder.onstart = () => {
        recordingStartedAt = Date.now(); $('recordButton').classList.add('recording'); $('recordButton').querySelector('span').textContent = 'Ferma';
        if (destination === 'dropbox') { $('cloudRecord').disabled = false; $('cloudRecord').textContent = 'Ferma frammento'; }
        if (maximumSeconds > 0) recordingStopTimer = window.setTimeout(() => mediaRecorder?.state === 'recording' && mediaRecorder.stop(), maximumSeconds * 1000);
      };
      mediaRecorder.onstop = () => {
        const startedAt = recordingStartedAt || Date.now(); const completedDestination = recordingDestination; recordingStartedAt = 0; recordingDestination = 'local';
        clearTimeout(recordingStopTimer); recordingStopTimer = 0;
        cancelAnimationFrame(recordingAnimation); recordingAnimation = 0;
        recordingStream?.getTracks().forEach((track) => track.stop()); recordingStream = null;
        $('recordButton').classList.remove('recording'); $('recordButton').querySelector('span').textContent = 'Registra';
        $('cloudRecord').textContent = 'Registra frammento su Dropbox'; $('cloudRecord').disabled = !cloud?.dropbox?.connected;
        addRecording(new Blob(chunks, { type:preferredMime }), camera, startedAt, completedDestination);
      };
      mediaRecorder.start(1000);
    } catch {
      cancelAnimationFrame(recordingAnimation); recordingAnimation = 0;
      recordingStream?.getTracks().forEach((track) => track.stop()); recordingStream = null;
      clearTimeout(recordingStopTimer); recordingStopTimer = 0; recordingDestination = 'local';
      toast('Registrazione non supportata dal browser.', 'error');
    }
  }

  function mediaDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('fredi-local-media-v1', 1);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('clips', { keyPath:'id' }); store.createIndex('cameraId', 'cameraId'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }

  async function saveRecording(blob, camera) {
    const db = await mediaDatabase();
    const record = { id:crypto.randomUUID(), cameraId:camera.id, cameraName:camera.name, createdAt:Date.now(), type:blob.type || 'video/webm', size:blob.size, blob };
    await new Promise((resolve, reject) => { const transaction = db.transaction('clips', 'readwrite'); transaction.objectStore('clips').put(record); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close(); return record;
  }

  async function deleteRecording(id) {
    const db = await mediaDatabase();
    await new Promise((resolve, reject) => { const transaction = db.transaction('clips', 'readwrite'); transaction.objectStore('clips').delete(id); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close(); await loadRecordings(activeId); await updateStorageEstimate(); toast('Clip eliminata dal dispositivo.', 'success');
  }

  async function loadRecordings(cameraId) {
    recordingUrls.forEach(URL.revokeObjectURL); recordingUrls = [];
    const container = $('recordingList'); container.innerHTML = '';
    if (!cameraId || !window.indexedDB) { $('recordingEmpty').hidden = false; return; }
    try {
      const db = await mediaDatabase();
      const records = await new Promise((resolve, reject) => { const request = db.transaction('clips').objectStore('clips').index('cameraId').getAll(cameraId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close(); records.sort((a, b) => b.createdAt - a.createdAt);
      $('recordingEmpty').hidden = records.length > 0;
      records.forEach((record) => {
        const url = URL.createObjectURL(record.blob); recordingUrls.push(url);
        const row = document.createElement('div'); row.className = 'recording';
        row.innerHTML = `${icon('record')}<div><b>${escapeHtml(record.cameraName || 'Camera')}</b><small>${escapeHtml(new Date(record.createdAt).toLocaleString('it-IT'))} · ${Math.max(1, Math.round(record.size / 1024 / 1024))} MB</small></div><a href="${url}" download="${slug(record.cameraName || 'camera')}-${record.createdAt}.webm">Scarica</a><button type="button" data-delete-recording="${record.id}" title="Elimina">×</button>`;
        container.append(row);
      });
    } catch { $('recordingEmpty').hidden = false; }
  }

  function archiveStamp(timestamp) {
    const date = new Date(timestamp); const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  async function uploadManualRecording(blob, camera, startedAt) {
    const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const query = new URLSearchParams({ cameraId:camera.id, stamp:archiveStamp(startedAt), duration:String(duration) });
    return gatewayFetch(`/api/archive/manual?${query}`, { method:'POST', headers:{ 'Content-Type':'video/webm' }, body:blob });
  }

  async function addRecording(blob, recordedCamera = currentCamera(), startedAt = Date.now(), destination = 'local') {
    const camera = recordedCamera; if (!camera) return;
    try {
      const result = await uploadManualRecording(blob, camera, startedAt);
      await loadArchive(camera.id);
      recordActivity('clip', 'Registrazione manuale salvata', `${camera.name}: ${result.name} · ${formatBytes(result.size || blob.size)}.`);
      if (destination === 'dropbox') {
        try {
          await gatewayFetch('/api/cloud/dropbox/upload', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, name:result.name }) });
          await loadCloudStatus(); toast('Frammento salvato nella cartella locale e su Dropbox.', 'success');
        } catch (error) { toast(`Frammento locale salvato; Dropbox: ${error.message}`, 'error'); }
      } else toast('Clip salvata nella cartella registrazioni del gateway.', 'success');
    } catch (gatewayError) {
      try {
        await saveRecording(blob, camera); await loadRecordings(camera.id); await updateStorageEstimate();
        recordActivity('clip', 'Registrazione salvata nel browser', `${camera.name}: ripiego locale da ${formatBytes(blob.size)}.`);
        toast('Gateway non raggiungibile: clip conservata nel browser.', 'error');
      } catch { toast(`Impossibile salvare la clip: ${gatewayError.message}`, 'error'); }
    }
  }

  async function loadCloudStatus() {
    try {
      cloud = await gatewayFetch('/api/cloud');
      const dropbox = cloud.dropbox || {};
      $('cloudState').textContent = dropbox.connected ? 'Dropbox attivo' : 'Locale';
      $('dropboxState').textContent = dropbox.connected ? `${dropbox.account || 'Account collegato'}${dropbox.lastError ? ' · errore backup' : ''}` : dropbox.configured ? 'Pronto per il collegamento' : 'App Dropbox da configurare';
      $('dropboxConnect').textContent = dropbox.connected ? 'Scollega' : 'Collega account';
      $('dropboxAuto').disabled = !dropbox.connected; $('dropboxAuto').checked = Boolean(dropbox.autoBackup);
      $('dropboxSnapshots').disabled = !dropbox.connected; $('dropboxSnapshots').checked = Boolean(dropbox.snapshotBackup);
      $('cloudRecord').disabled = !dropbox.connected;
      $('uploadDropbox').disabled = !(dropbox.connected && selectedArchiveClip);
    } catch { $('cloudState').textContent = 'Non disponibile'; }
  }

  async function toggleDropboxConnection() {
    if (cloud?.dropbox?.connected) {
      if (!confirm('Scollegare Dropbox e fermare il backup automatico?')) return;
      try { cloud = await gatewayFetch('/api/cloud/dropbox/disconnect', { method:'DELETE' }); await loadCloudStatus(); toast('Dropbox scollegato.', 'success'); } catch (error) { toast(error.message, 'error'); }
      return;
    }
    try {
      const result = await gatewayFetch('/api/cloud/dropbox/start', { method:'POST' });
      location.href = result.authorizationUrl;
    } catch (error) { toast(error.message === 'Dropbox app is not configured on the gateway' ? 'Configura DROPBOX_APP_KEY nel gateway prima di collegare Dropbox.' : error.message, 'error'); }
  }

  async function setDropboxSettings(changedInput) {
    try {
      cloud = await gatewayFetch('/api/cloud/dropbox/settings', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ autoBackup:$('dropboxAuto').checked, snapshotBackup:$('dropboxSnapshots').checked }) });
      await loadCloudStatus(); toast('Preferenze Dropbox aggiornate.', 'success');
    } catch (error) { changedInput.checked = !changedInput.checked; toast(error.message, 'error'); }
  }

  function recordDropboxFragment() {
    if (mediaRecorder?.state === 'recording') {
      if (recordingDestination === 'dropbox') mediaRecorder.stop();
      else toast('Ferma prima la registrazione corrente.', 'error');
      return;
    }
    if (!cloud?.dropbox?.connected) return toast('Collega prima il tuo account Dropbox.', 'error');
    startRecording('dropbox', Number($('cloudFragmentDuration').value || 30));
  }

  async function uploadSelectedDropbox() {
    const camera = currentCamera(); if (!camera || !selectedArchiveClip) return toast('Seleziona prima una clip nella timeline.', 'error');
    if (selectedArchiveClip.source === 'sd') return toast('Scarica prima la clip MicroSD; il caricamento diretto su Dropbox verrà aggiunto separatamente.', 'error');
    $('uploadDropbox').disabled = true; $('uploadDropbox').textContent = 'Caricamento…';
    try {
      await gatewayFetch('/api/cloud/dropbox/upload', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, name:selectedArchiveClip.name }) });
      toast('Clip salvata su Dropbox.', 'success'); await loadCloudStatus();
    } catch (error) { toast(error.message, 'error'); }
    finally { $('uploadDropbox').textContent = 'Salva clip selezionata su Dropbox'; $('uploadDropbox').disabled = !(cloud?.dropbox?.connected && selectedArchiveClip && selectedArchiveClip.source !== 'sd'); }
  }

  async function exportSelectedClip() {
    if (!selectedArchiveClip) return toast('Seleziona prima una clip nella timeline.', 'error');
    try {
      const response = await fetch(archiveUrl(selectedArchiveClip)); if (!response.ok) throw new Error('Clip non raggiungibile');
      const blob = await response.blob(); const fileName = selectedArchiveClip.source === 'sd' ? selectedArchiveClip.name.replace(/\.h264$/i, '.mp4') : selectedArchiveClip.name; await shareMediaBlob(blob, fileName, 'Registrazione FREDI Control');
    } catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); }
  }

  function applyPreferences() {
    let theme = preferences.theme;
    if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('compact', Boolean(preferences.compact));
    $('themeSelect').value = preferences.theme; $('viewSelect').value = preferences.cameraView; $('compactInput').checked = Boolean(preferences.compact);
    $('cameraSort').value = preferences.cameraSort || 'custom'; $('favoriteFilter').setAttribute('aria-pressed', String(Boolean(preferences.favoritesOnly)));
    const meta = document.querySelector('meta[name="theme-color"]'); meta.content = theme === 'light' ? '#edf3f9' : '#07111f';
    setWorkspaceView(preferences.workspaceView || 'live', false);
  }

  async function persistPreferences() {
    applyPreferences(); renderView();
    try {
      const result = await gatewayFetch('/api/preferences', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ preferences }) });
      preferences = result.preferences; applyPreferences(); toast('Preferenze sincronizzate.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  function setView(view) {
    preferences.cameraView = view; renderView(); persistPreferences();
  }

  async function clearEvents() {
    if (!events.length || !confirm('Pulire la timeline del tuo account?')) return;
    try { await gatewayFetch('/api/events', { method:'DELETE' }); events = []; renderEvents(); toast('Timeline pulita.', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  }

  function openAccount() {
    renderAccount(); applyPreferences();
    $('currentPassword').value = ''; $('newPassword').value = ''; $('confirmNewPassword').value = ''; $('deleteAccountPassword').value = '';
    $('accountDialog').showModal();
  }

  async function changePassword() {
    const currentPassword = $('currentPassword').value; const newPassword = $('newPassword').value;
    if (newPassword.length < 12) return toast('La nuova password deve avere almeno 12 caratteri.', 'error');
    if (newPassword !== $('confirmNewPassword').value) return toast('Le nuove password non coincidono.', 'error');
    setLoading(true, 'Aggiornamento password…');
    try {
      const result = await gatewayFetch('/api/account/password', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ currentPassword, newPassword }) });
      auth = { token:result.token, expiresAt:result.expiresAt }; localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      $('currentPassword').value = ''; $('newPassword').value = ''; $('confirmNewPassword').value = '';
      toast('Password aggiornata. Le altre sessioni sono state revocate.', 'success');
    } catch (error) { toast(translateError(error.message), 'error'); }
    finally { setLoading(false); }
  }

  async function deleteAccount() {
    const password = $('deleteAccountPassword').value;
    if (!password) return toast('Inserisci la password per confermare.', 'error');
    if (!confirm('Eliminare definitivamente account, camere e vault? Questa azione non è annullabile.')) return;
    setLoading(true, 'Eliminazione account…');
    try { await gatewayFetch('/api/account', { method:'DELETE', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ password }) }); $('accountDialog').close(); logout(false); $('loginError').textContent = 'Account eliminato definitivamente.'; }
    catch (error) { toast(translateError(error.message), 'error'); }
    finally { setLoading(false); }
  }

  function bindEvents() {
    $('loginForm').addEventListener('submit', submitAuth);
    $('authModeButton').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
    $('loginPassword').addEventListener('input', updatePasswordMeter);
    document.querySelectorAll('[data-reveal]').forEach((button) => button.addEventListener('click', () => { const input = $(button.dataset.reveal); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? 'Mostra' : 'Nascondi'; }));
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
    document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => setCameraStep(button.dataset.step)));
    $('ptzInput').addEventListener('change', updatePtzFields);
    $('addCamera').addEventListener('click', () => openCameraDialog()); $('emptyAddCamera').addEventListener('click', () => openCameraDialog()); $('mobileAdd').addEventListener('click', () => openCameraDialog());
    $('editCurrent').addEventListener('click', () => openCameraDialog(activeId)); $('configureCurrent').addEventListener('click', () => openCameraDialog(activeId));
    $('saveSettings').addEventListener('click', saveCamera); $('deleteCamera').addEventListener('click', deleteCamera);
    $('testStreamSettings').addEventListener('click', async () => { setLoading(true, 'Verifica HLS…'); try { await testStreamValues($('streamInput').value.trim(), $('streamUsernameInput').value.trim(), $('streamPasswordInput').value); toast('Playlist HLS raggiungibile.', 'success'); } catch (error) { toast(error.name === 'AbortError' ? 'Verifica scaduta.' : error.message, 'error'); } finally { setLoading(false); } });
    $('testCurrent').addEventListener('click', testCurrentCamera); $('refreshButton').addEventListener('click', testCurrentCamera);
    $('advancedToggle').addEventListener('click', () => {
      const expanded = document.body.classList.toggle('advanced-open');
      $('advancedToggle').setAttribute('aria-expanded', String(expanded));
      $('advancedToggle').textContent = expanded ? 'Vista semplice' : 'Altre funzioni';
    });
    document.querySelectorAll('[data-workspace-view]').forEach((button) => button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView)));
    document.querySelectorAll('[data-scene]').forEach((button) => button.addEventListener('click', () => applyScene(button.dataset.scene)));
    document.querySelectorAll('[data-ptz]').forEach((button) => {
      button.addEventListener('pointerdown', (event) => startPtzHold(event, button));
      ['pointerup','pointercancel','lostpointercapture'].forEach((name) => button.addEventListener(name, stopPtzHold));
    });
    document.querySelectorAll('[data-ptz-step]').forEach((button) => button.addEventListener('click', () => { ptzStep = Number(button.dataset.ptzStep); document.querySelectorAll('[data-ptz-step]').forEach((item) => item.classList.toggle('active', item === button)); }));
    $('snapshotButton').addEventListener('click', snapshot); $('recordButton').addEventListener('click', toggleRecording);
    $('aiAnalyze').addEventListener('click', analyzeCurrentFrame);
    $('aiPromptPreset').addEventListener('change', () => { $('aiQuestion').hidden = $('aiPromptPreset').value !== 'custom'; if (!$('aiQuestion').hidden) $('aiQuestion').focus(); });
    $('trackingToggle').addEventListener('click', togglePersonTracking);
    $('trackingSensitivity').addEventListener('change', () => trackingEnabled && toast('Sensibilità inseguimento aggiornata.', 'success'));
    $('muteButton').addEventListener('click', () => { player.muted = !player.muted; $('muteButton').classList.toggle('unmuted', !player.muted); });
    $('zoomOut').addEventListener('click', () => setDigitalZoom((currentCamera()?.digitalZoom || 1) - .25));
    $('zoomReset').addEventListener('click', () => setDigitalZoom(1));
    $('zoomIn').addEventListener('click', () => setDigitalZoom((currentCamera()?.digitalZoom || 1) + .25));
    $('stage').addEventListener('wheel', (event) => { if (!$('stage').classList.contains('playing')) return; event.preventDefault(); setDigitalZoom((currentCamera()?.digitalZoom || 1) + (event.deltaY < 0 ? .25 : -.25)); }, { passive:false });
    $('lightFeature').addEventListener('click', () => cycleDeviceFeature('light'));
    $('nightVisionFeature').addEventListener('click', () => cycleDeviceFeature('nightVision'));
    $('guardFeature').addEventListener('click', () => cycleDeviceFeature('alarm'));
    $('nativeTrackingFeature').addEventListener('click', () => cycleDeviceFeature('tracking'));
    document.querySelectorAll('[data-device-zoom]').forEach((button) => {
      button.addEventListener('pointerdown', (event) => { event.preventDefault(); sendOpticalZoom(button.dataset.deviceZoom); });
      if (button.dataset.deviceZoom !== 'stop') ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => button.addEventListener(name, () => sendOpticalZoom('stop')));
    });
    $('nativeSdMode').addEventListener('change', changeNativeSdMode);
    $('notificationMaster').addEventListener('click', toggleNotifications);
    ['notifyPerson','notifyAnimal','notifyVehicle'].forEach((id) => $(id).addEventListener('change', saveNotificationTypes));
    $('fullButton').addEventListener('click', () => $('stage').requestFullscreen?.());
    $('rotateButton').addEventListener('click', toggleOrientation); $('orientationFeature').addEventListener('click', toggleOrientation);
    $('shareCamera').addEventListener('click', shareCurrentCamera);
    $('talkFeature').addEventListener('pointerdown', startTalking);
    ['pointerup','pointercancel','pointerleave','lostpointercapture'].forEach((name) => $('talkFeature').addEventListener(name, stopTalking));
    $('favoriteCurrent').addEventListener('click', toggleFavorite);
    $('favoriteFilter').addEventListener('click', () => { preferences.favoritesOnly = !preferences.favoritesOnly; renderStats(); renderSwitcher(); renderGrid(); persistPreferences(); });
    $('cameraSort').addEventListener('change', () => { preferences.cameraSort = $('cameraSort').value; renderSwitcher(); renderGrid(); persistPreferences(); });
    $('qualitySelect').addEventListener('change', () => {
      selectedQuality = $('qualitySelect').value;
      const camera = currentCamera();
      if (camera?.streamUrl) { disconnectStream(); connectStream(camera); }
    });
    $('timelineDate').addEventListener('change', () => loadArchive(activeId));
    document.querySelectorAll('[data-timeline-filter]').forEach((button) => button.addEventListener('click', () => { timelineFilter = button.dataset.timelineFilter; document.querySelectorAll('[data-timeline-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderPlaybackTimeline(); }));
    $('timelineSearch').addEventListener('input', () => { timelineSearch = $('timelineSearch').value.trim().toLowerCase(); renderPlaybackTimeline(); });
    $('insightPeak').addEventListener('click', () => { const seconds = Number($('insightPeak').dataset.seconds); if (!Number.isFinite(seconds)) return; $('timelineScrubber').value = String(seconds); updateTimelineTime(seconds); seekArchiveSeconds(seconds); });
    $('timelineRail').addEventListener('click', seekTimeline);
    $('timelineScrubber').addEventListener('input', () => updateTimelineTime());
    $('timelineScrubber').addEventListener('change', () => seekArchiveSeconds(Number($('timelineScrubber').value)));
    $('returnLive').addEventListener('click', returnToLive);
    $('cloudSource').addEventListener('click', () => document.querySelector('.cloud-panel').scrollIntoView({ behavior:'smooth', block:'center' }));
    $('localSource').addEventListener('click', () => { archiveSource = 'local'; $('localSource').classList.add('active'); $('sdSource').classList.remove('active'); loadArchive(activeId); });
    $('sdSource').addEventListener('click', selectSdArchive);
    $('sdRecordToggle').addEventListener('click', toggleSdRecording);
    $('sdRefresh').addEventListener('click', () => { archiveSource = 'sd'; $('sdSource').classList.add('active'); $('localSource').classList.remove('active'); loadArchive(activeId); });
    $('sdDeleteClip').addEventListener('click', deleteSelectedSdClip);
    $('sdRetention').addEventListener('change', saveSdRetention);
    document.querySelectorAll('[data-media-filter]').forEach((button) => button.addEventListener('click', () => { mediaFilter = button.dataset.mediaFilter; document.querySelectorAll('[data-media-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderMediaLibrary(); }));
    $('trimStart').addEventListener('input', () => updateTrimControls('start')); $('trimEnd').addEventListener('input', () => updateTrimControls('end'));
    $('mediaShare').addEventListener('click', shareViewedMedia); $('mediaTrimExport').addEventListener('click', exportTrimmedMedia); $('mediaDelete').addEventListener('click', deleteSelectedSdClip);
    $('mediaDialog').addEventListener('close', () => { $('mediaViewerVideo').pause(); $('mediaViewerVideo').removeAttribute('src'); $('mediaViewerImage').removeAttribute('src'); mediaViewerClip = null; });
    $('dropboxConnect').addEventListener('click', toggleDropboxConnection);
    $('dropboxAuto').addEventListener('change', () => setDropboxSettings($('dropboxAuto')));
    $('dropboxSnapshots').addEventListener('change', () => setDropboxSettings($('dropboxSnapshots')));
    $('cloudRecord').addEventListener('click', recordDropboxFragment);
    $('uploadDropbox').addEventListener('click', uploadSelectedDropbox);
    $('exportClip').addEventListener('click', exportSelectedClip);
    $('stage').addEventListener('pointerdown', beginGesture);
    $('stage').addEventListener('pointermove', moveGesture);
    $('stage').addEventListener('pointerup', finishGesture);
    $('stage').addEventListener('pointercancel', () => { gestureStart = null; $('gestureHint').hidden = true; });
    $('recordingList').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-recording]'); if (button) deleteRecording(button.dataset.deleteRecording); });
    player.addEventListener('playing', () => {
      lastPlaybackTime = player.currentTime; lastPlaybackProgressAt = Date.now();
      setVideoLoading(false); $('stage').classList.add('playing'); $('cameraStatusDot').classList.add('live'); $('liveTag').className = 'live-badge live'; $('liveTag').textContent = archivePlayback ? 'ARCHIVIO' : liveTransport || 'LIVE';
      updateTrackingAvailability();
      if (!archivePlayback) startMotionDetection();
      const camera = currentCamera(); if (camera && !healthByCamera.has(camera.id)) { healthByCamera.set(camera.id, { ok:true, latency:Math.max(1, Math.round(performance.now() - streamConnectStarted)), checkedAt:Date.now() }); updateFocusedCameraStatus(camera); }
    });
    player.addEventListener('error', () => {
      if (archivePlayback) { setVideoLoading(false); offline('Clip non riproducibile.', 'Il link potrebbe essere scaduto: ricarica la timeline.'); return; }
      const activeCamera = currentCamera();
      if (activeCamera && (hls || hlsRecovering)) {
        scheduleHlsReconnect(activeCamera, streamGeneration, 'errore elemento video');
        return;
      }
      const camera = currentCamera(); if (camera) { healthByCamera.set(camera.id, { ok:false, latency:0, checkedAt:Date.now() }); updateFocusedCameraStatus(camera); }
      setVideoLoading(false); offline('Errore di riproduzione.', 'Controlla il codec e il gateway HLS.');
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPtzHold(); if (trackingEnabled) stopPersonTracking('Pagina non visibile: inseguimento arrestato.', true); } });
    player.addEventListener('timeupdate', () => {
      notePlaybackProgress();
      if (!archivePlayback || !selectedArchiveClip) return;
      const start = new Date(selectedArchiveClip.start); const seconds = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds() + player.currentTime;
      $('timelineScrubber').value = String(Math.min(86399, Math.round(seconds))); updateTimelineTime(seconds);
    });
    ['loadeddata','progress'].forEach((name) => player.addEventListener(name, notePlaybackProgress));
    setInterval(recoverStalledPlayback, 2000);
    $('viewFocus').addEventListener('click', () => setView('focus')); $('viewGrid').addEventListener('click', () => setView('grid'));
    $('globalSearch').addEventListener('input', (event) => { searchText = event.target.value.trim().toLowerCase(); renderStats(); renderSwitcher(); renderGrid(); });
    $('clearEvents').addEventListener('click', clearEvents);
    $('accountButton').addEventListener('click', openAccount); $('mobileAccount').addEventListener('click', openAccount); $('logoutButton').addEventListener('click', () => { $('accountDialog').close(); logout(); });
    $('savePreferences').addEventListener('click', () => { preferences.theme = $('themeSelect').value; preferences.cameraView = $('viewSelect').value; preferences.compact = $('compactInput').checked; persistPreferences(); });
    $('themeButton').addEventListener('click', () => { preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; persistPreferences(); });
    $('changePassword').addEventListener('click', changePassword); $('deleteAccount').addEventListener('click', deleteAccount);
    $('mobileCameras').addEventListener('click', () => window.scrollTo({ top:document.querySelector('.section-head').offsetTop - 75, behavior:'smooth' }));
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !event.target.matches('input,textarea,select')) { event.preventDefault(); $('globalSearch').focus(); return; }
      if (event.key === 'Escape') { const dialogs = [...document.querySelectorAll('dialog[open]')]; dialogs.forEach((dialog) => dialog.close()); if (!dialogs.length) { stopPtzHold(); sendPtz('stop', ptzStep, { continuous:true, quiet:true }); } return; }
      if (event.target.matches('input,textarea,select,button') || document.querySelector('dialog[open]')) return;
      const actions = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right' };
      if (actions[event.key]) { event.preventDefault(); if (!event.repeat) sendPtz(actions[event.key], ptzStep, { continuous:true, quiet:true }); }
    });
    document.addEventListener('keyup', (event) => { if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) sendPtz('stop', ptzStep, { continuous:true, quiet:true }); });
    window.addEventListener('blur', () => stopPtzHold());
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; $('installButton').hidden = false; });
    $('installButton').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $('installButton').hidden = true; });
    window.addEventListener('online', () => setConnection('', 'Vault sincronizzato')); window.addEventListener('offline', () => setConnection('error', 'Browser offline'));
  }

  async function bootstrap() {
    bindEvents(); setAuthMode('login'); $('loginUsername').value = localStorage.getItem(LAST_USER_KEY) || '';
    $('timelineDate').value = localDateKey(); const now = new Date(); $('timelineScrubber').value = String(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()); updateTimelineTime(); updateLiveClock(); setInterval(updateLiveClock, 1000);
    if (auth?.token) {
      try { await enterDashboard(); return; } catch { logout(false); }
    }
    $('authGate').hidden = false; $('appShell').hidden = true;
  }

  bootstrap();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
