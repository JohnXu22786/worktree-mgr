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
  return { ok: true, root: r.stdout.replace(/\n$/, '') }
}

/**
 * 读取 `git worktree list` 的机器可读输出。
 * Git 2.36 之前不支持 `-z`，遇到该选项错误时回退到换行分隔格式。
 * @param {{run: Function}} git
 * @param {{cwd?: string, signal?: AbortSignal, env?: Record<string, string>}} [opts]
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string, aborted: boolean}>}
 */
export async function runWorktreeList(git, opts) {
  const nul = await git.run(['worktree', 'list', '--porcelain', '-z'], opts)
  // Git uses exit status 129 for command-line option errors, independent of locale.
  if (nul.ok || nul.code !== 129) {
    return nul
  }
  return git.run(['worktree', 'list', '--porcelain'], opts)
}

/**
 * 解析 `git worktree list --porcelain -z` 输出。
 * 兼容不带 `-z` 的换行分隔输出，以便处理旧的调用方。
 * @param {string} text
 * @returns {Array<{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean}>}
 */
export function parseWorktreeList(text) {
  /** @type {Array<{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean}>} */
  const out = []
  /** @type {{path: string, branch: string | null, detached: boolean, bare: boolean, locked: boolean} | null} */
  let current = null
  const consume = (/** @type {string} */ field) => {
    if (field.startsWith('worktree ')) {
      current = {
        path: field.slice('worktree '.length),
        branch: null,
        detached: false,
        bare: false,
        locked: false,
      }
      out.push(current)
    } else if (current) {
      if (field.startsWith('branch refs/heads/')) {
        current.branch = field.slice('branch refs/heads/'.length).trim()
      } else if (field === 'detached') {
        current.detached = true
      } else if (field === 'bare') {
        current.bare = true
      } else if (field.startsWith('locked')) {
        current.locked = true
      }
    }
  }

  if (text.includes('\0')) {
    for (const field of text.split('\0')) consume(field)
    return out
  }

  // Legacy porcelain has no record delimiter. The stable HEAD line lets us
  // keep newlines that belong to the path before parsing the record fields.
  const records = [...text.matchAll(/^worktree ([\s\S]*?)\r?\nHEAD [0-9a-f]+(?:\r?\n|$)/gm)]
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    consume(`worktree ${record[1]}`)
    const start = (record.index ?? 0) + record[0].length
    const end = records[i + 1]?.index ?? text.length
    for (const field of text.slice(start, end).split(/\r?\n/)) consume(field)
  }
  if (records.length === 0) {
    for (const field of text.split(/\r?\n/)) consume(field)
  }
  return out
}

/**
 * 解析 `git rev-list --left-right --count base...branch` 的输出（base 独有数、branch 独有数）。
 * @param {string} text
 * @returns {{ahead: number, behind: number} | null}
 */
export function parseAheadBehind(text) {
  const m = text.trim().match(/^(\d+)\s+(\d+)$/)
  if (!m) return null
  return { ahead: Number(m[2]), behind: Number(m[1]) }
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
