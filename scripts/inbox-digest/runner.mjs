#!/usr/bin/env node
// 每日卡片 orchestrator v2 — 计划依据: §3.1 全链
// 审③-F9-R 修复:
//   ① 预检**先行**: matrix 的 state/closed_by_other/blocking_others 合并回通知后
//     才 classify/sort（预检纠正错误分桶与排序）
//   ② 渲染输出按 source_id 映射后**严格按 input 顺序重组**——DeepSeek 重排无效
//   ③ overflow 游标**先消费后写**: 上轮未发条目本轮置顶补发（跨日 since 窗口丢失免疫）
//   ④ send payload 结构化 JSON {text, lines:[{n, sentence, url, source_id, anomaly}]}，
//     发送 adapter 用 url 构造可点卡片
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from '../lib/common.mjs';
import { collect } from './collect.mjs';
import { validateRender, fallbackRender } from './render-validate.mjs';
import { registerPr } from '../pr-watch/register.mjs';

const MAX_CHARS = 6000;

function run(cmd, stdinData) {
  const parts = cmd.split(' ');
  return execFileSync(parts[0], parts.slice(1), { encoding: 'utf8', input: stdinData });
}
function journal(file, rec) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: nowIso(), ...rec }) + '\n');
}

export function runDigest(cfg) {
  const {
    fetchCmd, preflightCmd = null, markReadCmd = null, ownPrsCmd = null,
    renderCmd = null, sendCmd,
    stateDir = null, markedReadFile = null, journalFile = null, cursorFile = null,
    strict = true
  } = cfg;
  // 审④-F8: 生产模式（strict，默认）配置全必填——静默缺失会砍掉预检/标已读/补注册/游标闭环
  if (strict) {
    const requiredCfg = { fetchCmd, sendCmd, preflightCmd, markReadCmd, ownPrsCmd, stateDir, markedReadFile, journalFile, cursorFile };
    const missing = Object.entries(requiredCfg).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`digest 配置缺失: ${missing.join(',')}（strict 默认 fail-closed；单元 fixture 可显式 strict:false）`);
  }
  const report = { items: 0, carried_over: 0, preflight_anomalies: 0, reconciled: [], render_source: null, sent: false, heartbeat: false, overflow: false };

  // 1. 采集
  let notifications = JSON.parse(run(fetchCmd));

  // ①' 预检先行: 合并矩阵字段回通知（错误桶被纠正后才分桶）
  const anomalies = new Set();
  if (preflightCmd && notifications.length) {
    let matrix = null;
    try { matrix = JSON.parse(run(preflightCmd, JSON.stringify(notifications.map((n) => String(n.id))))); }
    catch (e) { journal(journalFile, { kind: 'preflight-error', error: e.message }); }
    if (matrix) {
      notifications = notifications.filter((n) => {
        const p = matrix[String(n.id)];
        if (!p) { anomalies.add(String(n.id)); return true; } // 缺失 = 异常保留并标注
        if (p.exists === false) { journal(journalFile, { kind: 'preflight-drop', id: n.id }); return false; }
        // 预检事实覆盖通知自带字段（预检是 API 实况，更可信）
        for (const k of ['closed_by_other', 'blocking_others']) if (k in p) n[k] = p[k];
        if (p.state) n.subject = { ...n.subject, state: p.state };
        return true;
      });
    } else {
      for (const n of notifications) anomalies.add(String(n.id));
    }
  }

  // 2. 分桶 + 确定性排序（预检合并后）
  const collected = collect({ notifications, markedReadFile });
  let items = collected.items;
  for (const i of items) if (anomalies.has(i.source_id)) { i.preflight = 'anomaly'; report.preflight_anomalies++; }

  // ③' 消费上轮 overflow 游标: 未发条目置顶（去重）
  if (cursorFile && existsSync(cursorFile)) {
    try {
      const prev = readJson(cursorFile);
      // 审⑤-I4: 结构校验——游标在但形态不对同样视为损坏
      if (prev.overflow_items !== undefined && !Array.isArray(prev.overflow_items)) {
        throw new Error('cursor.overflow_items 非数组（结构损坏）');
      }
      const seen = new Set(items.map((i) => i.source_id));
      const carried = (prev.overflow_items ?? []).filter((i) => !seen.has(i.source_id));
      items = [...carried, ...items];
      report.carried_over = carried.length;
      // 审④-F8: 此处**不清**游标——send 成功后统一 commit；发送失败/进程崩溃游标原样
    } catch (e) {
      // 审⑤-I4: strict（生产）下损坏游标 = 阻断发送并保留原文件——
      // 「读不出就当无遗留」会让 send 成功后的 commit 覆盖旧游标，overflow 永久丢失
      if (strict) throw new Error(`overflow 游标存在但不可读/结构非法（${e.message}）——阻断发送、保留原文件，owner 人工核账后再跑（审⑤-I4 fail-closed）`);
      journal(journalFile, { kind: 'cursor-error', error: e.message });
    }
  }
  report.items = items.length;

  // 3. D 桶真实标已读（失败不阻塞）
  if (markReadCmd && collected.noise_marked_read > 0) {
    try { run(markReadCmd, readFileSync(markedReadFile, 'utf8')); }
    catch (e) { journal(journalFile, { kind: 'mark-read-error', error: e.message }); }
  }

  // 4. 补注册（旁路 PR 24h SLO）
  if (ownPrsCmd && stateDir) {
    try {
      const prs = JSON.parse(run(ownPrsCmd));
      for (const pr of prs) {
        // 审⑤-F4: registerPr 现在对缺 branch/push_remote fail-closed——单 PR 失败记 journal 不拖垮整卡
        try {
          const r = registerPr({ stateDir, owner: pr.owner, repo: pr.repo, prNumber: pr.number, branch: pr.branch, pushRepo: pr.push_repo, pushRemote: pr.push_remote, registeredBy: 'daily-digest-reconcile' });
          if (!r.already) report.reconciled.push(`${pr.owner}/${pr.repo}#${pr.number}`);
        } catch (e) { journal(journalFile, { kind: 'reconcile-error', pr: `${pr.owner}/${pr.repo}#${pr.number}`, error: e.message }); }
      }
    } catch (e) { journal(journalFile, { kind: 'reconcile-error', error: e.message }); }
  }

  // 5. 渲染（重试 1 次 → fallback；绝不发未过验输出）
  let renderedById = null;
  if (items.length) {
    const renderInput = items.map((i) => ({ source_id: i.source_id, sentence: `${i.kind}|${i.repo}|${i.title}|${i.state}` }));
    let rendered = null;
    if (renderCmd) {
      for (let attempt = 1; attempt <= 2 && !rendered; attempt++) {
        try {
          const out = JSON.parse(run(renderCmd, JSON.stringify(renderInput)));
          const v = validateRender(items, out);
          if (v.ok) { rendered = out; report.render_source = `deepseek(attempt ${attempt})`; }
          else journal(journalFile, { kind: 'render-invalid', attempt, errors: v.errors.slice(0, 5) });
        } catch (e) { journal(journalFile, { kind: 'render-error', attempt, error: e.message }); }
      }
    }
    if (!rendered) {
      rendered = fallbackRender(items);
      const v = validateRender(items, rendered);
      if (!v.ok) throw new Error(`fallback 模板自身未过验（不可能态，阻断发送）: ${v.errors[0]}`);
      report.render_source = 'fallback';
    }
    // ②' 按 source_id 映射，严格 input（=脚本排序）顺序重组
    renderedById = new Map(rendered.map((r) => [r.source_id, r.sentence]));
  }

  // 6. 组卡（结构化 payload）+ overflow + 发送
  let lines;
  if (!items.length) {
    lines = [{ n: 1, sentence: '今天没活。收件箱里没有需要你处理的事项。', url: null, source_id: null, anomaly: false }];
    report.heartbeat = true;
  } else {
    lines = items.map((it, idx) => ({
      n: idx + 1,
      sentence: renderedById.get(it.source_id),
      url: it.url ?? null,
      source_id: it.source_id,
      anomaly: it.preflight === 'anomaly'
    }));
  }
  const lineText = (l) => `${l.n}. ${l.sentence}${l.anomaly ? '（预检异常，以链接实况为准）' : ''}`;
  let textLines = lines.map(lineText);
  let text = textLines.join('\n');
  let sendLines = lines;
  if (text.length > MAX_CHARS) {
    let cut = 0, total = 0;
    for (const l of textLines) { if (total + l.length + 1 > MAX_CHARS - 60) break; total += l.length + 1; cut++; }
    const remaining = lines.length - cut;
    sendLines = lines.slice(0, cut);
    text = textLines.slice(0, cut).join('\n') + `\n（还有 ${remaining} 条明天置顶补发，未丢失）`;
    report.overflow = true;
  }
  run(sendCmd, JSON.stringify({ text, lines: sendLines }));
  report.sent = true;
  // 审④-F8: send 成功才 commit 游标（overflow 存余量 / 无 overflow 清空）
  if (cursorFile) {
    const spill = report.overflow ? items.slice(sendLines.length) : [];
    writeJsonAtomic(cursorFile, { at: nowIso(), overflow_items: spill });
  }
  journal(journalFile, { kind: 'card-sent', items: report.items, carried_over: report.carried_over, source: report.render_source, heartbeat: report.heartbeat, overflow: report.overflow });
  return report;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) fail('用法: runner.mjs --config <digest.json>');
  const res = runDigest(readJson(args.config));
  process.stdout.write(JSON.stringify(res) + '\n');
}
