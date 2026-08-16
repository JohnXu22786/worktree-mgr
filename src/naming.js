/**
 * 任务名 ↔ 分支名的映射与校验。
 *
 * 设计要点：工具面向“任务”而非“分支”。用户给一个任务名，插件据此
 * 派生出稳定的分支名，并做两重防线：
 *   1. slugify 在源头保证派生分支永远合法；
 *   2. validateBranch 完整实现 git 的 ref 规则，作为显式分支参数的边界校验。
 */

const MAX_BRANCH_LENGTH = 255
const MAX_SLUG_LENGTH = 60
const MAX_TASK_LENGTH = 200

/**
 * 将任意任务名规范化为分支可用的 slug（全小写、非法字符转连字符）。
 * 允许 Unicode 字母/数字（含 CJK）、下划线、点、连字符、斜杠分段。
 * 返回的 slug 一定可以通过 validateBranch 的组件级检查
 * （段内不出现 ..、段不以 .lock 结尾、段不以 . 开头）。
 * @param {string | null | undefined} task
 * @returns {string}
 */
export function slugifyTask(task) {
  if (task === null || task === undefined) return 'task'
  const normalized = String(task).normalize('NFKC').toLowerCase()
  // 非法字符（非字母/数字/组合标记及 . _ - /）折叠为单个连字符
  const replaced = normalized.replace(/[^\p{L}\p{N}\p{M}._/-]+/gu, '-')
  // 分段处理：剔除空段、. 与 .. 段；并修正段内非法形态
  const segments = replaced
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .map((seg) => seg
      // 段内连续点（如 a..b）折叠为连字符
      .replace(/\.{2,}/g, '-')
      // 段不能以 .lock 结尾
      .replace(/\.lock$/g, '-lock')
      // 段不能以 . 开头
      .replace(/^\.+/g, ''))
    .filter((seg) => seg !== '')
  let slug = segments.join('/')
  // 折叠连续连字符，剥掉首尾的 - 与 .
  slug = slug.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (slug.length > MAX_SLUG_LENGTH) slug = slug.slice(0, MAX_SLUG_LENGTH)
  if (slug === '' || slug === '.') return 'task'
  return slug
}

/**
 * 由任务名派生分支名：<prefix>/<slug>。
 * @param {string} task
 * @param {string} [prefix='wtm'] 分支前缀（必须是单段合法 ref）
 * @returns {string}
 */
export function deriveBranch(task, prefix = 'wtm') {
  return `${prefix}/${slugifyTask(task)}`
}

/**
 * 校验分支名是否符合 git 的 ref 规则（check-ref-format 语义的纯函数版）。
 * @param {string} branch
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateBranch(branch) {
  if (typeof branch !== 'string') return { ok: false, reason: '分支名必须是字符串' }
  if (branch.length === 0) return { ok: false, reason: '分支名为空' }
  if (branch.length > MAX_BRANCH_LENGTH) {
    return { ok: false, reason: `分支名超过 ${MAX_BRANCH_LENGTH} 字符` }
  }
  if (branch.startsWith('-')) return { ok: false, reason: '分支名不能以 - 开头' }
  if (branch.startsWith('/')) return { ok: false, reason: '分支名不能以 / 开头' }
  if (branch.endsWith('/') || branch.endsWith('.')) {
    return { ok: false, reason: '分支名不能以 / 或 . 结尾' }
  }
  if (branch.includes('//')) return { ok: false, reason: '分支名不能包含连续 /' }
  if (branch.includes('..')) return { ok: false, reason: '分支名不能包含 ..' }
  if (branch.includes('@{')) return { ok: false, reason: '分支名不能包含 @{' }
  // 逐字符黑名单：空格、~ ^ : ? * [ \、控制字符
  for (const ch of branch) {
    if (/\s/u.test(ch)) return { ok: false, reason: `分支名不能包含空白字符: ${JSON.stringify(ch)}` }
    if ('~^:?*[\\'.includes(ch)) return { ok: false, reason: `分支名包含非法字符: ${JSON.stringify(ch)}` }
    if (/\p{C}/u.test(ch)) return { ok: false, reason: '分支名不能包含控制字符' }
  }
  // 分段规则：每段不能以 . 开头、不能以 .lock 结尾
  for (const seg of branch.split('/')) {
    if (seg.startsWith('.')) return { ok: false, reason: `分段不能以 . 开头: ${seg}` }
    if (seg.endsWith('.lock')) return { ok: false, reason: `分段不能以 .lock 结尾: ${seg}` }
  }
  return { ok: true }
}

/**
 * 校验分支前缀：必须是单段合法 ref（不能包含 /）。
 * @param {string} prefix
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validatePrefix(prefix) {
  const r = validateBranch(prefix)
  if (!r.ok) return r
  if (prefix.includes('/')) return { ok: false, reason: '前缀必须是单段，不能包含 /' }
  return { ok: true }
}

/**
 * 校验任务名：非空、长度受限。
 * @param {string} task
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateTask(task) {
  if (typeof task !== 'string' || task.trim() === '') {
    return { ok: false, reason: '任务名不能为空' }
  }
  if (task.length > MAX_TASK_LENGTH) {
    return { ok: false, reason: `任务名超过 ${MAX_TASK_LENGTH} 字符` }
  }
  return { ok: true }
}
