#!/usr/bin/env node
// UI 判定唯一源 — 计划依据: §1.1b ⑫；#22 registry 来源绑定（wave2 g2）
// 确定性脚本产出 { touches_ui, matched_paths, config_hash, receipt } 写入 review bundle；
// reviewer 无自判权；demo 证据预检复用同一结果。
// #22（T1 输入完整性）: receipt 携带 path/config_hash/source_sha/repo 四条 provenance，
// 由 review-input-hash.mjs 全量入锅；--repo 强制校验 registry 归属仓 === 目标仓（错仓红）。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readJson, parseArgs, fail, hashObject, isMain } from '../lib/common.mjs';
import { globToRe } from '../push-guard.mjs';

export function matchUiPaths(registry, changedFiles, opts = {}) {
  // #22 来源绑定: expectedRepo 在场时，registry 声明的 repo 必须与目标仓一致（错仓红）。
  // bundle 生成路径（CLI）强制传 expectedRepo；纯函数调用不传则保持旧语义。
  if (opts.expectedRepo) {
    if (!registry.repo) throw new Error(`registry 缺 repo 声明，无法做来源绑定（需要 ${opts.expectedRepo}）`);
    if (registry.repo !== opts.expectedRepo) {
      throw new Error(`registry 归属仓 ${registry.repo} 与目标仓 ${opts.expectedRepo} 不一致（#22 来源绑定，错仓红）`);
    }
  }
  const uiRes = registry.ui_globs.map(globToRe);
  const excRes = (registry.non_ui_exceptions ?? []).map(globToRe);
  const matched = changedFiles.filter(
    (f) => uiRes.some((re) => re.test(f)) && !excRes.some((re) => re.test(f))
  );
  return {
    touches_ui: matched.length > 0,
    matched_paths: matched.sort(),
    config_hash: hashObject(registry)
  };
}

// #22 provenance receipt: path + 内容 hash(64 hex) + 来源 ref SHA(40 hex) + 归属仓。
// 四条全量进入 computeReviewInputHash —— 源选择（哪份 registry、来自哪个 ref）从此有机器留痕，
// lead 手填 hash 或选错仓 registry 会在 hash 比对/双轨一致性处被拒。
export function registryReceipt({ path, registry, sourceSha }) {
  if (typeof path !== 'string' || !path) throw new Error('registry receipt 缺 path');
  if (!registry.repo) throw new Error('registry 缺 repo 声明，无法生成 receipt');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error(`source_sha 必须是 40 位 hex（#22），got ${sourceSha}`);
  return { path, config_hash: hashObject(registry), source_sha: sourceSha, repo: registry.repo };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.registry || !args.files) {
    fail('用法: match.mjs --registry <registry.json> --files <每行一个路径的文件|- 表示 stdin> --repo <owner/repo> [--source-sha <40hex>]');
  }
  if (!args.repo) fail('必须传 --repo <owner/repo>（#22 来源绑定：registry 归属仓须与目标仓一致）');
  const registry = readJson(args.registry);
  const raw = args.files === '-' ? readFileSync(0, 'utf8') : readFileSync(args.files, 'utf8');
  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  // 单一规则（issue #22 建议 4）: registry 来源 ref = 当前仓 HEAD；HEAD 前进 → source_sha 变 →
  // review_input_hash 变 → 三份 verdict 必须重签，防「随 main 漂移」的静默失效。
  // 注意 parseArgs 的 key 保留连字符（args['source-sha']，不是 args.source_sha）。
  let sourceSha = args['source-sha'];
  if (!sourceSha) {
    try { sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch { fail('无法确定 registry 来源 ref SHA：传 --source-sha 或在 git 仓内运行'); }
  }
  const out = matchUiPaths(registry, files, { expectedRepo: args.repo });
  out.receipt = registryReceipt({ path: args.registry, registry, sourceSha });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
