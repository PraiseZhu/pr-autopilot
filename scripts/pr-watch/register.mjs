#!/usr/bin/env node
// 盯梢注册 — 计划依据: W-1 / SP-3 注册回执四要素 / §0.3-I1（每 PR 一个状态文件，无共享锁）
// 状态文件: state/<owner>__<repo>__<N>.json（tmp+rename 原子写）
// 回执四要素: ① 状态文件落盘 ② 引擎 schedule active ③ 心跳 lease 未过期 ④ 本 PR 首扫 ack
//   本脚本保证①并检查②③（可注入）；④由引擎首扫回写 first_scan_ack，--verify 复查。
//   任一缺失 = 注册失败显式报错（绝不假成功，§0.3-F6）。
import { existsSync, readFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';
// 状态文件新增字段（审② F6/F7）: cursors（按类游标）/ pending_dispatch（两阶段状态机）

export function stateFileName(owner, repo, prNumber) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9.-]/g, '-');
  return `${clean(owner)}__${clean(repo)}__${Number(prNumber)}.json`;
}

export function registerPr({ stateDir, owner, repo, prNumber, branch, registeredBy, pushRepo, pushRemote }) {
  // 审⑤-F4: branch 与 push remote 名注册时必填——state.branch=null 会让 finalize 必然拒绝，
  // 正常文档路径不允许生成注定失败的注册；remote 名不许引擎事后猜。
  if (!branch) throw new Error('注册缺 branch（fail-closed: 无 branch 的状态文件会让 finalize 必然失败）');
  if (!pushRemote) throw new Error('注册缺 push_remote（fail-closed: 修复 push 的 remote 名必须显式指定，引擎不猜）');
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  // 审⑥-F1: 读改写持与 engine/ack 同一把 per-key 锁；既有状态做显式 v1→v2 迁移——
  // 只补/纠正接线字段（branch/push_repo/push_remote），cursors/pending_dispatch/first_scan_ack
  // 原样保留（迁移不得重置游标造成重复派发）。旧注册不再永久停派、错误注册可重注册纠正。
  return withLock(`${file}.lock`, () => {
    if (existsSync(file)) {
      const prev = readJson(file);
      // 审⑥-F1-⑥: push_repo 三态——undefined=保留旧值 / null=显式清空（CLI --clear-push-repo）/ 字符串=设置
      const wantPushRepo = pushRepo === undefined ? (prev.push_repo ?? null) : pushRepo;
      const wiringChanged = prev.branch !== branch || prev.push_remote !== pushRemote
        || (prev.push_repo ?? null) !== wantPushRepo;
      // 审⑥-F1-⑥: 在途 dispatch 的 manifest 冻结着旧接线，engine 重派走 pending 不看 state——
      // 接线纠错遇到非空 pending 必须 fail-closed，先收口/取消在途任务再重注册，
      // 不得声称 migrated 却让旧 manifest 继续对旧 remote 重派。
      if (wiringChanged && prev.pending_dispatch) {
        // 审⑦-P1: 恢复路径只有两条——complete（副作用核验后 ack）或 cancel（ack.mjs --cancel，
        // 不消费游标 + 释放预留 + 升 generation，同信号以新 id 重派）。绝不指引裸 ack 当取消。
        throw new Error(`迁移拒绝: ${owner}/${repo}#${prNumber} 有在途 dispatch（${prev.pending_dispatch.dispatch_id}）且接线字段变化——先运行 complete 收口，或用 ack.mjs --cancel 取消在途任务（不消费游标，同信号将以新 generation 重派），再重注册纠错（fail-closed，防旧 manifest 沿旧 remote 重派）`);
      }
      const next = {
        ...prev,
        schema_version: 'v2',
        branch, push_repo: wantPushRepo, push_remote: pushRemote,
        // 审⑪-P1: epoch 跨迁移/重注册保留（同一注册身份）；legacy 缺失时补生成。
        // 真正销单后重新注册走下方新建分支 = 新 epoch，旧 dispatch id 空间永不复用。
        registration_epoch: prev.registration_epoch ?? randomBytes(8).toString('hex')
      };
      const migrated = prev.schema_version !== 'v2' || wiringChanged || !prev.registration_epoch;
      if (migrated) writeJsonAtomic(file, next);
      return { file, state: next, already: true, migrated }; // 幂等: 游标/pending 不动
    }
    const state = {
      schema_version: 'v2',
      owner, repo, pr_number: Number(prNumber),
      registration_epoch: randomBytes(8).toString('hex'), // 审⑪-P1: 每次全新注册 = 新 dispatch id 空间
      branch,
      push_repo: pushRepo ?? null, // cindy 场景: 修复 push 目标 fork 全名（finalize 绑 remote URL 用）
      push_remote: pushRemote,     // 修复 worktree 里的 push remote 名（mivo=origin / cindy=fork）
      registered_at: nowIso(),
      registered_by: registeredBy ?? 'unknown',
      cursors: null,               // 按类游标（W-3 审②-F7 版），首扫后写入
      pending_dispatch: null,      // 两阶段状态机（F6）: dispatch→ack 才推进游标
      first_scan_ack: null,        // 回执要素④
      status: 'watching'           // watching | blocked-external | fixing | cleanup-pending
    };
    writeJsonAtomic(file, state);
    return { file, state, already: false, migrated: false };
  });
}

export function checkReceipt({ stateDir, owner, repo, prNumber, leaseFile, leaseTtlMinutes = 45, scheduleCheckCmd }) {
  const missing = [];
  const file = join(stateDir, stateFileName(owner, repo, prNumber));

  // ① 落盘
  if (!existsSync(file)) missing.push('要素①: 状态文件未落盘');
  const state = existsSync(file) ? readJson(file) : null;

  // ② 引擎 schedule active（可注入命令，产出 "active"/其他）
  if (scheduleCheckCmd) {
    try {
      const out = execFileSync(scheduleCheckCmd[0], scheduleCheckCmd.slice(1), { encoding: 'utf8' }).trim();
      if (out !== 'active') missing.push(`要素②: 引擎 schedule 非 active（got: ${out}）`);
    } catch (e) {
      missing.push(`要素②: schedule 状态读不到（fail-closed）: ${e.message}`);
    }
  } else {
    missing.push('要素②: 未提供 schedule 检查命令（fail-closed）');
  }

  // ③ lease 未过期
  if (!leaseFile || !existsSync(leaseFile)) {
    missing.push('要素③: 引擎心跳 lease 文件不存在');
  } else {
    const lease = readJson(leaseFile);
    const age = (Date.now() - Date.parse(lease.last_success)) / 60000;
    if (!(age >= 0) || age > leaseTtlMinutes) missing.push(`要素③: lease 过期（${age.toFixed(1)} 分钟 > TTL ${leaseTtlMinutes}）`);
  }

  // ④ 首扫 ack
  if (state && !state.first_scan_ack) missing.push('要素④: 本 PR 首扫 ack 未回写（等下一轮引擎扫描，超 30 分钟仍缺则报 owner）');

  return { ok: missing.length === 0, missing, state };
}

export function unregisterPr({ stateDir, owner, repo, prNumber, reason, journalFile, skipLock = false }) {
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  const doIt = () => {
    if (!existsSync(file)) return { removed: false };
    const state = readFileSync(file, 'utf8');
    if (journalFile) {
      mkdirSync(dirname(journalFile), { recursive: true });
      appendFileSync(journalFile, JSON.stringify({ at: nowIso(), reason: reason ?? 'terminal', state: JSON.parse(state) }) + '\n');
    }
    unlinkSync(file);
    return { removed: true };
  };
  // 审③-F14: 与 engine/ack 共用 per-key 锁；engine 终态路径已持锁时 skipLock
  return skipLock ? doIt() : withLock(`${file}.lock`, doIt);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['state-dir', 'owner', 'repo', 'pr', 'branch', 'push-remote']; // 审⑤-F4: branch/push-remote CLI 必填
  if (need.some((k) => !args[k])) fail('用法: register.mjs --state-dir <dir> --owner <o> --repo <r> --pr <N> --branch <b> --push-remote <origin|fork> [--push-repo owner/name | --clear-push-repo] [--verify --lease <file> --schedule-check "<cmd>"]');
  mkdirSync(args['state-dir'], { recursive: true });
  // 审⑥-F1-⑥: --clear-push-repo 显式清空（fork→origin 纠错）；不传任何 push-repo 参数 = 保留旧值
  const pushRepoArg = args['clear-push-repo'] ? null : (args['push-repo'] ?? undefined);
  const { file, already } = registerPr({
    stateDir: args['state-dir'], owner: args.owner, repo: args.repo,
    prNumber: args.pr, branch: args.branch, pushRepo: pushRepoArg,
    pushRemote: args['push-remote'],
    registeredBy: args.by ?? 'cli'
  });
  process.stdout.write(`${already ? 'ALREADY' : 'REGISTERED'} ${file}\n`);
  if (args.verify) {
    // 审②-I2: 首扫 ack 是异步的——新注册立即 verify 必然缺要素④。
    // 有限等待: --wait-seconds 内轮询（可用 --scan-cmd 主动触发一次引擎扫描），
    // 到时仍缺 = 真失败，显式报 owner。
    const waitMs = Number(args['wait-seconds'] ?? 0) * 1000;
    const deadline = Date.now() + waitMs;
    let receipt;
    for (;;) {
      if (args['scan-cmd']) {
        try {
          const parts = args['scan-cmd'].split(' ');
          execFileSync(parts[0], parts.slice(1), { encoding: 'utf8' });
        } catch (e) { process.stderr.write(`[VERIFY] scan-cmd 失败: ${e.message}\n`); }
      }
      receipt = checkReceipt({
        stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr,
        leaseFile: args.lease,
        scheduleCheckCmd: args['schedule-check'] ? args['schedule-check'].split(' ') : null
      });
      if (receipt.ok || Date.now() >= deadline) break;
      execFileSync('sleep', ['2']);
    }
    if (!receipt.ok) {
      for (const m of receipt.missing) process.stderr.write(`[RECEIPT-FAIL] ${m}\n`);
      process.exit(2); // 注册回执不完整 = 注册失败，显式报 owner
    }
    process.stdout.write('RECEIPT-OK 四要素齐备\n');
  }
}
