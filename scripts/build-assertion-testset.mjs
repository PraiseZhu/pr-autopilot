#!/usr/bin/env node
// scripts/build-assertion-testset.mjs — 从 PR taxonomy 构建断言弱化测试集
// 用法: node scripts/build-assertion-testset.mjs --out <dir> [--mivo-dir <path>] [--taxonomy-dir <path>]
//   输入路径可通过 CLI 参数或环境变量指定:
//     --mivo-dir <path>       mivo-canvas 仓路径 (默认: $MIVO_CANVAS_DIR)
//     --taxonomy-dir <path>   PR taxonomy detail 目录 (默认: $TAXONOMY_DIR, 或 $MIVO_CANVAS_DIR/_tmp/debug/pr-taxonomy/detail)
//   若未指定 --mivo-dir 且 $MIVO_CANVAS_DIR 为空，脚本会尝试从当前工作目录向上查找 git 仓根。
// 输出: fixtures/assertion-weakening/testset.json + diffs/<n>.diff

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

function findGitRoot(startDir) {
  let d = resolve(startDir);
  while (d !== '/') {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function resolveMivoDir(cliArg) {
  if (cliArg) return cliArg;
  if (process.env.MIVO_CANVAS_DIR) return process.env.MIVO_CANVAS_DIR;
  return findGitRoot(process.cwd()) || null;
}

function resolveTaxonomyDir(cliArg, mivoDir) {
  if (cliArg) return cliArg;
  if (process.env.TAXONOMY_DIR) return process.env.TAXONOMY_DIR;
  if (mivoDir) return join(mivoDir, '_tmp', 'debug', 'pr-taxonomy', 'detail');
  return null;
}

// curated 类型覆盖：PR 号 → detector 权威词汇表（不依赖 builder 关键词启发式）
// 当 builder 的启发式标签与 detector 实际产出不一致时，在此处手动纠正。
// 启发式标签保留在 heuristic_types 字段，不参与断言。
const CURATED_TYPES = {
  382: ['skip_log_early_return'],
};

const ASSERTION_WEAKENING_KEYWORDS = [
  'skip', '跳过', '弱化', '删断言', '删除断言', 'xdescribe', 'xtest', 'xit',
  'early return', '注释掉', '删测试', '删除测试', 'test_skip', 'relaxed',
  'console.log.*skip', 'mask-point', '显式 SKIP',
];

// 判断形态
function measurePR(pr) {
  const text = `${pr.title} ${pr.body}`;
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
    else if (process.argv[i] === '--mivo-dir') { args.mivoDir = process.argv[++i]; }
    else if (process.argv[i] === '--taxonomy-dir') { args.taxonomyDir = process.argv[++i]; }
  }
  if (!args.out) { process.stderr.write('[FAIL] 请指定 --out <dir>\n'); process.exit(2); }

  const MIVO = resolveMivoDir(args.mivoDir);
  if (!MIVO) { process.stderr.write('[FAIL] 无法确定 mivo-canvas 仓路径。请通过 --mivo-dir <path> 或环境变量 MIVO_CANVAS_DIR 指定\n'); process.exit(2); }
  const TAXONOMY_DIR = resolveTaxonomyDir(args.taxonomyDir, MIVO);
  if (!TAXONOMY_DIR) { process.stderr.write('[FAIL] 无法确定 taxonomy 目录。请通过 --taxonomy-dir <path> 或环境变量 TAXONOMY_DIR 指定\n'); process.exit(2); }

  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  const diffsDir = join(args.out, 'diffs');
  if (!existsSync(diffsDir)) mkdirSync(diffsDir, { recursive: true });

  if (!existsSync(TAXONOMY_DIR)) { process.stderr.write(`[FAIL] taxonomy 目录不存在: ${TAXONOMY_DIR}。请通过 --taxonomy-dir <path> 或环境变量 TAXONOMY_DIR 指定正确的路径\n`); process.exit(2); }

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
      heuristic_types: measurePR(p)?.types || [],
      types: CURATED_TYPES[p.number] || measurePR(p)?.types || [],
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