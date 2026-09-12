import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, unlinkSync, statSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
 * @param {string} dir
 * @param {string} mode
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, stderr: string, timedOut: boolean}>}
 */
function runLockChild(dir, mode) {
  const childScript = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'

    const dir = process.env.WTM_TEST_VAULT_DIR
    const lockPath = join(dir, '.lock')
    const sourcePath = process.env.WTM_TEST_VAULT_SOURCE
    const originalStatSync = fs.statSync
    const originalUnlinkSync = fs.unlinkSync

    if (process.env.WTM_TEST_LOCK_MODE === 'stat') {
      fs.statSync = (target, ...args) => {
        if (target === lockPath) {
          const error = new Error('simulated stat failure')
          error.code = 'EIO'
          throw error
        }
        return originalStatSync(target, ...args)
      }
    }
    if (process.env.WTM_TEST_LOCK_MODE === 'unlink') {
      fs.unlinkSync = (target, ...args) => {
        if (target === lockPath) {
          const error = new Error('simulated unlink failure')
          error.code = 'EIO'
          throw error
        }
        return originalUnlinkSync(target, ...args)
      }
    }
    syncBuiltinESMExports()

    const { withLock } = await import(pathToFileURL(sourcePath).href)
    try {
      await withLock(dir, async () => {}, { timeoutMs: 100, staleMs: 10 })
      console.error('lock unexpectedly acquired')
      process.exitCode = 1
    } catch (error) {
      if (error?.name !== 'VaultError') {
        console.error(error)
        process.exitCode = 2
      }
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: {
        ...process.env,
        WTM_TEST_VAULT_DIR: dir,
        WTM_TEST_VAULT_SOURCE: fileURLToPath(new URL('../src/vault.js', import.meta.url)),
        WTM_TEST_LOCK_MODE: mode,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 1000)
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stderr, timedOut })
    })
  })
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

test('withLock：写入 token 失败时清理文件描述符和锁文件', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const writeError = new Error('token write failed')
  mock.method(fs, 'writeFileSync', () => { throw writeError })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      withLock(dir, async () => {}),
      (error) => error === writeError,
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(lockPath), false)
  let acquired = false
  await withLock(dir, async () => { acquired = true }, { timeoutMs: 200, staleMs: 60_000 })
  assert.equal(acquired, true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：写入 token 失败时不暴露锁，也不删除后继锁', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const successorToken = 'successor-process-token'
  const writeError = new Error('token write failed')
  const realWriteFileSync = fs.writeFileSync
  const realStatSync = fs.statSync
  let lockExistedDuringWrite = false
  let statCalls = 0
  mock.method(fs, 'writeFileSync', (/** @type {string | number} */ target) => {
    if (typeof target !== 'number') throw new Error('unexpected path write')
    lockExistedDuringWrite = existsSync(lockPath)
    realWriteFileSync(lockPath, successorToken, 'utf8')
    throw writeError
  })
  mock.method(fs, 'statSync', (/** @type {string} */ path) => {
    const currentStat = realStatSync(path)
    if (path === lockPath) {
      statCalls += 1
      unlinkSync(lockPath)
      realWriteFileSync(lockPath, successorToken, 'utf8')
    }
    return currentStat
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      withLock(dir, async () => {}),
      (error) => error === writeError,
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(lockExistedDuringWrite, false)
  assert.equal(statCalls, 0)
  assert.equal(readFileSync(lockPath, 'utf8'), successorToken)
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

test('withLock：statSync 持续失败时仍遵守 timeout', async () => {
  const dir = makeTmp()
  writeFileSync(join(dir, '.lock'), String(process.pid))
  const result = await runLockChild(dir, 'stat')
  assert.equal(result.timedOut, false, `子进程不应无限自旋：${result.stderr}`)
  assert.equal(result.code, 0, result.stderr)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：悬空 .lock 符号链接仍遵守 timeout', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  symlinkSync(join(dir, 'missing-lock-target'), join(dir, '.lock'))
  const result = await runLockChild(dir, 'normal')
  assert.equal(result.timedOut, false, `子进程不应无限自旋：${result.stderr}`)
  assert.equal(result.code, 0, result.stderr)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：回收锁删除失败时仍遵守 timeout', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  writeFileSync(lockPath, String(process.pid))
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past)
  const result = await runLockChild(dir, 'unlink')
  assert.equal(result.timedOut, false, `子进程不应无限自旋：${result.stderr}`)
  assert.equal(result.code, 0, result.stderr)
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
