#!/usr/bin/env node
// gh 快照适配器 v2 — 计划依据: W-2/W-3
// 审③修复:
//   I7   : 真实 ETag 条件请求——每 endpoint 持久化 {etag, body}，请求带 If-None-Match，
//          304 直接用缓存（不重解析不覆盖），任一错误 fail-closed
//   F10-R: remote_findings 经 GraphQL reviewThreads 归一化产出（isResolved/isOutdated/
//          path/commit oid），E1/E2 采集真实接通
// 用法: gh-snapshot.mjs <owner> <repo> <pr>；GH_BIN 注入（契约 fixture 用假 gh）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ciReadiness } from '../../scripts/ci-readiness.mjs';

const GH = process.env.GH_BIN ?? 'gh';
const CACHE_DIR = process.env.SNAPSHOT_CACHE_DIR ?? null;
const [owner, repo, pr] = process.argv.slice(2);
if (!owner || !repo || !pr) { process.stderr.write('用法: gh-snapshot.mjs <owner> <repo> <pr>\n'); process.exit(1); }

function cachePath(endpoint) {
  const h = createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
  return join(CACHE_DIR, `etag-${h}.json`);
}

// I7: 条件请求。gh api -i 输出 headers+body；304 时 gh 以非零退出 → 从异常输出判 304 用缓存。
function ghGet(endpoint, { paginate = false } = {}) {
  const cacheFile = CACHE_DIR ? cachePath(endpoint) : null;
  const cached = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
  const args = ['api', '-i'];
  if (paginate) args.push('--paginate');
  if (cached?.etag) args.push('-H', `If-None-Match: ${cached.etag}`);
  args.push(endpoint);
  let raw;
  try {
    raw = execFileSync(GH, args, { encoding: 'utf8' });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (/HTTP\/[\d.]+ 304/.test(out) || /\b304\b/.test(out.split('\n')[0] ?? '')) {
      if (cached) return cached.body; // 304 → 缓存即真相，不重解析不覆盖
    }
    throw e; // 其他错误 fail-closed
  }
  // 解析 headers/body（--paginate 时可能有多段 header+body）
  const segments = raw.split(/\r?\n\r?\n/);
  let etag = null;
  const bodies = [];
  for (let i = 0; i < segments.length; i++) {
    if (/^HTTP\//.test(segments[i])) {
      const m = segments[i].match(/^Etag:\s*(.+)$/im);
      if (m) etag = m[1].trim();
    } else if (segments[i].trim()) {
      bodies.push(segments[i]);
    }
  }
  let body;
  if (paginate) {
    body = [];
    for (const b of bodies) { const parsed = JSON.parse(b); body.push(...(Array.isArray(parsed) ? parsed : [parsed])); }
  } else {
    body = JSON.parse(bodies.join(''));
  }
  if (cacheFile) { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ etag, body })); }
  return body;
}

function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push('-F', `${k}=${v}`);
  return JSON.parse(execFileSync(GH, args, { encoding: 'utf8' }));
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
    reviewThreads(first:100, after:$cursor){
      pageInfo{ hasNextPage endCursor }
      nodes{
        id isResolved isOutdated path
        comments(first:10){ nodes{ id body author{login} commit{ oid } } }
      }
    }
  } } }`;

// 审④-I2: reviewThreads 全分页——第 101+ 条 thread 不再静默遗漏
// 审⑤-I1: 结构强断言 + 进度守卫——nodes 必须是数组、hasNextPage 必须是布尔（缺结构
// 不再被 ??[] 当成空末页）；hasNext 时 endCursor 必须非空且未出现过（停滞/循环即抛）；
// 页数硬上限兜底（100 条/页 × 200 页 = 2 万 thread，超出必是 API 异常）。
const MAX_THREAD_PAGES = 200;
function fetchAllThreads(owner, repo, pr) {
  const all = [];
  let cursor = null;
  const seenCursors = new Set();
  for (let page = 1; ; page++) {
    if (page > MAX_THREAD_PAGES) throw new Error(`reviewThreads 分页超过 ${MAX_THREAD_PAGES} 页上限（疑似游标循环，fail-closed）`);
    const vars = { owner, repo, pr: Number(pr) };
    if (cursor) vars.cursor = cursor;
    const gql = ghGraphql(THREADS_QUERY, vars);
    const conn = gql.data?.repository?.pullRequest?.reviewThreads;
    if (!conn) throw new Error('reviewThreads 响应结构异常（fail-closed）');
    if (!Array.isArray(conn.nodes)) throw new Error('reviewThreads.nodes 非数组（结构缺失不当成空末页，fail-closed）');
    if (typeof conn.pageInfo?.hasNextPage !== 'boolean') throw new Error('reviewThreads.pageInfo.hasNextPage 缺失/非布尔（fail-closed）');
    all.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    const next = conn.pageInfo.endCursor;
    if (typeof next !== 'string' || !next) throw new Error('hasNextPage=true 但 endCursor 缺失/为空（无法推进，fail-closed）');
    if (seenCursors.has(next)) throw new Error(`endCursor 重复出现（${next}）——游标停滞/循环，fail-closed`);
    seenCursors.add(next);
    cursor = next;
  }
  return all;
}

try {
  const prData = ghGet(`repos/${owner}/${repo}/pulls/${pr}`);
  const state = prData.merged_at ? 'merged' : prData.state;
  const headSha = prData.head?.sha;
  let selfLogin = null;
  try { selfLogin = ghGet('user').login; } catch { /* 拿不到则不过滤，宁多唤醒 */ }

  const reviewsRaw = ghGet(`repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=50`, { paginate: true });
  const reviews = reviewsRaw.map((r) => ({
    id: String(r.id), state: r.state, commitOid: r.commit_id,
    dismissed: r.state === 'DISMISSED', outdated: false,
    body: r.body ?? '', author_is_self: selfLogin != null && r.user?.login === selfLogin
  }));

  const rcs = ghGet(`repos/${owner}/${repo}/pulls/${pr}/comments?per_page=50`, { paginate: true });
  const ics = ghGet(`repos/${owner}/${repo}/issues/${pr}/comments?per_page=50`, { paginate: true });
  const comments = [...rcs, ...ics].map((c) => ({
    id: String(c.id), body: c.body ?? '',
    author_is_self: selfLogin != null && c.user?.login === selfLogin
  }));

  const checkRuns = (ghGet(`repos/${owner}/${repo}/commits/${headSha}/check-runs`).check_runs ?? []).map((c) => ({
    context: c.name,
    state: c.status !== 'completed' ? 'pending' : (c.conclusion === 'success' ? 'success' : c.conclusion ?? 'error'),
    head_sha: headSha, completed_at: c.completed_at ?? c.started_at ?? null, run_id: String(c.id)
  }));
  const statuses = (ghGet(`repos/${owner}/${repo}/commits/${headSha}/status`).statuses ?? []).map((s) => ({
    context: s.context, state: s.state, head_sha: headSha, completed_at: s.updated_at ?? null, run_id: String(s.id)
  }));
  const checks = [...checkRuns, ...statuses];
  let required = [];
  const reqFile = process.env.REQUIRED_CONTEXTS_FILE;
  if (reqFile && existsSync(reqFile)) required = JSON.parse(readFileSync(reqFile, 'utf8'))[`${owner}/${repo}`] ?? [];
  const ci = required.length
    ? (() => { const r = ciReadiness({ headSha, checks, required }); return { green: r.green, failing: r.green ? [] : [r.reason], head_sha: headSha }; })()
    : { green: false, failing: ['required contexts 未配置（fail-closed）'], head_sha: headSha };

  // F10-R: reviewThreads → remote_findings 归一化（E1/E2 采集输入）
  let remoteFindings = [];
  try {
    const threads = fetchAllThreads(owner, repo, pr);
    remoteFindings = threads.map((t) => {
      const first = t.comments?.nodes?.[0] ?? {};
      return {
        node_id: t.id,
        head_sha: first.commit?.oid ?? headSha,
        path: t.path ?? '',
        summary: (first.body ?? '').slice(0, 300),
        source: first.author?.login ?? 'unknown',
        state: t.isOutdated ? 'outdated' : (t.isResolved ? 'resolved' : 'open'),
        resolved: t.isResolved === true,
        accepted: false, // accepted 语义（owner 明确接受）需评论内容判定，P0 后按真实数据补规则
        kind: 'finding'
      };
    });
  } catch (e) {
    // fail-open 但如实带出——escape 采集缺这轮数据，不影响盯梢主链
    process.stderr.write(`[GH-SNAPSHOT] reviewThreads GraphQL 失败: ${e.message}（remote_findings 本轮为空，已如实标注）\n`);
  }

  process.stdout.write(JSON.stringify({
    state, head_sha: headSha, ci, reviews, comments,
    labels: (prData.labels ?? []).map((l) => l.name),
    mergeable: prData.mergeable === false ? false : (prData.mergeable === true ? true : null),
    remote_findings: remoteFindings
  }) + '\n');
} catch (e) {
  process.stderr.write(`[GH-SNAPSHOT] ${e.message}\n`);
  process.exit(1);
}
