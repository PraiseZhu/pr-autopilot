#!/usr/bin/env node
// 飞书直连告警 — 计划依据: W-7/W-8（owner 个人通知走飞书；不经 Cindy notifier，
// 保住「Cindy 整体死掉也能叫人」的独立性）
// 凭证来源（按序）: FEISHU_WEBHOOK_URL（自定义机器人 webhook，最简）
//                → FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_OWNER_OPEN_ID（bot API）
// 红线: 凭证不落库不打日志（P0-⑫）；凭证不可得 → 退出码 4，由 lease-check 降级 Slack。
// 消息正文从 stdin 读。
import { readFileSync } from 'node:fs';

async function sendViaWebhook(url, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } })
  });
  if (!res.ok) throw new Error(`webhook http ${res.status}`);
  const body = await res.json();
  if (body.code && body.code !== 0) throw new Error(`webhook code ${body.code}`);
}

async function sendViaBotApi(appId, appSecret, openId, text) {
  const tokRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const tok = await tokRes.json();
  if (!tok.tenant_access_token) throw new Error('拿不到 tenant_access_token');
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.tenant_access_token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) })
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`im/v1/messages code ${body.code}`);
}

const text = readFileSync(0, 'utf8').trim();
if (!text) { process.stderr.write('[FEISHU] 空消息拒发\n'); process.exit(1); }

const webhook = process.env.FEISHU_WEBHOOK_URL;
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const openId = process.env.FEISHU_OWNER_OPEN_ID;

try {
  if (webhook) await sendViaWebhook(webhook, text);
  else if (appId && appSecret && openId) await sendViaBotApi(appId, appSecret, openId, text);
  else {
    process.stderr.write('[FEISHU] 凭证不可得（launchd 环境未注入）→ 调用方应降级 Slack 并注明降级\n');
    process.exit(4);
  }
  process.stdout.write('sent\n');
} catch (e) {
  process.stderr.write(`[FEISHU] 发送失败: ${e.message}\n`); // 只打错误类别，不回显凭证
  process.exit(1);
}
