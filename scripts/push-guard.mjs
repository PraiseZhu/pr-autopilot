#!/usr/bin/env node
// push 守卫 v3 — 计划依据: SP-3 / §0.3-F5 / W-4 / §1.3b R3·R6·R7·R8·R10
// 审③修复:
//   F3-R : remote/branch 走 lib/git-checks 共享校验（拒前导 -/+、check-ref-format、
//          remote URL 必须指向 manifest.repo——upstream 冒充 fork 被拦）
//   F4-R : artifact hash 含 base/candidate（consensus-gate 同步）；push 时必须带
//          review bundle，守卫重算 review_input_hash 并绑定 bundle↔artifact↔manifest 三方 SHA；
//          fast 的 base 由守卫自算 merge-base（manifest 无权自报），attestation 改
//          HMAC 签名（key 只存在于 owner 交互 shell 环境，自动会话拿不到）
//   F11-R: 进化规则集由 **diff 内容** 触发而非自报 purpose——changed files 落在
//          宪法黑名单/进化白名单领域时，purpose=feature 一样按进化红线拦；
//          ledger_ids 必须真实存在于台账文件；proposal_ledger 必须等于 constitution
//          固定路径；fixture 文件必须非空；JSON 白名单文件做深度单调校验（老内容
//          必须是新内容的子集），markdown 保持行保留校验并如实声明其局限
// S2 声明: 守卫是「可检测」而非「不可能」，服务端 ruleset 兜底。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { readJson, parseArgs, fail, hashObject, nowIso, isMain, canonicalJson } from './lib/common.mjs';
import { recomputeArtifactHash } from './consensus-gate.mjs';
import { computeReviewInputHash } from './review-input-hash.mjs';
import { validateRemoteBranch } from './lib/git-checks.mjs';
import { checkScCoverage } from './sc-coverage-gate.mjs';
import { buildFixPlan } from './fix-plan.mjs';
import { checkDispatch } from './fix-dispatch-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PURPOSES = ['feature', 'evolution', 'fast'];

export function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${esc}$`);
}
export function matchAny(path, globs) {
  return globs.some((g) => globToRe(g).test(path));
}

function git(repoDir, ...args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
}
const gitT = (repoDir, ...args) => git(repoDir, ...args).trim();

export function validateManifest(manifest) {
  const errs = [];
  for (const k of ['repo', 'remote', 'branch', 'expected_sha', 'purpose']) {
    if (!manifest[k]) errs.push(`push manifest 缺必填字段: ${k}`);
  }
  if (manifest.purpose && !PURPOSES.includes(manifest.purpose)) {
    errs.push(`purpose 非法: ${manifest.purpose}（必须 ${PURPOSES.join('/')}）`);
  }
  if (manifest.purpose === 'feature' || manifest.purpose === 'evolution') {
    if (!manifest.consensus_artifact_hash) errs.push(`purpose=${manifest.purpose} 必须携带 consensus_artifact_hash（F4）`);
    if (!manifest.sc_hash || !Array.isArray(manifest.sc_list) || manifest.sc_list.length === 0) {
      errs.push(`purpose=${manifest.purpose} 必须携带 sc_hash + 非空 sc_list`);
    }
    // v2 编排链（审 R1-P1-3 时序修正）: 修复编排产物必须与**源共识**（修复前那份）绑定，
    // 而 manifest.consensus_artifact_hash 指向 delta 复核后的**终版共识**——两份不同，必须分开带。
    // fix_orchestration 缺失 = 未走编排链（单 SC 或 fast 场景由下方条件豁免）。
    if (manifest.fix_orchestration) {
      const fo = manifest.fix_orchestration;
      for (const k of ['source_artifact_hash', 'sc_manifest_hash', 'fix_plan_hash', 'dispatch_record_hash']) {
        if (!fo[k]) errs.push(`fix_orchestration 缺 ${k}`);
      }
    }
  }
  if (manifest.purpose === 'evolution') {
    const ev = manifest.evolution ?? {};
    if (!Array.isArray(ev.ledger_ids) || ev.ledger_ids.length === 0) errs.push('R10: evolution manifest 必须引用台账条目 id（ledger_ids）');
    if (!ev.ledger_file) errs.push('R10: evolution manifest 必须提供 ledger_file（守卫要核对 id 真实存在）');
    if (!ev.proposal_ledger) errs.push('R8: evolution manifest 必须提供 proposal_ledger 路径');
  }
  if (manifest.purpose === 'fast') {
    const at = manifest.fast_attestation ?? {};
    if (!at.reason || !at.ledger_file || !at.signature || !at.expires_at) {
      errs.push('I6: purpose=fast 必须携带 fast_attestation{reason, ledger_file, signature, expires_at}（全字段 HMAC 签名 + 时效，审④-F2）');
    }
    if (!manifest.base_branch) errs.push('purpose=fast 必须提供 base_branch（守卫自算 merge-base，不信 manifest.base）');
  }
  return errs;
}

// F11-R: JSON 白名单文件深度单调 —— 旧值必须是新值的子集（只增不减不改）
export function jsonSubset(oldVal, newVal) {
  if (oldVal === null || typeof oldVal !== 'object') return JSON.stringify(oldVal) === JSON.stringify(newVal);
  if (Array.isArray(oldVal)) {
    if (!Array.isArray(newVal)) return false;
    return oldVal.every((o) => newVal.some((n) => JSON.stringify(n) === JSON.stringify(o) || jsonSubset(o, n)));
  }
  if (typeof newVal !== 'object' || newVal === null || Array.isArray(newVal)) return false;
  return Object.entries(oldVal).every(([k, v]) => k in newVal && jsonSubset(v, newVal[k]));
}

export function directionCheck(repoDir, baseSha, file) {
  let oldContent = '';
  try { oldContent = git(repoDir, 'show', `${baseSha}:${file}`); }
  catch { return { ok: true, reason: '新文件（纯新增 = 收紧）' }; }
  let newContent = '';
  try { newContent = git(repoDir, 'show', `HEAD:${file}`); }
  catch { return { ok: false, reason: '文件被删除（扩权特征）' }; }

  if (file.endsWith('.json')) {
    // JSON 深度单调（F11-R: 「保留旧行+追加相反键」在结构层被拦）
    try {
      const o = JSON.parse(oldContent), n = JSON.parse(newContent);
      if (!jsonSubset(o, n)) return { ok: false, reason: 'JSON 单调校验失败: 旧内容不再是新内容的子集（删/改/覆盖 = 扩权特征）' };
      return { ok: true, reason: 'JSON 单调追加' };
    } catch { return { ok: false, reason: 'JSON 解析失败（fail-closed）' }; }
  }
  // 非 JSON: 行保留校验。已知局限（如实声明）: 无法识别「追加语义相反的散文规则」，
  // 该风险由三审 + 上游审查兜底（提案 PR 与人写 PR 同权过审，R1）。
  const newLines = new Set(newContent.split('\n'));
  const removed = oldContent.split('\n').filter((l) => l.trim() !== '' && !newLines.has(l));
  if (removed.length) {
    return { ok: false, reason: `删除/改写既有行 ${removed.length} 处（扩权特征），首处: ${removed[0].slice(0, 80)}` };
  }
  return { ok: true, reason: '仅追加' };
}

export function weeklyProposalCount(proposalLedgerFile, nowMs) {
  if (!existsSync(proposalLedgerFile)) return 0;
  const cutoff = nowMs - 7 * 24 * 3600 * 1000;
  let n = 0;
  for (const line of readFileSync(proposalLedgerFile, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.kind === 'proposal' && Date.parse(rec.at) >= cutoff) n++;
  }
  return n;
}

// 审④-F2: 签 versioned canonical 全字段——改 remote/base_branch/reason/ledger_file
// 任一字段即签名失效；expires_at 入锅并强制未过期（重放窗口收窄）。
export function fastSignaturePayload(manifest) {
  const at = manifest.fast_attestation ?? {};
  return canonicalJson({
    v: 2, purpose: 'fast',
    repo: manifest.repo, remote: manifest.remote, base_branch: manifest.base_branch,
    branch: manifest.branch, expected_sha: manifest.expected_sha,
    reason: at.reason, ledger_file: at.ledger_file, expires_at: at.expires_at
  });
}
export function verifyFastAttestation(manifest, key, nowMs = Date.now()) {
  if (!key) return 'fast 签名 key 不可得（PR_AUTOPILOT_FAST_KEY 只应存在于 owner 交互 shell；自动会话/调度环境拿不到 = 正确的拒绝）';
  const at = manifest.fast_attestation;
  const exp = Date.parse(at.expires_at ?? '');
  if (!(exp > nowMs)) return 'fast attestation 已过期/时效非法（expires_at 必须是未来时刻）';
  const expect = createHmac('sha256', key).update(fastSignaturePayload(manifest)).digest('hex');
  if (at.signature !== expect) return 'fast 签名不匹配（任一受保护字段被改写即失效，owner 亲手签的才算数）';
  return null;
}

export function checkPushGuard({ repoDir, manifest, artifact, bundle, constitution, sourceArtifact = null, scManifest = null, fixPlan = null, dispatchRecord = null, nowMs = Date.now(), fastKey = process.env.PR_AUTOPILOT_FAST_KEY }) {
  const errors = [];

  const schemaErrs = validateManifest(manifest);
  if (schemaErrs.length) return { ok: false, errors: schemaErrs, changed: [], head: null, pushArgv: null };

  // ---- F3-R: remote/branch 共享校验（含 URL↔repo 绑定） ----
  errors.push(...validateRemoteBranch({ repoDir, remote: manifest.remote, branch: manifest.branch, repoFullName: manifest.repo }));

  // ---- ① SHA 绑定 + clean ----
  const head = gitT(repoDir, 'rev-parse', 'HEAD');
  if (head !== manifest.expected_sha) {
    errors.push(`SHA 漂移: HEAD=${head.slice(0, 12)} ≠ expected=${String(manifest.expected_sha).slice(0, 12)}（⑩）`);
  }
  // 审④-F1: 审 HEAD 推 branch-ref 的分叉被拦——branch ref 必须就是被审的 commit，
  // 且 refspec 源钉死为 expected_sha（推的永远是被批准的那个对象）
  try {
    const branchSha = gitT(repoDir, 'rev-parse', `refs/heads/${manifest.branch}`);
    if (branchSha !== manifest.expected_sha) {
      errors.push(`branch ref 分叉: refs/heads/${manifest.branch}=${branchSha.slice(0, 12)} ≠ expected=${String(manifest.expected_sha).slice(0, 12)}（审 A 推 B 被拦，审④-F1）`);
    }
  } catch { errors.push(`refs/heads/${manifest.branch} 不存在（fail-closed）`); }
  const status = gitT(repoDir, 'status', '--porcelain');
  if (status !== '') errors.push(`工作区不 clean:\n${status}`);

  // ---- ④ 共识工件三方绑定（F4-R: bundle 必到场重算） ----
  let baseSha = null;
  if (manifest.purpose === 'feature' || manifest.purpose === 'evolution') {
    if (!artifact) errors.push('必须提供 consensus artifact（fail-closed）');
    if (!bundle) errors.push('必须提供 review bundle（守卫要重算 review_input_hash，F4-R）');
    if (artifact && bundle) {
      for (const k of ['review_input_hash', 'base_sha', 'candidate_sha', 'canonical_findings', 'verdict_hashes', 'consensus_artifact_hash', 'gate_result']) {
        if (!(k in artifact)) errors.push(`consensus artifact 缺字段 ${k}`);
      }
      if (!errors.length) {
        if (artifact.gate_result !== 'pass') errors.push('consensus artifact gate_result ≠ pass');
        if (recomputeArtifactHash(artifact) !== artifact.consensus_artifact_hash) errors.push('consensus artifact hash 与内容重算值不符（含 base/candidate，伪造/改 SHA 均失效）');
        if (manifest.consensus_artifact_hash !== artifact.consensus_artifact_hash) errors.push('manifest 与 artifact 的 consensus_artifact_hash 不一致');
        // bundle 三方绑定
        let rih = null;
        try { rih = computeReviewInputHash(bundle); } catch (e) { errors.push(`bundle 重算失败（fail-closed）: ${e.message}`); }
        if (rih && rih !== artifact.review_input_hash) errors.push('bundle 重算的 review_input_hash ≠ artifact 记录值（bundle 被换）');
        if (bundle.base_sha !== artifact.base_sha) errors.push('bundle.base_sha ≠ artifact.base_sha');
        if (bundle.candidate_sha !== artifact.candidate_sha) errors.push('bundle.candidate_sha ≠ artifact.candidate_sha');
        if (artifact.candidate_sha !== manifest.expected_sha) errors.push('artifact.candidate_sha ≠ manifest.expected_sha（共识批的不是这个 commit）');
        baseSha = artifact.base_sha;
      }
    }
    if (manifest.sc_hash && manifest.sc_list && hashObject(manifest.sc_list) !== manifest.sc_hash) {
      errors.push('SC 清单 hash 与 sc_hash 不一致');
    }
    // ---- v2 修复编排链核验（审 R1-P1-3: 重算等价，非自报字符串比对） ----
    // 需要在场: sourceArtifact（修复前源共识）+ scManifest + fixPlan + dispatchRecord。
    // 缺任一 → 该项无法核验 → fail-closed（有 fix_orchestration 声明就必须能验）。
    if (manifest.fix_orchestration && !errors.length) {
      const fo = manifest.fix_orchestration;
      const missing = [];
      if (!sourceArtifact) missing.push('source consensus artifact');
      if (!scManifest) missing.push('sc manifest');
      if (!fixPlan) missing.push('fix plan');
      if (!dispatchRecord) missing.push('dispatch record');
      if (missing.length) {
        errors.push(`fix_orchestration 在场但缺件无法核验: ${missing.join(' / ')}（fail-closed）`);
      } else {
        // ① 源 artifact 自洽 + 与声明一致
        const srcReal = recomputeArtifactHash(sourceArtifact);
        if (srcReal !== sourceArtifact.consensus_artifact_hash) errors.push('源 consensus artifact hash 与内容重算不符');
        if (fo.source_artifact_hash !== srcReal) errors.push('fix_orchestration.source_artifact_hash ≠ 源 artifact 重算值');
        // 源 artifact 必须是同一次评审（同 review_input_hash 谱系）且 candidate 是修复前的
        if (sourceArtifact.review_input_hash && artifact.review_input_hash &&
            sourceArtifact.base_sha !== artifact.base_sha) {
          errors.push('源 artifact 与终版 artifact 的 base_sha 不同（跨评审拼接）');
        }
        // ② SC 覆盖门（绑源 artifact）——修 R1 既有洞: SC 必须真绑回 finding 且全覆盖
        const covErrs = checkScCoverage({ manifest: scManifest, artifact: sourceArtifact });
        for (const e of covErrs) errors.push(`SC 覆盖门: ${e}`);
        if (hashObject(scManifest) !== fo.sc_manifest_hash) errors.push('fix_orchestration.sc_manifest_hash ≠ sc manifest 重算值');
        // ③ fix plan 重算等价（纯函数——lead 改分组即 hash 对不上）
        const rebuilt = buildFixPlan({ artifact: sourceArtifact, manifest: scManifest, capacity: fixPlan.capacity ?? 8 });
        if (rebuilt.degraded) {
          errors.push(`fix plan 从源 artifact 重算为 degraded（不该产出可派工 plan）: ${rebuilt.reasons[0]}`);
        } else {
          if (rebuilt.plan.fix_plan_hash !== fixPlan.fix_plan_hash) {
            errors.push('fix plan 与源 artifact+SC 重算结果不一致（分组被 lead 改动，fail-closed）');
          }
          if (fo.fix_plan_hash !== rebuilt.plan.fix_plan_hash) errors.push('fix_orchestration.fix_plan_hash ≠ 重算 plan hash');
        }
        // ④ 派发门（T1）: 计划要求的并行组必须都有独立 worker 派发记录
        const dErrs = checkDispatch({ plan: fixPlan, record: dispatchRecord });
        for (const e of dErrs) errors.push(`派发门: ${e}`);
        if (hashObject(dispatchRecord) !== fo.dispatch_record_hash) errors.push('fix_orchestration.dispatch_record_hash ≠ dispatch record 重算值');
      }
    }
  } else if (manifest.purpose === 'fast') {
    // F4-R: base 由守卫自算 merge-base，manifest 无权自报
    const sigErr = verifyFastAttestation(manifest, fastKey, nowMs);
    if (sigErr) errors.push(`I6: ${sigErr}`);
    // 审④-F2 + 审⑤-I2: fast ledger 路径由 constitution 固定（改审计去向被拦）；
    // constitution 缺该字段 = 配置残缺，fail-closed 而非静默跳过固定校验
    if (!constitution.fast_ledger_path) {
      errors.push('I6: constitution 缺 fast_ledger_path（fast 留痕去向未钉死，fail-closed）');
    } else if (resolve(manifest.fast_attestation.ledger_file) !== resolve(constitution.fast_ledger_path)) {
      errors.push(`I6: fast ledger 必须是 constitution 固定路径 ${constitution.fast_ledger_path}`);
    }
    try {
      baseSha = gitT(repoDir, 'merge-base', `refs/remotes/${manifest.remote}/${manifest.base_branch}`, 'HEAD');
    } catch {
      errors.push(`fast base 计算失败: refs/remotes/${manifest.remote}/${manifest.base_branch} 不存在（先 fetch，fail-closed）`);
    }
  }

  // ---- ② diff 路径检查（git diff -z） ----
  let changed = [];
  if (baseSha) {
    try {
      changed = git(repoDir, 'diff', '-z', '--name-only', `${baseSha}...HEAD`).split('\0').filter(Boolean);
    } catch (e) { errors.push(`无法计算 diff（fail-closed）: ${e.message}`); }
  } else if (!errors.length) {
    errors.push('base SHA 不可得（fail-closed）');
  }

  const fastOwnerSigned = manifest.purpose === 'fast' && !errors.some((e) => e.startsWith('I6:'));
  // F11-R: 进化规则集由 diff 内容触发，不由自报 purpose 决定
  const touchesEvolutionDomain = changed.some((f) => matchAny(f, constitution.whitelist) || matchAny(f, constitution.blacklist));
  const evolutionRules = manifest.purpose === 'evolution' || (touchesEvolutionDomain && !fastOwnerSigned);
  if (touchesEvolutionDomain && manifest.purpose === 'feature') {
    errors.push('diff 落在进化领域（宪法黑名单/进化白名单路径）但 purpose=feature——降级伪装被拦（F11-R）；走 evolution manifest 或 owner fast 签名');
  }

  for (const f of changed) {
    if (matchAny(f, constitution.ci_paths)) errors.push(`diff 落在 CI 路径（R6/硬停线，任何 purpose 不豁免）: ${f}`);
    if (evolutionRules && matchAny(f, constitution.blacklist)) errors.push(`diff 落在宪法层黑名单（R3/R4/R5，仅 owner 亲手可改）: ${f}`);
    if (manifest.purpose === 'evolution' && !matchAny(f, constitution.whitelist) && !matchAny(f, constitution.blacklist)) {
      errors.push(`自进化 diff 超出进化白名单（R7）: ${f}`);
    }
  }

  // ---- F11-R: evolution 附加机器红线 ----
  if (manifest.purpose === 'evolution' && baseSha) {
    for (const f of changed) {
      if (matchAny(f, constitution.whitelist)) {
        const d = directionCheck(repoDir, baseSha, f);
        if (!d.ok) errors.push(`方向 diff 拒绝 ${f}: ${d.reason}`);
      }
    }
    // R10: fixture 非空 + worktree + ledger id 真实存在
    // 审④-I1: 只认 fixtures/ 根下的文件——文件名带 fixture 字样的伪装不算
    const fixtureFiles = changed.filter((f) => f.startsWith('fixtures/'));
    if (!fixtureFiles.length) errors.push('R10: 缺误报回归 fixture（必须位于 fixtures/ 根目录下）');
    for (const f of fixtureFiles) {
      try {
        const content = git(repoDir, 'show', `HEAD:${f}`);
        if (content.trim().length < 10) errors.push(`R10: fixture ${f} 为空/无实质内容（占位文件不算）`);
      } catch { errors.push(`R10: fixture ${f} 读取失败（fail-closed）`); }
    }
    try {
      if (gitT(repoDir, 'rev-parse', '--git-dir') === gitT(repoDir, 'rev-parse', '--git-common-dir')) {
        errors.push('R10: 自进化必须在专用 worktree 执行（当前是主 checkout）');
      }
    } catch { errors.push('R10: worktree 检测失败（fail-closed）'); }
    const ev = manifest.evolution;
    // ledger_ids 真实性
    if (ev.ledger_file) {
      const existing = new Set();
      if (existsSync(ev.ledger_file)) {
        for (const line of readFileSync(ev.ledger_file, 'utf8').split('\n').filter(Boolean)) existing.add(JSON.parse(line).id);
      }
      for (const id of ev.ledger_ids) {
        if (!existing.has(id)) errors.push(`R10: 台账条目 ${id} 在 ${ev.ledger_file} 中不存在（伪造引用被拦）`);
      }
    }
    // proposal_ledger 固定路径（constitution 配置，防换成空文件绕 R8）
    if (constitution.proposal_ledger_path && resolve(ev.proposal_ledger) !== resolve(constitution.proposal_ledger_path)) {
      errors.push(`R8: proposal_ledger 必须是 constitution 固定路径 ${constitution.proposal_ledger_path}（自带空账本绕限流被拦）`);
    }
    // e2e-pushguard 洞B: escape ledger 源同样固定——manifest 自带 ledger_file 伪造 id 被拦
    if (constitution.escape_ledger_path && resolve(ev.ledger_file) !== resolve(constitution.escape_ledger_path)) {
      errors.push(`R10: ledger_file 必须是 constitution 固定台账源 ${constitution.escape_ledger_path}（自带伪造台账被拦）`);
    }
    if (weeklyProposalCount(ev.proposal_ledger, nowMs) >= 3) errors.push('R8: 本周提案已达 3 个，拒绝再提');
  }

  // ---- I6: fast ledger 由守卫自写 ----
  // e2e-pushguard 洞A: 审计黑洞化被拦——ledger 路径拒 symlink/设备文件，写后读回验证真实落盘
  if (manifest.purpose === 'fast' && errors.length === 0) {
    const at = manifest.fast_attestation;
    mkdirSync(dirname(at.ledger_file), { recursive: true });
    try {
      const st = lstatSync(at.ledger_file, { throwIfNoEntry: false });
      if (st && !st.isFile()) {
        errors.push(`I6: fast ledger 路径不是普通文件（symlink/设备文件审计黑洞被拦）: ${at.ledger_file}`);
      }
    } catch { errors.push('I6: fast ledger 路径状态读取失败（fail-closed）'); }
    if (errors.length === 0) {
      const entry = JSON.stringify({
        at: nowIso(), kind: 'fast-bypass', repo: manifest.repo, branch: manifest.branch,
        expected_sha: manifest.expected_sha, reason: at.reason
      });
      appendFileSync(at.ledger_file, entry + '\n');
      const written = readFileSync(at.ledger_file, 'utf8');
      if (!written.includes(entry)) errors.push('I6: fast ledger 写后读回失败——审计未真实落盘（fail-closed）');
    }
  }

  // 审④-F1: refspec 源 = 被批准的 expected_sha 对象本身（不是易变的 branch ref）
  const pushArgv = errors.length === 0
    ? ['git', '-C', repoDir, 'push', manifest.remote, `${manifest.expected_sha}:refs/heads/${manifest.branch}`]
    : null;
  return { ok: errors.length === 0, errors, changed, head, pushArgv };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args['repo-dir']) {
    fail('用法: push-guard.mjs --repo-dir <dir> --manifest <m.json> [--artifact <a.json>] [--bundle <b.json>]\n      [--source-artifact <src.json> --sc-manifest <sc.json> --fix-plan <plan.json> --dispatch-record <rec.json>]\n      [--execute]\n（编排四件套在 manifest.fix_orchestration 在场时必填；宪法路径表固定随仓，不接受 override——审④-F3）');
  }
  const res = checkPushGuard({
    repoDir: args['repo-dir'],
    manifest: readJson(args.manifest),
    artifact: args.artifact ? readJson(args.artifact) : null,
    bundle: args.bundle ? readJson(args.bundle) : null,
    // v2 编排链四件套（缺件时 checkPushGuard 对声明了 fix_orchestration 的 manifest fail-closed）
    sourceArtifact: args['source-artifact'] ? readJson(args['source-artifact']) : null,
    scManifest: args['sc-manifest'] ? readJson(args['sc-manifest']) : null,
    fixPlan: args['fix-plan'] ? readJson(args['fix-plan']) : null,
    dispatchRecord: args['dispatch-record'] ? readJson(args['dispatch-record']) : null,
    constitution: readJson(join(HERE, 'evolution/constitution-paths.json')) // 固定路径，CLI 无 override（审④-F3）
  });
  if (!res.ok) {
    for (const e of res.errors) process.stderr.write(`[PUSH-GUARD] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS head=${res.head.slice(0, 12)} files=${res.changed.length}\n`);
  if (args.execute) execFileSync(res.pushArgv[0], res.pushArgv.slice(1), { stdio: 'inherit' });
}
