#!/usr/bin/env node
// 每 key 原子锁 v3 — 审③-F14 + 审④-F6 + 审⑤-F3:
//   - mkdir 原子互斥 + 锁内 owner 文件（token+pid）
//   - release 只删**自己 token** 的锁（旧 release 不会误删新持有者的锁）
//   - 陈锁抢占仅当「mtime 超时 且 持有 pid 已死」——活持有者永不被抢
//   - 审⑤-F3: 陈锁回收本身经独立 reaper 互斥（O_EXCL 文件）串行化，且删除前在
//     reaper 临界区内**重新验证**当前持有者仍陈旧仍死——两个进程基于同一份 stale
//     快照并发 unlink、误删新持有者锁的交错被消除。
//   - 审⑥-F4: reaper 文件自身陈死（SIGKILL/断电击中极短临界区）不自动清理——裸
//     rename 在可重建路径上不是 CAS（ABA 双 reaper），改为 fail-closed 显式报人工。
//   - 仅 EEXIST 视为「等待」；父目录先建；其他错误立即抛（不再静默自旋）
import { mkdirSync, rmdirSync, statSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const STALE_MS = 10 * 60_000; // 10 分钟——引擎临界区含外部命令，60s 太激进（审④-F6）
const REAPER_STALE_MS = 30_000; // reaper 临界区极短（无外部命令），30s 未退出即视为死

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = 存在但无权限 → 视为活
}

function lockLooksStale(lockPath, ownerFile) {
  const st = statSync(lockPath); // 不存在则抛（调用方按「已释放」处理）
  if (Date.now() - st.mtimeMs <= STALE_MS) return false;
  let ownerPid = null;
  try { ownerPid = JSON.parse(readFileSync(ownerFile, 'utf8')).pid; } catch { /* owner 缺失/损坏 → 视为死 */ }
  return !pidAlive(ownerPid);
}

// 审⑤-F3: 串行化的陈锁回收。返回 true = 本进程完成了回收（或锁已消失）。
function reapStale(lockPath, ownerFile) {
  const reaper = `${lockPath}.reaper`;
  let fd = null;
  try {
    fd = openSync(reaper, 'wx'); // 原子: 同一时刻至多一个 reaper
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 审⑥-F4: reaper 自身陈死**不自动清理**。可重建路径上的裸 rename 不是 CAS——
    // B rename 旧尸后 C 可 O_EXCL 重建，D 再按旧快照 rename 会吞掉 C 的活 reaper，
    // 形成双回收者并重现「基于旧 stale 快照删新持有者锁」。reaper 临界区极短且无外部
    // 命令，进程死在里面只剩 SIGKILL/断电一种可能——此时 fail-closed 显式报人工，
    // 而不是引入一条能破坏互斥的自动路径（S2: 可检测 > 假可用）。
    try {
      const st = statSync(reaper);
      if (Date.now() - st.mtimeMs > REAPER_STALE_MS) {
        let rpid = null;
        try { rpid = JSON.parse(readFileSync(reaper, 'utf8')).pid; }
        catch (er) { if (er.code === 'ENOENT') return false; /* 刚释放 */ rpid = null; /* 损坏 → 死 */ }
        if (!pidAlive(rpid)) {
          throw new Error(`锁回收器残骸: ${reaper}（持有 pid 已死且超 ${REAPER_STALE_MS / 1000}s）——需人工确认后手动删除该文件（fail-closed，不自动清理以保互斥）`);
        }
      }
    } catch (e2) {
      if (e2.message?.includes('锁回收器残骸')) throw e2;
      // 审⑥-F4-⑥: 只有 ENOENT（reaper 刚被正常释放）允许静默重试；
      // 权限/IO 等持续性错误吞掉会变成无限重试，必须显式抛出
      if (e2.code !== 'ENOENT') throw e2;
    }
    return false; // 活 reaper 在场（或刚释放），本轮不回收，回外层重试
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    // 临界区内重验: 基于**当前**持有者判定，不用进临界区前的旧快照——
    // 若旧锁已被回收且新持有者已就位，这里会看到新 mtime/活 pid 而放弃删除。
    let stillStale = false;
    try { stillStale = lockLooksStale(lockPath, ownerFile); }
    catch { return true; } // 锁已消失 = 目标达成
    if (!stillStale) return false;
    try { unlinkSync(ownerFile); } catch { /* 无 owner 文件 */ }
    try { rmdirSync(lockPath); } catch { /* 目录非空等异常留给下一轮 */ }
    return true;
  } finally {
    closeSync(fd);
    try { unlinkSync(reaper); } catch { /* 已被陈死清理 */ }
  }
}

export function acquireLock(lockPath, { timeoutMs = 10_000 } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;
  const ownerFile = join(lockPath, 'owner.json');
  for (;;) {
    try {
      mkdirSync(lockPath); // 原子: 存在即抛 EEXIST
      writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }));
      return () => {
        // 只释放自己的锁（审④-F6: 被抢占后旧 release 不得删新锁）
        try {
          const cur = JSON.parse(readFileSync(ownerFile, 'utf8'));
          if (cur.token !== token) return;
          unlinkSync(ownerFile);
          rmdirSync(lockPath);
        } catch { /* 已被清理 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // 权限/路径错误立即抛，不自旋（审④-F6）
      // 审⑥-F4-⑥: deadline 检查前置——所有等待路径（含 stale 但活 reaper 挡道的
      // continue 循环）都受 timeoutMs 约束，不存在绕过超时的永久挂死分支
      if (Date.now() > deadline) throw new Error(`获取锁超时: ${lockPath}（持有者存活或回收未完成，timeoutMs=${timeoutMs}）`);
      let stale = false;
      try { stale = lockLooksStale(lockPath, ownerFile); }
      catch { continue; } // 锁刚被释放 → 立刻重试（下轮先过 deadline 闸）
      if (stale) {
        if (!reapStale(lockPath, ownerFile)) execFileSync('sleep', ['0.02']); // 回收让位时小睡防紧自旋
        continue; // 无论谁回收成功都回到 mkdir 竞争
      }
      execFileSync('sleep', ['0.05']);
    }
  }
}

export function withLock(lockPath, fn, opts) {
  const release = acquireLock(lockPath, opts);
  try { return fn(); } finally { release(); }
}
