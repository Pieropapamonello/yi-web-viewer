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
  let preferences = { theme:'dark', cameraView:'focus', compact:false, cameraSort:'custom', favoritesOnly:false };
  let activeId = '';
  let editingId = '';
  let authMode = 'login';
  let searchText = '';
  let hls = null;
  let peerConnection = null;
  let whepResourceUrl = '';
  let whepAuthorization = '';
  let streamGeneration = 0;
  let liveTransport = '';
  let mediaRecorder = null;
  let chunks = [];
  let recordingAnimation = 0;
  let recordingStream = null;
  let toastTimer = null;
  let deferredInstallPrompt = null;
  let draggedId = '';
  let recordingUrls = [];
  let ptzStep = 12;
  let selectedQuality = 'auto';
  let gestureStart = null;
  let motionTimer = null;
  let previousMotionFrame = null;
  let motionCooldownUntil = 0;
  let suppressMotionUntil = 0;
  let archiveClips = [];
  let selectedArchiveClip = null;
  let archivePlayback = false;
  let cloud = null;
  let aiReady = false;
  const healthByCamera = new Map();
  let streamConnectStarted = 0;

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

  async function gatewayFetch(path, options = {}) {
    const response = await fetch(`${gatewayBase}${path}`, {
      ...options,
      cache:'no-store',
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
      const response = await fetch(`${gatewayBase}${path}`, { method:'POST', cache:'no-store', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
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
    player.classList.toggle('rotated', rotated);
    $('orientationState').textContent = rotated ? 'Ruotata 180°' : 'Normale';
    $('rotateButton').classList.toggle('active', rotated);
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

  async function loadCapabilities(camera) {
    $('capabilityState').textContent = 'Verifica…';
    if (!camera?.apiBaseUrl || !camera.apiToken) { $('capabilityState').textContent = 'Locale'; return; }
    try {
      const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/capabilities`, { cache:'no-store', headers:{ Authorization:`Bearer ${camera.apiToken}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gateway non raggiungibile');
      $('capabilityState').textContent = result.protocol === 'ipc365-local' ? 'IPC365' : 'Gateway';
      $('capabilityHint').textContent = 'Live, audio, PTZ, snapshot e registrazione locale disponibili. Talk, luce, guardia e playback richiedono una nuova cattura.';
    } catch { $('capabilityState').textContent = 'Non verificato'; }
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
      const result = await gatewayFetch('/api/ai/analyze', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ cameraId:camera.id, image }),
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

  function derivedLowStreamUrl(camera) {
    if (camera?.streamLowUrl) return camera.streamLowUrl;
    return String(camera?.streamUrl || '').replace('/ipc365/', '/ipc365-low/');
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
    applyOrientation(camera);
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
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    stopMotionDetection();
    hls?.destroy(); hls = null;
    stopWebRtc();
    player.pause(); player.srcObject = null; player.removeAttribute('src'); player.load();
    $('stage').classList.remove('playing', 'archive');
    $('cameraStatusDot').classList.remove('live');
    $('liveTag').className = 'live-badge'; $('liveTag').textContent = 'OFFLINE';
    setVideoLoading(false);
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
    liveTransport = 'HLS';
    player.srcObject = null;
    const authorization = basicAuthorization(camera);
    const sourceUrl = selectedQuality === 'low' ? derivedLowStreamUrl(camera) : camera.streamUrl;
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode:true, liveSyncDurationCount:1, liveMaxLatencyDurationCount:2, maxLiveSyncPlaybackRate:2, maxBufferLength:2, maxMaxBufferLength:4, backBufferLength:3, xhrSetup:(xhr) => { if (authorization) xhr.setRequestHeader('Authorization', authorization); } });
      hls.loadSource(sourceUrl); hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { renderQualityLevels(camera); player.play().catch(() => { setVideoLoading(false); toast('Tocca il video per avviare il live.'); }); });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal && generation === streamGeneration) { healthByCamera.set(camera.id, { ok:false, latency:0, checkedAt:Date.now() }); updateFocusedCameraStatus(camera); setVideoLoading(false); offline('Live non raggiungibile.', 'Controlla URL, CORS e credenziali HLS.'); } });
    } else if (player.canPlayType('application/vnd.apple.mpegurl') && !authorization) {
      player.src = sourceUrl; player.play().catch(() => setVideoLoading(false));
    } else {
      setVideoLoading(false); offline('HLS autenticato non supportato.', 'Prova un browser compatibile con hls.js.');
    }
  }

  function offline(title, detail) {
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
    const dayEvents = events.filter((item) => localDateKey(new Date(item.createdAt)) === selected);
    const clipMarkup = archiveClips.map((clip, index) => {
      const start = new Date(clip.start);
      const seconds = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds();
      const left = seconds / 86400 * 100;
      const width = Math.max(.28, Number(clip.duration || 60) / 86400 * 100);
      return `<button class="archive-segment" style="left:${left}%;width:${width}%" data-archive-index="${index}" title="Registrazione ${escapeHtml(start.toLocaleTimeString('it-IT'))}"></button>`;
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
    if (!dayEvents.length && !archiveClips.length) $('timelineSelection').textContent = 'Nessuna registrazione o evento in questa giornata.';
  }

  function archiveUrl(clip) {
    return `${gatewayBase}/api/archive/file?access=${encodeURIComponent(clip.access)}`;
  }

  async function loadArchive(cameraId = activeId) {
    if (!cameraId || !$('timelineDate').value) return;
    $('archiveState').textContent = 'Caricamento…';
    try {
      const result = await gatewayFetch(`/api/archive?cameraId=${encodeURIComponent(cameraId)}&date=${encodeURIComponent($('timelineDate').value)}`);
      if (cameraId !== activeId) return;
      archiveClips = result.clips || [];
      $('archiveState').textContent = archiveClips.length ? `${archiveClips.length} clip · ${formatBytes(result.usage || 0)}` : 'Nessuna clip';
      $('localArchiveState').textContent = `${result.retentionDays || 7} giorni · ${archiveClips.length} clip nel giorno`;
    } catch (error) {
      archiveClips = []; $('archiveState').textContent = 'Archivio non raggiungibile'; $('localArchiveState').textContent = error.message;
    }
    selectedArchiveClip = null; $('uploadDropbox').disabled = true; renderPlaybackTimeline();
  }

  function selectArchiveClip(clip, offsetSeconds = 0) {
    if (!clip) return;
    const camera = currentCamera(); if (!camera) return;
    selectedArchiveClip = clip; archivePlayback = true;
    disconnectStream(); archivePlayback = true;
    player.src = archiveUrl(clip);
    player.addEventListener('loadedmetadata', () => { player.currentTime = Math.min(Math.max(0, offsetSeconds), Math.max(0, player.duration - .2)); player.play().catch(() => {}); }, { once:true });
    $('stage').classList.add('playing', 'archive'); $('qualitySelect').disabled = true; $('returnLive').hidden = false; $('uploadDropbox').disabled = !cloud?.dropbox?.connected;
    const start = new Date(clip.start);
    $('timelineSelection').innerHTML = `<b>Riproduzione ${escapeHtml(start.toLocaleString('it-IT'))}</b><br>${Math.round(clip.duration || 60)} secondi · ${escapeHtml(formatBytes(clip.size || 0))}`;
  }

  function returnToLive() {
    const camera = currentCamera(); archivePlayback = false; selectedArchiveClip = null; $('stage').classList.remove('archive'); $('returnLive').hidden = true; $('uploadDropbox').disabled = true; renderQualityLevels(camera);
    disconnectStream(); if (camera?.streamUrl) connectStream(camera);
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
    const camera = cameras.find((item) => item.id === id) || { name:'', model:'', location:'', notes:'', favorite:false, webrtcUrl:'', streamUrl:'', streamLowUrl:'', streamUsername:'', streamPassword:'', apiBaseUrl:'', apiToken:'', ptz:false, motionDetection:true };
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

  async function sendPtz(action, step = ptzStep) {
    const camera = currentCamera();
    if (!camera?.ptz || !camera.apiBaseUrl || !camera.apiToken) return toast('PTZ non configurato per questa camera.', 'error');
    try {
      suppressMotionUntil = Date.now() + 6000;
      navigator.vibrate?.(18);
      snapToLiveEdge();
      [150, 450, 900, 1600].forEach((delay) => setTimeout(snapToLiveEdge, delay));
      const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/ptz`, { method:'POST', cache:'no-store', keepalive:true, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${camera.apiToken}` }, body:JSON.stringify({ action, step }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || result.error || 'Comando rifiutato.');
      toast(`Movimento ${action} · intensità ${result.step || step}.`, 'success');
    } catch (error) { toast(error.message, 'error'); }
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
    if (distance < 34) return;
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
    canvas.toBlob((blob) => {
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${slug(camera.name)}-${fileTimestamp(capturedAt)}.jpg`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000); $('snapshotState').textContent = capturedAt.toLocaleString('it-IT'); recordActivity('snapshot', 'Snapshot acquisito', `${camera.name}: immagine del ${capturedAt.toLocaleString('it-IT')} salvata sul dispositivo.`); toast('Snapshot con data e ora scaricato.', 'success');
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
    if (!HTMLCanvasElement.prototype.captureStream || player.paused) return toast('Avvia il live in un browser compatibile prima di registrare.', 'error');
    if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); return; }
    try {
      const camera = currentCamera();
      const canvas = document.createElement('canvas'); canvas.width = player.videoWidth; canvas.height = player.videoHeight;
      const renderFrame = () => { drawStampedFrame(canvas, new Date(), camera); recordingAnimation = requestAnimationFrame(renderFrame); };
      renderFrame();
      recordingStream = canvas.captureStream(25);
      const sourceStream = player.captureStream?.();
      sourceStream?.getAudioTracks().forEach((track) => recordingStream.addTrack(track.clone()));
      const preferredMime = MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
      chunks = []; mediaRecorder = new MediaRecorder(recordingStream, { mimeType:preferredMime });
      mediaRecorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      mediaRecorder.onstart = () => { $('recordButton').classList.add('recording'); $('recordButton').querySelector('span').textContent = 'Ferma'; };
      mediaRecorder.onstop = () => {
        cancelAnimationFrame(recordingAnimation); recordingAnimation = 0;
        recordingStream?.getTracks().forEach((track) => track.stop()); recordingStream = null;
        $('recordButton').classList.remove('recording'); $('recordButton').querySelector('span').textContent = 'Registra';
        addRecording(new Blob(chunks, { type:preferredMime }), camera);
      };
      mediaRecorder.start(1000);
    } catch {
      cancelAnimationFrame(recordingAnimation); recordingAnimation = 0;
      recordingStream?.getTracks().forEach((track) => track.stop()); recordingStream = null;
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

  async function addRecording(blob, recordedCamera = currentCamera()) {
    const camera = recordedCamera; if (!camera) return;
    try { await saveRecording(blob, camera); await loadRecordings(camera.id); await updateStorageEstimate(); recordActivity('clip', 'Registrazione salvata', `${camera.name}: clip locale da ${formatBytes(blob.size)}.`); toast('Clip salvata in modo persistente su questo dispositivo.', 'success'); }
    catch { toast('Impossibile salvare la clip: controlla lo spazio disponibile.', 'error'); }
  }

  async function loadCloudStatus() {
    try {
      cloud = await gatewayFetch('/api/cloud');
      const dropbox = cloud.dropbox || {};
      $('cloudState').textContent = dropbox.connected ? 'Dropbox attivo' : 'Locale';
      $('dropboxState').textContent = dropbox.connected ? `${dropbox.account || 'Account collegato'}${dropbox.lastError ? ' · errore backup' : ''}` : dropbox.configured ? 'Pronto per il collegamento' : 'App Dropbox da configurare';
      $('dropboxConnect').textContent = dropbox.connected ? 'Scollega' : 'Collega';
      $('dropboxAuto').disabled = !dropbox.connected; $('dropboxAuto').checked = Boolean(dropbox.autoBackup);
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

  async function setDropboxAuto() {
    try {
      cloud = await gatewayFetch('/api/cloud/dropbox/settings', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ autoBackup:$('dropboxAuto').checked }) });
      await loadCloudStatus(); toast($('dropboxAuto').checked ? 'Backup Dropbox automatico attivato.' : 'Backup automatico disattivato.', 'success');
    } catch (error) { $('dropboxAuto').checked = !$('dropboxAuto').checked; toast(error.message, 'error'); }
  }

  async function uploadSelectedDropbox() {
    const camera = currentCamera(); if (!camera || !selectedArchiveClip) return toast('Seleziona prima una clip nella timeline.', 'error');
    $('uploadDropbox').disabled = true; $('uploadDropbox').textContent = 'Caricamento…';
    try {
      await gatewayFetch('/api/cloud/dropbox/upload', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ cameraId:camera.id, name:selectedArchiveClip.name }) });
      toast('Clip salvata su Dropbox.', 'success'); await loadCloudStatus();
    } catch (error) { toast(error.message, 'error'); }
    finally { $('uploadDropbox').textContent = 'Salva clip selezionata su Dropbox'; $('uploadDropbox').disabled = !(cloud?.dropbox?.connected && selectedArchiveClip); }
  }

  async function exportSelectedClip() {
    if (!selectedArchiveClip) return toast('Seleziona prima una clip nella timeline.', 'error');
    try {
      const response = await fetch(archiveUrl(selectedArchiveClip)); if (!response.ok) throw new Error('Clip non raggiungibile');
      const blob = await response.blob(); const file = new File([blob], selectedArchiveClip.name, { type:'video/mp4' });
      if (navigator.canShare?.({ files:[file] })) await navigator.share({ title:'Registrazione FREDI Control', files:[file] });
      else { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
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
    document.querySelectorAll('[data-ptz]').forEach((button) => button.addEventListener('pointerdown', (event) => { event.preventDefault(); sendPtz(button.dataset.ptz); }));
    document.querySelectorAll('[data-ptz-step]').forEach((button) => button.addEventListener('click', () => { ptzStep = Number(button.dataset.ptzStep); document.querySelectorAll('[data-ptz-step]').forEach((item) => item.classList.toggle('active', item === button)); }));
    $('snapshotButton').addEventListener('click', snapshot); $('recordButton').addEventListener('click', toggleRecording);
    $('aiAnalyze').addEventListener('click', analyzeCurrentFrame);
    $('muteButton').addEventListener('click', () => { player.muted = !player.muted; $('muteButton').classList.toggle('unmuted', !player.muted); });
    $('fullButton').addEventListener('click', () => $('stage').requestFullscreen?.());
    $('rotateButton').addEventListener('click', toggleOrientation); $('orientationFeature').addEventListener('click', toggleOrientation);
    $('shareCamera').addEventListener('click', shareCurrentCamera);
    $('favoriteCurrent').addEventListener('click', toggleFavorite);
    $('favoriteFilter').addEventListener('click', () => { preferences.favoritesOnly = !preferences.favoritesOnly; renderStats(); renderSwitcher(); renderGrid(); persistPreferences(); });
    $('cameraSort').addEventListener('change', () => { preferences.cameraSort = $('cameraSort').value; renderSwitcher(); renderGrid(); persistPreferences(); });
    $('qualitySelect').addEventListener('change', () => {
      selectedQuality = $('qualitySelect').value;
      const camera = currentCamera();
      if (camera?.streamUrl) { disconnectStream(); connectStream(camera); }
    });
    $('timelineDate').addEventListener('change', () => loadArchive(activeId));
    $('timelineRail').addEventListener('click', seekTimeline);
    $('timelineScrubber').addEventListener('input', () => updateTimelineTime());
    $('timelineScrubber').addEventListener('change', () => seekArchiveSeconds(Number($('timelineScrubber').value)));
    $('returnLive').addEventListener('click', returnToLive);
    $('cloudSource').addEventListener('click', () => document.querySelector('.cloud-panel').scrollIntoView({ behavior:'smooth', block:'center' }));
    $('dropboxConnect').addEventListener('click', toggleDropboxConnection);
    $('dropboxAuto').addEventListener('change', setDropboxAuto);
    $('uploadDropbox').addEventListener('click', uploadSelectedDropbox);
    $('exportClip').addEventListener('click', exportSelectedClip);
    $('stage').addEventListener('pointerdown', beginGesture);
    $('stage').addEventListener('pointermove', moveGesture);
    $('stage').addEventListener('pointerup', finishGesture);
    $('stage').addEventListener('pointercancel', () => { gestureStart = null; $('gestureHint').hidden = true; });
    $('recordingList').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-recording]'); if (button) deleteRecording(button.dataset.deleteRecording); });
    player.addEventListener('playing', () => {
      setVideoLoading(false); $('stage').classList.add('playing'); $('cameraStatusDot').classList.add('live'); $('liveTag').className = 'live-badge live'; $('liveTag').textContent = archivePlayback ? 'ARCHIVIO' : liveTransport || 'LIVE';
      if (!archivePlayback) startMotionDetection();
      const camera = currentCamera(); if (camera && !healthByCamera.has(camera.id)) { healthByCamera.set(camera.id, { ok:true, latency:Math.max(1, Math.round(performance.now() - streamConnectStarted)), checkedAt:Date.now() }); updateFocusedCameraStatus(camera); }
    });
    player.addEventListener('error', () => {
      if (archivePlayback) { setVideoLoading(false); offline('Clip non riproducibile.', 'Il link potrebbe essere scaduto: ricarica la timeline.'); return; }
      const camera = currentCamera(); if (camera) { healthByCamera.set(camera.id, { ok:false, latency:0, checkedAt:Date.now() }); updateFocusedCameraStatus(camera); }
      setVideoLoading(false); offline('Errore di riproduzione.', 'Controlla il codec e il gateway HLS.');
    });
    player.addEventListener('timeupdate', () => {
      if (!archivePlayback || !selectedArchiveClip) return;
      const start = new Date(selectedArchiveClip.start); const seconds = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds() + player.currentTime;
      $('timelineScrubber').value = String(Math.min(86399, Math.round(seconds))); updateTimelineTime(seconds);
    });
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
      if (event.key === 'Escape') { const dialogs = [...document.querySelectorAll('dialog[open]')]; dialogs.forEach((dialog) => dialog.close()); if (!dialogs.length) sendPtz('stop'); return; }
      if (event.target.matches('input,textarea,select,button') || document.querySelector('dialog[open]')) return;
      const actions = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right' };
      if (actions[event.key]) { event.preventDefault(); sendPtz(actions[event.key]); }
    });
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
