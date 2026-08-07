import { loggerState } from '../src/util/logger';
import {
  shouldCheckLatestVersion,
  UPDATE_CHECK_ENV,
  UPDATE_CHECK_OPT_IN_ENV,
} from '../src/util/updateCheck';

describe('shouldCheckLatestVersion', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDisable = process.env[UPDATE_CHECK_ENV];
  const originalOptIn = process.env[UPDATE_CHECK_OPT_IN_ENV];
  const originalIsTestEnv = loggerState.isTestEnv;

  const withTestEnv = (isTestEnv: boolean) => {
    (loggerState as { isTestEnv: boolean }).isTestEnv = isTestEnv;
  };

  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    restoreEnv(UPDATE_CHECK_ENV, originalDisable);
    restoreEnv(UPDATE_CHECK_OPT_IN_ENV, originalOptIn);
    withTestEnv(originalIsTestEnv);
  });

  it('skips by default so being required as a package never spawns npm', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'development';
    delete process.env[UPDATE_CHECK_ENV];
    delete process.env[UPDATE_CHECK_OPT_IN_ENV];
    expect(shouldCheckLatestVersion()).toBe(false);
  });

  it('checks only when explicitly opted in', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'development';
    delete process.env[UPDATE_CHECK_ENV];
    process.env[UPDATE_CHECK_OPT_IN_ENV] = 'true';
    expect(shouldCheckLatestVersion()).toBe(true);
  });

  it('skips in production so containers and packaged apps never spawn npm', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'production';
    delete process.env[UPDATE_CHECK_ENV];
    delete process.env[UPDATE_CHECK_OPT_IN_ENV];
    expect(shouldCheckLatestVersion()).toBe(false);
  });

  it('keeps the legacy disable flag winning over the opt-in', () => {
    withTestEnv(false);
    process.env.NODE_ENV = 'development';
    process.env[UPDATE_CHECK_ENV] = 'true';
    process.env[UPDATE_CHECK_OPT_IN_ENV] = 'true';
    expect(shouldCheckLatestVersion()).toBe(false);
  });

  it('skips under jest', () => {
    withTestEnv(true);
    process.env.NODE_ENV = 'development';
    delete process.env[UPDATE_CHECK_ENV];
    process.env[UPDATE_CHECK_OPT_IN_ENV] = 'true';
    expect(shouldCheckLatestVersion()).toBe(false);
  });
});
