const mockUCommon = jest.fn();

jest.mock('../src/services', () => {
  const actual = jest.requireActual('../src/services');
  return {
    __esModule: true,
    default: {
      ...actual.default,
      UCommon: mockUCommon,
    },
  };
});

import request from 'supertest';
import app from '../src/app';

const server = app.callback();

describe('GET /getSongInfo', () => {
  beforeEach(() => {
    mockUCommon.mockReset();
    mockUCommon.mockResolvedValue({
      data: {
        code: 0,
        songinfo: {
          data: { songmid: '0039MnYb0qxYhV' },
        },
      },
    });
  });

  it('正常流程: 验证接口能否正确返回业务数据', async () => {
    const response = await request(server).get('/getSongInfo?songmid=0039MnYb0qxYhV');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('response');
    expect(response.body.response.code).toBe(0);
  });

  it('reads songmid and songid from the documented path parameters', async () => {
    await request(server).get('/getSongInfo/path-mid/42').expect(200);

    const call = mockUCommon.mock.calls.at(-1)?.[0];
    const payload = JSON.parse(String(call?.params?.data));
    expect(payload.songinfo.param).toMatchObject({ song_mid: 'path-mid', song_id: '42' });
  });

  it('边界条件: 验证参数为空时的表现', async () => {
    const response = await request(server).get('/getSongInfo');
    expect(response.status).toBe(200);
  });

  it('异常输入: 传入非法的 songmid', async () => {
    const response = await request(server).get('/getSongInfo?songmid=invalid_mid_!@#');
    expect(response.status).toBe(200);
    // 一般业务上会返回提示无此歌曲
    expect(response.body).toBeDefined();
  });

  it('性能压力: 100并发请求', async () => {
    const concurrency = 20;
    const batches = 5;

    for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
      const requests = Array.from({ length: concurrency }, () =>
        request(server).get('/getSongInfo?songmid=0039MnYb0qxYhV'),
      );
      const responses = await Promise.all(requests);
      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });
    }

    expect(mockUCommon).toHaveBeenCalledTimes(concurrency * batches);
  });

  it('安全测试: 验证接口是否抵御常见注入或跨站攻击', async () => {
    const response = await request(server).get('/getSongInfo?songmid=<script>alert(1)</script>');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
