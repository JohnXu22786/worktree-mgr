#!/usr/bin/env node
/**
 * worktree-mgr 命令行入口。
 *
 * 独立于 dsh 使用：`wtm begin "任务名"` 之类，也便于脚本/harness 以子进程方式接入。
 * 所有子命令支持 --json 输出结构化结果。
 *
 * 用法：
 *   wtm begin <task>   [--base b] [--branch br] [--note n] [--root d] [--json]
 *   wtm merge <task>   [--mode commit|refuse] [--message s] [--root d] [--json]
 *   wtm finish <task>  [--mode commit|abandon|keep] [--message s] [--root d] [--json]
 *   wtm status         [--root d] [--json]
 *   wtm purge [task...] [--all] [--mode m] [--root d] [--json]
 */

import { GitRunner, resolveToplevel } from '../src/git.js'
import { loadConfig } from '../src/config.js'
import { readRepoConfig } from '../src/tools.js'
import { begin, mergeTask, finishTask, listStatus, purge } from '../src/ops.js'

function usage() {
  return `worktree-mgr —— 任务隔离工作区管理

用法:
  wtm begin <task>   [--base b] [--branch br] [--note n] [--root dir] [--json]
  wtm merge <task>   [--mode commit|refuse] [--message msg] [--root dir] [--json]
  wtm finish <task>  [--mode commit|abandon|keep] [--message msg] [--root dir] [--json]
  wtm status         [--root dir] [--json]
  wtm purge [task...] [--all] [--mode commit|abandon|keep] [--root dir] [--json]
  wtm help

环境变量: WTM_ROOT, WTM_VAULT, WTM_PREFIX, WTM_COMMIT_MESSAGE, WTM_MERGE_MESSAGE`
}

/**
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
 * @property {Array<{task: string, branch: string, base: string, path: string, exists: boolean, dirty: boolean, counts: {ahead: number, behind: number} | null}>} [rows]
 * @property {Array<{task: string, ok: boolean, error?: string, note?: string}>} [results]
 * @property {string[]} [warnings]
 */

/**
 * 简单参数解析：支持 --key value 与 --flag（布尔）。
 * @param {string[]} argv
 * @returns {{positional: string[], options: Record<string, string | boolean>}}
 */
function parseArgs(argv) {
  const positional = []
  /** @type {Record<string, string | boolean>} */
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        i++
      } else {
        options[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, options }
}

/**
 * @param {OpResult} result
 * @param {boolean} json
 * @returns {number} 退出码
 */
function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    // 批量清理（purge）的失败体现在 results 子项：任一失败即非零退出码
    if (!result.ok) return 1
    if (Array.isArray(result.results) && result.results.some((r) => r.ok === false)) return 1
    return 0
  }
  if (!result.ok) {
    process.stderr.write(`错误：${result.error}\n`)
    return 1
  }
  let exitCode = 0
  if (result.note) {
    process.stdout.write(`${result.note}\n`)
  }
  if (Array.isArray(result.results)) {
    for (const r of result.results) {
      process.stdout.write(`• ${r.task}：${r.ok ? '完成' : `失败：${r.error}`}${r.note ? `（${r.note}）` : ''}\n`)
      if (!r.ok) exitCode = 1
    }
  }
  if (Array.isArray(result.rows)) {
    if (result.rows.length === 0) {
      process.stdout.write('暂无进行中的任务。\n')
    } else {
      process.stdout.write(`进行中的任务（${result.rows.length}）：\n`)
      for (const r of result.rows) {
        const state = []
        if (!r.exists) state.push('工作区缺失')
        else if (r.dirty) state.push('有未提交改动')
        if (r.counts) {
          if (r.counts.ahead > 0) state.push(`领先 ${r.counts.ahead}`)
          if (r.counts.behind > 0) state.push(`落后 ${r.counts.behind}`)
        }
        process.stdout.write(`• ${r.task}  [${r.branch} → ${r.base}]${state.length ? ' ' + state.join('，') : ''}\n`)
      }
    }
  } else if (result.branch && result.path) {
    process.stdout.write(`任务 ${result.task} 已创建\n分支: ${result.branch}\n位置: ${result.path}\n`)
  } else if (result.merged || result.removed) {
    const parts = [`任务 ${result.task} 已处理`]
    if (result.committed) parts.push('已快照提交')
    if (result.merged) parts.push('已合并')
    if (result.removed) parts.push('工作区已移除')
    process.stdout.write(`${parts.join('，')}\n`)
  } else if (result.task) {
    // 成功但无强动作（如 merge 发现已合并跳过）——给出确认而非静默
    const parts = [`任务 ${result.task} 已处理`]
    if (result.committed) parts.push('已快照提交')
    if (result.merged === false) parts.push('分支已包含在基分支中，跳过合并')
    process.stdout.write(`${parts.join('，')}\n`)
  }
  for (const w of result.warnings ?? []) process.stdout.write(`警告：${w}\n`)
  return exitCode
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${usage()}\n`)
    return argv.length === 0 ? 2 : 0
  }
  const command = argv[0]
  const { positional, options } = parseArgs(argv.slice(1))
  const json = options.json === true
  const root = typeof options.root === 'string' ? options.root : process.env.WTM_ROOT || process.cwd()

  const git = new GitRunner()
  const resolved = await resolveToplevel(git, root, undefined)
  if (!resolved.ok) {
    return printResult(resolved, json)
  }
  const repo = readRepoConfig(resolved.root)
  const cfg = loadConfig({ pluginConfig: {}, env: process.env, repoConfig: repo.config })

  /** @type {OpResult} */
  let result
  const common = {
    root: resolved.root, cfg, git, repo: repo.config,
  }
  try {
    switch (command) {
      case 'begin': {
        const task = positional[0]
        result = await begin({
          ...common,
          task,
          base: typeof options.base === 'string' ? options.base : undefined,
          branch: typeof options.branch === 'string' ? options.branch : undefined,
          note: typeof options.note === 'string' ? options.note : undefined,
        })
        break
      }
      case 'merge': {
        result = await mergeTask({
          ...common,
          task: positional[0],
          mode: typeof options.mode === 'string' ? options.mode : undefined,
          message: typeof options.message === 'string' ? options.message : undefined,
        })
        break
      }
      case 'finish': {
        result = await finishTask({
          ...common,
          task: positional[0],
          mode: typeof options.mode === 'string' ? options.mode : undefined,
          message: typeof options.message === 'string' ? options.message : undefined,
        })
        break
      }
      case 'status': {
        result = await listStatus(common)
        break
      }
      case 'purge': {
        result = await purge({
          ...common,
          tasks: positional,
          all: options.all === true,
          mode: typeof options.mode === 'string' ? options.mode : undefined,
          message: typeof options.message === 'string' ? options.message : undefined,
        })
        break
      }
      default:
        process.stderr.write(`未知命令：${command}\n\n${usage()}\n`)
        return 2
    }
  } catch (err) {
    result = { ok: false, error: `意外错误：${/** @type {Error} */ (err).message}` }
  }

  result.warnings = [...repo.warnings, ...cfg.warnings, ...(result.warnings ?? [])]
  return printResult(result, json)
}

main().then((code) => {
  process.exitCode = code
}).catch((err) => {
  process.stderr.write(`意外错误：${err?.message ?? err}\n`)
  process.exitCode = 1
})
