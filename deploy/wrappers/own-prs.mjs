#!/usr/bin/env node
// 补注册 wrapper — 共识计划 T1 (SC-1a): 列出自己名下 open PR，映射补注册字段。
// 计划依据: 双仓补注册接线（reconcile 班车为生产入口；每日卡片 ownPrsCmd 为可选辅路，见 deploy/README.md 补注册段）。
// gh 调用、字段映射、三态 push_repo、drop 判据全在此一处（reconcile 零复制 import）。
// gh 命令: `gh pr list --repo <r> --author @me --state open --json number,headRefName,headRepository`
// 字段语义（owner/repo=--repo 参数，base 仓全名即真相，不取 gh 响应里的 baseRepository 字段）:
//   owner        = --repo 的 owner 段；repo = --repo 的 repo 段
//   branch       = headRefName
//   push_repo    = headRepository.nameWithOwner 字符串；缺失或非字符串 → 该条 dropped+stderr；
//                  nameWithOwner === --repo 时 push_repo=null（同仓 PR 无需 fork 绑定）
//   push_remote  = remoteMap[--repo] 映射值（reconcile 启动前已整体校验，此处仅取用）
// drop 判据（仅此一处）: gh 失败 / 返回非数组 / number 非正整数 / 缺 headRefName / branch、push_remote、
//   push_repo 未过绑定守卫（SC-FIX-3，判据单一 owner 在 git-checks.mjs）/ nameWithOwner 缺失或非字符串。
//   合法 dropped 不判非零（reconcile 的退出码规则见该文件头注释）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain, parseArgs, fail } from '../../scripts/lib/common.mjs';
import { validateBranchName, validateRemoteName, validateRepoFullName } from '../../scripts/lib/git-checks.mjs';

const GH = process.env.GH_BIN ?? 'gh';

// 严格 owner/repo grammar（2026-08-08 GPT 审查 R2 修复，SC-F2 提炼复用）:
//   判据权威在 scripts/lib/git-checks.mjs 的 validateRepoFullName（单一 owner，第 10 类
//   形态①——register.mjs 的 push_repo 校验共用同一份，禁止两处各自手拄判据）。
//   恰一个斜杠、两段非空、GitHub 合法形状（owner 用户名规则 + repo 白名单字符集，
//   拒 .. / .git 结尾 / 尾部点 / 空白控制字符）。非法即 throw（fail-closed，调用方决定落盘与否）。
export function parseRepo(repo, label = 'repo') {
  if (typeof repo !== 'string') {
    throw new Error(`${label} 非法（须 owner/repo 字符串）: ${JSON.stringify(repo)}`);
  }
  const errs = validateRepoFullName(repo, label);
  if (errs.length) throw new Error(errs[0]);
  const [owner, repoName] = repo.split('/');
  return { owner, repo: repoName };
}

// 纯函数: 列本人 open PR → 补注册契约字段。返回 { prs, dropped }。
//   prs:    [{owner,repo,number,branch,push_repo,push_remote}]（契约输出；push_repo 三态: 同仓 null / fork 字符串）
//   dropped: [{pr,reason}]（API 脏字段，调用方决定继续与否；stderr 已在此处如实标注）
export function listOwnPrs({ repo, remoteMap }) {
  const { owner, repo: repoName } = parseRepo(repo);
  if (!remoteMap || typeof remoteMap !== 'object' || Array.isArray(remoteMap)) {
    throw new Error('remoteMap 须为对象');
  }
  const alias = remoteMap[repo];
  if (typeof alias !== 'string' || alias.length === 0) {
    throw new Error(`remoteMap 缺当前 --repo 的映射（${repo}）或 alias 非字符串/空串`);
  }

  let rows;
  try {
    const out = execFileSync(
      GH,
      ['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open',
        '--json', 'number,headRefName,headRepository'],
      { encoding: 'utf8' }
    );
    rows = JSON.parse(out);
  } catch (e) {
    throw new Error(`gh pr list 失败（GH_BIN=${GH}）: ${e.message}`);
  }
  if (!Array.isArray(rows)) throw new Error('gh pr list 返回非数组（响应结构异常，fail-closed）');

  const prs = [];
  const dropped = [];
  for (const row of rows) {
    const number = row.number;
    const prRef = `${repo}#${typeof number === 'number' ? number : '?'}`;
    // SC-FIX-2 (2026-08-08): PR 号必须是正整数——0/负数/非整数生成的注册不满足引擎
    // 扫描 grammar（STATE_FILE_NAME_RE 的 PR 段 \d+），可注册不可扫 = 空转，直接 dropped。
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
      dropped.push({ pr: prRef, reason: 'number 非正整数（PR 号须 >0 的整数）' });
      continue;
    }
    const branch = row.headRefName;
    if (typeof branch !== 'string' || !branch) {
      dropped.push({ pr: prRef, reason: '缺 headRefName' });
      continue;
    }
    // SC-FIX-3 (2026-08-08): 落盘前对 branch/push_remote/push_repo 应用与 finalize.mjs
    // validateRemoteBranch 同源的绑定守卫（语法级，判据单一 owner 在 git-checks.mjs）——
    // 可注册可派发但必然无法收口（finalize 必拒绝）的空转状态不允许从数据生产侧产生。
    const branchErrs = validateBranchName(branch);
    if (branchErrs.length) {
      dropped.push({ pr: prRef, reason: `branch 未过绑定守卫: ${branchErrs.join('; ')}` });
      continue;
    }
    const remoteErrs = validateRemoteName(alias);
    if (remoteErrs.length) {
      dropped.push({ pr: prRef, reason: `push_remote 未过绑定守卫: ${remoteErrs.join('; ')}` });
      continue;
    }
    const nameWithOwner = row.headRepository?.nameWithOwner;
    if (typeof nameWithOwner !== 'string' || !nameWithOwner) {
      dropped.push({ pr: prRef, reason: 'headRepository.nameWithOwner 缺失或非字符串' });
      continue;
    }
    const pushRepo = nameWithOwner === repo ? null : nameWithOwner; // 三态: 同仓→null / fork→nameWithOwner
    if (pushRepo !== null) {
      const repoErrs = validateRepoFullName(pushRepo, 'push_repo');
      if (repoErrs.length) {
        dropped.push({ pr: prRef, reason: `push_repo 未过绑定守卫: ${repoErrs.join('; ')}` });
        continue;
      }
    }
    prs.push({
      owner, repo: repoName, number, branch,
      push_repo: pushRepo,
      push_remote: alias
    });
  }
  for (const d of dropped) {
    process.stderr.write(`[OWN-PRS] dropped ${d.pr}: ${d.reason}\n`);
  }
  return { prs, dropped };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['repo', 'remote-map-file'];
  if (need.some((k) => !args[k])) {
    fail('用法: own-prs.mjs --repo <owner/repo> --remote-map-file <path>');
  }
  let remoteMap;
  try {
    remoteMap = JSON.parse(readFileSync(args['remote-map-file'], 'utf8'));
  } catch (e) {
    fail(`remote-map 文件不可读或非法: ${e.message}`);
  }
  let result;
  try {
    result = listOwnPrs({ repo: args.repo, remoteMap });
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(JSON.stringify(result.prs) + '\n');
}
