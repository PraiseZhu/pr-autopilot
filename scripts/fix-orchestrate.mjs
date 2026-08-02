#!/usr/bin/env node
// 修复执行编排器 — 计划: docs/plan/fix-orchestration-gate.md §4b（审 R1-P1-5 修正版）
// 职责（构造级保证「该串行必须串行」，不依赖 lead 诚实）:
//   allocate  按 plan 为本波每组建独立 worktree+分支（base=wave_base），产出组→路径/base 映射
//   integrate 逐组 merge 回集成分支；**merge 前比实改文件集**，非空交集 → fail-closed 弃组重排
//   waveBase  wave1 = candidate；wave k+1 = wave k 集成 tip（审 R1-P1-5: 否则依赖波看不见前波产物）
//
// 隔离即安全: 每组在自己 worktree 里改，并发写危险从构造上消失（不是事后检查）。
// git merge conflict 与 实改文件交集 是**真实**碰撞检测器，不是预测。
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, isMain, nowIso, normalizeRepoPath } from './lib/common.mjs';

// R5-P0: 「内容相等 ≠ 创建归属」——HEAD/base 血缘都可能与他人 worktree 撞值。
// 唯一可靠的归属判据是**创建时印记**: worktree 的 admin git-dir 里写 owner 文件
// （run_id + 随机 nonce），manifest 记录 nonce；cleanup 时两边比对。
const OWNER_FILE = 'pr-autopilot-owner';
export function stampOwner({ worktreeDir, payload, exec = null }) {
  const gitdir = exec
    ? exec(['git', '-C', worktreeDir, 'rev-parse', '--absolute-git-dir']).trim()
    : git(worktreeDir, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitdir, OWNER_FILE), JSON.stringify(payload) + '\n');
  return payload;
}
export function readOwner({ worktreeDir, exec = null }) {
  try {
    const gitdir = exec
      ? exec(['git', '-C', worktreeDir, 'rev-parse', '--absolute-git-dir']).trim()
      : git(worktreeDir, 'rev-parse', '--absolute-git-dir');
    return JSON.parse(readFileSync(join(gitdir, OWNER_FILE), 'utf8'));
  } catch { return null; }
}
export function newNonce() { return randomBytes(16).toString('hex'); }

const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', timeout: 120_000 }).trim(); }

export function groupBranch(runId, groupId) { return `fix/${runId}/${groupId}`; }
export function groupWorktreePath(worktreeRoot, runId, groupId) { return join(worktreeRoot, `${runId}-${groupId}`); }

// anchor_paths 三用途拆分（2026-08-02，源: mivo-canvas PR #419 submit-pr 实战反馈）:
//   finding.anchor_paths 是证据锚点；fix-plan 的 group.paths（= 覆盖 findings 的 anchor_paths
//   并集）是分组/hub 判定输入——这两用途不变，仍读 anchor_paths。
//   写入许可（第三用途）不再等于 anchor 并集：evidence 可能落在只读症状文件，真正要改的文件
//   可能根本不在证据里，拿 anchor 当写入域会把合法修复误判「越域改动」拒绝。
// write_paths 由 SC 的 kind 决定（脚本推导，lead/AI 不可自由填写——D2）：
//   kind=verify：SC-R3-7 加固不变——仍要求 changed ⊆ anchor 并集，且叠加全测试路径形状
//     （verify SC 的意图本就是「在指定测试文件里补断言」，证据=目标不构成本次要修的错配）。
//   kind=archive（SC-M1，合并另一分支后补齐）：fix-plan.mjs 把 group.paths 固定改写为
//     ARCHIVE_PATH（README.md，脚本给定常量，不从 anchor_paths 派生）——这是全链**唯一**
//     诚实拥有正向写入清单数据源的场景，专开一档 mode，不与 verify 共用
//     'anchor-test-path'：archive 的路径既不是 anchor 也不是 test path，混用会让下一个人
//     误以为它经过测试路径校验。
//   kind=fix：没有 kind 内在目标文件（修复内容各异，无法脚本推导出比 anchor 更准的清单，
//     而清单又不能由 lead/AI 自报）——不设清单，写入边界只靠结构隔离（各组独立 worktree，
//     并发写从构造上不可能）+ 集成期真实 diff 重叠检测（integrate() 无条件执行，不依赖
//     任何声明域，SC-R3-9）兜底。
export function writePathsFor(group) {
  if (group?.verify) return { mode: 'anchor-test-path', paths: group.paths ?? [] };
  if (group?.archive) return { mode: 'fixed-list', paths: group.paths ?? [] };
  return { mode: 'isolated' };
}

// SC-B1: 派工包的 family 上下文——纯只读派生，不改变写入范围（write_paths 仍按 kind 走
// writePathsFor 不变）。分组逻辑（union-find 按路径冲突）完全不改；本函数只是在已分好的组
// 之上，为组内每条 SC 附上「同 family 的其它已知 manifestation」，让 worker 一次看到本不变量
// 的全部已知表现——不这样做的话，worker 只看到自己组分到的窄路径，容易重演 hardening-checklist
// 第 1 类踩过的坑（分四次补丁而不是一次套对形状），只是这次的窄面来自「family 的其它成员在
// 别的组/别的波，我看不见」而不是「一个函数里少写一支」。
// D1: 分组键是 family_key（内容派生），不是 family_id——family_id 只是 reviewer 席内的本地
// 标签，两个不同 reviewer 完全可能各自合法地把同一标签用来指不同的不变量；按标签分组会把
// 互不相关的 finding 错误合并（gpt 终审实测复现的阻断项）。family 关系跨组/跨波（同 family_key
// 的两条 finding 完全可能分到不同的路径冲突组，甚至一个进 fix 波一个进 verify 波）——因此必须
// 扫**全量** canonical_findings，不能只看本组的 SC。
// D3（gpt 终审阻断修复）: artifact/manifest 必填——不传/传旧版（actionable finding 缺
// family_key）不再静默退化成「没有 family_context」，两个入口（本函数 + fix-run.mjs 的
// allocate）同等 fail-closed（hardening-checklist 第 5 类）。
export function familyContext({ artifact, manifest, scIds }) {
  if (!artifact) throw new Error('familyContext 缺 artifact（D3 必填：family_context 要强制覆盖全部路径，不传不再静默产出 null，两个入口同等 fail-closed）');
  if (!manifest) throw new Error('familyContext 缺 manifest（D3 必填，同上）');
  const canonical = artifact.canonical_findings ?? [];
  // D3: 真旧版 artifact（actionable finding 缺 family_key，即未升级到本次数据契约）不做
  // 静默兼容——一次性扫全量 canonical_findings，任何 actionable finding 缺 family_key 立即
  // fail-closed，而不是让「强制覆盖全部路径」这件事在下游按 scId 逐个悄悄退化成部分覆盖。
  for (const f of canonical) {
    if ((f.severity === 'blocker' || f.severity === 'major') && !f.family_key) {
      throw new Error(`familyContext: actionable finding ${f.id}（${f.severity}）缺 family_key——疑似旧版 consensus artifact（未升级到 family_key 数据契约），请用当前版本重新生成，不得静默产出不完整的 family_context（D3 fail-closed）`);
    }
  }
  const findingById = new Map(canonical.map((f) => [f.id, f]));
  const scByFindingId = new Map();
  for (const sc of manifest.scs ?? []) {
    if (sc.kind === 'global') continue;
    for (const fid of sc.finding_ids ?? []) scByFindingId.set(fid, sc.id);
  }
  // family_key -> 该 family 全部 manifestation（finding_id/sc_id/anchor_paths），全量、不分组不分波
  const byFamily = new Map();
  for (const f of canonical) {
    if (!f.family_key) continue; // 未归族（suggestion 或缺归因）: 不参与 family 聚合
    if (!byFamily.has(f.family_key)) byFamily.set(f.family_key, []);
    byFamily.get(f.family_key).push({
      finding_id: f.id, sc_id: scByFindingId.get(f.id) ?? null,
      anchor_paths: f.anchor_paths ?? [], invariant: f.invariant ?? null
    });
  }
  const out = {};
  for (const scId of scIds ?? []) {
    const sc = (manifest.scs ?? []).find((s) => s.id === scId);
    const fid = sc?.finding_ids?.[0];
    const f = fid ? findingById.get(fid) : null;
    if (!f || !f.family_key) { out[scId] = null; continue; } // 不存在或本就未归族（suggestion）: 合法态
    // 同 family 前序 finding 引用（D1 归因链）: 排除自己，其余全部 manifestation 原样列出——
    // 包括它们各自的 finding_id（引用本体）与已分到的 sc_id（若尚未分到任何 SC 则为 null）。
    const manifestations = (byFamily.get(f.family_key) ?? []).filter((m) => m.finding_id !== f.id);
    out[scId] = {
      family_key: f.family_key,
      invariant: f.invariant,
      manifestations,
      audit_instruction: manifestations.length
        ? `本 SC 修复的不变量「${f.invariant}」在本轮共识中还有 ${manifestations.length} 处已知表现（family_key=${f.family_key}）：${manifestations.map((m) => `${m.finding_id}${m.sc_id ? `(${m.sc_id})` : ''}@${m.anchor_paths.join(',')}`).join('; ')}。除上述已点名路径外，请审计所有可能违反该不变量的代码路径（含未点名处），一次性修复到位——不要只按分给自己的这几处打窄补丁。`
        : `本 SC 修复的不变量「${f.invariant}」在本轮共识中暂无其它已知表现，但请审计所有可能违反该不变量的代码路径（含未点名处），不要只按 anchor_paths 打窄补丁。`
    };
  }
  return out;
}

// 为一个波次分配 worktree（幂等: 已存在同名 worktree 视为复用，base 必须一致否则 fail-closed）
// D3（gpt 终审阻断修复）: artifact/scManifest 改必填——旧版允许不传、静默产出 family_context
// =null，「强制覆盖全部路径」这件事因此可以静默退化成「有的路径覆盖、有的路径没覆盖」。
// 两个入口（本函数 + fix-run.mjs 的 allocate）同等 fail-closed，不留 legacy 静默通道。
export function allocateWave({ repoDir, worktreeRoot, runId, plan, waveIndex, waveBase, exec = null, artifact, scManifest }) {
  if (!artifact) throw new Error('allocateWave 缺 artifact（D3 必填：family_context 强制覆盖全部路径，不传会静默退化，两个入口同等 fail-closed）');
  if (!scManifest) throw new Error('allocateWave 缺 scManifest（D3 必填，同上）');
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) throw new Error(`runId 非法: ${runId}`);
  if (!/^[0-9a-f]{40}$/.test(String(waveBase))) throw new Error(`waveBase 必须是完整 SHA: ${waveBase}`);
  const wave = plan.waves?.[waveIndex];
  if (!Array.isArray(wave) || wave.length === 0) throw new Error(`plan 无 wave[${waveIndex}]`);

  const allocations = [];
  for (const groupId of wave) {
    const group = plan.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`plan.waves 引用未知组 ${groupId}`);
    for (const p of group.paths ?? []) {
      const r = normalizeRepoPath(p);
      if (!r.ok) throw new Error(`组 ${groupId} 路径非法 ${p}: ${r.reason}`);
    }
    const branch = groupBranch(runId, groupId);
    if (!BRANCH_RE.test(branch)) throw new Error(`分支名非法: ${branch}`);
    const wtPath = groupWorktreePath(worktreeRoot, runId, groupId);
    let nonce = null;
    if (existsSync(wtPath)) {
      // 幂等复用: 必须是本 run 本组创建的（owner 印记，R5-P0），且分支已在 waveBase 之上
      const owner = readOwner({ worktreeDir: wtPath, exec });
      if (!owner || owner.run_id !== runId || owner.group_id !== groupId) {
        throw new Error(`worktree ${wtPath} 无本 run 本组的 owner 印记（他人/残骸占位，fail-closed 人工清理）`);
      }
      nonce = owner.nonce;
      let head = null;
      try { head = exec ? exec(['git', '-C', wtPath, 'rev-parse', 'HEAD']).trim() : git(wtPath, 'rev-parse', 'HEAD'); } catch { /* 损坏 */ }
      const ok = head && (head === waveBase || isAncestor({ repoDir, ancestor: waveBase, descendant: head, exec }));
      if (!ok) throw new Error(`worktree 残骸 ${wtPath} 不在本波 base 之上（fail-closed，人工清理后重跑）`);
    } else {
      g('worktree', 'add', '-q', '-b', branch, wtPath, waveBase);
      nonce = newNonce();
      stampOwner({ worktreeDir: wtPath, payload: { run_id: runId, group_id: groupId, nonce }, exec });
    }
    // D3: artifact/scManifest 已在函数入口强制校验非空，family_context 现在恰好覆盖全部路径
    // （不再有「没传就是 null」的静默退化通道）。分组结果本身不受影响（分组逻辑完全不改）。
    const family_context = familyContext({ artifact, manifest: scManifest, scIds: group.sc_ids });
    allocations.push({ group_id: groupId, sc_ids: group.sc_ids, anchor_paths: group.paths, write_paths: writePathsFor(group), branch, worktree: wtPath, base: waveBase, owner_nonce: nonce, family_context });
  }
  return { run_id: runId, wave_index: waveIndex, wave_base: waveBase, allocations, allocated_at: nowIso() };
}

export function isAncestor({ repoDir, ancestor, descendant, exec = null }) {
  try {
    if (exec) { exec(['git', '-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
    execFileSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

// 实改文件集（相对 base）——审 R1「actual write set 漂移」: anchor 是证据不是写集，必须按真实 diff 判
export function changedFiles({ repoDir, base, tip, exec = null }) {
  const out = exec
    ? exec(['git', '-C', repoDir, 'diff', '-z', '--name-only', `${base}..${tip}`])
    : git(repoDir, 'diff', '-z', '--name-only', `${base}..${tip}`);
  return String(out).split('\0').filter(Boolean);
}

// 集成一个波次: 逐组核验 tip 血统 → 两两比实改文件交集 → 无重叠才 merge
export function integrateWave({ repoDir, waveBase, groupTips, exec = null }) {
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  const report = { wave_base: waveBase, groups: [], overlaps: [], integrated_tip: null, ok: false };

  // ① 血统: 每组 tip 必须是 waveBase 的后代（防 lead 塞不相关 commit）
  for (const t of groupTips) {
    if (!/^[0-9a-f]{40}$/.test(String(t.tip))) { report.overlaps.push({ error: `组 ${t.group_id} tip 非完整 SHA` }); return report; }
    if (t.tip !== waveBase && !isAncestor({ repoDir, ancestor: waveBase, descendant: t.tip, exec })) {
      report.overlaps.push({ error: `组 ${t.group_id} 的 tip 不是本波 base 的后代（血统不符，fail-closed）` });
      return report;
    }
  }

  // ② 实改文件集 + 两两交集
  const sets = new Map();
  for (const t of groupTips) {
    const files = changedFiles({ repoDir, base: waveBase, tip: t.tip, exec });
    sets.set(t.group_id, files);
    report.groups.push({ group_id: t.group_id, tip: t.tip, changed: files });
  }
  const ids = [...sets.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = new Set(sets.get(ids[i]));
      const inter = sets.get(ids[j]).filter((f) => A.has(f));
      if (inter.length) report.overlaps.push({ a: ids[i], b: ids[j], files: inter });
    }
  }
  if (report.overlaps.length) return report; // fail-closed: 不 merge，调用方按 replan-serial 处理

  // ③ 逐组 merge（无重叠 → 文本冲突理论不该有；真有则 fail-closed 不留脏状态）
  g('checkout', '-q', '--detach', waveBase);
  for (const t of groupTips) {
    try {
      g('merge', '--no-edit', '-q', t.tip);
    } catch (e) {
      try { g('merge', '--abort'); } catch { /* 无进行中 merge */ }
      report.overlaps.push({ a: t.group_id, error: `merge 冲突（无文件重叠仍冲突，需人工）: ${e.message}` });
      return report;
    }
  }
  report.integrated_tip = exec ? exec(['git', '-C', repoDir, 'rev-parse', 'HEAD']).trim() : git(repoDir, 'rev-parse', 'HEAD');
  report.ok = true;
  return report;
}

// R6-P1: 分支是否正被任一 worktree 检出——update-ref 系操作会绕过 git 的检出保护，
// 删除/移动前必须显式查（branch -D 会拒，update-ref 不会）
export function branchCheckedOut({ repoDir, branch, exec = null }) {
  const out = exec ? exec(['git', '-C', repoDir, 'worktree', 'list', '--porcelain']) : git(repoDir, 'worktree', 'list', '--porcelain');
  return String(out).split('\n').includes(`branch refs/heads/${branch}`);
}

// R7/R8/R9: 分支 CAS 删除的**补偿事务**（group / serial / integration 共用同一实现，
// 避免路径漂移）。不变量: 一旦发起 destructive step（update-ref -d），后续任何异常都不得
// 在补偿尝试前逃逸——**包括删除命令自身抛错**（R9 实证: git 可能已原子落盘而父进程回执
// 丢失/被杀，把它当"删除未发生"就会留下已损坏的 racer worktree）与复查命令抛错
// （R8 实证: worktree list 一次 IO 失败即可让删除落地却不回滚不留痕）。
//   ① 预检查检出（含检查失败）→ fail-closed 不删
//   ② CAS 删除（old = 记录 tip；不匹配 git 自己拒）
//   ③ 删除**抛错** = 结果不确定 → 读 ref 实际状态后 reconcile（R9）:
//        ref 仍 == 记录 tip → 删除确实没发生，安全记 br-refused
//        ref 已消失 / 读不出来 → 尝试创建式 CAS 恢复
//        ref 变成第三方 tip → 绝不覆盖，记 br-restore-fail
//   ④ 删除成功后复查: 抛错 = 按不安全处理（与"确实被检出"同路径）
//   ⑤ 需补偿 → 创建式 CAS（old = 全零，不覆盖第三方同名新 ref）按记录 tip 精确恢复；
//      成功记 br-restored（消息带触发原因），失败记 br-restore-fail + 完整 expected tip + 各错误
function casDeleteBranch({ repoDir, branch, expectedTip, label, exec, g, steps, errors }) {
  const ref = `refs/heads/${branch}`;
  const readRef = () => {
    try { return exec ? exec(['git', '-C', repoDir, 'rev-parse', ref]).trim() : git(repoDir, 'rev-parse', ref); }
    catch { return null; } // ref 不存在 或 读取失败——两者都归入「不可证明仍在原位」
  };
  // 恢复: 仅当 ref 不存在时创建（old = 全零），因此永不覆盖第三方同名新 ref
  const restore = (why, extra = '') => {
    try {
      g('update-ref', ref, expectedTip, '0'.repeat(40));
      errors.push(`分支 ${branch} ${why}——已按记录 tip ${expectedTip} 恢复${extra}`);
      steps.push(`br-restored:${label}`);
    } catch (e) {
      errors.push(`分支 ${branch} ${why}且恢复失败，请人工恢复到 ${expectedTip}: 恢复错误=${e.message}${extra}`);
      steps.push(`br-restore-fail:${label}`);
    }
  };

  let checkedOut = null;
  try { checkedOut = branchCheckedOut({ repoDir, branch, exec }); }
  catch (e) {
    errors.push(`拒绝删除分支 ${branch}: 无法确认检出状态（${e.message}）——fail-closed 不做破坏性操作`);
    steps.push(`br-refused:${label}`);
    return;
  }
  if (checkedOut) {
    // R6-P1: update-ref -d 会绕过 git 的 checked-out 保护，把检出方打成「No commits yet」
    errors.push(`拒绝删除分支 ${branch}: 正被某个 worktree 检出（update-ref 会绕过 git 检出保护破坏其基线，fail-closed——R6-P1）`);
    steps.push(`br-refused:${label}`);
    return;
  }

  let delErr = null;
  try { g('update-ref', '-d', ref, expectedTip); }
  catch (e) { delErr = e; }

  if (delErr) {
    // R9-MUST-FIX: 删除报错 ≠ 删除未发生。按「结果不确定」reconcile，不得直接 return。
    const cur = readRef();
    if (cur === expectedTip) {
      errors.push(`分支 CAS 删除失败 ${branch}（ref 仍在记录 tip 原位，未产生破坏）: ${delErr.message}`);
      steps.push(`br-refused:${label}`);
    } else if (cur !== null) {
      errors.push(`分支 ${branch} 删除结果不确定，且 ref 现为 ${cur.slice(0, 12)} ≠ 记录 ${expectedTip}（第三方已抢占，绝不覆盖）: 删除错误=${delErr.message}`);
      steps.push(`br-restore-fail:${label}`);
    } else {
      restore(`删除命令报错但 ref 已不可证明在原位（结果不确定，R9）`, ` / 删除错误=${delErr.message}`);
    }
    return;
  }

  // —— 以下已是「删除确认落地」，必须走完补偿状态机 ——
  let raced = false, recheckErr = null;
  try { raced = branchCheckedOut({ repoDir, branch, exec }); }
  catch (e) { raced = true; recheckErr = e; } // 复查失败 → 不可证明安全 → 按不安全处理（R8-P1）
  if (!raced) { steps.push(`br-deleted:${label}`); return; }
  restore(
    recheckErr ? `删除后复查失败（${recheckErr.message}）——按不安全处理（R8-P1）` : '删除时被检出竞态（R7-P1 补偿回滚）',
    recheckErr ? ` / 复查错误=${recheckErr.message}` : ''
  );
}

// git 已登记的 worktree 路径集合（SC-1 归属校验的唯一可信来源）
export function registeredWorktrees({ repoDir, exec = null }) {
  const out = exec ? exec(['git', '-C', repoDir, 'worktree', 'list', '--porcelain']) : git(repoDir, 'worktree', 'list', '--porcelain');
  const paths = [];
  for (const line of String(out).split('\n')) {
    const m = line.match(/^worktree (.+)$/);
    if (m) { try { paths.push(realpathSync(m[1])); } catch { paths.push(m[1]); } }
  }
  return paths;
}

// 清理本 run 的全部 worktree/分支（终态或 replan 时调用）
// 归属模型（R5-P0 定版——「内容相等 ≠ 创建归属」，HEAD/血缘集合可被撞值）:
//   worktree: ① git 登记（realpath）② common-dir 归属本仓 ③ **owner 印记**——创建时写进
//   admin git-dir 的 {run_id, nonce} 必须与 manifest 记录完全一致（组/串行/integration 一律）；
//   分支目标叠加 ④ 检出分支 == 记录分支。integration 目标**只来自 manifest 的
//   integration_worktree 记录**（没有记录 = 本 run 从未创建 = 一个字都不碰，路径不做预测）。
//   分支删除: worktree 归属已证 → branch -D；否则必须有记录 tip，用
//   `git update-ref -d <ref> <expected>` 做 CAS 删除——无记录/不匹配一律拒。
// 任一不符 → 拒删且**连分支都不删**；remove 失败 → wt-fail 交人工，绝不 rmSync 兜底。
export function cleanupRun({ manifest, exec = null }) {
  const repoDir = manifest.repo_dir;
  const runId = manifest.run_id;
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  const steps = [];
  const errors = [];
  let registered = [];
  try { registered = registeredWorktrees({ repoDir, exec }); }
  catch (e) { return { steps, errors: [`无法读取 git worktree 列表（fail-closed 不删任何目录）: ${e.message}`] }; }
  let repoCommon = null;
  try {
    const out = exec ? exec(['git', '-C', repoDir, 'rev-parse', '--git-common-dir']).trim() : git(repoDir, 'rev-parse', '--git-common-dir');
    repoCommon = realpathSync(resolve(repoDir, out));
  } catch (e) { return { steps, errors: [`无法解析本仓 git common-dir（fail-closed）: ${e.message}`] }; }

  // 回收目标全部来自 manifest 记录。integration 只认创建记录（R5-P0: 不做路径预测）。
  const targets = [];
  let lastIntegrationTip = null;
  if (manifest.integration_worktree) {
    targets.push({ label: 'integration', worktree: manifest.integration_worktree.path, branch: null, nonce: manifest.integration_worktree.nonce ?? null });
  }
  for (const w of manifest.waves ?? []) {
    const tipOf = (gid) => (w.tips ?? []).find((x) => x.group_id === gid)?.tip ?? null;
    for (const a of w.allocations ?? []) targets.push({ label: a.group_id, worktree: a.worktree, branch: a.branch, nonce: a.owner_nonce ?? null, expectedTip: tipOf(a.group_id) });
    for (const r of w.replan?.rounds ?? []) targets.push({ label: `${r.group_id}-r${r.round}`, worktree: r.worktree, branch: r.branch, nonce: r.owner_nonce ?? null, expectedTip: r.tip ?? null });
    if (w.integrated_tip) lastIntegrationTip = w.integrated_tip;
  }

  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.worktree)) continue;
    seen.add(t.worktree);
    let owned = true;
    if (existsSync(t.worktree)) {
      let real = t.worktree;
      try { real = realpathSync(t.worktree); } catch { /* 保持原值 */ }
      if (!registered.includes(real)) {
        errors.push(`拒绝回收 ${t.worktree}: 不在本仓 git worktree 登记列表内（归属不符，fail-closed）`);
        steps.push(`wt-refused:${t.label}`);
        owned = false;
      }
      if (owned) {
        // 归属校验 ②: common-dir 必须是本仓
        try {
          const out = exec ? exec(['git', '-C', t.worktree, 'rev-parse', '--git-common-dir']).trim() : git(t.worktree, 'rev-parse', '--git-common-dir');
          const wtCommon = realpathSync(resolve(t.worktree, out));
          if (wtCommon !== repoCommon) {
            errors.push(`拒绝回收 ${t.worktree}: 归属其他仓（common-dir 不符，fail-closed）`);
            steps.push(`wt-refused:${t.label}`);
            owned = false;
          }
        } catch (e) {
          errors.push(`拒绝回收 ${t.worktree}: 无法确认归属（${e.message}）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned) {
        // 归属校验 ③（R5-P0 核心）: owner 印记必须与 manifest 记录一致——
        // 内容点（HEAD==base/squash）可撞值，创建 nonce 撞不了
        const o = readOwner({ worktreeDir: t.worktree, exec });
        if (!t.nonce || !o || o.run_id !== runId || o.nonce !== t.nonce) {
          errors.push(`拒绝回收 ${t.worktree}: owner 印记缺失/不匹配（记录=${t.nonce ? t.nonce.slice(0, 8) : '无'} 实际=${o?.nonce ? o.nonce.slice(0, 8) : '无'}——归属不符，fail-closed）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned && t.branch) {
        // 归属校验 ④: 检出分支必须就是 allocation 记录的分支
        let headRef = null;
        try { headRef = exec ? exec(['git', '-C', t.worktree, 'symbolic-ref', '--short', 'HEAD']).trim() : git(t.worktree, 'symbolic-ref', '--short', 'HEAD'); }
        catch { /* detached */ }
        if (headRef !== t.branch) {
          errors.push(`拒绝回收 ${t.worktree}: 检出分支 ${headRef ?? '(detached)'} ≠ allocation 记录 ${t.branch}（归属不符，fail-closed）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned) {
        try { g('worktree', 'remove', '--force', t.worktree); steps.push(`wt-removed:${t.label}`); }
        catch (e) {
          errors.push(`git worktree remove 失败（不做强删兜底，请人工检查 ${t.worktree}）: ${e.message}`);
          steps.push(`wt-fail:${t.label}`);
          owned = false;
        }
      }
    } else {
      steps.push(`wt-absent:${t.label}`);
      owned = false; // worktree 缺席 = 归属未证明，分支删除必须走 CAS
    }
    // 分支删除: 归属已证（owned）→ branch -D；否则只接受「记录 tip 完全一致」的 CAS 删除
    if (t.branch) {
      let brTip = null;
      try { brTip = exec ? exec(['git', '-C', repoDir, 'rev-parse', `refs/heads/${t.branch}`]).trim() : git(repoDir, 'rev-parse', `refs/heads/${t.branch}`); }
      catch { steps.push(`br-absent:${t.label}`); continue; }
      if (owned) {
        try { g('branch', '-D', t.branch); steps.push(`br-deleted:${t.label}`); } catch { steps.push(`br-absent:${t.label}`); }
      } else if (!existsSync(t.worktree)) {
        if (!t.expectedTip) {
          errors.push(`拒绝删除分支 ${t.branch}: 本 run 无记录 tip、worktree 又已缺席，归属无法确认（fail-closed 交人工）`);
          steps.push(`br-refused:${t.label}`);
        } else if (brTip !== t.expectedTip) {
          errors.push(`拒绝删除分支 ${t.branch}: tip ${brTip.slice(0, 12)} ≠ 记录 ${t.expectedTip.slice(0, 12)}（同名他人分支/被移动，fail-closed）`);
          steps.push(`br-refused:${t.label}`);
        } else {
          // 「未被检出」是外部条件，CAS 只保护 ref 的 old 值——统一走补偿事务 helper
          casDeleteBranch({ repoDir, branch: t.branch, expectedTip: t.expectedTip, label: t.label, exec, g, steps, errors });
        }
      }
      // owned=false 且 worktree 仍在（归属不符）→ 分支一个字都不碰
    }
  }
  if (manifest.integration_branch) {
    // integration 分支同样走 CAS: expected = 最后记录的 integrated_tip；无记录 → 拒
    let ibTip = null;
    try { ibTip = exec ? exec(['git', '-C', repoDir, 'rev-parse', `refs/heads/${manifest.integration_branch}`]).trim() : git(repoDir, 'rev-parse', `refs/heads/${manifest.integration_branch}`); }
    catch { steps.push('br-absent:integration'); ibTip = null; }
    if (ibTip !== null) {
      if (!lastIntegrationTip || ibTip !== lastIntegrationTip) {
        errors.push(`拒绝删除分支 ${manifest.integration_branch}: tip ${ibTip.slice(0, 12)} ≠ 记录的 integrated_tip ${lastIntegrationTip ? lastIntegrationTip.slice(0, 12) : '(无)'}（同名他人分支/无记录，fail-closed）`);
        steps.push('br-refused:integration');
      } else {
        // 与 group/serial 同一补偿事务实现（R8-P1: 消除两条路径漂移）
        casDeleteBranch({ repoDir, branch: manifest.integration_branch, expectedTip: lastIntegrationTip, label: 'integration', exec, g, steps, errors });
      }
    }
  }
  try { g('worktree', 'prune'); } catch { /* best-effort */ }
  return { steps, errors };
}

// SC-R3-11: 独立 CLI 入口已删除——fix-run.mjs 是唯一编排入口（本文件只做库函数）。
// 直接执行本文件 = 用法错误，指向状态机入口。
if (isMain(import.meta.url)) {
  fail('fix-orchestrate.mjs 不再提供 CLI（SC-R3-11: 单入口防绕过状态机）。请使用 scripts/fix-run.mjs <init|allocate|integrate|serial-allocate|serial-integrate|validate|finalize|cleanup>');
}
