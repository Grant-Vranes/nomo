#!/usr/bin/env node
/**
 * 构建期校验：离线图形编辑器资源必须随构建携带且 lock 校验一致。
 * 失败则构建直接失败。运行 `npm run offline-editors:fetch` 生成资源。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(ROOT, 'resources');

function sha256Dir(dir) {
  const entries = [];
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${path.relative(dir, full)} ${stat.size} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

function check(label, lockName, dirName) {
  const lockPath = path.join(RESOURCES, lockName);
  const dir = path.join(RESOURCES, dirName);
  if (!fs.existsSync(lockPath)) {
    throw new Error(`缺少 ${lockName}（请运行 npm run offline-editors:fetch）`);
  }
  if (!fs.existsSync(dir)) {
    throw new Error(`缺少 resources/${dirName}/（请运行 npm run offline-editors:fetch）`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.contentSha256 !== sha256Dir(dir)) {
    throw new Error(`resources/${dirName}/ 内容与 ${lockName} 校验不一致，请重新运行 npm run offline-editors:fetch`);
  }
  console.log(`✓ ${label} 资源校验通过（${dirName}）`);
}

check('Draw.io', 'drawio.lock.json', 'drawio');
check('Excalidraw', 'excalidraw.lock.json', 'excalidraw');
