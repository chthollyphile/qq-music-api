import fs from 'node:fs';
import path from 'node:path';

import pkg from '../package.json';

// 当前文件：守住 `npm ci --omit=dev` 的生产安装（Docker / Electron）不会缺少 src 运行时用到的包。
const SOURCE_ROOT = path.join(__dirname, '..', 'src');
const BARE_IMPORT_PATTERN = /(?:from|require\()\s*['"]([^'"]+)['"]/g;

const listSourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });

const toPackageName = (specifier: string): string => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

const collectRuntimePackages = (): string[] => {
  const packages = new Set<string>();

  for (const filePath of listSourceFiles(SOURCE_ROOT)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(BARE_IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) {
        continue;
      }
      packages.add(toPackageName(specifier));
    }
  }

  return [...packages].sort();
};

describe('runtime dependencies', () => {
  const runtimePackages = collectRuntimePackages();
  const dependencies = new Set(Object.keys(pkg.dependencies));
  const devDependencies = new Set(Object.keys(pkg.devDependencies));

  it('finds the packages that src actually imports', () => {
    expect(runtimePackages).toEqual(expect.arrayContaining(['axios', 'chalk', 'colors', 'koa']));
  });

  it('declares every src import in dependencies, not devDependencies', () => {
    const missing = runtimePackages.filter((name) => !dependencies.has(name));
    expect(missing).toEqual([]);
  });

  it('keeps runtime packages out of devDependencies so --omit=dev keeps them', () => {
    const misplaced = runtimePackages.filter((name) => devDependencies.has(name));
    expect(misplaced).toEqual([]);
  });
});
