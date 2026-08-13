#!/usr/bin/env node
// scripts/detect-assertion-weakening.mjs — 检测 diff 中删除/跳过/放宽测试断言
//
// 架构:
//   纯函数导出 (detectAssertionWeakening) + CLI 薄包装
//   两入口对同一输入返回等价判定
//
// 使用:
//   node scripts/detect-assertion-weakening.mjs --diff <diff_file>   # 检测指定 diff 文件
//   node scripts/detect-assertion-weakening.mjs --diff <diff_file> --json  # JSON 输出
//   node scripts/detect-assertion-weakening.mjs --dry-run  # 输出可行性研究报告
//   node scripts/detect-assertion-weakening.mjs --self-test  # 运行内部自测
//   node scripts/detect-assertion-weakening.mjs --help  # 帮助
//
// 管道输入:
//   git diff main...HEAD | node scripts/detect-assertion-weakening.mjs
//
// 退出码:
//   0 = 无发现 (或 --dry-run / --self-test 成功)
//   1 = 发现断言弱化
//   2 = 输入错误/参数缺
//   3 = 内部错误

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

// ── 公用函数 ──

function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(new URL(metaUrl).pathname) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function fail(msg, code = 2) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(code);
}

// ── 辅助函数 ──

function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const decoder = new TextDecoder();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      resolve(chunks.join(''));
    }, timeoutMs);

    process.stdin.on('data', (chunk) => {
      if (timedOut) return;
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    });

    process.stdin.on('end', () => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(chunks.join(''));
    });

    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── 检测形态清单（研究结论） ──

export const DETECTABLE_PATTERNS = [
  {
    id: 'deleted_assertion',
    label: '删除 expect() 断言行',
    description: '移除一行 expect(...) 或 assert(...) 调用',
    severity: 'high',
    regex: null, // 动态检测，见 detectWeakenings()
  },
  {
    id: 'test_skipped',
    label: '给测试/describe 块加 .skip',
    description: '在 it()/test()/describe() 上添加 .skip 标记',
    severity: 'high',
    markers: ['.skip', 'it.skip(', 'test.skip(', 'describe.skip('],
  },
  {
    id: 'xtest_used',
    label: '使用 xdescribe/xtest/xit 跳过',
    description: '将测试从 it/test 改为 xit/xtest，或 describe 改为 xdescribe',
    severity: 'high',
    markers: ['xdescribe(', 'xtest(', 'xit('],
  },
  {
    id: 'relaxed_matcher',
    label: '弱化比较器',
    description: '将严格比较器替换为较宽松的版本',
    severity: 'medium',
    relaxations: [
      { from: 'toStrictEqual', to: 'toEqual', risk: '忽略 undefined 和数组稀疏差异' },
      { from: 'toBe', to: 'toEqual', risk: '从引用相等降为值相等' },
      { from: 'toBeGreaterThan', to: 'toBeGreaterThanOrEqual', risk: '放宽边界' },
      { from: 'toBeLessThan', to: 'toBeLessThanOrEqual', risk: '放宽边界' },
      { from: 'toBe(true)', to: 'toBeTruthy()', risk: '允许多个 truthy 值通过' },
      { from: 'toBe(false)', to: 'toBeFalsy()', risk: '允许多个 falsy 值通过' },
      { from: 'toBeNull()', to: 'toBeUndefined()', risk: '语义改变' },
      { from: 'toHaveLength(N)', to: 'toBeGreaterThan(0)', risk: '从精确值降为范围检查' },
    ],
  },
  {
    id: 'narrowed_test_set',
    label: '缩小测试数据集合',
    description: '减少测试用例中的测试值数量',
    severity: 'medium',
  },
  {
    id: 'commented_assertion',
    label: '注释掉断言',
    description: '在断言前加 // 或在行尾加 // 注释掉',
    severity: 'high',
  },
  {
    id: 'early_return_before_assertion',
    label: '在断言前插入 early return',
    description: '在断言前插入 return 使后续断言不可达',
    severity: 'high',
  },
  {
    id: 'deleted_test_block',
    label: '删除整个测试块',
    description: '移除整个 it()/test()/describe() 块',
    severity: 'high',
  },
];

export const UNDETECTABLE_PATTERNS = [
  {
    id: 'semantic_weakening',
    label: '语义层面的断言弱化',
    description: '将具体值断言改为类型断言（如 toBe(42) → toBeGreaterThan(0)），从语义上无法判断是否合理',
  },
  {
    id: 'mock_indirect_weakening',
    label: '通过修改 mock 数据间接弱化',
    description: '在 mock 工厂中返回更宽松的值，测试代码本身不变但测试效果减弱',
  },
  {
    id: 'cross_file_weakening',
    label: '跨文件弱化',
    description: '在测试辅助文件或共享 fixture 中修改逻辑，主测试文件不变',
  },
  {
    id: 'cross_commit_weakening',
    label: '跨 commit 弱化',
    description: '断言弱化发生在不同 commit 中，diff 比较时看不到',
  },
  {
    id: 'test_file_deletion',
    label: '测试文件整体删除',
    description: '删除整个测试文件，diff 中仅显示文件删除，无法判断是否故意弱化',
  },
  {
    id: 'helper_logic_change',
    label: '测试辅助函数逻辑修改',
    description: '修改 beforeEach / afterEach / setup 等辅助函数，间接影响测试有效性',
  },
  {
    id: 'conditionally_skipped',
    label: '条件性跳过',
    description: '通过 if 条件包裹断言使其在某些环境下不执行，从 diff 文本难以可靠判断',
  },
  {
    id: 'import_mock_swap',
    label: '导入/依赖替换',
    description: '通过修改 import 引入更宽松的 mock 实现，测试代码不变',
  },
  {
    id: 'timeout_increase',
    label: '增加超时时间',
    description: '增加 testTimeout 或 jest.setTimeout 值，系统性地降低测试有效性',
  },
];

export const BIAS = 'conservative';

// ── Diff 解析 ──

/**
 * 解析 unified diff 格式，返回结构化文件列表
 * @param {string} diff
 * @returns {Array<{file: string, status: string, hunks: Array<{header: string, lines: Array<{type: string, content: string, oldLine?: number, newLine?: number}>}>}>}
 */
export function parseDiff(diff) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // diff --git a/... b/...
    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        if (currentHunk) { currentFile.hunks.push(currentHunk); currentHunk = null; }
        files.push(currentFile);
      }
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      currentFile = {
        file: match ? match[2] : line,
        status: 'modified',
        hunks: [],
      };
      continue;
    }

    // new file / deleted file / rename / index 等
    if (line.startsWith('new file mode')) { if (currentFile) currentFile.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { if (currentFile) currentFile.status = 'deleted'; continue; }
    if (line.startsWith('rename from') || line.startsWith('rename to')) { continue; }
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) { continue; }

    // @@ -a,b +c,d @@ ... (hunk header)
    if (line.startsWith('@@ ')) {
      if (currentFile && currentHunk) { currentFile.hunks.push(currentHunk); }
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (currentHunk) {
      const type = line[0] === '-' ? 'removed' : line[0] === '+' ? 'added' : 'context';
      currentHunk.lines.push({ type, content: line });
    }
  }

  // 收尾
  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    files.push(currentFile);
  }

  return files;
}

// ── 检测逻辑 ──

/**
 * 判断文件是否为测试文件
 * @param {string} filename
 * @returns {boolean}
 */
export function isTestFile(filename) {
  const base = filename.split('/').pop() || '';
  return /\.(test|spec|e2e)\.(mjs|js|ts|jsx|tsx)$/.test(base)
    || base.includes('__tests__')
    || base.includes('__test__')
    || base.startsWith('test-')
    || base.startsWith('spec-');
}

/**
 * 检测断言弱化
 * @param {string} diff 完整的 diff 内容
 * @returns {{ findings: Array<Object>, summary: { total: number, by_type: Object, by_severity: Object } }}
 */
export function detectAssertionWeakening(diff) {
  // 输入校验：fail-closed
  if (diff === undefined || diff === null) {
    throw new Error('detectAssertionWeakening: 需要 diff 参数 (string)，收到: ' + String(diff));
  }
  if (typeof diff !== 'string') {
    throw new Error('detectAssertionWeakening: diff 参数必须是 string，收到: ' + typeof diff);
  }

  const files = parseDiff(diff);
  const findings = [];

  // 只分析测试文件
  const testFiles = files.filter(f => isTestFile(f.file));

  for (const file of testFiles) {
    for (const hunk of file.hunks) {
      const removed = hunk.lines.filter(l => l.type === 'removed').map(l => l.content);
      const added = hunk.lines.filter(l => l.type === 'added').map(l => l.content);
      const context = hunk.lines.filter(l => l.type === 'context').map(l => l.content);

      // 1. 检测删除的断言
      for (const line of removed) {
        if (isAssertionLine(line)) {
          findings.push({
            file: file.file,
            type: 'deleted_assertion',
            severity: 'high',
            detail: `删除断言行: ${line.trim().substring(0, 120)}`,
          });
        }
      }

      // 2. 检测 .skip 标记
      for (const line of added) {
        if (line.includes('.skip') && !line.includes('//') && !line.trimStart().startsWith('//')) {
          const skipMatch = line.match(/(it|test|describe|it\.only|test\.only)\.skip\(/);
          if (skipMatch) {
            findings.push({
              file: file.file,
              type: 'test_skipped',
              severity: 'high',
              detail: `添加 .skip 跳过测试: ${line.trim().substring(0, 120)}`,
            });
          }
        }
      }

      // 3. 检测 xdescribe/xtest/xit
      for (const line of added) {
        const xMatch = line.match(/\b(xdescribe|xtest|xit|xcontext)\(/);
        if (xMatch) {
          findings.push({
            file: file.file,
            type: 'xtest_used',
            severity: 'high',
            detail: `使用 ${xMatch[1]} 跳过测试: ${line.trim().substring(0, 120)}`,
          });
        }
      }

      // 4. 检测弱化比较器
      for (const line of added) {
        for (const relaxed of DETECTABLE_PATTERNS.find(p => p.id === 'relaxed_matcher').relaxations) {
          // 检查是否在 + 行中只使用了宽松版，并且在 - 行中使用了严格版
          const hasRelaxed = line.includes(relaxed.to);
          const hasStrict = removed.some(r => r.includes(relaxed.from));
          if (hasRelaxed && hasStrict) {
            findings.push({
              file: file.file,
              type: 'relaxed_matcher',
              severity: 'medium',
              detail: `弱化比较器: ${relaxed.from} → ${relaxed.to} (${relaxed.risk})`,
            });
          }
        }
      }

      // 5. 检测注释掉的断言
      for (const line of added) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          if (isAssertionLine(trimmed.replace(/^\/\/\s*/, '').replace(/^\/\*.*\*\/\s*/, ''))) {
            findings.push({
              file: file.file,
              type: 'commented_assertion',
              severity: 'high',
              detail: `注释掉断言: ${trimmed.substring(0, 120)}`,
            });
          }
        }
      }

      // 6. 检测 early return 在断言前
      for (const line of added) {
        if (/^\s*return\s*[;}]/.test(line)) {
          // 检查上下文，看后面是否有断言被跳过
          const idx = hunk.lines.findIndex(l => l.content === line);
          if (idx >= 0) {
            const afterReturn = hunk.lines.slice(idx + 1).filter(l => l.type === 'added' || l.type === 'removed');
            if (afterReturn.some(l => l.type === 'removed' && isAssertionLine(l.content))) {
              findings.push({
                file: file.file,
                type: 'early_return_before_assertion',
                severity: 'high',
                detail: `插入 early return 使后续断言不可达: ${line.trim().substring(0, 120)}`,
              });
            }
          }
        }
      }

      // 7. 检测删除的测试块
      const removedTestBlocks = findRemovedTestBlocks(removed, added);
      findings.push(...removedTestBlocks.map(block => ({
        file: file.file,
        type: 'deleted_test_block',
        severity: 'high',
        detail: `删除测试块: ${block.substring(0, 120)}`,
      })));

      // 8. 检测缩小的测试集合
      const narrowedSet = detectNarrowedSet(removed, added, context);
      findings.push(...narrowedSet.map(ns => ({
        file: file.file,
        type: 'narrowed_test_set',
        severity: 'medium',
        detail: ns,
      })));
    }
  }

  // 汇总
  const byType = {};
  const bySeverity = {};
  for (const f of findings) {
    byType[f.type] = (byType[f.type] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  return {
    findings,
    summary: {
      total: findings.length,
      by_type: byType,
      by_severity: bySeverity,
    },
  };
}

function isAssertionLine(line) {
  const trimmed = line.trim();
  // 排除 import 语句、纯注释、空行
  if (trimmed.startsWith('import ') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.length === 0) return false;
  // 常见的断言模式
  const assertionPatterns = [
    /expect\s*\(/,
    /\bassert\s*\./,
    /\bassert\s*\(/,
    /\bt\.is\s*\(/,
    /\bt\.true\s*\(/,
    /\bt\.false\s*\(/,
    /\bt\.deepEqual\s*\(/,
    /\bt\.throws\s*\(/,
    /\.should\s*\./,
    /should\./,
    /expect\..*\.to/,
    /\.to(Be|Equal|Match|Contain|Throw|Have|Include|Reject|Resolve)/,
    /\.not\./,
  ];
  return assertionPatterns.some(p => p.test(trimmed));
}

function findRemovedTestBlocks(removed, added) {
  const blocks = [];
  let pending = '';
  let depth = 0;
  let inBlock = false;

  for (const line of removed) {
    const trimmed = line.trim();
    // 匹配 it( 或 test( 或 describe( 开头
    if (/^(it|test|describe)\s*\(/.test(trimmed)) {
      inBlock = true;
      pending = line;
      depth = 1;
      // 统计括号深度
      for (const ch of trimmed) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      if (depth === 0 && inBlock) {
        blocks.push(trimmed);
        pending = '';
        inBlock = false;
      }
      continue;
    }
    if (inBlock) {
      for (const ch of trimmed) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      pending += '\n' + line;
      if (depth <= 0) {
        blocks.push(pending);
        pending = '';
        inBlock = false;
      }
    }
  }
  return blocks;
}

function detectNarrowedSet(removed, added, context) {
  const findings = [];
  // 检测数组中的元素减少
  const removedArrayItems = removed.filter(l => /^\s*['"`\w]/.test(l) && l.trim().endsWith(','));
  const addedArrayItems = added.filter(l => /^\s*['"`\w]/.test(l) && l.trim().endsWith(','));

  if (removedArrayItems.length > 0 && addedArrayItems.length === 0) {
    findings.push(`被移除的数组元素: ${removedArrayItems.map(l => l.trim()).join(', ')}`);
  }

  // 检测循环次数减少
  for (const line of removed) {
    const loopMatch = line.match(/for\s*\([^;]+;\s*\w+\s*<\s*(\d+)/);
    if (loopMatch) {
      const oldCount = parseInt(loopMatch[1], 10);
      const addedLine = added.find(l => l.includes('for'));
      if (addedLine) {
        const newLoopMatch = addedLine.match(/for\s*\([^;]+;\s*\w+\s*<\s*(\d+)/);
        if (newLoopMatch) {
          const newCount = parseInt(newLoopMatch[1], 10);
          if (newCount < oldCount) {
            findings.push(`循环次数减少: ${oldCount} → ${newCount}`);
          }
        }
      }
    }
  }

  return findings;
}

// ── 自测 ──

/**
 * 运行内部自测，验证函数行为正确性
 * @returns {{ ok: boolean, results: Array<{name: string, pass: boolean, detail?: string}> }}
 */
export function runSelfTest() {
  const results = [];

  // 1. 函数缺参测试
  try {
    detectAssertionWeakening(undefined);
    results.push({ name: '函数缺参(undefined)应抛错', pass: false, detail: '未抛出错误' });
  } catch (e) {
    results.push({ name: '函数缺参(undefined)应抛错', pass: true, detail: `抛错: ${e.message}` });
  }

  try {
    detectAssertionWeakening(null);
    results.push({ name: '函数缺参(null)应抛错', pass: false, detail: '未抛出错误' });
  } catch (e) {
    results.push({ name: '函数缺参(null)应抛错', pass: true, detail: `抛错: ${e.message}` });
  }

  // 2. 空 diff 测试
  try {
    const result = detectAssertionWeakening('');
    results.push({
      name: '空 diff 应返回空发现',
      pass: result.summary.total === 0,
      detail: `total=${result.summary.total}`,
    });
  } catch (e) {
    results.push({ name: '空 diff 应返回空发现', pass: false, detail: `抛错: ${e.message}` });
  }

  // 3. 检测删除断言
  const diffWithDeletedAssertion = [
    'diff --git a/src/foo.test.ts b/src/foo.test.ts',
    'index abc..def 100644',
    '--- a/src/foo.test.ts',
    '+++ b/src/foo.test.ts',
    '@@ -10,7 +10,6 @@',
    '  it("should work", () => {',
    '    const result = myFunc();',
    '-   expect(result).toBe(42);',
    '    expect(result).toBeDefined();',
    '  });',
  ].join('\n');

  const result1 = detectAssertionWeakening(diffWithDeletedAssertion);
  results.push({
    name: '检测删除的断言',
    pass: result1.findings.some(f => f.type === 'deleted_assertion'),
    detail: `找到 ${result1.findings.length} 个发现`,
  });

  // 4. 检测 .skip 标记
  const diffWithSkip = [
    'diff --git a/src/bar.test.ts b/src/bar.test.ts',
    'index abc..def 100644',
    '--- a/src/bar.test.ts',
    '+++ b/src/bar.test.ts',
    '@@ -5,6 +5,6 @@',
    '-  it("should pass", () => {',
    '+  it.skip("should pass", () => {',
    '     expect(1).toBe(1);',
    '   });',
  ].join('\n');

  const result2 = detectAssertionWeakening(diffWithSkip);
  results.push({
    name: '检测 .skip 标记',
    pass: result2.findings.some(f => f.type === 'test_skipped'),
    detail: `找到 ${result2.findings.length} 个发现`,
  });

  // 5. 检测 xdescribe
  const diffWithXdescribe = [
    'diff --git a/src/baz.test.ts b/src/baz.test.ts',
    'index abc..def 100644',
    '--- a/src/baz.test.ts',
    '+++ b/src/baz.test.ts',
    '@@ -1,4 +1,4 @@',
    '-describe("My Suite", () => {',
    '+xdescribe("My Suite", () => {',
    '  it("test", () => { expect(1).toBe(1); });',
    '});',
  ].join('\n');

  const result3 = detectAssertionWeakening(diffWithXdescribe);
  results.push({
    name: '检测 xdescribe 跳过',
    pass: result3.findings.some(f => f.type === 'xtest_used'),
    detail: `找到 ${result3.findings.length} 个发现`,
  });

  // 6. 非测试文件不应触发
  const diffOnSourceFile = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index abc..def 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -10,7 +10,6 @@',
    '-  expect(result).toBe(42);',
    '+  console.log(result);',
  ].join('\n');

  const result4 = detectAssertionWeakening(diffOnSourceFile);
  results.push({
    name: '非测试文件忽略',
    pass: result4.summary.total === 0,
    detail: `total=${result4.summary.total}`,
  });

  // 7. 函数与 CLI 等价性（通过同一输入调用两次）
  const input = diffWithDeletedAssertion;
  const call1 = detectAssertionWeakening(input);
  const call2 = detectAssertionWeakening(input);
  results.push({
    name: '纯函数幂等性',
    pass: call1.summary.total === call2.summary.total && JSON.stringify(call1.findings) === JSON.stringify(call2.findings),
    detail: `调用1: ${call1.summary.total} 发现, 调用2: ${call2.summary.total} 发现`,
  });

  // 8. 检测弱化比较器
  const diffWithRelaxed = [
    'diff --git a/src/qux.test.ts b/src/qux.test.ts',
    'index abc..def 100644',
    '--- a/src/qux.test.ts',
    '+++ b/src/qux.test.ts',
    '@@ -5,8 +5,8 @@',
    '  it("should match", () => {',
    '    const result = { a: 1, b: undefined };',
    '-   expect(result).toStrictEqual({ a: 1 });',
    '+   expect(result).toEqual({ a: 1 });',
    '  });',
  ].join('\n');

  const result5 = detectAssertionWeakening(diffWithRelaxed);
  results.push({
    name: '检测弱化比较器',
    pass: result5.findings.some(f => f.type === 'relaxed_matcher'),
    detail: `找到 ${result5.findings.length} 个发现`,
  });

  const allPass = results.every(r => r.pass);
  return { ok: allPass, results };
}

// ── 研究报告输出 ──

export function researchReport() {
  return {
    trigger: '用户要求产出 t4 断言削弱检测器可行性结论',
    date: new Date().toISOString(),
    detectable: DETECTABLE_PATTERNS.map(p => ({
      id: p.id,
      label: p.label,
      description: p.description,
      severity: p.severity,
    })),
    undetectable: UNDETECTABLE_PATTERNS.map(p => ({
      id: p.id,
      label: p.label,
      description: p.description,
    })),
    bias: BIAS,
    bias_explanation: '保守偏误：宁可误报（将无害改动标记为危险）也不漏报。' +
      '误报导致额外审查成本（可接受），漏报导致断言弱化逃逸（不可接受）。',
    detection_approach: {
      methodology: 'unified diff 解析 + 逐行模式匹配',
      scope: '仅分析测试文件 (*.test.*, *.spec.*, __tests__/)',
      exit_codes: {
        0: '无发现',
        1: '发现断言弱化',
        2: '输入错误/参数缺',
        3: '内部错误',
      },
    },
  };
}

// ── CLI 入口 ──

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`
用法:
  node scripts/detect-assertion-weakening.mjs [选项]

选项:
  --diff <文件>    对指定 diff 文件运行检测
  --dry-run        输出可行性研究报告
  --self-test      运行内部自测
  --json           以 JSON 格式输出结果
  --help           显示帮助

管道模式:
  git diff | node scripts/detect-assertion-weakening.mjs

退出码:
  0  = 无发现 (或 --dry-run / --self-test 成功)
  1  = 发现断言弱化
  2  = 输入错误/参数缺
  3  = 内部错误
`);
    process.exit(0);
  }

  // --dry-run: 输出研究报告
  if (args['dry-run']) {
    const report = researchReport();
    const output = JSON.stringify(report, null, 2);
    process.stdout.write(output + '\n');
    process.exit(0);
  }

  // --self-test: 运行自测
  if (args['self-test']) {
    const result = runSelfTest();
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      for (const r of result.results) {
        process.stdout.write(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}\n`);
      }
      process.stdout.write(`\n总计: ${result.results.length}, 通过: ${result.results.filter(r => r.pass).length}, 失败: ${result.results.filter(r => !r.pass).length}\n`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  // 读取 diff
  let diff;
  if (args.diff) {
    if (!existsSync(args.diff)) {
      fail(`diff 文件不存在: ${args.diff}`);
    }
    diff = readFileSync(args.diff, 'utf8');
  } else if (!process.stdin.isTTY) {
    // 管道输入 — 检查 stdin 是否有数据可读，超时 500ms 就假定无输入
    diff = await readStdinWithTimeout(500);
    if (!diff) {
      fail('stdin 未提供 diff 数据（管道为空或超时）。请指定 --diff <文件> 或通过管道输入 diff');
    }
  } else {
    fail('请指定 --diff <文件> 或通过管道输入 diff');
  }

  if (!diff || diff.trim().length === 0) {
    const result = { findings: [], summary: { total: 0, by_type: {}, by_severity: {} } };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }

  try {
    const result = detectAssertionWeakening(diff);
    const output = args.json ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2);
    process.stdout.write(output + '\n');
    process.exit(result.summary.total > 0 ? 1 : 0);
  } catch (e) {
    fail(`检测失败: ${e.message}`, 3);
  }
}