import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  createMemoryDeviceContextRepository,
  type DeviceContextRepository,
} from '../src/services/auth/deviceContext';
import createAuthHttpClient, { type AuthHttpClient } from '../src/services/auth/httpClient';
import {
  createQrLoginService,
  type QrLoginService,
  QrLoginServiceError,
} from '../src/services/auth/qrLogin';
import { logger } from '../src/util/logger';

interface TestQrEvent {
  type: string;
  payload: unknown;
}

const QIMEI_16 = 'q'.repeat(36);
const QIMEI_36 = 'r'.repeat(36);

const response = <T>(
  data: T,
  status = 200,
  headers: Record<string, unknown> = {},
): AxiosResponse<T> => ({
  data,
  status,
  statusText: 'OK',
  headers: headers as AxiosResponse<T>['headers'],
  config: { headers: {} } as AxiosResponse<T>['config'],
});

const dictionaryOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const methodOf = (payload: unknown): string =>
  String(dictionaryOf(dictionaryOf(payload).req_0).method ?? '');

interface HarnessOptions {
  failCredential?: boolean;
  deviceRepository?: DeviceContextRepository;
  qimei?: () => AxiosResponse<unknown>;
}

const createProtocolHarness = (options: HarnessOptions = {}) => {
  const deviceRepository = options.deviceRepository ?? createMemoryDeviceContextRepository();
  const calls: string[] = [];
  const comms: Record<string, unknown>[] = [];
  const post = jest.fn(async <T>(_url: string, payload?: unknown): Promise<AxiosResponse<T>> => {
    if (!dictionaryOf(payload).req_0) {
      calls.push('GetQimei');
      if (options.qimei) return options.qimei() as AxiosResponse<T>;
      return response({
        data: JSON.stringify({ code: 0, data: { q16: QIMEI_16, q36: QIMEI_36 } }),
      } as T);
    }
    const method = methodOf(payload);
    calls.push(method);
    comms.push(dictionaryOf(dictionaryOf(payload).comm));
    if (method === 'GetSession') {
      return response({
        code: 0,
        req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
      } as T);
    }
    if (method === 'CreateQRCode') {
      const png = Buffer.from('89504e470d0a1a0a01020304', 'hex').toString('base64');
      return response({
        code: 0,
        req_0: { code: 0, data: { qrcodeID: 'qr-id', qrcode: png, expiresIn: 180 } },
      } as T);
    }
    if (method === 'Login' && options.failCredential) {
      return response({ code: 0, req_0: { code: 50006, data: {} } } as T);
    }
    if (method === 'Login') {
      return response({
        code: 0,
        req_0: { code: 0, data: { musicid: 123, musickey: 'credential-key', loginType: 6 } },
      } as T);
    }
    if (method === 'GetLoginUserInfo' && options.failCredential) {
      return response({ code: 0, req_0: { code: 50006, data: {} } } as T);
    }
    if (method === 'GetLoginUserInfo') {
      return response({
        code: 0,
        req_0: {
          code: 0,
          data: { musicid: 123, nickname: '我的 QQ 帳號', musickey: 'must-not-leak' },
        },
      } as T);
    }
    if (method === 'GetPlaylistByUin') {
      return response({
        code: 0,
        req_0: {
          code: 0,
          data: { v_playlist: [{ tid: 7, dirName: '我喜欢' }], total: 1, bFinish: true },
        },
      } as T);
    }
    if (method === 'CgiGetVkey') {
      const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
      const songmid = Array.isArray(param.songmid) ? String(param.songmid[0] ?? '') : '';
      return response({
        code: 0,
        req_0: {
          code: 0,
          data: {
            sip: ['https://audio.example.test/'],
            midurlinfo: [{ songmid, purl: 'fixture.flac' }],
          },
        },
      } as T);
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const http: AuthHttpClient = {
    getCookieHeader: () => '',
    request: jest.fn(),
    post: post as unknown as AuthHttpClient['post'],
  };
  let emit: ((event: TestQrEvent) => void) | undefined;
  let closed = false;
  const service = createQrLoginService({
    http,
    deviceRepository,
    randomBytes: (size) => Buffer.alloc(size, 7),
    listen: (_qrcodeId, onEvent) => {
      emit = onEvent;
      onEvent({ type: 'waiting', payload: null });
      return {
        ready: Promise.resolve(),
        done: new Promise<void>(() => undefined),
        close: () => {
          closed = true;
        },
      };
    },
  });
  return {
    calls,
    comms,
    httpPost: post,
    deviceRepository,
    service,
    emit: (event: TestQrEvent) => {
      if (!emit) throw new Error('listener not started');
      emit(event);
    },
    wasClosed: () => closed,
  };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
};

const login = async (service: QrLoginService, emit: (event: TestQrEvent) => void) => {
  const key = await service.createSession();
  const imageUrl = await service.createQr(key);
  emit({ type: 'scanned', payload: {} });
  emit({
    type: 'cookies',
    payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
  });
  await waitFor(() => service.checkQr(key).code === 803);
  return { key, imageUrl, result: service.checkQr(key) };
};

describe('QQ native QR login service', () => {
  it('should move through waiting, scanned, and confirmed states', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    const imageUrl = await harness.service.createQr(key);

    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(harness.service.checkQr(key)).toMatchObject({ code: 801 });
    harness.emit({ type: 'scanned', payload: {} });
    expect(harness.service.checkQr(key)).toMatchObject({ code: 802 });
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(() => harness.service.checkQr(key).code === 803);

    const confirmed = harness.service.checkQr(key);
    expect(confirmed).toMatchObject({
      code: 803,
      cookie: expect.stringMatching(/^qqmusic_session=/),
    });
    expect(confirmed.cookie).not.toContain('credential-key');
    expect(confirmed.cookie).not.toContain('mqtt-key');
  });

  it('should reject a parallel active QR session', async () => {
    const harness = createProtocolHarness();
    await harness.service.createSession();

    await expect(harness.service.createSession()).rejects.toEqual(
      expect.objectContaining({ httpStatus: 409 }),
    );
  });

  it('should preserve upstream 50006 and apply a retry backoff', async () => {
    const harness = createProtocolHarness({ failCredential: true });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(() => harness.service.checkQr(key).code === 800);

    expect(harness.service.checkQr(key)).toEqual(
      expect.objectContaining({
        code: 800,
        upstreamCode: 50006,
        retryAfterMs: 30000,
      }),
    );
    const retryError = await harness.service.createSession().catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(QrLoginServiceError);
    expect(retryError).toEqual(expect.objectContaining({ httpStatus: 429 }));
    expect((retryError as QrLoginServiceError).retryAfterMs).toBeGreaterThan(29000);
  });

  it('should expose authenticated user and playlist without exposing credentials', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({
      nickname: '我的 QQ 帳號',
    });
    await expect(harness.service.getLoginStatus(token)).resolves.not.toHaveProperty('musickey');
    await expect(harness.service.getUserDetail(token)).resolves.toMatchObject({ musicid: 123 });
    await expect(harness.service.getUserPlaylists(token)).resolves.toMatchObject({
      v_playlist: [{ tid: 7, dirName: '我喜欢' }],
    });
    expect(harness.calls).toContain('GetLoginUserInfo');
    expect(harness.calls).toContain('GetPlaylistByUin');
  });

  it('should resolve music URLs through the authenticated auth HTTP client', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(
      harness.service.getMusicPlay(token, 'song-mid', 'flac', 'media-mid'),
    ).resolves.toEqual({
      'song-mid': { url: 'https://audio.example.test/fixture.flac', error: false },
    });
    await expect(harness.service.getMusicPlay('unknown', 'song-mid', 'flac')).resolves.toBeNull();
    expect(harness.calls).toContain('CgiGetVkey');
    expect(harness.comms.at(-1)).toMatchObject({
      qq: '123',
      authst: 'credential-key',
      tmeLoginType: 6,
    });
    const vkeyPayload = dictionaryOf(
      dictionaryOf(dictionaryOf(jest.mocked(harness.httpPost).mock.calls.at(-1)?.[1])).req_0,
    );
    expect(dictionaryOf(vkeyPayload.param).filename).toEqual(['F000song-midmedia-mid.flac']);
  });

  it('should clear auth and close QR listeners on logout', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    harness.service.logout(token);

    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
    expect(harness.wasClosed()).toBe(true);
  });

  it('should reuse the stored device context after a service restart', async () => {
    const deviceRepository = createMemoryDeviceContextRepository();
    const first = createProtocolHarness({ deviceRepository });
    await first.service.createSession();
    const stored = deviceRepository.load();

    const restarted = createProtocolHarness({ deviceRepository });
    await restarted.service.createSession();

    expect(first.calls).toContain('GetQimei');
    expect(restarted.calls).not.toContain('GetQimei');
    expect(restarted.calls).toContain('GetSession');
    expect(stored).toMatchObject({ qimei: QIMEI_16, qimei36: QIMEI_36, sessionSid: 'session-sid' });
    expect(restarted.comms[0]).toMatchObject({
      QIMEI: QIMEI_16,
      QIMEI36: QIMEI_36,
      aid: stored?.androidId,
      OpenUDID: stored?.openUdid,
      uid: '1234567890',
    });
  });

  it('should persist a valid q16/q36 bootstrap without storing login credentials', async () => {
    const harness = createProtocolHarness();
    await login(harness.service, harness.emit);

    const stored = harness.deviceRepository.load();

    expect(stored?.qimei).toHaveLength(36);
    expect(stored?.qimei36).toHaveLength(36);
    expect(stored?.qimeiSavedAt).toEqual(expect.any(Number));
    const serialized = JSON.stringify(stored);
    for (const secret of ['credential-key', 'mqtt-key', 'must-not-leak'])
      expect(serialized).not.toContain(secret);
  });

  it('should back off on a non-zero QIMEI code instead of repeating upstream calls', async () => {
    const harness = createProtocolHarness({
      qimei: () => response({ code: -30002, data: undefined }),
    });

    const failure = await harness.service.createSession().catch((error: unknown) => error);
    const repeated = await harness.service.createSession().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QrLoginServiceError);
    expect(failure).toEqual(
      expect.objectContaining({ httpStatus: 502, retryAfterMs: 30000, upstreamCode: -30002 }),
    );
    expect(repeated).toEqual(expect.objectContaining({ httpStatus: 429 }));
    expect(harness.calls).toEqual(['GetQimei']);
    expect(harness.deviceRepository.load()?.qimei).toBeUndefined();
  });

  it('should keep QIMEI, credentials, and device identifiers out of the logs', async () => {
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => undefined),
    );
    try {
      const harness = createProtocolHarness();
      const { result } = await login(harness.service, harness.emit);
      const device = harness.deviceRepository.load();
      const failing = createProtocolHarness({
        qimei: () => response({ code: -30002, data: undefined }),
      });
      await failing.service.createSession().catch(() => undefined);

      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      for (const secret of [
        QIMEI_16,
        QIMEI_36,
        'credential-key',
        'mqtt-key',
        'must-not-leak',
        'qr-id',
        String(result.cookie),
        String(device?.androidId),
        String(device?.imei),
        String(device?.openUdid),
      ])
        expect(logged).not.toContain(secret);
      expect(logged).toContain('-30002');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('should translate timeout and unknown keys to expired code 800', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'timeout', payload: null });

    expect(harness.service.checkQr(key)).toMatchObject({ code: 800, message: 'QR code expired' });
    expect(harness.service.checkQr('missing')).toEqual({ code: 800, message: 'QR code expired' });
  });
});

describe('QQ auth HTTP client', () => {
  it('should carry Set-Cookie values across a manual redirect', async () => {
    const requests: AxiosRequestConfig[] = [];
    const transport = {
      request: jest.fn(async (config: AxiosRequestConfig) => {
        requests.push(config);
        if (requests.length === 1)
          return response({}, 302, { location: '/next', 'set-cookie': ['sid=secret; Path=/'] });
        return response({ ok: true });
      }),
    } as unknown as AxiosInstance;
    const client = createAuthHttpClient(transport);

    const result = await client.post<{ ok: boolean }>('https://example.test/start', {
      hello: 'world',
    });

    expect(result.data).toEqual({ ok: true });
    expect(requests[1].url).toBe('https://example.test/next');
    expect(requests[1].method).toBe('GET');
    expect(requests[1].headers).toEqual(expect.objectContaining({ Cookie: 'sid=secret' }));
    expect(client.getCookieHeader()).toBe('sid=secret');
  });
});
