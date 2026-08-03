import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import createAuthHttpClient, { type AuthHttpClient } from '../src/services/auth/httpClient';
import {
  createQrLoginService,
  type QrLoginService,
  QrLoginServiceError,
} from '../src/services/auth/qrLogin';

interface TestQrEvent {
  type: string;
  payload: unknown;
}

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

const createProtocolHarness = (options: { failCredential?: boolean } = {}) => {
  const calls: string[] = [];
  const post = jest.fn(async <T>(_url: string, payload?: unknown): Promise<AxiosResponse<T>> => {
    if (!dictionaryOf(payload).req_0) {
      return response({ data: JSON.stringify({ data: { q16: 'q16', q36: 'q36' } }) } as T);
    }
    const method = methodOf(payload);
    calls.push(method);
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

  it('should clear auth and close QR listeners on logout', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    harness.service.logout(token);

    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
    expect(harness.wasClosed()).toBe(true);
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
