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
  let preferences = { theme:'dark', cameraView:'focus', compact:false };
  let activeId = '';
  let editingId = '';
  let authMode = 'login';
  let searchText = '';
  let hls = null;
  let mediaRecorder = null;
  let chunks = [];
  let toastTimer = null;
  let deferredInstallPrompt = null;
  let draggedId = '';
  let recordingUrls = [];

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
    if (!searchText) return cameras;
    return cameras.filter((camera) => `${camera.name} ${camera.model}`.toLowerCase().includes(searchText));
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

  function renderQualityLevels() {
    const select = $('qualitySelect');
    select.innerHTML = '<option value="-1">Auto</option>';
    (hls?.levels || []).forEach((level, index) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = level.height ? `${level.height}p` : level.bitrate ? `${Math.round(level.bitrate / 1000)} kb/s` : `Livello ${index + 1}`;
      select.append(option);
    });
    select.disabled = (hls?.levels || []).length < 2;
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
    $('cameraCountLabel').textContent = cameras.length === 1 ? '1 camera nel vault' : `${cameras.length} camere nel vault`;
  }

  function renderSwitcher() {
    const container = $('cameraSwitcher');
    container.innerHTML = '';
    for (const camera of filteredCameras()) {
      const wrap = document.createElement('div');
      wrap.className = 'camera-chip-wrap';
      wrap.draggable = true;
      wrap.dataset.id = camera.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `camera-chip${camera.id === activeId ? ' active' : ''}`;
      button.innerHTML = `<b>${camera.streamUrl ? '●' : '○'} ${escapeHtml(camera.name)}</b><span>${escapeHtml(camera.model || 'Nessun modello')}</span>`;
      button.addEventListener('click', () => selectCamera(camera.id));
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'camera-chip-edit'; edit.title = `Modifica ${camera.name}`; edit.innerHTML = icon('edit');
      edit.addEventListener('click', () => openCameraDialog(camera.id));
      bindDrag(wrap);
      wrap.append(button, edit); container.append(wrap);
    }
  }

  function renderGrid() {
    const container = $('gridView');
    container.innerHTML = '';
    for (const camera of filteredCameras()) {
      const card = document.createElement('article');
      card.className = 'grid-card'; card.draggable = true; card.dataset.id = camera.id;
      card.innerHTML = `<div class="grid-preview">${icon('camera')}</div><div class="grid-card-body"><div class="grid-card-head"><div><h3>${escapeHtml(camera.name)}</h3><p>${escapeHtml(camera.model || 'Modello non indicato')}</p></div><span class="live-badge">${camera.streamUrl ? 'PRONTA' : 'SETUP'}</span></div><div class="grid-tags"><span class="tag ${camera.streamUrl ? 'ok' : ''}">${camera.streamUrl ? 'HLS' : 'NO VIDEO'}</span><span class="tag ${camera.ptz && camera.apiToken ? 'ok' : ''}">${camera.ptz ? 'PTZ' : 'SOLO VIDEO'}</span><span class="tag">VAULT</span></div><div class="grid-actions"><button class="button secondary" data-open="${camera.id}">${icon('focus')} Apri</button><button class="button ghost" data-edit="${camera.id}">${icon('edit')} Modifica</button><button class="button ghost" data-copy="${camera.id}" title="Duplica">Copia</button></div></div>`;
      card.querySelector('[data-open]').addEventListener('click', () => { setView('focus'); selectCamera(camera.id); });
      card.querySelector('[data-edit]').addEventListener('click', () => openCameraDialog(camera.id));
      card.querySelector('[data-copy]').addEventListener('click', () => duplicateCamera(camera.id));
      bindDrag(card); container.append(card);
    }
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
    $('cameraName').textContent = camera.name;
    $('cameraMeta').textContent = camera.model || 'Modello non specificato';
    $('detailVideo').textContent = camera.streamUrl ? 'HLS configurato' : 'Non configurato';
    $('detailPtz').textContent = camera.ptz && camera.apiBaseUrl && camera.apiToken ? 'Attivo' : 'Non configurato';
    $('detailCredentials').textContent = camera.streamUsername ? 'Basic Auth' : 'Nessuna';
    const ptzReady = camera.ptz && camera.apiBaseUrl && camera.apiToken;
    $('ptzState').textContent = ptzReady ? 'Pronto' : 'Non configurato';
    document.querySelectorAll('[data-ptz]').forEach((button) => { button.disabled = !ptzReady; });
    applyOrientation(camera);
    loadCapabilities(camera);
    loadRecordings(camera.id);
    if (camera.streamUrl) connectStream(camera); else offline('Sorgente video non configurata.', 'Apri le impostazioni e inserisci un URL HLS HTTPS.');
  }

  function setVideoLoading(show) {
    $('videoLoading').hidden = !show;
  }

  function disconnectStream() {
    hls?.destroy(); hls = null;
    player.pause(); player.removeAttribute('src'); player.load();
    $('stage').classList.remove('playing');
    $('cameraStatusDot').classList.remove('live');
    $('liveTag').className = 'live-badge'; $('liveTag').textContent = 'OFFLINE';
    setVideoLoading(false);
  }

  function connectStream(camera) {
    setVideoLoading(true);
    $('emptyTitle').textContent = 'Connessione in corso';
    $('emptyText').textContent = 'Il gateway sta preparando il flusso live.';
    const authorization = camera.streamUsername && camera.streamPassword ? `Basic ${btoa(`${camera.streamUsername}:${camera.streamPassword}`)}` : '';
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode:true, liveSyncDurationCount:2, backBufferLength:10, xhrSetup:(xhr) => { if (authorization) xhr.setRequestHeader('Authorization', authorization); } });
      hls.loadSource(camera.streamUrl); hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { renderQualityLevels(); player.play().catch(() => { setVideoLoading(false); toast('Tocca il video per avviare il live.'); }); });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) { setVideoLoading(false); offline('Live non raggiungibile.', 'Controlla URL, CORS e credenziali HLS.'); } });
    } else if (player.canPlayType('application/vnd.apple.mpegurl') && !authorization) {
      player.src = camera.streamUrl; player.play().catch(() => setVideoLoading(false));
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
    if (!events.length) { container.innerHTML = '<div class="recording-empty"><p>Nessuna attività recente.</p></div>'; return; }
    container.innerHTML = events.slice(0, 8).map((item) => {
      const date = new Date(item.createdAt);
      return `<div class="event-row"><i class="event-dot ${escapeHtml(item.type)}"></i><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div><time title="${escapeHtml(date.toLocaleString('it-IT'))}">${escapeHtml(relativeTime(date))}</time></div>`;
    }).join('');
  }

  function relativeTime(date) {
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'ora'; if (seconds < 3600) return `${Math.floor(seconds / 60)} min`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`; return `${Math.floor(seconds / 86400)} g`;
  }

  function openCameraDialog(id = '') {
    editingId = id;
    const camera = cameras.find((item) => item.id === id) || { name:'', model:'', streamUrl:'', streamUsername:'', streamPassword:'', apiBaseUrl:'', apiToken:'', ptz:false };
    $('settingsTitle').textContent = id ? `Modifica ${camera.name}` : 'Aggiungi camera';
    $('nameInput').value = camera.name; $('modelInput').value = camera.model || '';
    $('streamInput').value = camera.streamUrl || ''; $('streamUsernameInput').value = camera.streamUsername || ''; $('streamPasswordInput').value = camera.streamPassword || '';
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
      id:editingId || crypto.randomUUID(), name, model:$('modelInput').value.trim(), streamUrl:$('streamInput').value.trim(),
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
    try {
      if (camera.streamUrl) await testStreamValues(camera.streamUrl, camera.streamUsername, camera.streamPassword);
      if (camera.ptz && camera.apiBaseUrl) {
        const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/health`, { cache:'no-store' });
        if (!response.ok) throw new Error(`Gateway PTZ non raggiungibile (${response.status}).`);
      }
      toast('Configurazione raggiungibile.', 'success');
    } catch (error) { toast(error.name === 'AbortError' ? 'Verifica scaduta: gateway troppo lento.' : error.message, 'error'); }
    finally { setLoading(false); }
  }

  async function sendPtz(action) {
    const camera = currentCamera();
    if (!camera?.ptz || !camera.apiBaseUrl || !camera.apiToken) return toast('PTZ non configurato per questa camera.', 'error');
    try {
      const response = await fetch(`${camera.apiBaseUrl.replace(/\/$/, '')}/api/ptz`, { method:'POST', cache:'no-store', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${camera.apiToken}` }, body:JSON.stringify({ action }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || result.error || 'Comando rifiutato.');
      toast(`Movimento ${action} eseguito. Sincronizzo il live…`, 'success');
      [400, 1400, 2800].forEach((delay) => setTimeout(() => {
        const liveEdge = Number(hls?.liveSyncPosition);
        if (Number.isFinite(liveEdge) && Math.abs(player.currentTime - liveEdge) > 0.35) player.currentTime = liveEdge;
      }, delay));
    } catch (error) { toast(error.message, 'error'); }
  }

  function snapshot() {
    const camera = currentCamera();
    if (!camera || !player.videoWidth) return toast('Avvia il live prima dello snapshot.', 'error');
    const canvas = document.createElement('canvas'); canvas.width = player.videoWidth; canvas.height = player.videoHeight;
    canvas.getContext('2d').drawImage(player, 0, 0);
    canvas.toBlob((blob) => {
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${slug(camera.name)}-${Date.now()}.jpg`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000); $('snapshotState').textContent = new Date().toLocaleTimeString('it-IT'); toast('Snapshot scaricato.', 'success');
    }, 'image/jpeg', .92);
  }

  function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'camera'; }

  function toggleRecording() {
    if (!player.captureStream || player.paused) return toast('Avvia il live prima di registrare.', 'error');
    if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); return; }
    try {
      chunks = []; mediaRecorder = new MediaRecorder(player.captureStream(), { mimeType:'video/webm' });
      mediaRecorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      mediaRecorder.onstart = () => { $('recordButton').classList.add('recording'); $('recordButton').querySelector('span').textContent = 'Ferma'; };
      mediaRecorder.onstop = () => { $('recordButton').classList.remove('recording'); $('recordButton').querySelector('span').textContent = 'Registra'; addRecording(new Blob(chunks, { type:'video/webm' })); };
      mediaRecorder.start();
    } catch { toast('Registrazione non supportata dal browser.', 'error'); }
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
    db.close(); await loadRecordings(activeId); toast('Clip eliminata dal dispositivo.', 'success');
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

  async function addRecording(blob) {
    const camera = currentCamera(); if (!camera) return;
    try { await saveRecording(blob, camera); await loadRecordings(camera.id); toast('Clip salvata in modo persistente su questo dispositivo.', 'success'); }
    catch { toast('Impossibile salvare la clip: controlla lo spazio disponibile.', 'error'); }
  }

  function applyPreferences() {
    let theme = preferences.theme;
    if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('compact', Boolean(preferences.compact));
    $('themeSelect').value = preferences.theme; $('viewSelect').value = preferences.cameraView; $('compactInput').checked = Boolean(preferences.compact);
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
    $('testCurrent').addEventListener('click', testCurrentCamera); $('refreshButton').addEventListener('click', () => currentCamera() && updateFocusedCamera(currentCamera()));
    document.querySelectorAll('[data-ptz]').forEach((button) => button.addEventListener('click', () => sendPtz(button.dataset.ptz)));
    $('snapshotButton').addEventListener('click', snapshot); $('recordButton').addEventListener('click', toggleRecording);
    $('muteButton').addEventListener('click', () => { player.muted = !player.muted; $('muteButton').classList.toggle('unmuted', !player.muted); });
    $('fullButton').addEventListener('click', () => $('stage').requestFullscreen?.());
    $('rotateButton').addEventListener('click', toggleOrientation); $('orientationFeature').addEventListener('click', toggleOrientation);
    $('shareCamera').addEventListener('click', shareCurrentCamera);
    $('qualitySelect').addEventListener('change', () => { if (hls) hls.currentLevel = Number($('qualitySelect').value); });
    $('recordingList').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-recording]'); if (button) deleteRecording(button.dataset.deleteRecording); });
    player.addEventListener('playing', () => { setVideoLoading(false); $('stage').classList.add('playing'); $('cameraStatusDot').classList.add('live'); $('liveTag').className = 'live-badge live'; $('liveTag').textContent = 'LIVE'; });
    player.addEventListener('error', () => { setVideoLoading(false); offline('Errore di riproduzione.', 'Controlla il codec e il gateway HLS.'); });
    $('viewFocus').addEventListener('click', () => setView('focus')); $('viewGrid').addEventListener('click', () => setView('grid'));
    $('globalSearch').addEventListener('input', (event) => { searchText = event.target.value.trim().toLowerCase(); renderSwitcher(); renderGrid(); });
    $('clearEvents').addEventListener('click', clearEvents);
    $('accountButton').addEventListener('click', openAccount); $('mobileAccount').addEventListener('click', openAccount); $('logoutButton').addEventListener('click', () => { $('accountDialog').close(); logout(); });
    $('savePreferences').addEventListener('click', () => { preferences.theme = $('themeSelect').value; preferences.cameraView = $('viewSelect').value; preferences.compact = $('compactInput').checked; persistPreferences(); });
    $('themeButton').addEventListener('click', () => { preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; persistPreferences(); });
    $('changePassword').addEventListener('click', changePassword); $('deleteAccount').addEventListener('click', deleteAccount);
    $('mobileCameras').addEventListener('click', () => window.scrollTo({ top:document.querySelector('.section-head').offsetTop - 75, behavior:'smooth' }));
    document.addEventListener('keydown', (event) => { if (event.key === '/' && !event.target.matches('input,textarea,select')) { event.preventDefault(); $('globalSearch').focus(); } if (event.key === 'Escape') document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close()); });
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; $('installButton').hidden = false; });
    $('installButton').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $('installButton').hidden = true; });
    window.addEventListener('online', () => setConnection('', 'Vault sincronizzato')); window.addEventListener('offline', () => setConnection('error', 'Browser offline'));
  }

  async function bootstrap() {
    bindEvents(); setAuthMode('login'); $('loginUsername').value = localStorage.getItem(LAST_USER_KEY) || '';
    if (auth?.token) {
      try { await enterDashboard(); return; } catch { logout(false); }
    }
    $('authGate').hidden = false; $('appShell').hidden = true;
  }

  bootstrap();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
