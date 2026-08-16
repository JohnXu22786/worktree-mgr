/**
 * worktree-mgr 插件入口（dsh 加载约定）。
 *
 * 模块导出：
 *   name  —— 插件名
 *   inject —— 依赖的服务（tools 注册表）
 *   apply —— 加载回调：注册全部工具
 *
 * 加载流程（由 dsh 的 Cordis 加载器执行）：
 *   1. 读取 package.json 的 dsh.bundle.patch 指向 cordis.patch.yml；
 *   2. patch 向 profile 插入 id=worktree-mgr 的插件行，name 指向本包；
 *   3. 加载器解析本模块，等待 inject 的 tools 服务就绪后调用 apply(ctx, config)；
 *   4. apply 将 5 个工具注册进 ctx.tools，schema 自动汇入模型提示词。
 *
 * 配置键（apply 第二参数，可由插件行 config 或用户 overlay 覆盖）：
 *   root  —— 主仓库路径（默认 process.cwd()）
 *   vault —— 工作区存放目录（默认平台数据目录）
 *   prefix —— 分支前缀（默认 wtm）
 *   commitMessage / mergeMessage —— 提交与合并消息模板
 *   更细的仓库级配置见 <root>/.wtm.json（README 有完整说明）。
 */

import { GitRunner } from './src/git.js'
import { createToolSet } from './src/tools.js'

export const name = 'worktree-mgr'
export const inject = ['tools']

/**
 * @param {{tools: {register: (def: object) => unknown}}} ctx dsh 上下文
 * @param {Record<string, unknown>} [config] 插件行配置
 */
export function apply(ctx, config = {}) {
  const git = new GitRunner()
  const tools = createToolSet({ config, git })
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
}
