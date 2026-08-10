'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionKey, featureCapabilities, parseFrediCommands, parseIpcCommands, publicState } = require('./device-actions');

test('accepts only known device actions', () => {
  assert.equal(actionKey('light', 'auto'), 'light:auto');
  assert.throws(() => actionKey('light', 'blink'), /Unsupported/);
  assert.throws(() => actionKey('shell', 'run'), /Unsupported/);
});

test('requires an acknowledgement signature for IPC commands', () => {
  const frame = Buffer.alloc(72, 1).toString('base64');
  const expect = Buffer.from([0xcc, 0xdd, 0xee, 0xff]).toString('base64');
  const commands = parseIpcCommands(JSON.stringify({ 'alarm:on':{ frame, expect } }));
  assert.equal(commands['alarm:on'].frame.length, 72);
  assert.deepEqual(commands['alarm:on'].expect, Buffer.from([0xcc, 0xdd, 0xee, 0xff]));
  assert.throws(() => parseIpcCommands(JSON.stringify({ 'alarm:on':{ frame } })), /requires frame and expect/);
});

test('rejects newline injection in fixed FREDI commands', () => {
  assert.deepEqual(parseFrediCommands('{"light:on":"/var/tmp/sd/devctl light on"}'), { 'light:on':'/var/tmp/sd/devctl light on' });
  assert.throws(() => parseFrediCommands('{"light:on":"true\\nreboot"}'), /Invalid FREDI command/);
});

test('advertises a feature only when its complete command set exists', () => {
  assert.equal(featureCapabilities({ 'alarm:on':1 }).guard, false);
  assert.equal(featureCapabilities({ 'alarm:on':1, 'alarm:off':1 }).guard, true);
  assert.equal(featureCapabilities({ 'zoom:in':1, 'zoom:out':1, 'zoom:stop':1 }).opticalZoom, true);
});

test('normalizes unknown state without inventing a device value', () => {
  assert.deepEqual(publicState({ light:'on', alarm:'broken' }), {
    light:'on', nightVision:'unknown', alarm:'unknown', tracking:'unknown', zoom:'stop', sdRecording:'unknown',
  });
});
