import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type Method,
} from 'axios';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

export interface AuthHttpClient {
  getCookieHeader(): string;
  request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}

const normalizeSetCookies = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};

const updateCookieJar = (jar: Map<string, string>, setCookies: string[]): void => {
  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
};

const cookieHeader = (jar: Map<string, string>): string =>
  Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');

const redirectedMethod = (status: number, method: string | undefined): Method => {
  if (status === 303) return 'GET';
  if ([301, 302].includes(status) && String(method).toUpperCase() === 'POST') return 'GET';
  return (method ?? 'GET') as Method;
};

export const createAuthHttpClient = (
  transport: AxiosInstance = axios.create({ timeout: 25000, maxRedirects: 0 }),
): AuthHttpClient => {
  const jar = new Map<string, string>();

  const request = async <T>(initial: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
    let config = { ...initial };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const cookies = cookieHeader(jar);
      const response = await transport.request<T>({
        ...config,
        headers: { ...config.headers, ...(cookies ? { Cookie: cookies } : {}) },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      updateCookieJar(jar, normalizeSetCookies(response.headers['set-cookie']));

      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
      if (redirectCount === MAX_REDIRECTS) throw new Error('QQ auth redirect limit exceeded');

      const method = redirectedMethod(response.status, config.method);
      config = {
        ...config,
        url: new URL(location, config.url).toString(),
        method,
        data: method === 'GET' ? undefined : config.data,
      };
    }
    throw new Error('QQ auth redirect limit exceeded');
  };

  return {
    getCookieHeader: () => cookieHeader(jar),
    request,
    post: <T>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, url, data, method: 'POST' }),
  };
};

export default createAuthHttpClient;
