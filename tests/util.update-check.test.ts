import { loggerState } from '../src/util/logger';
import { shouldCheckLatestVersion, UPDATE_CHECK_ENV } from '../src/util/updateCheck';

describe('shouldCheckLatestVersion', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDisable = process.env[UPDATE_CHECK_ENV];
  const originalIsTestEnv = loggerState.isTestEnv;

  const withTestEnv = (isTestEnv: boolean) => {
    (loggerState as { isTestEnv: boolean }).isTestEnv = isTestEnv;
  };

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDisable === undefined) {
      delete process.env[UPDATE_CHECK_ENV];
    } else {
      process.env[UPDATE_CHECK_ENV] = originalDisable;
    }
    withTestEnv(originalIsTestEnv);
  });

  it('checks in a normal development run', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'development';
    delete process.env[UPDATE_CHECK_ENV];
    expect(shouldCheckLatestVersion()).toBe(true);
  });

  it('skips in production so containers and packaged apps never spawn npm', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'production';
    delete process.env[UPDATE_CHECK_ENV];
    expect(shouldCheckLatestVersion()).toBe(false);
  });

  it('skips when explicitly disabled', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'development';
    process.env[UPDATE_CHECK_ENV] = 'true';
    expect(shouldCheckLatestVersion()).toBe(false);
  });

  it('skips under jest', () => {
    withTestEnv(true);
    process.env.NODE_ENV = 'development';
    delete process.env[UPDATE_CHECK_ENV];
    expect(shouldCheckLatestVersion()).toBe(false);
  });
});
