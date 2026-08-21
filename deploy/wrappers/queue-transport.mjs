#!/usr/bin/env node
// 队列握手 transport — P0-⑦ 定案的 CINDY_DISPATCH_CMD 实现（mini 班车形态）
// 架构: 盯梢班车 = Cindy scheduler 的 agent 模式 schedule（claude-code + Cindy AI +
// z-ai/glm-5.2 + max）。班车会话后台跑 engine；engine → cindy-dispatch.mjs →
// 本脚本（stdin=投递文本）:
//   1. 从文本首行解析 dispatch_id（【pr-autopilot 修复任务 <id>】）
//   2. 文本原子落 queue/<id>.task.txt
//   3. 轮询 queue/<id>.receipt.json —— 由班车会话消费队列、经 send_to_session
//      创建修复会话（create 模式克隆班车自身 agent/model/effort = 四元组保证）后写入
//   4. 拿到 receipt 原样输出 stdout（cindy-dispatch 校验 session_id + 四元组），
//      清理 task/receipt 文件
//   5. 超时无 receipt = 非零退出（引擎 at-least-once: 预留释放 + 下轮重试）
// 本脚本零猜测: 不碰 Cindy 内部 API，唯一环境耦合是「班车会话会写 receipt」这个契约。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUEUE_DIR = join(HERE, '..', '..', '_runtime', 'dispatch-queue');
const QUEUE_DIR = process.env.PR_AUTOPILOT_QUEUE_DIR ?? DEFAULT_QUEUE_DIR;
// 超时硬边界 [5s, 300s]——审⑩-P2-2 同款纪律: 0/NaN/超大 env 不得关闭有界性
let timeoutMs = 240_000;
if (process.env.PR_AUTOPILOT_QUEUE_TIMEOUT_MS !== undefined) {
  const n = Number(process.env.PR_AUTOPILOT_QUEUE_TIMEOUT_MS);
  if (!Number.isInteger(n) || n < 5_000 || n > 300_000) {
    process.stderr.write(`[QUEUE-TRANSPORT] PR_AUTOPILOT_QUEUE_TIMEOUT_MS 非法（"${process.env.PR_AUTOPILOT_QUEUE_TIMEOUT_MS}"）——必须 [5000,300000] 整数（fail-closed）\n`);
    process.exit(1);
  }
  timeoutMs = n;
}

const text = readFileSync(0, 'utf8');
const m = text.match(/【pr-autopilot 修复任务 ([a-f0-9]{16})】/);
if (!m) {
  process.stderr.write('[QUEUE-TRANSPORT] 投递文本缺 dispatch_id 标头（非 cindy-dispatch 产物？fail-closed）\n');
  process.exit(1);
}
const id = m[1];
mkdirSync(QUEUE_DIR, { recursive: true });
const taskFile = join(QUEUE_DIR, `${id}.task.txt`);
const receiptFile = join(QUEUE_DIR, `${id}.receipt.json`);
try { unlinkSync(receiptFile); } catch { /* 无陈旧回执 */ }
const tmp = `${taskFile}.tmp-${process.pid}`;
writeFileSync(tmp, text);
renameSync(tmp, taskFile); // 原子: 班车绝不读到半个任务

const deadline = Date.now() + timeoutMs;
for (;;) {
  if (existsSync(receiptFile)) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')); }
    catch { execFileSync('sleep', ['0.2']); continue; } // 写到一半，下一拍再读
    // 清理后原样转交——真伪校验（session_id + 四元组 exact match）在 cindy-dispatch.mjs
    try { unlinkSync(taskFile); } catch { /* 班车已清 */ }
    try { unlinkSync(receiptFile); } catch { /* 幂等 */ }
    process.stdout.write(JSON.stringify(receipt) + '\n');
    process.exit(0);
  }
  if (Date.now() > deadline) {
    try { unlinkSync(taskFile); } catch { /* 防陈旧任务被晚到班车重复投递 */ }
    process.stderr.write(`[QUEUE-TRANSPORT] ${timeoutMs}ms 内无班车回执（班车未跑/未消费）——投递失败，引擎下轮重试\n`);
    process.exit(1);
  }
  execFileSync('sleep', ['0.5']);
}
