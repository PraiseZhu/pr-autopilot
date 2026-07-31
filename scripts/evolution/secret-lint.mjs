#!/usr/bin/env node
// secret-lint — 计划依据: E6（安全台账自己不能变成泄密源，审⑧/审⑨）
// 审②-F12 扩面: 补 sk-* provider key、credential=、通用赋值（含未加引号）、
// query-string secret、递归扫描任意嵌套结构。输出只给掩码后的片段。
import { readFileSync } from 'node:fs';
import { parseArgs, isMain} from '../lib/common.mjs';

const PATTERNS = [
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'openai-anthropic-key', re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer-header', re: /[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: 'authorization-header', re: /[Aa]uthorization:\s*\S{8,}/g },
  { name: 'generic-secret-assign', re: /(secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;]{8,}/gi },
  { name: 'query-secret', re: /[?&](token|key|secret|password|credential)=[^\s&"']{8,}/gi },
  { name: 'env-value', re: /\b[A-Z][A-Z0-9_]{4,}=(?!(true|false|\d{1,4}|null)\b)[^\s"']{12,}/g }
];

function mask(s) {
  return s.length <= 8 ? '****' : s.slice(0, 4) + '…' + '*'.repeat(4);
}

export function secretLint(text) {
  const hits = [];
  for (const p of PATTERNS) {
    for (const m of String(text).matchAll(p.re)) {
      hits.push({ pattern: p.name, masked: mask(m[0]), index: m.index });
    }
  }
  return hits;
}

export function scrubText(s) {
  let out = String(s);
  for (const p of PATTERNS) out = out.replace(p.re, '[REDACTED]');
  return out;
}

// 审②-F12: 递归脱敏任意嵌套结构（字符串全 scrub + 截断；对象/数组深入）
export function deepScrub(value, maxLen = 400) {
  if (typeof value === 'string') return scrubText(value).slice(0, maxLen);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, maxLen));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v, maxLen);
    return out;
  }
  return value;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? args._[0];
  if (!file) { process.stderr.write('用法: secret-lint.mjs <file>\n'); process.exit(1); }
  const hits = secretLint(readFileSync(file, 'utf8'));
  if (hits.length) {
    for (const h of hits) process.stderr.write(`[SECRET-LINT] ${h.pattern} @${h.index}: ${h.masked}\n`);
    process.exit(1);
  }
  process.stdout.write('clean\n');
}
