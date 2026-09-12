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
    try {
      child = spawnFn(shell, args, {
        ...opts,
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
      })
    } catch (err) {
      const aborted = /** @type {Error} */ (err).name === 'AbortError' || opts.signal?.aborted
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}`, aborted })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborting = false
    let abortDetail = '操作已取消（aborted）'
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
      if (terminationStarted) return
      terminationStarted = true
      Promise.resolve(terminate(child))
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
      startTermination()
      finishAborted()
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
      exitCode = code
      exitSignal = sig
      finishAborted()
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
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * 终止触发器进程组，避免 shell 的后代在取消后继续执行。
 * @param {any} child
 * @param {{platform?: string, spawnFn?: (command: string, args: string[], opts: object) => any}} [opts]
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export function terminateProcessTree(child, { platform = process.platform, spawnFn = spawn } = {}) {
  const pid = child?.pid
  if (Number.isInteger(pid) && pid > 0) {
    if (platform === 'win32') {
      return new Promise((resolve) => {
        let settled = false
        /** @type {number | null | undefined} */
        let exitCode
        const fallback = () => {
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
          const fallbackDetail = fallback()
            ? '已尝试直接终止 shell，但无法确认后代已结束'
            : '直接终止 shell 也失败，后代状态未知'
          resolve({ ok: false, detail: `${detail}；${fallbackDetail}` })
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
      try {
        process.kill(-pid, 'SIGKILL')
        return Promise.resolve({ ok: true })
      } catch { /* 进程组可能已经结束 */ }
    }
  }
  try {
    child?.kill?.('SIGKILL')
  } catch { /* 进程可能已经结束 */ }
  return Promise.resolve({ ok: true })
}
