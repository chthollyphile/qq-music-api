import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AndroidDevice,
  createAndroidDevice,
  createDefaultDeviceContextRepository,
  createDeviceContextStore,
  createFileDeviceContextRepository,
  createMemoryDeviceContextRepository,
  DEVICE_STATE_ENV,
  describeDeviceContext,
  isAndroidDevice,
  MEMORY_STATE_PATH,
  resolveDeviceStatePath,
} from '../src/services/auth/deviceContext';

const withTempDir = <T>(run: (directory: string) => T): T => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-device-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

describe('QQ auth device context repository', () => {
  it('should create a protocol-shaped device that survives its own validation', () => {
    const device = createAndroidDevice();

    expect(isAndroidDevice(device)).toBe(true);
    expect(device.imei).toHaveLength(15);
    expect(device.androidId).toHaveLength(16);
    expect(device.openUdid).toHaveLength(32);
    expect(device.qimei).toBeUndefined();
  });

  it('should round-trip a device through a private state file', () => {
    withTempDir((directory) => {
      const statePath = path.join(directory, 'nested', 'qq-device.json');
      const repository = createFileDeviceContextRepository(statePath);
      const device = { ...createAndroidDevice(), qimei: 'q'.repeat(36), qimei36: 'r'.repeat(36) };

      repository.save(device);

      expect(repository.load()).toEqual(device);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).version).toBe(1);
      repository.clear();
      expect(repository.load()).toBeNull();
    });
  });

  it('should reject a corrupt or truncated state file instead of using it', () => {
    withTempDir((directory) => {
      const statePath = path.join(directory, 'qq-device.json');
      const repository = createFileDeviceContextRepository(statePath);

      fs.writeFileSync(statePath, 'not json', 'utf8');
      expect(repository.load()).toBeNull();

      const { imei, ...withoutImei } = createAndroidDevice();
      fs.writeFileSync(statePath, JSON.stringify({ version: 1, device: withoutImei }), 'utf8');
      expect(imei).toBeDefined();
      expect(repository.load()).toBeNull();
      expect(isAndroidDevice({ ...createAndroidDevice(), sdk: 'twenty-nine' })).toBe(false);
    });
  });

  it('should keep working when the state directory is not writable', () => {
    withTempDir((directory) => {
      const blocker = path.join(directory, 'blocker');
      fs.writeFileSync(blocker, 'occupied', 'utf8');
      const repository = createFileDeviceContextRepository(path.join(blocker, 'qq-device.json'));

      expect(() => repository.save(createAndroidDevice())).not.toThrow();
      expect(repository.load()).toBeNull();

      const store = createDeviceContextStore(repository);
      expect(store.get()).toBe(store.get());
    });
  });

  it('should resolve the state path from the environment and support an opt-out', () => {
    expect(resolveDeviceStatePath({ [DEVICE_STATE_ENV]: MEMORY_STATE_PATH })).toBeNull();
    expect(resolveDeviceStatePath({ [DEVICE_STATE_ENV]: './custom/device.json' })).toBe(
      path.resolve('./custom/device.json'),
    );
    expect(resolveDeviceStatePath({})).toBe(
      path.resolve(process.cwd(), '.auth-state', 'qq-device.json'),
    );
    expect(
      createDefaultDeviceContextRepository({ [DEVICE_STATE_ENV]: MEMORY_STATE_PATH }).kind,
    ).toBe('memory');
    expect(createDefaultDeviceContextRepository({}).kind).toBe('file');
  });

  it('should reuse a stored device across store instances and rotate only on reset', () => {
    const repository = createMemoryDeviceContextRepository();
    const first = createDeviceContextStore(repository);
    const created = first.get();
    created.qimei = 'q'.repeat(36);
    created.qimei36 = 'r'.repeat(36);
    created.qimeiSavedAt = Date.now();
    first.persist();

    const restarted = createDeviceContextStore(repository);
    const restored = restarted.get();

    expect(restored.androidId).toBe(created.androidId);
    expect(restored.imei).toBe(created.imei);
    expect(restored.qimei).toBe(created.qimei);
    expect(restarted.reset().androidId).not.toBe(created.androidId);
    expect(createDeviceContextStore(repository).get().androidId).toBe(restarted.get().androidId);
  });

  it('should describe a device without exposing any identifier', () => {
    const device: AndroidDevice = {
      ...createAndroidDevice(),
      qimei: 'q'.repeat(36),
      qimei36: 'r'.repeat(36),
      qimeiSavedAt: Date.now() - 1000,
      sessionUid: 'session-uid',
      sessionSid: 'session-sid',
    };

    const described = describeDeviceContext(device);

    expect(described).toMatchObject({ hasDevice: true, hasQimei: true, hasSession: true });
    expect(described.qimeiAgeMs).toBeGreaterThanOrEqual(1000);
    const serialized = JSON.stringify(described);
    for (const secret of [
      device.qimei,
      device.qimei36,
      device.imei,
      device.androidId,
      'session-uid',
    ])
      expect(serialized).not.toContain(secret);
    expect(describeDeviceContext(null)).toMatchObject({ hasDevice: false, hasQimei: false });
  });
});
