const {
  buildAndroidComm,
  buildQimeiRequest,
} = require('../scripts/qq-native-qr-probe-core');
const {
  buildConnectPacket,
  decodeVariableByteInteger,
  encodeProperties,
  encodeUtf8,
  encodeVariableByteInteger,
  parsePublishPacket,
  requireWebSocketRuntime,
  splitPackets,
  wrapPacket,
} = require('../scripts/qq-native-qr-probe-mqtt');

// Locks down the deterministic seams around the human-in-the-loop M1 probe.

describe('QQ native QR protocol probe', () => {
  test.each([0, 127, 128, 16383, 16384, 268435455])('round-trips MQTT variable integer %i', (value) => {
    const encoded = encodeVariableByteInteger(value);
    expect(decodeVariableByteInteger(encoded)).toEqual({ value, bytes: encoded.length });
  });

  test('parses a publish event without exposing transport framing', () => {
    const properties = encodeProperties({ userProperties: [['type', 'scanned']] });
    const packet = wrapPacket(
      0x30,
      Buffer.concat([
        encodeUtf8('management.qrcode_login/example'),
        properties,
        Buffer.from(JSON.stringify({ status: 'ok' })),
      ]),
    );
    expect(parsePublishPacket(packet)).toEqual({
      topic: 'management.qrcode_login/example',
      type: 'scanned',
      payload: { status: 'ok' },
    });
    expect(splitPackets(Buffer.concat([packet, packet])).packets).toHaveLength(2);
  });

  test('connect packet carries the native QQ Music login context', () => {
    const packet = buildConnectPacket('1234567890123', 'qr-id');
    expect(packet[0]).toBe(0x10);
    expect(packet.includes(Buffer.from('qqmusic'))).toBe(true);
    expect(packet.includes(Buffer.from('management.user'))).toBe(true);
    expect(packet.includes(Buffer.from('qr-id'))).toBe(true);
  });

  test('keeps GetSession and login exchange on one Android identity', () => {
    const device = {
      qimei: 'q16',
      qimei36: 'q36',
      openUdid: 'open-udid',
      androidId: 'android-id',
      osRelease: '10',
      model: 'MI 6',
      sdk: 29,
      fingerprint: 'rom-fingerprint',
      sessionUid: 'session-uid',
      sessionSid: 'session-sid',
    };
    const comm = buildAndroidComm(device, null, { tmeLoginType: 6 });
    expect(comm).toMatchObject({
      QIMEI: 'q16',
      QIMEI36: 'q36',
      OpenUDID: 'open-udid',
      uid: 'session-uid',
      sid: 'session-sid',
      tmeLoginType: 6,
    });
  });

  test('builds an encrypted QIMEI request without embedding device plaintext', () => {
    const device = {
      androidId: '0011223344556677',
      brand: 'Xiaomi',
      device: 'sagit',
      model: 'MI 6',
      procVersion: 'Linux test',
      imei: '123456789012347',
      osRelease: '10',
      sdk: 29,
    };
    const request = buildQimeiRequest(device, new Date('2026-08-03T00:00:00.000Z'));
    expect(request.headers).toMatchObject({
      method: 'GetQimei',
      service: 'trpc.tme_datasvr.qimeiproxy.QimeiProxy',
      appid: 'qimei_qq_android',
    });
    expect(request.body.qimeiParams.key).not.toContain(device.androidId);
    expect(request.body.qimeiParams.params).not.toContain(device.androidId);
  });

  test('does not place login secrets in the Android comm without a credential', () => {
    const comm = buildAndroidComm({
      qimei: 'q16',
      qimei36: 'q36',
      openUdid: 'open-udid',
      androidId: 'android-id',
      osRelease: '10',
      model: 'MI 6',
      sdk: 29,
      fingerprint: 'rom-fingerprint',
    });
    expect(comm).not.toHaveProperty('authst');
    expect(comm).not.toHaveProperty('qq');
  });

  test('fails clearly when the probe runs without a global WebSocket implementation', () => {
    expect(() => requireWebSocketRuntime(null)).toThrow('requires Node.js 22+');
    class TestWebSocket {}
    expect(requireWebSocketRuntime(TestWebSocket)).toBe(TestWebSocket);
  });
});
