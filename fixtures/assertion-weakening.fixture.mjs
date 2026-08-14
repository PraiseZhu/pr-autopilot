// fixtures/assertion-weakening.fixture.mjs — 断言弱化检测器回归测试
// 用法: node fixtures/assertion-weakening.fixture.mjs
// 输出: 逐行汇总 + 末行 failed: <标签集> 或 pass
//
// 注: 这个 fixture 的 cwd 固定在 fixtures/ 下（run-all.sh 的 cd 或绝对路径）

import { readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = fileURLToPath(import.meta.url);
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
  process.exit(2);
}

// ── 第①组: 正样本检测 ──
function runPositiveTests(testset) {
  const results = [];
  for (const pos of testset.positives) {
    if (!pos.hasDiff) {
      results.push({ number: pos.number, title: pos.title, diff: 'N/A', pass: false, findings: -1, detail: 'not_run: hasDiff=false', tags: pos.types });
      continue;
    }
    const diffPath = join(DIFFS, `${pos.number}.diff`);
    if (!existsSync(diffPath)) { results.push({ number: pos.number, title: pos.title, diff: `${pos.number}.diff`, pass: false, findings: -1, detail: 'not_run: diff file missing', tags: pos.types }); continue; }
    const diff = readFileSync(diffPath, 'utf8');
    if (!diff.trim()) { results.push({ number: pos.number, title: pos.title, diff: `${pos.number}.diff`, pass: false, findings: -1, detail: 'not_run: diff empty', tags: pos.types }); continue; }
    try {
      const result = detectAssertionWeakening(diff);
      const foundTypes = new Set(result.findings.map(f => f.type));
      const hasFindings = result.summary.total > 0;
      const typesMatch = pos.types.length === 0 || pos.types.some(t => foundTypes.has(t));
      const pass = hasFindings && typesMatch;
      results.push({
        number: pos.number,
        title: pos.title,
        diff: `${pos.number}.diff`,
        pass,
        findings: result.summary.total,
        detail: !hasFindings ? `MISS: 0 findings (expected >0)`
          : !typesMatch ? `MISMATCH: expected types [${pos.types.join(',')}] not in [${[...foundTypes].join(',')}]`
          : `OK: ${result.summary.total} findings`,
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
      results.push({ number: neg.number, title: neg.title, diff: 'N/A', pass: false, findings: -1, detail: 'not_run: hasDiff=false', tags: [] });
      continue;
    }
    const diffPath = join(DIFFS, `${neg.number}.diff`);
    if (!existsSync(diffPath)) { results.push({ number: neg.number, title: neg.title, diff: `${neg.number}.diff`, pass: false, findings: -1, detail: 'not_run: diff file missing', tags: [] }); continue; }
    const diff = readFileSync(diffPath, 'utf8');
    if (!diff.trim()) { results.push({ number: neg.number, title: neg.title, diff: `${neg.number}.diff`, pass: false, findings: -1, detail: 'not_run: diff empty', tags: [] }); continue; }
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
  if (!existsSync(TESTSET)) { console.error('[FATAL] 测试集不存在'); process.exit(2); }
  const testset = JSON.parse(readFileSync(TESTSET, 'utf8'));

  // 第①组
  const positiveResults = runPositiveTests(testset);
  const posSkipped = positiveResults.filter(r => r.detail && r.detail.startsWith('not_run'));
  const posPass = positiveResults.filter(r => r.pass && !r.detail?.startsWith('not_run'));
  const posFail = positiveResults.filter(r => !r.pass && !r.detail?.startsWith('not_run'));
  const posTotal = positiveResults.filter(r => !r.detail?.startsWith('not_run')).length;

  // 第②组
  const negativeResults = runNegativeTests(testset);
  const negSkipped = negativeResults.filter(r => r.detail && r.detail.startsWith('not_run'));
  const negPass = negativeResults.filter(r => r.pass && !r.detail?.startsWith('not_run'));
  const negFail = negativeResults.filter(r => !r.pass && !r.detail?.startsWith('not_run'));
  const negTotal = negativeResults.filter(r => !r.detail?.startsWith('not_run')).length;

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
  const allPass = posFail.length === 0 && negFail.length === 0
    && posSkipped.length === 0 && negSkipped.length === 0
    && symlinkResults.every(r => r.pass);
  if (allPass) {
    console.log('pass');
    process.exit(0);
  } else {
    console.log(`failed: ${failedTags.join(',') || 'unknown'}`);
    process.exit(1);
  }
}

// ── FAM-4 回归测试：语料缺失必须让 fixture 失败 ──
// 用法: node fixtures/assertion-weakening.fixture.mjs --check-fam4
// 用 410.diff（仅负样本引用，不污染软链测试）做语料缺失反例
async function checkFam4() {
  const diff410 = join(DIFFS, '410.diff');
  const bak410 = join(DIFFS, '410.diff.fam4-bak');

  if (!existsSync(diff410)) {
    console.log('FAM-4 SKIP: 410.diff 不存在，无法执行回归');
    process.exit(2);
  }

  // 1. 先确认当前状态（零 skipped）是绿的
  console.log('--- FAM-4 对照组: 语料完整 ---');
  const ctrl = spawnSync(process.execPath, [FIXTURE_FILE], { encoding: 'utf8', timeout: 30000, cwd: HERE });
  const ctrlPass = ctrl.status === 0 && /^pass$/m.test(ctrl.stdout.trim());
  console.log(`对照组 exit=${ctrl.status} ${ctrlPass ? '✓ pass' : '✗ 非预期失败'}`);
  if (!ctrlPass) {
    console.log(ctrl.stdout.trim());
    console.log('FAM-4 FAIL: 对照组应 pass，但 exit ≠ 0');
    process.exit(1);
  }

  // 2. 单一变更：移走 410.diff → 语料缺失
  let expFail = false;
  let expOutput = '';
  try {
    renameSync(diff410, bak410);

    console.log('\n--- FAM-4 实验组: 410.diff 缺失（语料不可用）---');
    const exp = spawnSync(process.execPath, [FIXTURE_FILE], { encoding: 'utf8', timeout: 30000, cwd: HERE });
    expFail = exp.status !== 0 && /^failed/m.test(exp.stdout.trim());
    expOutput = exp.stdout.trim();
    console.log(`实验组 exit=${exp.status} ${expFail ? '✓ 预期失败（exit 1）' : '✗ 应 exit 1 但未失败'}`);
    console.log(expOutput);
  } finally {
    // 恢复（必须在 process.exit 前执行，因为 exit 不触发 finally）
    if (existsSync(bak410)) renameSync(bak410, diff410);
  }
  if (!expFail) {
    console.log('FAM-4 FAIL: 语料缺失时 fixture 应 exit 1，实际未失败');
    process.exit(1);
  }

  // 3. 恢复后再次确认绿
  console.log('\n--- FAM-4 恢复验证: 语料恢复后应重新绿 ---');
  const restore = spawnSync(process.execPath, [FIXTURE_FILE], { encoding: 'utf8', timeout: 30000, cwd: HERE });
  const restorePass = restore.status === 0 && /^pass$/m.test(restore.stdout.trim());
  console.log(`恢复后 exit=${restore.status} ${restorePass ? '✓ pass' : '✗ 非预期失败'}`);
  if (!restorePass) {
    console.log(restore.stdout.trim());
    console.log('FAM-4 FAIL: 恢复后应 pass');
    process.exit(1);
  }

  console.log('\nFAM-4 PASS: 语料缺失 → exit 1 ✓  语料恢复 → exit 0 ✓');
  process.exit(0);
}

// ── 入口 ──
const isFam4 = process.argv.includes('--check-fam4');
if (isFam4) {
  await checkFam4();
} else {
  await main();
}