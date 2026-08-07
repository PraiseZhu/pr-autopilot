#!/usr/bin/env node
// 补注册接线契约 fixture — 共识计划 T1 (SC-1b)。
// 真实三层接线（own-prs.mjs 的 listOwnPrs → reconcile-own-prs.mjs → register.mjs 的 registerPr），
// 只 stub gh 二进制（GH_BIN 注入，模式同 run-fixtures.mjs 的 gh-snapshot 契约 fixture）。
// 覆盖: 正常映射 / fork 三态（含 finalize.mjs 的 validateRemoteBranch 调用处 repoFullName
//       = push_repo ?? owner/repo 消费口径，git-checks 实现见 scripts/lib/git-checks.mjs）/
//       缺 headRefName 或 nameWithOwner 非字符串 → dropped 且 exit 0 / gh 失败非零 /
//       空列表 [] / 双仓互不污染 / 幂等 already / 缺 map key 非零 / registerPr throw 非零 /
//       fake gh 精确 argv 断言 + 反向变异（SC-F3）/ 非数组负例 / 真实 JSON 形状兼容。
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../scripts/lib/common.mjs';
import { stateFileName } from '../scripts/pr-watch/register.mjs';
import { parseRepo } from '../deploy/wrappers/own-prs.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RECONCILE = fileURLToPath(new URL('../deploy/wrappers/reconcile-own-prs.mjs', import.meta.url));
const OWN_PRS = fileURLToPath(new URL('../deploy/wrappers/own-prs.mjs', import.meta.url));

let failed = 0;
const eq = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) { failed++; console.error(`FAIL ${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };
const ok = (cond, label) => { if (!cond) { failed++; console.error(`FAIL ${label}`); } };

const MIVO = 'xindong/mivo-canvas';
const CINDY = 'makecindy/cindy'; // canonical cindy base 仓（2026-08-08 GPT 审查修复，SC-F1）
const FORK = 'PraiseZhu/cindy-fork';
const MAP = { [MIVO]: 'origin', [CINDY]: 'fork' };
// SC-R1/R2 正例: gh API 实测存在的合法标点仓名（2026-08-08 R2 确认，mame/_ 与 PrinceRpz23/- 均真实公开）
const MAME_PUNCT = 'mame/_', PRINCE_PUNCT = 'PrinceRpz23/-';

// ---- stub gh: 精确断言完整 argv（SC-F3），再按 --repo 与 OWN_PRS_FIXTURE_MODE 输出确定性响应 ----
// 期望序列与 own-prs.mjs 的 execFileSync argv 逐元素一致:
//   pr list --repo <repo> --author @me --state open --json number,headRefName,headRepository
// 补删 --author / 改 --state closed / 改 --json 字段 / 重排 → argv mismatch → exit 1（有牙齿）——
// 产品代码 argv 一旦退化，fixture 立即红。
const FAKE_GH_SRC = `
const argv = process.argv.slice(2);
if (process.env.OWN_PRS_FIXTURE_MODE === 'fail') { process.stderr.write('gh: boom\\n'); process.exit(1); }
if (argv[0] !== 'pr' || argv[1] !== 'list') { process.stderr.write('unknown endpoint: ' + argv.join(' ')); process.exit(1); }
const repo = argv[argv.indexOf('--repo') + 1];
const EXPECTED = ['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', 'number,headRefName,headRepository'];
if (argv.length !== EXPECTED.length || argv.some((a, i) => a !== EXPECTED[i])) {
  process.stderr.write('argv mismatch: ' + argv.join(' ') + ' != ' + EXPECTED.join(' ')); process.exit(1);
}
if (process.env.OWN_PRS_FIXTURE_MODE === 'empty') { process.stdout.write('[]'); process.exit(0); }
if (process.env.OWN_PRS_FIXTURE_MODE === 'object') { process.stdout.write('{"items":[]}'); process.exit(0); } // 非数组负例
const MIVO = 'xindong/mivo-canvas', CINDY = 'makecindy/cindy', FORK = 'PraiseZhu/cindy-fork';
// SC-R1/R2 正例: gh API 实测存在的合法标点仓名（2026-08-08 R2 确认，mame/_ 与 PrinceRpz23/- 均真实公开）
const MAME_PUNCT = 'mame/_', PRINCE_PUNCT = 'PrinceRpz23/-';
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
  ],
  [MAME_PUNCT]: [
    { number: 301, headRefName: 'feat/underscore-repo', headRepository: { nameWithOwner: MAME_PUNCT } },
    { number: 302, headRefName: 'feat/underscore-fork', headRepository: { nameWithOwner: PRINCE_PUNCT } }
  ],
  [PRINCE_PUNCT]: [
    { number: 401, headRefName: 'feat/dash-repo', headRepository: { nameWithOwner: PRINCE_PUNCT } }
  ]
};
if (process.env.OWN_PRS_FIXTURE_MODE === 'real') {
  // 真实 gh pr list --json 形状: 额外字段（baseRefName/url/isDraft/headRepositoryOwner/mergeable…）
  // 不影响解析——own-prs 只消费 number/headRefName/headRepository.nameWithOwner
  process.stdout.write(JSON.stringify([
    { number: 301, headRefName: 'feat/real', headRepository: { nameWithOwner: MIVO, id: 'R_1', isPrivate: false },
      baseRefName: 'main', url: 'https://github.com/' + MIVO + '/pull/301', isDraft: false,
      headRepositoryOwner: { login: 'xindong' }, mergeable: 'MERGEABLE' }
  ]));
  process.exit(0);
}
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

// state 文件落盘 + 三态 typeof 断言 + 消费口径（稳定符号，2026-08-08 行号刷新）
//   engine.mjs manifest 构造的 push_repo 行（`push_repo: state.push_repo ?? null`）;
//   finalize.mjs validateRemoteBranch 调用处（`repoFullName: manifest.push_repo ?? owner/repo`）;
//   engine.mjs 终态 branch-cleanup 调用处（`repoFullName: settled.push_repo ?? owner/repo`）;
//   scripts/lib/git-checks.mjs 的 validateRemoteBranch: repoFullName 与 push URL path 精确匹配——
//   fork 场景 remote push URL 的 path 必须 === nameWithOwner 才过。
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
for (const [s, nw, expectRepoFullName] of [
  [s101, MIVO, 'xindong/mivo-canvas'],
  [s102, FORK, 'PraiseZhu/cindy-fork']
]) {
  const manifestPushRepo = s.push_repo ?? null; // engine.mjs manifest 构造（push_repo: state.push_repo ?? null）
  ok(pushRepoTriState(manifestPushRepo), 'S1 manifest push_repo 字符串或 null');
  const repoFullName = manifestPushRepo ?? `${s.owner}/${s.repo}`; // finalize.mjs validateRemoteBranch 调用处口径
  eq(repoFullName, nw, `S1 消费口径 repoFullName===nameWithOwner（${nw}，fork 绑定不被上游冒充）`);
}

// ---- S2: 幂等重跑 → already，state 不再新增 ----
const r2 = reconcile(MIVO, stateMivo);
const o2 = JSON.parse(r2.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r2.status, 0, 'S2 幂等重跑 exit 0');
eq(o2.registered, [], 'S2 重跑无新注册');
eq(o2.already, ['xindong/mivo-canvas#101', 'xindong/mivo-canvas#102'], 'S2 重跑 already 两条（registerPr 幂等）');
eq(o2.dropped.length, 2, 'S2 重跑 dropped 依旧两条');

// ---- S3: 双仓互不污染（canonical cindy 跑自己的 stateDir） ----
const r3 = reconcile(CINDY, stateCindy);
const o3 = JSON.parse(r3.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r3.status, 0, 'S3 cindy 跑 exit 0');
eq(o3.registered, ['makecindy/cindy#201', 'makecindy/cindy#202'], 'S3 cindy 两条 registered');
ok(existsSync(stateFile(stateCindy, 'makecindy', 'cindy', 201)), 'S3 cindy state#201 落盘');
ok(!existsSync(stateFile(stateCindy, 'xindong', 'mivo-canvas', 101)), 'S3 cindy stateDir 无 mivo PR（互不污染）');
ok(!existsSync(stateFile(stateMivo, 'makecindy', 'cindy', 201)), 'S3 mivo stateDir 无 cindy PR（互不污染）');
const s201 = JSON.parse(readFileSync(stateFile(stateCindy, 'makecindy', 'cindy', 201), 'utf8'));
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

// ---- S7: registerPr throw（在途 dispatch 接线变化——registerPr 的 wiringChanged && pending_dispatch
//          迁移拒绝分支）→ 非零 + errors 明细 ----
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

// ---- S8: fake gh 精确 argv 断言的反向变异（SC-F3）——断言必须有牙齿 ----
// 对期望 argv 的每一处变异（补删 --author / 改 --state closed / 改 --json 字段 / 重排），
// fake gh 必须拒绝（exit 1 + argv mismatch）——产品代码 argv 一旦退化，fixture 立即红；
// 完整 argv 必须接受（正向闭环）。
const FULL_ARGV = (repo) => ['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', 'number,headRefName,headRepository'];
const ARGV_MUTATIONS = [
  { name: 'drop-author', argv: (r) => ['pr', 'list', '--repo', r, '--state', 'open', '--json', 'number,headRefName,headRepository'] },
  { name: 'state-closed', argv: (r) => ['pr', 'list', '--repo', r, '--author', '@me', '--state', 'closed', '--json', 'number,headRefName,headRepository'] },
  { name: 'drop-json-field', argv: (r) => ['pr', 'list', '--repo', r, '--author', '@me', '--state', 'open', '--json', 'number,headRefName'] },
  { name: 'reorder-flags', argv: (r) => ['pr', 'list', '--repo', r, '--state', 'open', '--author', '@me', '--json', 'number,headRefName,headRepository'] }
];
for (const m of ARGV_MUTATIONS) {
  const rm = spawnSync(ghWrap, m.argv(MIVO), { encoding: 'utf8', env });
  ok(rm.status !== 0, `S8 变异 argv 必须被 fake gh 拒绝（${m.name}）`);
  ok((rm.stderr ?? '').includes('argv mismatch'), `S8 拒绝信息含 argv mismatch（${m.name}）`);
}
const r8ok = spawnSync(ghWrap, FULL_ARGV(MIVO), { encoding: 'utf8', env });
eq(r8ok.status, 0, 'S8 完整 argv 被 fake gh 接受（正向闭环）');
// 全链路反向变异: 变异 fake gh 的期望序列（等价临时副本，逐个替换 FAKE_GH_SRC 中的唯一子串），
// 产品传完整 argv → 期望不匹配 → 拒绝 → reconcile 非零——证明 fixture 对 argv 变化敏感
const MUT_SUBST = [
  { name: 'drop-author', from: `'--author', '@me', `, to: `` },
  { name: 'state-closed', from: `'--state', 'open'`, to: `'--state', 'closed'` },
  { name: 'drop-json-field', from: `'number,headRefName,headRepository'`, to: `'number,headRefName'` },
  { name: 'reorder-flags', from: `'--author', '@me', '--state', 'open'`, to: `'--state', 'open', '--author', '@me'` }
];
const mutMap = join(gd, 'map-argvmut.json');
writeFileSync(mutMap, JSON.stringify({ [MIVO]: 'origin' }));
for (const m of MUT_SUBST) {
  const mutGh = join(gd, `fake-gh-${m.name}.mjs`);
  writeFileSync(mutGh, FAKE_GH_SRC.replace(m.from, m.to));
  const mutWrap = join(gd, `gh-${m.name}`);
  writeFileSync(mutWrap, `#!/bin/sh\nexec "${process.execPath}" "${mutGh}" "$@"\n`);
  execFileSync('chmod', ['+x', mutWrap]);
  const rm2 = reconcile(MIVO, join(gd, `state-argvmut-${m.name}`), mutMap, { GH_BIN: mutWrap });
  ok(rm2.status !== 0, `S8 全链路: 变异 fake gh（${m.name}）下 reconcile 必须非零`);
  ok(rm2.out.includes('argv mismatch') || rm2.out.includes('gh pr list 失败'), `S8 全链路失败信息可见（${m.name}）`);
}

// ---- S9: 非数组响应负例 → fail-closed 非零，无 state 落盘 ----
const r9 = reconcile(MIVO, join(gd, 'state-object'), join(gd, 'map.json'), { OWN_PRS_FIXTURE_MODE: 'object' });
ok(r9.status !== 0, 'S9 gh 返回非数组 exit 非零');
ok(r9.out.includes('非数组'), 'S9 报错含非数组（fail-closed）');
const stateDirObj = join(gd, 'state-object');
ok(existsSync(stateDirObj) && readdirSync(stateDirObj).filter((f) => f.endsWith('.json')).length === 0, 'S9 非数组失败无 state 文件落盘');

// ---- S10: 真实 gh JSON 形状（额外字段）→ 正常解析注册 ----
const r10 = reconcile(MIVO, join(gd, 'state-real'), join(gd, 'map.json'), { OWN_PRS_FIXTURE_MODE: 'real' });
const o10 = JSON.parse(r10.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r10.status, 0, 'S10 真实 JSON 形状 exit 0');
eq(o10.registered, ['xindong/mivo-canvas#301'], 'S10 真实形状 PR 正常注册');
eq(o10.dropped, [], 'S10 真实形状无 dropped');

// ---- S11: SC-R1/R2 合法标点 repo 正例 + 必要负例 + state filename 可扫描 ----
// 正例依据 gh API 实测（2026-08-08 R2）: mame/_、PrinceRpz23/- 真实存在且公开；
// makecindy/.github 同样真实存在，故 repo 段 `.` 开头不拒。
const POS_REPOS = ['mame/_', 'PrinceRpz23/-', 'xindong/mivo-canvas', 'makecindy/cindy', 'makecindy/.github', 'a-b/c-d', 'a-b/c.d_'];
const NEG_REPOS = ['/foo', 'foo/', 'a/b/c', 'foo//bar', 'a//', '', 'a/..', 'a/foo.git', 'a/foo.', 'a/foo bar', 'a/foo\tbar', 'a/foo\nbar', ' ', './x'];
for (const r of POS_REPOS) {
  let accepted = false;
  try { parseRepo(r); accepted = true; } catch { /* 期望接受 */ }
  ok(accepted, `S11 parseRepo 接受合法标点正例 ${JSON.stringify(r)}`);
}
for (const r of NEG_REPOS) {
  let rejected = false;
  try { parseRepo(r); } catch { rejected = true; }
  ok(rejected, `S11 parseRepo 拒绝非法 ${JSON.stringify(r)}`);
}

// 全链路: reconcile mame/_（fake gh 已加 MAME_PUNCT/PRINCE_PUNCT 数据）→ 注册成功
const mapPunct = join(gd, 'map-punct.json');
writeFileSync(mapPunct, JSON.stringify({ [MIVO]: 'origin', [CINDY]: 'fork', [MAME_PUNCT]: 'origin', [PRINCE_PUNCT]: 'origin' }));
const r11 = reconcile(MAME_PUNCT, join(gd, 'state-punct'), mapPunct);
const o11 = JSON.parse(r11.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r11.status, 0, 'S11 mame/_ reconcile exit 0');
eq(o11.registered, ['mame/_#301', 'mame/_#302'], 'S11 mame/_ 两条 registered（302 fork 绑定 PrinceRpz23/-）');
eq(o11.dropped, [], 'S11 mame/_ 无 dropped');

// SC-R2: state filename 可扫描——文件名由 stateFileName 生成（`_`/`-` 段 clean 到 `-`），
// 必须匹配 engine.mjs runEngine 的扫描 grammar（同款 regex）且内容反查 round-trip 一致，
// 否则 engine scan 会跳过该 state（不可扫描状态）。
const ENGINE_STATE_SCAN_RE = /^[A-Za-z0-9.-]+__[A-Za-z0-9.-]+__\d+\.json$/; // 与 engine.mjs runEngine 同款
const f301 = stateFileName('mame', '_', 301);
ok(ENGINE_STATE_SCAN_RE.test(f301), `S11 state 文件名匹配 engine 扫描 grammar: ${f301}`);
eq(f301, 'mame__-__301.json', 'S11 `_` repo 段在 state 文件名 clean 成 `-`（可扫描字符集内）');
const s301 = JSON.parse(readFileSync(join(gd, 'state-punct', f301), 'utf8'));
eq(stateFileName(s301.owner, s301.repo, s301.pr_number), f301, 'S11 内容反查 stateFileName 一致（engine 接受该文件）');
const f401 = stateFileName('PrinceRpz23', '-', 401);
ok(ENGINE_STATE_SCAN_RE.test(f401), `S11 dash repo state 文件名匹配 engine 扫描 grammar: ${f401}`);
const r11b = reconcile(PRINCE_PUNCT, join(gd, 'state-prince'), mapPunct);
const o11b = JSON.parse(r11b.out.split('\n').filter((l) => l.startsWith('{'))[0] ?? '{}');
eq(r11b.status, 0, 'S11 PrinceRpz23/- reconcile exit 0');
eq(o11b.registered, ['PrinceRpz23/-#401'], 'S11 PrinceRpz23/- 一条 registered');

// SC-R1 全入口一致: remote-map key 也过 parseRepo——含非法 key 的 map 启动前拒绝（fail-closed）
const mapBad = join(gd, 'map-bad.json');
writeFileSync(mapBad, JSON.stringify({ [MIVO]: 'origin', '/foo': 'origin' }));
const r11bad = reconcile(MIVO, join(gd, 'state-bad'), mapBad);
ok(r11bad.status !== 0, 'S11 remote-map 含非法 key（/foo）启动前非零');
ok(r11bad.out.includes('remote-map'), 'S11 报错指向 remote-map key');

// CLI 入口一致: own-prs CLI 直接传标点 repo 也能跑（parseRepo 全入口复用）
const w11 = run(process.execPath, [OWN_PRS, '--repo', MAME_PUNCT, '--remote-map-file', mapPunct]);
eq(w11.status, 0, 'S11 own-prs CLI --repo mame/_ exit 0');
const w11prs = JSON.parse(w11.out.split('\n').filter((l) => l.startsWith('['))[0] ?? '[]');
eq(w11prs.map((p) => [p.owner, p.repo, p.push_repo]), [
  ['mame', '_', null], ['mame', '_', PRINCE_PUNCT]
], 'S11 CLI 契约字段 owner/repo 正确 + push_repo 三态（同仓 null / 标点 fork 字符串）');

console.log(`own-prs.fixture: ${failed === 0 ? 'all pass' : failed + ' failed'}`);
process.exit(failed === 0 ? 0 : 1);
