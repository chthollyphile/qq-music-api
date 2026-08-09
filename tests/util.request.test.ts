import http from 'node:http';

interface ReceivedRequest {
  contentType?: string;
}

const startEchoServer = async (): Promise<{
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}> => {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push({ contentType: request.headers['content-type'] });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('echo server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/legacy-request`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('legacy request axios isolation', () => {
  it('should preserve host defaults while keeping the legacy request contract', async () => {
    const echo = await startEchoServer();
    try {
      // Run the imports in one isolated module registry so both the simulated host and the
      // request module observe the exact same axios singleton. This test would give a false
      // positive if axios were loaded from a second Jest module registry.
      await jest.isolateModulesAsync(async () => {
        const { default: sharedAxios } = await import('axios');
        sharedAxios.defaults.withCredentials = false;
        sharedAxios.defaults.timeout = 4321;
        sharedAxios.defaults.responseType = 'text';
        sharedAxios.defaults.headers.post['Content-Type'] = 'application/host-test';

        const hostDefaults = {
          withCredentials: sharedAxios.defaults.withCredentials,
          timeout: sharedAxios.defaults.timeout,
          responseType: sharedAxios.defaults.responseType,
          postContentType: sharedAxios.defaults.headers.post['Content-Type'],
        };

        const { default: request } = await import('../src/util/request');
        const { requestConfig } = await import('../src/config');

        expect({
          withCredentials: sharedAxios.defaults.withCredentials,
          timeout: sharedAxios.defaults.timeout,
          responseType: sharedAxios.defaults.responseType,
          postContentType: sharedAxios.defaults.headers.post['Content-Type'],
        }).toEqual(hostDefaults);

        const response = await request<{ ok: boolean }>(
          echo.url,
          'POST',
          { data: { source: 'private-client' } },
          'u',
        );

        expect(response.data).toEqual({ ok: true });
        expect(echo.received).toEqual([{ contentType: requestConfig.contentType }]);
        expect(sharedAxios.defaults.headers.post['Content-Type']).toBe('application/host-test');
      });
    } finally {
      await echo.close();
    }
  });
});
