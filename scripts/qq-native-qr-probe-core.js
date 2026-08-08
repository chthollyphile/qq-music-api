const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

// M1-only protocol probe. Production HTTP endpoints are intentionally deferred to M2.

const PROTOCOL_SOURCE = Object.freeze({
  repository: 'https://github.com/L-1124/QQMusicApi',
  commit: '8ec78ce3f16805ebe470b8308a96fef925cf8e56',
  inspectedAt: '2026-08-03',
});

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
const QIMEI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEIxgwoutfwoJxcGQeedgP7FG9qaIuS0qzfR8gWkrkTZKM2iWHn2ajQpBRZjMSoSf6+KJGvar2ORhBfpDXyVtZCKpqLQ+FLkpncClKVIrBwv6PHyUvuCb0rIarmgDnzkfQAqVufEtR64iazGDKatvJ9y6B9NMbHddGSAUmRTCrHQIDAQAB
-----END PUBLIC KEY-----`;
const QIMEI_SECRET = 'ZdJqM15EeO2zWc08';
const QIMEI_APP_KEY = '0AND0HD6FE4HY80F';
const CHANNEL_ID = '10003505';
const PACKAGE_ID = 'com.tencent.qqmusic';

function md5(...values) {
  const hash = crypto.createHash('md5');
  for (const value of values) hash.update(value);
  return hash.digest('hex');
}

function fingerprint(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function randomDigits(length) {
  let value = '';
  for (let index = 0; index < length; index += 1) value += crypto.randomInt(0, 10);
  return value;
}

function randomImei() {
  const digits = randomDigits(14).split('').map(Number);
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits[index];
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  digits.push((10 - (sum % 10)) % 10);
  return digits.join('');
}

function createDevice() {
  return {
    display: `QMAPI.${randomDigits(6)}.001`,
    product: 'iarim',
    device: 'sagit',
    board: 'eomam',
    model: 'MI 6',
    fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${randomDigits(7)}:user/release-keys`,
    procVersion: `Linux 5.4.0-54-generic-${randomHex(8)} (android-build@google.com)`,
    imei: randomImei(),
    brand: 'Xiaomi',
    androidId: randomHex(16),
    openUdid: randomHex(32),
    osRelease: '10',
    sdk: 29,
    qimei: null,
    qimei36: null,
    qimeiSavedAt: null,
    sessionUid: null,
    sessionSid: null,
    sessionVkey: null,
    sessionSavedAt: null,
  };
}

function loadOrCreateDevice(devicePath) {
  if (fs.existsSync(devicePath)) return JSON.parse(fs.readFileSync(devicePath, 'utf8'));
  const device = createDevice();
  savePrivateJson(devicePath, device);
  return device;
}

function savePrivateJson(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function randomBeaconId(now = new Date()) {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const first = randomDigits(6);
  const second = randomDigits(9);
  const datedKeys = new Set([1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38]);
  let beacon = '';
  for (let key = 1; key <= 40; key += 1) {
    if (datedKeys.has(key)) beacon += `k${key}:${month}${first}.${second}`;
    else if (key === 3) beacon += 'k3:0000000000000000';
    else if (key === 4) beacon += `k4:${randomHex(16).replaceAll('0', '1')}`;
    else beacon += `k${key}:${crypto.randomInt(0, 10000)}`;
    beacon += ';';
  }
  return beacon;
}

function buildQimeiPayload(device, now = new Date()) {
  const uptimeSeconds = crypto.randomInt(0, 14401);
  const uptime = new Date(now.getTime() - uptimeSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const reserved = {
    harmony: '0',
    clone: '0',
    containe: '',
    oz: 'UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=',
    oo: 'Xecjt+9S1+f8Pz2VLSxgpw==',
    kelong: '0',
    uptimes: uptime,
    multiUser: '0',
    bod: device.brand,
    dv: device.device,
    firstLevel: '',
    manufact: device.brand,
    name: device.model,
    host: 'se.infra',
    kernel: device.procVersion,
  };
  return {
    androidId: device.androidId,
    platformId: 1,
    appKey: QIMEI_APP_KEY,
    appVersion: '14.9.0.8',
    beaconIdSrc: randomBeaconId(now),
    brand: device.brand,
    channelId: CHANNEL_ID,
    cid: '',
    imei: device.imei,
    imsi: '',
    mac: '',
    model: device.model,
    networkType: 'unknown',
    oaid: '',
    osVersion: `Android ${device.osRelease},level ${device.sdk}`,
    qimei: '',
    qimei36: '',
    sdkVersion: '1.2.13.6',
    targetSdkVersion: '33',
    audit: '',
    userId: '{}',
    packageId: PACKAGE_ID,
    deviceType: 'Phone',
    sdkName: '',
    reserved: JSON.stringify(reserved),
  };
}

function buildQimeiRequest(device, now = new Date()) {
  const cryptKey = randomHex(16);
  const nonce = randomHex(16);
  const timestamp = Math.floor(now.getTime() / 1000);
  const encryptedKey = crypto.publicEncrypt(
    { key: QIMEI_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cryptKey),
  );
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(cryptKey), Buffer.from(cryptKey));
  const encryptedPayload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(buildQimeiPayload(device, now)))),
    cipher.final(),
  ]);
  const key = encryptedKey.toString('base64');
  const params = encryptedPayload.toString('base64');
  const extra = `{"appKey":"${QIMEI_APP_KEY}"}`;
  return {
    headers: {
      Host: 'api.tencentmusic.com',
      method: 'GetQimei',
      service: 'trpc.tme_datasvr.qimeiproxy.QimeiProxy',
      appid: 'qimei_qq_android',
      sign: md5('qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH', String(timestamp)),
      'user-agent': 'QQMusic',
      timestamp: String(timestamp),
    },
    body: {
      app: 0,
      os: 1,
      qimeiParams: {
        key,
        params,
        time: String(timestamp),
        nonce,
        sign: md5(key, params, String(timestamp * 1000), nonce, QIMEI_SECRET, extra),
        extra,
      },
    },
  };
}

function createHttpClient() {
  return axios.create({ timeout: 25000 });
}

async function ensureQimei(client, device, trace) {
  const isFresh =
    device.qimei &&
    device.qimei36 &&
    device.qimeiSavedAt &&
    Date.now() - device.qimeiSavedAt < 24 * 60 * 60 * 1000;
  if (isFresh) {
    trace.calls.push({ phase: 'qimei', source: 'cache', q16Length: device.qimei.length, q36Length: device.qimei36.length });
    return;
  }
  const request = buildQimeiRequest(device);
  const response = await client.post(QIMEI_URL, request.body, { headers: request.headers });
  const outer = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  const inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
  const data = inner && inner.data;
  if (!data || !data.q16 || !data.q36) throw new Error('QIMEI response missing q16/q36');
  device.qimei = String(data.q16);
  device.qimei36 = String(data.q36);
  device.qimeiSavedAt = Date.now();
  trace.calls.push({ phase: 'qimei', httpStatus: response.status, q16Length: device.qimei.length, q36Length: device.qimei36.length });
}

function buildAndroidComm(device, credential = null, overrides = {}) {
  const comm = {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: CHANNEL_ID,
    tmeAppID: 'qqmusic',
    QIMEI: device.qimei || '',
    QIMEI36: device.qimei36 || '',
    OpenUDID: device.openUdid,
    udid: device.openUdid,
    OpenUDID2: device.openUdid,
    aid: device.androidId,
    os_ver: device.osRelease,
    phonetype: device.model,
    devicelevel: String(device.sdk),
    newdevicelevel: String(device.sdk),
    rom: device.fingerprint,
  };
  if (device.sessionUid) comm.uid = device.sessionUid;
  if (device.sessionSid) comm.sid = device.sessionSid;
  if (credential && credential.musicid) comm.qq = String(credential.musicid);
  if (credential && credential.musickey) comm.authst = credential.musickey;
  if (credential && credential.loginType) comm.tmeLoginType = credential.loginType;
  return Object.assign(comm, overrides);
}

function sanitizeProtocolMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b\d{5,}\b/g, '[NUMBER]')
    .replace(/([?&](?:token|key|code)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 300);
}

function apiResultSummary(phase, response, module, method) {
  const body = response.data || {};
  const item = body.req_0 || {};
  const data = item.data || {};
  const messages = ['errMsg', 'errtip', 'errTip2', 'tip3']
    .map((key) => sanitizeProtocolMessage(data && data[key]))
    .filter(Boolean);
  return {
    phase,
    endpoint: MUSICU_URL,
    module,
    method,
    httpStatus: response.status,
    globalCode: body.code ?? 0,
    code: item.code ?? null,
    dataKeys: data && typeof data === 'object' ? Object.keys(data).sort() : [],
    ...(messages.length ? { messages } : {}),
  };
}

async function callMusicu(client, device, { phase, module, method, param, credential, commOverrides, trace }) {
  const payload = {
    comm: buildAndroidComm(device, credential, commOverrides),
    req_0: { module, method, param },
  };
  const response = await client.post(MUSICU_URL, payload, {
    headers: { 'User-Agent': `QQMusic 14090008(android ${device.osRelease})` },
  });
  const summary = apiResultSummary(phase, response, module, method);
  trace.calls.push(summary);
  const item = response.data && response.data.req_0;
  if (!item || (response.data.code ?? 0) !== 0 || (item.code ?? 0) !== 0) {
    const error = new Error(`${phase} failed (HTTP ${response.status}, global=${summary.globalCode}, code=${summary.code})`);
    error.protocol = summary;
    throw error;
  }
  return item.data || {};
}

async function refreshAndroidSession(client, device, trace) {
  const data = await callMusicu(client, device, {
    phase: 'get-session',
    module: 'music.getSession.session',
    method: 'GetSession',
    param: { uid: device.sessionUid || '', vkey: 0, caller: 0 },
    trace,
  });
  if (!data.session || !data.session.uid || !data.session.sid) throw new Error('GetSession response missing uid/sid');
  device.sessionUid = String(data.session.uid);
  device.sessionSid = String(data.session.sid);
  device.sessionVkey = data.session.vkey ?? null;
  device.sessionSavedAt = Date.now();
}

async function createNativeQr(client, device, trace) {
  const data = await callMusicu(client, device, {
    phase: 'create-qr',
    module: 'music.login.LoginServer',
    method: 'CreateQRCode',
    param: { tmeAppID: 'qqmusic', ct: 11, cv: 14090008 },
    commOverrides: { ct: 23, cv: 0 },
    trace,
  });
  const qrcodeId = String(data.qrcodeID || '');
  const encoded = String(data.qrcode || '').split(',').at(-1) || '';
  const image = Buffer.from(encoded, 'base64');
  if (!qrcodeId || image.length < 8 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('CreateQRCode response missing a valid PNG/qrcodeID');
  }
  trace.qr = { idHash: fingerprint(qrcodeId), imageBytes: image.length, mimetype: 'image/png' };
  return { qrcodeId, image };
}

async function exchangeCredentials(client, device, qrcodeId, musicid, token, trace) {
  const startedAt = Date.now();
  try {
    const credential = await callMusicu(client, device, {
      phase: 'credential-exchange',
      module: 'music.login.LoginServer',
      method: 'Login',
      param: { musicid: Number(musicid), qrCodeID: qrcodeId, token },
      commOverrides: { tmeLoginType: 6 },
      trace,
    });
    trace.exchange = { durationMs: Date.now() - startedAt, credentialKeys: Object.keys(credential).sort() };
    return credential;
  } catch (error) {
    trace.exchange = { durationMs: Date.now() - startedAt, error: error.message, protocol: error.protocol || null };
    throw error;
  }
}

async function verifyCredentialAndPlaylists(client, device, credential, trace, phaseSuffix = '') {
  const user = await callMusicu(client, device, {
    phase: `verify-user${phaseSuffix}`,
    module: 'music.UserInfo.userInfoServer',
    method: 'GetLoginUserInfo',
    param: {},
    credential,
    trace,
  });
  const playlistData = await callMusicu(client, device, {
    phase: `verify-playlists${phaseSuffix}`,
    module: 'music.musicasset.PlaylistBaseRead',
    method: 'GetPlaylistByUin',
    param: { uin: String(credential.musicid) },
    credential,
    trace,
  });
  const playlists = Array.isArray(playlistData.v_playlist) ? playlistData.v_playlist : [];
  trace.verification = {
    musicidHash: fingerprint(credential.musicid),
    userKeys: Object.keys(user).sort(),
    playlistCount: playlists.length,
    playlistIdHashes: playlists.slice(0, 3).map((item) => fingerprint(item.tid || item.dirId || item.dissid)),
  };
  return { user, playlists };
}

function pickDisplayName(user) {
  const candidates = [user.nickname, user.nick, user.name, user.userName];
  return candidates.find((value) => typeof value === 'string' && value.trim()) || '(上游未返回昵称)';
}

function pickPlaylistName(item) {
  const candidates = [item.dirName, item.dissname, item.title, item.name];
  return candidates.find((value) => typeof value === 'string' && value.trim()) || '(未命名歌单)';
}

module.exports = {
  PROTOCOL_SOURCE,
  buildAndroidComm,
  buildQimeiRequest,
  callMusicu,
  createHttpClient,
  createNativeQr,
  ensureQimei,
  exchangeCredentials,
  fingerprint,
  loadOrCreateDevice,
  pickDisplayName,
  pickPlaylistName,
  refreshAndroidSession,
  savePrivateJson,
  verifyCredentialAndPlaylists,
};
