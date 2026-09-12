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
  linkSync,
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
 * 解析 guard token 中的持有者 PID。
 * @param {string} token
 * @returns {number | null}
 */
function guardOwnerPid(token) {
  const match = /^(\d+)-/.exec(token)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * 判断 guard 的持有进程是否仍存在。无法确认时保守地视为仍存在，
 * 避免回收活动进程的临界区。
 * @param {string} token
 * @returns {boolean | null}
 */
function isGuardOwnerAlive(token) {
  const pid = guardOwnerPid(token)
  if (pid === null) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'ESRCH' ? false : true
  }
}

/**
 * 删除已从 guard 路径移走的旧 guard 文件或兼容旧版本的目录。
 * @param {string} path
 */
function removeGuardArtifact(path) {
  const st = statSync(path)
  if (!st.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const child of ['token', 'reclaiming']) {
    try { unlinkSync(join(path, child)) } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err
    }
  }
  rmdirSync(path)
}

/**
 * 将旧 guard 原子地移出固定路径，再清理 tombstone；不会触碰后继 guard。
 * @param {string} reclaimPath
 * @param {string} token
 * @returns {boolean} 是否成功移走 guard
 */
function moveStaleGuard(reclaimPath, token) {
  const tombstonePath = `${reclaimPath}.reclaimed-${token}`
  try {
    renameSync(reclaimPath, tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return false
    throw err
  }
  removeGuardArtifact(tombstonePath)
  return true
}

/**
 * 尝试取得整个锁生命周期使用的互斥 guard。
 * guard 先写入临时文件，再通过硬链接原子发布；只要 token 对应进程仍活着，
 * guard 永不过期。进程崩溃后，回收者用 rename 将旧 guard 移到独立 tombstone，
 * 因此不会误删随后发布的新 guard。
 * @param {string} reclaimPath
 * @param {string} token
 * @param {number} staleMs
 * @returns {string | null}
 */
function acquireLeaseGuard(reclaimPath, token, staleMs) {
  const tempPath = `${reclaimPath}-${token}.tmp`
  let fd = null
  try {
    fd = openSync(tempPath, 'wx')
    writeFileSync(fd, token, 'utf8')
    futimesSync(fd, new Date(), new Date())
    closeSync(fd)
    fd = null
    linkSync(tempPath, reclaimPath)
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 忽略 */ }
    }
    try { unlinkSync(tempPath) } catch { /* 忽略 */ }
    const code = /** @type {any} */ (err).code
    if (code !== 'EEXIST' && code !== 'EISDIR') throw err
    let existingStat
    try {
      existingStat = statSync(reclaimPath)
    } catch (statErr) {
      if (/** @type {any} */ (statErr).code === 'ENOENT') return null
      throw statErr
    }
    let existingToken = null
    if (existingStat.isDirectory()) {
      try {
        existingToken = readFileSync(join(reclaimPath, 'token'), 'utf8')
      } catch (readErr) {
        if (/** @type {any} */ (readErr).code === 'ENOENT') {
          // 旧版本在 mkdir 后崩溃留下的空目录没有发布任何 owner token。
          try { rmdirSync(reclaimPath) } catch { /* 另一个进程正在填充它 */ }
          return null
        }
        throw readErr
      }
    } else {
      try {
        existingToken = readFileSync(reclaimPath, 'utf8')
      } catch (readErr) {
        if (/** @type {any} */ (readErr).code !== 'ENOENT') throw readErr
        return null
      }
    }
    const ownerAlive = isGuardOwnerAlive(existingToken)
    if (ownerAlive === true) return null
    if (ownerAlive === null && Date.now() - existingStat.mtimeMs <= staleMs) return null
    moveStaleGuard(reclaimPath, token)
    return null
  }
  try { unlinkSync(tempPath) } catch { /* 临时硬链接可由后续清理 */ }
  return token
}

/**
 * 原子释放自己持有的 guard。先 rename 离开固定路径，再清理独立 tombstone，
 * 这样释放失败也不会把后继 guard 当成自己的 guard 删除。
 * @param {string} reclaimPath
 * @param {string} token
 */
function releaseLeaseGuard(reclaimPath, token) {
  let content
  try {
    content = readFileSync(reclaimPath, 'utf8')
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return
    throw err
  }
  if (content !== token) return
  const tombstonePath = `${reclaimPath}.released-${token}`
  renameSync(reclaimPath, tombstonePath)
  unlinkSync(tombstonePath)
}

/**
 * 账本互斥锁。fn 执行期间持有锁，其他调用方自旋等待。
 *
 * 安全性设计（防止多进程并发写账本）：
 * - token 先写入当前进程的临时文件，再通过硬链接原子地占用 .lock，
 *   写入失败不会暴露未完成的锁文件；
 * - 锁文件内容为持有者唯一 token（pid + 随机数），释放前先读取比对，
 *   只删除属于自己的锁——被其他进程回收（stale 窃取）后不会误删后继锁；
 * - .reclaim guard 覆盖整个 fn 生命周期，且只在确认持有进程已退出后回收，
 *   回收者无法在持有者更新或释放锁的临界区内删除锁；
 * - 持锁期间每心跳间隔刷新锁文件 mtime，长任务（如触发器）不会因
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
  const tempLockPath = join(vaultDir, `.lock-${token}.tmp`)
  const deadline = Date.now() + timeoutMs
  let fd = null
  let owned = false
  let guardToken = null
  for (;;) {
    const candidateGuard = acquireLeaseGuard(reclaimPath, token, staleMs)
    if (candidateGuard === null) {
      if (Date.now() >= deadline) {
        throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
      }
      await new Promise((r) => setTimeout(r, 100))
      continue
    }

    let acquired = false
    try {
      for (;;) {
        try {
          fd = openSync(tempLockPath, 'wx')
          writeFileSync(fd, token, 'utf8')
          futimesSync(fd, new Date(), new Date())
          linkSync(tempLockPath, lockPath)
          acquired = true
          try { unlinkSync(tempLockPath) } catch { /* 持锁期间保留，释放时再清理 */ }
          break
        } catch (err) {
          if (fd !== null) {
            try { closeSync(fd) } catch { /* 忽略 */ }
            fd = null
          }
          try { unlinkSync(tempLockPath) } catch { /* 忽略 */ }
          if (/** @type {any} */ (err).code !== 'EEXIST') throw err

          let stale = false
          try {
            const st = statSync(lockPath)
            stale = Date.now() - st.mtimeMs > staleMs
          } catch (statErr) {
            if (/** @type {any} */ (statErr).code !== 'ENOENT') throw statErr
            continue // 对方刚好释放，重试
          }
          if (!stale) break
          try { unlinkSync(lockPath) } catch (unlinkErr) {
            if (/** @type {any} */ (unlinkErr).code !== 'ENOENT') throw unlinkErr
          }
        }
      }
    } catch (err) {
      try { releaseLeaseGuard(reclaimPath, candidateGuard) } catch (cleanupError) { throw cleanupError }
      throw err
    }
    if (acquired && fd !== null) {
      guardToken = candidateGuard
      owned = true
      break
    }

    releaseLeaseGuard(reclaimPath, candidateGuard)

    if (Date.now() >= deadline) {
      throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  // 心跳：定期刷新 mtime，防止长任务期间被误判陈旧
  const heartbeat = setInterval(() => {
    if (!owned || fd === null) return
    try {
      if (readFileSync(lockPath, 'utf8') !== token) {
        owned = false
        return
      }
      futimesSync(fd, new Date(), new Date())
    } catch { /* 锁可能已被回收，忽略 */ }
  }, heartbeatMs)
  let result
  let bodyError
  let bodyFailed = false
  try {
    result = await fn()
  } catch (err) {
    bodyFailed = true
    bodyError = err
  }
  clearInterval(heartbeat)

  /** @type {unknown} */
  let cleanupError
  const rememberCleanupError = (err) => {
    if (cleanupError === undefined) cleanupError = err
  }
  if (fd !== null) {
    try { closeSync(fd) } catch (err) { rememberCleanupError(err) }
  }
  try {
    const content = readFileSync(lockPath, 'utf8')
    if (content === token) unlinkSync(lockPath)
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') rememberCleanupError(err)
  }
  try { unlinkSync(tempLockPath) } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') rememberCleanupError(err)
  }
  if (guardToken !== null) {
    try { releaseLeaseGuard(reclaimPath, guardToken) } catch (err) { rememberCleanupError(err) }
  }
  if (bodyFailed) {
    throw bodyError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  return result
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
