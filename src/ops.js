/**
 * 生命周期编排：任务工作区的 创建 / 同步 / 收尾 / 总览 / 批量清理。
 *
 * 所有写操作都在 vault 互斥锁内进行，保证账本与磁盘状态一致。
 * 每个公开函数返回 {ok: boolean, ...} 结构，错误通过 error 字段携带，
 * 不抛异常（调用方：dsh 工具层、CLI）。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  slugifyTask,
  deriveBranch,
  validateBranch,
  validateTask,
} from './naming.js'
import { renderTemplate } from './config.js'
import {
  VaultError,
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
 * @property {Array<{task: string, branch: string, base: string, path: string, exists: boolean, dirty: boolean, counts: {ahead: number, behind: number} | null, updatedAt: string}>} [rows]
 * @property {Array<{task: string, ok: boolean, error?: string, note?: string, merged?: boolean, committed?: boolean}>} [results]
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
  return { ok: false, error: '操作已取消（aborted）' }
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

  const vault = computeVault(root, cfg.vault)
  // 防护：vault 位于仓库工作树内会让主工作区持续处于未跟踪状态，
  // 进而阻塞后续合并（基分支脏检测）。直接拒绝并在报错中给出出路。
  if (isWithin(root, vault)) {
    return { ok: false, error: `vault 目录不能位于仓库工作树内（${vault}）：` +
      '请改用仓库外的路径，或将仓库配置的 vault 指向外部目录（WTM_VAULT / .wtm.json 的 vault 键）' }
  }
  /** @type {string[]} */
  const warnings = []
  let result
  let createdWorktree = false
  try {
    result = await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      if (findRecord(ledger, task)) {
        return { ok: false, error: `任务“${task}”已存在，请先 finish 或使用其他任务名` }
      }

      // 基分支：默认当前分支
      const cur = await git.run(['branch', '--show-current'], { cwd: root, signal: opts.signal })
      if (!cur.ok) return { ok: false, error: `读取当前分支失败：${cur.stderr.trim()}` }
      const baseName = opts.base ?? cur.stdout.trim()
      if (!baseName) {
        return { ok: false, error: '主工作区处于 detached HEAD 状态，请显式指定 base 分支' }
      }
      const baseCheck = await git.run(['rev-parse', '--verify', `refs/heads/${baseName}`], { cwd: root, signal: opts.signal })
      if (!baseCheck.ok) {
        // 空仓库（无任何提交）时分支尚未诞生，rev-parse 会失败——给出明确提示
        const headCheck = await git.run(['rev-parse', '--verify', 'HEAD'], { cwd: root, signal: opts.signal })
        const hint = headCheck.ok ? '' : '（仓库尚无任何提交，请先创建首个提交）'
        return { ok: false, error: `基分支不存在：${baseName}${hint}` }
      }

      // 分支冲突：git 里已存在
      const existsCheck = await git.run(['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: root, signal: opts.signal })
      if (existsCheck.ok) return { ok: false, error: `分支已存在：${branchName}` }

      // 安全提示：主工作区脏时新建工作区不会包含未提交改动
      const baseStatus = await git.run(['status', '--porcelain'], { cwd: root, signal: opts.signal })
      if (isDirty(baseStatus.stdout)) {
        warnings.push('主工作区存在未提交改动，新建的工作区不会包含这些改动，请留意')
      }

      const wtPath = join(vault, slugifyTask(task))
      // 防碰撞：不同任务名可能派生同一 slug（如 "a b" 与 "a-b"），
      // 账本中已有记录指向同一工作区路径时拒绝
      if (ledger.records.some((rec) => samePath(rec.path, wtPath))) {
        return { ok: false, error: `已有任务使用工作区目录 ${wtPath}，请更换任务名` }
      }
      if (existsSync(wtPath)) {
        return { ok: false, error: `工作区目录已存在：${wtPath}` }
      }

      // 核心动作：创建 worktree
      const add = await git.run(['worktree', 'add', wtPath, '-b', branchName, baseName], { cwd: root, signal: opts.signal })
      if (!add.ok) return { ok: false, error: `创建工作区失败：${add.stderr.trim()}` }
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

      // on_begin 触发器（工作目录 = 新工作区）
      const triggerWarnings = await runTriggers(
        repo?.triggers?.on_begin,
        { task, branch: branchName, base: baseName, path: wtPath, root },
        { spawn: opts.triggerSpawn, cwd: wtPath },
      )
      warnings.push(...triggerWarnings.warnings)

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
      upsertRecord(ledger, record)
      saveLedger(vault, ledger)
      return { ok: true, base: baseName, path: wtPath }
    })
  } catch (err) {
    // worktree 已创建但后续步骤失败：回滚，避免留下孤儿工作区阻塞重试
    if (createdWorktree && typeof result === 'undefined') {
      try {
        await git.run(['worktree', 'remove', '--force', join(vault, slugifyTask(task))], { cwd: root })
        await git.run(['branch', '-D', branchName], { cwd: root })
        warnings.push('已回滚未完成的工作区创建（worktree 与分支已清理）')
      } catch {
        warnings.push('工作区创建未完成，且回滚失败：请手动执行 git worktree remove / branch -D')
      }
    }
    if (err instanceof VaultError) return { ok: false, error: err.message }
    return { ok: false, error: `创建失败：${/** @type {Error} */ (err).message}` }
  }
  if (!result.ok) return result
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
  const vault = computeVault(root, cfg.vault)
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
    })
  } catch (err) {
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
  const vault = computeVault(root, cfg.vault)
  try {
    return await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      const rec = findRecord(ledger, task)
      if (!rec) return { ok: false, error: `任务不存在：${task}（可用 wtm_status 查看）` }
      return await finishCore(opts, { vault, ledger, rec, mode })
    })
  } catch (err) {
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
  const vault = computeVault(root, cfg.vault)
  try {
    const ledger = loadLedger(vault)
    const wl = await git.run(['worktree', 'list', '--porcelain'], { cwd: root, signal: opts.signal })
    if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
    const worktrees = parseWorktreeList(wl.stdout)
    const rows = []
    for (const rec of ledger.records) {
      const wt = worktrees.find((w) => samePath(w.path, rec.path))
      let dirty = false
      let counts = null
      // 存在性 = 注册表有该工作区 且 目录实际存在（目录被外部删除后注册表仍会列出）
      const alive = Boolean(wt) && existsSync(rec.path)
      if (alive) {
        const st = await git.run(['status', '--porcelain'], { cwd: rec.path, signal: opts.signal })
        dirty = st.ok && isDirty(st.stdout)
        const rc = await git.run(['rev-list', '--left-right', '--count', `${rec.base}...${rec.branch}`], { cwd: root, signal: opts.signal })
        counts = rc.ok ? parseAheadBehind(rc.stdout) : null
      }
      rows.push({
        task: rec.task,
        branch: rec.branch,
        base: rec.base,
        path: rec.path,
        exists: alive,
        dirty,
        counts,
        updatedAt: rec.updatedAt,
      })
    }
    return { ok: true, rows, warnings: [] }
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
  const vault = computeVault(root, cfg.vault)
  try {
    return await withLock(vault, async () => {
      const ledger = loadLedger(vault)
      /** @type {Array<{rec: LedgerRecord | undefined, name: string}>} */
      const targets = opts.all
        ? ledger.records.map((rec) => ({ rec, name: rec.task }))
        : tasks.map((t) => ({ rec: findRecord(ledger, t), name: t }))
      const results = []
      for (const item of targets) {
        if (!item.rec) {
          results.push({ task: item.name, ok: false, error: '任务不存在' })
          continue
        }
        const r = await finishCore(opts, { vault, ledger, rec: item.rec, mode })
        results.push({ task: item.rec.task, ok: r.ok, error: r.error, note: r.note, merged: r.merged, committed: r.committed })
      }
      return { ok: true, results }
    })
  } catch (err) {
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
 * @returns {Promise<{ok: boolean, committed: boolean, error?: string}>}
 */
async function snapshotCommit(opts, rec, task) {
  const { git, cfg } = opts
  const st = await git.run(['status', '--porcelain'], { cwd: rec.path, signal: opts.signal })
  if (!st.ok) return { ok: false, committed: false, error: `读取任务工作区状态失败：${st.stderr.trim()}` }
  if (!isDirty(st.stdout)) return { ok: true, committed: false }
  const message = opts.message ?? renderTemplate(cfg.commitMessage, { task, branch: rec.branch, base: rec.base })
  const add = await git.run(['add', '-A'], { cwd: rec.path, signal: opts.signal })
  if (!add.ok) return { ok: false, committed: false, error: `git add 失败：${add.stderr.trim()}` }
  const commit = await git.run(['commit', '-m', message], { cwd: rec.path, signal: opts.signal })
  if (!commit.ok) return { ok: false, committed: false, error: `快照提交失败：${commit.stderr.trim()}` }
  return { ok: true, committed: true }
}

/**
 * 合并回基分支：校验基工作区干净 → merge --no-ff。
 * @param {OpOpts} opts
 * @param {LedgerRecord} rec
 * @param {string} task
 * @returns {Promise<{ok: boolean, merged: boolean, error?: string, warnings: string[]}>}
 */
async function mergeIntoBase(opts, rec, task) {
  const { root, git, cfg } = opts

  // 合并目标必须与账本记录的基分支一致：主工作区可能已被切到其他分支
  // （或处于 detached HEAD），此时继续会把改动合入错误目标
  const cur = await git.run(['branch', '--show-current'], { cwd: root, signal: opts.signal })
  if (!cur.ok) {
    return { ok: false, merged: false, error: `读取主工作区分支失败：${cur.stderr.trim()}`, warnings: [] }
  }
  const currentBase = cur.stdout.trim()
  if (currentBase !== rec.base) {
    const hint = currentBase ? `当前在 ${currentBase}` : '当前处于 detached HEAD'
    return {
      ok: false,
      merged: false,
      error: `主工作区当前分支与任务基分支不一致（账本：${rec.base}，${hint}）。` +
        `请先在主工作区切回 ${rec.base} 再重试（git checkout ${rec.base}）`,
      warnings: [],
    }
  }

  const baseStatus = await git.run(['status', '--porcelain'], { cwd: root, signal: opts.signal })
  if (!baseStatus.ok) {
    return { ok: false, merged: false, error: `读取基分支状态失败：${baseStatus.stderr.trim()}`, warnings: [] }
  }
  if (isDirty(baseStatus.stdout)) {
    return {
      ok: false,
      merged: false,
      error: '基分支工作区存在未提交改动，请先提交或暂存（防止合并混入未完成的工作）',
      warnings: [],
    }
  }

  // 已合并检测：分支尖端已是基分支祖先时跳过合并（重试场景不再制造空 merge 提交）
  const ancestor = await git.run(['merge-base', '--is-ancestor', rec.branch, 'HEAD'], { cwd: root, signal: opts.signal })
  if (ancestor.ok) {
    return { ok: true, merged: false, warnings: ['任务分支已包含在基分支中，跳过重复合并'] }
  }

  const message = opts.message ?? renderTemplate(cfg.mergeMessage, { task, branch: rec.branch, base: rec.base })
  const merge = await git.run(['merge', '--no-ff', rec.branch, '-m', message], { cwd: root, signal: opts.signal })
  if (!merge.ok) {
    return {
      ok: false,
      merged: false,
      error: `合并失败：${merge.stderr.trim()}。主工作区可能处于合并中状态，可用 git merge --abort 恢复后重试`,
      warnings: [],
    }
  }
  return { ok: true, merged: true, warnings: [] }
}

/**
 * 同步核心（mergeTask 与 finishTask 共用）：快照 + 合并 + 更新账本。
 * @param {OpOpts} opts
 * @param {{vault: string, ledger: Ledger, rec: LedgerRecord, mode: string}} box
 * @returns {Promise<{ok: boolean, error?: string, committed?: boolean, merged?: boolean, warnings?: string[]}>}
 */
async function syncCore(opts, { vault, ledger, rec, mode }) {
  const { root, git, repo } = opts
  const task = rec.task
  const wl = await git.run(['worktree', 'list', '--porcelain'], { cwd: root, signal: opts.signal })
  if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
  const worktrees = parseWorktreeList(wl.stdout)
  const wt = worktrees.find((w) => samePath(w.path, rec.path))
  // stale：注册表没有该工作区，或目录已被外部删除
  // （目录被删后注册表仍会列出 prunable 条目，必须用目录实存判定）
  if (!wt || !existsSync(rec.path)) {
    return { ok: false, error: `任务工作区已不存在（${rec.path}），可运行 wtm_purge 清理记录` }
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
    if (st.ok && isDirty(st.stdout)) {
      return { ok: false, error: '任务工作区存在未提交改动，refuse 模式下拒绝合并（可改用 commit 模式自动快照）' }
    }
  }
  const snap = await snapshotCommit(opts, rec, task)
  if (!snap.ok) return { ok: false, error: snap.error }

  // 2) 合并回基分支
  const merged = await mergeIntoBase(opts, rec, task)
  if (!merged.ok) return { ok: false, error: merged.error }
  warnings.push(...merged.warnings)

  // 3) on_merge 触发器（工作目录 = 主仓库）
  const triggerWarnings = await runTriggers(
    repo?.triggers?.on_merge,
    { task, branch: rec.branch, base: rec.base, path: rec.path, root },
    { spawn: opts.triggerSpawn, cwd: root },
  )
  warnings.push(...triggerWarnings.warnings)

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
 * @param {{vault: string, ledger: Ledger, rec: LedgerRecord, mode: string}} box
 * @returns {Promise<OpResult>}
 */
async function finishCore(opts, { vault, ledger, rec, mode }) {
  const { root, git, repo } = opts
  const task = rec.task
  /** @type {string[]} */
  const warnings = []

  // 工作区已消失（stale：注册表缺失或目录被外部删除）：直接清记录
  const wl = await git.run(['worktree', 'list', '--porcelain'], { cwd: root, signal: opts.signal })
  if (!wl.ok) return { ok: false, error: `读取 worktree 列表失败：${wl.stderr.trim()}` }
  const worktrees = parseWorktreeList(wl.stdout)
  const wt = worktrees.find((w) => samePath(w.path, rec.path))
  if (!wt || !existsSync(rec.path)) {
    removeRecord(ledger, task)
    saveLedger(vault, ledger)
    return { ok: true, note: `任务工作区已不存在，已清理账本记录（任务：${task}）`, committed: false, merged: false }
  }

  // keep：仅解除管理
  if (mode === 'keep') {
    removeRecord(ledger, task)
    saveLedger(vault, ledger)
    return { ok: true, note: `任务“${task}”已解除管理，工作区与分支保留`, committed: false, merged: false }
  }

  let committed = false
  let merged = false
  if (mode === 'commit') {
    // commit 模式会提交改动：先校验工作区当前分支与账本记录一致，
    // 否则快照会落在错误分支并静默丢失（与 merge 路径同一防护）
    const branchCheck = checkWorktreeBranch(wt, rec)
    if (!branchCheck.ok) return { ok: false, error: branchCheck.error }
    // 快照提交 + 合并（abandon 模式两者都跳过）
    const snap = await snapshotCommit(opts, rec, task)
    if (!snap.ok) return { ok: false, error: snap.error }
    committed = snap.committed
    const m = await mergeIntoBase(opts, rec, task)
    if (!m.ok) return { ok: false, error: m.error }
    merged = m.merged
    warnings.push(...m.warnings)
  }

  // 移除工作区：commit 用安全移除，abandon 用 --force
  const removeArgs = mode === 'abandon'
    ? ['worktree', 'remove', '--force', rec.path]
    : ['worktree', 'remove', rec.path]
  const remove = await git.run(removeArgs, { cwd: root, signal: opts.signal })
  if (!remove.ok) {
    return {
      ok: false,
      error: `移除工作区失败：${remove.stderr.trim()}（如存在未跟踪文件，可改用 abandon 模式强制清理）`,
    }
  }

  // 删除任务分支：commit 用安全删除 -d；abandon 用 -D
  const delArgs = mode === 'abandon' ? ['branch', '-D', rec.branch] : ['branch', '-d', rec.branch]
  const del = await git.run(delArgs, { cwd: root, signal: opts.signal })
  let branchDeleted = del.ok
  if (!del.ok) warnings.push(`分支删除失败（${rec.branch}）：${del.stderr.trim()}`)

  // on_finish 触发器（工作目录 = 主仓库；注意此时任务工作区已移除）
  const triggerWarnings = await runTriggers(
    repo?.triggers?.on_finish,
    { task, branch: rec.branch, base: rec.base, path: rec.path, root },
    { spawn: opts.triggerSpawn, cwd: root },
  )
  warnings.push(...triggerWarnings.warnings)

  removeRecord(ledger, task)
  saveLedger(vault, ledger)
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




