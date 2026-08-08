#!/usr/bin/env node
// 盯梢注册 — 计划依据: W-1 / SP-3 注册回执四要素 / §0.3-I1（每 PR 一个状态文件，无共享锁）
// 状态文件: state/<owner>__<repo>__<N>.json（tmp+rename 原子写）
// 回执四要素: ① 状态文件落盘 ② 引擎 schedule active ③ 心跳 lease 未过期 ④ 本 PR 首扫 ack
//   本脚本保证①并检查②③（可注入）；④由引擎首扫回写 first_scan_ack，--verify 复查。
//   任一缺失 = 注册失败显式报错（绝不假成功，§0.3-F6）。
import { existsSync, readFileSync, renameSync, unlinkSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';
import { validateBranchName, validateRemoteName, validateRepoFullName } from '../lib/git-checks.mjs';
// 状态文件新增字段（审② F6/F7）: cursors（按类游标）/ pending_dispatch（两阶段状态机）

// ===== 状态文件名编码 v3（2026-08-08 GPT R3: v2 clean 折叠非单射，mame/_ 与 mame/- 同路径碰撞）=====
// 段内容 = encodeURIComponent(lower(段))，再补转义 `_` → `%5F`。
//   - 单射: encodeURIComponent 单射；`_` 补转义后段内字符集 {A-Za-z0-9.%!~*'()-} 不含裸 `_`，
//     `__` 分隔符无歧义；owner/repo 任意已允许标点（/ # _ . - 等）两两不碰撞
//   - 可逆: parseStateFileName（decodeURIComponent + %5F 还原），内容反查 round-trip 自洽
//   - 大小写归一: GitHub owner/repo 大小写不敏感（MAME/mame 同一身份）；macOS APFS 默认
//     大小写不敏感，不归一化会让 Mame/Repo#7 与 mame/repo#7 写两个名、实落同一 inode 互相覆盖
//   - 兼容: 无折叠字符的 ASCII 名（o/mivo-canvas 等）编码恒等 → 与 v2 文件名逐字一致，
//     存量普通状态文件零迁移；只有含折叠字符（_ / # 等）的旧注册才走迁移（migrateLegacyStateFile）
export const STATE_FILE_NAME_RE = /^([A-Za-z0-9.%!~*'()-]+)__([A-Za-z0-9.%!~*'()-]+)__(\d+)\.json$/;

export function stateFileName(owner, repo, prNumber) {
  const enc = (s) => encodeURIComponent(String(s).toLowerCase()).replace(/_/g, '%5F');
  return `${enc(owner)}__${enc(repo)}__${Number(prNumber)}.json`;
}

// v3 反向解析（小写解码值）: 解析失败返回 null（调用方按非法文件处理）
export function parseStateFileName(file) {
  const m = STATE_FILE_NAME_RE.exec(file);
  if (!m) return null;
  try {
    return {
      owner: decodeURIComponent(m[1].replace(/%5F/g, '_')),
      repo: decodeURIComponent(m[2].replace(/%5F/g, '_')),
      prNumber: Number(m[3])
    };
  } catch { return null; }
}

// v1/v2 旧编码（保留: 迁移识别用）。clean 非单射——`_`/`/`/`#` 等一律折叠成 `-`，
// 这正是 R3 碰撞根因；只有旧命名文件才需要按本函数做 round-trip 判定。
export function legacyStateFileName(owner, repo, prNumber) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9.-]/g, '-');
  return `${clean(owner)}__${clean(repo)}__${Number(prNumber)}.json`;
}

// SC-FIX-1 (2026-08-08): 状态文件内容身份与调用方身份核对（大小写不敏感——与 stateFileName
// 的 GitHub 大小写归一一致: Mame/Repo 与 mame/repo 同一身份）。
// 判据与 ack.mjs settleAndAckDispatch 的锁内 identity 复核同源（该处用区分大小写比较，
// 此处统一为 lower 比较: 大小写变体必须是同一身份，否则 registerPr 大小写幂等会被破坏）。
export function identityMatches(state, owner, repo, prNumber) {
  return !!state
    && typeof state.owner === 'string'
    && typeof state.repo === 'string'
    && String(state.owner).toLowerCase() === String(owner).toLowerCase()
    && String(state.repo).toLowerCase() === String(repo).toLowerCase()
    && Number(state.pr_number) === Number(prNumber);
}

// 旧命名 → 新命名原子迁移（SC-S3，fail-closed）。判据:
//   1. 内容 identity 的 legacy round-trip 必须等于文件名——否则是名实不符垃圾，拒绝
//   2. 新名不存在 → 持旧名锁原子 rename（同目录，内容原样保留）
//   3. 新名已存在 → 归一化身份（lower owner/repo + pr）相同 = 同一身份重复（大小写/迁移前
//      残留）→ 以新名文件为准删旧合并；不同 = 真实冲突 → 拒绝并给人工恢复提示
// 拒绝/合并都 journal 留痕；绝不静默漏扫（engine/probe 对拒绝文件跳过、但留痕可查）。
export function migrateLegacyStateFile({ stateDir, file, state, journalFile = null }) {
  const j = (rec) => {
    if (!journalFile) return;
    mkdirSync(dirname(journalFile), { recursive: true });
    appendFileSync(journalFile, JSON.stringify({ at: nowIso(), ...rec }) + '\n');
  };
  if (typeof state?.owner !== 'string' || typeof state?.repo !== 'string'
      || !Number.isInteger(Number(state?.pr_number))) {
    j({ kind: 'state-file-rejected', file, error: '内容缺 owner/repo/pr_number，无法反查身份（不迁移，人工核对）' });
    return { ok: false, file, action: 'rejected', reason: 'missing-identity' };
  }
  if (legacyStateFileName(state.owner, state.repo, state.pr_number) !== file) {
    j({ kind: 'state-file-rejected', file, error: '文件名与内容身份的旧编码 round-trip 不符（名实不符垃圾，不迁移）' });
    return { ok: false, file, action: 'rejected', reason: 'name-mismatch' };
  }
  const newFile = stateFileName(state.owner, state.repo, state.pr_number);
  if (newFile === file) return { ok: true, file, action: 'none' }; // 理论不可达（round-trip 通过即新名相同）
  const oldPath = join(stateDir, file);
  const newPath = join(stateDir, newFile);
  return withLock(`${oldPath}.lock`, () => {
    if (!existsSync(oldPath)) { // 并发下已被迁移
      if (existsSync(newPath)) return { ok: true, file: newFile, action: 'none' };
      j({ kind: 'state-file-rejected', file, error: '迁移源消失且目标不存在（异常，不迁移）' });
      return { ok: false, file, action: 'rejected', reason: 'source-lost' };
    }
    if (existsSync(newPath)) {
      let other = null;
      try { other = readJson(newPath); } catch { other = null; }
      const sameId = other && String(other.owner ?? '').toLowerCase() === String(state.owner).toLowerCase()
        && String(other.repo ?? '').toLowerCase() === String(state.repo).toLowerCase()
        && Number(other.pr_number) === Number(state.pr_number);
      if (sameId) {
        unlinkSync(oldPath); // 同一身份重复 → 新名文件为准，删旧合并
        j({ kind: 'state-file-merged', from: file, into: newFile, pr: `${state.owner}/${state.repo}#${state.pr_number}` });
        return { ok: true, file: newFile, action: 'merged' };
      }
      j({ kind: 'state-file-rejected', file, error: `迁移冲突: 目标 ${newFile} 已被不同身份占用（identity 不符）——保留旧文件未动，请人工核对后处理（fail-closed）` });
      return { ok: false, file, action: 'rejected', reason: 'conflict' };
    }
    renameSync(oldPath, newPath); // 同目录原子 rename，内容原样保留
    j({ kind: 'state-file-migrated', from: file, to: newFile, pr: `${state.owner}/${state.repo}#${state.pr_number}` });
    return { ok: true, file: newFile, action: 'renamed' };
  });
}

// 按身份解析状态文件路径（register/ack/finalize/unregister 共用）:
//   新名存在 → 直接用；否则旧名存在 → 尝试迁移（可安全识别单一身份则原子 rename）。
//   迁移失败（垃圾/冲突/损坏）→ 不迁移，按新名路径返回（调用方 existsSync 自然判不存在；
//   engine/probe 侧的目录扫描会对残留文件继续 journal 拒绝，留痕不静默）。
// SC-FIX-1 (2026-08-08): 解析判据除「内容 legacy round-trip 等于文件名自身」外，还必须核对
//   「文件内容身份等于调用方本次传入的 owner/repo/prNumber」——round-trip 只证明内容==文件名，
//   不证明内容==调用方。v2 clean 折叠下 mame/_#N 的旧名恰是 mame/-#N 的新名（碰撞落点）:
//   内容身份 != 调用方身份时，该文件属于他身份，调用方不得解析/复用/覆写。
//   - newFile 已存在但内容身份不符 → 返回 { identityConflict: true }，调用方 fail-closed；
//   - legacyFile 内容身份不符 → 不迁移（否则会把他人文件 rename 成本身份新名），按本身份
//     新名路径返回（调用方正常新建本身份文件，双方互不触碰）。
export function resolveStateFile({ stateDir, owner, repo, prNumber, journalFile = null }) {
  const newFile = stateFileName(owner, repo, prNumber);
  const newPath = join(stateDir, newFile);
  if (existsSync(newPath)) {
    let st = null;
    try { st = readJson(newPath); } catch { st = null; }
    if (st && !identityMatches(st, owner, repo, prNumber)) {
      return { file: newFile, migrated: false, identityConflict: true };
    }
    return { file: newFile, migrated: false };
  }
  const legacyFile = legacyStateFileName(owner, repo, prNumber);
  if (!existsSync(join(stateDir, legacyFile))) return { file: newFile, migrated: false };
  let state = null;
  try { state = readJson(join(stateDir, legacyFile)); } catch { state = null; }
  if (!state) return { file: newFile, migrated: false }; // 损坏旧文件无法反查 → 不迁移
  if (!identityMatches(state, owner, repo, prNumber)) {
    return { file: newFile, migrated: false }; // 他身份的 legacy 文件 → 不迁移，本身份按新名新建
  }
  const mig = migrateLegacyStateFile({ stateDir, file: legacyFile, state, journalFile });
  if (!mig.ok) return { file: newFile, migrated: false };
  return { file: mig.file, migrated: mig.action !== 'none' };
}

// 目录级迁移（engine/probe 扫描前调用）: 把仍为旧命名的状态文件逐个迁移到新编码名。
// 只处理新/旧格式段字符集内的文件；内容反查 round-trip 已通过的（= 新命名或无需改名）
// 跳过；名实不符/冲突由 migrateLegacyStateFile 拒绝并 journal 留痕（fail-closed，
// 绝不静默漏扫——engine/probe 对拒绝文件跳过，但 journal 可查、下轮仍会重试判定）。
export function migrateAllLegacyStateFiles(stateDir, journalFile = null) {
  if (!existsSync(stateDir)) return { scanned: 0, migrated: 0, rejected: 0 };
  const out = { scanned: 0, migrated: 0, rejected: 0 };
  for (const f of readdirSync(stateDir)) {
    if (f.startsWith('manifest-') || f.startsWith('receipt-')) continue;
    if (!STATE_FILE_NAME_RE.test(f)) continue; // 段字符集之外（garbage 等）不处理
    let state = null;
    try { state = readJson(join(stateDir, f)); } catch { continue; }
    out.scanned++;
    if (typeof state?.owner !== 'string' || typeof state?.repo !== 'string'
        || !Number.isInteger(Number(state?.pr_number))) continue; // 内容缺身份 → migrate 侧会拒绝
    if (stateFileName(state.owner, state.repo, state.pr_number) === f) continue; // 已新命名
    const mig = migrateLegacyStateFile({ stateDir, file: f, state, journalFile });
    if (mig.ok && mig.action === 'renamed') out.migrated++;
    if (!mig.ok) out.rejected++;
  }
  return out;
}

export function registerPr({ stateDir, owner, repo, prNumber, branch, registeredBy, pushRepo, pushRemote }) {
  // SC-FIX-2 (2026-08-08): PR 号必须是正整数——0/负数/非整数生成的状态文件名不满足
  // STATE_FILE_NAME_RE（PR 段 \d+），引擎扫描永不命中 = 可注册不可扫的空转，注册即拒绝。
  // SC-FIX-4 (2026-08-08): 规范类型与表示守卫——Number 强转会放行异形输入
  // （"1e2"→100 生成 o__r__100.json、"01"→1 生成 o__r__1.json、true→1、[1]→1），
  // 生成与调用方传入表示不一致的状态文件名（归一化绕过）。只接受:
  //   number 型正整数，或无前导零十进制字符串（/^[1-9]\d*$/）。
  // SC-FIX-4B (2026-08-08 R2): 数值保真复核——/^[1-9]\d*$/ 只验十进制形状不验数值保真，
  // 超过 Number.MAX_SAFE_INTEGER 的十进制字符串经 Number() 双精度损失后仍被接受
  // （'9007199254740993'→9007199254740992），两个不同 PR 号归一化到同一 state 文件
  // （collision）；number 型分支亦无 isSafeInteger 检查。转换结果必须过
  // Number.isSafeInteger（保真判据）——超界即拒绝，不生成精度损失的状态文件名。
  let prNum;
  if (typeof prNumber === 'number') {
    prNum = prNumber;
  } else if (typeof prNumber === 'string' && /^[1-9]\d*$/.test(prNumber)) {
    prNum = Number(prNumber);
  } else {
    throw new Error(`prNumber 非法（须正整数: number 型或 /^[1-9]\\d*$/ 无前导零十进制字符串，got ${JSON.stringify(prNumber)}）——拒绝注册（fail-closed: 生成的状态文件名不满足引擎扫描文法 STATE_FILE_NAME_RE 或与传入表示不一致）`);
  }
  if (!Number.isInteger(prNum) || prNum <= 0 || !Number.isSafeInteger(prNum)) {
    throw new Error(`prNumber 非法（须 Number.MAX_SAFE_INTEGER 内的正整数）: ${JSON.stringify(prNumber)}——拒绝注册（fail-closed: 超过 MAX_SAFE_INTEGER 的 PR 号经 Number() 双精度损失后可与另一 PR 号归一化到同一状态文件）`);
  }
  // 审⑤-F4: branch 与 push remote 名注册时必填——state.branch=null 会让 finalize 必然拒绝，
  // 正常文档路径不允许生成注定失败的注册；remote 名不许引擎事后猜。
  // SC-FIX-5 (2026-08-08): wiring 字段类型契约——branch/push_remote 必须为非空字符串、
  // push_repo 必须为 null 或字符串。git-checks 的语法守卫内部用 String() 归一
  // （123→'123'、true→'true'、自定义 toString 对象→任意串），对非字符串输入会隐式
  // 强转放行；registerPr 是全部注册入口（CLI/reconcile/其他调用方）的共同写盘点，
  // 落盘前在此先拒绝非字符串（守卫不依赖 String 隐式强转）。
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error(`注册缺 branch 或非字符串（fail-closed: 无合法 branch 的状态文件会让 finalize 必然失败）: ${JSON.stringify(branch)}`);
  }
  if (typeof pushRemote !== 'string' || pushRemote.length === 0) {
    throw new Error(`注册缺 push_remote 或非字符串（fail-closed: 修复 push 的 remote 名必须显式指定，引擎不猜）: ${JSON.stringify(pushRemote)}`);
  }
  // SC-FIX-3 (2026-08-08): 落盘前对 branch/push_remote/push_repo 应用与 finalize.mjs
  // validateRemoteBranch 同源的绑定守卫（语法级，判据单一 owner 在 git-checks.mjs）。
  // registerPr 是全部注册入口（CLI/reconcile/其他调用方）的共同写盘点——可注册可派发
  // 但 finalize 必然拒绝（无法收口）的空转状态必须在此 fail-closed，任何入口都绕不过。
  const branchErrs = validateBranchName(branch);
  if (branchErrs.length) throw new Error(`注册拒绝: branch 未过绑定守卫——${branchErrs.join('; ')}`);
  const remoteErrs = validateRemoteName(pushRemote);
  if (remoteErrs.length) throw new Error(`注册拒绝: push_remote 未过绑定守卫——${remoteErrs.join('; ')}`);
  if (pushRepo !== undefined && pushRepo !== null) {
    if (typeof pushRepo !== 'string') {
      throw new Error(`注册拒绝: push_repo 必须为 null 或字符串（got ${typeof pushRepo}）——不依赖 String 隐式强转（fail-closed）: ${JSON.stringify(pushRepo)}`);
    }
    const repoErrs = validateRepoFullName(pushRepo, 'push_repo');
    if (repoErrs.length) throw new Error(`注册拒绝: push_repo 未过绑定守卫——${repoErrs.join('; ')}`);
  }
  // R3 修复: 按身份解析先于加锁——旧命名文件（含折叠字符的 v2 注册）先原子迁移到新编码名，
  // 新名已存在则直接复用（同一身份幂等 already；不同身份必然不同名，不 already 不覆盖）。
  // SC-FIX-1 (2026-08-08): 解析结果可能命中「他身份」文件（v2 clean 折叠碰撞: mame/_#N 的
  // 旧名恰是 mame/-#N 的新名）——identityConflict 预判在加锁前 fail-closed（报调用方真实
  // 身份，不得指向他身份的在途 dispatch 误导）；锁内另有事后身份复核（防 TOCTOU）。
  const { file: resolvedFile, identityConflict } = resolveStateFile({ stateDir, owner, repo, prNumber: prNum });
  if (identityConflict) {
    throw new Error(`注册冲突: ${owner}/${repo}#${prNum} 的状态文件路径 ${resolvedFile} 已被其他身份占用（内容身份与请求不一致）——不覆写不复用（fail-closed），人工核对占用文件归属后处理`);
  }
  const file = join(stateDir, resolvedFile);
  // 审⑥-F1: 读改写持与 engine/ack 同一把 per-key 锁；既有状态做显式 v1→v2 迁移——
  // 只补/纠正接线字段（branch/push_repo/push_remote），cursors/pending_dispatch/first_scan_ack
  // 原样保留（迁移不得重置游标造成重复派发）。旧注册不再永久停派、错误注册可重注册纠正。
  return withLock(`${file}.lock`, () => {
    if (existsSync(file)) {
      const prev = readJson(file);
      // SC-FIX-1: 锁内事后身份复核（与 ack.mjs settleAndAckDispatch 等价）——解析到的新名
      // 文件内容身份必须等于调用方身份；不符 = 他身份文件（旧命名碰撞落点）→ fail-closed
      // 拒绝，绝不覆写/复用。锁外预判与锁内复核之间被并发抢占（TOCTOU）时由本复核兜底。
      if (!identityMatches(prev, owner, repo, prNum)) {
        throw new Error(`注册冲突: ${owner}/${repo}#${prNum} 的状态文件 ${resolvedFile} 内容属于其他身份（${prev.owner}/${prev.repo}#${prev.pr_number}）——不覆写不复用（fail-closed），人工核对后处理`);
      }
      // 审⑥-F1-⑥: push_repo 三态——undefined=保留旧值 / null=显式清空（CLI --clear-push-repo）/ 字符串=设置
      const wantPushRepo = pushRepo === undefined ? (prev.push_repo ?? null) : pushRepo;
      // SC-FIX-5B (2026-08-08 R2): 继承路径类型守卫——上方 SC-FIX-5 只覆盖「本次显式传参」
      // 分支（pushRepo !== undefined），wantPushRepo 从 prev.push_repo 继承时（仅改 branch
      // 重注册）不校验类型：预置畸形 push_repo（对象/数字/boolean）后原样落盘 migrated:true，
      // 后续被 git-checks.mjs 的 String() 隐式强转消费。落盘前对最终值统一应用类型契约
      // （null 或字符串，且字符串过绑定守卫）——与显式分支同判据，不依赖 String 隐式强转。
      if (typeof wantPushRepo !== 'string' && wantPushRepo !== null) {
        throw new Error(`注册拒绝: 继承的 push_repo 必须为 null 或字符串（got ${typeof wantPushRepo}）——不依赖 String 隐式强转（fail-closed）: ${JSON.stringify(wantPushRepo)}`);
      }
      if (typeof wantPushRepo === 'string') {
        const repoErrs = validateRepoFullName(wantPushRepo, 'push_repo');
        if (repoErrs.length) throw new Error(`注册拒绝: 继承的 push_repo 未过绑定守卫——${repoErrs.join('; ')}`);
      }
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
      owner, repo, pr_number: prNum, // SC-FIX-4: 规范表示（无 Number 强转异形放行）
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
  // R3 修复: 与 register/ack/unregister 同源解析（旧命名文件先迁移，四要素检查才能命中旧注册）
  const { file: resolvedFile, identityConflict } = resolveStateFile({ stateDir, owner, repo, prNumber });
  const file = join(stateDir, resolvedFile);

  // ① 落盘
  // SC-FIX-1: 解析路径被他身份文件占据（旧命名碰撞落点）→ 本身份无合法状态文件，要素①不满足
  if (identityConflict) missing.push('要素①: 状态文件未落盘（该路径被其他身份占用，本身份无合法注册）');
  else if (!existsSync(file)) missing.push('要素①: 状态文件未落盘');
  // SC-FIX-6 (2026-08-08): identityConflict 时该路径文件必然存在但内容属于他身份——
  // 不得读取/返回他身份注册详情（branch/push_repo/push_remote/registered_by 不外泄），
  // 要素④也不得用他身份文件的 first_scan_ack 判定本 PR（冲突时 state=null 天然跳过）。
  const state = (identityConflict || !existsSync(file)) ? null : readJson(file);

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
  // R3 修复: 同源解析——旧命名文件先迁移再销单，engine 终态路径（skipLock）与 CLI 一致
  // SC-FIX-1: 解析路径被他身份文件占据（旧命名碰撞落点）→ 绝不删除他身份的合法注册记录
  const { file: resolvedFile, identityConflict } = resolveStateFile({ stateDir, owner, repo, prNumber, journalFile });
  if (identityConflict) return { removed: false };
  const file = join(stateDir, resolvedFile);
  const doIt = () => {
    if (!existsSync(file)) return { removed: false };
    const raw = readFileSync(file, 'utf8');
    let state = null;
    try { state = JSON.parse(raw); } catch { /* 损坏内容：身份不可核验，fail-closed 拒绝删除 */ }
    // SC-FIX-1G (2026-08-08 R2): 锁内身份复核——resolveStateFile 与加锁之间（TOCTOU 窗口）
    // 文件内容可能已被并发替换为他身份（含在途 pending_dispatch）。registerPr/ack/finalize
    // 的锁内复核在此前的修复已覆盖，unregisterPr 是四个共用调用方中唯一缺失的：修复前
    // doIt() 在 unlinkSync 前不做 identityMatches 复核，锁外解析通过后即使锁内文件已换成
    // 他身份内容仍返回 {removed:true} 且物理删除他人注册（含在途 dispatch）。与
    // registerPr 锁内复核同源（同一 identityMatches 判据）——身份不符或不可核验（损坏）
    // 均 fail-closed 拒绝，绝不 unlink 身份不明文件。
    if (!identityMatches(state, owner, repo, prNumber)) {
      if (journalFile) {
        mkdirSync(dirname(journalFile), { recursive: true });
        appendFileSync(journalFile, JSON.stringify({ at: nowIso(), kind: 'unregister-identity-rejected', file, reason: reason ?? 'terminal', owner, repo, prNumber, stateOwner: state?.owner ?? null, stateRepo: state?.repo ?? null, statePr: state?.pr_number ?? null }) + '\n');
      }
      return { removed: false };
    }
    if (journalFile) {
      mkdirSync(dirname(journalFile), { recursive: true });
      appendFileSync(journalFile, JSON.stringify({ at: nowIso(), reason: reason ?? 'terminal', state }) + '\n');
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
