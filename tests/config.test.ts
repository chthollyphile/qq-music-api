import { defaultConfig } from '../src/config/default';
import { ConfigManager } from '../src/config/manager';

describe('ConfigManager', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    // 获取实例并重置状态以便测试
    manager = ConfigManager.getInstance();
    (manager as any).isLoaded = false;
  });

  it('should load default configuration successfully', () => {
    manager.loadConfig();
    const config = manager.getConfig();
    expect(config).toBeDefined();
    expect(config.server.port).toBe(defaultConfig.server?.port);
    expect(config.request.timeout).toBe(10000);
  });

  it('should freeze the returned configuration object', () => {
    manager.loadConfig();
    const config = manager.getConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as any).server = {};
    }).toThrow();
  });

  it('should update config and trigger audit log', () => {
    manager.loadConfig();
    const initialVersion = (manager as any).version;
    manager.updateConfig(
      {
        server: {
          ...manager.getConfig().server,
          port: 9090,
        },
      },
      'test-source',
    );

    const newConfig = manager.getConfig();
    expect(newConfig.server.port).toBe(9090);
    expect((manager as any).version).toBe(initialVersion + 1);
  });

  it('should mask sensitive data in getSafeConfig', () => {
    manager.loadConfig({
      user: {
        loginUin: '123456',
        cookie: 'secret_cookie_value',
        uin: '123456',
        musicid: 123456,
        str_musicid: '123456',
        musickey: 'secret_music_key',
        cookieList: ['secret_cookie_value'],
        cookieObject: { key: 'value' },
      },
    } as any);

    const safeConfig = manager.getSafeConfig();
    const user = safeConfig.user as {
      cookie?: string;
      cookieList?: string[];
      cookieObject?: Record<string, string>;
      loginUin?: string;
      musicid?: string;
      str_musicid?: string;
      musickey?: string;
    };
    expect(user.cookie).toBe('*** MASKED ***');
    expect(user.cookieList).toContain('*** MASKED ***');
    expect(user.cookieObject).toHaveProperty('***', 'MASKED');
    expect(user.loginUin).toBe('123456'); // Non-sensitive fields should remain intact
    expect(user.musicid).toBe('*** MASKED ***');
    expect(user.str_musicid).toBe('*** MASKED ***');
    expect(user.musickey).toBe('*** MASKED ***');
  });
});
