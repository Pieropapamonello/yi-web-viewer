'use strict';

function ipc365Id(value, name) {
  if (!/^[a-f0-9]{8}$/i.test(value)) throw new Error(`${name} must contain exactly 8 hexadecimal characters`);
  return Buffer.from(value, 'hex');
}

function baseFrame(opcode, length, clientId) {
  const frame = Buffer.alloc(length);
  frame.set([0xcc, 0xdd, 0xee, 0xff], 0);
  frame.writeUInt32LE(opcode, 4);
  ipc365Id(clientId, 'IPC365_CLIENT_ID').copy(frame, 8);
  frame.writeUInt32LE(length, 12);
  return frame;
}

function talkHandshakeFrames({ clientId, sourceId, deviceId }) {
  const source = ipc365Id(sourceId, 'IPC365_SOURCE_ID');
  const device = ipc365Id(deviceId, 'IPC365_DEVICE_ID');
  const hello = baseFrame(0x9c41, 32, clientId);
  source.copy(hello, 20); device.copy(hello, 24); hello.writeUInt32LE(0x29, 28);
  const open = baseFrame(0x9c4d, 36, clientId);
  device.copy(open, 20); open.writeUInt32LE(0x29, 24);
  open.set([0x01, 0x00, 0x01, 0x00], 28); source.copy(open, 32);
  const acknowledge = baseFrame(0x9c42, 32, clientId);
  source.copy(acknowledge, 20); device.copy(acknowledge, 24); acknowledge.writeUInt32LE(0x29, 28);
  return { request:Buffer.concat([hello, hello, hello, open]), acknowledge:Buffer.concat([acknowledge, acknowledge, acknowledge]) };
}

function talkCloseFrame({ clientId, sourceId, deviceId }) {
  const frame = baseFrame(0x9c4f, 44, clientId);
  ipc365Id(deviceId, 'IPC365_DEVICE_ID').copy(frame, 20);
  frame.writeUInt32LE(0x29, 24); frame.writeUInt32LE(1, 28);
  ipc365Id(sourceId, 'IPC365_SOURCE_ID').copy(frame, 32);
  frame.writeUInt32LE(1, 36);
  return frame;
}

function keepaliveFrame(clientId) { return baseFrame(1, 20, clientId); }

function linearToAlaw(sample) {
  let value = Math.max(-32768, Math.min(32767, sample));
  const sign = value < 0 ? 0x00 : 0x80;
  if (value < 0) value = -value - 1;
  value = Math.min(value, 32635);
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); exponent -= 1, mask >>= 1) { /* locate segment */ }
  const mantissa = exponent === 0 ? (value >> 4) & 0x0f : (value >> (exponent + 3)) & 0x0f;
  return (sign | (exponent << 4) | mantissa) ^ 0x55;
}

function talkAudioFrame(pcm, sequence, { clientId, sourceId }) {
  if (!Buffer.isBuffer(pcm) || pcm.length !== 640) throw new Error('IPC365 talk frame requires exactly 40 ms of PCM');
  const frame = baseFrame(0x9c57, 352, clientId);
  frame.writeUInt32LE(0x29, 20);
  ipc365Id(sourceId, 'IPC365_SOURCE_ID').copy(frame, 24);
  frame.writeUInt32LE(sequence >>> 0, 28);
  for (let index = 0; index < 320; index += 1) frame[32 + index] = linearToAlaw(pcm.readInt16LE(index * 2));
  return frame;
}

function alarmTriggerFrame({ clientId, sourceId, deviceId }) {
  const frame = baseFrame(0x4fb0, 56, clientId);
  const source = ipc365Id(sourceId, 'IPC365_SOURCE_ID');
  const device = ipc365Id(deviceId, 'IPC365_DEVICE_ID');
  source.copy(frame, 20); device.copy(frame, 24);
  frame.writeUInt32LE(20, 28); frame.writeUInt32LE(0x17780, 32);
  source.copy(frame, 36); device.copy(frame, 40);
  return frame;
}

module.exports = { alarmTriggerFrame, ipc365Id, keepaliveFrame, talkAudioFrame, talkCloseFrame, talkHandshakeFrames };
