#!/usr/bin/env node
// 通知分层路由 — 计划依据: W-8（owner 2026-07-31 定案）+ W-6（审②-F13）
// Slack = 项目级广播；飞书 = owner 个人通知。
// 规则（机器判，不由调用会话自选通道）:
//   budget-pause / health / arbitration / mivo-stuck / security-repeat → feishu
//   broadcast → slack
//   cindy-stuck → silent（不产生任何通知，只由调用方记台账；与 W-8 不互相覆盖）
// 发送器注入式: {feishuCmd, slackCmd}（真机: health/feishu-alert.mjs 与 notify.mjs 包装）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs, fail, isMain} from '../lib/common.mjs';

const ROUTES = {
  'budget-pause': 'feishu',
  'health': 'feishu',
  'arbitration': 'feishu',
  'security-repeat': 'feishu',
  'daily-card': 'feishu',
  'broadcast': 'slack',
  'stuck': null // 按 repo 细分，见 route()
};

// canonical cindy 判定（2026-08-08 GPT 审查修复，W-6 收窄）:
//   裸 repo 名（旧调用/部署只传 repo 段）→ 只认字面 'cindy'，不再用 /cindy/i 子串猜身份——
//   'my-cindy-app' 之类含 cindy 子串的 repo 不再被误静音；
//   owner/repo 全名（engine 现传 `${owner}/${repo}`）→ 只认 canonical makecindy/cindy，
//   PraiseZhu/pr-autopilot、evilorg/cindy 等一律不判 cindy。
export const CINDY_CANONICAL_REPO = 'makecindy/cindy';

export function isCindyRepo(repo) {
  if (typeof repo !== 'string' || repo.length === 0) return false;
  return repo.includes('/') ? repo === CINDY_CANONICAL_REPO : repo === 'cindy';
}

export function route(eventType, { repo } = {}) {
  // T3/SC-3a: pending-stuck 与 stuck 同通道（cindy=silent / mivo=feishu）——不落 ROUTES，
  // 否则 null 值会撞下方「未知事件类型」fail-closed
  if (eventType === 'stuck' || eventType === 'pending-stuck') {
    if (isCindyRepo(repo)) return 'silent'; // W-6: canonical cindy PR 卡死不打扰
    return 'feishu'; // 其余仓 PR 卡死飞书点名
  }
  const ch = ROUTES[eventType];
  if (!ch) throw new Error(`未知通知事件类型: ${eventType}（fail-closed，不猜通道）`);
  return ch;
}

export function send({ eventType, repo, message, feishuCmd, slackCmd }) {
  const channel = route(eventType, { repo });
  if (channel === 'silent') return { channel, sent: false };
  const cmd = channel === 'feishu' ? feishuCmd : slackCmd;
  if (!cmd) throw new Error(`通道 ${channel} 未配置发送命令（fail-closed）`);
  const parts = cmd.split(' ');
  execFileSync(parts[0], parts.slice(1), { input: message, encoding: 'utf8' });
  return { channel, sent: true };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.type) fail('用法: notify-router.mjs --type <event> [--repo r] [--feishu-cmd c] [--slack-cmd c] < message');
  const message = readFileSync(0, 'utf8');
  const res = send({ eventType: args.type, repo: args.repo, message, feishuCmd: args['feishu-cmd'], slackCmd: args['slack-cmd'] });
  process.stdout.write(JSON.stringify(res) + '\n');
}
