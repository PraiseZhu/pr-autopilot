#!/usr/bin/env node
// 批次闭合门 — issue #9 SC 延伸（批次事务协议，i9-batch）。
// 职责：批次收口时验证「冻结集全处置 + 新 family 不混入本批」，是 sc-coverage-gate 的
// 时间维度补充，不是替代：
//   · sc-coverage-gate 只看「当前 artifact 的 canonical_findings 都被 SC 恰好覆盖 1:1」；
//   · 本门追踪「批次开始时承诺处置的 family 集（frozen_families）在收口时是否全部兑现」——
//     关键增量是冻结集与终版集的**差集**：被「答」撤回（从 findings[] 消失）或审查席删除的
//     family，sc-coverage-gate 看不见（它不在终版 canonical 里），但本门必须拒收口。
// 判据（任一违 → fail-closed，消息互斥以支持反向变异隔离）：
//   ① run manifest 必须携带 batch 段且 status='closed'（open = 批次未收口，不许闭合判定）
//   ② batch.frozen_at_sha 必须 == run manifest 的 source_candidate（起点 CAS 派生，不自报）
//   ③ batch.frozen_families ⊆ 源共识（批次起点）canonical_findings 的 family_key 集
//     （冻结集只能来自源共识——initRun 已验，此处独立重验，防 init 后篡改）
//   ④ batch.frozen_families ∩ 终版共识 canonical_findings 的 family_key 集必须为空
//     （处置语义：冻结集内的 family 在本批 delta 审查中**不再出现** = 上次修住 = 处置完成；
//      再次出现 = 同族复发 = 上次没修住 = 未处置 → 拒收口。注意与触发条件④（convergence-
//      checkpoint.md）的区分：判据④是本批内「没修住」的拒收口；触发条件④是「上一批处置过、
//      又进本批 frozen」的跨批复发，命中时 lead 须在 checkpoint.json 里带 recurrence 段）
//   ⑤ 本批 SC（非 global）携带的 family_key 必须 ∈ batch.frozen_families
//     （本批 SC 只处置冻结集内的族；处置冻结集之外的 family = 把下一批的义务混进本批 → 拒）
//   ⑥ 源共识与终版共识的 blocker/major canonical finding 必须全部带 family_key
//     （lead 裁决：批次只冻结有 family_key 的 finding；没有 invariant 的 blocker/major 无法
//      归族 = 无法进 frozen_families = 「没归因就打补丁」本身——先归因再进批次，拒收口）
//   ⑦ recurrence 段校验（可选 checkpoint 参数；lead 申报跨批复发时必带）：
//      字段齐全 + verdict enum 合法 + symptom 时 root_cause_locator 非空（形如 路径:行号）
//      + family_key ∈ 本批 frozen_families + prior_sc_id ∈ sc manifest
// 保证等级 T1（如实声明）：
//   · family_key 是逐字内容派生（consensus-gate.mjs 的 familyKeyOf，归一化仅 trim/小写/去空白）——
//     「同一根因换个说法」会算出不同 key，机器视为新族（进下一批，不触发本门）；语义级同族
//     复发检测机器做不到，只能靠 lead 冻结时人工归族。本门只锁形状与集合关系，不防伪造
//     （同本仓其余 T1 条款：本地可构造满足全部条件的 run manifest 同样能通过，无签名/存证）。
//   · suggestion 级 canonical finding 不带 family_key（共识 schema 不强制），其 SC 无 family_key
//     可判定归属 → 放行（不在冻结集模型内）；机器能锁住的 actionable 混入全部锁住。
//   · recurrence 段：机器只验形状与自洽；「这次是不是真的同族复发」的判断权在 lead（机器无
//     跨批次账本，无法独立判定），prior_sc_missed_because 填一句废话也能过（防疏忽不防伪造）。
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';
import { recomputeArtifactHash, assertArtifactShape } from './consensus-gate.mjs';
import { runManifestHash, verifyEventChain, RUN_MANIFEST_SCHEMA_VERSION } from './fix-run.mjs';

const RECURRENCE_VERDICTS = ['fix_was_wrong', 'family_was_misgrouped', 'fix_was_symptom'];

export function checkBatchClosure({ runManifest, sourceArtifact, finalArtifact, scManifest, checkpoint = null }) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };

  need(runManifest && typeof runManifest === 'object', 'run manifest 不是对象');
  need(sourceArtifact && typeof sourceArtifact === 'object', '源 consensus artifact 不是对象');
  need(finalArtifact && typeof finalArtifact === 'object', '终版 consensus artifact 不是对象');
  need(scManifest && typeof scManifest === 'object', 'sc manifest 不是对象');
  if (errs.length) return errs;

  // ① 批次段存在且已收口
  const batch = runManifest.batch;
  need(batch && typeof batch === 'object', 'run manifest 无 batch 段（非批次 run，闭合门不适用，fail-closed）');
  if (!batch) return errs;
  need(batch.status === 'closed', `batch.status=${JSON.stringify(batch.status)} ≠ closed（批次未收口，不许闭合判定）`);
  need(/^[A-Za-z0-9._-]+$/.test(String(batch.batch_id ?? '')), `batch.batch_id 非法: ${batch.batch_id}`);

  // 事件链完整（防删改历史，与 fix-run.loadRun 同判据）
  for (const e of verifyEventChain(runManifest)) errs.push(`run manifest: ${e}`);
  need(runManifest.schema_version === RUN_MANIFEST_SCHEMA_VERSION,
    `run manifest schema_version=${JSON.stringify(runManifest.schema_version)} ≠ ${RUN_MANIFEST_SCHEMA_VERSION}（批次段是 ${RUN_MANIFEST_SCHEMA_VERSION} schema 的字段，i9-batch）`);

  // ② 起点派生不自报
  need(batch.frozen_at_sha === runManifest.source_candidate,
    `batch.frozen_at_sha（${String(batch.frozen_at_sha).slice(0, 12)}）≠ run manifest source_candidate（${String(runManifest.source_candidate).slice(0, 12)}）——批次起点必须由 run 起点派生，不接受自报`);

  // 终版 artifact 结构门 + 自洽（照 sc-coverage-gate：结构门先于 hash，PASS 共识才配闭合）
  for (const e of assertArtifactShape(finalArtifact, '终版 consensus artifact')) errs.push(e);
  for (const e of assertArtifactShape(sourceArtifact, '源 consensus artifact')) errs.push(e);
  if (errs.length) return errs;
  let fReal = null, sReal = null;
  try { fReal = recomputeArtifactHash(finalArtifact); } catch (e) { errs.push(`终版 consensus artifact hash 重算失败（结构非法，fail-closed）: ${e.message}`); }
  try { sReal = recomputeArtifactHash(sourceArtifact); } catch (e) { errs.push(`源 consensus artifact hash 重算失败（结构非法，fail-closed）: ${e.message}`); }
  if (fReal !== null) need(finalArtifact.consensus_artifact_hash === fReal, '终版 consensus artifact 自身 hash 与内容重算不符（artifact 被改）');
  if (sReal !== null) need(sourceArtifact.consensus_artifact_hash === sReal, '源 consensus artifact 自身 hash 与内容重算不符（artifact 被改）');
  if (fReal !== null) need(finalArtifact.gate_result === 'pass', `终版 consensus artifact gate_result=${finalArtifact.gate_result} ≠ pass（只有 PASS 共识才能作闭合判定的终版）`);
  if (sReal !== null) need(sourceArtifact.gate_result === 'pass', `源 consensus artifact gate_result=${sourceArtifact.gate_result} ≠ pass（只有 PASS 共识才能作批次起点）`);
  // 源共识必须是终版共识的谱系祖先（同 base 且 candidate 推进——终版是 delta 轮产物）
  need(finalArtifact.base_sha === sourceArtifact.base_sha, '终版共识与源共识的 base_sha 不同（跨评审拼接，i9-batch）');
  need(finalArtifact.parent_artifact_hash === sReal,
    `终版共识的 parent 不是源共识（parent=${String(finalArtifact.parent_artifact_hash).slice(0, 12)} 源=${String(sReal).slice(0, 12)}）——批次闭合判定要求终版是源共识的直接 delta 轮产物`);

  const frozen = batch.frozen_families ?? [];
  need(Array.isArray(frozen) && frozen.length > 0, 'batch.frozen_families 缺失或为空（冻结集为空 = 没有待处置义务，语义不成立）');

  // ③ 冻结集真实（⊆ 源共识 family_keys）
  const srcKeys = new Set((sourceArtifact.canonical_findings ?? []).map((c) => c.family_key).filter(Boolean));
  for (const fk of frozen) {
    if (!srcKeys.has(fk)) errs.push(`batch.frozen_families 含不在源共识中的 family_key: ${fk.slice(0, 12)}…（冻结集只能从源共识派生，fail-closed）`);
  }

  // ④ 全处置（冻结集 ∩ 终版 family_keys 必须为空——终版再次出现 = 同族复发 = 未处置）
  // R4 实测（lead 2026-08-07 查证 + 实测定论）: 一个被 ARCHIVE 的 family **会带着 archive SC
  // 留在终版 canonical_findings 里**（SKILL.md:507「ARCHIVE | 留在 findings[] | 进 canonical，
  // sc-coverage-gate 强制 kind=archive SC 1:1 覆盖」；sc-coverage-gate.mjs:41 mustCover 含
  // blocker/major）。`status=closed` ≠ 不进 canonical——closed 是「裁决为真且已处置」，进不进
  // canonical 是另一回事。因此判据④必须给 ARCHIVE 留出口，否则合法 ARCHIVE 永远收不了口。
  // 出口判据 =「该 family 有一条**已验证的 archive SC**」（结果导向，不是自报「已处置」标志
  // 位——后者是记账式满足，正是 lead 一开始否决的形态）: archive SC 必须真实存在于 sc
  // manifest 且其 finding_ids 引用的 canonical finding 的 family_key 就是本族，且本批 SC
  // manifest 里存在该 archive SC（含 kind=archive）。
  // **verify 由哪层保证（lead 2026-08-07 一行证据）**：`fix-run.mjs:551` validateIntegration
  // 对 wave 内全部 SC（含 archive）执行 verify 并强制全 PASS——:572-574 逐 SC 跑 verify recipe、
  // :643 `results.every((r) => r.status === 'PASS')`、:645 非 PASS 记 failed 阻断。因此
  // 「archive SC 过 verify」由 fix-run 的 wave validation 层保证，闭合门不扩（按确认门：删掉
  // 它其他判断仍成立——verify 记录已随 run manifest validation 入 hash，push-guard 校验之）。
  const finKeys = new Set((finalArtifact.canonical_findings ?? []).map((c) => c.family_key).filter(Boolean));
  // 本批已处置族的 archive SC 集合（结果导向出口，2026-08-07 按注释声明收紧）——
  // 注释 :100-102 声称「finding_ids 引用的 canonical finding 的 family_key 就是本族」，
  // 但实现此前只过滤 kind==='archive' && family_key，finding_ids 零次出现、allocations/
  // validation/sc_manifest_hash 同样零次——注释描述了一道没实现的检查（读的人会以为它在拦）。
  // 收紧为：① 该 archive SC 的 finding_ids 必须指向本族（每个 id 引用一条 canonical finding，
  //    且该 finding 的 family_key 必须等于该 SC 的 family_key——防「随便填个 family_key 的
  //    archive SC 冒充出口」）；② 该 archive SC 必须真实出现在某个 wave 的 allocations 里
  //    且该 wave 的 validation.ok === true（补上委派链断点：verify 由 fix-run wave validation
  //    层保证，闭合门要求该 wave 真实执行过且通过——「有 archive SC」≠「执行过」）。
  // 注意：canonical finding 的 family_key 从 invariant 派生（consensus-gate 的 familyKeyOf），
  // SC manifest 里的 family_key 是引用同一派生的字符串，可直接比对。finding_ids 引用的
  // canonical 可能是源共识的（archive SC 处置源共识发现的 finding，scManifest 的 finding_ids
  // 通常指向源共识——见 i9-batch 的 SC-2）也可能是终版的（终版复现的那条），两个命名空间
  // 都要查：只要引用任一 canonical 的 family_key == 该 SC 的 family_key 即「指向本族」。
  const finalById = new Map([...(finalArtifact.canonical_findings ?? []), ...(sourceArtifact.canonical_findings ?? [])].map((c) => [c.id, c]));
  const archiveScByFamily = new Map();
  for (const sc of Array.isArray(scManifest.scs) ? scManifest.scs : []) {
    if (sc.kind !== 'archive' || typeof sc.family_key !== 'string' || !sc.family_key) continue;
    // ① finding_ids 指向本族
    const fids = Array.isArray(sc.finding_ids) ? sc.finding_ids : [];
    if (!fids.length) continue; // 无 finding_ids 的 archive SC 不构成出口（无引用 = 无法指向本族）
    const allInFamily = fids.every((fid) => {
      const cf = finalById.get(fid);
      return cf && cf.family_key === sc.family_key;
    });
    if (!allInFamily) continue;
    // ② 该 SC 真实出现在某 wave 的 allocations **且该 wave 的 validation.results 中存在
    //    sc_id === sc.id 且 status === 'PASS' 的逐项证据**（2026-08-07 复核 major 修复）。
    //    此前只验 validation.ok（自报汇总布尔值）——空 results 上 fix-run:643 的
    //    results.every((r) => r.status === 'PASS') 恒为 true，`{ok:true, results:[]}` 就能
    //    伪造通过出口而该 SC 的 verify 从未执行（汇总布尔值 = 「台账≠修复」标准形态）。
    //    逐项查到即说明 results 非空且该 SC 真跑过；不再依赖 validation.ok（可真而 results 空）。
    const waves = Array.isArray(runManifest.waves) ? runManifest.waves : [];
    const executedOk = waves.some((w) => {
      const allocs = Array.isArray(w.allocations) ? w.allocations : [];
      if (!allocs.some((a) => (a.sc_ids ?? []).includes(sc.id))) return false;
      const results = w && w.validation ? (Array.isArray(w.validation.results) ? w.validation.results : []) : [];
      return results.some((r) => r.sc_id === sc.id && r.status === 'PASS');
    });
    if (!executedOk) continue;
    archiveScByFamily.set(sc.family_key, sc.id);
  }
  const archiveScFamilies = new Set(archiveScByFamily.keys());
  const recurred = frozen.filter((fk) => finKeys.has(fk) && !archiveScFamilies.has(fk));
  if (recurred.length) {
    for (const fk of recurred) {
      errs.push(`冻结集 family_key ${fk.slice(0, 12)}… 在终版共识中再次出现（同族复发：上次未修住或未 ARCHIVE，不得作为处置兑现，拒收口；按 i9-batch Task 4 须先产出归因六件套）`);
    }
  }

  // ⑤ 本批 SC 不处置冻结集外的 family（新 family 进下一批，不得混入本批）
  const frozenSet = new Set(frozen);
  const scs = Array.isArray(scManifest.scs) ? scManifest.scs : [];
  for (const sc of scs) {
    if (sc.kind === 'global') continue; // global SC 是中央验证步，不引用 finding，无族归属
    if (typeof sc.family_key === 'string' && sc.family_key) {
      if (!frozenSet.has(sc.family_key)) {
        errs.push(`本批 SC ${sc.id} 处置了冻结集之外的 family_key: ${sc.family_key.slice(0, 12)}…（批次期间新冒出的 finding 必须进下一批，不得混入本批 manifest，i9-batch）`);
      }
    }
    // 无 family_key 的 SC = 引用 suggestion 级 finding（共识不强制 suggestion 携带该字段）——
    // 不在冻结集模型内，放行（T1 上限如实声明见文件头）。
  }

  // ⑥ 缺 invariant 无法归族强制（lead 裁决）：blocker/major 必须全部带 family_key——
  // 批次只冻结有 family_key 的 finding；没有 invariant 的 actionable 无法进 frozen_families，
  // 恰恰是「没归因就打补丁」本身（convergence-checkpoint.md D5: 先归因到不变量再修全部路径）。
  const actionables = (artifact) => (artifact.canonical_findings ?? []).filter((c) => c.severity === 'blocker' || c.severity === 'major');
  for (const [label, artifact] of [['源共识', sourceArtifact], ['终版共识', finalArtifact]]) {
    for (const c of actionables(artifact)) {
      if (typeof c.family_key !== 'string' || !c.family_key) {
        errs.push(`${label} canonical finding ${c.id}（${c.severity}/${c.primary_face}）缺 invariant 无法归族（无 family_key）——先归因到不变量再进批次，拒收口（i9-batch）`);
      }
    }
  }

  // ⑦ recurrence 段校验（触发条件④命中时 lead 在 checkpoint.json 申报；机器验形状与自洽）
  const rec = checkpoint?.recurrence ?? null;
  if (rec !== null) {
    if (!rec || typeof rec !== 'object') {
      errs.push('checkpoint.recurrence 不是对象');
    } else {
      need(/^fk1-[0-9a-f]{64}$/.test(String(rec.family_key ?? '')),
        `recurrence.family_key 非法: ${JSON.stringify(rec.family_key)}（必须是 fk1- 派生的 64-hex key）`);
      need(/^[A-Za-z0-9._-]+$/.test(String(rec.prior_batch_id ?? '')),
        `recurrence.prior_batch_id 非法: ${JSON.stringify(rec.prior_batch_id)}`);
      need(/^[0-9a-f]{40}$/.test(String(rec.prior_candidate_sha ?? '')),
        `recurrence.prior_candidate_sha 非法: ${JSON.stringify(rec.prior_candidate_sha)}（必须是 40-hex commit SHA）`);
      need(/^SC-[A-Za-z0-9._-]+$/.test(String(rec.prior_sc_id ?? '')),
        `recurrence.prior_sc_id 非法: ${JSON.stringify(rec.prior_sc_id)}（须 ^SC-[A-Za-z0-9._-]+$）`);
      need(typeof rec.prior_sc_missed_because === 'string' && rec.prior_sc_missed_because.trim().length > 0,
        'recurrence.prior_sc_missed_because 缺失或为空（自由文本，T1 只验非空）');
      need(RECURRENCE_VERDICTS.includes(rec.verdict),
        `recurrence.verdict 非法: ${JSON.stringify(rec.verdict)}（必须 ∈ ${RECURRENCE_VERDICTS.join('/')}）`);
      if (rec.verdict === 'fix_was_symptom') {
        need(typeof rec.root_cause_locator === 'string' && /^[^:\s]+:\d+$/.test(rec.root_cause_locator.trim()),
          `recurrence.verdict=fix_was_symptom 必须携带 root_cause_locator（形如 路径:行号）: ${JSON.stringify(rec.root_cause_locator)}`);
      } else {
        need(rec.root_cause_locator === undefined || rec.root_cause_locator === null,
          'recurrence.verdict ≠ fix_was_symptom 时不得携带 root_cause_locator');
      }
      // 自洽：复发的族必须确实是本批要处置的族；上次的 SC 必须确实存在于 sc manifest
      need(frozenSet.has(rec.family_key),
        `recurrence.family_key（${String(rec.family_key).slice(0, 12)}…）不在本批 frozen_families 中——复发归因必须针对本批要处置的族（i9-batch）`);
      const scIds = new Set(scs.map((s) => s.id));
      need(scIds.has(rec.prior_sc_id),
        `recurrence.prior_sc_id（${rec.prior_sc_id}）不在 sc manifest 中——上次声称拦住它的 SC 必须真实存在（i9-batch）`);
    }
  }

  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args['run-manifest'] || !args['source-artifact'] || !args['final-artifact'] || !args['sc-manifest']) {
    fail('用法: batch-closure-gate.mjs --run-manifest <run.json> --source-artifact <consensus.json> --final-artifact <consensus.json> --sc-manifest <sc-manifest.json> [--checkpoint <checkpoint.json>]');
  }
  const errs = checkBatchClosure({
    runManifest: readJson(args['run-manifest']),
    sourceArtifact: readJson(args['source-artifact']),
    finalArtifact: readJson(args['final-artifact']),
    scManifest: readJson(args['sc-manifest']),
    checkpoint: args.checkpoint ? readJson(args.checkpoint) : null
  });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[BATCH-CLOSURE-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('BATCH-CLOSURE-OK\n');
}
