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
// drop 判据（仅此一处）: gh 失败 / 返回非数组 / 缺 headRefName / nameWithOwner 缺失或非字符串。
//   合法 dropped 不判非零（reconcile 的退出码规则见该文件头注释）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain, parseArgs, fail } from '../../scripts/lib/common.mjs';

const GH = process.env.GH_BIN ?? 'gh';

// 严格 owner/repo grammar（2026-08-08 GPT 审查修复，SC-F2 提炼复用）:
//   恰一个斜杠、两段非空、GitHub 合法形状（owner: 字母数字开头结尾、中间可连字符；
//   repo: 字母数字开头结尾、中间可连字符/下划线/点）。
//   拒: /foo、foo/、a/b/c、foo//bar、a//、空串、非字符串。
//   返回 { owner, repo }；非法即 throw（fail-closed，调用方决定落盘与否）。
export function parseRepo(repo, label = 'repo') {
  if (typeof repo !== 'string') {
    throw new Error(`${label} 非法（须 owner/repo 字符串）: ${JSON.stringify(repo)}`);
  }
  const parts = repo.split('/');
  if (parts.length !== 2) {
    throw new Error(`${label} 非法（须恰一个斜杠的 owner/repo）: ${JSON.stringify(repo)}`);
  }
  const [owner, repoName] = parts;
  if (!owner || !repoName) {
    throw new Error(`${label} 非法（owner/repo 两段均不能为空）: ${JSON.stringify(repo)}`);
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) {
    throw new Error(`${label} 非法（owner 不是 GitHub 合法用户名形状）: ${JSON.stringify(repo)}`);
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(repoName)) {
    throw new Error(`${label} 非法（repo 不是 GitHub 合法仓库名形状）: ${JSON.stringify(repo)}`);
  }
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
    if (typeof number !== 'number' || !Number.isInteger(number)) {
      dropped.push({ pr: prRef, reason: 'number 缺失或非整数' });
      continue;
    }
    const branch = row.headRefName;
    if (typeof branch !== 'string' || !branch) {
      dropped.push({ pr: prRef, reason: '缺 headRefName' });
      continue;
    }
    const nameWithOwner = row.headRepository?.nameWithOwner;
    if (typeof nameWithOwner !== 'string' || !nameWithOwner) {
      dropped.push({ pr: prRef, reason: 'headRepository.nameWithOwner 缺失或非字符串' });
      continue;
    }
    prs.push({
      owner, repo: repoName, number, branch,
      push_repo: nameWithOwner === repo ? null : nameWithOwner, // 三态: 同仓→null / fork→nameWithOwner
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
