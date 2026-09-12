/**
 * 生命周期触发器：在关键节点执行仓库配置的 shell 命令。
 *
 * 命令通过平台 shell 执行（win32 用 cmd /c，其他平台用 sh -c），
 * 并注入 WTM_TASK / WTM_BRANCH / WTM_BASE / WTM_PATH / WTM_ROOT 环境变量。
 * 触发器失败只产生警告，绝不中断主流程。
 */

import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

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
 * @param {{spawn?: (shell: string, args: string[], opts: object) => object, cwd?: string, signal?: AbortSignal, terminate?: (child: any) => Promise<{ok: boolean, detail?: string}>}} [opts]
 *        可注入 spawn 用于测试；cwd 指定命令的工作目录（默认继承进程目录）；signal 用于中止触发器进程
 * @returns {Promise<{warnings: string[], aborted?: boolean, cleanupFailed?: boolean}>}
 */
export async function runTriggers(commands, ctx, { spawn: spawnFn = spawn, cwd, signal, terminate = terminateProcessTree } = {}) {
  /** @type {string[]} */
  const warnings = []
  if (!Array.isArray(commands)) return { warnings }
  let aborted = false
  let cleanupFailed = false
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
    const result = await runOne(spawnFn, shell, args, { env, ...(cwd ? { cwd } : {}), signal }, terminate)
    if (!result.ok && !result.aborted) warnings.push(`触发器失败 [${cmd}]: ${result.detail}`)
    if (result.cleanupFailed) {
      cleanupFailed = true
      warnings.push(`触发器终止失败 [${cmd}]: ${result.detail}`)
    }
    if (result.aborted || signal?.aborted) {
      aborted = true
      break
    }
  }
  return aborted
    ? { warnings, aborted: true, ...(cleanupFailed ? { cleanupFailed: true } : {}) }
    : { warnings }
}

/**
 * 执行单个子进程并收集输出。
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {string} shell
 * @param {string[]} args
 * @param {{env: Record<string, string>, cwd?: string, signal?: AbortSignal}} opts
 * @param {(child: any) => Promise<{ok: boolean, detail?: string}>} terminate
 * @returns {Promise<{ok: boolean, detail: string, aborted?: boolean, cleanupFailed?: boolean}>}
 */
function runOne(spawnFn, shell, args, opts, terminate) {
  return new Promise((resolve) => {
    /** @type {any} */
    let child
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborting = false
    let abortPending = false
    let abortDetail = '操作已取消（aborted）'
    let exitSeen = false
    let closeSeen = false
    let terminationStarted = false
    let terminationDone = false
    let terminationFailure = ''
    /** @type {number | null} */
    let exitCode = null
    /** @type {string | null} */
    let exitSignal = null
    const signal = opts.signal
    /** @type {() => void} */
    let onAbort = () => {}
    /**
     * @param {{ok: boolean, detail: string, aborted?: boolean, cleanupFailed?: boolean}} result
     */
    const done = (result) => {
      if (!settled) {
        settled = true
        signal?.removeEventListener('abort', onAbort)
        for (const stream of [child?.stdout, child?.stderr]) {
          try { stream?.destroy?.() } catch { /* 输出流可能已经关闭 */ }
        }
        resolve(result)
      }
    }
    const finishAborted = () => {
      if ((aborting || signal?.aborted) && closeSeen && terminationDone) {
        done({
          ok: false,
          detail: abortDetail,
          aborted: true,
          ...(terminationFailure ? { cleanupFailed: true } : {}),
        })
      }
    }
    const startTermination = () => {
      if (!child || terminationStarted) return
      terminationStarted = true
      let termination
      try {
        termination = terminate(child)
      } catch (err) {
        termination = Promise.reject(err)
      }
      Promise.resolve(termination)
        .catch((err) => ({ ok: false, detail: `终止触发器失败：${err instanceof Error ? err.message : String(err)}` }))
        .then((result) => {
          terminationDone = true
          if (!result.ok) {
            terminationFailure = result.detail || '无法确认触发器后代已终止'
            abortDetail = `${abortDetail}；${terminationFailure}`
          }
          finishAborted()
        })
    }
    onAbort = () => {
      if (settled || aborting) return
      aborting = true
      abortPending = true
      startTermination()
      finishAborted()
    }
    // Register before spawn: Node's child_process AbortSignal handler otherwise
    // kills the shell before we can snapshot descendants that escaped its group.
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    try {
      child = spawnFn(shell, args, {
        ...opts,
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
    } catch (err) {
      const aborted = /** @type {Error} */ (err).name === 'AbortError' || aborting || opts.signal?.aborted
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}`, aborted })
      return
    }
    child.stdout?.on('data', (/** @type {any} */ d) => { stdout += d })
    child.stderr?.on('data', (/** @type {any} */ d) => { stderr += d })
    child.on('error', (/** @type {any} */ err) => {
      if (err.name === 'AbortError' || aborting || signal?.aborted) {
        aborting = true
        abortDetail = `${stderr.trim() || err.message || abortDetail}`
        startTermination()
        finishAborted()
        return
      }
      done({ ok: false, detail: `${stderr.trim() || err.message}` })
    })
    child.on('exit', (/** @type {any} */ code, /** @type {any} */ sig) => {
      exitSeen = true
      exitCode = code
      exitSignal = sig
      if (aborting || signal?.aborted) {
        finishAborted()
      } else if (!settled) {
        const detail = code === 0
          ? ''
          : `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}`
        done({ ok: code === 0, detail })
      }
    })
    child.on('close', (/** @type {any} */ code, /** @type {any} */ sig) => {
      closeSeen = true
      if (exitCode === null && exitSignal === null) {
        exitCode = code
        exitSignal = sig
      }
      if (aborting || signal?.aborted) {
        finishAborted()
      } else if (!settled) {
        const detail = exitCode === 0
          ? ''
          : `退出码 ${exitCode ?? exitSignal}: ${stderr.trim() || stdout.trim() || '无输出'}`
        done({ ok: exitCode === 0, detail })
      }
    })
    if (abortPending) startTermination()
  })
}

/**
 * 终止触发器进程组，避免 shell 的后代在取消后继续执行。
 * @param {any} child
 * @param {{platform?: string, spawnFn?: (command: string, args: string[], opts: object) => any, killFn?: (pid: number, signal: string) => (boolean | void)}} [opts]
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export function terminateProcessTree(child, { platform = process.platform, spawnFn = spawn, killFn = process.kill } = {}) {
  const pid = child?.pid
  if (Number.isInteger(pid) && pid > 0) {
    if (platform === 'win32') {
      return new Promise((resolve) => {
        let settled = false
        /** @type {number | null | undefined} */
        let exitCode
        const killDirectChild = () => {
          try {
            if (typeof child?.kill !== 'function') return false
            return child.kill('SIGKILL') !== false
          } catch {
            return false
          }
        }
        const reportFailure = (/** @type {string} */ detail) => {
          if (settled) return
          settled = true
          const direct = killDirectChild()
          Promise.resolve(terminateWindowsDescendants(pid, spawnFn))
            .then((treeResult) => {
              const directDetail = direct
                ? '已尝试直接终止 shell'
                : '直接终止 shell 也失败'
              const treeDetail = treeResult.ok
                ? '已尝试终止 Windows 后代树，但无法确认 taskkill 失败后的完整清理'
                : (treeResult.detail || 'Windows 后代树回退清理失败')
              resolve({ ok: false, detail: `${detail}；${treeDetail}；${directDetail}` })
            })
            .catch((err) => {
              resolve({
                ok: false,
                detail: `${detail}；Windows 后代树回退清理异常：${err instanceof Error ? err.message : String(err)}；` +
                  (direct ? '已尝试直接终止 shell' : '直接终止 shell 也失败'),
              })
            })
        }
        const reportSuccess = () => {
          if (settled) return
          settled = true
          resolve({ ok: true })
        }
        let killer
        try {
          killer = spawnFn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          })
        } catch (err) {
          reportFailure(`启动 taskkill 失败：${err instanceof Error ? err.message : String(err)}`)
          return
        }
        killer.on('error', (/** @type {Error} */ err) => reportFailure(`taskkill 失败：${err.message}`))
        killer.on('exit', (/** @type {number | null} */ code) => { exitCode = code })
        killer.on('close', (/** @type {number | null} */ code) => {
          const finalCode = code ?? exitCode
          if (finalCode === 0) reportSuccess()
          else reportFailure(`taskkill 失败（退出码 ${finalCode ?? 'unknown'}）`)
        })
      })
    } else {
      return terminatePosixProcessTree(child, pid, killFn, platform)
    }
  }
  let direct = false
  try {
    if (typeof child?.kill === 'function') direct = child.kill('SIGKILL') !== false
  } catch { /* 进程可能已经结束 */ }
  return Promise.resolve(direct
    ? { ok: true }
    : { ok: false, detail: '无法终止触发器 shell，后代状态未知' })
}

/**
 * 终止 POSIX 触发器进程组以及可能通过 setsid 脱离进程组的后代。
 * @param {any} child
 * @param {number} pid
 * @param {(pid: number, signal: string) => (boolean | void)} killFn
 * @param {string} platform
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
function terminatePosixProcessTree(child, pid, killFn, platform) {
  const descendants = collectDescendantPids(pid, platform)
  let groupError = ''
  let groupKilled = false
  try {
    const result = killFn(-pid, 'SIGKILL')
    if (result === false) throw new Error('进程组终止返回失败')
    groupKilled = true
  } catch (err) {
    groupError = err instanceof Error ? err.message : String(err)
  }

  /** @type {string[]} */
  const descendantFailures = []
  for (const descendantPid of descendants.pids) {
    try {
      const result = killFn(descendantPid, 'SIGKILL')
      if (result === false) descendantFailures.push(`${descendantPid} 返回失败`)
    } catch (err) {
      if (/** @type {{code?: string}} */ (err).code !== 'ESRCH') {
        descendantFailures.push(`${descendantPid}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (!groupKilled) {
    let direct = false
    try {
      if (typeof child?.kill === 'function') direct = child.kill('SIGKILL') !== false
    } catch { /* 进程可能已经结束 */ }
    return Promise.resolve({
      ok: false,
      detail: `进程组终止失败：${groupError || '未知错误'}；` +
        (direct ? '已尝试直接终止 shell，但无法确认后代已结束' : '直接终止 shell 也失败，后代状态未知'),
    })
  }
  if (!descendants.complete) {
    return Promise.resolve({
      ok: false,
      detail: `进程组已终止，但无法枚举脱离进程组的后代：${descendants.error || '未知错误'}`,
    })
  }
  if (descendantFailures.length > 0) {
    return Promise.resolve({
      ok: false,
      detail: `进程组已终止，但部分后代终止失败：${descendantFailures.join('；')}`,
    })
  }
  return Promise.resolve({ ok: true })
}

/**
 * 获取指定 PID 的后代快照。Linux 优先读取 /proc，其他 POSIX 系统回退到 ps。
 * @param {number} rootPid
 * @param {string} platform
 * @returns {{pids: number[], complete: boolean, error?: string}}
 */
function collectDescendantPids(rootPid, platform) {
  /** @type {Map<number, number[]>} */
  let childrenByParent
  try {
    if (platform === 'win32') return { pids: [], complete: true }
    childrenByParent = readProcParentMap()
  } catch (procErr) {
    try {
      childrenByParent = readPsParentMap()
    } catch (psErr) {
      return {
        pids: [],
        complete: false,
        error: `${procErr instanceof Error ? procErr.message : String(procErr)}；` +
          `${psErr instanceof Error ? psErr.message : String(psErr)}`,
      }
    }
  }
  /** @type {number[]} */
  const out = []
  /** @param {number} parent */
  const visit = (parent) => {
    for (const childPid of childrenByParent.get(parent) ?? []) {
      visit(childPid)
      out.push(childPid)
    }
  }
  visit(rootPid)
  return { pids: out, complete: true }
}

/** @returns {Map<number, number[]>} */
function readProcParentMap() {
  /** @type {Map<number, number[]>} */
  const childrenByParent = new Map()
  const entries = readdirSync('/proc', { withFileTypes: true })
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8')
      const closeParen = stat.lastIndexOf(')')
      if (closeParen < 0) continue
      const fields = stat.slice(closeParen + 1).trim().split(/\s+/)
      const parent = Number(fields[1])
      if (!Number.isInteger(parent) || parent <= 0) continue
      const children = childrenByParent.get(parent) ?? []
      children.push(pid)
      childrenByParent.set(parent, children)
    } catch { /* 进程可能在扫描时退出 */ }
  }
  return childrenByParent
}

/** @returns {Map<number, number[]>} */
function readPsParentMap() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) throw new Error(`ps 退出码 ${result.status ?? 'unknown'}`)
  /** @type {Map<number, number[]>} */
  const childrenByParent = new Map()
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 2) continue
    const pid = Number(fields[0])
    const parent = Number(fields[1])
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid <= 0 || parent <= 0) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(pid)
    childrenByParent.set(parent, children)
  }
  return childrenByParent
}

/**
 * Windows taskkill 失败后的后代树回退。PowerShell 先按 ParentProcessId 建树，
 * 再从叶子到根强制终止，即使根 shell 已经退出也能处理遗留后代。
 * @param {number} pid
 * @param {(command: string, args: string[], opts: object) => any} spawnFn
 * @returns {Promise<{ok: boolean, detail?: string}>}
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
  return new Promise((resolve) => {
    let cleaner
    try {
      cleaner = spawnFn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (err) {
      resolve({ ok: false, detail: `启动 Windows 后代树回退失败：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    let settled = false
    /** @type {number | null | undefined} */
    let exitCode
    /** @param {number | null | undefined} code */
    const finish = (code) => {
      if (settled) return
      settled = true
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, detail: `Windows 后代树回退退出码 ${code ?? 'unknown'}` })
    }
    try {
      cleaner.on('error', (/** @type {Error} */ err) => {
        if (!settled) {
          settled = true
          resolve({ ok: false, detail: `Windows 后代树回退失败：${err.message}` })
        }
      })
      cleaner.on('exit', (/** @type {number | null} */ code) => {
        exitCode = code
        finish(code)
      })
      cleaner.on('close', (/** @type {number | null} */ code) => finish(code ?? exitCode))
    } catch (err) {
      finish(null)
      if (err) return
    }
  })
}
