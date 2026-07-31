#!/usr/bin/env node
// DeepSeek 渲染输出机器门 — 计划依据: §0.3-I2 / §3.1 / §3.3 风格契约
// 审②-I1 扩面: tokenize 检测 identifier/path/command；完整性要求自然语言结构
// （含 CJK 或 ≥3 个词 + 句读），不再只看长度；fallback 不再拼原始标题——
// 标题过不了 lint 就用不带标题的安全模板（由 fallbackRender 保证自身必过验）。
import { readJson, parseArgs, isMain} from '../lib/common.mjs';

const LINE_PATTERNS = [
  { re: /`/, why: '反引号' },
  { re: /\bhttps?:\/\/\S+/, why: '裸 URL（链接放卡片按钮，不进句子）' },
  { re: /--[a-z-]{2,}/, why: '命令行参数' },
  { re: /<[a-z]+[^>]*>/i, why: 'HTML/XML 标签' }
];
const CMD_WORDS = new Set(['npm', 'yarn', 'pnpm', 'git', 'node', 'npx', 'pip', 'pytest', 'cargo', 'docker', 'bash', 'sh', 'curl']);
// 品牌/产品名白名单: 形似 camel/Pascal 但属于日常人话，不算代码标识符
const ALLOW_WORDS = new Set(['github', 'gitlab', 'deepseek', 'taptap', 'youtube', 'ios', 'macos', 'iphone', 'ipad', 'javascript', 'typescript', 'copilot', 'greptile', 'openai', 'xcode', 'wechat', 'figma', 'playwright']);
const FILE_EXT_RE = /\.(mjs|cjs|jsx?|tsx?|json|md|ya?ml|py|sh|go|rs|java|kt|rb|css|html|sql|toml|lock)$/i;

export function lintSentence(sentence) {
  const hits = [];
  const s = String(sentence);
  for (const p of LINE_PATTERNS) {
    if (p.re.test(s)) hits.push(p.why);
  }
  // token 级检测（I1: 覆盖无括号 camelCase/PascalCase 混合、单段 snake_case、无扩展名路径、裸文件名、命令）
  const tokens = s.split(/[\s，。、！？；：「」（）()\[\]{}"']+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (ALLOW_WORDS.has(t.toLowerCase())) continue;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(t)) { hits.push(`路径样式标识符: ${t}`); continue; }
    if (FILE_EXT_RE.test(t)) { hits.push(`文件名: ${t}`); continue; }
    if (/^[a-z0-9]+_[a-z0-9_]+$/i.test(t)) { hits.push(`snake_case 标识符: ${t}`); continue; }
    if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) { hits.push(`camelCase 标识符: ${t}`); continue; }
    if (/^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(t)) { hits.push(`PascalCase 标识符: ${t}`); continue; }
    if (/\(\)/.test(t)) { hits.push(`函数调用样式: ${t}`); continue; }
    if (CMD_WORDS.has(t.toLowerCase()) && i + 1 < tokens.length && /^[a-z][a-z0-9:_-]*$/i.test(tokens[i + 1])) {
      hits.push(`命令样式: ${t} ${tokens[i + 1]}`); continue;
    }
  }
  // 完整性: 必须像自然语言（含 CJK，或 ≥3 个词），且不是半截话
  const hasCjk = /[一-鿿]/.test(s);
  const wordCount = tokens.length;
  if (!hasCjk && wordCount < 3) hits.push('不是完整自然语言句子（完整性契约）');
  if (s.trim().length < 8) hits.push('半截话（完整性契约: 每行一个完整意思）');
  return hits;
}

export function validateRender(input, output) {
  const errors = [];
  if (!Array.isArray(output)) return { ok: false, errors: ['输出不是数组'] };

  const inIds = new Set(input.map((i) => i.source_id));
  const outIds = new Set(output.map((o) => o.source_id));
  for (const id of inIds) if (!outIds.has(id)) errors.push(`丢条目: source_id=${id}（幻觉删除被拦）`);
  for (const id of outIds) if (!inIds.has(id)) errors.push(`多条目: source_id=${id}（幻觉新增被拦）`);
  if (output.length !== input.length) errors.push(`条数不等: in=${input.length} out=${output.length}`);

  const byId = new Map(input.map((i) => [i.source_id, i]));
  for (const o of output) {
    const src = byId.get(o.source_id);
    if (!src) continue;
    if (typeof o.sentence !== 'string' || !o.sentence.trim()) { errors.push(`source_id=${o.source_id} sentence 为空`); continue; }
    const lint = lintSentence(o.sentence);
    for (const why of lint) errors.push(`source_id=${o.source_id} 违反风格契约: ${why}`);
    for (const k of ['url', 'state', 'repo']) {
      if (k in o && o[k] !== src[k]) errors.push(`source_id=${o.source_id} 试图改写 ${k}（只许改 sentence）`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// 回退确定性模板 — 二级降级（I1）:
// 一级: 标题过 lint → 带净化标题；二级: 标题不过 → 不带标题的安全句。
export function fallbackRender(items) {
  const label = { blocking_others: '【阻塞别人】', awaiting_decision: '【等你拍板】', mentioned: '【有人找你】', closed_on_me: '【被人关掉】', other: '【其他】' };
  return items.map((i) => {
    const tag = label[i.kind] ?? '【其他】';
    const repoName = String(i.repo).split('/').pop() ?? '';
    const withTitle = `${tag}${repoName} 仓有一条「${i.title}」需要你看一眼`;
    if (lintSentence(withTitle).length === 0) {
      return { source_id: i.source_id, sentence: withTitle };
    }
    return { source_id: i.source_id, sentence: `${tag}${repoName} 仓有一条待处理事项，标题含技术词已省略，点开卡片链接看详情` };
  });
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) { process.stderr.write('用法: render-validate.mjs --input <items.json> --output <rendered.json>\n'); process.exit(1); }
  const res = validateRender(readJson(args.input), readJson(args.output));
  if (!res.ok) {
    for (const e of res.errors) process.stderr.write(`[RENDER-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('ok\n');
}
