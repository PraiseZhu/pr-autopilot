#!/usr/bin/env node
// provenance HMAC — 计划依据: W-3「provenance=HMAC 签名标记 + node-id ledger 仅加速」
// 审②-F7 修复: 实现真实 HMAC 签名/校验，供机器人回帖打标与 gate 过滤自家评论。
// key 来源: 环境变量 PR_AUTOPILOT_HMAC_KEY（不落盘不打日志）；fixture 可显式传 key。
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MARKER_RE = /<!-- pr-autopilot:([0-9a-f]{32}) -->/;

export function signMarker(body, key) {
  if (!key) throw new Error('缺 HMAC key（PR_AUTOPILOT_HMAC_KEY）');
  const mac = createHmac('sha256', key).update(body).digest('hex').slice(0, 32);
  return `${body}\n<!-- pr-autopilot:${mac} -->`;
}

// 返回 true = 这是我们自己签的评论（gate 应过滤，不当作新反馈）
export function verifyMarker(fullText, key) {
  if (!key) return false; // 无 key 无法验证 → 不声称是自家的（宁多唤醒）
  const m = String(fullText).match(MARKER_RE);
  if (!m) return false;
  const body = String(fullText).replace(new RegExp(`\\n?<!-- pr-autopilot:${m[1]} -->`), '');
  const expect = createHmac('sha256', key).update(body).digest('hex').slice(0, 32);
  const a = Buffer.from(m[1], 'hex'), b = Buffer.from(expect, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
