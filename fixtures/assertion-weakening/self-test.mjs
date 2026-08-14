// fixtures/assertion-weakening/self-test.mjs — 自测被移出主脚本 fixture
// 主脚本 --self-test 模式动态 import 本文件

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', '..', 'scripts', 'detect-assertion-weakening.mjs');

/**
 * @returns {{ ok: boolean, results: Array<{name: string, pass: boolean, detail?: string}> }}
 */
export async function runSelfTest() {
  const results = [];
  // 动态 import 主脚本的函数
  let detectAssertionWeakening, isTestFile;
  try {
    const mod = await import(MAIN);
    detectAssertionWeakening = mod.detectAssertionWeakening;
    isTestFile = mod.isTestFile;
  } catch (e) {
    results.push({ name: '动态加载主脚本', pass: false, detail: `加载失败: ${e.message}` });
    return { ok: false, results };
  }

  // 1. 函数缺参测试
  try { detectAssertionWeakening(undefined); results.push({ name: '函数缺参(undefined)应抛错', pass: false, detail: '未抛出错误' }); }
  catch (e) { results.push({ name: '函数缺参(undefined)应抛错', pass: true, detail: `抛错: ${e.message}` }); }
  try { detectAssertionWeakening(null); results.push({ name: '函数缺参(null)应抛错', pass: false, detail: '未抛出错误' }); }
  catch (e) { results.push({ name: '函数缺参(null)应抛错', pass: true, detail: `抛错: ${e.message}` }); }

  // 2. 空 diff
  try { const r = detectAssertionWeakening(''); results.push({ name: '空 diff 应返回空发现', pass: r.summary.total === 0, detail: `total=${r.summary.total}` }); }
  catch (e) { results.push({ name: '空 diff 应返回空发现', pass: false, detail: `抛错: ${e.message}` }); }

  // 3. 删除断言
  const d1 = 'diff --git a/src/foo.test.ts b/src/foo.test.ts\nindex a..b 100644\n--- a/src/foo.test.ts\n+++ b/src/foo.test.ts\n@@ -10,7 +10,6 @@\n it("should work", () => {\n   const result = myFunc();\n-  expect(result).toBe(42);\n   expect(result).toBeDefined();\n });\n';
  const r1 = detectAssertionWeakening(d1);
  results.push({ name: '检测删除的断言', pass: r1.findings.some(f => f.type === 'deleted_assertion'), detail: `找到 ${r1.findings.length} 个发现` });

  // 4. .skip
  const d2 = 'diff --git a/src/bar.test.ts b/src/bar.test.ts\nindex a..b 100644\n--- a/src/bar.test.ts\n+++ b/src/bar.test.ts\n@@ -5,6 +5,6 @@\n- it("should pass", () => {\n+ it.skip("should pass", () => {\n   expect(1).toBe(1);\n });\n';
  const r2 = detectAssertionWeakening(d2);
  results.push({ name: '检测 .skip 标记', pass: r2.findings.some(f => f.type === 'test_skipped'), detail: `找到 ${r2.findings.length} 个发现` });

  // 5. xdescribe
  const d3 = 'diff --git a/src/baz.test.ts b/src/baz.test.ts\nindex a..b 100644\n--- a/src/baz.test.ts\n+++ b/src/baz.test.ts\n@@ -1,4 +1,4 @@\n-describe("My Suite", () => {\n+xdescribe("My Suite", () => {\n it("test", () => { expect(1).toBe(1); });\n});\n';
  const r3 = detectAssertionWeakening(d3);
  results.push({ name: '检测 xdescribe 跳过', pass: r3.findings.some(f => f.type === 'xtest_used'), detail: `找到 ${r3.findings.length} 个发现` });

  // 6. 非测试文件
  const d4 = 'diff --git a/src/foo.ts b/src/foo.ts\nindex a..b 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,7 +10,6 @@\n-  expect(result).toBe(42);\n+  console.log(result);\n';
  const r4 = detectAssertionWeakening(d4);
  results.push({ name: '非测试文件忽略', pass: r4.summary.total === 0, detail: `total=${r4.summary.total}` });

  // 7. 幂等性
  const r5a = detectAssertionWeakening(d1); const r5b = detectAssertionWeakening(d1);
  results.push({ name: '纯函数幂等性', pass: r5a.summary.total === r5b.summary.total && JSON.stringify(r5a.findings) === JSON.stringify(r5b.findings), detail: `调用1: ${r5a.summary.total}, 调用2: ${r5b.summary.total}` });

  // 8. 弱化比较器
  const d6 = 'diff --git a/src/qux.test.ts b/src/qux.test.ts\nindex a..b 100644\n--- a/src/qux.test.ts\n+++ b/src/qux.test.ts\n@@ -5,8 +5,8 @@\n it("should match", () => {\n   const result = { a: 1, b: undefined };\n-  expect(result).toStrictEqual({ a: 1 });\n+  expect(result).toEqual({ a: 1 });\n });\n';
  const r6 = detectAssertionWeakening(d6);
  results.push({ name: '检测弱化比较器', pass: r6.findings.some(f => f.type === 'relaxed_matcher'), detail: `找到 ${r6.findings.length} 个发现` });

  // 9. isTestFile — e2e scenario
  results.push({ name: 'isTestFile(/e2e/路径)', pass: isTestFile('scripts/e2e/scenarios/mask-point.mjs'), detail: '应返回 true' });
  results.push({ name: 'isTestFile(/scenarios/路径)', pass: isTestFile('src/__tests__/scenarios/foo.mjs'), detail: '应返回 true' });
  results.push({ name: 'isTestFile(普通源码)', pass: !isTestFile('src/foo.ts'), detail: '应返回 false' });

  // 10. SKIP 日志 + early return (#382 形态)
  const d7 = 'diff --git a/scripts/e2e/scenarios/mask-point.mjs b/scripts/e2e/scenarios/mask-point.mjs\nindex a..b 100644\n--- a/scripts/e2e/scenarios/mask-point.mjs\n+++ b/scripts/e2e/scenarios/mask-point.mjs\n@@ -100,6 +100,8 @@ export const runMaskPointScenario = async (context) => {\n+  console.log(\'[e2e-smoke] SKIP scenario=mask-point\')\n+  return\n+  const { page } = context\n';
  const r7 = detectAssertionWeakening(d7);
  results.push({ name: '检测 #382 形态(SKIP日志+return)', pass: r7.findings.some(f => f.type === 'skip_log_early_return'), detail: `找到 ${r7.findings.length} 个发现` });

  const allPass = results.every(r => r.pass);
  return { ok: allPass, results };
}