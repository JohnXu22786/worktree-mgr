import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VaultError,
  repoSlug,
  resolveVault,
  loadLedger,
  saveLedger,
  withLock,
  findRecord,
  upsertRecord,
  removeRecord,
  EMPTY_LEDGER,
} from '../src/vault.js'

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-vault-test-'))
  return dir
}

test('repoSlug：仓库名 + 路径哈希，同名仓库不同路径区分', () => {
  const a = repoSlug('C:/work/proj')
  const b = repoSlug('D:/other/proj')
  assert.ok(a.startsWith('proj-'))
  assert.ok(a.length > 8)
  assert.notEqual(a, b)
})

test('resolveVault：显式 vault 生效（相对路径以仓库路径解析）', () => {
  assert.equal(resolveVault({ rootPath: 'C:/repo', vault: 'D:/v' }), 'D:/v')
  assert.equal(resolveVault({ rootPath: 'C:/repo', vault: './v' }), join('C:/repo', 'v'))
  assert.equal(resolveVault({ rootPath: 'C:/repo', vault: '' }), null) // 空串视为未设置
})

test('loadLedger：缺失时返回空账本，不创建文件', () => {
  const dir = makeTmp()
  const ledger = loadLedger(dir)
  assert.deepEqual(ledger, EMPTY_LEDGER)
  assert.equal(existsSync(join(dir, 'index.json')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('saveLedger/loadLedger：写入回读一致，且不残留临时文件', () => {
  const dir = makeTmp()
  const ledger = {
    version: 1,
    records: [
      { task: 'T', branch: 'wtm/t', base: 'main', path: join(dir, 'wtm-t'), createdAt: 'x', updatedAt: 'x' },
    ],
  }
  saveLedger(dir, ledger)
  assert.deepEqual(loadLedger(dir), ledger)
  const leftovers = readFileSync(join(dir, 'index.json'), 'utf8').includes('.tmp')
  assert.equal(leftovers, false)
  rmSync(dir, { recursive: true, force: true })
})

test('loadLedger：损坏索引抛出 VaultError 并带提示', () => {
  const dir = makeTmp()
  writeFileSync(join(dir, 'index.json'), '{broken')
  assert.throws(() => loadLedger(dir), (e) => e instanceof VaultError && /index\.json/.test(e.message))
  rmSync(dir, { recursive: true, force: true })
})

test('loadLedger：非对象结构视为损坏', () => {
  const dir = makeTmp()
  writeFileSync(join(dir, 'index.json'), '[]')
  assert.throws(() => loadLedger(dir), VaultError)
  rmSync(dir, { recursive: true, force: true })
})

test('loadLedger：记录字段缺失视为损坏（单条坏记录不瘫痪账本）', () => {
  const dir = makeTmp()
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    version: 1,
    records: [{ task: 'T' }, { task: 'T2', branch: 'wtm/t2', base: 'main', path: 'p', createdAt: 'c', updatedAt: 'u' }],
  }))
  assert.throws(() => loadLedger(dir), (e) => e instanceof VaultError && /path|字段/.test(e.message))
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：串行执行并释放锁', async () => {
  const dir = makeTmp()
  /** @type {number[]} */
  const order = []
  await withLock(dir, async () => { order.push(1) })
  await withLock(dir, async () => { order.push(2) })
  assert.deepEqual(order, [1, 2])
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：竞争时等待对方释放（并发交错）', async () => {
  const dir = makeTmp()
  let firstInside = false
  /** @type {((value?: unknown) => void) | undefined} */
  let release
  const gate = new Promise((r) => { release = r })
  const p1 = withLock(dir, async () => {
    firstInside = true
    await gate
  })
  // 等 p1 拿到锁
  while (!firstInside) await new Promise((r) => setTimeout(r, 5))
  let p2Done = false
  const p2 = withLock(dir, async () => { p2Done = true })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(p2Done, false, 'p2 不应在 p1 释放前完成')
  assert.ok(release, 'release 应已赋值')
  release()
  await p1
  await p2
  assert.equal(p2Done, true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：超时抛出 VaultError', async () => {
  const dir = makeTmp()
  mkdirSync(dir, { recursive: true })
  // 预置一个永远不会释放的锁文件
  writeFileSync(join(dir, '.lock'), String(process.pid))
  await assert.rejects(
    withLock(dir, async () => {}, { timeoutMs: 200, staleMs: 60_000 }),
    VaultError,
  )
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：过期锁被回收（stale）', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  writeFileSync(lockPath, String(process.pid))
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past) // 锁文件时间戳拨回 1 分钟前
  let ran = false
  await withLock(dir, async () => { ran = true }, { timeoutMs: 2000, staleMs: 10_000 })
  assert.equal(ran, true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：锁被其他进程回收后，释放时不删除后继锁（token 校验）', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  await withLock(dir, async () => {
    // 模拟 B 把 A 的锁判定为陈旧并回收重建
    unlinkSync(lockPath)
    writeFileSync(lockPath, 'other-process-token')
    await new Promise((r) => setTimeout(r, 30))
  })
  // A 释放后，B 的锁必须原样保留
  assert.equal(readFileSync(lockPath, 'utf8'), 'other-process-token')
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：长任务期间心跳刷新 mtime，不被陈旧判定窃取', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const p1 = withLock(dir, async () => {
    await new Promise((r) => setTimeout(r, 300))
  }, { heartbeatMs: 50, staleMs: 100 })
  // 等锁建立，记录 mtime；150ms 后（远超 staleMs=100）再比较
  await new Promise((r) => setTimeout(r, 60))
  const t0 = statSync(lockPath).mtimeMs
  await new Promise((r) => setTimeout(r, 150))
  const t1 = statSync(lockPath).mtimeMs
  assert.ok(t1 > t0, `mtime 应被心跳刷新（${t0} → ${t1}）`)
  await p1
  rmSync(dir, { recursive: true, force: true })
})

test('findRecord/upsertRecord/removeRecord：按任务名操作', () => {
  const ledger = structuredClone(EMPTY_LEDGER)
  assert.equal(findRecord(ledger, 'T'), undefined)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: 'p', createdAt: 'c', updatedAt: 'u' })
  const rec1 = findRecord(ledger, 'T')
  assert.ok(rec1, '应有记录')
  assert.equal(rec1.branch, 'wtm/t')
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t2', base: 'main', path: 'p', createdAt: 'c', updatedAt: 'u2' })
  assert.equal(ledger.records.length, 1)
  const rec2 = findRecord(ledger, 'T')
  assert.ok(rec2, '应有记录')
  assert.equal(rec2.updatedAt, 'u2')
  assert.equal(removeRecord(ledger, 'T'), true)
  assert.equal(removeRecord(ledger, 'T'), false)
  assert.deepEqual(ledger, EMPTY_LEDGER)
})
