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
    const result = await runOne(spawnFn, shell, args, { env, ...(cwd ? { cwd } : {}), signal })
    if (!result.ok && !result.aborted) warnings.push(`触发器失败 [${cmd}]: ${result.detail}`)
    if (result.aborted || signal?.aborted) {
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
      const aborted = /** @type {Error} */ (err).name === 'AbortError' || opts.signal?.aborted
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}`, aborted })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborting = false
    let abortDetail = '操作已取消（aborted）'
    const signal = opts.signal
    /** @type {() => void} */
    let onAbort = () => {}
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
    onAbort = () => {
      if (settled || aborting) return
      aborting = true
      terminateProcessTree(child)
    }
    child.stdout?.on('data', (/** @type {any} */ d) => { stdout += d })
    child.stderr?.on('data', (/** @type {any} */ d) => { stderr += d })
    child.on('error', (/** @type {any} */ err) => {
      if (err.name === 'AbortError' || aborting || signal?.aborted) {
        aborting = true
        abortDetail = `${stderr.trim() || err.message || abortDetail}`
        terminateProcessTree(child)
        return
      }
      done({ ok: false, detail: `${stderr.trim() || err.message}` })
    })
    child.on('exit', (/** @type {any} */ code, /** @type {any} */ sig) => {
      if (aborting || signal?.aborted) {
        done({ ok: false, detail: abortDetail, aborted: true })
        return
      }
      if (code === 0) {
        done({ ok: true, detail: '' })
      } else {
        done({ ok: false, detail: `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}` })
      }
    })
    child.on('close', (/** @type {any} */ code, /** @type {any} */ sig) => {
      if (aborting || signal?.aborted) {
        done({ ok: false, detail: abortDetail, aborted: true })
      } else if (!settled) {
        const detail = code === 0
          ? ''
          : `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}`
        done({ ok: code === 0, detail })
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * 终止触发器进程组，避免 shell 的后代在取消后继续执行。
 * @param {any} child
 */
function terminateProcessTree(child) {
  const pid = child?.pid
  if (Number.isInteger(pid) && pid > 0) {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => {})
        killer.unref?.()
      } catch {
        try { child.kill?.('SIGKILL') } catch { /* 进程可能已经结束 */ }
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
