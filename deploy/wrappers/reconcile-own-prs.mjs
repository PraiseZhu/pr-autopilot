#!/usr/bin/env node
// 补注册班车生产入口 — 共识计划 T1 (SC-1a2)。每仓一条 15 分钟 schedule：
// mivo → state-mivo、cindy → state-cindy（schedule 接法见 deploy/README.md 补注册段）。
// listOwnPrs 零复制 import（gh 调用/字段映射/三态 push_repo/drop 判据全在 own-prs.mjs 一处）；
// 逐条 import registerPr 注册进 --state-dir（registerPr 幂等，高频重跑安全）。
//
// fail-closed 分层:
//   ① 启动前非零 —— remote-map 文件不可读 / JSON 非对象 / 缺当前 --repo key / alias 非法或空串
//   ② 逐 PR 可容忍 —— API 脏字段 → dropped + warning（stderr）继续；合法 dropped 不判非零
//   ③ registerPr 异常（含在途 dispatch 接线变化——registerPr 的 wiringChanged && pending_dispatch
//      迁移拒绝 throw）→ errors 记明细且该轮非零
// 退出码: 配置错 / gh 失败 / errors 非空 → 非零；其余（含合法 dropped）→ 0
// 输出 JSON 四明细: {registered:[prKey...], already:[prKey...], dropped:[{pr,reason}...], errors:[{pr,reason}...]}
import { mkdirSync, readFileSync } from 'node:fs';
import { isMain, parseArgs, fail } from '../../scripts/lib/common.mjs';
import { registerPr } from '../../scripts/pr-watch/register.mjs';
import { listOwnPrs, parseRepo } from './own-prs.mjs';
import { validateRemoteName } from '../../scripts/lib/git-checks.mjs';

// ①层启动校验: 读 map 并整体校验（结构 + 全部 alias 非空字符串 + 缺当前 --repo key 即报错）。
// 所有 key 也要求严格 owner/repo 形状（parseRepo grammar 复用，own-prs.mjs 导出）——
// /foo、foo/、多斜杠、非法字符的 key 一律启动前拒绝（fail-closed，无 state 落盘）。
// SC-FIX-3 (2026-08-08): alias（push_remote 来源）过 validateRemoteName 绑定守卫（与
// finalize.mjs validateRemoteBranch 同源，单一 owner 在 git-checks.mjs）——'bad remote'
// 这类非法 remote 名在启动前整体拒绝，不逐 PR dropped 也不落任何 state。
export function loadRemoteMap(file, repo) {
  parseRepo(repo, '--repo'); // CLI 入口 fail-closed: 非法 repo 在任何 state 落盘之前拒绝
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`remote-map 文件不可读: ${e.message}`); }
  let map;
  try { map = JSON.parse(raw); }
  catch (e) { throw new Error(`remote-map 不是合法 JSON: ${e.message}`); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('remote-map 须为 JSON 对象 {"owner/repo":"alias"}');
  }
  for (const [k, v] of Object.entries(map)) {
    try { parseRepo(k, `remote-map key`); }
    catch (e) { throw new Error(`remote-map ${e.message}`); }
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`remote-map alias 非法或空串: ${k}=${JSON.stringify(v)}`);
    }
    const remoteErrs = validateRemoteName(v);
    if (remoteErrs.length) {
      throw new Error(`remote-map alias 未过绑定守卫: ${k}=${JSON.stringify(v)}（${remoteErrs.join('; ')}）`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(map, repo)) {
    throw new Error(`remote-map 缺当前 --repo 的 key: ${repo}`);
  }
  return map;
}

// 核心: 列本人 open PR → 逐条注册。返回四明细（dropped 从 listOwnPrs 带出，errors 仅 registerPr 层）。
export function reconcileOwnPrs({ repo, stateDir, remoteMap }) {
  const { prs, dropped } = listOwnPrs({ repo, remoteMap });
  const registered = [];
  const already = [];
  const errors = [];
  for (const pr of prs) {
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    try {
      const r = registerPr({
        stateDir, owner: pr.owner, repo: pr.repo, prNumber: pr.number,
        branch: pr.branch, pushRepo: pr.push_repo, pushRemote: pr.push_remote,
        registeredBy: 'reconcile-shuttle'
      });
      (r.already ? already : registered).push(prKey);
    } catch (e) {
      errors.push({ pr: prKey, reason: e.message });
    }
  }
  return { registered, already, dropped, errors };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['repo', 'state-dir', 'remote-map-file'];
  if (need.some((k) => !args[k])) {
    fail('用法: reconcile-own-prs.mjs --repo <owner/repo> --state-dir <dir> --remote-map-file <path>');
  }
  let remoteMap;
  try { remoteMap = loadRemoteMap(args['remote-map-file'], args.repo); }
  catch (e) { fail(`配置错误: ${e.message}`); }
  mkdirSync(args['state-dir'], { recursive: true });
  let result;
  try { result = reconcileOwnPrs({ repo: args.repo, stateDir: args['state-dir'], remoteMap }); }
  catch (e) { fail(`reconcile 失败: ${e.message}`); } // gh 失败/响应结构异常 → 非零
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.errors.length > 0) process.exit(1);
}
