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

export function validateRemoteBranch({ repoDir, remote, branch, repoFullName, allowedHosts = DEFAULT_HOSTS }) {
  const errors = [];
  const r = String(remote ?? '');
  if (/^[-+]/.test(r) || r === '') errors.push(`remote 名非法（拒前导 -/+）: ${remote}`);
  else {
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
  const b = String(branch ?? '');
  if (/^[-+]/.test(b) || b === '') errors.push(`branch 非法（拒前导 -/+）: ${branch}`);
  else {
    try { execFileSync('git', ['check-ref-format', '--branch', b], { encoding: 'utf8' }); }
    catch { errors.push(`branch 未过 git check-ref-format: ${branch}`); }
  }
  return errors;
}
