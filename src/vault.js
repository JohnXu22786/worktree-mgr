/**
 * 状态账本（vault）：任务 ↔ 分支 ↔ 工作区路径 的映射持久化。
 *
 * 存放位置：
 *   - 显式配置（.wtm.json 的 vault 键 / WTM_VAULT 环境变量）
 *   - 否则为平台数据目录下的 wtm/vaults/<仓库slug>/
 *
 * 存储格式为单个 JSON 文件 index.json：
 *   { "version": 1, "records": [ { task, branch, base, path, createdAt, updatedAt, note? } ] }
 *
 * 并发安全：所有写入都在 withLock 的临界区内完成；锁文件 .lock 带过期
 * 回收机制（staleMs），进程崩溃不会永久卡死后续操作。
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export class VaultError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'VaultError'
  }
}

/**
 * 账本中的单条任务记录。
 * @typedef {object} LedgerRecord
 * @property {string} task
 * @property {string} branch
 * @property {string} base
 * @property {string} path
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [note]
 */

/**
 * 账本整体结构。
 * @typedef {object} Ledger
 * @property {number} version
 * @property {LedgerRecord[]} records
 */

/** @type {Ledger} */
export const EMPTY_LEDGER = { version: 1, records: [] }

/**
 * 平台数据目录：win32 用 LOCALAPPDATA，其他平台用 XDG_DATA_HOME。
 * @returns {string}
 */
export function platformDataDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  }
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
}

/**
 * 由仓库顶层路径生成稳定 slug：<规范化仓库名>-<路径哈希前 8 位>。
 * 同名的仓库放在不同路径下也不会冲突。
 * @param {string} rootPath
 * @returns {string}
 */
export function repoSlug(rootPath) {
  const name = basename(rootPath) || 'repo'
  const cleaned = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  // Windows 文件系统大小写不敏感：规范化后再哈希，避免同一仓库因大小写产生两套 vault
  const canonical = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `${cleaned || 'repo'}-${hash}`
}

/**
 * 解析 vault 目录（空值表示未配置）。
 * @param {{rootPath: string, vault: string | null | undefined}} opts
 * @returns {string | null}
 */
export function resolveVault({ rootPath, vault }) {
  if (vault === null || vault === undefined) return null
  if (typeof vault !== 'string' || vault.trim() === '') return null
  const v = vault.trim()
  if (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) return v
  return resolve(rootPath, v)
}

/**
 * 计算最终生效的 vault 目录。
 * @param {string} rootPath
 * @param {string | null | undefined} vault 配置的 vault（可为空）
 * @returns {string}
 */
export function computeVault(rootPath, vault) {
  return resolveVault({ rootPath, vault }) ?? join(platformDataDir(), 'wtm', 'vaults', repoSlug(rootPath))
}

/**
 * 解析路径中的别名和已存在路径段中的符号链接。
 * 目标目录可能尚未创建，因此从最近的已存在父目录开始解析，再拼回尾部。
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  const absolute = resolve(path)
  let existing = absolute
  /** @type {string[]} */
  const suffix = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return absolute
    suffix.unshift(basename(existing))
    existing = parent
  }
  try {
    return join(realpathSync(existing), ...suffix)
  } catch {
    return absolute
  }
}

/**
 * 判断 target 是否位于 parent 之内（或等于 parent）。
 * 比较前解析路径别名和符号链接；路径分隔符先归一化，Windows 下同时忽略大小写
 * （与 samePath 语义一致），防止路径变体绕过防护。
 * @param {string} parent
 * @param {string} target
 * @returns {boolean}
 */
export function isWithin(parent, target) {
  const norm = (/** @type {string} */ p) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  let p = norm(canonicalPath(parent))
  let t = norm(canonicalPath(target))
  if (process.platform === 'win32') {
    p = p.toLowerCase()
    t = t.toLowerCase()
  }
  if (p === t) return true
  return t.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/**
 * 读取账本；文件不存在时返回空账本。
 * 逐条校验记录必填字段（task/branch/base/path 均为字符串），
 * 单条坏记录不瘫痪整个账本——直接按损坏处理并给出恢复指引。
 * @param {string} vaultDir
 * @returns {Ledger}
 * @throws {VaultError} 账本损坏时
 */
export function loadLedger(vaultDir) {
  const indexPath = join(vaultDir, 'index.json')
  if (!existsSync(indexPath)) return structuredClone(EMPTY_LEDGER)
  let text
  try {
    text = readFileSync(indexPath, 'utf8')
  } catch (err) {
    throw new VaultError(`账本不可读（${indexPath}）：${/** @type {Error} */ (err).message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new VaultError(`账本损坏（${indexPath}）：${/** @type {Error} */ (err).message}。` +
      '若确认无用可删除该文件重建。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.records)) {
    throw new VaultError(`账本格式非法（${indexPath}）：应为 {version, records[]} 结构`)
  }
  for (const rec of parsed.records) {
    for (const key of ['task', 'branch', 'base', 'path']) {
      if (typeof rec?.[key] !== 'string' || rec[key] === '') {
        throw new VaultError(`账本记录字段缺失或非法（${indexPath} 中 ${JSON.stringify(rec)}）：` +
          `缺少字符串字段 ${key}。若确认无用可删除该文件重建。`)
      }
    }
  }
  return parsed
}

/**
 * 原子写入账本：先写临时文件再 rename，避免半截文件。
 * @param {string} vaultDir
 * @param {Ledger} ledger
 */
export function saveLedger(vaultDir, ledger) {
  mkdirSync(vaultDir, { recursive: true })
  const indexPath = join(vaultDir, 'index.json')
  const tmpPath = join(vaultDir, `.index.json.tmp-${process.pid}`)
  writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), 'utf8')
  renameSync(tmpPath, indexPath)
}

/**
 * 尝试取得锁操作的互斥 guard。guard 是目录而不是普通文件，
 * 回收时必须先清空再 rmdir；如果期间出现新的 guard，rmdir 会失败，
 * 不会误删新的持有者。
 * @param {string} reclaimPath
 * @param {string} lockPath
 * @param {string} token
 * @param {number} staleMs
 * @returns {string | null}
 */
function acquireLeaseGuard(reclaimPath, lockPath, token, staleMs) {
  const stagingPath = `${reclaimPath}.creating-${token}`
  try {
    mkdirSync(stagingPath)
    writeFileSync(join(stagingPath, 'token'), token, 'utf8')
    renameSync(stagingPath, reclaimPath)
    return token
  } catch (err) {
    try { unlinkSync(join(stagingPath, 'token')) } catch { /* 忽略 */ }
    try { rmdirSync(stagingPath) } catch { /* 忽略 */ }
    const code = /** @type {any} */ (err).code
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EISDIR') throw err
    // 另一个进程持有 guard；下面只回收陈旧 guard，或没有对应锁的孤儿 guard。
  }

  let guardStat
  try {
    guardStat = statSync(reclaimPath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null
    throw err
  }
  let lockExists = true
  try {
    statSync(lockPath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') lockExists = false
    else throw err
  }
  const guardAge = Date.now() - guardStat.mtimeMs
  if (!guardStat.isDirectory()) {
    // 兼容旧版本留下的普通文件 claim；新 guard 始终是目录，
    // 因此 unlink 不会误删新的目录 guard。
    if (guardAge <= staleMs && lockExists) return null
    let observedToken = null
    try { observedToken = readFileSync(reclaimPath, 'utf8') } catch { /* 文件可能刚被清理 */ }
    try {
      const currentStat = statSync(reclaimPath)
      if (currentStat.dev !== guardStat.dev || currentStat.ino !== guardStat.ino) return null
      if (readFileSync(reclaimPath, 'utf8') !== observedToken) return null
      unlinkSync(reclaimPath)
    } catch { /* 对方刚好完成或替换了旧 claim */ }
    return null
  }
  const tokenPath = join(reclaimPath, 'token')
  let observedToken = null
  try {
    observedToken = readFileSync(tokenPath, 'utf8')
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') throw err
  }
  if (guardAge <= staleMs && lockExists) return null

  if (observedToken === null && guardAge <= staleMs) return null
  const reclaimingPath = join(reclaimPath, 'reclaiming')
  let reclaimingFd = null
  try {
    reclaimingFd = openSync(reclaimingPath, 'wx')
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'EEXIST') throw err
    // 另一个回收者已经预约了该 guard；只有陈旧预约才可清理。
    try {
      const reclaimingStat = statSync(reclaimingPath)
      if (Date.now() - reclaimingStat.mtimeMs > staleMs) {
        try { unlinkSync(reclaimingPath) } catch { /* 对方刚好完成 */ }
      }
    } catch { /* 对方刚好完成或预约已被清理 */ }
    return null
  }

  try {
    const currentStat = statSync(reclaimPath)
    if (currentStat.dev !== guardStat.dev || currentStat.ino !== guardStat.ino) return null
    let currentToken = null
    try {
      currentToken = readFileSync(tokenPath, 'utf8')
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err
    }
    if (currentToken !== observedToken) {
      // 原持有者可能已先释放 token；此时 guard 目录已经没有持有者，
      // 可以在预约仍有效时一并清理。新的 guard 会表现为不同的目录 inode。
      return null
    }
    try { unlinkSync(tokenPath) } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err
    }
  } finally {
    if (reclaimingFd !== null) {
      try { closeSync(reclaimingFd) } catch { /* 忽略 */ }
    }
    try { unlinkSync(reclaimingPath) } catch { /* 对方刚好完成 */ }
    // 非空的新 guard 不会被删除；空目录可能只是原持有者已释放后的残留。
    try { rmdirSync(reclaimPath) } catch { /* 后继 guard 已出现或已被回收 */ }
  }
  return null
}

/**
 * 释放自己持有的操作 guard。
 * @param {string} reclaimPath
 * @param {string} token
 */
function releaseLeaseGuard(reclaimPath, token) {
  try {
    if (readFileSync(join(reclaimPath, 'token'), 'utf8') !== token) return
    unlinkSync(join(reclaimPath, 'token'))
    try { rmdirSync(reclaimPath) } catch { /* 后继 guard 已出现或已被回收 */ }
  } catch { /* guard 可能已被回收或删除，忽略 */ }
}

/**
 * 账本互斥锁。fn 执行期间持有锁，其他调用方自旋等待。
 *
 * 安全性设计（防止多进程并发写账本）：
 * - 锁文件内容为持有者唯一 token（pid + 随机数），释放前先读取比对，
 *   只删除属于自己的锁——被其他进程回收（stale 窃取）后不会误删后继锁；
 * - 锁的创建、回收、心跳和释放都先取得 wx 独占的 .reclaim guard，
 *   回收者无法在持有者更新或释放锁的临界区内删除锁；
 * - 持锁期间每心跳间隔在 guard 内刷新锁文件 mtime，长任务（如触发器）不会因
 *   陈旧判定被其他进程窃取锁；
 * - 进程崩溃时心跳停止，锁文件超过 staleMs 判定陈旧并回收。
 *
 * @template T
 * @param {string} vaultDir
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, staleMs?: number, heartbeatMs?: number}} [opts]
 * @returns {Promise<T>}
 * @throws {VaultError} 等待超时
 */
export async function withLock(vaultDir, fn, { timeoutMs = 5000, staleMs = 300_000, heartbeatMs = 30_000 } = {}) {
  mkdirSync(vaultDir, { recursive: true })
  const lockPath = join(vaultDir, '.lock')
  const reclaimPath = `${lockPath}.reclaim`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + timeoutMs
  let fd = null
  let owned = false
  for (;;) {
    const reclaimFd = acquireLeaseGuard(reclaimPath, lockPath, token, staleMs)
    if (reclaimFd === null) {
      if (Date.now() >= deadline) {
        throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
      }
      await new Promise((r) => setTimeout(r, 100))
      continue
    }

    let acquired = false
    try {
      try {
        fd = openSync(lockPath, 'wx')
        writeFileSync(fd, token, 'utf8')
        acquired = true
      } catch (err) {
        if (fd !== null) {
          try { closeSync(fd) } catch { /* 忽略 */ }
          fd = null
        }
        if (/** @type {any} */ (err).code !== 'EEXIST') throw err
        let stale = false
        try {
          const st = statSync(lockPath)
          stale = Date.now() - st.mtimeMs > staleMs
        } catch (statErr) {
          if (/** @type {any} */ (statErr).code !== 'ENOENT') throw statErr
          stale = true
        }
        if (stale) {
          try { unlinkSync(lockPath) } catch (unlinkErr) {
            if (/** @type {any} */ (unlinkErr).code !== 'ENOENT') throw unlinkErr
          }
          try {
            fd = openSync(lockPath, 'wx')
            writeFileSync(fd, token, 'utf8')
            acquired = true
          } catch (retryErr) {
            if (fd !== null) {
              try { closeSync(fd) } catch { /* 忽略 */ }
              fd = null
            }
            if (/** @type {any} */ (retryErr).code !== 'EEXIST') throw retryErr
          }
        }
      }
    } catch (err) {
      releaseLeaseGuard(reclaimPath, reclaimFd)
      throw err
    }
    releaseLeaseGuard(reclaimPath, reclaimFd)
    if (acquired && fd !== null) {
      owned = true
      break
    }

    if (Date.now() >= deadline) {
      throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  // 心跳：定期刷新 mtime，防止长任务期间被误判陈旧
  const heartbeat = setInterval(() => {
    if (!owned || fd === null) return
    const heartbeatToken = `${token}-heartbeat`
    let guardToken = null
    try {
      guardToken = acquireLeaseGuard(reclaimPath, lockPath, heartbeatToken, staleMs)
    } catch { return }
    if (guardToken === null) return
    try {
      if (readFileSync(lockPath, 'utf8') !== token) {
        owned = false
        return
      }
      const now = new Date()
      futimesSync(fd, now, now)
    } catch { /* 锁可能已被回收，忽略 */ }
    finally { releaseLeaseGuard(reclaimPath, guardToken) }
  }, heartbeatMs)
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    const releaseToken = `${token}-release`
    const releaseDeadline = Date.now() + timeoutMs
    let releaseGuard = null
    while (releaseGuard === null) {
      try {
        releaseGuard = acquireLeaseGuard(reclaimPath, lockPath, releaseToken, staleMs)
      } catch {
        break
      }
      if (releaseGuard !== null || Date.now() >= releaseDeadline) break
      await new Promise((r) => setTimeout(r, 10))
    }
    if (releaseGuard === null) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* 忽略 */ }
      }
    } else {
      try {
        if (fd !== null) {
          try { closeSync(fd) } catch { /* 忽略 */ }
        }
        // 只删除属于自己的锁：先读内容比对 token，防止误删后继持有者的锁
        try {
          const content = readFileSync(lockPath, 'utf8')
          if (content === token) unlinkSync(lockPath)
        } catch { /* 已被回收或删除，忽略 */ }
      } finally {
        releaseLeaseGuard(reclaimPath, releaseGuard)
      }
    }
  }
}

/**
 * 按任务名查找记录。
 * @param {Ledger} ledger
 * @param {string} task
 * @returns {LedgerRecord | undefined}
 */
export function findRecord(ledger, task) {
  return ledger.records.find((r) => r.task === task)
}

/**
 * 新增或替换记录（同任务去重）。
 * @param {Ledger} ledger
 * @param {LedgerRecord} record
 */
export function upsertRecord(ledger, record) {
  const idx = ledger.records.findIndex((r) => r.task === record.task)
  if (idx >= 0) ledger.records[idx] = record
  else ledger.records.push(record)
}

/**
 * 删除记录。
 * @param {Ledger} ledger
 * @param {string} task
 * @returns {boolean} 是否存在并被删除
 */
export function removeRecord(ledger, task) {
  const idx = ledger.records.findIndex((r) => r.task === task)
  if (idx < 0) return false
  ledger.records.splice(idx, 1)
  return true
}
