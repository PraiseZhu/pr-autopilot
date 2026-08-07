#!/usr/bin/env node
// 补注册接线契约 fixture — 共识计划 T1 (SC-1b)。
// 真实三层接线（own-prs.mjs 的 listOwnPrs → reconcile-own-prs.mjs → register.mjs 的 registerPr），
// 只 stub gh 二进制（GH_BIN 注入，模式同 run-fixtures.mjs 的 gh-snapshot 契约 fixture）。
// 覆盖: 正常映射 / fork 三态（含 finalize.mjs:46-50→git-checks.mjs:24-27 消费口径）/
//       缺 headRefName 或 nameWithOwner 非字符串 → dropped 且 exit 0 / gh 失败非零 /
//       空列表 [] / 双仓互不污染 / 幂等 already / 缺 map key 非零 / registerPr throw 非零。
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../scripts/lib/common.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RECONCILE = fileURLToPath(new URL('../deploy/wrappers/reconcile-own-prs.mjs', import.meta.url));
const OWN_PRS = fileURLToPath(new URL('../deploy/wrappers/own-prs.mjs', import.meta.url));

let failed = 0;
const eq = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) { failed++; console.error(`FAIL ${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };
const ok = (cond, label) => { if (!cond) { failed++; console.error(`FAIL ${label}`); } };

const MIVO = 'xindong/mivo-canvas';
const CINDY = 'PraiseZhu/pr-autopilot';
const FORK = 'PraiseZhu/cindy-fork';
const MAP = { [MIVO]: 'origin', [CINDY]: 'fork' };

// ---- stub gh: 按 --repo 与 OWN_PRS_FIXTURE_MODE 输出确定性响应 ----
const FAKE_GH_SRC = `
const argv = process.argv.slice(2);
if (process.env.OWN_PRS_FIXTURE_MODE === 'fail') { process.stderr.write('gh: boom\\n'); process.exit(1); }
if (argv[0] !== 'pr' || argv[1] !== 'list') { process.stderr.write('unknown endpoint: ' + argv.join(' ')); process.exit(1); }
const repo = argv[argv.indexOf('--repo') + 1];
if (process.env.OWN_PRS_FIXTURE_MODE === 'empty') { process.stdout.write('[]'); process.exit(0); }
const MIVO = 'xindong/mivo-canvas', CINDY = 'PraiseZhu/pr-autopilot', FORK = 'PraiseZhu/cindy-fork';
const byRepo = {
  [MIVO]: [
    { number: 101, headRefName: 'feat/mivo-base', headRepository: { nameWithOwner: MIVO } },
    { number: 102, headRefName: 'feat/mivo-fork', headRepository: { nameWithOwner: FORK } },
    { number: 103, headRefName: null, headRepository: { nameWithOwner: MIVO } },
    { number: 104, headRefName: 'feat/mivo-badnw', headRepository: { nameWithOwner: 42 } }
  ],
  [CINDY]: [
    { number: 201, headRefName: 'feat/cindy-fork', headRepository: { nameWithOwner: FORK } },
    { number: 202, headRefName: 'feat/cindy-base', headRepository: { nameWithOwner: CINDY } }
  ]
};
if (!byRepo[repo]) { process.stderr.write('unknown repo: ' + repo); process.exit(1); }
process.stdout.write(JSON.stringify(byRepo[repo]));
`;

// ---- 组装临时环境: gd/gh（stub 可执行）+ map.json + 两个 stateDir ----
const gd = mkdtempSync(join(tmpdir(), 'own-prs-fix-'));
const ghWrap = join(gd, 'gh');
writeFileSync(join(gd, 'fake-gh.mjs'), FAKE_GH_SRC);
writeFileSync(ghWrap, `#!/bin/sh\nexec "${process.execPath}" "${join(gd, 'fake-gh.mjs')}" "$@"\n`);
execFileSync('chmod', ['+x', ghWrap]);
writeFileSync(join(gd, 'map.json'), JSON.stringify(MAP));
const env = { ...process.env, GH_BIN: ghWrap };
const stateMivo = join(gd, 'state-mivo');
const stateCindy = join(gd, 'state-cindy');
const run = (cmd, args, extraEnv = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const reconcile = (repo, stateDir, mapFile = join(gd, 'map.json'), extraEnv = {}) =>
  run(process.execPath, [RECONCILE, '--repo', repo, '--state-dir', stateDir, '--remote-map-file', mapFile], extraEnv);
const stateFile = (dir, owner, repo, n) => join(dir, `${owner}__${repo}__${n}.json`);

// ---- S1: 正常映射 + fork 三态 + 消费口径（mivo 首跑） ----
const r1 = reconcile(MIVO, stateMivo);
const o1 = JSON.parse(r1.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r1.status, 0, 'S1 mivo 首跑 exit 0');
eq(o1.registered, ['xindong/mivo-canvas#101', 'xindong/mivo-canvas#102'], 'S1 正常+fork 两条 registered');
eq(o1.already, [], 'S1 首跑无 already');
eq(o1.errors, [], 'S1 无 errors');
eq(o1.dropped.length, 2, 'S1 两条 dropped（103 缺 headRefName / 104 nameWithOwner 非字符串）');
ok(o1.dropped.some((d) => d.pr === 'xindong/mivo-canvas#103' && d.reason.includes('headRefName')), 'S1 dropped#103 reason 缺 headRefName');
ok(o1.dropped.some((d) => d.pr === 'xindong/mivo-canvas#104' && d.reason.includes('nameWithOwner')), 'S1 dropped#104 reason nameWithOwner');
ok(r1.out.includes('[OWN-PRS] dropped xindong/mivo-canvas#103'), 'S1 dropped 写 stderr（warning 可见）');

// 契约输出形状（own-prs.mjs 独立 CLI 跑，五字段齐全 + push_repo 三态）
const w1 = run(process.execPath, [OWN_PRS, '--repo', MIVO, '--remote-map-file', join(gd, 'map.json')]);
eq(w1.status, 0, 'S1 wrapper CLI exit 0');
const wprs = JSON.parse(w1.out.split('\n').filter((l) => l.startsWith('['))[0] ?? '[]');
eq(wprs.map((p) => [p.owner, p.repo, p.number, p.branch, p.push_repo, p.push_remote]), [
  ['xindong', 'mivo-canvas', 101, 'feat/mivo-base', null, 'origin'],
  ['xindong', 'mivo-canvas', 102, 'feat/mivo-fork', 'PraiseZhu/cindy-fork', 'origin']
], 'S1 契约五字段 + push_repo 三态（同仓 null / fork 字符串）');

// state 文件落盘 + 三态 typeof 断言 + finalize:46-50→git-checks:24-27 消费口径
const s101 = JSON.parse(readFileSync(stateFile(stateMivo, 'xindong', 'mivo-canvas', 101), 'utf8'));
const s102 = JSON.parse(readFileSync(stateFile(stateMivo, 'xindong', 'mivo-canvas', 102), 'utf8'));
const pushRepoTriState = (v) => v === null || typeof v === 'string'; // 三态: 字符串或 null
ok(pushRepoTriState(s101.push_repo), 'S1 state#101 push_repo 字符串或 null');
ok(pushRepoTriState(s102.push_repo), 'S1 state#102 push_repo 字符串或 null');
eq(s101.push_repo, null, 'S1 state#101 同仓 push_repo=null');
eq(s102.push_repo, 'PraiseZhu/cindy-fork', 'S1 state#102 fork push_repo=nameWithOwner');
eq(s101.push_remote, 'origin', 'S1 state#101 push_remote=映射值 origin');
eq(s102.push_remote, 'origin', 'S1 state#102 push_remote=映射值 origin');
eq(s101.branch, 'feat/mivo-base', 'S1 state#101 branch=headRefName');
eq(s101.registered_by, 'reconcile-shuttle', 'S1 registered_by 标注班车来源');
// engine.mjs:281 manifest 口径: push_repo: state.push_repo ?? null；
// finalize.mjs:50 / engine.mjs:165 消费口径: repoFullName = manifest.push_repo ?? `${owner}/${repo}`
// git-checks.mjs:24-27: validateRemoteBranch 用 repoFullName 与 push URL path 精确匹配——
// fork 场景 remote push URL 的 path 必须 === nameWithOwner 才过。
for (const [s, nw, expectRepoFullName] of [
  [s101, MIVO, 'xindong/mivo-canvas'],
  [s102, FORK, 'PraiseZhu/cindy-fork']
]) {
  const manifestPushRepo = s.push_repo ?? null; // engine.mjs:281
  ok(pushRepoTriState(manifestPushRepo), 'S1 manifest push_repo 字符串或 null');
  const repoFullName = manifestPushRepo ?? `${s.owner}/${s.repo}`; // finalize.mjs:50 口径
  eq(repoFullName, nw, `S1 消费口径 repoFullName===nameWithOwner（${nw}，fork 绑定不被上游冒充）`);
}

// ---- S2: 幂等重跑 → already，state 不再新增 ----
const r2 = reconcile(MIVO, stateMivo);
const o2 = JSON.parse(r2.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r2.status, 0, 'S2 幂等重跑 exit 0');
eq(o2.registered, [], 'S2 重跑无新注册');
eq(o2.already, ['xindong/mivo-canvas#101', 'xindong/mivo-canvas#102'], 'S2 重跑 already 两条（registerPr 幂等）');
eq(o2.dropped.length, 2, 'S2 重跑 dropped 依旧两条');

// ---- S3: 双仓互不污染（cindy 跑自己的 stateDir） ----
const r3 = reconcile(CINDY, stateCindy);
const o3 = JSON.parse(r3.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r3.status, 0, 'S3 cindy 跑 exit 0');
eq(o3.registered, ['PraiseZhu/pr-autopilot#201', 'PraiseZhu/pr-autopilot#202'], 'S3 cindy 两条 registered');
ok(existsSync(stateFile(stateCindy, 'PraiseZhu', 'pr-autopilot', 201)), 'S3 cindy state#201 落盘');
ok(!existsSync(stateFile(stateCindy, 'xindong', 'mivo-canvas', 101)), 'S3 cindy stateDir 无 mivo PR（互不污染）');
ok(!existsSync(stateFile(stateMivo, 'PraiseZhu', 'pr-autopilot', 201)), 'S3 mivo stateDir 无 cindy PR（互不污染）');
const s201 = JSON.parse(readFileSync(stateFile(stateCindy, 'PraiseZhu', 'pr-autopilot', 201), 'utf8'));
eq(s201.push_repo, 'PraiseZhu/cindy-fork', 'S3 cindy fork PR push_repo 正确');
eq(s201.push_remote, 'fork', 'S3 cindy 映射值 push_remote=fork');

// ---- S4: 空列表 [] → 全空四明细，exit 0 ----
const r4 = reconcile(MIVO, join(gd, 'state-empty'), join(gd, 'map.json'), { OWN_PRS_FIXTURE_MODE: 'empty' });
const o4 = JSON.parse(r4.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r4.status, 0, 'S4 空列表 exit 0');
eq([o4.registered, o4.already, o4.dropped, o4.errors], [[], [], [], []], 'S4 空列表四明细全空');

// ---- S5: gh 失败 → 非零 ----
const r5 = reconcile(MIVO, join(gd, 'state-ghfail'), join(gd, 'map.json'), { OWN_PRS_FIXTURE_MODE: 'fail' });
ok(r5.status !== 0, 'S5 gh 失败 exit 非零');
ok(r5.out.includes('gh pr list 失败'), 'S5 失败信息含 gh pr list 失败（fail-closed）');

// ---- S6: 缺 map key → 启动前非零 ----
const mapNokey = join(gd, 'map-nokey.json');
writeFileSync(mapNokey, JSON.stringify({ [MIVO]: 'origin' }));
const r6 = reconcile(CINDY, stateCindy, mapNokey);
ok(r6.status !== 0, 'S6 缺 map key exit 非零');
ok(r6.out.includes('缺当前 --repo'), 'S6 报错含缺当前 --repo 的 key');

// ---- S7: registerPr throw（在途 dispatch 接线变化，register.mjs:39-42）→ 非零 + errors 明细 ----
// 预置 state#101 为「旧 branch + 在途 dispatch」——API 返回 feat/mivo-base ≠ 旧 branch → wiringChanged
// 且 pending_dispatch 非空 → registerPr 必须 throw（迁移拒绝），该条记 errors，其余条照常注册。
writeJsonAtomic(stateFile(stateMivo, 'xindong', 'mivo-canvas', 101), {
  schema_version: 'v2', owner: 'xindong', repo: 'mivo-canvas', pr_number: 101,
  branch: 'feat/OLD', push_repo: null, push_remote: 'origin',
  registered_at: '2026-08-08T00:00:00.000Z', registered_by: 'fixture',
  cursors: null, pending_dispatch: { dispatch_id: 'd-inflight', kind: 'pr-fix' },
  first_scan_ack: null, status: 'watching'
});
const r7 = reconcile(MIVO, stateMivo);
const o7 = JSON.parse(r7.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
ok(r7.status !== 0, 'S7 registerPr throw exit 非零');
ok(o7.errors.some((e) => e.pr === 'xindong/mivo-canvas#101' && e.reason.includes('在途 dispatch')), 'S7 errors 含 {pr,reason}（101 在途 dispatch 迁移拒绝）');
ok(!o7.registered.includes('xindong/mivo-canvas#101'), 'S7 101 不进 registered');
ok(!o7.errors.some((e) => e.pr === 'xindong/mivo-canvas#102'), 'S7 102 不进 errors（逐 PR 隔离）');
ok([...o7.registered, ...o7.already].includes('xindong/mivo-canvas#102'), 'S7 102 不受 101 影响照常处理（已注册走 already）');

console.log(`own-prs.fixture: ${failed === 0 ? 'all pass' : failed + ' failed'}`);
process.exit(failed === 0 ? 0 : 1);
