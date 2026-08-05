#!/usr/bin/env node
// size-gate.mjs — PR 规模机器闸（PR-B2，2026-08-06，GPT 共识计划 SC-6/7/19/21）
//
// 契约（共识钉死，勿凭感觉改）：
// - 统计口径：git diff --numstat -z <merge-base(base,head)> <head> 的 added+deleted 行数，
//   二进制文件（numstat 报 "-"）不计行数但计入 binary_files 上报；rename 按 numstat 原样（计新路径）。
// - 排除：内置 regex（测试/spec/fixtures/lockfile/生成物）∪ 目标仓 sizeGate.excludePaths（regex 并集）。
// - 配置源：<repoDir>/agent-use/docs/pr-rules.json 的 sizeGate 字段。
//   文件或字段缺失 → fallback 默认 {budgetLines:800, warnRatio:0.75}（fail-safe，配置 PR 可后置）；
//   字段存在但 malformed（类型错/regex 编不过/JSON 坏）→ **fail-closed 抛错**，不是回退默认。
// - 三档：PASS(<warnRatio×budget) / WARN(≥warnRatio×budget) / STOP(≥budget)。CLI: STOP exit 1，其余 0。
// - 豁免：结构化记录 {repo, branch, base_sha, head_sha, lineCount, at, reason}，owner 当次签发；
//   head_sha 与当前 head 不一致即失效（改一行就要重新豁免）。Phase 1 与 push-guard 同口径消费。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, canonicalJson, parseArgs, fail, isMain, readJson } from './lib/common.mjs';

export const DEFAULT_SIZE_CONFIG = Object.freeze({ budgetLines: 800, warnRatio: 0.75, excludePaths: [] });

export const BUILTIN_EXCLUDES = [
  '(^|/)(tests?|__tests__|fixtures?|spec)/',
  '\\.(test|spec)\\.[cm]?[jt]sx?$',
  '(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|Gemfile\\.lock)$',
  '(^|/)dist/',
  '\\.min\\.(js|css)$',
  '(^|/)(generated|__generated__)/',
  '\\.snap$'
];

// 返回 {config, source: 'default'|'repo'}；malformed 一律 throw（fail-closed，SC-19）
export function loadSizeGateConfig(repoDir) {
  const p = join(repoDir, 'agent-use', 'docs', 'pr-rules.json');
  if (!existsSync(p)) return { config: { ...DEFAULT_SIZE_CONFIG }, source: 'default' };
  let rules;
  try { rules = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    throw new Error(`size-gate: pr-rules.json 解析失败（fail-closed，不回退默认）: ${e.message}`);
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
  return { config: cfg, source: 'repo' };
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
  const mergeBase = git('merge-base', baseRef, headRef).trim();
  const headSha = git('rev-parse', headRef).trim();
  const raw = git('diff', '--numstat', '-z', mergeBase, headRef);
  const { config, source } = loadSizeGateConfig(repoDir);
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
