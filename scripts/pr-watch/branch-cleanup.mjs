#!/usr/bin/env node
// merged 后远端 feature 分支清理 — owner 2026-08-01 点单。
// 这是全系统仅有的「远端删除」能力，门槛按删除类外部写从严:
//   ① 只在 PR **merged** 时被引擎调用（closed 未合并 = 分支上可能有未进主干的代码，绝不删）
//   ② 保护分支名单硬拒（main/master/develop/release* 等，任何配置不可放开）
//   ③ remote/branch 过 validateRemoteBranch——push URL 钉死 github.com + 精确 owner/repo，
//      野 host / pushurl 分离 / 非法 ref 名全拦（与 push-guard/finalize 同一套校验）
//   ④ 远端分支头必须等于被合并 PR 的 head——merge 后有人又往分支推了新提交 → 拒删（fail-closed）
//   ⑤ 远端分支已不存在（如 GitHub 仓库开了 auto-delete）→ already-gone，幂等静默
//   ⑥ 删除失败不阻塞销单（best-effort），但必须 journal 留痕，绝不静默
// exec 可注入仅为 fixture 隔离网络；生产走默认 execFileSync。
import { execFileSync } from 'node:child_process';
import { validateRemoteBranch } from '../lib/git-checks.mjs';

const PROTECTED = /^(main|master|develop|dev|release(\/.*)?|deploy\/green)$/;
const defaultExec = (argv, opts = {}) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30_000, ...opts });

export function cleanupRemoteBranch({ repoDir, remote, branch, repoFullName, expectedHeadSha, exec = defaultExec }) {
  if (!branch || !remote) return { deleted: false, skipped: true, reason: '缺 branch/remote（不猜不删）' };
  if (PROTECTED.test(branch)) return { deleted: false, skipped: true, reason: `保护分支「${branch}」永不删除（硬名单）` };
  const errs = validateRemoteBranch({ repoDir, remote, branch, repoFullName });
  if (errs.length) return { deleted: false, skipped: true, reason: `remote/branch 校验未过: ${errs[0]}` };
  if (!/^[0-9a-f]{40}$/.test(String(expectedHeadSha ?? ''))) {
    return { deleted: false, skipped: true, reason: 'expectedHeadSha 非法（无 PR head 锚点不删）' };
  }
  // ④ 远端头锚定: ls-remote 精确 ref
  let lsOut;
  try {
    lsOut = exec(['git', '-C', repoDir, 'ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  } catch (e) {
    return { deleted: false, skipped: true, reason: `ls-remote 失败（fail-closed 不删）: ${e.message}` };
  }
  const line = String(lsOut).split('\n').filter(Boolean)[0] ?? null;
  if (!line) return { deleted: false, skipped: true, reason: 'already-gone（远端分支已不存在，幂等）', alreadyGone: true };
  const remoteSha = line.split(/\s+/)[0];
  if (remoteSha !== expectedHeadSha) {
    return { deleted: false, skipped: true, reason: `远端分支头 ${remoteSha.slice(0, 12)} ≠ 被合并 PR head ${expectedHeadSha.slice(0, 12)}——merge 后有新提交，拒删（fail-closed）` };
  }
  const argv = ['git', '-C', repoDir, 'push', remote, '--delete', branch];
  exec(argv); // 失败即抛，由调用方 journal（不静默）
  return { deleted: true, skipped: false, reason: `已删除 ${remote}/${branch}`, argv };
}
