#!/usr/bin/env node
// 共识门 — 计划依据: SP-2 / §1.1b ⑥⑨⑩
// 审②修复（F1/F2/F4）:
//   - conjunct② 收紧: **每一份 verdict 里的每一条 finding** 必须 status=closed 且出现在
//     该 reviewer 自己的 closed_finding_ids —— 聚类只用于报告与去重展示，
//     不再决定"谁负责关"（堵 F2: 一席先关吞掉另一席仍 open 的同簇 finding）
//   - 必须提供 review bundle: 共识脚本用 bundle 重算 review_input_hash，
//     三份 verdict 的 hash 必须等于重算值（不信 opaque 字符串）
//   - verdict 校验走 role-aware 跨字段规则（verdict-validate F1 修复版）
//   - consensus artifact 增记 base_sha / candidate_sha，供 push-guard 绑定（F4）
// 放行四 conjunct（缺一不可）:
//   ① 三 verdict 同 review_input_hash 且 == bundle 重算值
//   ② 每条 finding 由其所属 reviewer 本人 close（全量，无例外）
//   ③ 三 verdict 均 APPROVED
//   ④ 全部 gate_checks ∈ {pass, n_a}（脚本断言，不信模型总 verdict）
import { hashObject, sha256, canonicalJson, readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from './lib/common.mjs';
import { validateVerdict, changedPathSet, trackedPathSet } from './verdict-validate.mjs';
import { computeReviewInputHash } from './review-input-hash.mjs';

const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];
const SEVERITY_RANK = { suggestion: 1, major: 2, blocker: 3 }; // SC-5: canonical 取最高

// D1（owner 2026-08-02 fable 拍板，gpt 终审阻断修复）: family_key 是跨 reviewer/跨 candidate 的
// 内容派生身份——`family_id` 只是「同 verdict 内」的本地归组标签（SKILL.md 正式定义），两个不同
// reviewer 完全可能各自合法地把同一个标签（如 "F1"）用来指不同的不变量；下游若直接按 family_id
// 字符串分组，会把互不相关的 finding 错误合并（gpt 实测复现: SC-A「状态单一 writer」与 SC-B
// 「删除须 reconciliation」因两席各自的 F1 恰好撞了标签字符串，被合成一族，PR body 只显示了
// 第一个 invariant）。family_key 从 invariant 文本本身派生：同（归一化后）文本 → 同 key，
// 不同文本 → （密码学意义上）不同 key，天然免疫「标签撞车」，也天然支持反过来的「同一 invariant
// 用了不同 family_id 标签」被正确合并。'fk1-' 是算法版本前缀——未来若换归一化规则，旧 key 与新
// key 不再相等，不会被误认成兼容（对齐 hardening-checklist 第 7 类「改契约要同步改」的教训）。
export function normalizeInvariantForKey(invariant) {
  return String(invariant).trim().toLowerCase().replace(/\s+/g, '');
}
export function familyKeyOf(invariant) {
  if (typeof invariant !== 'string' || !invariant) return null;
  return `fk1-${sha256(normalizeInvariantForKey(invariant))}`;
}

// 聚类 key（仅用于去重展示，不参与放行判定）:
// face + 去行号规整 anchor + 语义指纹。同 key 的多席条目并入一簇，
// 全部 origins 保留（审②-F2: 不做先到先得）。
export function canonicalFindingKey(finding) {
  const anchor = String(finding.anchor)
    .toLowerCase()
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const semantic = sha256(
    String(finding.evidence).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  ).slice(0, 16);
  return `${finding.primary_face}|${anchor}|${semantic}`;
}

export function runConsensusGate(verdicts, opts = {}) {
  // issue #9 SC-B5: opts.parentArtifactHash 是已废弃参数，不再被任何代码读取。调用方若仍
  // 传它（哪怕值是 undefined——用 hasOwnProperty 而非真值判断，防漏报），说明调用方代码
  // 没跟上新契约，这是**编程错误**，不是 verdict 数据不合规——不得混进 failReasons（那会让
  // 调用方误以为是 verdict 有问题去排错，而迁移期恰恰需要它响得刺耳），必须直接 throw。
  // 根因（sc-final.md 审查发现）: 若只静默忽略废弃键，round=1 却想绑定 parent 的调用会被
  // 误判成「无谱系的根」而 PASS——round=1 分支只看 `parentArtifact` 是否为真，不认识旧键。
  if (Object.prototype.hasOwnProperty.call(opts, 'parentArtifactHash')) {
    throw new Error(
      'runConsensusGate: opts.parentArtifactHash 已废弃且不再被识别（issue #9 SC-B）——' +
      '请改传 opts.parentArtifact，值必须是完整的 parent consensus artifact 对象本身' +
      '（不是 consensus_artifact_hash 的 hash 字符串）。静默忽略旧键会让「round=1 却带 ' +
      'parent」这类应被拒的输入错误地被当作「无谱系的根」放行（SC-B5）。'
    );
  }
  const bundle = opts.bundle ?? null;
  // issue #9 SC-B: parent 绑定改为读取**完整 parent artifact 对象**（opts.parentArtifact），
  // 不再接受 opaque 的 parentArtifactHash 字符串——校验逻辑见下方 round/parent 处理块。
  // R4-P1: changed-set 校验必须在**共识入口**生效，不能只活在 validator CLI——
  // 否则 tracked-but-unchanged 的 hub 路径能穿过 live 路径污染冲突图。
  // repoDir 在场时脚本自算实改集；调用方也可直接注入 changedPaths（fixture 用）。
  let changedPaths = opts.changedPaths ?? null;
  // D3 接线修复（2026-08-06）: tracked 集此前**只在 verdict-validate 的 CLI** 里被构造，
  // `runConsensusGate` 从不传——即 live 共识路径没有 tracked 门。`anchor_paths` 侥幸无恙
  // （实改集检查天然吞掉 tracked：实改文件必在 base∪candidate 的 tracked 集内），但 D3 新增的
  // `out_of_scope_notes[].ref_paths` **只有** tracked 这一道检查，于是在 live 路径上一道都没有。
  // fixture 靠注入 trackedPaths 断言通过 = 单元层锁住了、接线层没接上（本仓台账里的既有教训形态）。
  // 现与 changedPaths 对称构造，同样 fail-closed。
  let trackedPaths = opts.trackedPaths ?? null;
  const failReasons = [];
  if (!changedPaths && opts.repoDir && bundle) {
    try { changedPaths = changedPathSet({ repoDir: opts.repoDir, baseSha: bundle.base_sha, candidateSha: bundle.candidate_sha }); }
    catch (e) { failReasons.push(`无法计算 base..candidate 实改集（fail-closed）: ${e.message}`); }
  }
  if (!trackedPaths && opts.repoDir && bundle) {
    try { trackedPaths = trackedPathSet({ repoDir: opts.repoDir, baseSha: bundle.base_sha, candidateSha: bundle.candidate_sha }); }
    catch (e) { failReasons.push(`无法计算 base∪candidate 的 tracked 集（fail-closed）: ${e.message}`); }
  }
  // R5-P1: 函数契约本身 fail-closed——changedPaths 与 repoDir 双缺 = 调用方漏传（T1 要拦的
  // 正是这种疏忽），不允许产出 pass artifact。不设旁路 flag。
  if (!changedPaths) {
    failReasons.push('缺 base..candidate 实改集（changedPaths / repoDir 二者必居其一）——anchor 污染门不允许 fail-open（R5-P1）');
  }

  if (!bundle) failReasons.push('缺 review bundle（共识脚本必须重算 input hash，不信 opaque 值）');
  if (verdicts.length !== 3) failReasons.push(`需要恰好 3 份 verdict，得到 ${verdicts.length}`);

  for (const v of verdicts) {
    const errs = validateVerdict(v, { bundle, changedPaths, trackedPaths, requirements: opts.requirements });
    if (errs.length) failReasons.push(`verdict(${v?.reviewer ?? '?'}) schema/跨字段校验失败 → degraded: ${errs[0]}`);
    else if (v.run_status !== 'ok') failReasons.push(`verdict(${v.reviewer}) run_status=degraded ≠ APPROVED（⑦ fail-closed）`);
  }

  const seen = new Set(verdicts.map((v) => v?.reviewer));
  for (const r of REVIEWERS) {
    if (!seen.has(r)) failReasons.push(`缺少三席之一: ${r}`);
  }
  if (failReasons.length) return { gate_result: 'fail', fail_reasons: failReasons };

  // issue #9 SC-B: round 重定义为「PASS consensus artifact 的序号」，不是审查尝试次数。
  // 三席 round 必须完全一致——替代此前 D8-3「三席不一致时按最大值要求 parent」的静默取 max：
  // 不一致本身就是应当被拒的输入错误，不该被悄悄纠正成「按最严的那个走」。
  // 位置放在上面那道 schema 早返回**之后**：到此每份 verdict 已过 validateVerdict 的
  // `Number.isInteger(v.round) && v.round >= 1`，可以直接按整数比较。
  const roundSet = new Set(verdicts.map((v) => v.round));
  let round = null;
  if (roundSet.size !== 1) {
    failReasons.push(`三席 round 不一致: ${[...roundSet].sort((a, b) => a - b).join('/')}（SC-B: round 必须完全一致，不再静默取最大值）`);
  } else {
    round = [...roundSet][0];
  }

  // SC-B4（lead 补充方案）: round 收成「PASS 序号」后，「这是第几次审查尝试」这条信息从
  // round 里消失了，改由新字段 attempt 承载——三席必须一致（跨席才校验得到；单份 verdict 的
  // 形状校验属 verdict-validate.mjs 的职责，不在本函数内做）。
  const attemptSet = new Set(verdicts.map((v) => v.attempt));
  if (attemptSet.size !== 1) {
    failReasons.push(`三席 attempt 不一致: ${[...attemptSet].map((a) => JSON.stringify(a)).join('/')}（SC-B4: attempt 必须完全一致）`);
  }

  // SC-B: round=1 必须无 parent（首个可 PASS 的共识永远是谱系根，收紧 F9 的反方向缺口：
  // 此前「round 1 带 parent」不拦）；round>=2 必须携带**完整可信**的 parent——不再只信任
  // opaque 的 consensus_artifact_hash 字符串（此前 CLI 只取该字符串一个字段，parent 的
  // gate_result / round 全无验证，伪造或过期的 parent 一样能绑进谱系）。
  let parentArtifactHash = null;
  const parentArtifact = opts.parentArtifact ?? null;
  if (round === 1) {
    if (parentArtifact) {
      failReasons.push('round=1 不得携带 parent（首个可 PASS 的共识必须是无谱系的根，SC-B）');
    }
  } else if (round !== null) {
    // roundSet.size===1 且 round!==1 时，round 必然 >=2（validateVerdict 已保证 >=1）。
    if (!parentArtifact) {
      failReasons.push(`delta 轮（round=${round}）未绑定上一轮 artifact：缺 --parent / parentArtifact——SC-B 谱系门不允许 fail-open`);
    } else {
      // issue #9 R2 blocker: parent 结构门先于 hash 自洽——parent.schema_version 被改成 v1
      // 后一样能按当前公式重算出自洽 hash（hash 自洽挡不住"篡改后照公式重算"这类确定性
      // 攻击），唯一能拦的是独立于 hash 结果的显式结构校验（SC-R2-3）。
      const parentShapeErrs = assertArtifactShape(parentArtifact, 'parent artifact');
      if (parentShapeErrs.length) {
        for (const e of parentShapeErrs) failReasons.push(e);
      } else {
        const parentReal = recomputeArtifactHash(parentArtifact);
        if (parentArtifact.consensus_artifact_hash !== parentReal) {
          failReasons.push('parent artifact 自身 hash 与内容重算不符（parent 被伪造/篡改，SC-B fail-closed）');
        } else if (parentArtifact.gate_result !== 'pass') {
          failReasons.push(`parent artifact gate_result=${parentArtifact.gate_result} ≠ pass（只有 PASS 共识才能作 parent，SC-B）`);
        } else if (parentArtifact.round !== round - 1) {
          failReasons.push(`parent artifact round=${parentArtifact.round} ≠ 当前 round-1=${round - 1}（父 round 跳号被拦，SC-B）`);
        } else {
          parentArtifactHash = parentArtifact.consensus_artifact_hash;
        }
      }
    }
  }

  // conjunct ①: 同 hash 且等于 bundle 重算值
  let recomputed = null;
  try {
    recomputed = computeReviewInputHash(bundle);
  } catch (e) {
    failReasons.push(`bundle 无法重算 input hash（fail-closed）: ${e.message}`);
  }
  const hashes = new Set(verdicts.map((v) => v.review_input_hash));
  if (hashes.size !== 1) {
    failReasons.push(`conjunct① 失败: review_input_hash 不一致（${[...hashes].map((h) => h.slice(0, 12)).join(' / ')}）`);
  } else if (recomputed && [...hashes][0] !== recomputed) {
    failReasons.push(`conjunct① 失败: verdict 携带的 hash 与 bundle 重算值不符（携带=${[...hashes][0].slice(0, 12)} 重算=${recomputed.slice(0, 12)}）`);
  }
  // SHA 一致性: 三份 verdict 的 base/candidate 必须一致且与 bundle 相同
  for (const field of ['base_sha', 'candidate_sha']) {
    const vals = new Set(verdicts.map((v) => v[field]));
    if (vals.size !== 1) failReasons.push(`三份 verdict 的 ${field} 不一致`);
    else if (bundle && bundle[field] && [...vals][0] !== bundle[field]) {
      failReasons.push(`verdict 的 ${field} 与 bundle 不一致`);
    }
  }

  // conjunct ②（收紧版）: 全量 finding 逐条由本人 close
  for (const v of verdicts) {
    for (const fd of v.findings) {
      const closed = fd.status === 'closed' && v.closed_finding_ids.includes(fd.id);
      if (!closed) failReasons.push(`conjunct② 失败: ${v.reviewer} 的 finding ${fd.id} 未被本人 close（他席关闭不算，lead 代关不算）`);
    }
  }

  // conjunct ③
  for (const v of verdicts) {
    if (v.verdict !== 'APPROVED') failReasons.push(`conjunct③ 失败: ${v.reviewer} verdict=${v.verdict}`);
  }

  // conjunct ④
  for (const v of verdicts) {
    for (const g of v.gate_checks) {
      if (!['pass', 'n_a'].includes(g.result)) {
        failReasons.push(`conjunct④ 失败: ${v.reviewer} gate_check ${g.gate_id}=${g.result}`);
      }
    }
  }

  if (failReasons.length) return { gate_result: 'fail', fail_reasons: failReasons };

  // 聚类（展示层）: 全 origins 保留
  const union = new Map();
  for (const v of verdicts) {
    for (const fd of v.findings) {
      const key = canonicalFindingKey(fd);
      if (!union.has(key)) {
        union.set(key, {
          canonical_key: key,
          id: sha256(key).slice(0, 12), // v2: 稳定 canonical finding id，供 SC manifest 引用
          origins: [],
          primary_face: fd.primary_face,
          severity: fd.severity,
          anchor: fd.anchor,
          anchor_paths: [], // v2: 各 origin 并集，随 artifact hash——下游换路径即断裂
          // SC-B1（D1）: invariant 冻结自**首个**（按 verdicts 到达顺序）提供该字段的
          // origin——与 anchor/primary_face 同一处理方式（只有 severity 特殊取最高，见下方）。
          // 归属本就发生在 origin 席自己的 verdict 里（同 verdict 内 family_id 已由
          // verdict-validate 强制自洽），这里只做「冻结第一手」，不做跨 origin 的语义合并/裁决。
          // suggestion 级 finding 不强制该字段——不带就不带，不写 null（schema 类型是 string）。
          // D1: family_key 从冻结后的 invariant 派生——跨 reviewer/跨 candidate 的真实身份，
          // 下游分组/校验全部改绑这个字段，不再信任 family_id 字符串本身（见上方 familyKeyOf）。
          ...(typeof fd.invariant === 'string' && fd.invariant ? { invariant: fd.invariant, family_key: familyKeyOf(fd.invariant) } : {}),
          // D1: origin_family_ids 保留每个 origin 自己的本地标签，供人工回溯「这条记录是哪个
          // reviewer 用哪个标签指过」——不参与任何机器分组判定，纯审计用途。
          origin_family_ids: [],
          status: 'closed' // 走到这里必然全 closed（conjunct② 已断言）
        });
      }
      const c = union.get(key);
      c.origins.push({ reviewer: v.reviewer, finding_id: fd.id });
      if (typeof fd.family_id === 'string' && fd.family_id) {
        c.origin_family_ids.push({ reviewer: v.reviewer, family_id: fd.family_id });
      }
      for (const p of fd.anchor_paths ?? []) if (!c.anchor_paths.includes(p)) c.anchor_paths.push(p);
      // SC-5（R2-P1-2 附带洞）: canonical severity 取同簇**最高**——旧实现取首个 origin，
      // 一席 suggestion 一席 major 时输入顺序能把 canonical 降为 suggestion，
      // 从而绕过 coverage gate 的强制覆盖。
      if (SEVERITY_RANK[fd.severity] > SEVERITY_RANK[c.severity]) c.severity = fd.severity;
    }
  }

  const review_input_hash = verdicts[0].review_input_hash;
  for (const c of union.values()) c.anchor_paths.sort(); // 确定性: 并集顺序不依赖 origin 到达序
  const canonical_findings = [...union.values()].sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  const verdict_hashes = {};
  for (const v of verdicts) verdict_hashes[v.reviewer] = hashObject(v);
  const base_sha = verdicts[0].base_sha;
  const candidate_sha = verdicts[0].candidate_sha;
  // 审③-F4-R: base/candidate 必须入锅——只改 artifact 声明的 SHA 即 hash 失效
  // SC-3: parent_artifact_hash 一并入锅——谱系被换即 hash 失效
  // issue #9 SC-A1: gate_result 与 round 入锅——PASS↔fail 互改而 hash 不变，手工拼一份
  // fail artifact 能冒充源共识。
  // issue #9 R2 blocker: hash 不再在此处手抄第二份公式——直接调 recomputeArtifactHash 对
  // 草稿对象计算，公式改动（如追加 schema_version）只有一处，不会出现"改了消费端却忘了
  // 同步构造端"这种本仓 hardening 台账反复出现的第 7 类教训（SC-A1 曾经的教训，schema_version
  // 追加时差点再踩一次）。
  const draft = {
    schema_version: 'v3',
    review_input_hash,
    parent_artifact_hash: parentArtifactHash,
    round,
    base_sha,
    candidate_sha,
    canonical_findings,
    verdict_hashes,
    created_at: nowIso(),
    gate_result: 'pass',
    fail_reasons: []
  };
  return { ...draft, consensus_artifact_hash: recomputeArtifactHash(draft) };
}

// push-guard 复用: 从 artifact 内容重算 hash（F4: 不信自报字符串；F4-R: 含 base/candidate）
// issue #9 SC-A1: gate_result/round 追加入锅——任一字段翻转即 hash 失效（末尾追加，不重排既有字段）。
// issue #9 R2 blocker: round/gate_result 去掉 `?? null` 静默兜底——缺字段是结构错误，必须
// 直接拒绝计算，不得悄悄哈希出一个"看起来合法"的值（SC-R2-2/5）。schema_version 追加入锅
// （SC-R2-4）：这只挡住"改字段却忘记/懒得重算 hash"的自洽性检查，挡不住"篡改后照同一公式
// 重算"这类确定性攻击——后者只能靠 assertArtifactShape 独立于 hash 结果的显式结构校验来拒绝
// （SC-R2-1/2/3，见该函数注释）。
export function recomputeArtifactHash(artifact) {
  if (!Number.isInteger(artifact.round)) {
    throw new Error(`recomputeArtifactHash: artifact.round 非整数（缺字段不再静默兜底为 null，issue #9 R2 blocker）: ${JSON.stringify(artifact.round)}`);
  }
  if (artifact.gate_result !== 'pass' && artifact.gate_result !== 'fail') {
    throw new Error(`recomputeArtifactHash: artifact.gate_result 非法（缺字段不再静默兜底为 null，issue #9 R2 blocker）: ${JSON.stringify(artifact.gate_result)}`);
  }
  return sha256(
    artifact.base_sha + artifact.candidate_sha + artifact.review_input_hash +
    canonicalJson(artifact.canonical_findings) + canonicalJson(artifact.verdict_hashes) +
    canonicalJson({ parent: artifact.parent_artifact_hash ?? null }) +
    canonicalJson({ gate_result: artifact.gate_result, round: artifact.round }) +
    canonicalJson({ schema_version: artifact.schema_version ?? null })
  );
}

// issue #9 R2 blocker（单审席 blocker，2026-08-07）: 三消费入口（sc-coverage-gate.
// checkScCoverage / fix-run.initRun / push-guard 的 artifact 与 sourceArtifact）与
// consensus-gate 自身的 parent 路径此前只验 hash 自洽与 gate_result，从不检查
// schema_version/round——克隆一份合法 PASS artifact，把 schema_version 改成 v1 或删掉
// round，按 recomputeArtifactHash 当前公式重算 hash 即可自洽通过，结构门被完全架空。
// hash 自洽在数学上不可能挡住"篡改后照同一公式重算"这类确定性攻击（攻击者与校验方用的
// 是同一个函数）——唯一能挡的是独立于 hash 结果的显式结构校验，因此单独抽出本函数，四处
// （三入口 + parent 路径）统一调用，禁止各自手抄一份（本仓 hardening 台账第 7 类教训：
// 同一字面值/同一校验四处手抄，改一处漏三处）。
export function assertArtifactShape(artifact, label = 'consensus artifact') {
  const errs = [];
  if (!artifact || typeof artifact !== 'object') {
    errs.push(`${label}: 不是对象（结构非法，fail-closed）`);
    return errs;
  }
  if (artifact.schema_version !== 'v3') {
    errs.push(`${label}.schema_version=${JSON.stringify(artifact.schema_version)} ≠ 'v3'（结构门拒绝非当前 schema 版本——这是 schema 版本问题，不是 hash 问题，issue #9 R2 blocker）`);
  }
  if (!Number.isInteger(artifact.round) || artifact.round < 1) {
    errs.push(`${label}.round=${JSON.stringify(artifact.round)} 非法（须为 >=1 的整数，缺字段/被删不再静默兜底为 null，issue #9 R2 blocker）`);
  } else if (artifact.round === 1) {
    if (artifact.parent_artifact_hash !== null) {
      errs.push(`${label}.round=1 但 parent_artifact_hash=${JSON.stringify(artifact.parent_artifact_hash)}（round=1 必须是无谱系的根，parent 必须为 null）`);
    }
  } else if (typeof artifact.parent_artifact_hash !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.parent_artifact_hash)) {
    errs.push(`${label}.round=${artifact.round} 但 parent_artifact_hash=${JSON.stringify(artifact.parent_artifact_hash)} 非合法 64-hex（round>=2 必须携带谱系）`);
  }
  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  // R4-P1: live 入口必须带 --repo-dir——changed-set 校验缺席 = anchor 污染门形同虚设
  if (args._.length < 3 || !args.bundle || !args['repo-dir']) {
    fail('用法: consensus-gate.mjs <v1.json> <v2.json> <v3.json> --bundle <bundle.json> --repo-dir <dir> [--parent <prev-artifact.json>] [--out artifact.json]\n（--repo-dir 必填: 共识入口自算 base..candidate 实改集校验 anchor_paths——R4-P1；delta 轮（round>=2）必须传 --parent——issue #9 SC-B）');
  }
  const verdicts = args._.slice(0, 3).map(readJson);
  // issue #9 SC-B: 读**完整** parent 文件，不再只取 consensus_artifact_hash 字符串——
  // gate_result/round/自身 hash 自洽全部要在 runConsensusGate 内部校验，opaque 字符串绑定不再可信。
  const parentArtifact = args.parent ? readJson(args.parent) : null;
  // issue #9 SC-B5: runConsensusGate 现在对「废弃参数名」这类编程错误会 throw（不再是
  // fail_reasons 里的一条数据错误）——CLI 侧兜住，输出干净的单行消息，不让用户看到裸
  // stack trace（本 CLI 自身从不传 parentArtifactHash，这里防的是未来误用/其他调用路径）。
  let result;
  try {
    result = runConsensusGate(verdicts, { bundle: readJson(args.bundle), parentArtifact, repoDir: args['repo-dir'] });
  } catch (e) {
    fail(e.message);
  }
  if (result.gate_result === 'pass') {
    if (args.out) writeJsonAtomic(args.out, result);
    process.stdout.write(`PASS consensus_artifact_hash=${result.consensus_artifact_hash}\n`);
  } else {
    for (const r of result.fail_reasons) process.stderr.write(`[GATE-FAIL] ${r}\n`);
    process.exit(1);
  }
}
