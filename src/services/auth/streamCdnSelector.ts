import type { AuthHttpClient } from './httpClient';

// Selects a stream base from QQ's dispatch response without exposing signed song URLs in logs.

const PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MS = 30 * 60 * 1_000;
const MIN_CACHE_MS = 60 * 1_000;
const MAX_CACHE_MS = 24 * 60 * 60 * 1_000;

export interface StreamProbeResult {
  bytes: number;
  elapsedMs: number;
}

export type StreamUrlProbe = (url: string) => Promise<StreamProbeResult | null>;

const byteLengthOf = (value: unknown): number => {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
};

export const createStreamUrlProbe =
  (http: AuthHttpClient): StreamUrlProbe =>
  async (url) => {
    const startedAt = Date.now();
    try {
      const response = await http.request<ArrayBuffer>({
        url,
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          Range: `bytes=0-${PROBE_BYTES - 1}`,
        },
        responseType: 'arraybuffer',
        maxContentLength: PROBE_BYTES,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.status !== 206) return null;
      const bytes = byteLengthOf(response.data);
      return bytes > 0 ? { bytes, elapsedMs: Math.max(1, Date.now() - startedAt) } : null;
    } catch {
      return null;
    }
  };

const normalizeBase = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (!host.endsWith('.qqmusic.qq.com') && !host.endsWith('.tc.qq.com')) return null;
    url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

interface CachedSelection {
  base: string;
  expiresAt: number;
}

export class StreamCdnSelector {
  private cached: CachedSelection | null = null;
  private selecting: Promise<string | null> | null = null;

  public constructor(
    private readonly probe: StreamUrlProbe,
    private readonly now: () => number = Date.now,
  ) {}

  public async select(
    candidates: string[],
    purl: string,
    refreshAfterMs = DEFAULT_CACHE_MS,
  ): Promise<string | null> {
    const bases = [...new Set(candidates.map(normalizeBase).filter((value) => value !== null))];
    if (bases.length === 0 || !purl) return null;
    if (this.cached && this.cached.expiresAt > this.now() && bases.includes(this.cached.base))
      return this.cached.base;
    if (this.selecting) return this.selecting;

    this.selecting = this.measure(bases, purl, refreshAfterMs).finally(() => {
      this.selecting = null;
    });
    return this.selecting;
  }

  // Measures candidates concurrently so a throttled fallback cannot serially delay playback.
  private async measure(
    bases: string[],
    purl: string,
    refreshAfterMs: number,
  ): Promise<string | null> {
    const results = await Promise.all(
      bases.map(async (base) => ({
        base,
        result: await this.probe(new URL(purl, base).toString()),
      })),
    );
    const fastest = results
      .filter(
        (entry): entry is { base: string; result: StreamProbeResult } => entry.result !== null,
      )
      .sort(
        (left, right) =>
          right.result.bytes / right.result.elapsedMs - left.result.bytes / left.result.elapsedMs,
      )[0];
    if (!fastest) return null;

    const cacheMs = Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, refreshAfterMs));
    this.cached = { base: fastest.base, expiresAt: this.now() + cacheMs };
    return fastest.base;
  }
}
