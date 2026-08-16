/**
 * 配置解析与合并。
 *
 * 配置来源按优先级从低到高：
 *   1. 内置默认值
 *   2. 插件配置（dsh 插件行的 config，经 apply(ctx, config) 传入）
 *   3. 仓库级配置文件 <root>/.wtm.json
 *   4. 环境变量 WTM_*
 *
 * 仓库配置文件还承载 seed（文件种子）与 triggers（生命周期钩子），
 * 这两个键属于仓库语义，不会跨仓库生效。
 */

import { validatePrefix } from './naming.js'

/** 已知配置键（仓库文件与插件配置共用的键；seed/triggers 为仓库专属语义键） */
const KNOWN_KEYS = ['prefix', 'vault', 'commitMessage', 'mergeMessage', 'seed', 'triggers']

/**
 * @returns {{prefix: string, vault: string | null, commitMessage: string, mergeMessage: string}}
 */
export function defaults() {
  return {
    prefix: 'wtm',
    vault: null,
    commitMessage: 'chore(wtm): snapshot {task}',
    mergeMessage: 'merge(wtm): fold {task} into {base}',
  }
}

/**
 * 合并出最终配置。
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.pluginConfig] 插件行配置
 * @param {Record<string, string | undefined>} [opts.env] 环境变量（默认 process.env）
 * @param {Record<string, unknown> | null} [opts.repoConfig] 仓库 .wtm.json 解析结果
 * @returns {{prefix: string, vault: string | null, commitMessage: string, mergeMessage: string, warnings: string[]}}
 */
export function loadConfig({ pluginConfig = {}, env = process.env, repoConfig = null } = {}) {
  const warnings = []
  const cfg = defaults()

  const apply = (
    /** @type {Record<string, unknown> | null} */ source,
    /** @type {string} */ label,
  ) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (source))) {
      if (value === undefined || value === null || value === '') continue
      if (key === 'prefix' && typeof value === 'string') cfg.prefix = value
      else if (key === 'vault' && typeof value === 'string') cfg.vault = value
      else if (key === 'commitMessage' && typeof value === 'string') cfg.commitMessage = value
      else if (key === 'mergeMessage' && typeof value === 'string') cfg.mergeMessage = value
      else if (key === 'root' && label === '插件配置') {
        // 工具层消费，这里忽略
      } else if (key === 'seed' || key === 'triggers') {
        // 仓库语义键，由工具层单独读取
      } else {
        warnings.push(`${label}存在未知或类型不符的配置键: ${key}`)
      }
    }
  }

  apply(pluginConfig, '插件配置')
  apply(repoConfig, '仓库配置')

  // 环境变量覆盖
  const envMap = {
    WTM_PREFIX: 'prefix',
    WTM_VAULT: 'vault',
    WTM_COMMIT_MESSAGE: 'commitMessage',
    WTM_MERGE_MESSAGE: 'mergeMessage',
  }
  for (const [envKey, cfgKey] of Object.entries(envMap)) {
    const v = env?.[envKey]
    if (v === undefined || v === '') continue
    if (cfgKey === 'prefix') cfg.prefix = v
    else if (cfgKey === 'vault') cfg.vault = v
    else if (cfgKey === 'commitMessage') cfg.commitMessage = v
    else if (cfgKey === 'mergeMessage') cfg.mergeMessage = v
  }

  // 校验：前缀必须合法
  const prefixCheck = validatePrefix(cfg.prefix)
  if (!prefixCheck.ok) {
    warnings.push(`分支前缀非法（${cfg.prefix}）：${prefixCheck.reason}，已回退为默认值 wtm`)
    cfg.prefix = defaults().prefix
  }
  // 校验：消息模板必须是字符串
  for (const key of /** @type {const} */ (['commitMessage', 'mergeMessage'])) {
    if (typeof cfg[key] !== 'string' || cfg[key].trim() === '') {
      warnings.push(`消息模板 ${key} 无效，已回退为默认值`)
      cfg[key] = defaults()[key]
    }
  }
  // 校验：vault 必须是字符串
  if (cfg.vault !== null && typeof cfg.vault !== 'string') {
    warnings.push('vault 配置无效，已回退为默认目录')
    cfg.vault = null
  }

  return { ...cfg, warnings }
}

/**
 * 渲染消息模板：替换 {task} {branch} {base} 占位符。
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (vars[key] !== undefined ? vars[key] : whole))
}

/**
 * 解析仓库配置文本（.wtm.json）。
 * @param {string} text
 * @returns {{ok: true, value: Record<string, unknown> | null} | {ok: false, error: string}}
 */
export function parseRepoConfigText(text) {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, error: `.wtm.json JSON 解析失败: ${/** @type {Error} */ (err).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '.wtm.json 必须是 JSON 对象' }
  }
  return { ok: true, value: parsed }
}
