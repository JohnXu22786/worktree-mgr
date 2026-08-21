/**
 * dsh 工具定义：把生命周期编排包装成模型可调用的工具。
 *
 * 每个工具遵循 dsh 工具约定：
 *   { name, description, parameters, output: { schema, render }, execute(args, exec) }
 * - parameters 为扁平属性表，required: true 表示必填；
 * - output.schema 声明规范返回值，render 负责生成模型可见的文本；
 * - execute 返回规范 JSON 值，失败时返回 { ok: false, error } 而非抛异常。
 *
 * root 解析优先级：调用参数 root > 插件配置 config.root > 进程当前目录。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, parseRepoConfigText } from './config.js'
import { resolveToplevel } from './git.js'
import {
  begin,
  mergeTask,
  finishTask,
  listStatus,
  purge,
} from './ops.js'

/**
 * 插件配置（ops 层类型，此处引用）。
 * @typedef {import('./ops.js').PluginConfig} PluginConfig
 * @typedef {import('./ops.js').RepoConfig} RepoConfig
 */

/**
 * 读取仓库级配置 .wtm.json。
 * @param {string} root
 * @returns {{config: Record<string, unknown> | null, warnings: string[]}}
 */
export function readRepoConfig(root) {
  /** @type {string[]} */
  const warnings = []
  let text
  try {
    text = readFileSync(join(root, '.wtm.json'), 'utf8')
  } catch {
    return { config: null, warnings } // 无配置文件是常态
  }
  const parsed = parseRepoConfigText(text)
  if (!parsed.ok) {
    return { config: null, warnings: [`仓库配置 .wtm.json 解析失败，已忽略：${parsed.error}`] }
  }
  return { config: parsed.value, warnings }
}

/**
 * 工具定义形态（dsh 工具约定）。
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Record<string, object>} parameters
 * @property {{schema: object, render: (args: Record<string, unknown>, value: any) => Array<{type: string, text: string}>}} output
 * @property {(args: Record<string, unknown>, exec?: {signal?: AbortSignal}) => Promise<object>} execute
 */

/**
 * 工具调用前的公共准备：解析 root → 读取仓库配置 → 合并配置。
 * @param {{args: Record<string, unknown>, exec: {signal?: AbortSignal} | undefined, tool: {config: Record<string, unknown>}, git: {run: Function}}} input
 * @returns {Promise<{ok: false, error: string} | {ok: true, root: string, cfg: PluginConfig, repo: RepoConfig | null, warnings: string[]}>}
 */
async function prepare({ args, exec, tool, git }) {
  if (exec?.signal?.aborted) return { ok: false, error: '调用已取消（aborted）' }
  const candidate = typeof args.root === 'string'
    ? args.root
    : (typeof tool.config.root === 'string'
      ? tool.config.root
      : (typeof process.env.WTM_ROOT === 'string' && process.env.WTM_ROOT !== ''
        ? process.env.WTM_ROOT
        : process.cwd()))
  const resolved = await resolveToplevel(git, candidate, exec?.signal)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const repo = readRepoConfig(resolved.root)
  const cfg = loadConfig({
    pluginConfig: tool.config,
    env: process.env,
    repoConfig: repo.config,
  })
  return {
    ok: true,
    root: resolved.root,
    cfg,
    repo: repo.config,
    warnings: [...repo.warnings, ...cfg.warnings],
  }
}

/** @param {string} text */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * 组装全部工具定义。
 * @param {{config: Record<string, unknown>, git: {run: Function}}} opts
 * @returns {ToolDef[]}
 */
export function createToolSet(opts) {
  const { config, git } = opts

  /** @type {ToolDef[]} */
  const tools = []

  // ── wtm_begin：为任务创建隔离工作区 ──────────────────────────────────────
  tools.push({
    name: 'wtm_begin',
    description:
      '为一项任务创建隔离的 git 工作区：按任务名派生独立分支（形如 wtm/<任务名>），' +
      '在独立的目录中检出代码，任务间的改动互不干扰。创建后可自由在任务工作区中修改代码。' +
      '任务名与分支的对应关系会被记录，后续可用 wtm_merge / wtm_finish / wtm_status 管理。',
    parameters: {
      task: { type: 'string', required: true, description: '任务名，如 "add-search-box"。将据此自动生成分支名' },
      base: { type: 'string', description: '基分支名，默认取主工作区当前分支' },
      branch: { type: 'string', description: '显式指定分支名（默认由任务名派生）' },
      note: { type: 'string', description: '任务备注，记录在账本中' },
      root: { type: 'string', description: '仓库路径（默认取插件配置或当前目录）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          task: { type: 'string' },
          branch: { type: 'string' },
          base: { type: 'string' },
          path: { type: 'string' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return textBlock(`❌ 创建失败：${value.error}`)
        const lines = [
          `✅ 已创建任务工作区`,
          `任务: ${value.task}`,
          `分支: ${value.branch}（起始于 ${value.base}）`,
          `位置: ${value.path}`,
        ]
        for (const w of value.warnings ?? []) lines.push(`⚠️  ${w}`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const p = await prepare({ args, exec, tool: { config }, git })
      if (!p.ok) return p
      const a = /** @type {{task: string, base?: string, branch?: string, note?: string}} */ (args)
      const r = await begin({
        root: p.root, task: a.task, base: a.base, branch: a.branch,
        note: a.note, cfg: p.cfg, git, repo: p.repo, signal: exec?.signal,
      })
      if (!r.ok) return { ...r, warnings: p.warnings }
      return { ...r, warnings: [...p.warnings, ...(r.warnings ?? [])] }
    },
  })

  // ── wtm_merge：把任务改动合并回基分支（工作区保留） ─────────────────────
  tools.push({
    name: 'wtm_merge',
    description:
      '把任务分支的改动合并回账本记录的基分支（主工作区当前分支与该基分支不一致时会拒绝，' +
      '防止改动落错目标）。任务工作区会保留，可继续修改；合并前若有未提交改动，默认自动快照提交。' +
      '若基分支存在未提交改动则拒绝合并，防止混入未完成的工作。',
    parameters: {
      task: { type: 'string', required: true, description: '要同步的任务名' },
      mode: { type: 'string', enum: ['commit', 'refuse'], description: '任务工作区有未提交改动时的处理：commit=自动快照提交（默认），refuse=拒绝' },
      message: { type: 'string', description: '覆盖默认提交/合并消息（含 {task} {branch} {base} 占位符）' },
      root: { type: 'string', description: '仓库路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          committed: { type: 'boolean' },
          merged: { type: 'boolean' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return textBlock(`❌ 同步失败：${value.error}`)
        const parts = [`✅ 已同步任务 ${value.task} → ${value.base}`]
        if (value.committed) parts.push(`已自动快照提交任务工作区的改动`)
        if (value.merged) parts.push(`已合并分支 ${value.branch} 回 ${value.base}`)
        for (const w of value.warnings ?? []) parts.push(`⚠️  ${w}`)
        return textBlock(parts.join('\n'))
      },
    },
    async execute(args, exec) {
      const p = await prepare({ args, exec, tool: { config }, git })
      if (!p.ok) return p
      const a = /** @type {{task: string, mode?: string, message?: string}} */ (args)
      const r = await mergeTask({
        root: p.root, task: a.task, mode: a.mode, message: a.message,
        cfg: p.cfg, git, repo: p.repo, signal: exec?.signal,
      })
      if (!r.ok) return { ...r, warnings: p.warnings }
      return { ...r, warnings: [...p.warnings, ...(r.warnings ?? [])] }
    },
  })

  // ── wtm_finish：收尾任务并清理 ───────────────────────────────────────────
  tools.push({
    name: 'wtm_finish',
    description:
      '收尾一项任务：默认（commit 模式）先自动快照提交未提交改动，再合并回基分支，' +
      '然后移除任务工作区并删除任务分支。abandon 模式直接丢弃全部改动并强制清理；' +
      'keep 模式仅解除管理，保留工作区与分支。',
    parameters: {
      task: { type: 'string', required: true, description: '要收尾的任务名' },
      mode: { type: 'string', enum: ['commit', 'abandon', 'keep'], description: 'commit=提交并合并后清理（默认）；abandon=丢弃改动强制清理；keep=仅解除管理' },
      message: { type: 'string', description: '覆盖默认提交/合并消息' },
      root: { type: 'string', description: '仓库路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          committed: { type: 'boolean' },
          merged: { type: 'boolean' },
          removed: { type: 'boolean' },
          branchDeleted: { type: 'boolean' },
          note: { type: 'string' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return textBlock(`❌ 收尾失败：${value.error}`)
        if (value.note) return textBlock(`✅ ${value.note}`)
        const parts = [`✅ 任务 ${value.task} 已收尾`]
        if (value.committed) parts.push(`已快照提交任务改动`)
        if (value.merged) parts.push(`已合并回基分支`)
        parts.push(`工作区已移除${value.branchDeleted ? '，分支已删除' : ''}`)
        for (const w of value.warnings ?? []) parts.push(`⚠️  ${w}`)
        return textBlock(parts.join('\n'))
      },
    },
    async execute(args, exec) {
      const p = await prepare({ args, exec, tool: { config }, git })
      if (!p.ok) return p
      const a = /** @type {{task: string, mode?: string, message?: string}} */ (args)
      const r = await finishTask({
        root: p.root, task: a.task, mode: a.mode, message: a.message,
        cfg: p.cfg, git, repo: p.repo, signal: exec?.signal,
      })
      if (!r.ok) return { ...r, warnings: p.warnings }
      return { ...r, warnings: [...p.warnings, ...(r.warnings ?? [])] }
    },
  })

  // ── wtm_status：任务总览 ──────────────────────────────────────────────────
  tools.push({
    name: 'wtm_status',
    description:
      '列出所有进行中的任务：每个任务的工作区是否存在、是否有未提交改动、' +
      '分支与基分支的领先/落后提交数。用于决定哪些任务可以合并或收尾。',
    parameters: {
      root: { type: 'string', description: '仓库路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          rows: { type: 'array' },
          warnings: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return textBlock(`❌ 总览失败：${value.error}`)
        const rows = value.rows ?? []
        if (rows.length === 0) {
          return textBlock(`暂无进行中的任务。可用 wtm_begin 为任务创建隔离工作区。`)
        }
        const lines = [`进行中的任务（${rows.length}）：`, '']
        for (const r of rows) {
          const state = []
          if (!r.exists) state.push('工作区缺失')
          else {
            if (r.dirty) state.push('有未提交改动')
            if (r.counts) {
              if (r.counts.ahead > 0) state.push(`领先基分支 ${r.counts.ahead} 个提交`)
              if (r.counts.behind > 0) state.push(`落后基分支 ${r.counts.behind} 个提交`)
            }
          }
          lines.push(`• ${r.task}  [${r.branch} → ${r.base}]${state.length ? ' ' + state.join('，') : ''}`)
          lines.push(`    ${r.path}`)
        }
        for (const w of value.warnings ?? []) lines.push(`⚠️  ${w}`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const p = await prepare({ args, exec, tool: { config }, git })
      if (!p.ok) return p
      const r = await listStatus({ root: p.root, cfg: p.cfg, git, repo: p.repo, signal: exec?.signal })
      if (!r.ok) return { ...r, warnings: p.warnings }
      return { ...r, warnings: [...p.warnings, ...(r.warnings ?? [])] }
    },
  })

  // ── wtm_purge：批量清理 ──────────────────────────────────────────────────
  tools.push({
    name: 'wtm_purge',
    description:
      '批量收尾多个任务（或全部任务）。逐个执行与 wtm_finish 相同的流程，' +
      '单个任务失败不会中断其余任务；每个任务的结果单独报告。',
    parameters: {
      tasks: { type: 'array', items: { type: 'string' }, description: '要清理的任务名列表（与 all 二选一）' },
      all: { type: 'boolean', description: 'true 表示清理全部任务' },
      mode: { type: 'string', enum: ['commit', 'abandon', 'keep'], description: '同 wtm_finish 的 mode' },
      message: { type: 'string', description: '覆盖默认提交/合并消息' },
      root: { type: 'string', description: '仓库路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          results: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return textBlock(`❌ 批量清理失败：${value.error}`)
        const results = value.results ?? []
        const lines = [`批量清理完成（${results.length} 个任务）：`, '']
        for (const r of results) {
          lines.push(`• ${r.task}：${r.ok ? '✅ 完成' : `❌ ${r.error}`}${r.note ? `（${r.note}）` : ''}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const p = await prepare({ args, exec, tool: { config }, git })
      if (!p.ok) return p
      const a = /** @type {{tasks?: string[], all?: boolean, mode?: string, message?: string}} */ (args)
      const r = await purge({
        root: p.root, tasks: a.tasks, all: a.all === true, mode: a.mode,
        message: a.message, cfg: p.cfg, git, repo: p.repo, signal: exec?.signal,
      })
      return { ...r, warnings: p.warnings }
    },
  })

  return tools
}

