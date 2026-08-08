#!/usr/bin/env node
// remote/branch 共享校验 — 审③-F3-R + 审④-F1:
//   - remote 名拒前导 -/+
//   - 校验 **全部实际 push URL**（git remote get-url --push --all）——fetch URL 合法
//     但 pushurl 指向别处的分离攻击被拦
//   - URL 必须是「允许 host + 精确 owner/repo」——evil.example/owner/repo.git 不再过
//   - branch 经 git check-ref-format --branch
import { execFileSync } from 'node:child_process';

const DEFAULT_HOSTS = ['github.com'];

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' }).trim(); }

// 解析三种形态: https://host/owner/repo(.git) / git@host:owner/repo(.git) / ssh://git@host/owner/repo(.git)
export function parseGitUrl(url) {
  const s = String(url).trim();
  let m = s.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (m) return { host: m[1].toLowerCase(), path: m[2] };
  m = s.match(/^(?:[^@/]+@)?([^/:]+):(.+?)(?:\.git)?\/?$/);
  if (m && !s.includes('://')) return { host: m[1].toLowerCase(), path: m[2] };
  return null;
}

export function urlMatchesRepo(url, repoFullName, allowedHosts = DEFAULT_HOSTS) {
  const p = parseGitUrl(url);
  if (!p) return false;
  return allowedHosts.includes(p.host) && p.path === repoFullName;
}

// SC-FIX-3 (2026-08-08): branch/remote 名语法判据拆为纯静态导出（单一 owner），供
// own-prs/reconcile/register 注册侧在落盘前复用同一判据（第 10 类形态①: 同一语义不得
// 两份独立定义）。语法级校验不需要 repoDir（git check-ref-format 静态可判）；
// 「在已配置列表 / push URL 匹配」等绑定校验仍只在 validateRemoteBranch（finalize 侧）做。
// 安全性: git remote add 自身拒绝非法 remote 名——任何真实配置过的 remote 名必然通过
// refs/remotes/<name>/HEAD 语法检查，语法守卫不会误伤已配置 remote。
export function validateBranchName(branch) {
  const errors = [];
  const b = String(branch ?? '');
  if (b === '' || /^[-+]/.test(b)) errors.push(`branch 非法（拒前导 -/+）: ${branch}`);
  else {
    try { execFileSync('git', ['check-ref-format', '--branch', b], { encoding: 'utf8' }); }
    catch { errors.push(`branch 未过 git check-ref-format: ${branch}`); }
  }
  return errors;
}

// owner/repo 全名语法判据（单一 owner）——own-prs.mjs 的 parseRepo 与 register.mjs 的
// push_repo 校验共用同一份定义，禁止两处各自手拄判据（第 10 类形态①）。判据与
// parseRepo 原有 grammar 逐字一致（2026-08-08 GPT R2，SC-F2 提炼）: 恰一个斜杠、两段非空、
// owner 为 GitHub 用户名形状、repo 为 GitHub 合法仓库名形状（白名单字符集 + 拒 ../.git/尾部点）。
export function validateRepoFullName(repoFullName, label = 'repo') {
  const errors = [];
  const s = String(repoFullName ?? '');
  const parts = s.split('/');
  if (parts.length !== 2) {
    errors.push(`${label} 非法（须恰一个斜杠的 owner/repo）: ${JSON.stringify(repoFullName)}`);
    return errors;
  }
  const [owner, repoName] = parts;
  if (!owner || !repoName) {
    errors.push(`${label} 非法（owner/repo 两段均不能为空）: ${JSON.stringify(repoFullName)}`);
    return errors;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) {
    errors.push(`${label} 非法（owner 不是 GitHub 合法用户名形状）: ${JSON.stringify(repoFullName)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName.includes('..') || repoName.endsWith('.git') || repoName.endsWith('.')) {
    errors.push(`${label} 非法（repo 不是 GitHub 合法仓库名形状）: ${JSON.stringify(repoFullName)}`);
  }
  return errors;
}

export function validateRemoteName(remote) {
  const errors = [];
  const r = String(remote ?? '');
  if (r === '' || /^[-+]/.test(r)) errors.push(`remote 名非法（拒前导 -/+）: ${remote}`);
  else {
    try { execFileSync('git', ['check-ref-format', `refs/remotes/${r}/HEAD`], { encoding: 'utf8' }); }
    catch { errors.push(`remote 名未过 git check-ref-format: ${remote}`); }
  }
  return errors;
}

export function validateRemoteBranch({ repoDir, remote, branch, repoFullName, allowedHosts = DEFAULT_HOSTS }) {
  const errors = [];
  errors.push(...validateRemoteName(remote));
  if (errors.length === 0) {
    const r = String(remote ?? '');
    const remotes = git(repoDir, 'remote').split('\n').filter(Boolean);
    if (!remotes.includes(r)) errors.push(`remote「${r}」不在已配置列表 [${remotes.join(',')}]`);
    else if (repoFullName) {
      // 审④-F1: 枚举全部实际 push URL（含 pushurl 覆盖），逐一校验 host+repo
      let urls = [];
      try {
        urls = git(repoDir, 'remote', 'get-url', '--push', '--all', '--', r).split('\n').filter(Boolean);
      } catch { errors.push(`remote「${r}」push URL 读取失败（fail-closed）`); }
      if (urls.length === 0) errors.push(`remote「${r}」无 push URL（fail-closed）`);
      for (const url of urls) {
        if (!urlMatchesRepo(url, repoFullName, allowedHosts)) {
          errors.push(`remote「${r}」的 push URL 不是 ${allowedHosts.join('/')} 上的 ${repoFullName}（实际 ${url}）——pushurl 分离/野 host 被拦`);
        }
      }
    }
  }
  errors.push(...validateBranchName(branch));
  return errors;
}
