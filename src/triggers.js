/**
 * 生命周期触发器：在关键节点执行仓库配置的 shell 命令。
 *
 * 命令通过平台 shell 执行（win32 用 cmd /c，其他平台用 sh -c），
 * 并注入 WTM_TASK / WTM_BRANCH / WTM_BASE / WTM_PATH / WTM_ROOT 环境变量。
 * 触发器失败只产生警告，绝不中断主流程。
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, promises as fs, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const TERM_GRACE_MS = 120
const KILL_CONFIRM_MS = 80
const CLEANUP_DEADLINE_MS = 700
const HAS_SETSID = process.platform !== 'win32' && (process.env.PATH ?? '').split(delimiter).some((dir) => {
  try {
    accessSync(join(dir, 'setsid'), constants.X_OK)
    return true
  } catch {
    return false
  }
})

/**
 * @typedef {object} TriggerContext
 * @property {string} [task]
 * @property {string} [branch]
 * @property {string} [base]
 * @property {string} [path]
 * @property {string} [root]
 */

/**
 * 顺序执行一组触发器命令。
 * @param {unknown[] | undefined} commands
 * @param {TriggerContext} ctx
 * @param {{spawn?: (shell: string, args: string[], opts: object) => object, cwd?: string, signal?: AbortSignal, platform?: NodeJS.Platform}} [opts]
 *        可注入 spawn 用于测试；platform 可用于测试平台专属清理；cwd 指定命令的工作目录
 *        （默认继承进程目录），signal 用于取消
 * @returns {Promise<{warnings: string[], cancelled?: boolean, cleanupConfirmed?: boolean, cleanupError?: string}>}
 */
export async function runTriggers(commands, ctx, { spawn: spawnFn = spawn, cwd, signal, platform = process.platform } = {}) {
  /** @type {string[]} */
  const warnings = []
  let completedCommand = false
  if (signal?.aborted) return { warnings, cancelled: true, cleanupConfirmed: true }
  if (commands === undefined) return { warnings, cleanupConfirmed: true }
  if (!Array.isArray(commands)) {
    warnings.push('触发器配置类型无效，必须是命令数组，已忽略')
    return { warnings, cleanupConfirmed: true }
  }
  const isWin = platform === 'win32'
  for (const [index, cmd] of commands.entries()) {
    if (signal?.aborted) {
      return completedCommand
        ? { warnings, cancelled: true, cleanupConfirmed: false, cleanupError: '取消在触发器 shell 关闭后才被观察到，无法排除未跟踪的 escaped 后代' }
        : { warnings, cancelled: true, cleanupConfirmed: true }
    }
    if (typeof cmd !== 'string') {
      warnings.push(`触发器配置项无效（索引 ${index}），必须是字符串，已忽略`)
      continue
    }
    if (cmd.trim() === '') continue
    const shell = isWin ? 'cmd' : 'sh'
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
    const env = {
      ...process.env,
      WTM_TASK: ctx.task ?? '',
      WTM_BRANCH: ctx.branch ?? '',
      WTM_BASE: ctx.base ?? '',
      WTM_PATH: ctx.path ?? '',
      WTM_ROOT: ctx.root ?? '',
    }
    const priorCommandCompleted = completedCommand
    const outcome = await runOne(spawnFn, shell, args, { env, ...(cwd ? { cwd } : {}), signal, platform })
    if (outcome.started) completedCommand = true
    if (outcome.cancelled) {
      if (outcome.spawnError) warnings.push(`触发器失败 [${cmd}]: ${outcome.spawnError}`)
      const partialOutput = [outcome.stdout?.trim(), outcome.stderr?.trim()].filter(Boolean).join('\n')
      if (partialOutput) warnings.push(`触发器取消前输出 [${cmd}]: ${partialOutput}`)
      const cleanupError = [
        outcome.cleanupError,
        priorCommandCompleted ? '此前完成的触发器命令可能仍有 escaped 后代' : undefined,
      ].filter(Boolean).join('; ')
      return {
        warnings,
        cancelled: true,
        cleanupConfirmed: outcome.cleanupConfirmed === true && !priorCommandCompleted,
        ...(cleanupError ? { cleanupError } : {}),
      }
    }
    if (!outcome.ok) warnings.push(`触发器失败 [${cmd}]: ${outcome.detail}`)
    if (signal?.aborted) {
      return completedCommand
        ? { warnings, cancelled: true, cleanupConfirmed: false, cleanupError: '取消在触发器 shell 关闭后才被观察到，无法排除未跟踪的 escaped 后代' }
        : { warnings, cancelled: true, cleanupConfirmed: true }
    }
  }
  return { warnings, ...(!completedCommand ? { cleanupConfirmed: true } : {}) }
}

/**
 * 执行单个子进程并收集输出。
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {string} shell
 * @param {string[]} args
 * @param {{env: Record<string, string>, cwd?: string, signal?: AbortSignal, platform: NodeJS.Platform}} opts
 * @returns {Promise<{ok: boolean, detail: string, started?: boolean, spawnError?: string, stdout?: string, stderr?: string, cancelled?: boolean, cleanupConfirmed?: boolean, cleanupError?: string}>}
 */
function runOne(spawnFn, shell, args, opts) {
  return new Promise((resolve) => {
    /** @type {any} */
    let child
    const { signal, platform, ...spawnOpts } = opts
    const useSetsid = platform !== 'win32' && HAS_SETSID
    const launchCommand = useSetsid ? 'exec setsid sh -c "$1"' : 'exec sh -c "$1"'
    const actualArgs = platform === 'win32'
      ? args
      : ['-c', `IFS= read -r _wtm_start <&3 || exit 0; exec 3<&-; ${launchCommand}`, 'wtm-trigger', args.at(-1) ?? '']
    try {
      child = spawnFn(shell, actualArgs, {
        ...spawnOpts,
        windowsHide: true,
        detached: platform !== 'win32' && !useSetsid,
        ...(platform !== 'win32' ? { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] } : {}),
      })
    } catch (err) {
      resolve({ ok: false, started: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}` })
      return
    }

    let stdout = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let outputFlushed = false
    let collectingOutput = true
    let closeObserved = false
    let exitObserved = false
    let spawnFailed = false
    /** @type {string | undefined} */
    let spawnError
    let cancellationStarted = false
    let settled = false
    const startupGate = platform !== 'win32' && typeof child.stdio?.[3]?.end === 'function'
      ? child.stdio[3]
      : undefined
    let commandStarted = startupGate === undefined
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let cleanupTimeout
    // Process tracking is needed only when the caller can cancel this command.
    // Keep the POSIX startup gate in place so the no-signal path still opens fd 3.
    const processTracker = createProcessTracker(
      signal ? child.pid : undefined,
      platform,
      () => !exitObserved && child.exitCode == null && child.signalCode == null,
    )
    const flushOutput = () => {
      if (outputFlushed) return
      outputFlushed = true
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
    }
    /**
     * @param {{ok: boolean, detail: string, started?: boolean, spawnError?: string, stdout?: string, stderr?: string, cancelled?: boolean, cleanupConfirmed?: boolean, cleanupError?: string}} result
     */
    const done = (result) => {
      if (settled) return
      settled = true
      collectingOutput = false
      if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout)
      signal?.removeEventListener('abort', abort)
      processTracker.stop()
      if (result.cancelled) {
        child.stdout?.destroy?.()
        child.stderr?.destroy?.()
      }
      resolve(result)
    }
    /** @param {{confirmed: boolean, error?: string}} cleanup */
    const finishCancellation = (cleanup) => {
      flushOutput()
      const detail = cleanup.confirmed
        ? '操作已取消（aborted）'
        : `操作已取消（aborted）；触发器进程清理未能确认${cleanup.error ? `：${cleanup.error}` : ''}`
      done({
        ok: false,
        detail,
        started: commandStarted,
        ...(spawnError ? { spawnError } : {}),
        stdout,
        stderr,
        cancelled: true,
        cleanupConfirmed: cleanup.confirmed,
        ...(cleanup.error ? { cleanupError: cleanup.error } : {}),
      })
    }
    const abort = () => {
      if (settled || cancellationStarted) return
      cancellationStarted = true
      cleanupTimeout = setTimeout(() => {
        finishCancellation({ confirmed: false, error: '触发器进程清理超时' })
      }, CLEANUP_DEADLINE_MS)
      if (!commandStarted) {
        // EOF makes the gated wrapper exit before it can start the trigger command.
        // This avoids signalling an unverified numeric PID during startup.
        try { startupGate?.end() } catch { /* final cleanup result will report uncertainty if it stays open */ }
      }
      const rootStatus = async () => {
        if (exitObserved || child.exitCode != null || child.signalCode != null) return 'exited'
        return await processTracker.rootStatus()
      }
      void terminateTrigger(
        spawnFn,
        child,
        processTracker,
        () => closeObserved,
        platform,
        rootStatus,
        () => commandStarted,
        () => spawnFailed,
      )
        .then((/** @type {{confirmed: boolean, error?: string}} */ cleanup) => finishCancellation(cleanup))
        .catch((err) => {
          const message = /** @type {Error} */ (err).message
          finishCancellation({ confirmed: false, error: message })
        })
    }

    child.stdout?.on('data', (/** @type {any} */ data) => {
      if (collectingOutput) stdout += stdoutDecoder.write(data)
    })
    child.stderr?.on('data', (/** @type {any} */ data) => {
      if (collectingOutput) stderr += stderrDecoder.write(data)
    })
    child.on('error', (/** @type {any} */ err) => {
      if (child.pid === undefined && !exitObserved) {
        spawnFailed = true
        commandStarted = false
        spawnError = stderr.trim() || err.message
      }
      if (cancellationStarted) return
      flushOutput()
      done({ ok: false, started: commandStarted, detail: `${stderr.trim() || err.message}` })
    })
    child.on('exit', () => { exitObserved = true })
    child.on('close', (/** @type {any} */ code, /** @type {any} */ sig) => {
      closeObserved = true
      if (signal?.aborted || cancellationStarted) {
        abort()
        return
      }
      flushOutput()
      if (code === 0) {
        done({ ok: true, started: commandStarted, detail: '' })
      } else {
        done({ ok: false, started: commandStarted, detail: `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}` })
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin?.end()
    if (signal?.aborted) {
      abort()
    } else if (startupGate !== undefined) {
      void processTracker.ready().then(() => {
        if (settled) return
        if (signal?.aborted) {
          abort()
          return
        }
        commandStarted = true
        startupGate.end('\n')
      })
    }
  })
}

/**
 * Read Linux process identities so descendants can still be signalled after the
 * shell exits and reparents a setsid child. Start time prevents signalling a reused PID.
 * @param {number} pid
 * @returns {{pid: number, ppid: number, pgrp: number, state: string, startTime: string} | undefined}
 */
function readProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end < 0) return undefined
    const fields = stat.slice(end + 2).trim().split(/\s+/)
    if (fields.length < 20) return undefined
    return { pid, state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), startTime: fields[19] }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT' || code === 'ESRCH') return undefined
    throw err
  }
}

/**
 * Track process ancestry while the trigger runs. This preserves the identity of an
 * escaped descendant after its shell exits and the OS reparents it.
 * @param {number | undefined} rootPid
 * @param {NodeJS.Platform} platform
 * @param {() => boolean} rootStillRunning
 * @returns {{enabled: boolean, ready: () => Promise<void>, refresh: () => Promise<void>, stop: () => void, stopped: () => boolean, signal: (sig: NodeJS.Signals) => Promise<string[]>, liveCount: () => Promise<number>, complete: () => boolean, groupMayExist: () => Promise<'present' | 'absent' | 'reused' | 'unverified'>, rootStatus: () => Promise<'alive' | 'exited' | 'unverified'>}}
 */
function createProcessTracker(rootPid, platform, rootStillRunning) {
  const enabled = platform === 'linux' && Number.isInteger(rootPid)
  /** @type {Map<number, string>} */
  const descendants = new Map()
  /** @type {Map<number, string>} */
  const groupMembers = new Map()
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer
  /** @type {string | undefined} */
  let rootStartTime
  let initialRefreshAttempted = false
  let complete = true
  let stopped = false
  /** @type {Promise<void> | undefined} */
  let refreshPromise
  /** @type {Promise<void>} */
  let initialRefresh = Promise.resolve()

  const refresh = () => {
    if (!enabled || stopped) return Promise.resolve()
    if (refreshPromise) return refreshPromise
    const isInitialRefresh = !initialRefreshAttempted
    initialRefreshAttempted = true
    refreshPromise = (async () => {
      /** @type {string[]} */
      let entries
      try {
        entries = await fs.readdir('/proc', { encoding: 'utf8' })
      } catch {
        complete = false
        return
      }
      /** @type {Map<number, {pid: number, ppid: number, pgrp: number, state: string, startTime: string}>} */
      const processes = new Map()
      const processEntries = entries.filter((entry) => /^\d+$/.test(entry))
      for (let offset = 0; offset < processEntries.length; offset += 32) {
        if (stopped) return
        for (const entry of processEntries.slice(offset, offset + 32)) {
          try {
            const identity = readProcessIdentity(Number(entry))
            if (identity) processes.set(identity.pid, identity)
          } catch {
            complete = false
          }
        }
        if (offset + 32 < processEntries.length) await new Promise((resolve) => setImmediate(resolve))
      }
      if (stopped) return
      const root = processes.get(/** @type {number} */ (rootPid))
      if (isInitialRefresh && root && rootStillRunning()) {
        rootStartTime = root.startTime
      } else if (rootStartTime === undefined && root) {
        // A later process at the old PID must never become the identity anchor
        // after the initial read failed, even if its parent/group look familiar.
        complete = false
      }
      const rootIdentityMatches = root !== undefined && rootStartTime !== undefined && root.startTime === rootStartTime
      // Process-group membership catches children reparented between ancestry polls.
      // Only adopt members while the original root identity is present: after it
      // disappears, the numeric PGID could have been reused by an unrelated group.
      if (rootIdentityMatches) {
        for (const process of processes.values()) {
          if (process.pgrp === rootPid) groupMembers.set(process.pid, process.startTime)
        }
      }
      /** @type {Set<number>} */
      const anchors = new Set()
      if (rootIdentityMatches) anchors.add(/** @type {NonNullable<typeof root>} */ (root).pid)
      for (const [pid, startTime] of descendants) {
        if (processes.get(pid)?.startTime === startTime) anchors.add(pid)
      }
      let added = true
      while (added) {
        added = false
        for (const process of processes.values()) {
          if (!anchors.has(process.ppid) || process.pid === rootPid) continue
          const previousStartTime = descendants.get(process.pid)
          if (previousStartTime === undefined) {
            descendants.set(process.pid, process.startTime)
            anchors.add(process.pid)
            added = true
          } else if (previousStartTime === process.startTime && !anchors.has(process.pid)) {
            anchors.add(process.pid)
            added = true
          }
        }
      }
    })().finally(() => { refreshPromise = undefined })
    return refreshPromise
  }

  if (enabled) {
    initialRefresh = refresh()
    timer = setInterval(() => { void refresh() }, 10)
    timer.unref?.()
  }

  const liveIdentities = async () => {
    if (stopped) return []
    /** @type {Map<number, {startTime: string, pgrp: number}>} */
    const alive = new Map()
    let checked = 0
    for (const [pid, startTime] of descendants) {
      if (stopped) return []
      try {
        const current = readProcessIdentity(pid)
        if (current?.startTime === startTime && current.state !== 'Z' && current.state !== 'X') {
          alive.set(pid, { startTime, pgrp: current.pgrp })
        }
      } catch {
        complete = false
      }
      checked += 1
      if (checked % 32 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    for (const [pid, startTime] of groupMembers) {
      if (stopped) return []
      try {
        const current = readProcessIdentity(pid)
        if (current?.startTime === startTime && current.pgrp === rootPid && current.state !== 'Z' && current.state !== 'X') {
          alive.set(pid, { startTime, pgrp: current.pgrp })
        }
      } catch {
        complete = false
      }
      checked += 1
      if (checked % 32 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    return [...alive].map(([pid, identity]) => ({ pid, ...identity }))
  }
  return {
    enabled,
    ready: () => initialRefresh,
    refresh,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    },
    stopped: () => stopped,
    signal: async (/** @type {NodeJS.Signals} */ sig) => {
      /** @type {string[]} */
      const failures = []
      const tracked = new Map([...descendants, ...groupMembers])
      let index = 0
      for (const [pid, startTime] of tracked) {
        if (stopped) break
        try {
          // Recheck each PID immediately before signaling it; an earlier full-tree
          // snapshot may be stale by the time this PID's turn arrives.
          const current = readProcessIdentity(pid)
          if (!current || current.startTime !== startTime || current.state === 'Z' || current.state === 'X') continue
          process.kill(pid, sig)
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') {
            complete = false
            failures.push(`${pid}: ${errorText(err)}`)
          }
        }
        index += 1
        if (index % 32 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      return failures
    },
    liveCount: async () => (await liveIdentities()).length,
    complete: () => complete,
    rootStatus: async () => {
      if (!enabled || rootPid === undefined) return 'alive'
      if (rootStartTime === undefined) {
        complete = false
        return 'unverified'
      }
      // Read just the direct child so a slow whole-tree snapshot cannot delay
      // its best-effort termination. Group and descendant signals still use
      // their own start-time and membership checks.
      try {
        const root = readProcessIdentity(rootPid)
        if (!root) return 'exited'
        return root.startTime !== rootStartTime || root.state === 'Z' || root.state === 'X'
          ? 'exited'
          : 'alive'
      } catch {
        complete = false
        return 'unverified'
      }
    },
    groupMayExist: async () => {
      if (!enabled || rootPid === undefined) return 'absent'
      await refresh()
      if (stopped) return 'unverified'
      let root
      try {
        root = readProcessIdentity(rootPid)
      } catch {
        complete = false
        return 'unverified'
      }
      if (root && rootStartTime === undefined) return 'unverified'
      if (root && rootStartTime !== undefined && root.startTime !== rootStartTime) return 'reused'
      if (root && root.pgrp === rootPid && root.state !== 'Z' && root.state !== 'X') return 'present'
      const live = await liveIdentities()
      if (stopped) return 'unverified'
      if (live.some((descendant) => descendant.pgrp === rootPid)) return 'present'
      if (!root || !complete) return 'unverified'
      return complete ? 'absent' : 'unverified'
    },
  }
}

/** @param {unknown} err */
function errorText(err) {
  const error = /** @type {NodeJS.ErrnoException} */ (err)
  return error.code ?? error.message ?? String(err)
}

/** @param {any} child @param {() => boolean} isClosed @param {number} timeoutMs @returns {Promise<boolean>} */
function waitForClose(child, isClosed, timeoutMs) {
  if (isClosed()) return Promise.resolve(true)
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    timer = setTimeout(() => {
      child.removeListener?.('close', onClose)
      resolve(false)
    }, timeoutMs)
    child.once?.('close', onClose)
    if (isClosed()) onClose()
  })
}

/**
 * Terminate the shell process group and the descendants captured while it was alive.
 * The latter includes setsid children that have left the shell's process group.
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {any} child
 * @param {ReturnType<typeof createProcessTracker>} processTracker
 * @param {() => boolean} isClosed
 * @param {NodeJS.Platform} platform
 * @param {() => Promise<'alive' | 'exited' | 'unverified'>} rootStatus
 * @param {() => boolean} commandStarted
 * @param {() => boolean} spawnFailed
 * @returns {Promise<{confirmed: boolean, error?: string}>}
 */
async function terminateTrigger(spawnFn, child, processTracker, isClosed, platform, rootStatus, commandStarted, spawnFailed) {
  if (!commandStarted()) {
    const closed = await waitForClose(child, isClosed, CLEANUP_DEADLINE_MS)
    return closed
      ? { confirmed: true }
      : { confirmed: false, error: '触发器启动 wrapper 在关闭 startup gate 后仍未退出' }
  }
  /** @type {string[]} */
  const failures = []
  const pid = Number.isInteger(child.pid) ? child.pid : undefined
  const isWin = platform === 'win32'
  /** @param {number} target @param {NodeJS.Signals} sig */
  const signalPid = (target, sig) => {
    try {
      process.kill(target, sig)
      return true
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (code === 'ESRCH') return true
      failures.push(`${sig} ${target}: ${errorText(err)}`)
      return false
    }
  }
  /** @param {NodeJS.Signals} sig */
  const signalGroup = async (sig) => {
    if (isWin || pid === undefined || !commandStarted()) return true
    if (!processTracker.enabled && await rootStatus() === 'exited') {
      failures.push(`${sig} process group root exited; skipped unverified group signal`)
      return false
    }
    if (processTracker.enabled) {
      try {
        const exists = await processTracker.groupMayExist()
        if (exists === 'reused') {
          failures.push(`${sig} process group root PID was reused; skipped group signal`)
          return false
        }
        if (exists === 'unverified') {
          failures.push(`${sig} process group root identity could not be verified; skipped group signal`)
          return false
        }
        if (exists === 'absent') return true
      } catch (err) {
        failures.push(`${sig} process group inspection: ${errorText(err)}`)
        return false
      }
    }
    return signalPid(-pid, sig)
  }
  /** @param {NodeJS.Signals} sig */
  const signalChild = async (sig) => {
    if (spawnFailed()) return true
    // ChildProcess.kill() targets its stored numeric PID. If that PID has been
    // reused after the shell exits, skip it instead of signalling an unrelated process.
    const status = await rootStatus()
    if (status === 'exited') return true
    if (status === 'unverified') {
      failures.push(`${sig} child identity could not be verified; skipped numeric PID signal`)
      return false
    }
    try {
      const sent = child.kill?.(sig)
      if (sent === false && child.exitCode === null && child.signalCode === null) {
        failures.push(`${sig} child: kill returned false`)
        return false
      }
      return true
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (code === 'ESRCH') return true
      failures.push(`${sig} child: ${errorText(err)}`)
      return false
    }
  }
  const signalDescendants = async (/** @type {NodeJS.Signals} */ sig) => {
    if (!commandStarted()) return
    try {
      for (const failure of await processTracker.signal(sig)) failures.push(`${sig} descendants: ${failure}`)
    } catch (err) {
      failures.push(`${sig} descendants: ${errorText(err)}`)
    }
  }

  if (isWin) {
    const rootAlreadyExited = await rootStatus() === 'exited'
    if (!rootAlreadyExited && !isClosed()) await signalChild('SIGKILL')
    await delay(KILL_CONFIRM_MS)
    if (pid === undefined && spawnFailed() && isClosed()) return { confirmed: true }
    if (!isClosed()) failures.push('触发器输出管道仍未关闭')
    const treeCleanupError = rootAlreadyExited
      ? '触发器 shell 已退出，跳过可能已复用的 PID 进程树清理'
      : '无法验证 Windows 触发器进程树的 PID 身份，已跳过数字 PID 清理'
    return { confirmed: false, error: [treeCleanupError, ...failures].join('; ') }
  }

  const rootAlreadyExited = await rootStatus() === 'exited'
  await signalChild('SIGTERM')
  await signalDescendants('SIGTERM')
  const escalation = delay(TERM_GRACE_MS).then(async () => {
    await signalChild('SIGKILL')
    await signalDescendants('SIGKILL')
  })
  await processTracker.refresh()
  await signalGroup('SIGTERM')
  await signalDescendants('SIGTERM')
  await delay(TERM_GRACE_MS)
  await escalation

  await processTracker.refresh()
  await signalGroup('SIGKILL')
  await signalDescendants('SIGKILL')
  await delay(KILL_CONFIRM_MS)
  await processTracker.refresh()

  const noLiveDescendants = await processTracker.liveCount() === 0
  const signalsHandled = failures.length === 0 || spawnFailed()
  const cannotInspectEscapedDescendants = !processTracker.enabled
  const commandWasStarted = commandStarted()
  const escapedDescendantsPossible = commandWasStarted && (processTracker.enabled || cannotInspectEscapedDescendants)
  const confirmed = processTracker.enabled
    ? processTracker.complete() && noLiveDescendants && signalsHandled && isClosed() && !escapedDescendantsPossible
    : isClosed() && signalsHandled && !escapedDescendantsPossible
  if (confirmed) return { confirmed: true }

  if (processTracker.enabled && !processTracker.complete()) failures.push('无法完整检查触发器后代进程')
  if (!noLiveDescendants) failures.push('触发器后代进程仍可能存活')
  if (!isClosed()) failures.push('触发器输出管道仍未关闭，无法确认所有进程已终止')
  if (!signalsHandled) failures.push('无法确认触发器进程已终止')
  if (rootAlreadyExited && !spawnFailed()) {
    failures.push('触发器 shell 在取消前已退出，无法排除未跟踪的 escaped 后代')
  }
  if (processTracker.enabled && commandWasStarted && !rootAlreadyExited && !spawnFailed()) {
    failures.push('触发器命令已启动，无法排除未跟踪的 escaped 后代')
  }
  if (cannotInspectEscapedDescendants && commandWasStarted && !spawnFailed()) failures.push('此 POSIX 平台无法检查 escaped 后代，不能确认清理')
  return { confirmed: false, error: failures.join('; ') || '触发器进程仍可能存活' }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
