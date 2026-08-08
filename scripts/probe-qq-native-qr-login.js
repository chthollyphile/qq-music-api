const path = require('node:path');

const {
  PROTOCOL_SOURCE,
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
} = require('./qq-native-qr-probe-core');
const { listenForQrEvents } = require('./qq-native-qr-probe-mqtt');

// Interactive G1 harness. It writes secrets only below ignored test-results/.

const outputDirectory = path.resolve(process.cwd(), 'test-results', 'qq-native-login');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const devicePath = path.join(outputDirectory, 'device.local.json');
const qrPath = path.join(outputDirectory, `qq-music-login-${runId}.png`);
const credentialPath = path.join(outputDirectory, 'credential.local.json');
const tracePath = path.join(outputDirectory, `trace-${runId}.sanitized.json`);
const timeoutMs = Number(process.env.QQ_QR_TIMEOUT_MS || 180000);

function logPhase(message) {
  process.stdout.write(`[QQ-QR] ${new Date().toISOString()} ${message}\n`);
}

function recordEvent(trace, type, payload) {
  const event = {
    type: type || 'unknown',
    at: new Date().toISOString(),
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
  };
  if (payload && typeof payload.commConf === 'object' && payload.commConf) {
    event.commConfKeys = Object.keys(payload.commConf).sort();
    event.commConf = Object.fromEntries(
      Object.entries(payload.commConf).filter(
        ([key, value]) =>
          /^(ct|cv|v|chid|platform|tmeAppID|tmeLoginType)$/i.test(key) &&
          (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
      ),
    );
  }
  if (payload && typeof payload.cookies === 'object' && payload.cookies) {
    event.cookieKeys = Object.keys(payload.cookies).sort();
    event.cookieValueLengths = Object.fromEntries(
      Object.entries(payload.cookies).map(([key, cookie]) => [
        key,
        cookie && typeof cookie.value === 'string' ? cookie.value.length : null,
      ]),
    );
  }
  trace.mqtt.events.push(event);
  return event;
}

async function main() {
  const trace = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    protocolSource: PROTOCOL_SOURCE,
    device: {},
    calls: [],
    mqtt: { events: [] },
    result: 'running',
  };
  const device = loadOrCreateDevice(devicePath);
  const client = createHttpClient();
  try {
    trace.device = {
      androidIdHash: fingerprint(device.androidId),
      openUdidHash: fingerprint(device.openUdid),
      reused: Boolean(device.qimei || device.sessionUid),
    };

    logPhase('取得并固定 Android 装置上下文（QIMEI）…');
    await ensureQimei(client, device, trace);
    savePrivateJson(devicePath, device);

    logPhase('在同一装置上下文建立 GetSession…');
    await refreshAndroidSession(client, device, trace);
    savePrivateJson(devicePath, device);
    trace.device.sessionUidHash = fingerprint(device.sessionUid);

    logPhase('向 QQ 音乐建立原生登录 QR…');
    const { qrcodeId, image } = await createNativeQr(client, device, trace);
    require('node:fs').writeFileSync(qrPath, image, { mode: 0o600 });
    logPhase(`QR_READY ${qrPath}`);
    logPhase(`QR_ID_HASH ${fingerprint(qrcodeId)}`);

    let scannedAt = null;
    const terminal = await listenForQrEvents(qrcodeId, {
      timeoutMs,
      onEvent(event) {
        recordEvent(trace, event.type, event.payload);
        if (event.type === 'waiting') logPhase('STATUS waiting（MQTT 已订阅，可扫码）');
        else if (event.type === 'scanned') {
          scannedAt = Date.now();
          logPhase('STATUS scanned（手机已扫码，等待凭据事件）');
        } else if (event.type === 'cookies') logPhase('STATUS credential-received（立即交换，不输出 token）');
        else logPhase(`STATUS ${event.type || 'unknown'}`);
      },
    });

    if (terminal.type !== 'cookies') throw new Error(`QR login ended with MQTT event: ${terminal.type}`);
    const cookies = terminal.payload && terminal.payload.cookies;
    const musicid = cookies && cookies.qqmusic_uin && cookies.qqmusic_uin.value;
    const token = cookies && cookies.qqmusic_key && cookies.qqmusic_key.value;
    if (!musicid || !token) throw new Error('MQTT cookies event missing qqmusic_uin/qqmusic_key');
    trace.exchangeDelayFromScannedMs = scannedAt ? Date.now() - scannedAt : null;

    let credential;
    let verification;
    try {
      credential = await exchangeCredentials(client, device, qrcodeId, musicid, token, trace);
      trace.credentialSource = 'login-exchange';
    } catch (exchangeError) {
      logPhase(`EXCHANGE_REJECTED ${exchangeError.message}`);
      logPhase('尝试把 MQTT qqmusic_key 当作既有登录凭据验证（不重出码）…');
      const directCredential = {
        musicid: Number(musicid),
        str_musicid: String(musicid),
        musickey: String(token),
        loginType: 6,
      };
      try {
        verification = await verifyCredentialAndPlaylists(
          client,
          device,
          directCredential,
          trace,
          '-mqtt-cookie',
        );
        credential = directCredential;
        trace.credentialSource = 'mqtt-cookie';
        trace.exchangeFallback = { result: 'passed' };
      } catch (fallbackError) {
        trace.exchangeFallback = {
          result: 'failed',
          message: fallbackError.message,
          protocol: fallbackError.protocol || null,
        };
        const combined = new Error(
          `exchange rejected and MQTT cookie validation failed: ${exchangeError.message}; ${fallbackError.message}`,
        );
        combined.protocol = fallbackError.protocol || exchangeError.protocol || null;
        throw combined;
      }
    }
    if (!verification) verification = await verifyCredentialAndPlaylists(client, device, credential, trace);
    savePrivateJson(credentialPath, credential);
    logPhase(`LOGIN_OK source=${trace.credentialSource} MUSIC_ID_HASH=${fingerprint(credential.musicid)}`);

    logPhase(`ACCOUNT_OK ${pickDisplayName(verification.user)}`);
    logPhase(`PLAYLISTS_OK count=${verification.playlists.length}`);
    for (const playlist of verification.playlists.slice(0, 3)) {
      logPhase(`PLAYLIST ${pickPlaylistName(playlist)}`);
    }
    trace.result = 'passed';
  } catch (error) {
    trace.result = 'failed';
    trace.failure = {
      name: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
      protocol: error && error.protocol ? error.protocol : null,
    };
    logPhase(`FAILED ${trace.failure.message}`);
    process.exitCode = 1;
  } finally {
    trace.finishedAt = new Date().toISOString();
    savePrivateJson(tracePath, trace);
    logPhase(`SANITIZED_TRACE ${tracePath}`);
  }
}

main();
