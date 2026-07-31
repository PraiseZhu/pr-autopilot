#!/usr/bin/env node
// 台账追加器 — 计划依据: §1.3 统一纪律 + SP-6 + R9（append-only）
// 审②-F12 修复: E6 走严格 allowlist schema——未知字段直接拒绝（不再 spread 全量 entry），
// 原始 command/diff/evidence 不落盘，只在内存算 hash 后丢弃；redacted_summary 经
// deepScrub 递归脱敏 + secret-lint 二层校验，任一层不过即阻断入账。
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, parseArgs, fail, nowIso, sha256, canonicalJson, isMain} from '../lib/common.mjs';
import { secretLint, deepScrub } from './secret-lint.mjs';
import { withLock } from '../lib/state-lock.mjs';

const CHANNELS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
const WHY_CLASSES = ['face-gap', 'lens-blind', 'evidence-skip', 'judgment', 'pending'];
// E6 allowlist（F12）: 这些之外的字段一律拒绝——防「洗数据」经未知字段带秘密落盘
const E6_ALLOWED = new Set(['channel', 'kind', 'pattern_key', 'instance_key', 'guard_id', 'session_surrogate', 'content_hash', 'redacted_summary', 'raw_material']);
const E6_REQUIRED = ['guard_id'];

export function appendLedger({ ledgerFile, entry }) {
  if (!CHANNELS.includes(entry.channel)) throw new Error(`channel 必须是 ${CHANNELS.join('/')}`);
  if (!entry.instance_key) throw new Error('缺 instance_key（≥2 阈值要求跨实例）');
  if (!entry.pattern_key) throw new Error('缺 pattern_key（聚类幂等键）');
  if (entry.channel === 'E1' && entry.kind !== 'confirm' && !WHY_CLASSES.includes(entry.why_class)) {
    throw new Error(`E1 why_class 必须是 ${WHY_CLASSES.join('/')}（新账默认 pending）`);
  }
  // e2e-evolution 实锤修复: confirm 必须显式引用被转正的 event id（cluster 只认 id_ref）
  if (entry.kind === 'confirm') {
    if (!entry.id_ref) throw new Error('confirm 记录必须携带 id_ref（引用被转正的 event id，伪 confirm 无引用即无效）');
    // 审⑤-F6: 知道真实 id ≠ 有权转正。confirm 必须来自独立可信入口——
    // owner HMAC 签名（confirmed_by=owner + sig）或 allowlist 确定性规则（rule_id + evidence_hash）。
    // 此处做结构闸（缺鉴权材料拒收）；密码学/规则验证在 cluster 消费端执行。
    // 审⑥-F3: 两路径都必须带 sig（authority 在签名，格式只是结构面）
    const hasSig = typeof entry.sig === 'string' && entry.sig.length >= 32;
    const ownerShape = entry.confirmed_by === 'owner';
    const ruleShape = typeof entry.rule_id === 'string' && /^[0-9a-f]{64}$/.test(String(entry.evidence_hash ?? ''));
    if (!hasSig || (!ownerShape && !ruleShape)) {
      throw new Error('confirm 缺鉴权材料: 两路径均需 HMAC sig（owner: confirmed_by=owner+sig；规则: rule_id+64hex evidence_hash+sig，全字段入签）——自动会话自报 confirm 被拦（审⑤-F6/审⑥-F3）');
    }
  }

  // 审③-F10-R: remote_node_id 在场时作为幂等主键（node 内容变化不能再刷一条）
  const idBasis = entry.remote_node_id
    ? { c: entry.channel, n: String(entry.remote_node_id) }
    : { c: entry.channel, p: entry.pattern_key, i: entry.instance_key };

  let record;
  if (entry.channel === 'E6') {
    for (const k of Object.keys(entry)) {
      if (!E6_ALLOWED.has(k) && !['why_class', 'remote_node_id'].includes(k)) {
        throw new Error(`E6 字段「${k}」不在 allowlist（F12: 未知字段拒绝，防洗数据夹带秘密）`);
      }
    }
    for (const k of E6_REQUIRED) {
      if (!entry[k]) throw new Error(`E6 缺必填字段: ${k}`);
    }
    // raw_material（命令/diff/header 原文）只在内存算 hash，绝不落盘。
    // 审③-F12-R: raw_material 在场时 content_hash 一律由本函数重算（外部自报值忽略）；
    // 仅提供 content_hash 时必须是严格 64 位 hex——任意明文借该字段洗入被拒。
    let contentHash = null;
    if (entry.raw_material !== undefined) {
      contentHash = sha256(typeof entry.raw_material === 'string' ? entry.raw_material : canonicalJson(entry.raw_material));
    } else if (entry.content_hash !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(String(entry.content_hash))) {
        throw new Error('E6 content_hash 必须是 64 位 hex（明文洗入被拦，F12-R）');
      }
      contentHash = entry.content_hash;
    }
    if (!contentHash) throw new Error('E6 需要 content_hash 或 raw_material（用于聚类追溯，原文不落盘）');
    record = {
      id: sha256(canonicalJson(idBasis)).slice(0, 16),
      at: nowIso(),
      kind: entry.kind ?? 'event',
      channel: 'E6',
      pattern_key: deepScrub(entry.pattern_key, 120),
      instance_key: deepScrub(entry.instance_key, 120),
      guard_id: deepScrub(entry.guard_id, 80),
      session_surrogate: entry.session_surrogate ? sha256(String(entry.session_surrogate)).slice(0, 12) : null,
      content_hash: contentHash,
      redacted_summary: deepScrub(entry.redacted_summary ?? '', 200)
    };
    const hits = secretLint(JSON.stringify(record));
    if (hits.length) {
      throw new Error(`E6 条目脱敏后仍含疑似 secret（${hits.map((h) => h.pattern).join(',')}），阻断入账`);
    }
  } else {
    // 审④-I3: untrusted spread 在前，可信字段最后写入——entry 自带 id/at/prev 无法覆盖
    record = {
      ...deepScrub(entry, 400),
      id: sha256(canonicalJson(idBasis)).slice(0, 16),
      at: nowIso(),
      kind: entry.kind ?? 'event'
    };
    delete record.prev; // prev 只能由链逻辑生成
  }

  // 幂等 + hash 链（e2e-evolution 实锤: append-only 不能只是约定——
  // 每条记录携带 prev = 上一行原文的 sha256，删/改任何历史行都会使链断裂，
  // cluster 读取时验链 fail-closed）
  return withLock(`${ledgerFile}.lock`, () => { // 审④-I3: dedupe+append 原子化（跨引擎共享台账）
  const headFile = `${ledgerFile}.head`;
  let lastLine = null;
  if (existsSync(ledgerFile)) {
    const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
    // 审⑤-F5: 任何 dedupe/append 前先验整条 prev 链——被删改的台账绝不重封
    for (let i = 0; i < lines.length; i++) {
      const expect = i === 0 ? 'GENESIS' : sha256(lines[i - 1]);
      if (JSON.parse(lines[i]).prev !== expect) {
        throw new Error(`台账 hash 链断裂于第 ${i + 1} 行——拒绝追加（重封会把删改历史合法化，R9 违例先审计再修账）`);
      }
    }
    // 审⑤-F5: 非空台账必须有 head 侧车且等于当前末行 hash——截尾后 append 重封被拦
    if (lines.length > 0) {
      if (!existsSync(headFile)) throw new Error('台账非空但 head 侧车缺失——疑似截尾/侧车被删，拒绝追加（fail-closed）');
      const expectedHead = readFileSync(headFile, 'utf8').trim();
      if (sha256(lines[lines.length - 1]) !== expectedHead) {
        throw new Error('台账末行与 head 侧车不一致——疑似截尾删除历史，拒绝追加（R9 违例，fail-closed）');
      }
    } else if (existsSync(headFile) && readFileSync(headFile, 'utf8').trim()) {
      // 审⑥-F2: 文件在但被截成 0 行、而侧车仍有历史锚点 → 整本历史被清空，拒绝按 GENESIS 重封。
      // 「从未初始化的新空账」= 无侧车（或空侧车），才允许 GENESIS 起链。
      throw new Error('台账为空但 head 侧车仍有历史锚点——疑似整本被 truncate，拒绝重封（R9 违例，fail-closed）');
    }
    for (const line of lines) {
      const prevRec = JSON.parse(line);
      if (prevRec.id === record.id && prevRec.kind === record.kind) return { appended: false, id: record.id };
      lastLine = line;
    }
  } else if (existsSync(headFile)) {
    throw new Error('台账缺失但 head 侧车仍在——疑似整账被删，拒绝重建（fail-closed，先审计）');
  }
  record.prev = lastLine === null ? 'GENESIS' : sha256(lastLine);
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const line = JSON.stringify(record);
  appendFileSync(ledgerFile, line + '\n');
  // head 侧车: 记录末行 hash——纯 prev 链防不了「截尾删除」（前缀天然自洽），
  // cluster/append 双端比对。原子替换写入（审⑤-F5）。本地防篡改为 S2 级，
  // 终局审计线 = git 历史（台账入仓）+ R9 纪律；侧车把「随手删一行」变成可检测。
  const tmp = `${headFile}.tmp-${process.pid}`;
  writeFileSync(tmp, sha256(line));
  renameSync(tmp, headFile);
  return { appended: true, id: record.id };
  });
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ledger || !args.entry) fail('用法: ledger-append.mjs --ledger <jsonl> --entry <entry.json>');
  try {
    const res = appendLedger({ ledgerFile: args.ledger, entry: readJson(args.entry) });
    process.stdout.write(`${res.appended ? 'APPENDED' : 'DUPLICATE-SKIP'} id=${res.id}\n`);
  } catch (e) {
    fail(e.message);
  }
}
