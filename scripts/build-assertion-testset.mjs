#!/usr/bin/env node
// scripts/build-assertion-testset.mjs — 从 PR taxonomy 构建断言弱化测试集
// 用法: node scripts/build-assertion-testset.mjs --out <dir>
// 输出: fixtures/assertion-weakening/testset.json + diffs/<n>.diff

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIVO = '/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas';
const TAXONOMY_DIR = join(MIVO, '_tmp', 'debug', 'pr-taxonomy', 'detail');

const ASSERTION_WEAKENING_KEYWORDS = [
  'skip', '跳过', '弱化', '删断言', '删除断言', 'xdescribe', 'xtest', 'xit',
  'early return', '注释掉', '删测试', '删除测试', 'test_skip', 'relaxed',
  'console.log.*skip', 'mask-point', '显式 SKIP',
];

// 判断形态
function measurePR(pr) {
  const text = `${pr.title} ${pr.body} ${(pr.files||[]).map(f => f.path).join(' ')}`;
  const low = text.toLowerCase();
  const types = [];
  const files = pr.files || [];

  const testFiles = files.filter(f =>
    /\.(test|spec|e2e)\.(mjs|js|ts|jsx|tsx)$/.test(f.path) ||
    f.path.includes('__tests__') || f.path.includes('/e2e/') || f.path.includes('/scenarios/')
  );
  if (testFiles.length === 0) return null;

  if (low.includes('skip') || low.includes('.skip')) types.push('test_skipped');
  if (low.includes('xdescribe') || low.includes('xtest') || low.includes('xit')) types.push('xtest_used');
  if (low.includes('删除断言') || low.includes('删断言')) types.push('deleted_assertion');
  if (low.includes('弱化') || low.includes('relax')) types.push('relaxed_matcher');
  if (low.includes('删测试') || low.includes('删除测试') || low.includes('delete.*test')) types.push('deleted_test_block');
  if (/console\.log\(.*SKIP/i.test(text)) types.push('skip_log_early_return');

  if (types.length === 0 && testFiles.length > 0 && pr.deletions > 0) types.push('deleted_assertion');
  return { types, testFiles: testFiles.map(f => f.path) };
}

function isAssertionWeakening(pr) {
  const text = `${pr.title} ${pr.body}`;
  return ASSERTION_WEAKENING_KEYWORDS.some(k => new RegExp(k, 'i').test(text));
}

function isPureTestAddition(pr) {
  // 纯新增测试：文件全是测试文件，且无实质性删除
  const files = pr.files || [];
  const allTestFiles = files.every(f =>
    /\.(test|spec|e2e)\.(mjs|js|ts|jsx|tsx)$/.test(f.path) ||
    f.path.includes('__tests__') || f.path.includes('/e2e/') || f.path.includes('/scenarios/') ||
    f.path.startsWith('test-') || f.path.startsWith('spec-')
  );
  // 基本无删除行 (≤1 行可能是 import 替换)
  const hasMeaningfulDeletions = files.some(f => f.deletions > 1) || pr.deletions > 1;
  return allTestFiles && !hasMeaningfulDeletions && pr.title.toLowerCase().includes('test');
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--out') { args.out = process.argv[++i]; }
  }
  if (!args.out) { process.stderr.write('[FAIL] 请指定 --out <dir>\n'); process.exit(2); }

  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  const diffsDir = join(args.out, 'diffs');
  if (!existsSync(diffsDir)) mkdirSync(diffsDir, { recursive: true });

  if (!existsSync(TAXONOMY_DIR)) { process.stderr.write(`[FAIL] taxonomy 目录不存在: ${TAXONOMY_DIR}\n`); process.exit(2); }

  const entries = [];
  for (const name of readdirSync(TAXONOMY_DIR)) {
    if (!name.endsWith('.json')) continue;
    try { entries.push(JSON.parse(readFileSync(join(TAXONOMY_DIR, name), 'utf8'))); } catch {}
  }
  entries.sort((a, b) => a.number - b.number);

  const positives = []; // 断言弱化 PR
  const negatives = []; // 纯新增测试 PR（无断言弱化）

  for (const pr of entries) {
    const result = measurePR(pr);
    if (!result) continue;

    if (isAssertionWeakening(pr)) {
      positives.push(pr);
    } else if (isPureTestAddition(pr)) {
      negatives.push(pr);
    } else if (result.types.length > 0) {
      // 有形态标记但未命中 assertion weakening 关键词 → 保守放正样本
      positives.push(pr);
    }
  }

  // 确保 #382 在正样本，#410 在负样本
  if (!positives.some(p => p.number === 382)) {
    const p = entries.find(e => e.number === 382);
    if (p) positives.push(p);
  }
  if (!negatives.some(n => n.number === 410)) {
    const n = entries.find(e => e.number === 410);
    if (n) negatives.push(n);
  }

  // 从 git 历史查找 PR commit 的 SHA
  function findPrCommitSha(prNumber) {
    for (const pattern of [`(#${prNumber})`, `#${prNumber}`]) {
      try {
        const sha = execFileSync('git', ['-C', MIVO, 'log', '--all', '--grep', pattern, '--format=%H', '-1'], { encoding: 'utf8', timeout: 15000 }).trim();
        if (sha) return sha;
      } catch { /* 下一种 pattern */ }
    }
    return null;
  }

  // 提取单个 PR 的 diff 文件
  function extractDiffFile(prNumber) {
    const diffPath = join(diffsDir, `${prNumber}.diff`);
    if (existsSync(diffPath)) return true;

    const sha = findPrCommitSha(prNumber);
    if (!sha) return false;

    // 对 merge commit: diff 第一个 parent 就是 PR 全量改动
    try {
      const diff = execFileSync('git', ['-C', MIVO, 'diff', `${sha}^`, sha], { encoding: 'utf8', timeout: 15000 });
      if (diff.trim()) { writeFileSync(diffPath, diff); return true; }
    } catch {
      // fallback: git show
      try {
        const diff = execFileSync('git', ['-C', MIVO, 'show', sha, '--format='], { encoding: 'utf8', timeout: 15000 });
        if (diff.trim()) { writeFileSync(diffPath, diff); return true; }
      } catch {}
    }
    return false;
  }

  // 复制 diff 文件
  for (const pr of [...positives, ...negatives]) {
    extractDiffFile(pr.number);
  }

  // 关键 PR 必须能抽出 diff
  const requiredPRs = [382, 410];
  const missingRequired = requiredPRs.filter(n => !existsSync(join(diffsDir, `${n}.diff`)));
  if (missingRequired.length > 0) {
    process.stderr.write(`[FATAL] 关键 PR 的 diff 无法从 git 历史抽出: #${missingRequired.join(', #')}\n`);
    process.stderr.write(`  确认 mivo-canvas 仓 (${MIVO}) 包含这些 PR 的 merge commit\n`);
    process.exit(2);
  }

  // 正负样本都只保留 hasDiff===true 的条目
  const keptPositives = positives.filter(p => existsSync(join(diffsDir, `${p.number}.diff`)));
  const keptNegatives = negatives.filter(n => existsSync(join(diffsDir, `${n.number}.diff`)));
  const droppedPositives = positives.length - keptPositives.length;
  const droppedNegatives = negatives.length - keptNegatives.length;

  const testset = {
    generated: new Date().toISOString(),
    source: TAXONOMY_DIR,
    total_entries: entries.length,
    positives: keptPositives.map(p => ({
      number: p.number, title: p.title,
      types: measurePR(p)?.types || [],
      files: (p.files||[]).map(f => f.path),
      hasDiff: true,
    })),
    negatives: keptNegatives.map(n => ({
      number: n.number, title: n.title,
      files: (n.files||[]).map(f => f.path),
      hasDiff: true,
    })),
  };

  writeFileSync(join(args.out, 'testset.json'), JSON.stringify(testset, null, 2));

  process.stdout.write(JSON.stringify({
    status: 'ok', total_entries: entries.length,
    positive_count: keptPositives.length, negative_count: keptNegatives.length,
    kept_with_diff: keptPositives.length + keptNegatives.length,
    dropped_no_diff: droppedPositives + droppedNegatives,
    has_382_in_positive: keptPositives.some(p => p.number === 382),
    has_410_in_negative: keptNegatives.some(n => n.number === 410),
    output_dir: args.out,
  }, null, 2) + '\n');
  process.exit(0);
}

main();