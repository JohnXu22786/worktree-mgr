import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * @param {string} path
 * @param {number} [timeoutMs]
 */
async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待测试标记超时：${path}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('repoSlug：仓库名 + 路径哈希，同名仓库不同路径区分', () => {
  const a = repoSlug('C:/work/proj')
  const b = repoSlug('D:/other/proj')
  assert.ok(a.startsWith('proj-'))
  assert.ok(a.length > 8)
  assert.notEqual(a, b)
})

test('resolveVault：显式 vault 生效（相对路径以仓库路径解析）', () => {
  const rootPath = process.platform === 'win32' ? 'C:/repo' : '/repo'
  assert.equal(resolveVault({ rootPath: 'C:/repo', vault: 'D:/v' }), 'D:/v')
  assert.equal(resolveVault({ rootPath, vault: './v' }), join(rootPath, 'v'))
  assert.equal(resolveVault({ rootPath, vault: '' }), null) // 空串视为未设置
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

test('withLock：已有陈旧回收 claim 时不会重复回收', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const reclaimPath = `${lockPath}.reclaim`
  const token = 'crashed-owner'
  writeFileSync(lockPath, token)
  const past = new Date(Date.now() - 120_000)
  utimesSync(lockPath, past, past)
  mkdirSync(reclaimPath)
  writeFileSync(join(reclaimPath, 'token'), 'another-reclaimer')

  let ran = false
  await assert.rejects(
    withLock(dir, async () => { ran = true }, { timeoutMs: 100, staleMs: 60_000 }),
    VaultError,
  )
  assert.equal(ran, false)
  assert.equal(readFileSync(lockPath, 'utf8'), token)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：没有锁的孤儿 guard 可立即回收', async () => {
  const dir = makeTmp()
  const reclaimPath = join(dir, '.lock.reclaim')
  mkdirSync(reclaimPath)
  writeFileSync(join(reclaimPath, 'token'), 'crashed-before-lock')

  let ran = false
  await withLock(dir, async () => { ran = true }, { timeoutMs: 200, staleMs: 60_000 })
  assert.equal(ran, true)
  assert.equal(existsSync(reclaimPath), false)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：释放 guard 等待有界返回', async () => {
  const dir = makeTmp()
  const reclaimPath = join(dir, '.lock.reclaim')
  const started = Date.now()
  await withLock(dir, async () => {
    mkdirSync(reclaimPath)
    writeFileSync(join(reclaimPath, 'token'), 'another-owner')
  }, { timeoutMs: 50, staleMs: 60_000 })
  assert.ok(Date.now() - started < 500, '释放不应无限等待 guard')
  assert.equal(existsSync(join(dir, '.lock')), true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：持有者心跳与陈旧回收互斥', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const readyPath = join(dir, '.owner-ready')
  const heartbeatPath = join(dir, '.owner-heartbeat')
  const continuePath = join(dir, '.owner-continue')
  const releasePath = join(dir, '.owner-release')
  const donePath = join(dir, '.owner-done')
  const childScript = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'

    const realFutimesSync = fs.futimesSync
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    fs.futimesSync = (...args) => {
      if (!fs.existsSync(process.env.WTM_TEST_CONTINUE)) {
        fs.writeFileSync(process.env.WTM_TEST_HEARTBEAT, '')
        while (!fs.existsSync(process.env.WTM_TEST_CONTINUE)) {
          Atomics.wait(waitBuffer, 0, 0, 5)
        }
      }
      return realFutimesSync(...args)
    }
    syncBuiltinESMExports()

    const { withLock } = await import(process.env.WTM_TEST_VAULT_MODULE)
    await withLock(process.env.WTM_TEST_DIR, async () => {
      fs.writeFileSync(process.env.WTM_TEST_READY, '')
      while (!fs.existsSync(process.env.WTM_TEST_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 5))
    }, { heartbeatMs: 10, staleMs: 1000 })
    fs.writeFileSync(process.env.WTM_TEST_DONE, '')
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      WTM_TEST_DIR: dir,
      WTM_TEST_VAULT_MODULE: new URL('../src/vault.js', import.meta.url).href,
      WTM_TEST_READY: readyPath,
      WTM_TEST_HEARTBEAT: heartbeatPath,
      WTM_TEST_CONTINUE: continuePath,
      WTM_TEST_RELEASE: releasePath,
      WTM_TEST_DONE: donePath,
    },
    stdio: 'ignore',
  })
  /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  let contenderRan = false
  try {
    await waitForFile(readyPath)
    await waitForFile(heartbeatPath)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)
    const contender = withLock(dir, async () => { contenderRan = true }, { timeoutMs: 250, staleMs: 1000 })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(contenderRan, false)
    writeFileSync(continuePath, '')
    await assert.rejects(contender, VaultError)
    writeFileSync(releasePath, '')
    await waitForFile(donePath)
    const result = await childExit
    assert.equal(result.code, 0, `owner 子进程异常退出：${result.signal ?? result.code}`)
  } finally {
    writeFileSync(continuePath, '')
    writeFileSync(releasePath, '')
    if (child.exitCode === null) child.kill()
    await childExit.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withLock：过期锁被回收（stale）', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  writeFileSync(lockPath, 'crashed-owner')
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past) // 锁文件时间戳拨回 1 分钟前
  let ran = false
  await withLock(dir, async () => { ran = true }, { timeoutMs: 2000, staleMs: 10_000 })
  assert.equal(ran, true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：空或损坏的过期锁可被回收', async () => {
  for (const token of ['', 'malformed-lock-token']) {
    const dir = makeTmp()
    const lockPath = join(dir, '.lock')
    writeFileSync(lockPath, token)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)
    let ran = false
    await withLock(dir, async () => { ran = true }, { timeoutMs: 2000, staleMs: 10_000 })
    assert.equal(ran, true, `应回收内容为 ${JSON.stringify(token)} 的过期锁`)
    rmSync(dir, { recursive: true, force: true })
  }
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
