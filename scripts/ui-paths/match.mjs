#!/usr/bin/env node
// UI 判定唯一源 — 计划依据: §1.1b ⑫
// 确定性脚本产出 { touches_ui, matched_paths, config_hash } 写入 review bundle；
// reviewer 无自判权；demo 证据预检复用同一结果。
import { readFileSync } from 'node:fs';
import { readJson, parseArgs, fail, hashObject, isMain} from '../lib/common.mjs';
import { globToRe } from '../push-guard.mjs';

export function matchUiPaths(registry, changedFiles) {
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

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.registry || !args.files) {
    fail('用法: match.mjs --registry <registry.json> --files <每行一个路径的文件|- 表示 stdin>');
  }
  const registry = readJson(args.registry);
  const raw = args.files === '-' ? readFileSync(0, 'utf8') : readFileSync(args.files, 'utf8');
  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  process.stdout.write(JSON.stringify(matchUiPaths(registry, files), null, 2) + '\n');
}
