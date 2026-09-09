import { StreamCdnSelector, type StreamUrlProbe } from '../src/services/auth/streamCdnSelector';

describe('StreamCdnSelector', () => {
  it('selects the fastest compatible dispatched CDN and ignores untrusted hosts', async () => {
    const probe = jest.fn<ReturnType<StreamUrlProbe>, Parameters<StreamUrlProbe>>(async (url) => {
      if (url.startsWith('https://fast.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 100 };
      if (url.startsWith('http://dl.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 1_000 };
      return null;
    });
    const selector = new StreamCdnSelector(probe);

    await expect(
      selector.select(
        [
          'https://attacker.example/',
          'http://dl.stream.qqmusic.qq.com/',
          'https://fast.stream.qqmusic.qq.com/',
        ],
        'F000fixture.flac?vkey=signed',
      ),
    ).resolves.toBe('https://fast.stream.qqmusic.qq.com/');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalledWith(expect.stringContaining('attacker.example'));
  });

  it('caches a selection until the dispatch refresh interval expires', async () => {
    let now = 1_000;
    const probe = jest.fn(async () => ({ bytes: 262_144, elapsedMs: 100 }));
    const selector = new StreamCdnSelector(probe, () => now);
    const candidates = ['https://fast.stream.qqmusic.qq.com/'];

    await selector.select(candidates, 'first.flac?vkey=one', 60_000);
    await selector.select(candidates, 'second.flac?vkey=two', 60_000);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 60_001;
    await selector.select(candidates, 'third.flac?vkey=three', 60_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns null when no dispatched CDN accepts the signed URL', async () => {
    const selector = new StreamCdnSelector(async () => null);

    await expect(
      selector.select(['https://ws.stream.qqmusic.qq.com/'], 'fixture.flac?vkey=signed'),
    ).resolves.toBeNull();
  });
});
