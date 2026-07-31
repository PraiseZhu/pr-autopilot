// pr-autopilot 公共库 — 计划依据: docs/plan.md §1.1b ⑨⑩ (机器契约 + 两段式 hash)
// 零外部依赖，仅 node 内建。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// CLI 主模块判断 — e2e-evolution 实锤: macOS /tmp→/private/tmp 别名下
// `import.meta.url === file://argv[1]` 失配会「成功退出但不执行」（静默 no-op）。
// 统一走 realpath 归一化，两侧都解析后比较。
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(new URL(metaUrl).pathname) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
export { pathToFileURL };

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

// 键排序的规范化 JSON —— 同一对象在任何机器上得到同一 hash
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function hashObject(obj) {
  return sha256(canonicalJson(obj));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// tmp+rename 原子写 —— 计划 W-1: 只防半文件，不需要跨进程锁（mini 无 flock）
export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

export function fail(msg, code = 1) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(code);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

export function nowIso() {
  return new Date().toISOString();
}

export { tmpdir };
