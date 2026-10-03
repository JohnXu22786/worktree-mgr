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
  fstatSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { normalizePathForComparison } from './path-identity.js'

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
  if (/^[A-Za-z]:[^\\/]/.test(v)) return resolve(rootPath, v)
  const root = resolve(rootPath)
  const separator = process.platform === 'win32' ? '\\' : '/'
  const separatorPattern = process.platform === 'win32' ? /[\\/]+/ : /\/+/
  const relative = v.split(separatorPattern).filter((part) => part && part !== '.').join(separator)
  if (relative === '') return root
  return root.endsWith(separator) ? `${root}${relative}` : `${root}${separator}${relative}`
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
 * 按平台的文件系统语义解析路径段和符号链接。
 * 目标目录可能尚未创建，因此遇到不存在的路径段后继续拼接剩余路径。
 * @param {string} path
 * @returns {string | null}
 */
function canonicalPath(path, seen = new Set()) {
  const separatorPattern = process.platform === 'win32' ? /[\\/]+/ : /\/+/
  /**
   * @param {string} value
   * @returns {{root: string, parts: string[]}}
   */
  const splitPath = (value) => {
    const root = parse(value).root
    return { root, parts: value.slice(root.length).split(separatorPattern).filter(Boolean) }
  }
  // Win32 normalizes `..` before traversing junctions; POSIX follows symlinks first.
  const absolute = process.platform === 'win32'
    ? resolve(path)
    : isAbsolute(path)
      ? path
      : `${resolve('.')}/${path}`
  const parsed = splitPath(absolute)
  let existing = parsed.root
  /** @type {(string | { done: string })[]} */
  const pending = [...parsed.parts]

  while (pending.length > 0) {
    const item = pending.shift()
    if (item === undefined) continue
    if (typeof item !== 'string') {
      seen.delete(item.done)
      continue
    }
    const component = item
    if (component === '.') continue
    if (component === '..') {
      if (process.platform !== 'win32') {
        if (!statSync(existing).isDirectory()) {
          const error = Object.assign(new Error(`ENOTDIR: not a directory, path '${existing}'`), { code: 'ENOTDIR' })
          throw error
        }
      }
      const parent = dirname(existing)
      if (parent !== existing) existing = parent
      continue
    }

    const candidate = join(existing, component)
    try {
      const stat = lstatSync(candidate)
      if (stat.isSymbolicLink()) {
        if (seen.has(candidate)) return null
        seen.add(candidate)
        try {
          existing = realpathSync.native(candidate)
          pending.unshift({ done: candidate })
          continue
        } catch (err) {
          if (/** @type {{code?: string}} */ (err).code === 'ELOOP') return null
          const linkTarget = readlinkSync(candidate)
          const target = splitPath(linkTarget)
          existing = isAbsolute(linkTarget) ? target.root : dirname(candidate)
          pending.unshift(...target.parts, { done: candidate })
          continue
        }
      }
      existing = realpathSync(candidate)
    } catch {
      existing = candidate
    }
  }
  return existing
}

/**
 * 按文件系统语义解析路径；符号链接循环时返回 null。
 * @param {string} path
 * @returns {string | null}
 */
export function canonicalizePath(path) {
  return canonicalPath(path)
}

/**
 * 判断 target 是否位于 parent 之内（或等于 parent）。
 * 比较前解析路径别名和符号链接；仅在 Windows 下归一化路径分隔符并忽略大小写
 * （与 samePath 语义一致），防止路径变体绕过防护。POSIX 下反斜杠是有效的文件名字符。
 * @param {string} parent
 * @param {string} target
 * @returns {boolean}
 */
export function isWithin(parent, target) {
  const norm = (/** @type {string} */ p) => normalizePathForComparison(p).replace(/\/+$/, '')
  let canonicalParent
  let canonicalTarget
  try {
    canonicalParent = canonicalPath(parent)
    canonicalTarget = canonicalPath(target)
  } catch {
    return false
  }
  if (canonicalParent === null || canonicalTarget === null) return false
  let p = norm(canonicalParent)
  let t = norm(canonicalTarget)
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
 * 独立 heartbeat worker。主线程可能正在执行阻塞的同步文件操作，
 * 因此不能用主线程的 setInterval 作为 guard 的存活证明。
 */
const LEASE_HEARTBEAT_SOURCE = `
  const { workerData } = require('node:worker_threads')
  const { utimesSync } = require('node:fs')
  const beat = () => {
    try {
      const now = new Date()
      utimesSync(workerData.path, now, now)
    } catch { /* 所有者正在释放或 guard 已被回收 */ }
  }
  beat()
  const timer = setInterval(beat, workerData.intervalMs)
`

/**
 * @param {string} path
 * @param {number} staleMs
 * @param {number} heartbeatMs
 * @returns {{worker: Worker, ready: Promise<void>}}
 */
function startLeaseHeartbeat(path, staleMs, heartbeatMs) {
  const intervalMs = Math.max(1, Math.min(
    heartbeatMs,
    Math.max(1, Math.floor(staleMs / 3)),
  ))
  const worker = new Worker(LEASE_HEARTBEAT_SOURCE, {
    eval: true,
    workerData: { path, intervalMs },
  })
  // The worker must be started before the following synchronous operation:
  // that operation may block the main thread for longer than staleMs.
  // Keep an error listener attached so a failed heartbeat cannot become an
  // unhandled worker error during cleanup.
  worker.on('error', () => {})
  let readyState = false
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    worker.once('online', () => {
      readyState = true
      resolve()
    })
    worker.once('error', (err) => {
      if (!readyState) reject(err)
    })
    worker.once('exit', (code) => {
      if (!readyState && code !== 0) reject(new Error(`guard heartbeat worker exited (${code})`))
    })
  })
  return { worker, ready }
}

/** @param {Worker | null} worker */
async function stopLeaseHeartbeat(worker) {
  if (worker === null) return
  await worker.terminate()
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 清理操作允许少量瞬态 I/O 失败后重试。若仍然失败，调用方会把错误
 * 返回给用户；guard 的 heartbeat 已停止后，后续调用仍可按 mtime 回收它。
 * @template T
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
async function retryCleanup(action) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await action()
    } catch (err) {
      lastError = err
      if (attempt < 2) await delay(10)
    }
  }
  throw lastError
}

/**
 * 删除已从 guard 路径移走的旧 guard 文件或兼容旧版本的目录。
 * 只清理 vault 自己创建过的 legacy 子项，避免扩大删除范围。
 * @param {string} path
 */
function removeGuardArtifact(path) {
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return
    throw err
  }
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
 * Restore a tombstoned lease only while atomically claiming its fixed path.
 * Files are hard-linked so an existing destination is never replaced; legacy
 * guard directories reserve their name with mkdir before their children move.
 * @param {string} tombstonePath
 * @param {string} path
 */
function restoreGuardArtifact(tombstonePath, path) {
  let tombstoneStat
  try {
    tombstoneStat = lstatSync(tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return
    throw err
  }

  if (tombstoneStat.isDirectory()) {
    try {
      mkdirSync(path, { mode: tombstoneStat.mode })
    } catch (err) {
      const code = /** @type {any} */ (err).code
      if (code === 'EEXIST') {
        removeGuardArtifact(tombstonePath)
        return
      }
      if (code === 'ENOENT') return
      throw err
    }

    for (const child of readdirSync(tombstonePath)) {
      renameSync(join(tombstonePath, child), join(path, child))
    }
    rmdirSync(tombstonePath)
    return
  }

  try {
    linkSync(tombstonePath, path)
  } catch (err) {
    const code = /** @type {any} */ (err).code
    if (code === 'EEXIST') {
      removeGuardArtifact(tombstonePath)
      return
    }
    if (code === 'ENOENT') return
    throw err
  }
  try {
    unlinkSync(tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') throw err
  }
}

/**
 * 将一个陈旧 guard 原子地移到私有 tombstone 后再判断其时间戳。
 * 读取 mtime 与删除路径之间允许其他进程运行；若它们发布了后继
 * guard，rename 会移动后继对象，但后继的最新 mtime 会使其被恢复，
 * 而不是被删除。
 * @param {string} path
 * @param {number} staleMs
 * @param {string} token
 * @returns {boolean} 是否已确认没有活动 guard 可阻塞下一轮
 */
function reclaimStaleGuard(path, staleMs, token) {
  let st
  try {
    st = statSync(path)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }
  if (Date.now() - st.mtimeMs <= staleMs) return false

  const tombstonePath = `${path}.stale-${token}`
  try {
    renameSync(path, tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }

  let tombstoneStat
  try {
    tombstoneStat = statSync(tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }
  if (Date.now() - tombstoneStat.mtimeMs <= staleMs) {
    restoreGuardArtifact(tombstonePath, path)
    return false
  }
  removeGuardArtifact(tombstonePath)
  return true
}

/**
 * 当回收标记本身过期时，把它移到私有 tombstone 后再判断实际内容。
 * 这避免了“读取旧 mtime 后，rename 到了新回收者标记”的竞态；
 * 如果 tombstone 实际上是新鲜标记，会用硬链接安全地放回固定路径。
 * @param {string} markerPath
 * @param {string} token
 * @param {number} staleMs
 * @param {string} [protectedPath]
 * @returns {boolean} 是否可以再次尝试创建回收标记
 */
function reclaimStaleMarker(markerPath, token, staleMs, protectedPath) {
  let markerStat
  try {
    markerStat = statSync(markerPath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }
  if (Date.now() - markerStat.mtimeMs <= staleMs) return false
  if (protectedPath !== undefined) {
    try {
      const protectedStat = statSync(protectedPath)
      if (Date.now() - protectedStat.mtimeMs <= staleMs) return false
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err
    }
  }

  const tombstonePath = `${markerPath}.stale-${token}`
  try {
    renameSync(markerPath, tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }

  let tombstoneStat
  try {
    tombstoneStat = statSync(tombstonePath)
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return true
    throw err
  }
  if (Date.now() - tombstoneStat.mtimeMs <= staleMs) {
    try {
      linkSync(tombstonePath, markerPath)
    } catch (err) {
      const code = /** @type {any} */ (err).code
      if (code !== 'EEXIST' && code !== 'ENOENT') throw err
    }
    try { unlinkSync(tombstonePath) } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err
    }
    return false
  }
  if (protectedPath !== undefined && !reclaimStaleGuard(protectedPath, staleMs, token)) {
    removeGuardArtifact(tombstonePath)
    return false
  }
  removeGuardArtifact(tombstonePath)
  return true
}

/**
 * @typedef {object} LeaseMarker
 * @property {string} path
 * @property {string} token
 * @property {Worker} heartbeat
 */

/**
 * 取得固定的 stale-reclamation 标记。所有新 guard 的发布都检查这个标记，
 * 所以持有标记的回收者可以在 guard 路径上安全地完成一次完整判断和清理。
 * @param {string} reclaimPath
 * @param {string} token
 * @param {number} staleMs
 * @param {number} heartbeatMs
 * @param {number} deadline
 * @param {() => void} throwIfAborted
 * @returns {Promise<LeaseMarker | null>}
 */
async function acquireReclaimMarker(reclaimPath, token, staleMs, heartbeatMs, deadline, throwIfAborted) {
  const markerPath = `${reclaimPath}.reclaiming`
  for (;;) {
    throwIfAborted()
    if (Date.now() >= deadline) return null
    let fd = null
    let heartbeat = null
    let markerCreated = false
    try {
      fd = openSync(markerPath, 'wx')
      markerCreated = true
      const started = startLeaseHeartbeat(markerPath, staleMs, heartbeatMs)
      heartbeat = started.worker
      await started.ready
      writeFileSync(fd, token, 'utf8')
      closeSync(fd)
      fd = null
      return { path: markerPath, token, heartbeat }
    } catch (err) {
      let creationFileStat = null
      if (fd !== null) {
        try { creationFileStat = fstatSync(fd) } catch { /* 继续尽力清理 */ }
        if (process.platform === 'win32') {
          // Windows requires the handle closed before the lease path can be renamed.
          try { closeSync(fd) } catch { /* 继续报告原始错误 */ }
          fd = null
        }
      }
      let cleanupError
      try {
        if (markerCreated) {
          await releaseLeasePath(
            markerPath,
            token,
            heartbeat,
            'reclaim marker creation cleanup failed',
            true,
            creationFileStat,
          )
        } else {
          await stopLeaseHeartbeat(heartbeat)
        }
      } catch (cleanupErr) {
        cleanupError = cleanupErr
      } finally {
        // Keep the descriptor open through rename so its inode cannot be reused
        // by a successor before tombstone ownership is checked.
        if (fd !== null) {
          try { closeSync(fd) } catch { /* 继续报告原始错误 */ }
        }
      }
      if (cleanupError !== undefined) {
        throw new AggregateError([err, cleanupError], 'reclaim marker creation failed')
      }
      if (/** @type {any} */ (err).code !== 'EEXIST') throw err
      if (!reclaimStaleMarker(markerPath, token, staleMs, reclaimPath)) return null
      if (Date.now() >= deadline) return null
      await delay(Math.min(10, Math.max(0, deadline - Date.now())))
    }
  }
}

/**
 * 若已有回收标记，只有在确认它已过期并完成安全回收后才允许发布 guard。
 * @param {string} reclaimPath
 * @param {string} token
 * @param {number} staleMs
 * @returns {boolean} 是否可以继续尝试发布 guard
 */
function canPublishGuard(reclaimPath, token, staleMs) {
  return reclaimStaleMarker(`${reclaimPath}.reclaiming`, token, staleMs, reclaimPath)
}

/**
 * 原子释放一个带 token 的 lease。先把固定路径移到唯一 tombstone，
 * 后续读写只针对 tombstone；因此后继进程即使立刻重新占用固定路径，
 * 旧释放流程也不会按固定路径删除它。
 * @param {string} path
 * @param {string} token
 * @param {Worker | null} heartbeat
 * @param {string} errorMessage
 * @param {boolean} [allowEmpty]
 * @param {import('node:fs').Stats | null} [creationFileStat]
 */
async function releaseLeasePath(path, token, heartbeat, errorMessage, allowEmpty = false, creationFileStat = null) {
  const tombstonePath = `${path}.released-${token}`
  let moved = false
  let heartbeatStopped = false
  /** @type {unknown} */
  let stopError
  /** @type {unknown} */
  let releaseError
  const stopHeartbeat = async () => {
    if (heartbeatStopped) return
    heartbeatStopped = true
    try {
      await stopLeaseHeartbeat(heartbeat)
    } catch (err) {
      stopError = err
    }
  }

  try {
    await retryCleanup(async () => {
      if (!moved) {
        try {
          renameSync(path, tombstonePath)
          moved = true
        } catch (err) {
          if (/** @type {any} */ (err).code === 'ENOENT') return
          throw err
        }
        // The fixed path is no longer ours after rename. Stop the worker
        // before a successor can publish the same path.
        await stopHeartbeat()
      }

      let content
      try {
        content = readFileSync(tombstonePath, 'utf8')
      } catch (err) {
        if (/** @type {any} */ (err).code === 'ENOENT') {
          moved = false
          return
        }
        throw err
      }
      const isEmptyCreationFile = allowEmpty && content === ''
      const isPartialToken = content.length > 0 && content.length < token.length && token.startsWith(content)
      let isCreatedFile = false
      if (creationFileStat !== null && (content === token || isEmptyCreationFile || isPartialToken)) {
        try {
          const tombstoneStat = lstatSync(tombstonePath)
          isCreatedFile = tombstoneStat.dev === creationFileStat.dev && tombstoneStat.ino === creationFileStat.ino
        } catch (err) {
          if (/** @type {any} */ (err).code !== 'ENOENT') throw err
        }
      }
      if (
        (content === token && (creationFileStat === null || isCreatedFile)) ||
        (isCreatedFile && (isEmptyCreationFile || isPartialToken))
      ) {
        removeGuardArtifact(tombstonePath)
        moved = false
        return
      }

      // The path contained a successor. Restore it only if it can claim the
      // fixed path without replacing a successor that appeared in the meantime.
      restoreGuardArtifact(tombstonePath, path)
      moved = false
    })
  } catch (err) {
    releaseError = err
  } finally {
    await stopHeartbeat()
  }

  if (moved && releaseError === undefined) {
    releaseError = new Error(errorMessage)
  }
  if (stopError !== undefined && releaseError !== undefined) {
    releaseError = new AggregateError([releaseError, stopError], errorMessage)
  } else if (stopError !== undefined) {
    releaseError = stopError
  }
  if (releaseError !== undefined) throw releaseError
}

/**
 * 释放回收标记。只操作自己 token 对应的 tombstone，避免触碰后继标记。
 * @param {LeaseMarker} marker
 */
async function releaseReclaimMarker(marker) {
  await releaseLeasePath(marker.path, marker.token, marker.heartbeat, 'reclaim marker cleanup failed')
}

/**
 * 释放已取得的 guard。只操作自己 token 对应的 tombstone，避免触碰后继 guard。
 * @param {{path: string, token: string, heartbeat: Worker}} lease
 */
async function releaseLeaseGuard(lease) {
  await releaseLeasePath(lease.path, lease.token, lease.heartbeat, 'guard cleanup failed')
}

/**
 * 尝试取得整个锁生命周期使用的互斥 guard。
 * guard 是先创建再由独立 worker 续租的 regular file；因此主线程在
 * 创建、心跳或释放中的同步 I/O 阻塞时，其他进程不会误判它已过期。
 * @param {string} reclaimPath
 * @param {string} token
 * @param {number} staleMs
 * @param {number} heartbeatMs
 * @param {number} deadline
 * @param {() => void} throwIfAborted
 * @returns {Promise<{path: string, token: string, heartbeat: Worker} | null>}
 */
async function acquireLeaseGuard(reclaimPath, token, staleMs, heartbeatMs, deadline, throwIfAborted) {
  throwIfAborted()
  if (Date.now() >= deadline) return null
  if (!canPublishGuard(reclaimPath, token, staleMs)) return null

  let fd = null
  let heartbeat = null
  let guardCreated = false
  try {
    fd = openSync(reclaimPath, 'wx')
    guardCreated = true
    const started = startLeaseHeartbeat(reclaimPath, staleMs, heartbeatMs)
    heartbeat = started.worker
    await started.ready
    writeFileSync(fd, token, 'utf8')
    closeSync(fd)
    fd = null

    // 回收者可能在 openSync 与 token 发布之间取得了标记。此 guard
    // 不得越过它进入临界区，清掉自己后让下一轮重新判断。
    if (!canPublishGuard(reclaimPath, token, staleMs)) {
      await releaseLeaseGuard({ path: reclaimPath, token, heartbeat })
      return null
    }
    return { path: reclaimPath, token, heartbeat }
  } catch (err) {
    let creationFileStat = null
    if (fd !== null) {
      try { creationFileStat = fstatSync(fd) } catch { /* 继续尽力清理 */ }
      if (process.platform === 'win32') {
        // Windows requires the handle closed before the lease path can be renamed.
        try { closeSync(fd) } catch { /* 继续报告原始错误 */ }
        fd = null
      }
    }
    let cleanupError
    try {
      if (guardCreated) {
        await releaseLeasePath(
          reclaimPath,
          token,
          heartbeat,
          'guard creation cleanup failed',
          true,
          creationFileStat,
        )
      } else {
        await stopLeaseHeartbeat(heartbeat)
      }
    } catch (cleanupErr) {
      cleanupError = cleanupErr
    } finally {
      // Keep the descriptor open through rename so its inode cannot be reused
      // by a successor before tombstone ownership is checked.
      if (fd !== null) {
        try { closeSync(fd) } catch { /* 继续报告原始错误 */ }
      }
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([err, cleanupError], 'guard creation failed')
    }
    const code = /** @type {any} */ (err).code
    if (code !== 'EEXIST' && code !== 'EISDIR') throw err
  }

  const marker = await acquireReclaimMarker(reclaimPath, token, staleMs, heartbeatMs, deadline, throwIfAborted)
  if (marker === null) return null
  let actionError
  try {
    let existingStat
    try {
      existingStat = statSync(reclaimPath)
    } catch (err) {
      if (/** @type {any} */ (err).code === 'ENOENT') existingStat = null
      else throw err
    }
    if (existingStat !== null) {
      if (Date.now() - existingStat.mtimeMs > staleMs) {
        reclaimStaleGuard(reclaimPath, staleMs, token)
      }
    }
  } catch (err) {
    actionError = err
  }
  let releaseError
  try {
    await releaseReclaimMarker(marker)
  } catch (err) {
    releaseError = err
  }
  if (actionError !== undefined && releaseError !== undefined) {
    throw new AggregateError([actionError, releaseError], 'guard reclaim cleanup failed')
  }
  if (actionError !== undefined) throw actionError
  if (releaseError !== undefined) throw releaseError
  return null
}

/**
 * 账本互斥锁。fn 执行期间持有锁，其他调用方自旋等待。
 *
 * 安全性设计（防止多进程并发写账本）：
 * - token 先写入当前进程的临时文件，再通过硬链接原子地占用 .lock，
 *   写入失败不会暴露未完成的锁文件；
 * - 锁文件内容为持有者唯一 token（pid + 随机数），释放前先读取比对，
 *   只删除属于自己的锁——被其他进程回收（stale 窃取）后不会误删后继锁；
 * - .reclaim guard 覆盖整个 fn 生命周期，并由独立 worker 续租；只有 guard
 *   和当前回收标记都停止续租后才回收，主线程阻塞时也不会删除活动锁；
 * - 持锁期间每心跳间隔刷新锁文件 mtime，长任务（如触发器）不会因
 *   陈旧判定被其他进程窃取锁；
 * - 进程崩溃时心跳停止，锁文件超过 staleMs 判定陈旧并回收。
 *
 * @template T
 * @param {string} vaultDir
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, staleMs?: number, heartbeatMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<T>}
 * @throws {VaultError} 等待超时
 */
export async function withLock(vaultDir, fn, {
  timeoutMs = 5000,
  staleMs = 300_000,
  heartbeatMs = 30_000,
  signal,
} = {}) {
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  }
  /** @returns {Promise<void>} */
  const waitForRetry = () => {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, 100))
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      const onAbort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 100)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  throwIfAborted()
  mkdirSync(vaultDir, { recursive: true })
  const lockPath = join(vaultDir, '.lock')
  const reclaimPath = `${lockPath}.reclaim`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const tempLockPath = join(vaultDir, `.lock-${token}.tmp`)
  const deadline = Date.now() + timeoutMs
  let fd = null
  let owned = false
  let guardLease = null
  for (;;) {
    throwIfAborted()
    const candidateGuard = await acquireLeaseGuard(
      reclaimPath,
      token,
      staleMs,
      heartbeatMs,
      deadline,
      throwIfAborted,
    )
    if (candidateGuard === null) {
      throwIfAborted()
      if (Date.now() >= deadline) {
        throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
      }
      await waitForRetry()
      continue
    }

    let acquired = false
    try {
      throwIfAborted()
      for (;;) {
        throwIfAborted()
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
            if (/** @type {any} */ (statErr).code === 'ENOENT') {
              if (Date.now() >= deadline) {
                throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
              }
              await delay(0)
              continue // 对方刚好释放，重试
            }
            if (Date.now() >= deadline) {
              throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
            }
            await waitForRetry()
            continue
          }
          if (!stale) break
          let reclaimed
          try {
            reclaimed = reclaimStaleGuard(lockPath, staleMs, token)
          } catch (reclaimError) {
            try {
              lstatSync(lockPath)
            } catch (pathError) {
              if (/** @type {any} */ (pathError).code === 'ENOENT') throw reclaimError
              throw pathError
            }
            if (Date.now() >= deadline) {
              throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
            }
            await waitForRetry()
            continue
          }
          if (!reclaimed) break
          if (Date.now() >= deadline) {
            throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
          }
          await delay(0)
        }
      }
    } catch (err) {
      try {
        await releaseLeaseGuard(candidateGuard)
      } catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'lock acquisition cleanup failed')
      }
      throw err
    }
    if (acquired && fd !== null) {
      guardLease = candidateGuard
      owned = true
      break
    }

    await releaseLeaseGuard(candidateGuard)

    if (Date.now() >= deadline) {
      throw new VaultError(`账本被其他进程占用（${lockPath}），等待 ${timeoutMs}ms 超时`)
    }
    await waitForRetry()
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
    throwIfAborted()
    result = await fn()
  } catch (err) {
    bodyFailed = true
    bodyError = err
  }
  clearInterval(heartbeat)
  owned = false

  /** @type {unknown} */
  let cleanupError
  const rememberCleanupError = (/** @type {unknown} */ err) => {
    if (cleanupError === undefined) cleanupError = err
  }
  if (fd !== null) {
    try {
      await retryCleanup(async () => { closeSync(fd) })
    } catch (err) {
      rememberCleanupError(err)
    }
  }
  try {
    await releaseLeasePath(lockPath, token, null, 'lock cleanup failed')
  } catch (err) {
    rememberCleanupError(err)
  }
  try {
    await retryCleanup(async () => {
      try { unlinkSync(tempLockPath) } catch (err) {
        if (/** @type {any} */ (err).code !== 'ENOENT') throw err
      }
    })
  } catch (err) {
    rememberCleanupError(err)
  }
  if (guardLease !== null) {
    try {
      await releaseLeaseGuard(guardLease)
    } catch (err) {
      rememberCleanupError(err)
    }
  }
  if (bodyFailed) {
    if (cleanupError !== undefined) {
      throw new AggregateError([bodyError, cleanupError], 'lock body and cleanup both failed')
    }
    throw bodyError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  return /** @type {T} */ (result)
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
