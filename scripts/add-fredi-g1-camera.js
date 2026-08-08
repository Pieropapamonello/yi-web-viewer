'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const accountsFile = process.env.ACCOUNTS_FILE || '/data/accounts.json';
const key = Buffer.from(process.env.VAULT_KEY || '', 'hex');
const username = process.argv[2] || '';

if (key.length !== 32) throw new Error('VAULT_KEY must be a 32-byte hexadecimal key');
if (!username) throw new Error('Pass the target username as the first argument');

function decrypt(account) {
  const envelope = account.vault;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`fredi-camera-vault-v2:${account.id}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

function encrypt(accountId, vault) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`fredi-camera-vault-v2:${accountId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()]);
  return {
    version:1,
    iv:iv.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'),
    ciphertext:ciphertext.toString('base64'),
  };
}

const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
const account = data.users.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
if (!account) throw new Error(`Account ${username} not found`);
const vault = decrypt(account);
vault.cameras ||= [];

if (!vault.cameras.some((camera) => camera.archiveKey === 'yi' || camera.streamUrl?.includes('/yi/'))) {
  const credentialSource = vault.cameras.find((camera) => camera.streamUsername && camera.streamPassword) || {};
  vault.cameras.push({
    id:crypto.randomUUID(),
    name:'FREDI G1',
    model:'FREDI G1 · firmware RTSP',
    location:'Da impostare',
    notes:'RTSP locale 192.168.1.78 · H.264 1080p',
    favorite:false,
    streamUrl:'https://camera.nelloonrender.duckdns.org/yi/index.m3u8',
    streamLowUrl:'https://camera.nelloonrender.duckdns.org/yi-low/index.m3u8',
    webrtcUrl:'https://rtc.nelloonrender.duckdns.org/yi-webrtc/whep',
    streamUsername:credentialSource.streamUsername || '',
    streamPassword:credentialSource.streamPassword || '',
    apiBaseUrl:'',
    apiToken:'',
    ptz:false,
    rotation:0,
    motionDetection:true,
    archiveKey:'yi',
  });
  vault.events ||= [];
  vault.events.unshift({
    id:crypto.randomUUID(),
    type:'camera',
    title:'FREDI G1 aggiunta',
    detail:'Profili HLS 1080p, 480p e WebRTC configurati.',
    createdAt:new Date().toISOString(),
  });
  vault.events = vault.events.slice(0, 100);
  account.vault = encrypt(account.id, vault);
  const temporary = `${accountsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode:0o600 });
  fs.renameSync(temporary, accountsFile);
  console.log('FREDI G1 added');
} else {
  console.log('FREDI G1 already present');
}
