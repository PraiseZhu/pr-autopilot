// fixtures/assertion-weakening.fixture.mjs — 断言弱化检测器回归测试
// 用法: node fixtures/assertion-weakening.fixture.mjs
// 输出: 逐行汇总 + 末行 failed: <标签集> 或 pass
//
// 注: 这个 fixture 的 cwd 固定在 fixtures/ 下（run-all.sh 的 cd 或绝对路径）

import { readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAIN = join(ROOT, 'scripts', 'detect-assertion-weakening.mjs');
const TESTSET = join(HERE, 'assertion-weakening', 'testset.json');
const DIFFS = join(HERE, 'assertion-weakening', 'diffs');

// 动态 import 主脚本
let detectAssertionWeakening;
try {
  const mod = await import(MAIN);
  detectAssertionWeakening = mod.detectAssertionWeakening;
} catch (e) {
  console.error(`[FATAL] 加载主脚本失败: ${e.message}`);
  process.exit(1);
}

// ── 第①组: 正样本检测 ──
function runPositiveTests(testset) {
  const results = [];
  for (const pos of testset.positives) {
    if (!pos.hasDiff) {
      results.push({ number: pos.number, title: pos.title, diff: 'N/A', pass: true, findings: -1, detail: 'not_run: hasDiff=false', tags: pos.types });
      continue;
    }
    const diffPath = join(DIFFS, `${pos.number}.diff`);
    if (!existsSync(diffPath)) { results.push({ number: pos.number, title: pos.title, diff: `${pos.number}.diff`, pass: true, findings: -1, detail: 'not_run: diff file missing', tags: pos.types }); continue; }
    const diff = readFileSync(diffPath, 'utf8');
    if (!diff.trim()) { results.push({ number: pos.number, title: pos.title, diff: `${pos.number}.diff`, pass: true, findings: -1, detail: 'not_run: diff empty', tags: pos.types }); continue; }
    try {
      const result = detectAssertionWeakening(diff);
      const hasFindings = result.summary.total > 0;
      results.push({
        number: pos.number,
        title: pos.title,
        diff: `${pos.number}.diff`,
        pass: hasFindings,
        findings: result.summary.total,
        detail: hasFindings ? `OK: ${result.summary.total} findings` : `MISS: 0 findings (expected >0)`,
        tags: pos.types,
      });
    } catch (e) {
      results.push({ number: pos.number, title: pos.title, diff: `${pos.number}.diff`, pass: false, findings: -1, detail: `ERROR: ${e.message}`, tags: pos.types });
    }
  }
  return results;
}

// ── 第②组: 负样本检测 ──
function runNegativeTests(testset) {
  const results = [];
  for (const neg of testset.negatives) {
    if (!neg.hasDiff) {
      results.push({ number: neg.number, title: neg.title, diff: 'N/A', pass: true, findings: -1, detail: 'not_run: hasDiff=false', tags: [] });
      continue;
    }
    const diffPath = join(DIFFS, `${neg.number}.diff`);
    if (!existsSync(diffPath)) { results.push({ number: neg.number, title: neg.title, diff: `${neg.number}.diff`, pass: true, findings: -1, detail: 'not_run: diff file missing', tags: [] }); continue; }
    const diff = readFileSync(diffPath, 'utf8');
    if (!diff.trim()) { results.push({ number: neg.number, title: neg.title, diff: `${neg.number}.diff`, pass: true, findings: -1, detail: 'not_run: diff empty', tags: [] }); continue; }
    try {
      const result = detectAssertionWeakening(diff);
      results.push({
        number: neg.number,
        title: neg.title,
        diff: `${neg.number}.diff`,
        pass: result.summary.total === 0,
        findings: result.summary.total,
        detail: result.summary.total === 0 ? 'OK: 0 findings' : `FALSE: ${result.summary.total} unexpected findings`,
        tags: [],
      });
    } catch (e) {
      results.push({ number: neg.number, title: neg.title, diff: `${neg.number}.diff`, pass: false, findings: -1, detail: `ERROR: ${e.message}`, tags: [] });
    }
  }
  return results;
}

// ── 第③组: 软链一致性测（sc-t4-5） ──
function runSymlinkConsistencyTest() {
  const results = [];
  const tmpDir = '/tmp/aex-a-t4-skills-bin';
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  // 创建软链
  const symlinkPath = join(tmpDir, 'detect-assertion-weakening.mjs');
  try {
    if (existsSync(symlinkPath)) execFileSync('rm', [symlinkPath]);
    symlinkSync(MAIN, symlinkPath);
  } catch (e) {
    return [{ pass: false, detail: `创建软链失败: ${e.message}` }];
  }

  // 用同一 diff 比直接路径和软链路径
  const testDiff = join(DIFFS, '382.diff');
  if (!existsSync(testDiff)) return [{ pass: false, detail: '382.diff 不存在，跳过软链测试' }];

  try {
    // 直接调用
    const directResult = detectAssertionWeakening(readFileSync(testDiff, 'utf8'));
    // 通过软链调 CLI（exit code 1 是正常发现，不要抛）
    let symlinkOutput = '';
    const sp = spawnSync('node', [symlinkPath, '--diff', testDiff], { encoding: 'utf8', timeout: 15000 });
    symlinkOutput = sp.stdout || '';
    if (!symlinkOutput) symlinkOutput = sp.stderr || '';
    const symlinkResult = JSON.parse(symlinkOutput);

    const directTotal = directResult.summary.total;
    const symlinkTotal = symlinkResult.summary.total;
    const pass = directTotal === symlinkTotal;
    results.push({
      pass,
      detail: pass ? `一致: 直接=${directTotal}, 软链=${symlinkTotal}` : `不一致: 直接=${directTotal}, 软链=${symlinkTotal}`,
      direct_total: directTotal,
      symlink_total: symlinkTotal,
    });
  } catch (e) {
    results.push({ pass: false, detail: `软链测试失败: ${e.message}` });
  }

  // 清理
  try { execFileSync('rm', [symlinkPath]); } catch {}
  return results;
}

// ── 主流程 ──
async function main() {
  // 加载测试集
  if (!existsSync(TESTSET)) { console.error('[FATAL] 测试集不存在'); process.exit(1); }
  const testset = JSON.parse(readFileSync(TESTSET, 'utf8'));

  // 第①组
  const positiveResults = runPositiveTests(testset);
  const posPass = positiveResults.filter(r => r.pass);
  const posFail = positiveResults.filter(r => !r.pass);
  const posSkipped = positiveResults.filter(r => r.detail.startsWith('not_run'));
  const posTotal = positiveResults.length;

  // 第②组
  const negativeResults = runNegativeTests(testset);
  const negPass = negativeResults.filter(r => r.pass);
  const negFail = negativeResults.filter(r => !r.pass);
  const negSkipped = negativeResults.filter(r => r.detail.startsWith('not_run'));
  const negTotal = negativeResults.length;

  // 特检 #382
  const pr382 = positiveResults.find(r => r.number === 382);
  const pr410 = negativeResults.find(r => r.number === 410);

  // 第③组
  const symlinkResults = runSymlinkConsistencyTest();

  // 输出摘要
  console.log('=== 断言弱化检测器回归 ===');
  const posSkippedStr = posSkipped.length > 0 ? ` (${posSkipped.length} 无 diff 跳过)` : '';
  const negSkippedStr = negSkipped.length > 0 ? ` (${negSkipped.length} 无 diff 跳过)` : '';
  console.log(`正样本: ${posPass.length}/${posTotal} 通过, ${posFail.length} 失败${posSkippedStr}`);
  console.log(`负样本: ${negPass.length}/${negTotal} 通过, ${negFail.length} 失败${negSkippedStr}`);
  console.log(`#382: ${pr382 ? (pr382.pass ? '✓ 命中' : '✗ 漏报') : 'N/A'}`);
  console.log(`#410: ${pr410 ? (pr410.pass ? '✓ 0 findings' : `✗ ${pr410.findings} findings`) : 'N/A'}`);
  console.log(`软链一致性: ${symlinkResults[0]?.pass ? '✓ 一致' : '✗ 不一致'}`);

  // 输出失败详情
  if (posFail.length > 0) {
    console.log('\n--- 正样本失败 ---');
    for (const f of posFail) console.log(`  #${f.number} ${f.title}: ${f.detail}`);
  }
  if (negFail.length > 0) {
    console.log('\n--- 负样本失败 ---');
    for (const f of negFail) console.log(`  #${f.number} ${f.title}: ${f.detail}`);
  }
  if (posSkipped.length > 0 || negSkipped.length > 0) {
    console.log('\n--- 无 diff 跳过 ---');
    for (const s of [...posSkipped, ...negSkipped]) console.log(`  #${s.number} ${s.title}: ${s.detail}`);
  }

  // 末行: failed 标签集合或 pass
  const failedTags = [...new Set([...posFail, ...negFail].flatMap(r => r.tags || []))];
  const allPass = posFail.length === 0 && negFail.length === 0 && symlinkResults.every(r => r.pass);
  if (allPass) {
    console.log('pass');
    process.exit(0);
  } else {
    console.log(`failed: ${failedTags.join(',') || 'unknown'}`);
    process.exit(1);
  }
}

await main();