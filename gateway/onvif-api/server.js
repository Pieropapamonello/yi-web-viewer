'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
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
  0xe3, 0x12, 0x69, 0x00, 0x48, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xaf, 0x93, 0xc6, 0x3b,
  0x09, 0xf7, 0x4b, 0x01, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

function ipc365Frame(action) {
  const frame = Buffer.alloc(64);
  IPC365_HEADER.copy(frame);
  const vectors = {
    right: [5, 0],
    left: [-5, 0],
    up: [0, 5],
    down: [0, -5],
    stop: [0, 0],
  };
  const vector = vectors[action];
  if (!vector) throw new Error('Unsupported IPC365 PTZ action');
  frame.writeInt32LE(vector[0], 36);
  frame.writeInt32LE(vector[1], 40);
  return frame;
}

function ipc365Move(action) {
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
      socket.write(ipc365Frame(action), (error) => {
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

async function move(action) {
  await ipc365Move(action === 'home' ? 'stop' : action);
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
  console.log(`Camera gateway listening on port ${PORT}; ONVIF ${HOST}:${ONVIF_PORT}; IPC365 PTZ ${HOST}:${IPC365_PTZ_PORT}`);
});
