'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { alarmTriggerFrame, keepaliveFrame, talkAudioFrame, talkCloseFrame, talkHandshakeFrames, talkStateFrame } = require('./ipc365-protocol');

const ids = { clientId:'e4126900', sourceId:'7ce0db3b', deviceId:'e3856f02' };

test('builds the captured IPC365 talk handshake exactly', () => {
  const frames = talkHandshakeFrames(ids);
  assert.equal(frames.request.toString('hex'),
    'ccddeeff419c0000e412690020000000000000007ce0db3be3856f0229000000'.repeat(3) +
    'ccddeeff4d9c0000e41269002400000000000000e3856f0229000000010001007ce0db3b');
  assert.equal(frames.acknowledge.toString('hex'),
    'ccddeeff429c0000e412690020000000000000007ce0db3be3856f0229000000'.repeat(3));
  assert.equal(talkCloseFrame(ids).toString('hex'),
    'ccddeeff4f9c0000e41269002c00000000000000e3856f0229000000010000007ce0db3b0100000000000000');
});

test('builds the talk speaker state captured from the official app', () => {
  assert.equal(talkStateFrame(true, ids).toString('hex'),
    'ccddeeff354f0000e41269002c000000000000007ce0db3be3856f0201000000010000000000000000000000');
  assert.equal(talkStateFrame(false, ids).toString('hex'),
    'ccddeeff354f0000e41269002c000000000000007ce0db3be3856f0201000000000000000000000000000000');
});

test('builds 40 ms A-law audio and keepalive frames', () => {
  const audio = talkAudioFrame(Buffer.alloc(640), 7, ids);
  assert.equal(audio.length, 352);
  assert.equal(audio.readUInt32LE(4), 0x9c57);
  assert.equal(audio.readUInt32LE(28), 7);
  assert.ok(audio.subarray(32).every((value) => value === 0xd5));
  assert.equal(keepaliveFrame(ids.clientId).toString('hex'), 'ccddeeff01000000e41269001400000000000000');
});

test('builds the alarm sound command captured from the official app', () => {
  assert.equal(alarmTriggerFrame(ids).toString('hex'),
    'ccddeeffb04f0000e412690038000000000000007ce0db3be3856f0214000000807701007ce0db3be3856f02000000000000000000000000');
});
