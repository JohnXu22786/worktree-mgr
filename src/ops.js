/**
 * 生命周期编排：任务工作区的 创建 / 同步 / 收尾 / 总览 / 批量清理。
 *
 * 所有写操作都在 vault 互斥锁内进行，保证账本与磁盘状态一致。
 * 每个公开函数返回 {ok: boolean, ...} 结构，错误通过 error 字段携带，
 * 不抛异常（调用方：dsh 工具层、CLI）。
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  slugifyTask,
  deriveBranch,
  validateBranch,
  validateTask,
} from './naming.js'
import { renderTemplate } from './config.js'
import {
  VaultError,
  canonicalizePath,
  computeVault,
  isWithin,
  loadLedger,
  saveLedger,
  withLock,
  findRecord,
  upsertRecord,
  removeRecord,
} from './vault.js'
import { parseWorktreeList, parseAheadBehind, isDirty, samePath } from './git.js'
import { calculateMergeTree, createMergeGuard, readMergeOptions } from './merge-guard.js'
import { runTriggers } from './triggers.js'

/**
 * 合并后的插件配置。
 * @typedef {object} PluginConfig
 * @property {string} prefix
 * @property {string | null} vault
 * @property {string} commitMessage
 * @property {string} mergeMessage
 * @property {string[]} warnings
 */

/**
 * 账本与记录类型（引用自 vault.js）。
 * @typedef {import('./vault.js').Ledger} Ledger
 * @typedef {import('./vault.js').LedgerRecord} LedgerRecord
 */

/**
 * 仓库级配置（<root>/.wtm.json 的解析结果）。
 * @typedef {object} RepoConfig
 * @property {string} [prefix]
 * @property {string} [vault]
 * @property {string} [commitMessage]
 * @property {string} [mergeMessage]
 * @property {{files?: string[]}} [seed]
 * @property {{on_begin?: string[], on_merge?: string[], on_finish?: string[]}} [triggers]
 */

/**
 * 操作公共参数。
 * @typedef {object} OpOpts
 * @property {string} root
 * @property {string} [task]
 * @property {string} [base]
 * @property {string} [branch]
 * @property {string} [note]
 * @property {string} [message]
 * @property {PluginConfig} cfg
 * @property {{run: Function}} git
 * @property {RepoConfig | null} [repo]
 * @property {AbortSignal} [signal]
 * @property {(shell: string, args: string[], opts: object) => object} [triggerSpawn]
 */

/**
 * 操作统一结果。
 * @typedef {object} OpResult
 * @property {boolean} ok
 * @property {boolean} [cancelled]
 * @property {string} [error]
 * @property {string} [note]
 * @property {string} [task]
 * @property {string} [branch]
 * @property {string} [base]
 * @property {string} [path]
 * @property {boolean} [committed]
 * @property {boolean} [merged]
 * @property {boolean} [removed]
 * @property {boolean} [branchDeleted]
 * @property {string[]} [warnings]
 * @property {Array<{task: string, branch: string, base: string, path: string, exists: boolean, branchDrift: boolean, currentBranch: string | null, dirty: boolean | null, counts: {ahead: number, behind: number} | null, updatedAt: string}>} [rows]
 * @property {Array<{task: string, ok: boolean, cancelled?: boolean, error?: string, note?: string, merged?: boolean, committed?: boolean, branchDeleted?: boolean, warnings?: string[]}>} [results]
 */

const MERGE_MODES = new Set(['commit', 'refuse'])
const FINISH_MODES = new Set(['commit', 'abandon', 'keep'])

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {AbortSignal | undefined} signal
 */
function isAborted(signal) {
  return signal?.aborted === true
}

function abortResult() {
  return { ok: false, cancelled: true, error: '操作已取消（aborted）' }
}

/**
 * @param {{cancelled?: boolean, cleanupConfirmed?: boolean, cleanupError?: string}} result
 * @param {AbortSignal | undefined} signal
 */
function triggerWasCancelled(result, signal) {
  return result.cancelled === true || isAborted(signal)
}

/**
 * @param {{cleanupConfirmed?: boolean, cleanupError?: string}} result
 * @param {string} stage
 */
function triggerCancellationError(result, stage) {
  if (result.cleanupConfirmed !== true) {
    return `操作已取消（aborted）；${stage}触发器清理未能确认${result.cleanupError ? `：${result.cleanupError}` : ''}`
  }
  return '操作已取消（aborted）'
}

/**
 * @param {{cleanupConfirmed?: boolean, cleanupError?: string}} result
 * @param {string} stage
 */
function triggerCancellationWarnings(result, stage) {
  if (result.cleanupConfirmed === true) return []
  return [`${stage}触发器清理未能确认：${result.cleanupError || '请检查仍运行的触发器进程'}`]
}

/**
 * 计算并规范化操作使用的 vault 路径，确保后续拼接子路径时不会改变文件系统语义。
 * @param {string} root
 * @param {PluginConfig} cfg
 * @returns {{vault: string} | {vault: null, error: string}}
 */
function resolveOperationVault(root, cfg) {
  const configuredVault = computeVault(root, cfg.vault)
  try {
    const vault = canonicalizePath(configuredVault)
    if (vault === null) {
      return { vault: null, error: `vault 路径无法解析（${configuredVault}）：存在符号链接循环` }
    }
    return { vault }
  } catch (err) {
    const error = /** @type {{code?: string, message?: string}} */ (err)
    return { vault: null, error: `vault 路径无法解析（${configuredVault}）：${error.code ?? error.message ?? String(err)}` }
  }
}

/**
 * Build manual recovery guidance without putting filesystem values into shell syntax.
 * JSON string notation keeps quotes and line breaks visible as data for inspection.
 * @param {string} wtPath
 * @param {string} branchName
 */
function manualCleanupHint(wtPath, branchName) {
  return '请手动检查 Git 工作区列表和分支列表。只有确认它们是本次操作遗留的资源后，才分别清理；' +
    '若无法确认归属，请保留并联系仓库管理员。' +
    `工作区路径（JSON 字符串）：${JSON.stringify(wtPath)}；分支（JSON 字符串）：${JSON.stringify(branchName)}`
}

/**
 * Roll back resources created by a successful worktree add, attempting each cleanup independently.
 * @param {{run: Function}} git
 * @param {string} root
 * @param {string} wtPath
 * @param {string} branchName
 * @returns {Promise<string[]>}
 */
async function rollbackCreatedWorktree(git, root, wtPath, branchName) {
  /** @type {string[]} */
  const warnings = []
  try {
    const remove = await git.run(['worktree', 'remove', '--force', wtPath], { cwd: root })
    if (!remove.ok) {
      warnings.push(`工作区回滚失败：${JSON.stringify(remove.stderr.trim() || '命令返回失败')}`)
    }
  } catch (err) {
    warnings.push(`工作区回滚失败：${JSON.stringify(/** @type {Error} */ (err).message)}`)
  }
  try {
    const branch = await git.run(['branch', '-D', branchName], { cwd: root })
    if (!branch.ok) {
      warnings.push(`分支回滚失败：${JSON.stringify(branch.stderr.trim() || '命令返回失败')}`)
    }
  } catch (err) {
    warnings.push(`分支回滚失败：${JSON.stringify(/** @type {Error} */ (err).message)}`)
  }
  if (warnings.length === 0) {
    warnings.push('已回滚未完成的工作区创建（工作区与分支已清理）')
  } else {
    warnings.unshift('工作区创建未完成，且回滚失败')
    warnings.push(manualCleanupHint(wtPath, branchName))
  }
  return warnings
}

/**
 * 检查工作区路径：只有明确的“不存在”才算 stale，其他文件系统错误必须保留给调用方处理。
 * @param {string} path
 * @returns {{exists: boolean, isDirectory?: boolean, error?: string}}
 */
function inspectPath(path) {
  try {
    return { exists: true, isDirectory: statSync(path).isDirectory() }
  } catch (err) {
    const error = /** @type {{code?: string, message?: string}} */ (err)
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false }
    return {
      exists: false,
      error: error.message || String(err),
    }
  }
}

/**
 * 创建任务工作区：派生分支 → 校验 → git worktree add → 种子文件 → 触发器 → 落账本。
 * @param {{root: string, task?: string, base?: string, branch?: string, note?: string,
 *          cfg: PluginConfig, git: {run: Function}, repo: RepoConfig | null,
 *          signal?: AbortSignal, triggerSpawn?: (shell: string, args: string[], opts: object) => object}} opts
 * @returns {Promise<OpResult>}
 */
export async function begin(opts) {
  const { root, cfg, git, repo } = opts
  if (isAborted(opts.signal)) return abortResult()
  const task = opts.task
  if (typeof task !== 'string' || task.trim() === '') {
    return { ok: false, error: '缺少任务名（task 参数）' }
  }

  // 边界 1：任务名校验（在任何 git 调用之前）
  const taskCheck = validateTask(task)
  if (!taskCheck.ok) return { ok: false, error: `任务名非法：${taskCheck.reason}` }

  // 边界 2：分支名（显式或派生）校验
  const branchName = opts.branch ?? deriveBranch(task, cfg.prefix)
  const branchCheck = validateBranch(branchName)
  if (!branchCheck.ok) return { ok: false, error: `分支名非法（${branchName}）：${branchCheck.reason}` }

  const vaultResult = resolveOperationVault(root, cfg)
  if (vaultResult.vault === null) return { ok: false, error: vaultResult.error }
  const vault = vaultResult.vault
  // 防护：vault 位于仓库工作树内会让主工作区持续处于未跟踪状态，
  // 进而阻塞后续合并（基分支脏检测）。直接拒绝并在报错中给出出路。
  if (isWithin(root, vault)) {
    return { ok: false, error: `vault 目录不能位于仓库工作树内（${vault}）：` +
      '请改用仓库外的路径，或将仓库配置的 vault 指向外部目录（WTM_VAULT / .wtm.json 的 vault 键）' }
  }
  const wtPath = join(vault, slugifyTask(task))
  /** @type {string[]} */
  const warnings = []
  let result
  let createdWorktree = false
  let addAttempted = false
  let triggerCleanupUncertain = false
  let cancellationRollbackUncertain = false
  try {
    result = await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      if (findRecord(ledger, task)) {
        return { ok: false, error: `任务“${task}”已存在，请先 finish 或使用其他任务名` }
      }

      // 基分支：默认当前分支
      const cur = await git.run(['branch', '--show-current'], { cwd: root, signal: opts.signal })
      if (cur.aborted || isAborted(opts.signal)) return abortResult()
      if (!cur.ok) return { ok: false, error: `读取当前分支失败：${cur.stderr.trim()}` }
      const baseName = opts.base ?? cur.stdout.trim()
      if (!baseName) {
        return { ok: false, error: '主工作区处于 detached HEAD 状态，请显式指定 base 分支' }
      }
      const baseRef = `refs/heads/${baseName}`
      const baseCheck = await git.run(['show-ref', '--verify', baseRef], { cwd: root, signal: opts.signal })
      if (baseCheck.aborted || isAborted(opts.signal)) return abortResult()
      if (!baseCheck.ok) {
        // 空仓库（无任何提交）时分支尚未诞生，show-ref 会失败——给出明确提示
        const headCheck = await git.run(['rev-parse', '--verify', 'HEAD'], { cwd: root, signal: opts.signal })
        if (headCheck.aborted || isAborted(opts.signal)) return abortResult()
        const hint = headCheck.ok ? '' : '（仓库尚无任何提交，请先创建首个提交）'
        return { ok: false, error: `基分支不存在：${baseName}${hint}` }
      }

      // 分支冲突：git 里已存在
      const existsCheck = await git.run(['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: root, signal: opts.signal })
      if (existsCheck.aborted || isAborted(opts.signal)) return abortResult()
      if (existsCheck.ok) return { ok: false, error: `分支已存在：${branchName}` }

      // 安全检查：主工作区状态不可读时不能继续；脏时新建工作区不会包含未提交改动
      const baseStatus = await git.run(['status', '--porcelain'], { cwd: root, signal: opts.signal })
      if (baseStatus.aborted || isAborted(opts.signal)) return abortResult()
      if (!baseStatus.ok) {
        return { ok: false, error: `读取主工作区状态失败：${baseStatus.stderr.trim() || 'git status 失败'}` }
      }
      if (isDirty(baseStatus.stdout)) {
        warnings.push('主工作区存在未提交改动，新建的工作区不会包含这些改动，请留意')
      }

      // 防碰撞：不同任务名可能派生同一 slug（如 "a b" 与 "a-b"），
      // 账本中已有记录指向同一工作区路径时拒绝
      if (ledger.records.some((rec) => samePath(rec.path, wtPath))) {
        return { ok: false, error: `已有任务使用工作区目录 ${wtPath}，请更换任务名` }
      }
      if (existsSync(wtPath)) {
        return { ok: false, error: `工作区目录已存在：${wtPath}` }
      }

      // 核心动作：创建 worktree
      addAttempted = true
      const add = await git.run(['worktree', 'add', wtPath, '-b', branchName, baseRef], { cwd: root, signal: opts.signal })
      if (!add.ok) {
        const addCancelled = add.aborted || isAborted(opts.signal)
        if (addCancelled) {
          // A killed `worktree add` can still have registered the worktree and
          // created its branch. Keep those identifiers in the ledger instead of
          // rolling them back or leaving them discoverable only by manual search.
          const afterInterruptedAdd = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root })
          const registered = afterInterruptedAdd.ok
            ? parseWorktreeList(afterInterruptedAdd.stdout).find((worktree) => samePath(worktree.path, wtPath))
            : undefined
          /** @type {LedgerRecord} */
          const recoveryRecord = {
            task,
            branch: branchName,
            base: baseName,
            path: wtPath,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          }
          if (opts.note) recoveryRecord.note = opts.note
          upsertRecord(ledger, recoveryRecord)
          saveLedger(vault, ledger)
          if (registered?.branch === branchName) {
            warnings.push(`worktree add 已取消，但 Git 已登记工作区和分支，恢复信息已写入账本；${manualCleanupHint(wtPath, branchName)}`)
          } else {
            warnings.push(`worktree add 已取消，Git 未能确认工作区和分支状态；待恢复任务、分支和路径已写入账本；${manualCleanupHint(wtPath, branchName)}`)
          }
        }
        warnings.push(`worktree add 失败，可能留下部分资源；${manualCleanupHint(wtPath, branchName)}`)
        return {
          ok: false,
          ...(addCancelled ? { cancelled: true } : {}),
          error: addCancelled
            ? '操作已取消（aborted）'
            : `创建工作区失败：${add.stderr.trim()}`,
        }
      }
      createdWorktree = true

      // 种子文件：从主仓库复制到新工作区（防路径穿越：必须位于仓库/工作区之内）
      const seedFiles = repo?.seed?.files
      if (Array.isArray(seedFiles)) {
        for (const f of seedFiles) {
          if (typeof f !== 'string' || f.trim() === '') continue
          // 用 resolve 而非 join：绝对路径输入（/abs/x）会被解析到仓库外，随后的越界检查会拦截
          const src = resolve(root, f)
          const dst = resolve(wtPath, f)
          if (!isWithin(root, src)) {
            warnings.push(`种子文件越界（${f}），已跳过`)
            continue
          }
          if (!isWithin(wtPath, dst)) {
            warnings.push(`种子目标越界（${f}），已跳过`)
            continue
          }
          if (!existsSync(src)) {
            warnings.push(`种子文件不存在，已跳过：${f}`)
            continue
          }
          try {
            mkdirSync(dirname(dst), { recursive: true })
            copyFileSync(src, dst)
          } catch (err) {
            warnings.push(`种子文件复制失败（${f}）：${/** @type {Error} */ (err).message}`)
          }
        }
      }

      /** @type {LedgerRecord} */
      const record = {
        task,
        branch: branchName,
        base: baseName,
        path: wtPath,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      if (opts.note) record.note = opts.note

      // on_begin 触发器（工作目录 = 新工作区）
      const triggerWarnings = await runTriggers(
        repo?.triggers?.on_begin,
        { task, branch: branchName, base: baseName, path: wtPath, root },
        { spawn: opts.triggerSpawn, cwd: wtPath, signal: opts.signal },
      )
      warnings.push(...triggerWarnings.warnings)
      if (triggerWasCancelled(triggerWarnings, opts.signal)) {
        if (triggerWarnings.cleanupConfirmed !== true) {
          triggerCleanupUncertain = true
          upsertRecord(ledger, record)
          saveLedger(vault, ledger)
          warnings.push(
            `on_begin 触发器清理未能确认，工作区与分支已保留并写入账本以便恢复；${manualCleanupHint(wtPath, branchName)}`,
          )
          return {
            ok: false,
            cancelled: true,
            error: triggerCancellationError(triggerWarnings, 'on_begin '),
            task,
            branch: branchName,
            base: baseName,
            path: wtPath,
          }
        }
        const rollbackWarnings = await rollbackCreatedWorktree(git, root, wtPath, branchName)
        warnings.push(...rollbackWarnings)
        if (rollbackWarnings.some((warning) => warning.startsWith('工作区创建未完成，且回滚失败'))) {
          cancellationRollbackUncertain = true
          upsertRecord(ledger, record)
          saveLedger(vault, ledger)
          warnings.push(
            `on_begin 触发器清理已确认，但资源回滚未能确认，工作区与分支已写入账本以便恢复；${manualCleanupHint(wtPath, branchName)}`,
          )
        }
        return {
          ok: false,
          cancelled: true,
          error: triggerCancellationError(triggerWarnings, 'on_begin '),
          task,
          branch: branchName,
          base: baseName,
          path: wtPath,
        }
      }
      upsertRecord(ledger, record)
      saveLedger(vault, ledger)
      return { ok: true, base: baseName, path: wtPath }
    }, { signal: opts.signal })
  } catch (err) {
    // worktree 已创建但后续步骤失败：回滚，避免留下孤儿工作区阻塞重试
    if (createdWorktree && typeof result === 'undefined' && !triggerCleanupUncertain && !cancellationRollbackUncertain) {
      warnings.push(...await rollbackCreatedWorktree(git, root, wtPath, branchName))
    } else if (triggerCleanupUncertain) {
      warnings.push(`on_begin 触发器清理未能确认，且恢复账本写入失败：${/** @type {Error} */ (err).message}；${manualCleanupHint(wtPath, branchName)}`)
    } else if (cancellationRollbackUncertain) {
      warnings.push(`on_begin 资源回滚失败，且恢复账本写入失败：${/** @type {Error} */ (err).message}；${manualCleanupHint(wtPath, branchName)}`)
    } else if (addAttempted && !createdWorktree) {
      warnings.push(`worktree add 未能确认是否完成，可能留下部分资源；${manualCleanupHint(wtPath, branchName)}`)
    }
    if (isAborted(opts.signal)) return { ok: false, cancelled: true, error: '操作已取消（aborted）', task, branch: branchName, path: wtPath, warnings }
    if (err instanceof VaultError) return { ok: false, error: err.message, warnings }
    return { ok: false, error: `创建失败：${/** @type {Error} */ (err).message}`, warnings }
  }
  if (!result.ok) {
    return warnings.length > 0 ? { ...result, warnings } : result
  }
  return {
    ok: true,
    task,
    branch: branchName,
    base: result.base ?? '',
    path: result.path ?? '',
    warnings,
  }
}

/**
 * 同步任务：把任务分支合并回基分支（工作区保留）。
 * @param {{root: string, task?: string, mode?: string, message?: string,
 *          cfg: PluginConfig, git: {run: Function}, repo: RepoConfig | null,
 *          signal?: AbortSignal, triggerSpawn?: (shell: string, args: string[], opts: object) => object}} opts
 * @returns {Promise<OpResult>}
 */
export async function mergeTask(opts) { // eslint-disable-line
  if (isAborted(opts.signal)) return abortResult()
  const task = opts.task
  if (typeof task !== 'string' || task.trim() === '') {
    return { ok: false, error: '缺少任务名（task 参数）' }
  }
  const mode = opts.mode ?? 'commit'
  if (!MERGE_MODES.has(mode)) return { ok: false, error: `未知 mode：${mode}（可选 commit / refuse）` }
  const { root, cfg, git, repo } = opts
  const vaultResult = resolveOperationVault(root, cfg)
  if (vaultResult.vault === null) return { ok: false, error: vaultResult.error }
  const vault = vaultResult.vault
  try {
    return await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      const rec = findRecord(ledger, task)
      if (!rec) return { ok: false, error: `任务不存在：${task}（可用 wtm_status 查看）` }
      const core = await syncCore(opts, { vault, ledger, rec, mode })
      if (!core.ok) return core
      return {
        ok: true,
        task,
        branch: rec.branch,
        base: rec.base,
        committed: core.committed,
        merged: core.merged,
        warnings: core.warnings,
      }
    }, { signal: opts.signal })
  } catch (err) {
    if (isAborted(opts.signal)) return abortResult()
    if (err instanceof VaultError) return { ok: false, error: err.message }
    return { ok: false, error: `同步失败：${/** @type {Error} */ (err).message}` }
  }
}

/**
 * 收尾任务：提交（可选）→ 合并（commit 模式）→ 移除工作区 → 删分支 → 清记录。
 * @param {{root: string, task?: string, mode?: string, message?: string,
 *          cfg: PluginConfig, git: {run: Function}, repo: RepoConfig | null,
 *          signal?: AbortSignal, triggerSpawn?: (shell: string, args: string[], opts: object) => object}} opts
 * @returns {Promise<OpResult>}
 */
export async function finishTask(opts) {
  if (isAborted(opts.signal)) return abortResult()
  const task = opts.task
  if (typeof task !== 'string' || task.trim() === '') {
    return { ok: false, error: '缺少任务名（task 参数）' }
  }
  const mode = opts.mode ?? 'commit'
  if (!FINISH_MODES.has(mode)) return { ok: false, error: `未知 mode：${mode}（可选 commit / abandon / keep）` }
  const { root, cfg, git, repo } = opts
  const vaultResult = resolveOperationVault(root, cfg)
  if (vaultResult.vault === null) return { ok: false, error: vaultResult.error }
  const vault = vaultResult.vault
  try {
    return await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      const rec = findRecord(ledger, task)
      if (!rec) return { ok: false, error: `任务不存在：${task}（可用 wtm_status 查看）` }
      return await finishCore(opts, { vault, ledger, rec, mode, restoreOnBranchDeleteFailure: true })
    }, { signal: opts.signal })
  } catch (err) {
    if (isAborted(opts.signal)) return abortResult()
    if (err instanceof VaultError) return { ok: false, error: err.message }
    return { ok: false, error: `收尾失败：${/** @type {Error} */ (err).message}` }
  }
}

/**
 * 任务总览：存在性、脏状态、领先/落后计数。
 * @param {{root: string, cfg: PluginConfig, git: {run: Function}, repo: RepoConfig | null, signal?: AbortSignal}} opts
 * @returns {Promise<OpResult>}
 */
export async function listStatus(opts) {
  if (isAborted(opts.signal)) return abortResult()
  const { root, cfg, git } = opts
  const vaultResult = resolveOperationVault(root, cfg)
  if (vaultResult.vault === null) return { ok: false, error: vaultResult.error }
  const vault = vaultResult.vault
  try {
    const ledger = loadLedger(vault)
    const wl = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal: opts.signal })
    if (wl.aborted || isAborted(opts.signal)) return abortResult()
    if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
    const worktrees = parseWorktreeList(wl.stdout)
    /** @type {string[]} */
    const warnings = []
    const rows = []
    for (const rec of ledger.records) {
      const wt = worktrees.find((w) => samePath(w.path, rec.path))
      let counts = null
      // 存在性 = 注册表有该工作区、目录实际存在且仍在账本分支上；
      // 分支漂移后不能读取或统计错误分支的状态。
      const pathState = wt ? inspectPath(rec.path) : { exists: false }
      const branchDrift = Boolean(wt) && pathState.exists && pathState.isDirectory === true && wt?.branch !== rec.branch
      const alive = Boolean(wt) && pathState.exists && pathState.isDirectory === true && !branchDrift
      /** @type {boolean | null} */
      let dirty = pathState.error ? null : false
      if (pathState.error) {
        warnings.push(`读取任务工作区失败（${rec.task}）：${pathState.error}`)
      }
      if (alive) {
        const st = await git.run(['status', '--porcelain'], { cwd: rec.path, signal: opts.signal })
        if (st.aborted || isAborted(opts.signal)) return abortResult()
        if (st.ok) {
          dirty = isDirty(st.stdout)
        } else {
          dirty = null
          warnings.push(`读取任务工作区状态失败（${rec.task}）：${st.stderr.trim() || 'git status 失败'}`)
        }
        const rc = await git.run(['rev-list', '--left-right', '--count', `refs/heads/${rec.base}...refs/heads/${rec.branch}`], { cwd: root, signal: opts.signal })
        if (rc.aborted || isAborted(opts.signal)) return abortResult()
        const parsedCounts = rc.ok ? parseAheadBehind(rc.stdout) : null
        if (parsedCounts) {
          counts = parsedCounts
        } else {
          const detail = rc.ok ? 'git rev-list 输出格式无效' : rc.stderr.trim() || 'git rev-list 失败'
          warnings.push(`读取任务领先/落后计数失败（${rec.task}）：${detail}`)
        }
      }
      rows.push({
        task: rec.task,
        branch: rec.branch,
        base: rec.base,
        path: rec.path,
        exists: alive,
        branchDrift,
        currentBranch: wt?.branch ?? null,
        dirty,
        counts,
        updatedAt: rec.updatedAt,
      })
    }
    if (isAborted(opts.signal)) return abortResult()
    return { ok: true, rows, warnings }
  } catch (err) {
    if (err instanceof VaultError) return { ok: false, error: err.message }
    return { ok: false, error: `总览失败：${/** @type {Error} */ (err).message}` }
  }
}

/**
 * 批量清理：对多个（或全部）任务逐个执行收尾，单个失败不中断。
 * @param {{root: string, tasks?: string[], all?: boolean, mode?: string, message?: string,
 *          cfg: PluginConfig, git: {run: Function}, repo: RepoConfig | null,
 *          signal?: AbortSignal, triggerSpawn?: (shell: string, args: string[], opts: object) => object}} opts
 * @returns {Promise<OpResult>}
 */
export async function purge(opts) {
  if (isAborted(opts.signal)) return abortResult()
  const tasks = Array.isArray(opts.tasks) ? opts.tasks.filter((t) => typeof t === 'string') : []
  if (opts.all && tasks.length > 0) {
    return { ok: false, error: 'all 与 tasks 不能同时指定，请二选一' }
  }
  if (!opts.all && tasks.length === 0) {
    return { ok: false, error: '请指定 tasks 列表或 all=true' }
  }
  const mode = opts.mode ?? 'commit'
  if (!FINISH_MODES.has(mode)) return { ok: false, error: `未知 mode：${mode}（可选 commit / abandon / keep）` }
  const { root, cfg, git, repo } = opts
  const vaultResult = resolveOperationVault(root, cfg)
  if (vaultResult.vault === null) return { ok: false, error: vaultResult.error }
  const vault = vaultResult.vault
  try {
    return await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      /** @type {Array<{rec: LedgerRecord | undefined, name: string}>} */
      const targets = opts.all
        ? ledger.records.map((rec) => ({ rec, name: rec.task }))
        : tasks.map((t) => ({ rec: findRecord(ledger, t), name: t }))
      const results = []
      for (const item of targets) {
        if (isAborted(opts.signal)) {
          return { ok: false, cancelled: true, error: '操作已取消（aborted）', results }
        }
        if (!item.rec) {
          results.push({ task: item.name, ok: false, error: '任务不存在' })
          continue
        }
        const r = await finishCore(opts, { vault, ledger, rec: item.rec, mode })
        results.push({
          task: item.rec.task,
          ok: r.ok,
          cancelled: r.cancelled,
          error: r.error,
          note: r.note,
          merged: r.merged,
          committed: r.committed,
          branchDeleted: r.branchDeleted,
          warnings: r.warnings,
        })
        if (r.cancelled || isAborted(opts.signal)) {
          return {
            ok: false,
            cancelled: true,
            error: r.error ?? '操作已取消（aborted）',
            results,
          }
        }
      }
      return { ok: true, results }
    }, { signal: opts.signal })
  } catch (err) {
    if (isAborted(opts.signal)) return abortResult()
    if (err instanceof VaultError) return { ok: false, error: err.message }
    return { ok: false, error: `批量清理失败：${/** @type {Error} */ (err).message}` }
  }
}

// ── 内部实现（均假定调用方已持有 vault 锁）────────────────────────────────────

/**
 * 快照提交：任务工作区脏时 add -A + commit。
 * @param {OpOpts} opts
 * @param {LedgerRecord} rec
 * @param {string} task
 * @param {string} [mode='commit']
 * @returns {Promise<{ok: boolean, committed: boolean, cancelled?: boolean, error?: string}>}
 */
async function snapshotCommit(opts, rec, task, mode = 'commit') {
  const { git, cfg } = opts
  const st = await git.run(['status', '--porcelain'], { cwd: rec.path, signal: opts.signal })
  if (st.aborted || isAborted(opts.signal)) return { ok: false, committed: false, cancelled: true, error: '操作已取消（aborted）' }
  if (!st.ok) return { ok: false, committed: false, error: `读取任务工作区状态失败：${st.stderr.trim()}` }
  if (!isDirty(st.stdout)) return { ok: true, committed: false }
  if (mode === 'refuse') {
    return { ok: false, committed: false, error: '任务工作区存在未提交改动，refuse 模式下拒绝合并（可改用 commit 模式自动快照）' }
  }
  const message = opts.message ?? renderTemplate(cfg.commitMessage, { task, branch: rec.branch, base: rec.base })
  const add = await git.run(['add', '-A'], { cwd: rec.path, signal: opts.signal })
  if (add.aborted || isAborted(opts.signal)) return { ok: false, committed: false, cancelled: true, error: '操作已取消（aborted）' }
  if (!add.ok) return { ok: false, committed: false, error: `git add 失败：${add.stderr.trim()}` }
  const commit = await git.run(['commit', '-m', message], { cwd: rec.path, signal: opts.signal })
  if (commit.aborted || isAborted(opts.signal)) return { ok: false, committed: false, cancelled: true, error: '操作已取消（aborted）' }
  if (!commit.ok) return { ok: false, committed: false, error: `快照提交失败：${commit.stderr.trim()}` }
  return { ok: true, committed: true }
}

/**
 * 合并回基分支：复验基工作区 → 安装 merge-time guard → merge --no-ff。
 * @param {OpOpts} opts
 * @param {LedgerRecord} rec
 * @param {string} task
 * @returns {Promise<{ok: boolean, merged: boolean, cancelled?: boolean, branchHead?: string, error?: string, warnings: string[]}>}
 */
async function mergeIntoBase(opts, rec, task) {
  const { root, git, cfg } = opts
  /** @returns {{ok: false, merged: false, cancelled: true, error: string, warnings: string[]}} */
  const cancelled = () => ({ ok: false, merged: false, cancelled: true, error: '操作已取消（aborted）', warnings: [] })

  const initialBaseCheck = await checkBaseState(opts, rec)
  if (!initialBaseCheck.ok) {
    return {
      ok: false,
      merged: false,
      ...(initialBaseCheck.cancelled ? { cancelled: true } : {}),
      error: initialBaseCheck.error,
      warnings: [],
    }
  }

  const initialMergeHead = await git.run(['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`], { cwd: root, signal: opts.signal })
  if (initialMergeHead.aborted || isAborted(opts.signal)) return cancelled()
  if (!initialMergeHead.ok || !initialMergeHead.stdout.trim()) {
    return {
      ok: false,
      merged: false,
      error: `读取任务分支尖端失败：${initialMergeHead.stderr.trim() || 'git rev-parse 失败'}`,
      warnings: [],
    }
  }
  const initialBranchHead = initialMergeHead.stdout.trim()

  // 已合并检测：分支尖端已是基分支祖先时跳过合并（重试场景不再制造空 merge 提交）
  const ancestor = await git.run(['merge-base', '--is-ancestor', `refs/heads/${rec.branch}`, 'HEAD'], { cwd: root, signal: opts.signal })
  if (ancestor.aborted || isAborted(opts.signal)) {
    return { ok: false, merged: false, cancelled: true, error: '操作已取消（aborted）', warnings: [] }
  }
  if (!ancestor.ok && ancestor.code !== 1) {
    return {
      ok: false,
      merged: false,
      error: `检查任务分支是否已合并失败：${ancestor.stderr.trim() || 'git merge-base 失败'}`,
      warnings: [],
    }
  }

  // Recheck after the asynchronous ancestor query; the user may have switched branches or edited the base meanwhile.
  const finalBaseCheck = await checkBaseState(opts, rec)
  if (!finalBaseCheck.ok) {
    return {
      ok: false,
      merged: false,
      ...(finalBaseCheck.cancelled ? { cancelled: true } : {}),
      error: finalBaseCheck.error,
      warnings: [],
    }
  }
  if (ancestor.ok) {
    const currentMergeHead = await git.run(['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`], { cwd: root, signal: opts.signal })
    if (currentMergeHead.aborted || isAborted(opts.signal)) return cancelled()
    if (!currentMergeHead.ok || !currentMergeHead.stdout.trim()) {
      return {
        ok: false,
        merged: false,
        error: `读取任务分支尖端失败：${currentMergeHead.stderr.trim() || 'git rev-parse 失败'}`,
        warnings: [],
      }
    }
    if (currentMergeHead.stdout.trim() !== initialBranchHead) {
      return {
        ok: false,
        merged: false,
        error: `检查任务分支是否已合并时尖端继续前进（检查前 ${initialBranchHead}，当前 ${currentMergeHead.stdout.trim()}），请重试`,
        warnings: [],
      }
    }
    return { ok: true, merged: false, branchHead: initialBranchHead, warnings: ['任务分支已包含在基分支中，跳过重复合并'] }
  }

  const mergeOptions = await readMergeOptions(root, git, opts.signal, rec.base)
  if (isAborted(opts.signal)) return cancelled()
  if (!mergeOptions.ok) {
    return { ok: false, merged: false, error: mergeOptions.error, warnings: [] }
  }
  const mergeHead = await git.run(['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`], { cwd: root, signal: opts.signal })
  if (mergeHead.aborted || isAborted(opts.signal)) return cancelled()
  if (!mergeHead.ok) {
    return {
      ok: false,
      merged: false,
      error: `读取任务分支尖端失败：${mergeHead.stderr.trim() || 'git rev-parse 失败'}`,
      warnings: [],
    }
  }
  const expectedMergeHead = mergeHead.stdout.trim()
  if (!expectedMergeHead) {
    return { ok: false, merged: false, error: '任务分支没有有效的 commit 尖端', warnings: [] }
  }

  const baseHead = await git.run(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, signal: opts.signal })
  if (baseHead.aborted || isAborted(opts.signal)) return cancelled()
  if (!baseHead.ok || !baseHead.stdout.trim()) {
    return {
      ok: false,
      merged: false,
      error: `读取基分支尖端失败：${baseHead.stderr.trim() || 'git rev-parse 失败'}`,
      warnings: [],
    }
  }
  const expectedBaseHead = baseHead.stdout.trim()
  const expectedTree = await calculateMergeTree(root, git, opts.signal, expectedBaseHead, expectedMergeHead, mergeOptions)
  if (isAborted(opts.signal)) return cancelled()
  if (!expectedTree.ok) {
    return { ok: false, merged: false, error: expectedTree.error, warnings: [] }
  }

  const message = opts.message ?? renderTemplate(cfg.mergeMessage, { task, branch: rec.branch, base: rec.base })
  let guard
  try {
    guard = await createMergeGuard(root, git, opts.signal, rec.base, {
      expectedTree: expectedTree.tree,
      expectedBaseHead,
      expectedMergeHead,
    })
  } catch (err) {
    if (isAborted(opts.signal)) return cancelled()
    return {
      ok: false,
      merged: false,
      error: `准备合并保护钩子失败：${/** @type {Error} */ (err).message}`,
      warnings: [],
    }
  }
  if (isAborted(opts.signal)) {
    rmSync(guard.hooksPath, { recursive: true, force: true })
    return cancelled()
  }

  try {
    const mergeArgs = ['-c', `core.hooksPath=${guard.hooksPath}`]
    if (mergeOptions.value !== null) mergeArgs.push('-c', `branch.${rec.base}.mergeOptions=${mergeOptions.value}`)
    mergeArgs.push('merge', '--no-ff', '--commit', `refs/heads/${rec.branch}`, '-m', message)
    const merge = await git.run(
      mergeArgs,
      {
        cwd: root,
        signal: opts.signal,
        env: {
          LC_ALL: 'C',
          LANG: 'C',
          WTM_EXPECTED_BASE: rec.base,
        },
      },
    )
    if (!merge.ok) {
      if (merge.aborted || isAborted(opts.signal)) {
        return { ok: false, merged: false, cancelled: true, error: '操作已取消（aborted）', warnings: [] }
      }
      return {
        ok: false,
        merged: false,
        error: `合并失败：${merge.stderr.trim()}。主工作区可能处于合并中状态，可用 git merge --abort 恢复后重试`,
        warnings: [],
      }
    }
    if (/^Already up to date\.?$/m.test(merge.stdout)) {
      return { ok: true, merged: false, branchHead: expectedMergeHead, warnings: ['任务分支已包含在基分支中，跳过重复合并'] }
    }
    return { ok: true, merged: true, branchHead: expectedMergeHead, warnings: [] }
  } finally {
    rmSync(guard.hooksPath, { recursive: true, force: true })
  }
}

/**
 * 校验当前主工作区仍位于账本基分支且没有未提交改动。
 * @param {OpOpts} opts
 * @param {LedgerRecord} rec
 * @returns {Promise<{ok: true} | {ok: false, error: string, cancelled?: boolean}>}
 */
async function checkBaseState(opts, rec) {
  const { root, git } = opts
  const cur = await git.run(['branch', '--show-current'], { cwd: root, signal: opts.signal })
  if (cur.aborted || isAborted(opts.signal)) return { ok: false, cancelled: true, error: '操作已取消（aborted）' }
  if (!cur.ok) return {
    ok: false,
    error: `读取主工作区分支失败：${cur.stderr.trim()}`,
  }

  const currentBase = cur.stdout.trim()
  if (currentBase !== rec.base) {
    const hint = currentBase ? `当前在 ${currentBase}` : '当前处于 detached HEAD'
    return {
      ok: false,
      error: `主工作区当前分支与任务基分支不一致（账本：${rec.base}，${hint}）。` +
        `请先在主工作区切回 ${rec.base} 再重试（git checkout ${rec.base}）`,
    }
  }

  const baseStatus = await git.run(['status', '--porcelain'], { cwd: root, signal: opts.signal })
  if (baseStatus.aborted || isAborted(opts.signal)) return { ok: false, cancelled: true, error: '操作已取消（aborted）' }
  if (!baseStatus.ok) return {
    ok: false,
    error: `读取基分支状态失败：${baseStatus.stderr.trim()}`,
  }
  if (isDirty(baseStatus.stdout)) {
    return { ok: false, error: '基分支工作区存在未提交改动，请先提交或暂存（防止合并混入未完成的工作）' }
  }

  return { ok: true }
}

/**
 * 同步核心（mergeTask 与 finishTask 共用）：快照 + 合并 + 更新账本。
 * @param {OpOpts} opts
 * @param {{vault: string, ledger: Ledger, rec: LedgerRecord, mode: string}} box
 * @returns {Promise<{ok: boolean, cancelled?: boolean, error?: string, committed?: boolean, merged?: boolean, warnings?: string[]}>}
 */
async function syncCore(opts, { vault, ledger, rec, mode }) {
  const { root, git, repo } = opts
  const task = rec.task
  const wl = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal: opts.signal })
  if (wl.aborted || isAborted(opts.signal)) return abortResult()
  if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
  const worktrees = parseWorktreeList(wl.stdout)
  const wt = worktrees.find((w) => samePath(w.path, rec.path))
  // stale：注册表没有该工作区，或目录已被外部删除
  // （目录被删后注册表仍会列出 prunable 条目，必须用目录实存判定）
  if (!wt) {
    return { ok: false, error: `任务工作区已不存在（${rec.path}），可运行 wtm_purge 清理记录` }
  }
  const pathState = inspectPath(rec.path)
  if (pathState.error) {
    return { ok: false, error: `读取任务工作区失败（${rec.path}）：${pathState.error}` }
  }
  if (!pathState.exists) {
    return { ok: false, error: `任务工作区已不存在（${rec.path}），可运行 wtm_purge 清理记录` }
  }
  if (pathState.isDirectory !== true) {
    return { ok: false, error: `任务工作区路径不是目录（${rec.path}），请恢复该路径后重试` }
  }

  /** @type {string[]} */
  const warnings = []
  // 任务工作区当前分支必须与账本记录一致：
  // 否则快照提交会落在错误分支，而合并仍报告成功（静默丢失改动）
  const branchCheck = checkWorktreeBranch(wt, rec)
  if (!branchCheck.ok) return { ok: false, error: branchCheck.error }

  // 1) 脏检查 + 快照提交（refuse 模式直接拒绝）
  if (mode === 'refuse') {
    const st = await git.run(['status', '--porcelain'], { cwd: rec.path, signal: opts.signal })
    if (st.aborted || isAborted(opts.signal)) return abortResult()
    if (st.ok && isDirty(st.stdout)) {
      return { ok: false, error: '任务工作区存在未提交改动，refuse 模式下拒绝合并（可改用 commit 模式自动快照）' }
    }
  }
  const snap = await snapshotCommit(opts, rec, task, mode)
  if (!snap.ok) return { ok: false, ...(snap.cancelled ? { cancelled: true } : {}), error: snap.error }

  // 2) 合并回基分支
  const merged = await mergeIntoBase(opts, rec, task)
  if (!merged.ok) return { ok: false, cancelled: merged.cancelled, error: merged.error }
  warnings.push(...merged.warnings)
  if (isAborted(opts.signal)) {
    return {
      ok: false,
      cancelled: true,
      error: '操作已取消（aborted）',
      committed: snap.committed,
      merged: merged.merged,
      warnings,
    }
  }

  // 3) on_merge 触发器（工作目录 = 主仓库）
  if (merged.merged) {
    const triggerWarnings = await runTriggers(
      repo?.triggers?.on_merge,
      { task, branch: rec.branch, base: rec.base, path: rec.path, root },
      { spawn: opts.triggerSpawn, cwd: root, signal: opts.signal },
    )
    warnings.push(...triggerWarnings.warnings)
    if (triggerWasCancelled(triggerWarnings, opts.signal)) {
      warnings.push(...triggerCancellationWarnings(triggerWarnings, 'on_merge '))
      return {
        ok: false,
        cancelled: true,
        error: triggerCancellationError(triggerWarnings, 'on_merge '),
        committed: snap.committed,
        merged: merged.merged,
        warnings,
      }
    }
  }

  // 4) 更新账本时间戳
  rec.updatedAt = nowIso()
  upsertRecord(ledger, rec)
  saveLedger(vault, ledger)
  return { ok: true, committed: snap.committed, merged: merged.merged, warnings }
}

/**
 * 校验任务工作区当前分支与账本记录一致。
 * 不一致时快照提交会落在错误分支，而合并仍报告成功——必须拒绝。
 * @param {{path: string, branch: string | null}} wt
 * @param {LedgerRecord} rec
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkWorktreeBranch(wt, rec) {
  if (!wt.branch || wt.branch !== rec.branch) {
    const hint = wt.branch ? `当前在 ${wt.branch}` : '当前处于 detached HEAD'
    return {
      ok: false,
      error: `任务工作区分支与账本记录不一致（账本：${rec.branch}，${hint}）。` +
        '为避免改动被提交到错误分支，已拒绝执行。可先在工作区切回记录分支，或用 wtm_finish --mode keep 解除管理后手动处理。',
    }
  }
  return { ok: true }
}

/**
 * 收尾核心：同步（commit 模式）→ 移除工作区 → 删分支 → 清记录。
 * 前提：调用方已持有 vault 锁。
 * @param {OpOpts} opts
 * @param {{vault: string, ledger: Ledger, rec: LedgerRecord, mode: string, restoreOnBranchDeleteFailure?: boolean}} box
 * @returns {Promise<OpResult>}
 */
async function finishCore(opts, { vault, ledger, rec, mode, restoreOnBranchDeleteFailure = false }) {
  const { root, git, repo } = opts
  const task = rec.task
  /** @type {string[]} */
  const warnings = []
  /**
   * @param {string} cause
   * @param {boolean} [cancelled]
   */
  const preserveAfterBranchDrift = async (cause, cancelled = isAborted(opts.signal)) => {
    upsertRecord(ledger, rec)
    saveLedger(vault, ledger)
    const restore = await git.run(
      ['worktree', 'add', rec.path, rec.branch],
      { cwd: root, ...(cancelled ? {} : { signal: opts.signal }) },
    )
    const restoreCancelled = cancelled || restore.aborted === true || isAborted(opts.signal)
    return {
      ok: false,
      ...(restoreCancelled ? { cancelled: true } : {}),
      error: `${restoreCancelled ? '操作已取消（aborted）；' : ''}${cause}，分支删除失败（${rec.branch}）；` +
        (restore.ok
          ? '工作区已恢复，账本记录已保留，请同步新提交后重试'
          : `工作区恢复失败：${restore.stderr.trim() || 'git worktree add 失败'}；账本记录已保留，请手动恢复工作区`),
      warnings,
    }
  }

  // 工作区已消失（stale：注册表缺失或目录被外部删除）：直接清记录
  const wl = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal: opts.signal })
  if (wl.aborted || isAborted(opts.signal)) return abortResult()
  if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
  const worktrees = parseWorktreeList(wl.stdout)
  const wt = worktrees.find((w) => samePath(w.path, rec.path))
  if (!wt) {
    removeRecord(ledger, task)
    saveLedger(vault, ledger)
    return { ok: true, note: `任务工作区已不存在，已清理账本记录（任务：${task}）`, committed: false, merged: false }
  }
  const pathState = inspectPath(rec.path)
  if (pathState.error) {
    return { ok: false, error: `读取任务工作区失败（${rec.path}）：${pathState.error}` }
  }
  if (!pathState.exists) {
    removeRecord(ledger, task)
    saveLedger(vault, ledger)
    return { ok: true, note: `任务工作区已不存在，已清理账本记录（任务：${task}）`, committed: false, merged: false }
  }

  if (pathState.isDirectory !== true) {
    return { ok: false, error: `任务工作区路径不是目录（${rec.path}），请恢复该路径后重试` }
  }

  // keep：仅解除管理
  if (mode === 'keep') {
    removeRecord(ledger, task)
    saveLedger(vault, ledger)
    return { ok: true, note: `任务“${task}”已解除管理，工作区与分支保留`, committed: false, merged: false }
  }

  // commit 与 abandon 都会移除工作区和处理任务分支，必须先确认当前工作区
  // 仍是账本记录的分支，避免误删被切换到该目录的其他工作区或分支。
  const branchCheck = checkWorktreeBranch(wt, rec)
  if (!branchCheck.ok) return { ok: false, error: branchCheck.error }

  /** @type {string | undefined} */
  let abandonWorktreeState
  /** @type {string | undefined} */
  let abandonWorktreePath
  /** @type {string | undefined} */
  let abandonHeadLockPath
  /** @type {boolean} */
  let abandonLedgerPathPersisted = false
  const originalWorktreePath = rec.path
  const restoreAbandonWorktree = async () => {
    if (abandonHeadLockPath) {
      rmSync(abandonHeadLockPath, { force: true })
      abandonHeadLockPath = undefined
    }
    const restore = await git.run(['worktree', 'move', rec.path, originalWorktreePath], { cwd: root })
    if (!restore.ok) {
      upsertRecord(ledger, rec)
      try {
        saveLedger(vault, ledger)
        abandonLedgerPathPersisted = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `恢复原工作区路径失败：${restore.stderr.trim() || 'git worktree move 失败'}；更新账本失败：${message}` }
      }
      return { ok: false, error: `恢复原工作区路径失败：${restore.stderr.trim() || 'git worktree move 失败'}` }
    }
    rec.path = originalWorktreePath
    upsertRecord(ledger, rec)
    if (abandonLedgerPathPersisted) {
      try {
        saveLedger(vault, ledger)
        abandonLedgerPathPersisted = false
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `工作区已恢复原路径，但恢复账本记录失败：${message}` }
      }
    }
    return { ok: true }
  }
  /**
   * @param {string} cause
   * @param {boolean} [cancelled]
   * @returns {Promise<OpResult>}
   */
  const rejectAfterWorktreeRecheck = async (cause, cancelled = false) => {
    if (mode !== 'abandon' || !abandonWorktreePath) {
      return { ok: false, ...(cancelled ? { cancelled: true } : {}), error: `${cancelled ? '操作已取消（aborted）；' : ''}${cause}`, warnings }
    }
    const restore = await restoreAbandonWorktree()
    const restoreCancelled = cancelled || isAborted(opts.signal)
    return {
      ok: false,
      ...(restoreCancelled ? { cancelled: true } : {}),
      error: `${restoreCancelled ? '操作已取消（aborted）；' : ''}${cause}；${restore.ok ? '工作区与账本记录已恢复' : restore.error}`,
      warnings,
    }
  }
  if (mode === 'abandon') {
    const state = await git.run(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], {
      cwd: rec.path,
      signal: opts.signal,
    })
    if (state.aborted || isAborted(opts.signal)) return abortResult()
    if (!state.ok) {
      return { ok: false, error: `检查任务工作区状态失败：${state.stderr.trim() || 'git status 失败'}；已保留工作区与账本记录` }
    }
    const currentBranch = /^# branch\.head (.+)$/m.exec(state.stdout)?.[1]
    if (currentBranch !== rec.branch) {
      const hint = currentBranch ? `当前在 ${currentBranch}` : '当前处于 detached HEAD'
      return {
        ok: false,
        error: `任务工作区分支与账本记录不一致（账本：${rec.branch}，${hint}）；已保留工作区与账本记录`,
      }
    }
    abandonWorktreeState = state.stdout
  }

  let committed = false
  let merged = false
  /** @type {string | undefined} */
  let mergedBranchHead
  if (mode === 'commit') {
    // 快照提交 + 合并（abandon 模式两者都跳过）
    const snap = await snapshotCommit(opts, rec, task)
    if (!snap.ok) return { ok: false, ...(snap.cancelled ? { cancelled: true } : {}), error: snap.error, warnings }
    committed = snap.committed
    const m = await mergeIntoBase(opts, rec, task)
    if (!m.ok) return { ok: false, cancelled: m.cancelled, error: m.error, warnings }
    merged = m.merged
    mergedBranchHead = m.branchHead
    warnings.push(...m.warnings)
    if (restoreOnBranchDeleteFailure) {
      const currentBranchHead = await git.run(['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`], { cwd: root, signal: opts.signal })
      if (currentBranchHead.aborted || isAborted(opts.signal)) return { ok: false, cancelled: true, error: '操作已取消（aborted）', warnings }
      if (!currentBranchHead.ok || !currentBranchHead.stdout.trim()) {
        return {
          ok: false,
          error: `合并后读取任务分支尖端失败：${currentBranchHead.stderr.trim() || 'git rev-parse 失败'}；已保留工作区与账本记录`,
          warnings,
        }
      }
      if (currentBranchHead.stdout.trim() !== mergedBranchHead) {
        return {
          ok: false,
          error: `任务分支在合并后继续前进（已合并 ${mergedBranchHead}，当前 ${currentBranchHead.stdout.trim()}）；已保留工作区与账本记录，请同步新提交后重试`,
          warnings,
        }
      }
    }
    if (m.merged) {
      const mergeTriggerWarnings = await runTriggers(
        repo?.triggers?.on_merge,
        { task, branch: rec.branch, base: rec.base, path: rec.path, root },
        { spawn: opts.triggerSpawn, cwd: root, signal: opts.signal },
      )
      warnings.push(...mergeTriggerWarnings.warnings)
      if (triggerWasCancelled(mergeTriggerWarnings, opts.signal)) {
        warnings.push(...triggerCancellationWarnings(mergeTriggerWarnings, 'on_merge '))
        return {
          ok: false,
          cancelled: true,
          error: triggerCancellationError(mergeTriggerWarnings, 'on_merge '),
          task,
          committed,
          merged,
          warnings,
        }
      }
    }
  }

  // abandon 先把工作区移到临时路径，再锁住 Git 的 HEAD 更新，避免分支切换越过最终检查。
  // 状态变化时先恢复路径和账本，不触发强制删除。
  if (mode === 'abandon') {
    abandonWorktreePath = join(dirname(rec.path), `.${basename(rec.path)}.abandon-pending`)
    // Finish this path transition even if cancellation arrives mid-command; later checks can roll it back safely.
    const move = await git.run(['worktree', 'move', rec.path, abandonWorktreePath], { cwd: root })
    if (!move.ok) {
      const moveCancelled = move.aborted || isAborted(opts.signal)
      return {
        ok: false,
        ...(moveCancelled ? { cancelled: true } : {}),
        error: `${moveCancelled ? '操作已取消（aborted）；' : ''}隔离任务工作区失败：${move.stderr.trim() || 'git worktree move 失败'}；已保留工作区与账本记录`,
        warnings,
      }
    }
    rec.path = abandonWorktreePath

    const gitDir = await git.run(['rev-parse', '--absolute-git-dir'], { cwd: rec.path, signal: opts.signal })
    const gitDirCancelled = gitDir.aborted || isAborted(opts.signal)
    if (gitDirCancelled || !gitDir.ok || !gitDir.stdout.trim()) {
      const cause = gitDirCancelled
        ? '操作已取消（aborted）'
        : `读取隔离工作区 Git 目录失败：${gitDir.stderr.trim() || 'git rev-parse 失败'}`
      const restore = await restoreAbandonWorktree()
      return {
        ok: false,
        ...(gitDirCancelled ? { cancelled: true } : {}),
        error: `${cause}；${restore.ok ? '工作区与账本记录已恢复' : restore.error}`,
        warnings,
      }
    }
    const headLockPath = join(gitDir.stdout.trim(), 'HEAD.lock')
    /** @type {number | undefined} */
    let headLockFd
    try {
      headLockFd = openSync(headLockPath, 'wx')
      abandonHeadLockPath = headLockPath
      closeSync(headLockFd)
      headLockFd = undefined
    } catch (error) {
      if (headLockFd !== undefined) {
        try { closeSync(headLockFd) } catch { /* lock path cleanup below is authoritative */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      const restore = await restoreAbandonWorktree()
      return {
        ok: false,
        error: `锁定任务工作区分支失败：${message}；${restore.ok ? '工作区与账本记录已恢复' : restore.error}`,
        warnings,
      }
    }

    const state = await git.run(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], {
      cwd: rec.path,
      signal: opts.signal,
    })
    const stateCancelled = state.aborted || isAborted(opts.signal)
    if (stateCancelled || !state.ok || state.stdout !== abandonWorktreeState) {
      const cause = stateCancelled
        ? '操作已取消（aborted）'
        : state.ok
        ? '任务工作区在检查后发生变化，已拒绝强制移除'
        : `隔离后检查任务工作区状态失败：${state.stderr.trim() || 'git status 失败'}`
      const restore = await restoreAbandonWorktree()
      if (restore.ok) {
        return { ok: false, ...(stateCancelled ? { cancelled: true } : {}), error: `${cause}；工作区与账本记录已恢复，请检查后重试`, warnings }
      }
      return {
        ok: false,
        ...(stateCancelled ? { cancelled: true } : {}),
        error: `${cause}；工作区与账本记录保留在 ${rec.path}，${restore.error}`,
        warnings,
      }
    }
    upsertRecord(ledger, rec)
    try {
      saveLedger(vault, ledger)
      abandonLedgerPathPersisted = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const restore = await restoreAbandonWorktree()
      return {
        ok: false,
        error: `记录隔离工作区路径失败：${message}；${restore.ok ? '工作区与账本记录已恢复' : restore.error}`,
        warnings,
      }
    }
  }

  // Commit and merge hooks can change the task worktree after the initial
  // validation. Bind removal to the same registered path and branch immediately
  // before cleanup; abandon restores its staged path if this check fails.
  const latestWorktrees = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal: opts.signal })
  if (latestWorktrees.aborted || isAborted(opts.signal)) {
    return rejectAfterWorktreeRecheck(
      `读取收尾前 worktree 列表失败：${latestWorktrees.stderr.trim() || '取消期间未完成复验'}`,
      true,
    )
  }
  if (!latestWorktrees.ok) {
    return rejectAfterWorktreeRecheck(`读取收尾前 worktree 列表失败：${latestWorktrees.stderr.trim()}`)
  }
  const latestWorktree = parseWorktreeList(latestWorktrees.stdout).find((w) => samePath(w.path, rec.path))
  if (!latestWorktree) {
    return rejectAfterWorktreeRecheck(`任务工作区在收尾前已不存在（${rec.path}），已拒绝清理`)
  }
  const latestBranchCheck = checkWorktreeBranch(latestWorktree, rec)
  if (!latestBranchCheck.ok) return rejectAfterWorktreeRecheck(latestBranchCheck.error)

  // 移除工作区：commit 用安全移除，abandon 用 --force
  const removeArgs = mode === 'abandon'
    ? ['worktree', 'remove', '--force', abandonWorktreePath ?? rec.path]
    : ['worktree', 'remove', rec.path]
  const remove = await git.run(removeArgs, mode === 'abandon' ? { cwd: root } : { cwd: root, signal: opts.signal })
  const removeCancelled = remove.aborted || isAborted(opts.signal)
  if (removeCancelled && !remove.ok && mode !== 'abandon') {
    return {
      ok: false,
      cancelled: true,
      error: `操作已取消（aborted）；移除工作区未能确认完成：${remove.stderr.trim() || '已保留账本记录以便恢复'}`,
      warnings,
    }
  }
  if (!remove.ok) {
    if (mode === 'abandon' && abandonWorktreePath) {
      const restore = await restoreAbandonWorktree()
      if (restore.ok) {
        return {
          ok: false,
          ...(removeCancelled ? { cancelled: true } : {}),
          error: `${removeCancelled ? '操作已取消（aborted）；' : ''}移除工作区失败：${remove.stderr.trim()}；工作区与账本记录已恢复原路径`,
          warnings,
        }
      }
      return {
        ok: false,
        ...(removeCancelled ? { cancelled: true } : {}),
        error: `${removeCancelled ? '操作已取消（aborted）；' : ''}移除工作区失败：${remove.stderr.trim()}；工作区与账本记录保留在 ${abandonWorktreePath}，${restore.error}`,
        warnings,
      }
    }
    return {
      ok: false,
      error: `移除工作区失败：${remove.stderr.trim()}（如存在未跟踪文件，可改用 abandon 模式强制清理）`,
      warnings,
    }
  }
  if (abandonHeadLockPath) {
    rmSync(abandonHeadLockPath, { force: true })
    abandonHeadLockPath = undefined
  }
  rec.path = originalWorktreePath

  // Finish commit 条件删除合并时的 OID，避免误删前进后的尖端。
  // update-ref 不检查其他工作区是否检出该分支，因此先刷新列表核对。
  // Purge 保留原有 -d 行为；abandon 仍使用 -D。
  const delArgs = mode === 'abandon'
    ? ['branch', '-D', rec.branch]
    : mode === 'commit' && restoreOnBranchDeleteFailure && mergedBranchHead
      ? ['update-ref', '-d', `refs/heads/${rec.branch}`, mergedBranchHead]
      : ['branch', '-d', rec.branch]
  let del
  if (mode === 'commit' && restoreOnBranchDeleteFailure && mergedBranchHead) {
    const remainingWorktrees = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal: opts.signal })
    const otherWorktree = remainingWorktrees.ok
      ? parseWorktreeList(remainingWorktrees.stdout).find((other) => !samePath(other.path, rec.path) && other.branch === rec.branch)
      : undefined
    if (!remainingWorktrees.ok) {
      del = { ok: false, code: remainingWorktrees.code, stdout: '', stderr: `读取 worktree 列表失败：${remainingWorktrees.stderr.trim()}` }
    } else if (otherWorktree) {
      del = { ok: false, code: 1, stdout: '', stderr: `分支仍在其他工作区检出：${otherWorktree.path}` }
    } else {
      del = await git.run(delArgs, { cwd: root, signal: opts.signal })
    }
  } else {
    del = await git.run(delArgs, { cwd: root, signal: opts.signal })
  }
  let branchDeleted = del.ok
  if (!del.ok) {
    if (mode === 'commit' && restoreOnBranchDeleteFailure) {
      // Worktree removal has succeeded, so complete this read-only safety check
      // even if cancellation arrived during removal. An aborted read cannot
      // distinguish branch drift from cancellation and would restore stale state.
      const currentBranchHead = await git.run(['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`], { cwd: root })
      if (!currentBranchHead.ok || !currentBranchHead.stdout.trim() || currentBranchHead.stdout.trim() !== mergedBranchHead) {
        const cause = currentBranchHead.ok && currentBranchHead.stdout.trim()
          ? `任务分支在合并后继续前进（已合并 ${mergedBranchHead}，当前 ${currentBranchHead.stdout.trim()}）`
          : `合并后读取任务分支尖端失败：${currentBranchHead.stderr.trim() || 'git rev-parse 失败'}`
        return preserveAfterBranchDrift(cause)
      }
    }
    warnings.push(`分支删除失败（${rec.branch}）：${del.stderr.trim()}`)
  }

  // on_finish 触发器（工作目录 = 主仓库；注意此时任务工作区已移除）
  const triggerWarnings = await runTriggers(
    repo?.triggers?.on_finish,
    { task, branch: rec.branch, base: rec.base, path: rec.path, root },
    { spawn: opts.triggerSpawn, cwd: root, signal: opts.signal },
  )
  warnings.push(...triggerWarnings.warnings)
  let finishCancelled = triggerWasCancelled(triggerWarnings, opts.signal)
  let finishCancellationWarningsAdded = false
  const addFinishCancellationWarnings = () => {
    if (finishCancellationWarningsAdded) return
    warnings.push(...triggerCancellationWarnings(triggerWarnings, 'on_finish '))
    finishCancellationWarningsAdded = true
  }
  if (finishCancelled) addFinishCancellationWarnings()

  if (mode === 'commit' && restoreOnBranchDeleteFailure && !branchDeleted && mergedBranchHead) {
    const currentBranchHead = await git.run(
      ['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`],
      { cwd: root, ...(finishCancelled ? {} : { signal: opts.signal }) },
    )
    const branchCheckCancelled = currentBranchHead.aborted === true || isAborted(opts.signal)
    finishCancelled ||= branchCheckCancelled
    if (branchCheckCancelled) addFinishCancellationWarnings()
    if (currentBranchHead.aborted || !currentBranchHead.ok || !currentBranchHead.stdout.trim() || currentBranchHead.stdout.trim() !== mergedBranchHead) {
      const cause = currentBranchHead.aborted
        ? '取消时未能复验任务分支尖端'
        : currentBranchHead.ok && currentBranchHead.stdout.trim()
        ? `任务分支在合并后继续前进（已合并 ${mergedBranchHead}，当前 ${currentBranchHead.stdout.trim()}）`
        : `合并后读取任务分支尖端失败：${currentBranchHead.stderr.trim() || 'git rev-parse 失败'}`
      return preserveAfterBranchDrift(cause, finishCancelled)
    }
  }

  removeRecord(ledger, task)
  saveLedger(vault, ledger)
  if (mode === 'commit' && restoreOnBranchDeleteFailure && !branchDeleted && mergedBranchHead) {
    const finalBranchHead = await git.run(
      ['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`],
      { cwd: root, ...(finishCancelled ? {} : { signal: opts.signal }) },
    )
    const finalBranchCheckCancelled = finalBranchHead.aborted === true || isAborted(opts.signal)
    finishCancelled ||= finalBranchCheckCancelled
    if (finalBranchCheckCancelled) addFinishCancellationWarnings()
    if (finalBranchHead.aborted || !finalBranchHead.ok || !finalBranchHead.stdout.trim() || finalBranchHead.stdout.trim() !== mergedBranchHead) {
      const cause = finalBranchHead.aborted
        ? '取消时未能完成最终任务分支尖端复验'
        : finalBranchHead.ok && finalBranchHead.stdout.trim()
        ? `任务分支在合并后继续前进（已合并 ${mergedBranchHead}，当前 ${finalBranchHead.stdout.trim()}）`
        : `合并后读取任务分支尖端失败：${finalBranchHead.stderr.trim() || 'git rev-parse 失败'}`
      return preserveAfterBranchDrift(cause, finishCancelled)
    }
  }
  if (finishCancelled) {
    return {
      ok: false,
      cancelled: true,
      error: triggerCancellationError(triggerWarnings, 'on_finish '),
      task,
      committed,
      merged,
      removed: true,
      branchDeleted,
      warnings,
    }
  }
  return {
    ok: true,
    task,
    committed,
    merged,
    removed: true,
    branchDeleted,
    warnings,
  }
}
