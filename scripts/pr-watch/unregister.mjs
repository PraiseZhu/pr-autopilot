#!/usr/bin/env node
// 销单 CLI — 计划依据: W-5（终态: merged/closed → 销单 + 清理，绝不合并）
import { parseArgs, fail, isMain} from '../lib/common.mjs';
import { unregisterPr } from './register.mjs';

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['state-dir', 'owner', 'repo', 'pr'];
  if (need.some((k) => !args[k])) fail('用法: unregister.mjs --state-dir <dir> --owner <o> --repo <r> --pr <N> [--reason merged|closed|manual] [--journal <file>]');
  const res = unregisterPr({
    stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr,
    reason: args.reason, journalFile: args.journal
  });
  process.stdout.write(res.removed ? 'UNREGISTERED\n' : 'NOT-FOUND（幂等: 已销单）\n');
}
