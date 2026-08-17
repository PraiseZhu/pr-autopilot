#!/usr/bin/env node
// size-gate.mjs — PR 规模机器闸（PR-B2，2026-08-06，GPT 共识计划 SC-6/7/19/21）
//
// 契约（共识钉死，勿凭感觉改）：
// - 统计口径：git diff --numstat -z <merge-base(base,head)> <head> 的 added+deleted 行数，
//   二进制文件（numstat 报 "-"）不计行数但计入 binary_files 上报；rename 按 numstat 原样（计新路径）。
// - 排除：内置 regex（测试/spec/fixtures/lockfile/生成物）∪ 目标仓 sizeGate.excludePaths（regex 并集）。
// - 配置源：**merge-base 树**的 agent-use/docs/pr-rules.json 的 sizeGate 字段（git show 读取，
//   绝不读候选工作树——否则被测 PR 自带一份宽配置就能绕过双闸，审 B2-F1 实测复现过）。
//   文件或字段缺失 → fallback 默认 {budgetLines:800, warnRatio:0.75}（fail-safe，配置 PR 可后置）；
//   字段存在但 malformed（类型错/regex 编不过/JSON 坏）→ **fail-closed 抛错**，不是回退默认。
//   候选侧对配置的修改只在合并进 base 后对未来 PR 生效。
// - 三档：PASS(<warnRatio×budget) / WARN(≥warnRatio×budget) / STOP(≥budget)。CLI: STOP exit 1，其余 0。
// - 豁免：结构化记录 {repo, branch, base_sha, head_sha, lineCount, at, reason}，owner 当次签发；
//   head_sha 与当前 head 不一致即失效（改一行就要重新豁免）。Phase 1 与 push-guard 同口径消费。

import { execFileSync } from 'node:child_process';
import { sha256, canonicalJson, parseArgs, fail, isMain, readJson } from './lib/common.mjs';

export const DEFAULT_SIZE_CONFIG = Object.freeze({ budgetLines: 800, warnRatio: 0.75, excludePaths: [] });

export const BUILTIN_EXCLUDES = [
  '(^|/)(tests?|__tests__|fixtures?|spec)/',
  '\\.(test|spec)\\.[cm]?[jt]sx?$',
  '(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|Gemfile\\.lock)$',
  '(^|/)dist/',
  '(^|/)preview-dist/',
  '\\.min\\.(js|css)$',
  '(^|/)(generated|__generated__)/',
  '\\.snap$'
];

// 返回 {config, source: 'default'|'base'}；malformed 一律 throw（fail-closed，SC-19）。
// ref = merge-base SHA：配置从 base 树读（审 B2-F1：读候选树 = 被测 PR 可自改闸门）。
// T8（SC-8）：git show 失败必须分「真缺文件」与「坏 ref / 非 git 仓 / 对象损坏」——
// 只有前者回退 default（唯一正例），后者 fail-closed 抛错，不得伪装成缺文件。
export function loadSizeGateConfig(repoDir, ref) {
  // 第一道：ref 必须能解析成 commit；坏 ref / 非 git 仓在此拦截（fail-closed，不回退 default）
  // stderr 必须 pipe：区分「真缺文件」要靠 git show 的 stderr 判据，丢弃了就无从判断
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = (e.stderr ?? '').toString().trim() || e.message;
    throw new Error(`size-gate: merge-base ref 无法解析 ${ref}（坏 ref / 非 git 仓，fail-closed，不回退默认）: ${why}`);
  }
  let text;
  try {
    text = execFileSync('git', ['-C', repoDir, 'show', `${ref}:agent-use/docs/pr-rules.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  } catch (e) {
    // 第二道：ref 已有效，失败只有「树里真没有该路径」是 default 正例；
    // 权限 / 对象损坏等其他失败仍 fail-closed（失败≠零测量）。
    // 判据靠 stderr 文本匹配 /does not exist in/，git 该消息可被 gettext 翻译——
    // 强制 C locale 防止宿主非英文环境下真缺文件被误判为 fail-closed。
    const why = (e.stderr ?? '').toString().trim() || e.message;
    if (/does not exist in/.test(why)) return { config: { ...DEFAULT_SIZE_CONFIG }, source: 'default' };
    throw new Error(`size-gate: 读取 base 树 pr-rules.json 失败（fail-closed，不回退默认）: ${why}`);
  }
  let rules;
  try { rules = JSON.parse(text); } catch (e) {
    throw new Error(`size-gate: base 树 pr-rules.json 解析失败（fail-closed，不回退默认）: ${e.message}`);
  }
  const sg = rules.sizeGate;
  if (sg === undefined || sg === null) return { config: { ...DEFAULT_SIZE_CONFIG }, source: 'default' };
  if (typeof sg !== 'object' || Array.isArray(sg)) throw new Error('size-gate: sizeGate 必须是对象（fail-closed）');
  const cfg = { ...DEFAULT_SIZE_CONFIG };
  if ('budgetLines' in sg) {
    if (!Number.isInteger(sg.budgetLines) || sg.budgetLines <= 0) throw new Error('size-gate: sizeGate.budgetLines 必须是正整数（fail-closed）');
    cfg.budgetLines = sg.budgetLines;
  }
  if ('warnRatio' in sg) {
    if (typeof sg.warnRatio !== 'number' || !(sg.warnRatio > 0 && sg.warnRatio <= 1)) throw new Error('size-gate: sizeGate.warnRatio 必须在 (0,1]（fail-closed）');
    cfg.warnRatio = sg.warnRatio;
  }
  if ('excludePaths' in sg) {
    if (!Array.isArray(sg.excludePaths) || sg.excludePaths.some((x) => typeof x !== 'string')) {
      throw new Error('size-gate: sizeGate.excludePaths 必须是字符串数组（fail-closed）');
    }
    for (const re of sg.excludePaths) {
      try { new RegExp(re); } catch { throw new Error(`size-gate: excludePaths 含非法 regex: ${re}（fail-closed）`); }
    }
    cfg.excludePaths = [...sg.excludePaths];
  }
  return { config: cfg, source: 'base' };
}

export function sizeConfigHash(config) {
  return sha256(canonicalJson({ budgetLines: config.budgetLines, warnRatio: config.warnRatio, excludePaths: [...config.excludePaths].sort(), builtin: BUILTIN_EXCLUDES }));
}

function isExcluded(path, config) {
  return [...BUILTIN_EXCLUDES, ...config.excludePaths].some((re) => new RegExp(re).test(path));
}

// 解析 `git diff --numstat -z` 输出（含 rename 的 NUL 三段形态）
export function parseNumstatZ(raw) {
  const parts = raw.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let path = m[3];
    if (path === '') { // rename: 后随 old\0new 两段
      i += 2;
      path = parts[i] ?? '';
    }
    entries.push({ added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]), path });
  }
  return entries;
}

export function computeSizeReport({ repoDir, baseRef, headRef = 'HEAD' }) {
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' });
  let mergeBase;
  try {
    mergeBase = git('merge-base', baseRef, headRef).trim();
  } catch (e) {
    // T8（SC-8）：不存在的 merge-base / 非 git 仓 → fail-closed 抛错，不得继续产出零测量报告
    const why = (e.stderr ?? '').toString().trim() || e.message;
    throw new Error(`size-gate: merge-base(${baseRef}, ${headRef}) 失败（坏 ref / 非 git 仓，fail-closed，不回退默认）: ${why}`);
  }
  const headSha = git('rev-parse', headRef).trim();
  const raw = git('diff', '--numstat', '-z', mergeBase, headRef);
  const { config, source } = loadSizeGateConfig(repoDir, mergeBase);
  let counted = 0, excludedLines = 0;
  const binaryFiles = [], countedFiles = [], excludedFiles = [];
  for (const e of parseNumstatZ(raw)) {
    if (e.added === null || e.deleted === null) { binaryFiles.push(e.path); continue; }
    const lines = e.added + e.deleted;
    if (isExcluded(e.path, config)) { excludedLines += lines; excludedFiles.push(e.path); continue; }
    counted += lines;
    countedFiles.push(e.path);
  }
  return { merge_base: mergeBase, head_sha: headSha, counted_lines: counted, excluded_lines: excludedLines, binary_files: binaryFiles, counted_files: countedFiles, excluded_files: excludedFiles, config, config_source: source, config_hash: sizeConfigHash(config) };
}

export function evaluateSize(report) {
  const { budgetLines, warnRatio } = report.config;
  const result = report.counted_lines >= budgetLines ? 'STOP'
    : report.counted_lines >= Math.ceil(budgetLines * warnRatio) ? 'WARN' : 'PASS';
  return { ...report, result, budget_lines: budgetLines, warn_threshold: Math.ceil(budgetLines * warnRatio) };
}

// 豁免有效性（SC-21）：head_sha 必须等于当前 head；必填字段齐全且 reason 非空。
// 返回 null=有效；string=无效原因。
export function exemptionInvalidReason(exemption, report) {
  if (!exemption || typeof exemption !== 'object') return '无豁免记录';
  for (const k of ['repo', 'branch', 'base_sha', 'head_sha', 'lineCount', 'at', 'reason']) {
    if (!(k in exemption)) return `豁免记录缺字段 ${k}`;
  }
  if (!String(exemption.reason).trim()) return '豁免 reason 为空';
  if (exemption.head_sha !== report.head_sha) return `豁免绑定 head=${String(exemption.head_sha).slice(0, 12)} ≠ 当前 head=${report.head_sha.slice(0, 12)}（head 变化即失效，需 owner 重新豁免）`;
  return null;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = args['repo-dir'] ?? '.';
  const baseRef = args.base;
  if (!baseRef) fail('用法: size-gate.mjs --repo-dir <dir> --base <ref>（如 origin/main）[--exemption <json文件>]');
  let out;
  try { out = evaluateSize(computeSizeReport({ repoDir, baseRef })); } catch (e) { fail(e.message, 3); }
  let exempted = false;
  if (out.result === 'STOP' && args.exemption) {
    const reason = exemptionInvalidReason(readJson(args.exemption), out);
    if (reason === null) exempted = true; else out.exemption_invalid = reason;
  }
  out.exempted = exempted;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.result === 'STOP' && !exempted ? 1 : 0);
}
