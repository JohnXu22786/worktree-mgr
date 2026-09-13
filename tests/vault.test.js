import { spawn } from 'node:child_process'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, unlinkSync, statSync } from 'node:fs'
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
 * @param {string} path
 * @param {number} [timeoutMs]
 */
async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待测试标记超时：${path}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * @param {string[]} paths
 * @param {number} [timeoutMs]
 */
async function waitForAnyFile(paths, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!paths.some((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`等待测试标记超时：${paths.join(', ')}`)
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

test('withLock：崩溃留下的空 guard 不阻塞后续获取', async () => {
  const dir = makeTmp()
  const reclaimPath = join(dir, '.lock.reclaim')
  mkdirSync(reclaimPath)
  writeFileSync(join(reclaimPath, 'reclaiming'), 'legacy-reclaimer')
  const past = new Date(Date.now() - 120_000)
  utimesSync(reclaimPath, past, past)

  let ran = false
  await withLock(dir, async () => { ran = true }, { timeoutMs: 1000, staleMs: 60_000 })
  assert.equal(ran, true)
  assert.equal(existsSync(reclaimPath), false)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：释放清理失败时显式失败且不遗留锁', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const reclaimPath = join(dir, '.lock.reclaim')
  const cleanupError = Object.assign(new Error('guard cleanup failed'), { code: 'EIO' })
  const bodyError = new Error('body failed')
  const realRenameSync = fs.renameSync
  let failCleanup = false
  mock.method(fs, 'renameSync', (/** @type {string} */ source, /** @type {string} */ target) => {
    if (failCleanup && source === reclaimPath && target.includes('.released-')) throw cleanupError
    return realRenameSync(source, target)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      withLock(dir, async () => {
        failCleanup = true
        throw bodyError
      }),
      (error) => error instanceof AggregateError &&
        error.errors.includes(bodyError) && error.errors.includes(cleanupError),
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(lockPath), false)
  assert.equal(existsSync(reclaimPath), true)
  utimesSync(reclaimPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  await withLock(dir, async () => {}, { timeoutMs: 500, staleMs: 10 })
  assert.equal(existsSync(reclaimPath), false)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：释放 guard 时后继 guard 不会被旧流程删除', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  const reclaimPath = join(dir, '.lock.reclaim')
  const successorToken = 'successor-guard-token'
  const realRenameSync = fs.renameSync
  let replaced = false
  mock.method(fs, 'renameSync', (/** @type {string} */ source, /** @type {string} */ target) => {
    if (!replaced && source === reclaimPath && target.includes('.released-')) {
      replaced = true
      unlinkSync(source)
      writeFileSync(source, successorToken)
    }
    return realRenameSync(source, target)
  })
  syncBuiltinESMExports()
  try {
    await withLock(dir, async () => {}, { timeoutMs: 1000, staleMs: 10, heartbeatMs: 10 })
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(replaced, true)
  assert.equal(readFileSync(reclaimPath, 'utf8'), successorToken)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：释放 reclaim marker 时后继 marker 不会被旧流程删除', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  const reclaimPath = join(dir, '.lock.reclaim')
  const markerPath = `${reclaimPath}.reclaiming`
  const successorToken = 'successor-marker-token'
  const past = new Date(Date.now() - 60_000)
  writeFileSync(reclaimPath, 'stale-guard-token')
  utimesSync(reclaimPath, past, past)

  const realRenameSync = fs.renameSync
  let replaced = false
  let successorMoved = false
  mock.method(fs, 'renameSync', (/** @type {string} */ source, /** @type {string} */ target) => {
    if (!replaced && source === markerPath && target.includes('.released-')) {
      replaced = true
      unlinkSync(source)
      writeFileSync(source, successorToken)
      utimesSync(source, past, past)
    }
    const result = realRenameSync(source, target)
    if (replaced && source === markerPath && target.includes('.released-')) {
      successorMoved = readFileSync(target, 'utf8') === successorToken
    }
    return result
  })
  syncBuiltinESMExports()
  try {
    await withLock(dir, async () => {}, { timeoutMs: 1000, staleMs: 10, heartbeatMs: 10 })
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(replaced, true)
  assert.equal(successorMoved, true)
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：陈旧检查与持有者心跳不会竞态回收活动锁', async () => {
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
    let blockHeartbeat = false
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    fs.futimesSync = (...args) => {
      if (blockHeartbeat && !fs.existsSync(process.env.WTM_TEST_CONTINUE)) {
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
      blockHeartbeat = true
      fs.writeFileSync(process.env.WTM_TEST_READY, '')
      while (!fs.existsSync(process.env.WTM_TEST_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 5))
    }, { heartbeatMs: 10, staleMs: 50 })
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
    utimesSync(join(dir, '.lock.reclaim'), past, past)
    const contender = withLock(dir, async () => { contenderRan = true }, { timeoutMs: 150, staleMs: 50 })
    await new Promise((r) => setTimeout(r, 100))
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

test('withLock：多个陈旧回收者不会同时进入临界区', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const reclaimPath = join(dir, '.lock.reclaim')
  const releasePath = join(dir, '.release')
  const enteredPaths = [join(dir, '.entered-a'), join(dir, '.entered-b')]
  const donePaths = [join(dir, '.done-a'), join(dir, '.done-b')]
  const past = new Date(Date.now() - 60_000)
  writeFileSync(lockPath, 'dead-process-token')
  writeFileSync(reclaimPath, 'dead-guard-token')
  utimesSync(lockPath, past, past)
  utimesSync(reclaimPath, past, past)

  const childScript = `
    import fs from 'node:fs'
    const { withLock } = await import(process.env.WTM_TEST_VAULT_MODULE)
    await withLock(process.env.WTM_TEST_DIR, async () => {
      fs.writeFileSync(process.env.WTM_TEST_ENTERED, '')
      while (!fs.existsSync(process.env.WTM_TEST_RELEASE)) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }, { timeoutMs: 1000, staleMs: 50, heartbeatMs: 10 })
    fs.writeFileSync(process.env.WTM_TEST_DONE, '')
  `
  const children = enteredPaths.map((enteredPath, index) => spawn(
    process.execPath,
    ['--input-type=module', '-e', childScript],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        WTM_TEST_DIR: dir,
        WTM_TEST_VAULT_MODULE: new URL('../src/vault.js', import.meta.url).href,
        WTM_TEST_ENTERED: enteredPath,
        WTM_TEST_RELEASE: releasePath,
        WTM_TEST_DONE: donePaths[index],
      },
      stdio: 'ignore',
    },
  ))
  const exits = children.map((child) => new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  }))

  try {
    await waitForAnyFile(enteredPaths)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(enteredPaths.filter((path) => existsSync(path)).length, 1)
    writeFileSync(releasePath, '')
    await Promise.all(donePaths.map((path) => waitForFile(path)))
    const results = await Promise.all(exits)
    for (const result of results) {
      assert.equal(result.code, 0, `回收者子进程异常退出：${result.signal ?? result.code}`)
    }
  } finally {
    writeFileSync(releasePath, '')
    for (const child of children) {
      if (child.exitCode === null) child.kill()
    }
    await Promise.all(exits.map((exit) => exit.catch(() => {})))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withLock：陈旧锁持续重建时仍按 timeoutMs 退出', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const past = new Date(Date.now() - 60_000)
  writeFileSync(lockPath, 'stale-lock-token')
  utimesSync(lockPath, past, past)

  const realRenameSync = fs.renameSync
  let rebuilds = 0
  mock.method(fs, 'renameSync', (/** @type {string} */ source, /** @type {string} */ target) => {
    const result = realRenameSync(source, target)
    if (source === lockPath && target.includes('.stale-')) {
      rebuilds += 1
      writeFileSync(lockPath, 'rebuilt-stale-lock')
      utimesSync(lockPath, past, past)
    }
    return result
  })
  syncBuiltinESMExports()
  const started = Date.now()
  try {
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 500, staleMs: 10, heartbeatMs: 10 }),
      VaultError,
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.ok(rebuilds > 1, `应持续重建陈旧锁，实际 ${rebuilds} 次`)
  assert.ok(Date.now() - started < 1000, '持续重建陈旧锁不应阻塞超过 timeoutMs')
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：陈旧回收标记持续重建时仍按 timeoutMs 退出', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp()
  const markerPath = join(dir, '.lock.reclaim.reclaiming')
  const past = new Date(Date.now() - 60_000)
  writeFileSync(markerPath, 'stale-marker-token')
  utimesSync(markerPath, past, past)

  const realRenameSync = fs.renameSync
  let rebuilds = 0
  mock.method(fs, 'renameSync', (/** @type {string} */ source, /** @type {string} */ target) => {
    const result = realRenameSync(source, target)
    if (source === markerPath && target.includes('.stale-')) {
      rebuilds += 1
      writeFileSync(markerPath, 'rebuilt-stale-marker')
      utimesSync(markerPath, past, past)
    }
    return result
  })
  syncBuiltinESMExports()
  const started = Date.now()
  try {
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 500, staleMs: 10, heartbeatMs: 10 }),
      VaultError,
    )
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.ok(rebuilds > 1, `应持续重建陈旧标记，实际 ${rebuilds} 次`)
  assert.ok(Date.now() - started < 1500, '持续重建陈旧标记不应阻塞超过 timeoutMs')
  rmSync(dir, { recursive: true, force: true })
})

test('withLock：过期锁被回收（stale）', async () => {
  const dir = makeTmp()
  const lockPath = join(dir, '.lock')
  const reclaimPath = join(dir, '.lock.reclaim')
  writeFileSync(lockPath, String(process.pid))
  // guard token 中的 PID 仍然是当前进程，但这个 lease 已停止续租；
  // PID 存活不能阻止 stale lease 回收。
  writeFileSync(reclaimPath, `${process.pid}-old-guard`)
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past) // 锁文件时间戳拨回 1 分钟前
  utimesSync(reclaimPath, past, past)
  let ran = false
  await withLock(dir, async () => { ran = true }, { timeoutMs: 2000, staleMs: 10_000 })
  assert.equal(ran, true)
  assert.equal(existsSync(reclaimPath), false)
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
  await waitForFile(lockPath)
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
