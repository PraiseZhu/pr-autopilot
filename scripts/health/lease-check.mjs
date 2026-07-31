#!/usr/bin/env node
// 引擎健康检查（独立于 Cindy 调度器）— 计划依据: W-7
// 审②-I3 修复: 降级链真实实现——
//   飞书成功 → exit 2（有引擎死且已告警）
//   飞书凭证不可得（feishu-alert exit 4）→ 走 Slack 降级命令，消息强制注明降级通道 → exit 2
//   飞书发送失败（其他非零）→ 也尝试 Slack 降级 → exit 2
//   两条通道都失败 → exit 3（最坏情况，launchd 日志可见）
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readJson, parseArgs, fail, isMain} from '../lib/common.mjs';

export function checkLeases({ leases, ttlMinutes = 45, now = Date.now() }) {
  const dead = [];
  for (const l of leases) {
    if (!existsSync(l.file)) { dead.push({ name: l.name, why: 'lease 文件不存在（引擎从未跑起 or 被删）' }); continue; }
    let lease;
    try { lease = readJson(l.file); } catch { dead.push({ name: l.name, why: 'lease 文件损坏（fail-closed 视为死）' }); continue; }
    const age = (now - Date.parse(lease.last_success)) / 60000;
    if (!(age >= 0) || age > ttlMinutes) dead.push({ name: l.name, why: `lease 过期 ${age.toFixed(0)} 分钟 > TTL ${ttlMinutes}` });
  }
  return dead;
}

function trySend(cmdParts, message) {
  try {
    execFileSync(cmdParts[0], cmdParts.slice(1), { input: message, encoding: 'utf8', stdio: ['pipe', 'ignore', 'inherit'] });
    return { ok: true, code: 0 };
  } catch (e) {
    return { ok: false, code: e.status ?? 1 };
  }
}

// 导出供 fixture 直测降级决策（发送器注入）
export function alertWithFallback({ message, feishuCmd, slackCmd }) {
  const f = trySend(feishuCmd, message);
  if (f.ok) return { channel: 'feishu', ok: true };
  const degraded = `【降级通道·飞书不可用(code=${f.code}${f.code === 4 ? '/凭证不可得' : ''})】\n${message}`;
  if (slackCmd) {
    const s = trySend(slackCmd, degraded);
    if (s.ok) return { channel: 'slack-degraded', ok: true };
  }
  return { channel: 'none', ok: false };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) fail('用法: lease-check.mjs --config <health.json> [--now-iso <iso>]');
  const cfg = readJson(args.config); // { leases:[{name,file}], ttl_minutes, feishu_cmd?, slack_cmd? }
  const dead = checkLeases({
    leases: cfg.leases,
    ttlMinutes: cfg.ttl_minutes ?? 45,
    now: args['now-iso'] ? Date.parse(args['now-iso']) : Date.now()
  });
  if (dead.length === 0) { process.stdout.write('healthy\n'); process.exit(0); }

  const message = `【引擎健康告警】pr-autopilot 盯梢引擎异常:\n` +
    dead.map((d) => `- ${d.name}: ${d.why}`).join('\n') +
    `\n在飞 PR 可能无人盯，请检查 mini 上的 Cindy 调度。`;

  const feishuCmd = (cfg.feishu_cmd ?? `node ${new URL('./feishu-alert.mjs', import.meta.url).pathname}`).split(' ');
  const slackCmd = cfg.slack_cmd ? cfg.slack_cmd.split(' ') : null;
  const res = alertWithFallback({ message, feishuCmd, slackCmd });
  if (!res.ok) {
    process.stderr.write('[HEALTH] 飞书与 Slack 降级通道均失败\n');
    process.exit(3);
  }
  process.stdout.write(`alerted via ${res.channel}\n`);
  process.exit(2);
}
