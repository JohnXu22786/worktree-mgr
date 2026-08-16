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
 * @param {{spawn?: (shell: string, args: string[], opts: object) => object, cwd?: string}} [opts]
 *        可注入 spawn 用于测试；cwd 指定命令的工作目录（默认继承进程目录）
 * @returns {Promise<{warnings: string[]}>}
 */
export async function runTriggers(commands, ctx, { spawn: spawnFn = spawn, cwd } = {}) {
  /** @type {string[]} */
  const warnings = []
  if (!Array.isArray(commands)) return { warnings }
  const isWin = process.platform === 'win32'
  for (const cmd of commands) {
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
    const { ok, detail } = await runOne(spawnFn, shell, args, { env, ...(cwd ? { cwd } : {}) })
    if (!ok) warnings.push(`触发器失败 [${cmd}]: ${detail}`)
  }
  return { warnings }
}

/**
 * 执行单个子进程并收集输出。
 * @param {(shell: string, args: string[], opts: object) => object} spawnFn
 * @param {string} shell
 * @param {string[]} args
 * @param {{env: Record<string, string>, cwd?: string}} opts
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function runOne(spawnFn, shell, args, opts) {
  return new Promise((resolve) => {
    /** @type {any} */
    let child
    try {
      child = spawnFn(shell, args, { ...opts, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, detail: `无法启动 shell: ${/** @type {Error} */ (err).message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    /**
     * @param {{ok: boolean, detail: string}} result
     */
    const done = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    child.stdout?.on('data', (/** @type {any} */ d) => { stdout += d })
    child.stderr?.on('data', (/** @type {any} */ d) => { stderr += d })
    child.on('error', (/** @type {any} */ err) => {
      done({ ok: false, detail: `${stderr.trim() || err.message}` })
    })
    child.on('exit', (/** @type {any} */ code, /** @type {any} */ sig) => {
      if (code === 0) {
        done({ ok: true, detail: '' })
      } else {
        done({ ok: false, detail: `退出码 ${code ?? sig}: ${stderr.trim() || stdout.trim() || '无输出'}` })
      }
    })
  })
}
