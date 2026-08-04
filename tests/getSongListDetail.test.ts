const mockSongListDetail = jest.fn();

jest.mock('../src/services', () => {
  const actual = jest.requireActual('../src/services');
  return {
    __esModule: true,
    default: {
      ...actual.default,
      songListDetail: mockSongListDetail,
    },
  };
});

import request from 'supertest';
import app from '../src/app';

const server = app.callback();

describe('GET /getSongListDetail', () => {
  beforeEach(() => {
    mockSongListDetail.mockReset();
    mockSongListDetail.mockResolvedValue({ status: 200, body: { response: { code: 0 } } });
  });

  it('reads disstid from the documented path parameter', async () => {
    await request(server).get('/getSongListDetail/9757480713').expect(200);

    expect(mockSongListDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { disstid: '9757480713' },
      }),
    );
  });

  it('keeps the legacy query parameter compatible', async () => {
    await request(server).get('/getSongListDetail?disstid=7').expect(200);

    expect(mockSongListDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { disstid: '7' },
      }),
    );
  });
});
