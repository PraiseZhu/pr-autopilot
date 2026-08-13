#!/usr/bin/env node
// scripts/detect-assertion-weakening.mjs — 检测 diff 中删除/跳过/放宽测试断言
//
// 架构: 纯函数导出 (detectAssertionWeakening) + CLI 薄包装
//
// 使用:
//   node scripts/detect-assertion-weakening.mjs --diff <diff_file>   # 检测指定 diff 文件
//   node scripts/detect-assertion-weakening.mjs --diff <diff_file> --json  # JSON 输出
//   node scripts/detect-assertion-weakening.mjs --dry-run  # 输出可行性研究报告
//   node scripts/detect-assertion-weakening.mjs --self-test  # 运行内部自测
//   node scripts/detect-assertion-weakening.mjs --help  # 帮助
//
// 管道输入: git diff main...HEAD | node scripts/detect-assertion-weakening.mjs
//
// 退出码: 0=无发现(或--dry-run/--self-test成功) 1=发现断言弱化 2=输入错误 3=内部错误

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

// ── 公用 ──
function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(new URL(metaUrl).pathname) === realpathSync(process.argv[1]); } catch { return false; }
}
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2), next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}
function fail(msg, code = 2) { process.stderr.write(`[FAIL] ${msg}\n`); process.exit(code); }

function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = []; const decoder = new TextDecoder(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; resolve(chunks.join('')); }, timeoutMs);
    process.stdin.on('data', (chunk) => { if (!timedOut) chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })); });
    process.stdin.on('end', () => { if (!timedOut) { clearTimeout(timer); resolve(chunks.join('')); } });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(chunks.join('')); });
  });
}

// ── 检测形态清单 ──
const RELAXATIONS = [
  { from: 'toStrictEqual', to: 'toEqual', risk: '忽略 undefined 和数组稀疏差异' },
  { from: 'toBe', to: 'toEqual', risk: '从引用相等降为值相等' },
  { from: 'toBeGreaterThan', to: 'toBeGreaterThanOrEqual', risk: '放宽边界' },
  { from: 'toBeLessThan', to: 'toBeLessThanOrEqual', risk: '放宽边界' },
  { from: 'toBe(true)', to: 'toBeTruthy()', risk: '允许多个 truthy 值通过' },
  { from: 'toBe(false)', to: 'toBeFalsy()', risk: '允许多个 falsy 值通过' },
  { from: 'toBeNull()', to: 'toBeUndefined()', risk: '语义改变' },
  { from: 'toHaveLength(N)', to: 'toBeGreaterThan(0)', risk: '从精确值降为范围检查' },
];
export const DETECTABLE_PATTERNS = [
  { id: 'deleted_assertion', label: '删除 expect() 断言行', severity: 'high' },
  { id: 'test_skipped', label: '给测试加 .skip', severity: 'high', markers: ['.skip'] },
  { id: 'xtest_used', label: '使用 xdescribe/xtest/xit 跳过', severity: 'high', markers: ['xdescribe(', 'xtest(', 'xit('] },
  { id: 'relaxed_matcher', label: '弱化比较器', severity: 'medium', relaxations: RELAXATIONS },
  { id: 'narrowed_test_set', label: '缩小测试数据集合', severity: 'medium' },
  { id: 'commented_assertion', label: '注释掉断言', severity: 'high' },
  { id: 'early_return_before_assertion', label: '在断言前插入 early return', severity: 'high' },
  { id: 'deleted_test_block', label: '删除整个测试块', severity: 'high' },
  { id: 'skip_log_early_return', label: 'SKIP 日志 + 提前 return 跳过测试', severity: 'high' },
];
export const UNDETECTABLE_PATTERNS = [
  { id: 'semantic_weakening', label: '语义层面的断言弱化', description: '将具体值断言改为类型断言' },
  { id: 'mock_indirect_weakening', label: '通过修改 mock 数据间接弱化', description: '在 mock 工厂中返回更宽松的值' },
  { id: 'cross_file_weakening', label: '跨文件弱化', description: '在测试辅助文件或共享 fixture 中修改逻辑' },
  { id: 'cross_commit_weakening', label: '跨 commit 弱化', description: '断言弱化发生在不同 commit 中' },
  { id: 'test_file_deletion', label: '测试文件整体删除', description: '删除整个测试文件' },
  { id: 'helper_logic_change', label: '测试辅助函数逻辑修改', description: '修改 beforeEach/afterEach/setup 等辅助函数' },
  { id: 'conditionally_skipped', label: '条件性跳过', description: '通过 if 条件包裹断言使其在某些环境下不执行' },
  { id: 'import_mock_swap', label: '导入/依赖替换', description: '通过修改 import 引入更宽松的 mock 实现' },
  { id: 'timeout_increase', label: '增加超时时间', description: '增加 testTimeout 或 jest.setTimeout 值' },
];
export const BIAS = 'conservative';

// ── Diff 解析 ──
export function parseDiff(diff) {
  const files = []; let currentFile = null; let currentHunk = null;
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (currentFile) { if (currentHunk) { currentFile.hunks.push(currentHunk); currentHunk = null; } files.push(currentFile); }
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      currentFile = { file: match ? match[2] : line, status: 'modified', hunks: [] }; continue;
    }
    if (line.startsWith('new file mode')) { if (currentFile) currentFile.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { if (currentFile) currentFile.status = 'deleted'; continue; }
    if (line.startsWith('rename from') || line.startsWith('rename to') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@ ')) { if (currentFile && currentHunk) { currentFile.hunks.push(currentHunk); } currentHunk = { header: line, lines: [] }; continue; }
    if (currentHunk) { const type = line[0] === '-' ? 'removed' : line[0] === '+' ? 'added' : 'context'; currentHunk.lines.push({ type, content: line }); }
  }
  if (currentFile) { if (currentHunk) currentFile.hunks.push(currentHunk); files.push(currentFile); }
  return files;
}

// ── 检测逻辑 ──
export function isTestFile(filename) {
  const base = filename.split('/').pop() || '';
  // 标准测试文件扩展名
  if (/\.(test|spec|e2e)\.(mjs|js|ts|jsx|tsx)$/.test(base)) return true;
  // __tests__ / __test__ 目录
  if (base.includes('__tests__') || base.includes('__test__')) return true;
  if (base.startsWith('test-') || base.startsWith('spec-')) return true;
  // e2e scenario 文件（路径含 /e2e/ 或 /scenarios/）
  if (/\/e2e\//.test(filename) || /\/scenarios\//.test(filename)) return true;
  return false;
}

export function detectAssertionWeakening(diff) {
  if (diff === undefined || diff === null) throw new Error('detectAssertionWeakening: 需要 diff 参数 (string)，收到: ' + String(diff));
  if (typeof diff !== 'string') throw new Error('detectAssertionWeakening: diff 参数必须是 string，收到: ' + typeof diff);
  const files = parseDiff(diff);
  const findings = [];
  const testFiles = files.filter(f => isTestFile(f.file));

  for (const file of testFiles) {
    for (const hunk of file.hunks) {
      const removed = hunk.lines.filter(l => l.type === 'removed').map(l => l.content);
      const added = hunk.lines.filter(l => l.type === 'added').map(l => l.content);

      // 1. 删除的断言
      for (const line of removed) {
        if (isAssertionLine(line)) findings.push({ file: file.file, type: 'deleted_assertion', severity: 'high', detail: `删除断言: ${line.trim().substring(0, 120)}` });
      }

      // 2. .skip 标记
      for (const line of added) {
        if (line.includes('.skip') && !line.includes('//') && !line.trimStart().startsWith('//')) {
          if (/(it|test|describe|it\.only|test\.only)\.skip\(/.test(line)) {
            findings.push({ file: file.file, type: 'test_skipped', severity: 'high', detail: `添加 .skip: ${line.trim().substring(0, 120)}` });
          }
        }
      }

      // 3. xdescribe/xtest/xit
      for (const line of added) {
        const xm = line.match(/\b(xdescribe|xtest|xit|xcontext)\(/);
        if (xm) findings.push({ file: file.file, type: 'xtest_used', severity: 'high', detail: `使用 ${xm[1]}: ${line.trim().substring(0, 120)}` });
      }

      // 4. 弱化比较器
      for (const line of added) {
        for (const r of RELAXATIONS) {
          if (line.includes(r.to) && removed.some(rm => rm.includes(r.from))) {
            findings.push({ file: file.file, type: 'relaxed_matcher', severity: 'medium', detail: `弱化比较器: ${r.from} → ${r.to} (${r.risk})` });
          }
        }
      }

      // 5. 注释掉的断言
      for (const line of added) {
        const t = line.trimStart();
        if ((t.startsWith('//') || t.startsWith('/*')) && isAssertionLine(t.replace(/^\/\/\s*/, '').replace(/^\/\*.*\*\/\s*/, ''))) {
          findings.push({ file: file.file, type: 'commented_assertion', severity: 'high', detail: `注释掉断言: ${t.substring(0, 120)}` });
        }
      }

      // 6. early return 在断言前
      for (const line of added) {
        if (/^\s*return\s*[;}]/.test(line)) {
          const idx = hunk.lines.findIndex(l => l.content === line);
          if (idx >= 0) {
            const afterReturn = hunk.lines.slice(idx + 1).filter(l => l.type === 'removed' || l.type === 'added');
            if (afterReturn.some(l => l.type === 'removed' && isAssertionLine(l.content))) {
              findings.push({ file: file.file, type: 'early_return_before_assertion', severity: 'high', detail: `early return 使断言不可达: ${line.trim().substring(0, 120)}` });
            }
          }
        }
      }

      // 7. 删除的测试块
      const removedBlocks = findRemovedTestBlocks(removed, added);
      for (const block of removedBlocks) findings.push({ file: file.file, type: 'deleted_test_block', severity: 'high', detail: `删除测试块: ${block.substring(0, 120)}` });

      // 8. 缩小的测试集合
      for (const ns of detectNarrowedSet(removed, added)) findings.push({ file: file.file, type: 'narrowed_test_set', severity: 'medium', detail: ns });

      // 9. SKIP 日志 + 提前 return（#382 形态）
      for (const line of added) {
        if (/console\.log\(.*SKIP/i.test(line) && /^\+\s*return\s*[;}]/.test(line)) {
          findings.push({ file: file.file, type: 'skip_log_early_return', severity: 'high', detail: `SKIP 日志+提前 return: ${line.trim().substring(0, 120)}` });
        }
      }
      // 9b. 跨行 SKIP 日志 + 后续 return
      for (let i = 0; i < added.length; i++) {
        if (/console\.log\(.*SKIP/i.test(added[i]) && !/^\+\s*return\s*[;}]/.test(added[i])) {
          for (let j = i + 1; j < Math.min(i + 4, added.length); j++) {
            if (/^\+\s*return\s*[;}]?/.test(added[j]) || /^\+\s*return\s*$/.test(added[j])) {
              findings.push({ file: file.file, type: 'skip_log_early_return', severity: 'high', detail: `SKIP 日志+后续 return: ${added[i].trim().substring(0, 80)} | ${added[j].trim().substring(0, 80)}` });
              break;
            }
          }
        }
      }
    }
  }

  const byType = {}, bySeverity = {};
  for (const f of findings) { byType[f.type] = (byType[f.type] || 0) + 1; bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1; }
  return { findings, summary: { total: findings.length, by_type: byType, by_severity: bySeverity } };
}

function isAssertionLine(line) {
  const t = line.trim();
  if (t.startsWith('import ') || t.startsWith('//') || t.startsWith('/*') || t.length === 0) return false;
  return [/expect\s*\(/, /\bassert\s*\./, /\bassert\s*\(/, /\bt\.is\s*\(/, /\bt\.true\s*\(/, /\bt\.false\s*\(/, /\bt\.deepEqual\s*\(/, /\bt\.throws\s*\(/, /\.should\s*\./, /should\./, /\.to(Be|Equal|Match|Contain|Throw|Have|Include|Reject|Resolve)/, /\.not\./].some(p => p.test(t));
}

function findRemovedTestBlocks(removed, added) {
  const blocks = []; let pending = ''; let depth = 0; let inBlock = false;
  for (const line of removed) {
    const t = line.trim();
    if (/^(it|test|describe)\s*\(/.test(t)) {
      inBlock = true; pending = line; depth = 1;
      for (const ch of t) { if (ch === '(') depth++; if (ch === ')') depth--; }
      if (depth === 0 && inBlock) { blocks.push(t); pending = ''; inBlock = false; } continue;
    }
    if (inBlock) { for (const ch of t) { if (ch === '(') depth++; if (ch === ')') depth--; } pending += '\n' + line; if (depth <= 0) { blocks.push(pending); pending = ''; inBlock = false; } }
  }
  return blocks;
}

function detectNarrowedSet(removed, added) {
  const findings = [];
  const removedItems = removed.filter(l => /^\s*['"`\w]/.test(l) && l.trim().endsWith(','));
  const addedItems = added.filter(l => /^\s*['"`\w]/.test(l) && l.trim().endsWith(','));
  if (removedItems.length > 0 && addedItems.length === 0) findings.push(`被移除的数组元素: ${removedItems.map(l => l.trim()).join(', ')}`);
  for (const line of removed) {
    const lm = line.match(/for\s*\([^;]+;\s*\w+\s*<\s*(\d+)/);
    if (lm) { const al = added.find(l => l.includes('for')); if (al) { const nm = al.match(/for\s*\([^;]+;\s*\w+\s*<\s*(\d+)/); if (nm && parseInt(nm[1], 10) < parseInt(lm[1], 10)) findings.push(`循环次数减少: ${lm[1]} → ${nm[1]}`); } }
  }
  return findings;
}

// ── 研究报告输出 ──
export function researchReport() {
  return { detectable: DETECTABLE_PATTERNS.map(p => ({ id: p.id, label: p.label, severity: p.severity })), undetectable: UNDETECTABLE_PATTERNS.map(p => ({ id: p.id, label: p.label })), bias: BIAS, bias_explanation: '保守偏误：宁可误报也不漏报' };
}

// ── CLI 入口 ──
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`用法:\n  node scripts/detect-assertion-weakening.mjs [选项]\n\n选项:\n  --diff <文件>    对指定 diff 文件运行检测\n  --dry-run        输出可行性研究报告\n  --self-test      运行内部自测\n  --json           以 JSON 格式输出结果\n  --help           显示帮助\n\n管道模式: git diff | node scripts/detect-assertion-weakening.mjs\n\n退出码: 0=无发现(--dry-run/--self-test成功) 1=发现断言弱化 2=输入错误 3=内部错误\n`); process.exit(0); }

  // --dry-run: 研究报告（与 --diff 同时给时 dry-run 优先）
  if (args['dry-run']) {
    if (args.diff) process.stderr.write('[WARN] --diff 已忽略，--dry-run 优先\n');
    process.stdout.write(JSON.stringify(researchReport(), null, 2) + '\n');
    process.exit(0);
  }

  // --self-test: 自测
  if (args['self-test']) {
    const { runSelfTest } = await import(join(import.meta.dirname, '..', 'fixtures', 'assertion-weakening', 'self-test.mjs'));
    const result = await runSelfTest();
    for (const r of result.results) process.stdout.write(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}\n`);
    process.stdout.write(`\n总计: ${result.results.length}, 通过: ${result.results.filter(r => r.pass).length}, 失败: ${result.results.filter(r => !r.pass).length}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  // 读取 diff
  let diff;
  if (args.diff) {
    if (!existsSync(args.diff)) fail(`diff 文件不存在: ${args.diff}`);
    diff = readFileSync(args.diff, 'utf8');
  } else if (!process.stdin.isTTY) {
    diff = await readStdinWithTimeout(500);
    if (!diff) fail('stdin 未提供 diff 数据。请指定 --diff <文件> 或通过管道输入 diff');
  } else { fail('请指定 --diff <文件> 或通过管道输入 diff'); }

  if (!diff || diff.trim().length === 0) { process.stdout.write(JSON.stringify({ findings: [], summary: { total: 0, by_type: {}, by_severity: {} } }, null, 2) + '\n'); process.exit(0); }

  try {
    const result = detectAssertionWeakening(diff);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.summary.total > 0 ? 1 : 0);
  } catch (e) { fail(`检测失败: ${e.message}`, 3); }
}

if (isMain(import.meta.url)) { main(); }