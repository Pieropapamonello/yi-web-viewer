'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
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

if (!USERNAME || !PASSWORD || API_TOKEN.length < 24) {
  console.error('ONVIF_USERNAME, ONVIF_PASSWORD and an API_TOKEN of at least 24 characters are required.');
  process.exit(1);
}

let cameraPromise;

function connectCamera() {
  if (!cameraPromise) {
    cameraPromise = new Promise((resolve, reject) => {
      const camera = new Cam({
        hostname: HOST,
        port: ONVIF_PORT,
        username: USERNAME,
        password: PASSWORD,
        timeout: 8000,
      }, (error) => error ? reject(error) : resolve(camera));
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

async function move(action) {
  const camera = await connectCamera();
  if (action === 'home') {
    await call(camera, 'gotoHomePosition', {});
    return;
  }

  const vectors = {
    up: { x: 0, y: MOVE_SPEED },
    down: { x: 0, y: -MOVE_SPEED },
    left: { x: -MOVE_SPEED, y: 0 },
    right: { x: MOVE_SPEED, y: 0 },
  };
  const vector = vectors[action];
  if (!vector) throw new Error('Unsupported PTZ action');

  await call(camera, 'continuousMove', {
    ...vector,
    onlySendPanTilt: true,
    timeout: MOVE_DURATION + 500,
  });
  await new Promise((resolve) => setTimeout(resolve, MOVE_DURATION));
  await stop(camera);
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

function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
    if (body.length > 16_384) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (request, response) => {
  const headers = corsHeaders(request.headers.origin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    return response.end();
  }
  if (request.url === '/health' && request.method === 'GET') {
    return send(response, 200, { ok: true }, headers);
  }
  if (!authorized(request)) {
    return send(response, 401, { error: 'Unauthorized' }, headers);
  }

  try {
    const body = await readJson(request);
    if (request.url === '/api/ptz' && request.method === 'POST') {
      await move(body.action);
      return send(response, 200, { ok: true, action: body.action }, headers);
    }
    if (request.url === '/api/ptz/preset' && request.method === 'POST') {
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
  console.log(`ONVIF gateway listening on port ${PORT}; camera ${HOST}:${ONVIF_PORT}`);
});
