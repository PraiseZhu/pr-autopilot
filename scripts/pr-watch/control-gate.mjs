#!/usr/bin/env node
// 盯梢控制面闸 — 唯一开关读者。
//
// 「关盯梢」必须能拦住所有会起 PR 跟进会话的路径。班车 schedule 的 paused 只停自己，
// review-pr 的 handoff / cindy-dispatch / 补注册都不读它。本模块是那一层共享门禁：
//
//   读到 enabled=true  → { allowed: true }
//   读到 enabled=false → { allowed: false, reason: 'disabled', status: 'SUPPRESSED_BY_SWITCH' }
//   文件缺 / 读失败 / JSON 坏 / enabled 非布尔 → 同上，reason 区分（fail-closed）
//
// 路径解析（按序，命中即停）:
//   1. 调用方显式传入 controlPath（非空字符串）
//   2. 环境变量 PR_AUTOPILOT_CONTROL
//   3. 都没有 → { allowed: true, reason: 'unconfigured' }
//      库调用（runEngine / probe() fixture）不因缺文件变红；生产 CLI 必须自己解析
//      出路径（见 resolveProductionControlPath），缺文件才 fail-closed。
//
// 本模块不派会话、不碰 Cindy API。review-pr 的 handoff 继续走自己的宿主投递，
// 出门前过本闸即可——不要把那条协议硬塞进 cindy-dispatch.mjs。
import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, fail, nowIso, writeJsonAtomic, readJson } from '../lib/common.mjs';
import { STATE_FILE_NAME_RE } from './register.mjs';
import { withLock } from '../lib/state-lock.mjs';

export const SUPPRESSED_BY_SWITCH = 'SUPPRESSED_BY_SWITCH';

function deny(reason) {
  return { allowed: false, reason, status: SUPPRESSED_BY_SWITCH, enabled: false };
}

export function resolveControlPath({ controlPath = null, env = process.env } = {}) {
  if (typeof controlPath === 'string' && controlPath.length > 0) return controlPath;
  const fromEnv = env?.PR_AUTOPILOT_CONTROL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return null;
}

// 生产 CLI 的默认落点：runtime 目录旁的 control.json。
// PR_AUTOPILOT_RUNTIME 优先；否则从 --state-dir 推（state 的父目录）。
// 解析出的路径即使文件还不存在也返回——缺文件由 readControl 判 off。
export function resolveProductionControlPath({ controlPath = null, stateDir = null, env = process.env } = {}) {
  const explicit = resolveControlPath({ controlPath, env });
  if (explicit) return explicit;
  const runtime = env?.PR_AUTOPILOT_RUNTIME;
  if (typeof runtime === 'string' && runtime.length > 0) return join(runtime, 'control.json');
  if (typeof stateDir === 'string' && stateDir.length > 0) return join(dirname(resolvePath(stateDir)), 'control.json');
  return null;
}

export function readControl({ controlPath = null, env = process.env } = {}) {
  const path = resolveControlPath({ controlPath, env });
  if (!path) return { allowed: true, reason: 'unconfigured', status: null, enabled: true };
  if (!existsSync(path)) return deny('missing');
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return deny(`unreadable:${e.code ?? e.message}`); }
  let obj;
  try { obj = JSON.parse(raw); }
  catch { return deny('malformed-json'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return deny('malformed-json');
  if (typeof obj.enabled !== 'boolean') return deny('enabled-not-boolean');
  if (obj.enabled !== true) return deny('disabled');
  return { allowed: true, reason: 'enabled', status: null, enabled: true };
}

export function assertControlAllowed(opts = {}) {
  const gate = readControl(opts);
  if (!gate.allowed) {
    const err = new Error(`control-gate: ${gate.status} (${gate.reason})`);
    err.code = SUPPRESSED_BY_SWITCH;
    err.gate = gate;
    throw err;
  }
  return gate;
}

export function writeControl({ controlPath, enabled, changedBy, now = nowIso() }) {
  if (typeof controlPath !== 'string' || controlPath.length === 0) {
    throw new Error('writeControl 需要 controlPath');
  }
  if (typeof enabled !== 'boolean') throw new Error('writeControl.enabled 必须是布尔');
  writeJsonAtomic(controlPath, {
    enabled,
    changed_at: now,
    changed_by: typeof changedBy === 'string' && changedBy.length ? changedBy : 'unknown'
  });
  return readControl({ controlPath });
}

function defaultQueueDir(env = process.env) {
  if (env.PR_AUTOPILOT_QUEUE_DIR) return env.PR_AUTOPILOT_QUEUE_DIR;
  const runtime = env.PR_AUTOPILOT_RUNTIME;
  if (runtime) return join(runtime, 'dispatch-queue');
  return null;
}

function defaultSuppressedDir(env = process.env) {
  if (env.PR_AUTOPILOT_SUPPRESSED_DIR) return env.PR_AUTOPILOT_SUPPRESSED_DIR;
  const runtime = env.PR_AUTOPILOT_RUNTIME;
  if (runtime) return join(runtime, 'suppressed');
  return null;
}

// 把 dispatch-queue 里未消费的 *.task.txt 挪到 suppressed/，留痕不静默丢。
export function sweepQueueToSuppressed({ queueDir, suppressedDir, now = nowIso() }) {
  if (!queueDir || !existsSync(queueDir)) return { moved: [] };
  if (!suppressedDir) throw new Error('sweepQueueToSuppressed 需要 suppressedDir');
  mkdirSync(suppressedDir, { recursive: true });
  const moved = [];
  for (const f of readdirSync(queueDir)) {
    if (!f.endsWith('.task.txt')) continue;
    const src = join(queueDir, f);
    const dest = join(suppressedDir, `${now.replace(/[:.]/g, '-')}-${f}`);
    renameSync(src, dest);
    moved.push({ from: src, to: dest });
  }
  return { moved };
}

// 把在册 pending_dispatch 标 canceling。不在这里 release 预算——那是 engine 的 canceling
// 恢复分支（ack.mjs cancelDispatch Phase B/C）的活。本函数只做 Phase A，让引擎收敛。
export function markPendingCanceling({ stateDir, now = nowIso() }) {
  if (!stateDir || !existsSync(stateDir)) return { marked: [] };
  const marked = [];
  for (const f of readdirSync(stateDir)) {
    if (!STATE_FILE_NAME_RE.test(f) || f.startsWith('manifest-') || f.startsWith('receipt-')) continue;
    const path = join(stateDir, f);
    withLock(`${path}.lock`, () => {
      let state;
      try { state = readJson(path); } catch { return; }
      if (!state?.pending_dispatch || state.pending_dispatch.canceling) return;
      writeJsonAtomic(path, {
        ...state,
        pending_dispatch: { ...state.pending_dispatch, canceling: true, cancel_started_at: now }
      });
      marked.push(f);
    });
  }
  return { marked };
}

export function suppressRecord({ suppressedDir, kind, payload, now = nowIso() }) {
  if (!suppressedDir) throw new Error('suppressRecord 需要 suppressedDir');
  mkdirSync(suppressedDir, { recursive: true });
  const name = `${now.replace(/[:.]/g, '-')}-${kind}.json`;
  const path = join(suppressedDir, name);
  writeFileSync(path, JSON.stringify({ at: now, kind, status: SUPPRESSED_BY_SWITCH, payload }, null, 2) + '\n');
  return path;
}

// worktree / 别名路径下 isMain 的 realpath 对拍会静默 no-op（本仓 evolution fixture 记过）。
// CLI 入口改看 argv[1] 是否指向本文件，import 当库时不会误跑。
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return /control-gate\.mjs$/.test(process.argv[1]);
  }
})();
if (invokedAsCli) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const path = resolveProductionControlPath({
    controlPath: args.control ?? null,
    stateDir: args['state-dir'] ?? null
  });
  if (cmd === 'read') {
    if (!path) fail('用法: control-gate.mjs read --control <file> | --state-dir <dir> | PR_AUTOPILOT_CONTROL / PR_AUTOPILOT_RUNTIME', 1);
    const gate = readControl({ controlPath: path });
    process.stdout.write(JSON.stringify({ ...gate, path }) + '\n');
    process.exit(gate.allowed ? 0 : 2);
  }
  if (cmd === 'write') {
    if (!path) fail('用法: control-gate.mjs write --control <file> --enabled true|false [--changed-by <who>]', 1);
    const raw = args.enabled;
    if (raw !== 'true' && raw !== 'false') fail('--enabled 必须是 true 或 false', 1);
    const gate = writeControl({ controlPath: path, enabled: raw === 'true', changedBy: args['changed-by'] ?? 'cli' });
    process.stdout.write(JSON.stringify({ ...gate, path }) + '\n');
    process.exit(0);
  }
  if (cmd === 'sweep-off') {
    if (!path) fail('用法: control-gate.mjs sweep-off --control <file> --state-dir <dir> --queue-dir <dir> --suppressed-dir <dir>', 1);
    if (!args['state-dir'] || !args['queue-dir'] || !args['suppressed-dir']) {
      fail('sweep-off 需要 --state-dir --queue-dir --suppressed-dir', 1);
    }
    const gate = writeControl({ controlPath: path, enabled: false, changedBy: args['changed-by'] ?? 'cli' });
    const swept = sweepQueueToSuppressed({ queueDir: args['queue-dir'], suppressedDir: args['suppressed-dir'] });
    const canceling = markPendingCanceling({ stateDir: args['state-dir'] });
    process.stdout.write(JSON.stringify({ gate, swept, canceling, path }) + '\n');
    process.exit(0);
  }
  fail('用法: control-gate.mjs read|write|sweep-off --control <file> ...', 1);
}

void fileURLToPath;
void dirname;
