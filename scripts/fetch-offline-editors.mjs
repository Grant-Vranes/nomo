#!/usr/bin/env node
/**
 * 拉取/构建桌面端离线图形编辑器资源：
 *  1. Draw.io：下载 jgraph/drawio 发布版 draw.war，SHA-256 校验后解包到 resources/drawio/
 *  2. Excalidraw：用 scripts/excalidraw-host 宿主源码 + @excalidraw/excalidraw 构建静态微应用到 resources/excalidraw/
 * 两个目录各生成一个 lock 文件（版本 + SHA-256），构建期由 tests/check-package-assets.mjs 校验。
 * 已就位且 lock 校验通过时脚本快速退出，可安全挂在 beforeDevCommand / beforeBuildCommand 上。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(ROOT, 'resources');

const DRAWIO_VERSION = '32.6.1';
const DRAWIO_WAR_URL = `https://github.com/jgraph/drawio/releases/download/v${DRAWIO_VERSION}/draw.war`;
// 锁定的 SHA-256（draw.war）。升级版本时同步更新此处。
const DRAWIO_WAR_SHA256 = '44dd56958c8408963457dc98f04d2228408ac145c7aa1d8e6895d9c88d5e42aa';

const EXCALIDRAW_VERSION = '0.18.1';
const REACT_VERSION = '18.3.1';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Dir(dir) {
  const entries = [];
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${path.relative(dir, full)} ${stat.size} ${sha256File(full)}`);
    }
  })(dir);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

function ensureFreshLock(lockPath, dir, meta) {
  if (!fs.existsSync(dir)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (existing.contentSha256 === sha256Dir(dir) && existing.metaSha256 === JSON.stringify(meta)) {
      return true; // 已就位且一致
    }
  } catch {
    /* lock 缺失/损坏，重建 */
  }
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ ...meta, contentSha256: sha256Dir(dir), metaSha256: JSON.stringify(meta) }, null, 2)}\n`,
  );
  return true;
}

/* ---------------- Draw.io ---------------- */

function fetchDrawio() {
  const dir = path.join(RESOURCES, 'drawio');
  const meta = { kind: 'drawio', version: DRAWIO_VERSION, url: DRAWIO_WAR_URL, warSha256: DRAWIO_WAR_SHA256 };
  const lockPath = path.join(RESOURCES, 'drawio.lock.json');
  if (fs.existsSync(dir) && fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock.version === DRAWIO_VERSION && lock.contentSha256 === sha256Dir(dir)) {
        console.log(`[offline-editors] drawio v${DRAWIO_VERSION} 已就位，跳过下载`);
        return;
      }
    } catch {
      /* 重新拉取 */
    }
  }
  const warPath = path.join(RESOURCES, 'draw.war.part');
  console.log(`[offline-editors] 下载 drawio v${DRAWIO_VERSION} ...`);
  fs.mkdirSync(RESOURCES, { recursive: true });
  execFileSync('curl', ['-fSL', '--retry', '3', '-o', warPath, DRAWIO_WAR_URL], { stdio: 'inherit' });
  const actual = sha256File(warPath);
  if (actual !== DRAWIO_WAR_SHA256) {
    fs.rmSync(warPath, { force: true });
    throw new Error(`draw.war SHA-256 校验失败：期望 ${DRAWIO_WAR_SHA256}，实际 ${actual}`);
  }
  console.log('[offline-editors] SHA-256 校验通过，解包中 ...');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-oq', warPath, '-d', dir], { stdio: 'inherit' });
  fs.rmSync(warPath, { force: true });
  ensureFreshLock(lockPath, dir, meta);
  console.log('[offline-editors] drawio 就绪');
}

/* ---------------- Excalidraw ---------------- */

function buildExcalidraw() {
  const dir = path.join(RESOURCES, 'excalidraw');
  const meta = {
    kind: 'excalidraw',
    excalidraw: EXCALIDRAW_VERSION,
    react: REACT_VERSION,
    host: sha256Dir(path.join(ROOT, 'scripts', 'excalidraw-host')),
  };
  const lockPath = path.join(RESOURCES, 'excalidraw.lock.json');
  if (fs.existsSync(dir) && fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock.metaSha256 === JSON.stringify(meta) && lock.contentSha256 === sha256Dir(dir)) {
        console.log('[offline-editors] excalidraw 已就位，跳过构建');
        return;
      }
    } catch {
      /* 重新构建 */
    }
  }
  const hostDir = path.join(ROOT, 'scripts', 'excalidraw-host');
  const packageJson = {
    name: 'nomo-excalidraw-host',
    private: true,
    type: 'module',
    scripts: { build: 'vite build' },
    dependencies: {
      react: `^${REACT_VERSION}`,
      'react-dom': `^${REACT_VERSION}`,
      '@excalidraw/excalidraw': EXCALIDRAW_VERSION,
    },
    devDependencies: {
      vite: '^6.0.0',
      '@types/react': `^${REACT_VERSION}`,
      '@vitejs/plugin-react': '^4.3.0',
    },
  };
  fs.writeFileSync(path.join(hostDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log('[offline-editors] 安装 excalidraw 宿主依赖 ...');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: hostDir,
    stdio: 'inherit',
  });
  console.log('[offline-editors] 构建 excalidraw 微应用 ...');
  execFileSync('npm', ['run', 'build'], { cwd: hostDir, stdio: 'inherit' });
  ensureFreshLock(lockPath, dir, meta);
  console.log('[offline-editors] excalidraw 就绪');
}

/* ---------------- main ---------------- */

const only = process.argv[2];
if (!only || only === 'drawio') fetchDrawio();
if (!only || only === 'excalidraw') buildExcalidraw();
console.log('[offline-editors] 完成');
