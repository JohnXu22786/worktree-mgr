# worktree-mgr

[English](README.md)

为 **dsh**（DeepSeek Harness，运行在 Cordis 插件框架之上的插件化 harness）提供「任务隔离工作区」能力的插件。

模型并行处理多个任务时，每个任务都在独立的 **git 工作区**（git worktree）与独立分支中完成，互不污染主工作区；任务结束自动提交、合并、清理。整个生命周期——**创建 / 同步 / 总览 / 收尾 / 批量清理**——由 5 个工具 + 1 个 CLI 覆盖，全程零手工 git 操作。

## 核心概念

| 概念 | 说明 |
|------|------|
| 任务（task） | 一项独立工作，如 `add-search-box`。工具以任务名为入口 |
| 分支 | 由任务名自动派生：`<prefix>/<任务slug>`，默认 `wtm/add-search-box`，也可显式指定 |
| 工作区 | 位于 vault 目录下（默认平台数据目录 `wtm/vaults/<仓库slug>/`），与主仓库隔离 |
| 账本 | vault 下的 `index.json`，持久化「任务 ↔ 分支 ↔ 路径」映射（JSON 格式，原子写入 + 互斥锁） |
| 基分支 | 任务合并的目标分支，默认主工作区当前分支 |

## 特性

- **任务驱动**：给模型一个任务名，分支名、路径、账本记录全部自动生成，无需指定分支
- **分支名安全**：任务名 → slug 规范化（段内 `..`、`.lock` 结尾、段首点等非法形态在源头修正），ref 合法性双重校验；不同任务派生同一 slug 时拒绝创建
- **未提交改动检测**：基分支脏时拒绝合并（防止混入未完成工作）；任务工作区脏时默认自动快照提交
- **合并目标一致性**：合并前校验「主工作区当前分支 == 账本基分支」「工作区当前分支 == 账本任务分支」，不一致一律拒绝——杜绝改动被提交到错误分支却报告成功的静默错误
- **同步与收尾分离**：`wtm_merge` 只合并不清理，`wtm_finish` 提交→合并→删工作区→删分支→清记录；重试场景自动跳过已完成的合并（不产生重复空 merge 提交）
- **批量清理**：`wtm_purge` 一次收尾多个任务，单任务失败不中断其余，任一失败即非零退出码
- **仓库级配置**：`<仓库根>/.wtm.json` 支持分支前缀、消息模板、种子文件（带路径越界防护）、生命周期触发器（固定工作目录）
- **并发安全**：账本写操作带互斥锁——锁内含唯一 token 与心跳刷新，陈旧锁仅在进程崩溃后回收，释放时绝不误删后继持有者的锁
- **失败恢复**：创建中途失败自动回滚已创建的 worktree 与分支；合并冲突给出 `git merge --abort` 恢复指引
- **跨平台**：Windows（cmd）与 POSIX（sh）触发器执行；路径比较大小写/分隔符归一化
- **零依赖、免构建**：纯 Node ESM，`node >= 21` 即可，安装即用

## 安装

### 在 DSH 中安装（从 GitHub）

从 GitHub 安装最新版本到 profile：

```bash
dsh plugin --profile demo add github:JohnXu22786/worktree-mgr
```

移除：

```bash
dsh plugin --profile demo remove worktree-mgr
```

### 方式一：作为 dsh bundle 安装（推荐）

在包含本目录的路径下：

```bash
dsh plugin --profile demo add ./worktree-mgr
```

- `package.json` 声明了 `dsh.bundle.patch → cordis.patch.yml`，dsh 会自动把插件行插入 profile 的配置层；
- 该层默认 `root: !!js process.cwd()`（以 dsh 启动目录为主仓库），可按需覆盖；
- 本包为纯 JavaScript，无构建步骤，从 git 安装也不会缺产物。

### 方式二：overlay 加载（不装进 profile）

```bash
dsh --profile demo --patch ./examples/overlay.yml
```

`overlay.yml` 与插件行配置结构一致，适合临时挂载或改配置。

### 方式三：独立 CLI

```bash
npm link            # 或 node bin/wtm.js ...
wtm begin "Add Search Box"
```

## 快速开始

```bash
# 1. 为任务创建隔离工作区（自动派生分支 wtm/add-search-box）
wtm begin "Add Search Box"

# 2. 在 <vault>/add-search-box 中自由修改代码
#    （或让模型在任务工作区目录中工作）

# 3. 查看所有任务的状态（脏/领先/落后）
wtm status

# 4. 只同步不回填清理：把任务改动合并回基分支，工作区保留
wtm merge "Add Search Box"

# 5. 收尾：快照提交 → 合并 → 移除工作区 → 删除分支 → 清账本
wtm finish "Add Search Box"

# 6. 批量收尾
wtm purge "Task A" "Task B"      # 指定任务
wtm purge --all                  # 全部任务
```

所有命令支持 `--json` 输出结构化结果，便于脚本与 harness 消费。

## CLI 参考

`bin/wtm.js` 可独立使用（`npm link` 后为 `wtm`，或 `node bin/wtm.js`）；每个子命令都支持 `--json`，结构化结果输出到 stdout。

| 命令 | 说明 | 退出码 |
|------|------|------|
| `wtm begin <task>` | 创建隔离工作区（`--base`、`--branch`、`--note`、`--root`） | 0 成功 / 1 失败 |
| `wtm merge <task>` | 任务分支合并回基分支，工作区保留（`--mode`、`--message`） | 0 / 1 |
| `wtm finish <task>` | 收尾并清理（`--mode`、`--message`） | 0 / 1 |
| `wtm status` | 全部任务总览 | 0 / 1 |
| `wtm purge [task...]` | 批量收尾；`--all` 表示全部 | 0，任一任务失败为 1 |
| `wtm help` | 打印用法 | 0（裸 `wtm` 为 2） |

退出码语义：`0` 成功；`1` 操作失败（`--json` 模式下失败信息在 JSON 载荷中，且 `purge` 任一子任务失败同样为 1）；`2` 用法错误（未知或缺失命令）。`WTM_*` 环境变量对 CLI 同样生效。

## 工具接口（模型可见）

| 工具 | 作用 | 关键参数 |
|------|------|----------|
| `wtm_begin` | 为任务创建隔离工作区 | `task`(必填), `base`, `branch`, `note`, `root` |
| `wtm_merge` | 同步：任务分支合并回基分支（工作区保留） | `task`(必填), `mode`(commit/refuse), `message`, `root` |
| `wtm_finish` | 收尾：提交→合并→清理工作区与分支 | `task`(必填), `mode`(commit/abandon/keep), `message`, `root` |
| `wtm_status` | 任务总览（存在性/脏状态/领先落后） | `root` |
| `wtm_purge` | 批量收尾 | `tasks`, `all`, `mode`, `message`, `root` |

**mode 语义**

- `commit`（默认）：先自动快照提交任务工作区的未提交改动，再合并回基分支，最后清理
- `refuse`：任务工作区有未提交改动时直接拒绝（仅 `wtm_merge`）
- `abandon`：丢弃任务全部改动，强制清理工作区并删除分支（不可恢复，谨慎使用）
- `keep`：仅解除管理，工作区与分支原样保留（仅 `wtm_finish`）

**安全边界**（工具与 CLI 一致）：

- 基分支工作区存在未提交改动 → 拒绝合并（`wtm_merge` / `wtm_finish` 的 commit 模式）
- 主工作区当前分支与账本基分支不一致、任务工作区当前分支与账本记录不一致 → 拒绝操作（防止改动落错分支）
- 任务分支已存在、任务已登记、工作区目录已存在、不同任务派生同一工作区路径 → 拒绝创建
- 任务名或分支名非法（git ref 规则）→ 在任何 git 操作之前拒绝
- 种子文件路径越界（`../x` 等逃逸仓库/工作区）→ 拦截并告警
- 调用被取消（`exec.signal` abort）→ 干净返回；创建中途失败自动回滚已创建的 worktree 与分支

## 插件接入说明（harness 如何加载它）

本插件遵循 dsh 的标准插件协议，共三块拼图：

```
worktree-mgr/
├── package.json        # ① dsh.bundle manifest：声明本包是一个配置层
├── cordis.patch.yml    # ② 配置层内容：向 profile 插入插件行
├── index.js            # ③ 入口模块：导出 name / inject / apply
└── src/                # 实现：naming/config/vault/git/triggers/ops/tools
```

**① bundle manifest**（`package.json`）：

```json
{
  "name": "worktree-mgr",
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**② 配置层**（`cordis.patch.yml`）：

```yaml
- insert:
    - id: worktree-mgr
      name: worktree-mgr        # 按包名解析，Node 模块解析找到 index.js
      config:
        root: !!js process.cwd()
```

**③ 入口模块**（`index.js`）导出：

```js
export const name = 'worktree-mgr'
export const inject = ['tools']              // 声明依赖 tools 注册表
export function apply(ctx, config = {}) {
  ctx.tools.register(...)                    // 注册 5 个工具
}
```

加载顺序：profile 组装 → 本 bundle 的 patch 层插入插件行 → 加载器等待 `tools` 服务就绪 → 调用 `apply(ctx, config)` → 工具 schema 自动汇入系统提示词，模型即可调用。

**工具定义形态**（与 dsh 工具约定一致）：

```js
{
  name: 'wtm_status',
  description: '...',                        // 模型可见描述
  parameters: {                              // 扁平属性表，required: true 为必填
    root: { type: 'string', description: '仓库路径' }
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean', required: true }, ... } },
    render: (args, value) => [{ type: 'text', text: '...' }]   // 模型可见内容
  },
  async execute(args, exec) { ... }          // 返回规范 JSON；exec.signal 支持取消
}
```

**事件/钩子接口**：插件本身不订阅 harness 事件；生命周期扩展通过仓库级配置的 **触发器**（triggers）实现——在 `on_begin` / `on_merge` / `on_finish` 三个节点执行仓库配置的 shell 命令，注入 `WTM_TASK` / `WTM_BRANCH` / `WTM_BASE` / `WTM_PATH` / `WTM_ROOT` 环境变量。触发器有固定工作目录：`on_begin` 在新工作区内执行，`on_merge` / `on_finish` 在主仓库根目录执行。触发器失败只记警告，不中断主流程。

## 配置

优先级（低 → 高）：**内置默认 < 插件行 config < 仓库 `.wtm.json` < 环境变量 `WTM_*`**

| 键 | 默认 | 说明 |
|----|------|------|
| `root` | `process.cwd()` | 主仓库路径（仅插件行/工具参数） |
| `vault` | 平台数据目录 `wtm/vaults/<仓库slug>/` | 任务工作区与账本存放目录；相对路径按仓库路径解析 |
| `prefix` | `wtm` | 分支前缀，派生分支为 `<prefix>/<slug>` |
| `commitMessage` | `chore(wtm): snapshot {task}` | 快照提交模板，占位符 `{task}` `{branch}` `{base}` |
| `mergeMessage` | `merge(wtm): fold {task} into {base}` | 合并提交模板 |

环境变量：`WTM_ROOT`（工具与 CLI 均生效）、`WTM_VAULT`、`WTM_PREFIX`、`WTM_COMMIT_MESSAGE`、`WTM_MERGE_MESSAGE`（`WTM_ROOT` 优先级低于工具参数与插件配置）。

### 仓库级配置 `<仓库根>/.wtm.json`

```json
{
  "prefix": "wtm",
  "vault": "D:/wtm-vaults",
  "commitMessage": "chore(wtm): snapshot {task}",
  "mergeMessage": "merge(wtm): fold {task} into {base}",
  "seed": { "files": ["docs/AGENTS.md"] },
  "triggers": {
    "on_begin": ["pnpm install"],
    "on_merge": ["pnpm lint"],
    "on_finish": []
  }
}
```

- `vault` **必须位于仓库工作树之外**（否则主工作区会被 vault 目录持续弄脏，插件会直接拒绝）；
- `seed.files`：创建任务工作区时从主仓库复制到工作区的文件（如团队约定文档）；路径必须位于仓库/工作区内，越界条目会被拦截并告警；
- `triggers.*`：生命周期钩子命令数组，见上文「事件/钩子接口」。

未知键会产生警告并被忽略；损坏的 `.wtm.json` 不阻塞操作，仅告警。

## 安全说明（重要）

- **仓库配置即代码**：`.wtm.json` 的 `seed.files` 会把仓库内的文件复制进工作区，`triggers.*` 会以当前用户权限执行任意 shell 命令。**只应在可信仓库中启用本插件**——克隆并操作不可信仓库时，仓库自带的 `.wtm.json` 等同于自动获得你的执行权限。无需此能力时留空 `seed`/`triggers` 即可。
- **快照提交包含未跟踪文件**：任务工作区脏时，默认快照会 `git add -A` 提交全部改动（含未跟踪文件，如构建产物）。不想把大目录纳入历史，请先在任务工作区维护 `.gitignore`，或使用 `refuse` 模式手动处理。
- **abandon 不可恢复**：`wtm_finish --mode abandon` 与批量 `wtm_purge` 会强制删除工作区并删除任务分支（`-D`），其中的改动无法恢复，仅应在确认丢弃时使用。

## 账本与并发

- 账本：`<vault>/index.json`，`{version: 1, records: [{task, branch, base, path, createdAt, updatedAt, note?}]}`
- 写入原子（临时文件 + rename），且全程持有 `.lock` 互斥锁；
- 锁内含持有者唯一 token 与 30s 心跳刷新：进程崩溃后锁超过 5 分钟判定陈旧并回收；释放时校验 token，绝不误删后继持有者的锁；等待超时默认 5 秒。

## 开发与测试

```bash
npm test          # node --test，零第三方依赖
npm run typecheck # 可选：需 dev 安装 typescript + @types/node
```

测试覆盖：命名规则、配置合并、账本（原子写/锁/陈旧回收/损坏恢复）、git 输出解析、触发器、生命周期编排（fake git 注入）、工具 schema、以及调用真实 git 的集成测试（begin → 改文件 → status → finish 全链路）。

## 目录结构

```
worktree-mgr/
├── package.json          # bundle manifest + 元数据
├── cordis.patch.yml      # 插件配置层
├── index.js              # dsh 插件入口（name/inject/apply）
├── bin/wtm.js            # 独立 CLI
├── src/
│   ├── naming.js         # 任务名→分支映射与 ref 校验
│   ├── config.js         # 配置合并与模板渲染
│   ├── vault.js          # 账本持久化（原子写/锁）
│   ├── git.js            # git 执行层与输出解析
│   ├── triggers.js       # 生命周期触发器
│   ├── ops.js            # 生命周期编排（begin/merge/finish/status/purge）
│   └── tools.js          # dsh 工具定义
├── examples/
│   ├── .wtm.json.example # 仓库配置示例
│   └── overlay.yml       # dsh overlay 示例
└── tests/                # node:test 单元 + 集成测试
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
