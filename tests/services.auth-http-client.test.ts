import http from 'node:http';
import createAuthHttpClient from '../src/services/auth/httpClient';

// Runs the real axios stack over loopback. `src/util/request.ts` mutates the global axios
// defaults for the legacy services, and `axios.create()` snapshots them, so an auth client
// built after that import used to ship the QIMEI JSON body as form-urlencoded. Jest gives this
// file its own module registry, so the deliberate contamination stays contained here.

interface ReceivedRequest {
  contentType?: string;
  body: string;
}

const startEchoServer = async (): Promise<{
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}> => {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('echo server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/qimei`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('QQ auth HTTP client global default isolation', () => {
  it('should keep posting JSON after the legacy services rewrite the axios defaults', async () => {
    const echo = await startEchoServer();
    try {
      const beforeLegacyImport = createAuthHttpClient();
      await beforeLegacyImport.post(echo.url, { app: 0, os: 1 });

      // Importing any legacy service pulls this in, exactly like src/app.ts does at boot.
      await import('../src/util/request');

      const afterLegacyImport = createAuthHttpClient();
      await afterLegacyImport.post(echo.url, { app: 0, os: 1 });
      await beforeLegacyImport.post(echo.url, { app: 0, os: 1 });

      expect(echo.received).toHaveLength(3);
      for (const request of echo.received) {
        expect(request.contentType).toBe('application/json');
        expect(JSON.parse(request.body)).toEqual({ app: 0, os: 1 });
      }
    } finally {
      await echo.close();
    }
  });

  it('should not attach a JSON content type to a body-less request', async () => {
    const echo = await startEchoServer();
    try {
      await createAuthHttpClient().request({ url: echo.url, method: 'GET' });

      expect(echo.received[0].contentType).toBeUndefined();
    } finally {
      await echo.close();
    }
  });
});
