/**
 * git 命令执行层。
 *
 * 所有 git 交互都收敛到这里：统一注入 --no-pager / core.quotepath=false，
 * 返回结构化的 {ok, code, stdout, stderr}，并支持通过 AbortSignal 中止。
 * 解析逻辑（worktree list porcelain 等）为纯函数，便于单元测试。
 */

import { spawn, spawnSync } from 'node:child_process'

/**
 * 执行一条 git 命令。
 * @param {string[]} args
 * @param {{cwd?: string, signal?: AbortSignal, env?: Record<string, string>}} [opts]
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string, aborted: boolean}>}
 */
export function runGit(args, { cwd, signal, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    let settled = false
    /**
     * @param {{ok: boolean, code: number | null, stdout: string, stderr: string, aborted: boolean}} result
     */
    const done = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    child.on('error', (err) => {
      const aborted = err.name === 'AbortError'
      done({ ok: false, code: -1, stdout, stderr: aborted ? '' : stderr || err.message, aborted })
    })
    child.on('close', (code, codeSig) => {
      done({ ok: code === 0, code, stdout, stderr, aborted: codeSig !== null })
    })
  })
}

/** git 命令执行器（可替换为测试桩的接口面） */
export class GitRunner {
  /**
   * @param {string[]} args
   * @param {{cwd?: string, signal?: AbortSignal, env?: Record<string, string>}} [opts]
   */
  async run(args, opts) {
    return runGit(args, opts)
  }

  /** 探测本机是否可用 git（供测试 skip 判断） */
  static probe() {
    try {
      return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  }
}

/**
 * 解析候选路径，得到仓库顶层目录。
 * @param {{run: Function}} git
 * @param {string} candidate 候选路径（仓库内任意位置）
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: true, root: string} | {ok: false, error: string}>}
 */
export async function resolveToplevel(git, candidate, signal) {
  const r = await git.run(['rev-parse', '--show-toplevel'], { cwd: candidate, signal })
  if (!r.ok) {
    return { ok: false, error: `“${candidate}”不是 git 仓库：${r.stderr.trim() || 'rev-parse 失败'}` }
  }
  return { ok: true, root: r.stdout.trim() }
}

/**
 * 解析 `git worktree list --porcelain` 输出。
 * @param {string} text
 * @returns {Array<{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean}>}
 */
export function parseWorktreeList(text) {
  /** @type {Array<{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean}>} */
  const out = []
  /** @type {{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean} | null} */
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        detached: false,
        bare: false,
        locked: false,
      }
      out.push(current)
    } else if (current) {
      if (line.startsWith('branch refs/heads/')) {
        current.branch = line.slice('branch refs/heads/'.length).trim()
      } else if (line === 'detached') {
        current.detached = true
      } else if (line === 'bare') {
        current.bare = true
      } else if (line.startsWith('locked')) {
        current.locked = true
      }
    }
  }
  return out
}

/**
 * 解析 `git rev-list --left-right --count a...b` 的输出（a 领先数、b 领先数）。
 * @param {string} text
 * @returns {{ahead: number, behind: number} | null}
 */
export function parseAheadBehind(text) {
  const m = text.trim().match(/^(\d+)\s+(\d+)$/)
  if (!m) return null
  return { ahead: Number(m[1]), behind: Number(m[2]) }
}

/**
 * 由 `git status --porcelain` 输出判断工作区是否脏。
 * @param {string} text
 * @returns {boolean}
 */
export function isDirty(text) {
  return text.trim() !== ''
}

/**
 * Windows 下路径比较：归一化分隔符并忽略大小写。
 * git 的 porcelain 输出始终使用正斜杠，而本地拼出的路径可能带反斜杠，
 * 统一归一化后再比较，避免同一路径因分隔符差异匹配失败。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  const norm = (/** @type {string} */ p) => p.replace(/\\/g, '/')
  if (process.platform === 'win32') {
    return norm(a).toLowerCase() === norm(b).toLowerCase()
  }
  return a === b
}
