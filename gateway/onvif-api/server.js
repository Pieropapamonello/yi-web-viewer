'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { Cam } = require('onvif');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.ONVIF_HOST || '192.168.1.50';
const ONVIF_PORT = Number(process.env.ONVIF_PORT || 8080);
const USERNAME = process.env.ONVIF_USERNAME || '';
const PASSWORD = process.env.ONVIF_PASSWORD || '';
const API_TOKEN = process.env.API_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://yi-web-viewer.onrender.com';
const MOVE_SPEED = Math.min(1, Math.max(0.05, Number(process.env.PTZ_SPEED || 0.45)));
const MOVE_DURATION = Math.min(2000, Math.max(100, Number(process.env.PTZ_DURATION_MS || 350)));
const TIME_OFFSET_MS = Number(process.env.ONVIF_TIME_OFFSET_MS || 0);
const IPC365_PTZ_PORT = Number(process.env.IPC365_PTZ_PORT || 23456);
const IPC365_PTZ_STEP = Math.min(30, Math.max(3, Number(process.env.IPC365_PTZ_STEP || 12)));
const IPC365_SOURCE_ID = process.env.IPC365_SOURCE_ID || 'af93c63b';
const IPC365_DEVICE_ID = process.env.IPC365_DEVICE_ID || '09f74b01';
const DASHBOARD_PASSWORD_ITERATIONS = Number(process.env.DASHBOARD_PASSWORD_ITERATIONS || 310000);
const AUTH_SECRET = process.env.AUTH_SECRET || '';
const VAULT_KEY = process.env.VAULT_KEY || '';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || '/data/accounts.json';
const SESSION_DAYS = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const MAX_USERS = Math.min(10000, Math.max(1, Number(process.env.MAX_USERS || 500)));
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/archive';
const ARCHIVE_SEGMENT_SECONDS = Math.min(3600, Math.max(10, Number(process.env.ARCHIVE_SEGMENT_SECONDS || 60)));
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY || '';
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET || '';
const DROPBOX_REDIRECT_URI = process.env.DROPBOX_REDIRECT_URI || 'https://control.nelloonrender.duckdns.org/api/cloud/dropbox/callback';
const DASHBOARD_URL = process.env.DASHBOARD_URL || ALLOWED_ORIGIN;
const AUTH_READY = Boolean(
  AUTH_SECRET.length >= 32 &&
  /^[a-f0-9]{64}$/i.test(VAULT_KEY)
);

if (!USERNAME || !PASSWORD || API_TOKEN.length < 24) {
  console.error('ONVIF_USERNAME, ONVIF_PASSWORD and an API_TOKEN of at least 24 characters are required.');
  process.exit(1);
}

if (!AUTH_READY) {
  console.warn('Dashboard registration disabled until AUTH_SECRET and VAULT_KEY are configured.');
}

let cameraPromise;
const pendingDropbox = new Map();

function connectCamera() {
  if (!cameraPromise) {
    cameraPromise = new Promise((resolve, reject) => {
      const camera = new Cam({
        hostname: HOST,
        port: ONVIF_PORT,
        username: USERNAME,
        password: PASSWORD,
        timeout: 8000,
        autoconnect: false,
        preserveAddress: true,
      });

      // Some IPC365 firmware returns InvalidSecurity to the unauthenticated
      // GetSystemDateAndTime request required by ONVIF clients. Seed the
      // WS-Security clock from the Docker host, then skip that broken call.
      const cameraNow = () => new Date(Date.now() + TIME_OFFSET_MS);
      camera.timeShift = cameraNow().getTime() - (process.uptime() * 1000);
      camera.getSystemDateAndTime = function getSystemDateAndTime(callback) {
        callback.call(this, null, cameraNow(), '');
      };
      // This IPC365 closes the socket on GetServices. Use the older but
      // widely-supported GetCapabilities discovery path instead.
      camera.getCapabilities((capabilityError) => {
        if (capabilityError) return reject(new Error(`GetCapabilities: ${capabilityError.message || capabilityError}`));
        camera.getProfiles((profileError) => {
          if (profileError) return reject(new Error(`GetProfiles: ${profileError.message || profileError}`));
          camera.getVideoSources((sourceError) => {
            if (sourceError) return reject(new Error(`GetVideoSources: ${sourceError.message || sourceError}`));
            camera.getActiveSources();
            console.log(`ONVIF ready; PTZ path ${camera.uri?.ptz?.path || 'unknown'}; profile ${camera.activeSource?.profileToken || 'unknown'}`);
            resolve(camera);
          });
        });
      });
    }).catch((error) => {
      cameraPromise = undefined;
      throw error;
    });
  }
  return cameraPromise;
}

function call(camera, method, options = {}) {
  return new Promise((resolve, reject) => {
    camera[method](options, (error, result) => error ? reject(error) : resolve(result));
  });
}

function stop(camera) {
  return call(camera, 'stop', { panTilt: true, zoom: true }).catch(() => undefined);
}

const IPC365_HEADER = Buffer.from([
  0xcc, 0xdd, 0xee, 0xff, 0x77, 0x4f, 0x00, 0x00,
  0xe4, 0x12, 0x69, 0x00, 0x48, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

function ipc365Id(value, name) {
  if (!/^[a-f0-9]{8}$/i.test(value)) throw new Error(`${name} must contain exactly 8 hexadecimal characters`);
  return Buffer.from(value, 'hex');
}

function ipc365Frame(action, requestedStep = IPC365_PTZ_STEP) {
  // The IPC365 frame declares 0x48 (72) bytes in its header. Sending only
  // 64 bytes is silently accepted by TCP but ignored by stricter 81XXF firmware.
  const frame = Buffer.alloc(72);
  IPC365_HEADER.copy(frame);
  ipc365Id(IPC365_SOURCE_ID, 'IPC365_SOURCE_ID').copy(frame, 20);
  ipc365Id(IPC365_DEVICE_ID, 'IPC365_DEVICE_ID').copy(frame, 24);
  const step = Math.min(30, Math.max(3, Number(requestedStep) || IPC365_PTZ_STEP));
  const vectors = {
    right: [step, 0],
    left: [-step, 0],
    // Captured IPC365/S5-T firmware uses an inverted vertical axis.
    up: [0, -step],
    down: [0, step],
    stop: [0, 0],
  };
  const vector = vectors[action];
  if (!vector) throw new Error('Unsupported IPC365 PTZ action');
  // The two signed PTZ values start at offsets 40 and 44. Older community
  // examples are frequently copied with an off-by-four error at 36/40.
  frame.writeInt32LE(vector[0], 40);
  frame.writeInt32LE(vector[1], 44);
  return frame;
}

function ipc365Move(action, step) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: IPC365_PTZ_PORT });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error('IPC365 PTZ connection timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(ipc365Frame(action, step), (error) => {
        if (error) return fail(error);
        const finish = () => {
          if (settled) return;
          settled = true;
          socket.end();
          resolve();
        };
        if (action === 'stop') return finish();
        setTimeout(() => socket.write(ipc365Frame('stop'), (stopError) => stopError ? fail(stopError) : finish()), MOVE_DURATION);
      });
    });
  });
}

async function move(action, step) {
  await ipc365Move(action === 'home' ? 'stop' : action, step);
}

async function gotoPreset(index) {
  const camera = await connectCamera();
  const presets = await new Promise((resolve, reject) => {
    camera.getPresets((error, result) => error ? reject(error) : resolve(result || {}));
  });
  const tokens = Object.keys(presets);
  const token = tokens[index - 1];
  if (!token) throw new Error(`Preset ${index} is not configured on the camera`);
  await call(camera, 'gotoPreset', { preset: token });
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession(payload) {
  const encoded = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySignedToken(token) {
  if (!AUTH_READY) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0]).digest();
  let supplied;
  try {
    supplied = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof payload.sub !== 'string' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionFromRequest(request) {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? verifySignedToken(authorization.slice(7)) : null;
}

function passwordHash(password, salt, iterations = DASHBOARD_PASSWORD_ITERATIONS) {
  const derived = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    iterations,
    64,
    'sha256',
  );
  return derived.toString('hex');
}

function passwordMatches(password, account) {
  if (!AUTH_READY || typeof password !== 'string' || password.length > 256) return false;
  const derived = Buffer.from(passwordHash(password, account.passwordSalt, account.passwordIterations), 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function vaultKey() {
  return Buffer.from(VAULT_KEY, 'hex');
}

function loadAccounts() {
  if (!AUTH_READY || !fs.existsSync(ACCOUNTS_FILE)) return { version: 2, users: [] };
  const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  return { version: 2, users: Array.isArray(data.users) ? data.users : [] };
}

function saveAccounts(data) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const temporary = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, ACCOUNTS_FILE);
}

function decryptVault(account) {
  if (!account.vault) return { version: 1, cameras: [], events: [], preferences: {}, cloud:{} };
  const envelope = account.vault;
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`fredi-camera-vault-v2:${account.id}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const vault = JSON.parse(plaintext.toString('utf8'));
  return {
    version: 1,
    cameras: Array.isArray(vault.cameras) ? vault.cameras : [],
    events: Array.isArray(vault.events) ? vault.events.slice(0, 100) : [],
    preferences: vault.preferences && typeof vault.preferences === 'object' ? vault.preferences : {},
    cloud: vault.cloud && typeof vault.cloud === 'object' ? vault.cloud : {},
  };
}

function encryptVault(accountId, vault) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  cipher.setAAD(Buffer.from(`fredi-camera-vault-v2:${accountId}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(vault), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function publicVault(vault) {
  return { version:1, cameras:vault.cameras || [], events:vault.events || [], preferences:vault.preferences || {} };
}

function publicAccount(account) {
  return { id:account.id, username:account.username, email:account.email, createdAt:account.createdAt };
}

function accountFromSession(session, data) {
  if (!session) return null;
  const account = data.users.find((candidate) => candidate.id === session.sub) || null;
  if (!account || session.ver !== (account.sessionVersion || '1')) return null;
  return account;
}

function vaultEvent(type, title, detail) {
  return {
    id:crypto.randomUUID(),
    type:cleanText(type, 24, 'info'),
    title:cleanText(title, 100, 'Evento'),
    detail:cleanText(detail, 240),
    createdAt:new Date().toISOString(),
  };
}

function addAccountEvent(account, type, title, detail) {
  const vault = decryptVault(account);
  vault.events.unshift(vaultEvent(type, title, detail));
  vault.events = vault.events.slice(0, 100);
  account.vault = encryptVault(account.id, vault);
  return vault;
}

function cleanPreferences(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    theme:['dark', 'light', 'system'].includes(input.theme) ? input.theme : 'dark',
    cameraView:['focus', 'grid'].includes(input.cameraView) ? input.cameraView : 'focus',
    compact:Boolean(input.compact),
    cameraSort:['custom', 'name', 'location'].includes(input.cameraSort) ? input.cameraSort : 'custom',
    favoritesOnly:Boolean(input.favoritesOnly),
  };
}

function cleanText(value, maximum, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : fallback;
}

function cleanUrl(value) {
  const text = cleanText(value, 2048);
  if (!text) return '';
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS gateway URLs are allowed');
  return parsed.toString();
}

function cleanCameras(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid cameras list');
  const ids = new Set();
  return value.map((camera) => {
    const id = cleanText(camera?.id, 80) || crypto.randomUUID();
    if (ids.has(id)) throw new Error('Duplicate camera id');
    ids.add(id);
    return {
      id,
      name: cleanText(camera?.name, 80, 'Camera'),
      model: cleanText(camera?.model, 80),
      location: cleanText(camera?.location, 80),
      notes: cleanText(camera?.notes, 300),
      favorite:Boolean(camera?.favorite),
      streamUrl: cleanUrl(camera?.streamUrl),
      streamLowUrl: cleanUrl(camera?.streamLowUrl),
      webrtcUrl: cleanUrl(camera?.webrtcUrl),
      streamUsername: cleanText(camera?.streamUsername, 256),
      streamPassword: typeof camera?.streamPassword === 'string' ? camera.streamPassword.slice(0, 512) : '',
      apiBaseUrl: cleanUrl(camera?.apiBaseUrl),
      apiToken: typeof camera?.apiToken === 'string' ? camera.apiToken.slice(0, 1024) : '',
      ptz: camera?.ptz !== false,
      rotation: camera?.rotation === 180 ? 180 : 0,
      motionDetection: camera?.motionDetection !== false,
      archiveKey: cleanText(camera?.archiveKey, 64).replace(/[^a-zA-Z0-9_-]/g, ''),
    };
  });
}

function cameraArchiveKey(camera) {
  if (camera?.archiveKey) return camera.archiveKey;
  try {
    const segment = new URL(camera?.streamLowUrl || camera?.streamUrl).pathname.split('/').filter(Boolean)[0] || '';
    return segment.replace(/-low$/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  } catch { return ''; }
}

function cameraArchiveAuthorized(camera) {
  const supplied = Buffer.from(typeof camera?.apiToken === 'string' ? camera.apiToken : '');
  const expected = Buffer.from(API_TOKEN);
  return supplied.length === expected.length && supplied.length > 0 && crypto.timingSafeEqual(supplied, expected);
}

function archiveEntries(camera, date) {
  const key = cameraArchiveKey(camera);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !fs.existsSync(ARCHIVE_DIR)) return [];
  const expression = new RegExp(`^${key}_${date}_(\\d{2})-(\\d{2})-(\\d{2})\\.mp4$`);
  return fs.readdirSync(ARCHIVE_DIR).flatMap((name) => {
    const match = expression.exec(name);
    if (!match) return [];
    const filePath = path.join(ARCHIVE_DIR, name);
    const stat = fs.statSync(filePath);
    // FFmpeg writes the MP4 index only when a segment closes. Hide the file
    // that is still growing so browsers never receive an incomplete movie.
    if (!stat.isFile() || stat.size < 1024 || Date.now() - stat.mtimeMs < 5000) return [];
    const start = new Date(`${date}T${match[1]}:${match[2]}:${match[3]}`);
    return [{ name, start:start.toISOString(), duration:ARCHIVE_SEGMENT_SECONDS, size:stat.size }];
  }).sort((left, right) => left.start.localeCompare(right.start));
}

function archiveFileForAccount(account, cameraId, name) {
  const vault = decryptVault(account);
  const camera = vault.cameras.find((item) => item.id === cameraId);
  const key = cameraArchiveKey(camera);
  if (!camera || !cameraArchiveAuthorized(camera) || !key || path.basename(name) !== name || !name.startsWith(`${key}_`) || !name.endsWith('.mp4')) return null;
  const filePath = path.join(ARCHIVE_DIR, name);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
}

function sendArchiveFile(request, response, filePath, headers) {
  const stat = fs.statSync(filePath);
  const range = request.headers.range;
  const common = { ...headers, 'Content-Type':'video/mp4', 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store' };
  if (!range) {
    response.writeHead(200, { ...common, 'Content-Length':stat.size });
    return fs.createReadStream(filePath).pipe(response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { response.writeHead(416, { ...common, 'Content-Range':`bytes */${stat.size}` }); return response.end(); }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) { response.writeHead(416, { ...common, 'Content-Range':`bytes */${stat.size}` }); return response.end(); }
  response.writeHead(206, { ...common, 'Content-Length':end - start + 1, 'Content-Range':`bytes ${start}-${end}/${stat.size}` });
  return fs.createReadStream(filePath, { start, end }).pipe(response);
}

function cloudStatus(vault) {
  const dropbox = vault.cloud?.dropbox || {};
  return {
    dropbox:{ configured:Boolean(DROPBOX_APP_KEY), connected:Boolean(dropbox.refreshToken || dropbox.accessToken), autoBackup:Boolean(dropbox.autoBackup), account:dropbox.account || '', lastUpload:dropbox.lastUpload || '', lastError:dropbox.lastError || '' },
    mega:{ configured:false, connected:false, detail:'Richiede il servizio MEGAcmd locale.' },
  };
}

async function dropboxToken(parameters) {
  const body = new URLSearchParams(parameters);
  if (DROPBOX_APP_SECRET) body.set('client_secret', DROPBOX_APP_SECRET);
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_description || result.error || `Dropbox OAuth ${response.status}`);
  return result;
}

async function validDropboxAccess(dropbox) {
  if (dropbox.accessToken && Number(dropbox.expiresAt || 0) > Date.now() + 60_000) return dropbox.accessToken;
  if (!dropbox.refreshToken) throw new Error('Dropbox authorization expired');
  const result = await dropboxToken({ grant_type:'refresh_token', refresh_token:dropbox.refreshToken, client_id:DROPBOX_APP_KEY });
  dropbox.accessToken = result.access_token;
  dropbox.expiresAt = Date.now() + Number(result.expires_in || 14400) * 1000;
  return dropbox.accessToken;
}

async function uploadToDropbox(vault, camera, filePath) {
  const dropbox = vault.cloud?.dropbox;
  if (!dropbox) throw new Error('Dropbox is not connected');
  const accessToken = await validDropboxAccess(dropbox);
  const remoteName = `/FREDI Control/${String(camera.name || 'Camera').replace(/[\\/:?*<>|]/g, '-')}/${path.basename(filePath)}`;
  const content = fs.readFileSync(filePath);
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method:'POST',
    headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/octet-stream', 'Dropbox-API-Arg':JSON.stringify({ path:remoteName, mode:'overwrite', autorename:false, mute:true }) },
    body:content,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_summary || `Dropbox upload ${response.status}`);
  dropbox.lastUpload = new Date().toISOString(); dropbox.lastError = '';
  return result;
}

let cloudBackupRunning = false;
async function runCloudBackups() {
  if (cloudBackupRunning || !DROPBOX_APP_KEY || !AUTH_READY || !fs.existsSync(ARCHIVE_DIR)) return;
  cloudBackupRunning = true;
  try {
    const data = loadAccounts(); let changed = false;
    for (const account of data.users) {
      const vault = decryptVault(account); const dropbox = vault.cloud?.dropbox;
      if (!dropbox?.autoBackup || (!dropbox.refreshToken && !dropbox.accessToken)) continue;
      const uploaded = new Set(dropbox.uploaded || []);
      for (const camera of vault.cameras) {
        if (!cameraArchiveAuthorized(camera)) continue;
        const key = cameraArchiveKey(camera); if (!key) continue;
        const candidate = fs.readdirSync(ARCHIVE_DIR).filter((name) => name.startsWith(`${key}_`) && name.endsWith('.mp4') && !uploaded.has(name)).sort().at(0);
        if (!candidate) continue;
        const filePath = path.join(ARCHIVE_DIR, candidate);
        if (Date.now() - fs.statSync(filePath).mtimeMs < 15_000) continue;
        try {
          await uploadToDropbox(vault, camera, filePath); uploaded.add(candidate);
          dropbox.uploaded = [...uploaded].slice(-1000); changed = true;
        } catch (error) { dropbox.lastError = error.message; changed = true; }
      }
      if (changed) account.vault = encryptVault(account.id, vault);
    }
    if (changed) saveAccounts(data);
  } finally { cloudBackupRunning = false; }
}

const loginAttempts = new Map();

function loginAllowed(address, maximum = 8) {
  const now = Date.now();
  const current = loginAttempts.get(address);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(address, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  return current.count < maximum;
}

function noteLoginFailure(address) {
  const current = loginAttempts.get(address) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  current.count += 1;
  loginAttempts.set(address, current);
}

function clearLoginFailures(address) {
  loginAttempts.delete(address);
}

function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function authorized(request) {
  const supplied = request.headers.authorization || '';
  const expected = `Bearer ${API_TOKEN}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function send(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65_536) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (request, response) => {
  const headers = corsHeaders(request.headers.origin);
  const requestUrl = new URL(request.url, 'http://gateway.local');
  const pathname = requestUrl.pathname;
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    return response.end();
  }
  if (pathname === '/health' && request.method === 'GET') {
    return send(response, 200, { ok: true, authReady: AUTH_READY, publicRegistration: true }, headers);
  }

  if (pathname === '/api/auth/register' && request.method === 'POST') {
    if (!AUTH_READY) return send(response, 503, { error: 'Account registration is not configured' }, headers);
    const forwarded = cleanText(request.headers['x-forwarded-for'], 200).split(',')[0].trim();
    const address = forwarded || request.socket.remoteAddress || 'unknown';
    const rateKey = `register:${address}`;
    if (!loginAllowed(rateKey, 4)) return send(response, 429, { error: 'Too many registrations. Try again later.' }, headers);
    try {
      const body = await readJson(request);
      const username = cleanText(body.username, 32);
      const email = cleanText(body.email, 254).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new Error('Username must be 3-32 characters using letters, numbers, dot, underscore or dash');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email address is required');
      if (password.length < 12 || password.length > 256) throw new Error('Password must be between 12 and 256 characters');
      const data = loadAccounts();
      if (data.users.length >= MAX_USERS) return send(response, 503, { error: 'Registration capacity reached' }, headers);
      const normalizedUsername = username.toLowerCase();
      if (data.users.some((account) => account.username.toLowerCase() === normalizedUsername)) return send(response, 409, { error: 'Username already registered' }, headers);
      if (data.users.some((account) => account.email === email)) return send(response, 409, { error: 'Email already registered' }, headers);
      const salt = crypto.randomBytes(16).toString('hex');
      const account = {
        id:crypto.randomUUID(),
        username,
        email,
        passwordSalt:salt,
        passwordHash:passwordHash(password, salt),
        passwordIterations:DASHBOARD_PASSWORD_ITERATIONS,
        sessionVersion:crypto.randomBytes(16).toString('hex'),
        createdAt:new Date().toISOString(),
        vault:null,
      };
      account.vault = encryptVault(account.id, {
        version:1,
        cameras:[],
        events:[vaultEvent('success', 'Account creato', 'Il vault personale è pronto.')],
        preferences:cleanPreferences({}),
        cloud:{},
      });
      data.users.push(account);
      saveAccounts(data);
      noteLoginFailure(rateKey);
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      const token = signSession({ sub:account.id, username:account.username, ver:account.sessionVersion, exp:expiresAt, nonce:crypto.randomBytes(12).toString('hex') });
      return send(response, 201, { ok:true, account:publicAccount(account), expiresAt, token }, headers);
    } catch (error) {
      console.error(`Registration failed: ${error.message}`);
      const validationError = /^(Username must|A valid email address|Password must)/.test(error.message);
      if (validationError) noteLoginFailure(rateKey);
      return send(response, validationError ? 400 : 500, { error:validationError ? error.message : 'Registration could not be completed' }, headers);
    }
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (!AUTH_READY) return send(response, 503, { error: 'Account login is not configured' }, headers);
    const forwarded = cleanText(request.headers['x-forwarded-for'], 200).split(',')[0].trim();
    const address = forwarded || request.socket.remoteAddress || 'unknown';
    const rateKey = `login:${address}`;
    if (!loginAllowed(rateKey)) return send(response, 429, { error: 'Too many login attempts. Try again later.' }, headers);
    try {
      const body = await readJson(request);
      const identity = cleanText(body.username, 254).toLowerCase();
      const data = loadAccounts();
      const account = data.users.find((candidate) => candidate.username.toLowerCase() === identity || candidate.email === identity);
      if (!account || !passwordMatches(body.password, account)) {
        noteLoginFailure(rateKey);
        await new Promise((resolve) => setTimeout(resolve, 350));
        return send(response, 401, { error: 'Invalid username or password' }, headers);
      }
      clearLoginFailures(rateKey);
      addAccountEvent(account, 'success', 'Nuovo accesso', 'Accesso completato alla dashboard.');
      saveAccounts(data);
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      const token = signSession({ sub:account.id, username:account.username, ver:account.sessionVersion || '1', exp:expiresAt, nonce:crypto.randomBytes(12).toString('hex') });
      return send(response, 200, { ok:true, account:publicAccount(account), expiresAt, token }, headers);
    } catch (error) {
      console.error(`Login failed: ${error.message}`);
      return send(response, 500, { error:'Login service temporarily unavailable' }, headers);
    }
  }

  if (pathname === '/api/cloud/dropbox/callback' && request.method === 'GET') {
    const state = cleanText(requestUrl.searchParams.get('state'), 200);
    const pending = pendingDropbox.get(state); pendingDropbox.delete(state);
    if (!pending || pending.expiresAt < Date.now()) { response.writeHead(302, { Location:`${DASHBOARD_URL}/?cloud=dropbox-expired` }); return response.end(); }
    try {
      const code = cleanText(requestUrl.searchParams.get('code'), 2048);
      const token = await dropboxToken({ code, grant_type:'authorization_code', client_id:DROPBOX_APP_KEY, redirect_uri:DROPBOX_REDIRECT_URI, code_verifier:pending.verifier });
      const profileResponse = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method:'POST', headers:{ Authorization:`Bearer ${token.access_token}`, 'Content-Type':'application/json' }, body:'null' });
      const profile = await profileResponse.json().catch(() => ({}));
      const data = loadAccounts();
      const account = data.users.find((item) => item.id === pending.accountId);
      if (!account) throw new Error('Account no longer exists');
      const vault = decryptVault(account); vault.cloud ||= {};
      vault.cloud.dropbox = { accessToken:token.access_token, refreshToken:token.refresh_token || '', expiresAt:Date.now() + Number(token.expires_in || 14400) * 1000, account:profile.email || profile.name?.display_name || token.account_id || 'Dropbox', autoBackup:false, uploaded:[] };
      vault.events.unshift(vaultEvent('success', 'Dropbox collegato', 'Il cloud è pronto per il backup delle registrazioni.'));
      account.vault = encryptVault(account.id, vault); saveAccounts(data);
      response.writeHead(302, { Location:`${DASHBOARD_URL}/?cloud=dropbox-connected` }); return response.end();
    } catch (error) {
      console.error(`Dropbox callback: ${error.message}`);
      response.writeHead(302, { Location:`${DASHBOARD_URL}/?cloud=dropbox-error` }); return response.end();
    }
  }

  const session = sessionFromRequest(request);
  if (pathname === '/api/archive/file' && request.method === 'GET') {
    const access = verifySignedToken(requestUrl.searchParams.get('access') || '');
    if (!access || access.kind !== 'archive') return send(response, 401, { error:'Archive link expired' }, headers);
    const data = loadAccounts();
    const account = accountFromSession(access, data);
    const filePath = account ? archiveFileForAccount(account, access.cameraId, access.name) : null;
    if (!filePath) return send(response, 404, { error:'Archive clip not found' }, headers);
    return sendArchiveFile(request, response, filePath, headers);
  }

  if (pathname === '/api/auth/session' && request.method === 'GET') {
    if (!session) return send(response, 401, { error: 'Unauthorized' }, headers);
    const account = accountFromSession(session, loadAccounts());
    if (!account) return send(response, 401, { error: 'Unauthorized' }, headers);
    return send(response, 200, { ok:true, account:publicAccount(account), expiresAt:session.exp }, headers);
  }

  if (pathname === '/api/archive' && request.method === 'GET') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const data = loadAccounts();
      const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
      const vault = decryptVault(account);
      const cameraId = cleanText(requestUrl.searchParams.get('cameraId'), 80);
      const date = cleanText(requestUrl.searchParams.get('date'), 10);
      const camera = vault.cameras.find((item) => item.id === cameraId);
      if (!camera) return send(response, 404, { error:'Camera not found' }, headers);
      if (!cameraArchiveAuthorized(camera)) return send(response, 403, { error:'Archive access is not configured for this camera' }, headers);
      const clips = archiveEntries(camera, date).map((clip) => ({
        ...clip,
        access:signSession({ kind:'archive', sub:account.id, ver:account.sessionVersion || '1', exp:Date.now() + 10 * 60 * 1000, cameraId, name:clip.name }),
      }));
      const usage = clips.reduce((sum, clip) => sum + clip.size, 0);
      return send(response, 200, { ok:true, date, cameraId, clips, usage, retentionDays:Number(process.env.ARCHIVE_RETENTION_DAYS || 7), sdCardSupported:false }, headers);
    } catch (error) {
      console.error(`Archive: ${error.message}`);
      return send(response, 500, { error:'Archive temporarily unavailable' }, headers);
    }
  }

  if (pathname === '/api/cloud' && request.method === 'GET') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    const account = accountFromSession(session, loadAccounts());
    if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
    return send(response, 200, { ok:true, ...cloudStatus(decryptVault(account)) }, headers);
  }

  if (pathname === '/api/cloud/dropbox/start' && request.method === 'POST') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    const account = accountFromSession(session, loadAccounts());
    if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
    if (!DROPBOX_APP_KEY) return send(response, 503, { error:'Dropbox app is not configured on the gateway' }, headers);
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    pendingDropbox.set(state, { accountId:account.id, verifier, expiresAt:Date.now() + 10 * 60 * 1000 });
    const authorize = new URL('https://www.dropbox.com/oauth2/authorize');
    authorize.search = new URLSearchParams({ client_id:DROPBOX_APP_KEY, response_type:'code', redirect_uri:DROPBOX_REDIRECT_URI, token_access_type:'offline', code_challenge_method:'S256', code_challenge:challenge, state }).toString();
    return send(response, 200, { ok:true, authorizationUrl:authorize.toString() }, headers);
  }

  if (pathname === '/api/cloud/dropbox/settings' && request.method === 'PUT') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const body = await readJson(request); const data = loadAccounts(); const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
      const vault = decryptVault(account); if (!vault.cloud?.dropbox) return send(response, 409, { error:'Dropbox is not connected' }, headers);
      vault.cloud.dropbox.autoBackup = Boolean(body.autoBackup);
      account.vault = encryptVault(account.id, vault); saveAccounts(data);
      return send(response, 200, { ok:true, ...cloudStatus(vault) }, headers);
    } catch (error) { return send(response, 400, { error:error.message }, headers); }
  }

  if (pathname === '/api/cloud/dropbox/disconnect' && request.method === 'DELETE') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    const data = loadAccounts(); const account = accountFromSession(session, data);
    if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
    const vault = decryptVault(account); if (vault.cloud) delete vault.cloud.dropbox;
    account.vault = encryptVault(account.id, vault); saveAccounts(data);
    return send(response, 200, { ok:true, ...cloudStatus(vault) }, headers);
  }

  if (pathname === '/api/cloud/dropbox/upload' && request.method === 'POST') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const body = await readJson(request); const data = loadAccounts(); const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
      const vault = decryptVault(account); const camera = vault.cameras.find((item) => item.id === cleanText(body.cameraId, 80));
      const filePath = camera ? archiveFileForAccount(account, camera.id, cleanText(body.name, 200)) : null;
      if (!camera || !filePath) return send(response, 404, { error:'Archive clip not found' }, headers);
      const result = await uploadToDropbox(vault, camera, filePath);
      vault.cloud.dropbox.uploaded = [...new Set([...(vault.cloud.dropbox.uploaded || []), path.basename(filePath)])].slice(-1000);
      vault.events.unshift(vaultEvent('success', 'Clip salvata su Dropbox', `${camera.name}: ${path.basename(filePath)}`));
      account.vault = encryptVault(account.id, vault); saveAccounts(data);
      return send(response, 201, { ok:true, name:result.name, path:result.path_display, cloud:cloudStatus(vault) }, headers);
    } catch (error) {
      console.error(`Dropbox upload: ${error.message}`);
      return send(response, 502, { error:'Dropbox upload failed', detail:error.message }, headers);
    }
  }

  if (pathname === '/api/cameras') {
    if (!session) return send(response, 401, { error: 'Unauthorized' }, headers);
    try {
      const data = loadAccounts();
      const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error: 'Unauthorized' }, headers);
      if (request.method === 'GET') {
        return send(response, 200, publicVault(decryptVault(account)), headers);
      }
      if (request.method === 'PUT') {
        const body = await readJson(request);
        const vault = decryptVault(account);
        vault.cameras = cleanCameras(body.cameras);
        vault.events.unshift(vaultEvent('camera', 'Camere aggiornate', `${vault.cameras.length} configurazioni nel vault.`));
        vault.events = vault.events.slice(0, 100);
        account.vault = encryptVault(account.id, vault);
        saveAccounts(data);
        return send(response, 200, publicVault(vault), headers);
      }
      return send(response, 405, { error: 'Method not allowed' }, headers);
    } catch (error) {
      console.error(`Camera vault: ${error.message}`);
      const validationError = /^(Invalid cameras list|Duplicate camera id|Only HTTP\/HTTPS)/.test(error.message);
      return send(response, validationError ? 400 : 500, { error:validationError ? 'Camera configuration rejected' : 'Camera vault temporarily unavailable', ...(validationError ? { detail:error.message } : {}) }, headers);
    }
  }

  if (pathname === '/api/preferences') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const data = loadAccounts();
      const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
      const vault = decryptVault(account);
      if (request.method === 'GET') return send(response, 200, { preferences:cleanPreferences(vault.preferences) }, headers);
      if (request.method === 'PUT') {
        const body = await readJson(request);
        vault.preferences = cleanPreferences(body.preferences);
        account.vault = encryptVault(account.id, vault);
        saveAccounts(data);
        return send(response, 200, { preferences:vault.preferences }, headers);
      }
      return send(response, 405, { error:'Method not allowed' }, headers);
    } catch (error) {
      console.error(`Preferences: ${error.message}`);
      return send(response, 500, { error:'Preferences temporarily unavailable' }, headers);
    }
  }

  if (pathname === '/api/events') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const data = loadAccounts();
      const account = accountFromSession(session, data);
      if (!account) return send(response, 401, { error:'Unauthorized' }, headers);
      const vault = decryptVault(account);
      if (request.method === 'GET') return send(response, 200, { events:vault.events }, headers);
      if (request.method === 'POST') {
        const body = await readJson(request);
        vault.events.unshift(vaultEvent(body.type, body.title, body.detail));
        vault.events = vault.events.slice(0, 100);
        account.vault = encryptVault(account.id, vault);
        saveAccounts(data);
        return send(response, 201, { events:vault.events }, headers);
      }
      if (request.method === 'DELETE') {
        vault.events = [];
        account.vault = encryptVault(account.id, vault);
        saveAccounts(data);
        return send(response, 200, { ok:true, events:[] }, headers);
      }
      return send(response, 405, { error:'Method not allowed' }, headers);
    } catch (error) {
      console.error(`Events: ${error.message}`);
      return send(response, 500, { error:'Events temporarily unavailable' }, headers);
    }
  }

  if (pathname === '/api/account/password' && request.method === 'PUT') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const body = await readJson(request);
      const data = loadAccounts();
      const account = accountFromSession(session, data);
      if (!account || !passwordMatches(body.currentPassword, account)) return send(response, 401, { error:'Current password is incorrect' }, headers);
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (newPassword.length < 12 || newPassword.length > 256) throw new Error('New password must be between 12 and 256 characters');
      const salt = crypto.randomBytes(16).toString('hex');
      account.passwordSalt = salt;
      account.passwordHash = passwordHash(newPassword, salt);
      account.passwordIterations = DASHBOARD_PASSWORD_ITERATIONS;
      account.sessionVersion = crypto.randomBytes(16).toString('hex');
      addAccountEvent(account, 'security', 'Password modificata', 'Le altre sessioni sono state revocate.');
      saveAccounts(data);
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      const token = signSession({ sub:account.id, username:account.username, ver:account.sessionVersion, exp:expiresAt, nonce:crypto.randomBytes(12).toString('hex') });
      return send(response, 200, { ok:true, account:publicAccount(account), expiresAt, token }, headers);
    } catch (error) {
      return send(response, 400, { error:error.message }, headers);
    }
  }

  if (pathname === '/api/account' && request.method === 'DELETE') {
    if (!session) return send(response, 401, { error:'Unauthorized' }, headers);
    try {
      const body = await readJson(request);
      const data = loadAccounts();
      const index = data.users.findIndex((account) => account.id === session.sub);
      const account = index >= 0 ? data.users[index] : null;
      if (!account || session.ver !== (account.sessionVersion || '1')) return send(response, 401, { error:'Unauthorized' }, headers);
      if (!passwordMatches(body.password, account)) return send(response, 401, { error:'Password is incorrect' }, headers);
      data.users.splice(index, 1);
      saveAccounts(data);
      return send(response, 200, { ok:true }, headers);
    } catch (error) {
      return send(response, 400, { error:error.message }, headers);
    }
  }

  if (!authorized(request)) {
    return send(response, 401, { error: 'Unauthorized' }, headers);
  }

  try {
    const body = await readJson(request);
    if (pathname === '/api/ptz' && request.method === 'POST') {
      const step = Math.min(30, Math.max(3, Number(body.step) || IPC365_PTZ_STEP));
      await move(body.action, step);
      console.log(`PTZ ${body.action} step ${step} completed in ${MOVE_DURATION}ms`);
      return send(response, 200, { ok: true, action: body.action, step, durationMs: MOVE_DURATION }, headers);
    }
    if (pathname === '/api/capabilities' && request.method === 'GET') {
      return send(response, 200, {
        ok:true,
        protocol:'ipc365-local',
        features:{
          liveVideo:true,
          liveAudio:true,
          ptz:true,
          snapshot:true,
          localRecording:true,
          orientation:true,
          light:false,
          guard:false,
          talk:false,
          sdPlayback:false,
          cloudPlayback:false,
        },
      }, headers);
    }
    if (pathname === '/api/ptz/preset' && request.method === 'POST') {
      await gotoPreset(Number(body.preset));
      return send(response, 200, { ok: true, preset: Number(body.preset) }, headers);
    }
    return send(response, 404, { error: 'Not found' }, headers);
  } catch (error) {
    console.error(error.message);
    return send(response, 502, { error: 'ONVIF command failed', detail: error.message }, headers);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Camera gateway listening on port ${PORT}; ONVIF ${HOST}:${ONVIF_PORT}; IPC365 PTZ ${HOST}:${IPC365_PTZ_PORT}`);
});

setInterval(() => runCloudBackups().catch((error) => console.error(`Cloud backup: ${error.message}`)), 60_000).unref();
