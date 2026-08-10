'use strict';

const ACTION_VALUES = Object.freeze({
  light: ['off', 'on', 'auto'],
  nightVision: ['off', 'on', 'auto'],
  alarm: ['off', 'on'],
  tracking: ['off', 'on'],
  zoom: ['in', 'out', 'stop'],
  sdRecording: ['off', 'continuous', 'event'],
});

function actionKey(feature, value) {
  if (!Object.hasOwn(ACTION_VALUES, feature) || !ACTION_VALUES[feature].includes(value)) {
    throw new Error('Unsupported device action');
  }
  return `${feature}:${value}`;
}

function parseJsonObject(source, name) {
  if (!source) return {};
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error(`${name} must be valid JSON`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${name} must be a JSON object`);
  return value;
}

function validBase64(value, maximum = 16384) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.length % 4) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parseIpcCommands(source) {
  const input = parseJsonObject(source, 'IPC365_DEVICE_COMMANDS_JSON');
  return Object.fromEntries(Object.entries(input).map(([key, spec]) => {
    const [feature, value, extra] = key.split(':');
    if (extra || actionKey(feature, value) !== key) throw new Error(`Invalid IPC365 action ${key}`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Invalid IPC365 command ${key}`);
    if (!validBase64(spec.frame) || !validBase64(spec.expect)) throw new Error(`IPC365 command ${key} requires frame and expect in base64`);
    const frame = Buffer.from(spec.frame, 'base64');
    const expect = Buffer.from(spec.expect, 'base64');
    if (frame.length < 32 || frame.length > 4096 || !expect.length || expect.length > 1024) throw new Error(`Invalid IPC365 command size for ${key}`);
    return [key, {
      frame,
      expect,
      patchIds:spec.patchIds !== false,
      timeoutMs:Math.min(10000, Math.max(250, Number(spec.timeoutMs) || 2500)),
    }];
  }));
}

function parseFrediCommands(source) {
  const input = parseJsonObject(source, 'FREDI_DEVICE_COMMANDS_JSON');
  return Object.fromEntries(Object.entries(input).map(([key, command]) => {
    const [feature, value, extra] = key.split(':');
    if (extra || actionKey(feature, value) !== key) throw new Error(`Invalid FREDI action ${key}`);
    if (typeof command !== 'string' || !command.trim() || command.length > 512 || /[\r\n\0]/.test(command)) throw new Error(`Invalid FREDI command ${key}`);
    return [key, command.trim()];
  }));
}

function featureCapabilities(commands) {
  const keys = new Set(Object.keys(commands));
  const has = (feature, values) => values.every((value) => keys.has(`${feature}:${value}`));
  return {
    light:has('light', ['off', 'on']),
    lightAuto:has('light', ['auto']),
    nightVision:has('nightVision', ['off', 'on']),
    nightVisionAuto:has('nightVision', ['auto']),
    guard:has('alarm', ['off', 'on']),
    nativeTracking:has('tracking', ['off', 'on']),
    opticalZoom:has('zoom', ['in', 'out', 'stop']),
    nativeSdRecording:has('sdRecording', ['off', 'continuous', 'event']),
  };
}

function publicState(state = {}) {
  return {
    light:['off', 'on', 'auto'].includes(state.light) ? state.light : 'unknown',
    nightVision:['off', 'on', 'auto'].includes(state.nightVision) ? state.nightVision : 'unknown',
    alarm:['off', 'on'].includes(state.alarm) ? state.alarm : 'unknown',
    tracking:['off', 'on'].includes(state.tracking) ? state.tracking : 'unknown',
    zoom:'stop',
    sdRecording:['off', 'continuous', 'event'].includes(state.sdRecording) ? state.sdRecording : 'unknown',
  };
}

module.exports = {
  ACTION_VALUES,
  actionKey,
  featureCapabilities,
  parseFrediCommands,
  parseIpcCommands,
  publicState,
};
