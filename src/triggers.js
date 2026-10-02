/**
 * 生命周期触发器：在关键节点执行仓库配置的 shell 命令。
 *
 * 命令通过平台 shell 执行（win32 用 cmd /c，其他平台用 sh -c），
 * 并注入 WTM_TASK / WTM_BRANCH / WTM_BASE / WTM_PATH / WTM_ROOT 环境变量。
 * 触发器失败只产生警告，绝不中断主流程。
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

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
 * @param {{spawn?: (shell: string, args: string[], opts: object) => object, cwd?: string, signal?: AbortSignal}} [opts]
 *        可注入 spawn 用于测试；cwd 指定命令的工作目录（默认继承进程目录）
 * @returns {Promise<{warnings: string[]}>}
 */
export async function runTriggers(commands, ctx, { spawn: spawnFn = spawn, cwd, signal } = {}) {
  /** @type {string[]} */
  const warnings = []
  if (commands === undefined) return { warnings }
  if (!Array.isArray(commands)) {
    warnings.push('触发器配置类型无效，必须是命令数组，已忽略')
    return { warnings }
  }
  const isWin = process.platform === 'win32'
  for (const [index, cmd] of commands.entries()) {
    if (signal?.aborted) return { warnings }
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
    const { ok, detail } = await runOne(spawnFn, shell, args, {
      env,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    })
    if (signal?.aborted) return { warnings }
    if (!ok) warnings.push(`触发器失败 [${cmd}]: ${detail}`)
  }
  return { warnings }
}

/**
 * 执行单个子进程并收集输出。
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {string} shell
 * @param {string[]} args
 * @param {{env: Record<string, string>, cwd?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, detail: string}>}
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
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}` })
      return
    }
    child.stdin?.end()
    let stdout = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let outputFlushed = false
    let errorDetail = ''
    let aborted = false
    let killRequested = false
    let settled = false
    let termination = Promise.resolve()
    /** @type {() => void} */
    let onAbort = () => {}
    const flushOutput = () => {
      if (outputFlushed) return
      outputFlushed = true
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
    }

    /** @param {NodeJS.Signals} signal */
    const terminate = (signal) => {
      const pid = child?.pid
      if (Number.isInteger(pid) && pid > 0 && process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          termination = new Promise((resolveTermination) => {
            killer.once('error', () => {
              try { child?.kill?.(signal) } catch { /* best effort */ }
              resolveTermination()
            })
            killer.once('close', (code) => {
              if (code !== 0) {
                try { child?.kill?.(signal) } catch { /* best effort */ }
              }
              resolveTermination()
            })
          })
        } catch {
          // fallback to child.kill below
        }
      } else if (Number.isInteger(pid) && pid > 0) {
        try {
          // POSIX detached children form their own process group; kill the group
          // so shell descendants do not outlive the trigger operation.
          process.kill(-pid, signal)
        } catch {
          // The group may have exited; child.kill below is still best effort.
        }
      }
      try { child?.kill?.(signal) } catch { /* best effort */ }
    }

    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort)
    }
    /**
     * @param {{ok: boolean, detail: string}} result
     */
    const done = (result) => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(result)
      }
    }
    onAbort = () => {
      if (killRequested || settled) return
      killRequested = true
      aborted = true
      // Kill the detached process group immediately: descendants can inherit
      // the shell's ignored SIGTERM disposition and otherwise outlive it.
      terminate('SIGKILL')
    }
    child.stdout?.on('data', (/** @type {any} */ d) => { stdout += stdoutDecoder.write(d) })
    child.stderr?.on('data', (/** @type {any} */ d) => { stderr += stderrDecoder.write(d) })
    child.on('error', (/** @type {any} */ err) => {
      if (err.name === 'AbortError' || opts.signal?.aborted) {
        aborted = true
        return
      }
      flushOutput()
      errorDetail = stderr.trim() || err.message
      done({ ok: false, detail: errorDetail })
    })
    child.on('close', (/** @type {any} */ code, /** @type {any} */ sig) => {
      flushOutput()
      if (aborted || opts.signal?.aborted) {
        void termination.then(() => done({ ok: false, detail: '' }))
        return
      }
      if (code === 0) {
        done({ ok: true, detail: '' })
      } else {
        done({ ok: false, detail: `退出码 ${code ?? sig}: ${errorDetail || stderr.trim() || stdout.trim() || '无输出'}` })
      }
    })
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true })
      if (opts.signal.aborted) onAbort()
    }
  })
}
