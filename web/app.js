'use strict';

(() => {
  const defaults = window.APP_CONFIG || {};
  const AUTH_KEY = 'fredi-auth-v1';
  const LAST_USER_KEY = 'fredi-last-user';
  const EVENT_KEY = 'fredi-events-v2';
  const gatewayBase = String(defaults.apiBaseUrl || 'https://control.nelloonrender.duckdns.org').replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);
  const player = $('player');
  let auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  let cameras = [];
  let activeId = '';
  let editingId = '';
  let hls;
  let mediaRecorder;
  let chunks = [];
  let toastTimer;
  let deferredInstallPrompt;
  let authMode = 'login';
  const eventLog = JSON.parse(localStorage.getItem(EVENT_KEY) || '[]');

  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3600);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
  }

  function renderEvents() {
    if (!eventLog.length) {
      $('events').innerHTML = '<div class="recording-empty">Nessun evento recente.</div>';
      return;
    }
    $('events').innerHTML = eventLog.map((item) => `<div class="event"><i class="event-dot ${escapeHtml(item.type)}"></i><div><b>${escapeHtml(item.title)}</b><div class="sub">${escapeHtml(item.detail)}</div></div><time class="event-time">${escapeHtml(item.time)}</time></div>`).join('');
  }

  function addEvent(title, detail, type = '') {
    eventLog.unshift({ title, detail, type, time:new Date().toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit' }) });
    eventLog.splice(25);
    localStorage.setItem(EVENT_KEY, JSON.stringify(eventLog));
    renderEvents();
  }

  function currentCamera() {
    return cameras.find((camera) => camera.id === activeId) || null;
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
    if (response.status === 401 && path !== '/api/auth/login') {
      logout(false);
      throw new Error('Sessione scaduta: accedi di nuovo.');
    }
    if (!response.ok) throw new Error(result.detail || result.error || `Errore gateway (${response.status})`);
    return result;
  }

  function createAuthUi() {
    document.body.insertAdjacentHTML('beforeend', `
      <section class="auth-gate" id="authGate">
        <form class="auth-card" id="loginForm">
          <div class="auth-brand"><div class="logo">◉</div><div><h2 id="authTitle">Accedi a FREDI Control</h2><p id="authSubtitle">Apri il tuo archivio cifrato di telecamere.</p></div></div>
          <div class="field"><label for="loginUsername">Utente</label><input id="loginUsername" autocomplete="username" required maxlength="128"></div>
          <div class="field" id="registerEmailField" hidden><label for="registerEmail">Email</label><input id="registerEmail" type="email" autocomplete="email" maxlength="254"></div>
          <div class="field"><label for="loginPassword">Password</label><input id="loginPassword" type="password" autocomplete="current-password" required maxlength="256"></div>
          <div class="field" id="registerConfirmField" hidden><label for="registerConfirm">Ripeti password</label><input id="registerConfirm" type="password" autocomplete="new-password" maxlength="256"></div>
          <button class="primary auth-submit" id="loginButton" type="submit">Accedi</button>
          <div class="auth-error" id="loginError" role="alert"></div>
          <button class="secondary auth-submit" id="authModeButton" type="button">Non hai un account? Registrati</button>
          <p>Le configurazioni sono cifrate sul gateway domestico e non vengono salvate su Render o GitHub.</p>
        </form>
      </section>`);
    $('loginUsername').value = localStorage.getItem(LAST_USER_KEY) || '';
    $('loginForm').addEventListener('submit', login);
    $('authModeButton').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));

    const accountButton = document.createElement('button');
    accountButton.className = 'icon-btn account-button';
    accountButton.id = 'accountButton';
    accountButton.type = 'button';
    accountButton.innerHTML = '<span class="account-badge">U</span><span class="account-name">Esci</span>';
    accountButton.hidden = true;
    accountButton.addEventListener('click', () => logout(true));
    document.querySelector('.top-actions').prepend(accountButton);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    $('authTitle').textContent = registering ? 'Crea il tuo account' : 'Accedi a FREDI Control';
    $('authSubtitle').textContent = registering ? 'Ogni account ha un archivio di camere separato.' : 'Apri il tuo archivio cifrato di telecamere.';
    $('registerEmailField').hidden = !registering;
    $('registerConfirmField').hidden = !registering;
    $('registerEmail').required = registering;
    $('registerConfirm').required = registering;
    $('loginPassword').autocomplete = registering ? 'new-password' : 'current-password';
    $('loginButton').textContent = registering ? 'Crea account' : 'Accedi';
    $('authModeButton').textContent = registering ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati';
    $('loginError').textContent = '';
  }

  async function login(event) {
    event.preventDefault();
    const button = $('loginButton');
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    $('loginError').textContent = '';
    button.disabled = true;
    button.textContent = authMode === 'register' ? 'Creazione…' : 'Accesso…';
    try {
      if (authMode === 'register' && password !== $('registerConfirm').value) throw new Error('Le due password non coincidono.');
      if (authMode === 'register' && password.length < 12) throw new Error('La password deve contenere almeno 12 caratteri.');
      const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload = authMode === 'register' ? { username, email:$('registerEmail').value.trim(), password } : { username, password };
      const result = await fetch(`${gatewayBase}${path}`, {
        method:'POST',
        cache:'no-store',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify(payload),
      });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(data.error || 'Accesso non riuscito.');
      auth = { token:data.token, username:data.account.username, expiresAt:data.expiresAt };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      localStorage.setItem(LAST_USER_KEY, username);
      $('loginPassword').value = '';
      await enterDashboard();
    } catch (error) {
      $('loginError').textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = authMode === 'register' ? 'Crea account' : 'Accedi';
    }
  }

  function logout(showMessage) {
    auth = null;
    cameras = [];
    activeId = '';
    localStorage.removeItem(AUTH_KEY);
    disconnectStream();
    $('authGate').hidden = false;
    $('accountButton').hidden = true;
    if (showMessage) $('loginError').textContent = 'Sessione chiusa correttamente.';
  }

  function migratedDefaultCameras() {
    const legacyText = localStorage.getItem('camera-control-v2');
    if (!legacyText) return [];
    const legacy = JSON.parse(legacyText || '{}');
    return [
      {
        id:crypto.randomUUID(),
        name:legacy.cameraName || defaults.cameraName || 'IPC365 · 1080p',
        model:'IPC365 · ONVIF',
        streamUrl:legacy.streamUrl || '',
        streamUsername:legacy.streamUsername || '',
        streamPassword:sessionStorage.getItem('camera-stream-password') || '',
        apiBaseUrl:legacy.apiBaseUrl || gatewayBase,
        apiToken:sessionStorage.getItem('camera-api-token') || '',
        ptz:true,
      },
    ];
  }

  async function enterDashboard() {
    const session = await gatewayFetch('/api/auth/session');
    auth.username = session.account.username;
    auth.expiresAt = session.expiresAt;
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    $('authGate').hidden = true;
    $('accountButton').hidden = false;
    $('accountButton').querySelector('.account-badge').textContent = auth.username.slice(0, 1).toUpperCase();
    $('accountButton').querySelector('.account-name').textContent = `${auth.username} · Esci`;
    const vault = await gatewayFetch('/api/cameras');
    cameras = Array.isArray(vault.cameras) ? vault.cameras : [];
    if (!cameras.length) {
      cameras = migratedDefaultCameras();
      if (cameras.length) await saveCameras();
      sessionStorage.removeItem('camera-stream-password');
      sessionStorage.removeItem('camera-api-token');
    }
    activeId = cameras.some((camera) => camera.id === activeId) ? activeId : cameras[0]?.id || '';
    renderCameraSwitch();
    if (activeId) selectCamera(activeId); else offline('Aggiungi la tua prima camera.');
  }

  async function saveCameras() {
    const result = await gatewayFetch('/api/cameras', {
      method:'PUT',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ cameras }),
    });
    cameras = result.cameras;
  }

  function renderCameraSwitch() {
    const container = document.querySelector('.camera-switch');
    container.innerHTML = '';
    for (const camera of cameras) {
      const wrap = document.createElement('div');
      wrap.className = 'camera-chip-wrap';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = `camera-chip${camera.id === activeId ? ' active' : ''}`;
      select.innerHTML = `<b>${camera.streamUrl ? '●' : '○'} ${escapeHtml(camera.name)}</b><span>${escapeHtml(camera.model || (camera.streamUrl ? 'HLS configurato' : 'Da configurare'))}</span>`;
      select.addEventListener('click', () => selectCamera(camera.id));
      select.addEventListener('dblclick', () => openSettings(camera.id));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'camera-chip-edit';
      edit.title = `Modifica ${camera.name}`;
      edit.setAttribute('aria-label', `Modifica ${camera.name}`);
      edit.textContent = '⚙';
      edit.addEventListener('click', () => openSettings(camera.id));
      wrap.append(select, edit);
      container.append(wrap);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'camera-chip add';
    add.textContent = '＋ Aggiungi camera';
    add.addEventListener('click', () => openSettings(''));
    container.append(add);
  }

  function selectCamera(id) {
    const camera = cameras.find((item) => item.id === id);
    if (!camera) return;
    activeId = id;
    renderCameraSwitch();
    $('cameraName').textContent = camera.name;
    document.querySelector('.camera-meta').textContent = camera.model || 'Gateway HLS HTTPS';
    document.querySelectorAll('[data-ptz]').forEach((button) => { button.disabled = !camera.ptz; });
    disconnectStream();
    if (camera.streamUrl) connectStream(camera);
    else offline('Camera non ancora configurata.');
  }

  function disconnectStream() {
    hls?.destroy();
    hls = null;
    player.pause();
    player.removeAttribute('src');
    player.load();
    $('stage').classList.remove('playing');
  }

  function connectStream(camera) {
    $('gatewayState').textContent = 'Connessione…';
    const authorization = camera.streamUsername && camera.streamPassword ? `Basic ${btoa(`${camera.streamUsername}:${camera.streamPassword}`)}` : '';
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode:true,
        liveSyncDurationCount:2,
        xhrSetup:(xhr) => { if (authorization) xhr.setRequestHeader('Authorization', authorization); },
      });
      hls.loadSource(camera.streamUrl);
      hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, () => player.play().catch(() => toast('Tocca il video per avviare il live.')));
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) offline('HLS non raggiungibile o credenziali errate.'); });
    } else if (player.canPlayType('application/vnd.apple.mpegurl') && !authorization) {
      player.src = camera.streamUrl;
      player.play().catch(() => {});
    } else {
      offline('Il browser non supporta HLS autenticato.');
    }
  }

  function offline(message) {
    $('gatewayState').textContent = 'Non raggiungibile';
    $('gatewayState').className = 'pending';
    $('statusText').textContent = message || 'Gateway non raggiungibile';
    $('statusDot').classList.remove('live');
    $('liveTag').textContent = 'OFFLINE';
    $('stage').classList.remove('playing');
  }

  function prepareSettingsDialog() {
    const dialog = $('settingsDialog');
    dialog.querySelector('h2').textContent = 'Configura camera';
    $('apiTokenInput').closest('.field').hidden = false;
    $('apiInput').closest('.field').querySelector('label').textContent = 'URL API gateway';
    $('streamPasswordInput').placeholder = 'Salvata cifrata nel tuo account';
    $('apiTokenInput').placeholder = 'Salvato cifrato nel tuo account';
    dialog.querySelector('.notice').textContent = 'Password HLS, token PTZ e configurazione vengono cifrati nel vault del tuo account. Render e GitHub non ricevono questi dati.';
    const ptzRow = document.createElement('label');
    ptzRow.className = 'field-check';
    ptzRow.innerHTML = '<input id="ptzInput" type="checkbox"> Abilita controlli PTZ per questa camera';
    $('apiInput').closest('.field').after(ptzRow);
    const footer = dialog.querySelector('.modal-foot');
    footer.className = 'settings-actions';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.id = 'deleteCamera';
    deleteButton.className = 'danger-button';
    deleteButton.textContent = 'Elimina camera';
    footer.prepend(deleteButton);
    $('saveSettings').type = 'button';
    $('saveSettings').addEventListener('click', saveSettings);
    deleteButton.addEventListener('click', deleteCamera);
    $('settingsButton').addEventListener('click', () => openSettings(activeId));
  }

  function openSettings(id) {
    const camera = cameras.find((item) => item.id === id) || { name:'', model:'', streamUrl:'', streamUsername:'', streamPassword:'', apiBaseUrl:'', apiToken:'', ptz:false };
    editingId = id;
    $('settingsDialog').querySelector('h2').textContent = id ? `Modifica ${camera.name}` : 'Aggiungi camera';
    $('nameInput').value = camera.name;
    $('streamInput').value = camera.streamUrl;
    $('streamUsernameInput').value = camera.streamUsername;
    $('streamPasswordInput').value = camera.streamPassword;
    $('apiInput').value = camera.apiBaseUrl || '';
    $('apiTokenInput').value = camera.apiToken || '';
    $('ptzInput').checked = camera.ptz !== false;
    $('deleteCamera').hidden = !id;
    $('settingsDialog').showModal();
  }

  async function saveSettings() {
    const name = $('nameInput').value.trim();
    if (!name) return toast('Inserisci il nome della camera.');
    const previous = cameras.find((item) => item.id === editingId);
    const camera = {
      id:editingId || crypto.randomUUID(),
      name,
      model:previous?.model || ($('streamInput').value.trim() ? 'HLS configurato' : 'Da configurare'),
      streamUrl:$('streamInput').value.trim(),
      streamUsername:$('streamUsernameInput').value.trim(),
      streamPassword:$('streamPasswordInput').value,
      apiBaseUrl:$('apiInput').value.trim(),
      apiToken:$('apiTokenInput').value,
      ptz:$('ptzInput').checked,
    };
    const index = cameras.findIndex((item) => item.id === camera.id);
    if (index >= 0) cameras[index] = camera; else cameras.push(camera);
    try {
      await saveCameras();
      activeId = camera.id;
      $('settingsDialog').close();
      renderCameraSwitch();
      selectCamera(activeId);
      toast('Camera salvata nel vault cifrato.');
    } catch (error) {
      toast(error.message);
    }
  }

  async function deleteCamera() {
    const camera = cameras.find((item) => item.id === editingId);
    if (!camera || !confirm(`Eliminare ${camera.name}?`)) return;
    const backup = cameras;
    cameras = cameras.filter((item) => item.id !== editingId);
    try {
      await saveCameras();
      activeId = cameras[0]?.id || '';
      $('settingsDialog').close();
      renderCameraSwitch();
      if (activeId) selectCamera(activeId); else offline('Aggiungi una camera.');
      toast('Camera eliminata.');
    } catch (error) {
      cameras = backup;
      toast(error.message);
    }
  }

  async function actionFromGateway(path, body) {
    const camera = currentCamera();
    if (!camera?.ptz) throw new Error('PTZ non abilitato per questa camera.');
    if (!camera.apiBaseUrl || !camera.apiToken) throw new Error('Configura URL e token PTZ per questa camera.');
    const base = String(camera.apiBaseUrl).replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
      method:'POST',
      cache:'no-store',
      headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${camera.apiToken}` },
      body:JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || result.error || 'Comando PTZ rifiutato.');
    return result;
  }

  function snapshot() {
    const camera = currentCamera();
    if (!camera?.streamUrl || !player.videoWidth) return toast('Snapshot disponibile quando il live è attivo.');
    const canvas = document.createElement('canvas');
    canvas.width = player.videoWidth;
    canvas.height = player.videoHeight;
    canvas.getContext('2d').drawImage(player, 0, 0);
    canvas.toBlob((blob) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${camera.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now()}.jpg`;
      link.click();
      URL.revokeObjectURL(link.href);
      $('snapshotState').textContent = new Date().toLocaleTimeString('it-IT');
      toast('Snapshot scaricato.');
    }, 'image/jpeg', 0.92);
  }

  function addRecording(blob) {
    const url = URL.createObjectURL(blob);
    const row = document.createElement('div');
    row.className = 'recording';
    row.innerHTML = `<div class="thumb">▶</div><div><b>Clip manuale</b><div class="sub">${new Date().toLocaleString('it-IT')}</div></div><a class="storage-action" href="${url}" download="camera-${Date.now()}.webm">Scarica</a>`;
    $('recordingEmpty').style.display = 'none';
    $('recordingList').style.display = 'block';
    $('recordingList').prepend(row);
  }

  function record() {
    if (!player.captureStream || player.paused) return toast('Avvia prima il live.');
    const button = $('recordButton');
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
      button.classList.remove('active');
      button.textContent = '⏺ Registra clip';
      return;
    }
    try {
      chunks = [];
      mediaRecorder = new MediaRecorder(player.captureStream(), { mimeType:'video/webm' });
      mediaRecorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      mediaRecorder.onstop = () => addRecording(new Blob(chunks, { type:'video/webm' }));
      mediaRecorder.start();
      button.classList.add('active');
      button.textContent = '■ Ferma registrazione';
    } catch {
      toast('Registrazione non supportata da questo browser.');
    }
  }

  function bindControls() {
    player.addEventListener('playing', () => {
      $('stage').classList.add('playing');
      $('statusText').textContent = 'Live connesso';
      $('statusDot').classList.add('live');
      $('liveTag').textContent = 'LIVE';
      $('gatewayState').textContent = 'Online';
      $('gatewayState').className = '';
    });
    player.addEventListener('error', () => offline('Errore nel live.'));
    document.querySelectorAll('[data-ptz]').forEach((button) => button.addEventListener('click', async () => {
      try { await actionFromGateway('/api/ptz', { action:button.dataset.ptz }); toast('Comando PTZ inviato.'); }
      catch (error) { toast(error.message); }
    }));
    $('snapshotButton').addEventListener('click', snapshot);
    $('snapshotTop').addEventListener('click', snapshot);
    $('recordButton').addEventListener('click', record);
    $('muteButton').addEventListener('click', () => { player.muted = !player.muted; $('muteButton').textContent = player.muted ? '🔇' : '🔊'; });
    $('fullButton').addEventListener('click', () => $('stage').requestFullscreen?.());
    $('speakerButton').addEventListener('click', () => toast('Audio bidirezionale non ancora supportato dalla camera.'));
    $('qualityButton').addEventListener('click', () => toast('Qualità automatica gestita dal gateway HLS.'));
    $('clearEvents').addEventListener('click', () => { eventLog.length = 0; localStorage.setItem(EVENT_KEY, '[]'); renderEvents(); });
    $('notificationButton').addEventListener('click', async () => {
      if (!('Notification' in window)) return toast('Notifiche non supportate.');
      const result = await Notification.requestPermission();
      toast(result === 'granted' ? 'Notifiche abilitate.' : 'Notifiche non autorizzate.');
    });
    document.querySelectorAll('[data-storage]').forEach((button) => button.addEventListener('click', () => toast(button.dataset.storage === 'device' ? 'Download locale già attivo.' : 'Integrazione cloud in preparazione.')));
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; $('installButton').hidden = false; });
    $('installButton').addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $('installButton').hidden = true; });
  }

  async function bootstrap() {
    createAuthUi();
    prepareSettingsDialog();
    bindControls();
    renderEvents();
    if (auth?.token) {
      try { await enterDashboard(); return; }
      catch { logout(false); }
    }
    $('authGate').hidden = false;
  }

  bootstrap();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
