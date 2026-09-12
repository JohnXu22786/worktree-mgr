/**
 * 生命周期触发器：在关键节点执行仓库配置的 shell 命令。
 *
 * 命令通过平台 shell 执行（win32 用 cmd /c，其他平台用 sh -c），
 * 并注入 WTM_TASK / WTM_BRANCH / WTM_BASE / WTM_PATH / WTM_ROOT 环境变量。
 * 触发器失败只产生警告，绝不中断主流程。
 */

import { spawn } from 'node:child_process'

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
 * @param {string[] | undefined} commands
 * @param {TriggerContext} ctx
 * @param {{spawn?: (shell: string, args: string[], opts: object) => object, cwd?: string, signal?: AbortSignal}} [opts]
 *        可注入 spawn 用于测试；cwd 指定命令的工作目录（默认继承进程目录）；signal 用于中止触发器进程
 * @returns {Promise<{warnings: string[], aborted?: boolean}>}
 */
export async function runTriggers(commands, ctx, { spawn: spawnFn = spawn, cwd, signal } = {}) {
  /** @type {string[]} */
  const warnings = []
  if (!Array.isArray(commands)) return { warnings }
  let aborted = false
  const isWin = process.platform === 'win32'
  for (const cmd of commands) {
    if (signal?.aborted) {
      aborted = true
      break
    }
    if (typeof cmd !== 'string' || cmd.trim() === '') continue
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
    const { ok, detail, aborted: commandAborted } = await runOne(spawnFn, shell, args, { env, ...(cwd ? { cwd } : {}), signal })
    if (!ok && !commandAborted) warnings.push(`触发器失败 [${cmd}]: ${detail}`)
    if (commandAborted || signal?.aborted) {
      aborted = true
      break
    }
  }
  return aborted ? { warnings, aborted: true } : { warnings }
}

/**
 * 执行单个子进程并收集输出。
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {string} shell
 * @param {string[]} args
 * @param {{env: Record<string, string>, cwd?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, detail: string, aborted?: boolean}>}
 */
function runOne(spawnFn, shell, args, opts) {
  return new Promise((resolve) => {
    /** @type {any} */
    let child
    try {
      child = spawnFn(shell, args, {
        ...opts,
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
    } catch (err) {
      const aborted = /** @type {Error} */ (err).name === 'AbortError'
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}`, aborted })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborting = false
    let abortDetail = '操作已取消（aborted）'
    /** @type {{ok: boolean, detail: string, aborted?: boolean} | undefined} */
    let exitResult
    let termination = Promise.resolve()
    let terminationRequested = false
    const signal = /** @type {{signal?: AbortSignal}} */ (opts).signal
    const requestTermination = () => {
      if (terminationRequested) return
      terminationRequested = true
      try {
        termination = Promise.resolve(terminateProcessTree(child))
      } catch {
        termination = Promise.resolve()
      }
    }
    const onAbort = () => {
      aborting = true
      requestTermination()
    }
    /**
     * @param {{ok: boolean, detail: string, aborted?: boolean}} result
     */
    const done = (result) => {
      if (!settled) {
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
    }
    child.stdout?.on('data', (/** @type {any} */ d) => { stdout += d })
    child.stderr?.on('data', (/** @type {any} */ d) => { stderr += d })
    child.on('error', (/** @type {any} */ err) => {
      if (err.name === 'AbortError' || aborting || signal?.aborted) {
        aborting = true
        abortDetail = `${stderr.trim() || err.message}`
        requestTermination()
        return
      }
      done({ ok: false, detail: `${stderr.trim() || err.message}` })
    })
    child.on('exit', (/** @type {any} */ code, /** @type {any} */ sig) => {
      if (aborting || signal?.aborted) return
      if (code === 0) {
        exitResult = { ok: true, detail: '' }
      } else {
        exitResult = { ok: false, detail: `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}` }
      }
    })
    child.on('close', (/** @type {any} */ code, /** @type {any} */ sig) => {
      if (aborting || signal?.aborted) {
        termination.then(
          () => done({ ok: false, detail: abortDetail, aborted: true }),
          () => done({ ok: false, detail: abortDetail, aborted: true }),
        )
        return
      }
      if (exitResult) {
        done(exitResult)
      } else if (code === 0) {
        done({ ok: true, detail: '' })
      } else {
        done({ ok: false, detail: `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}` })
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * 终止触发器的进程组，避免 shell 的后代在取消后继续执行。
 * @param {any} child
 * @param {{platform?: NodeJS.Platform, spawnFn?: (command: string, args: string[], opts: object) => any}} [deps]
 */
export function terminateProcessTree(child, { platform = process.platform, spawnFn = spawn } = {}) {
  const pid = child?.pid
  if (typeof pid === 'number') {
    if (platform === 'win32') {
      let fallbackUsed = false
      /** @type {Promise<void> | undefined} */
      let fallbackCleanup
      const fallback = () => {
        if (fallbackUsed) return fallbackCleanup
        fallbackUsed = true
        try { child.kill?.('SIGKILL') } catch { /* 已结束 */ }
        fallbackCleanup = terminateWindowsDescendants(pid, spawnFn)
        return fallbackCleanup
      }
      /**
       * @param {() => void | Promise<void> | undefined} action
       * @param {() => void} finish
       */
      const finishAfter = (action, finish) => {
        let result
        try {
          result = action()
        } catch {
          result = undefined
        }
        Promise.resolve(result).then(finish, finish)
      }
      try {
        const killer = spawnFn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        /** @type {Promise<void>} */
        const cleanup = new Promise((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            resolve()
          }
          killer.on('error', () => {
            finishAfter(fallback, finish)
          })
          killer.on('exit', (/** @type {number | null} */ code) => {
            if (code !== 0) {
              finishAfter(fallback, finish)
            } else {
              finish()
            }
          })
          killer.on('close', (/** @type {number | null} */ code) => {
            if (code !== 0) {
              finishAfter(fallback, finish)
            } else {
              finish()
            }
          })
          killer.unref?.()
        })
        return cleanup
      } catch { /* 回退到 child.kill */
        return fallback()
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
        return
      } catch { /* 进程组可能已经结束 */ }
    }
  }
  try { child?.kill?.('SIGKILL') } catch { /* 进程可能已经结束 */ }
}

/**
 * Windows taskkill 失败后，按父进程关系枚举并终止整个后代树。
 * 即使根 shell 已经退出，仍可通过 ParentProcessId 找到遗留后代。
 * @param {number} pid
 * @param {(command: string, args: string[], opts: object) => any} spawnFn
 * @returns {Promise<void> | undefined}
 */
function terminateWindowsDescendants(pid, spawnFn) {
  const script = [
    `$root = ${pid}`,
    '$processes = @(Get-CimInstance Win32_Process)',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '$queue = [System.Collections.Generic.Queue[int]]::new()',
    '$ids.Add($root) > $null',
    '$queue.Enqueue($root)',
    'while ($queue.Count -gt 0) {',
    '  $parent = $queue.Dequeue()',
    '  foreach ($process in $processes) {',
    '    $processId = [int]$process.ProcessId',
    '    if ([int]$process.ParentProcessId -eq $parent -and $ids.Add($processId)) {',
    '      $queue.Enqueue($processId)',
    '    }',
    '  }',
    '}',
    '$ids | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
  ].join('; ')
  try {
    const cleaner = spawnFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      windowsHide: true,
      stdio: 'ignore',
    })
    /** @type {Promise<void>} */
    const cleanup = new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      cleaner.on('error', finish)
      cleaner.on('exit', finish)
      cleaner.on('close', finish)
      cleaner.unref?.()
    })
    return cleanup
  } catch {
    return undefined
  }
}
