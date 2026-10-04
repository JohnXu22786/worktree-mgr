import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { GitRunner, resolveToplevel, samePath } from '../src/git.js'
import { createMergeGuard } from '../src/merge-guard.js'
import { begin, mergeTask, finishTask, listStatus } from '../src/ops.js'
import { loadLedger } from '../src/vault.js'
import { apply } from '../index.js'

const HAS_GIT = (() => {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})()

/**
 * @param {string[]} args
 * @param {string | undefined} cwd
 */
function gitOk(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}
async function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wtm-it-'))
  const r0 = gitOk(['init', '-b', 'main'], root)
  assert.equal(r0.status, 0)
  gitOk(['config', 'user.name', 'wtm-test'], root)
  gitOk(['config', 'user.email', 'wtm@example.test'], root)
  gitOk(['config', 'commit.gpgsign', 'false'], root)
  gitOk(['config', 'core.autocrlf', 'false'], root)
  writeFileSync(join(root, 'a.txt'), 'base\n')
  gitOk(['add', 'a.txt'], root)
  assert.equal(gitOk(['commit', '-m', 'init'], root).status, 0)
  return root
}

/** 集成测试的 vault 必须放在仓库之外（否则主工作区会被 vault 目录弄脏） */
function makeVault() {
  return mkdtempSync(join(tmpdir(), 'wtm-it-vault-'))
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** @param {string} directory @param {string} name @param {string} body */
function installHook(directory, name, body) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

class MergeRaceGit extends GitRunner {
  /** @param {() => void} beforeMerge */
  constructor(beforeMerge) {
    super()
    this.beforeMerge = beforeMerge
  }

  /** @param {string[]} args @param {Parameters<GitRunner['run']>[1]} opts */
  async run(args, opts) {
    if (args.includes('merge')) this.beforeMerge()
    return super.run(args, opts)
  }
}

class BranchSwitchBeforeSnapshotCommitGit extends GitRunner {
  /** @type {boolean} */
  switched

  constructor() {
    super()
    this.switched = false
  }

  /** @param {string[]} args @param {Parameters<GitRunner['run']>[1]} opts */
  async run(args, opts) {
    if (!this.switched && args.includes('commit')) {
      this.switched = true
      const switchBranch = await super.run(['symbolic-ref', 'HEAD', 'refs/heads/other'], opts)
      if (!switchBranch.ok) return switchBranch
    }
    return super.run(args, opts)
  }
}

for (const directory of [
  'vault with spaces', 'vault "quoted"', 'vault\nwith newline',
  'vault\nHEAD deadbeef\nbranch refs/heads/other', 'vault\\literal\tcarriage\rinside',
]) {
  test(`集成：插件入口保留工作区路径 ${JSON.stringify(directory)}`, {
    skip: !HAS_GIT || (process.platform === 'win32' && /["\x00-\x1f]/.test(directory)),
    timeout: 120000,
  }, async () => {
    const root = await makeRepo()
    const vaultParent = makeVault()
    const vault = join(vaultParent, directory)
    /** @type {Map<string, import('../src/tools.js').ToolDef>} */
    const tools = new Map()
    apply({ tools: { register: (tool) => {
      const definition = /** @type {import('../src/tools.js').ToolDef} */ (tool)
      tools.set(definition.name, definition)
    } } }, { root, vault })
    const call = async (/** @type {string} */ name, /** @type {Record<string, unknown>} */ args = {}) => {
      const tool = tools.get(name)
      assert.ok(tool)
      return /** @type {any} */ (await tool.execute(args))
    }
    try {
      const b = await call('wtm_begin', { task: 'Path Handling' })
      assert.equal(b.ok, true, b.error ?? '')
      const taskPath = join(vault, 'path-handling')
      assert.equal(b.path, taskPath)
      writeFileSync(join(taskPath, 'a.txt'), 'base\n+first change\n')

      const status = await call('wtm_status')
      assert.equal(status.ok, true, status.error ?? '')
      assert.equal(status.rows[0].path, taskPath)
      assert.equal(status.rows[0].exists, true, '已创建的工作区应仍被识别')
      assert.equal(status.rows[0].dirty, true, '未提交改动应被识别')

      const merge = await call('wtm_merge', { task: 'Path Handling' })
      assert.equal(merge.ok, true, merge.error ?? '')
      assert.equal(merge.merged, true)
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'base\n+first change\n')
      assert.equal(existsSync(taskPath), true)

      writeFileSync(join(taskPath, 'a.txt'), 'base\n+first change\n+second change\n')
      const finish = await call('wtm_finish', { task: 'Path Handling' })
      assert.equal(finish.ok, true, finish.error ?? '')
      assert.equal(finish.committed, true)
      assert.equal(finish.merged, true)
      assert.equal(finish.removed, true)
      assert.equal(finish.branchDeleted, true)
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'base\n+first change\n+second change\n')
      assert.equal(existsSync(taskPath), false)
      assert.notEqual(gitOk(['show-ref', '--verify', 'refs/heads/wtm/path-handling'], root).status, 0)
      assert.equal(loadLedger(vault).records.length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vaultParent, { recursive: true, force: true })
    }
  })
}

test('集成：非 Git 目录的未知命令先报用法错误', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-'))
  const cli = fileURLToPath(new URL('../bin/wtm.js', import.meta.url))
  const env = { ...process.env }
  delete env.WTM_ROOT
  try {
    const result = spawnSync(process.execPath, [cli, 'unknown-command'], {
      cwd,
      encoding: 'utf8',
      env,
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /未知命令：unknown-command/)
    assert.doesNotMatch(result.stderr, /不是 git 仓库/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('集成：base 只接受真实分支名，拒绝 revision expression', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  try {
    writeFileSync(join(root, 'second.txt'), 'second\n')
    assert.equal(gitOk(['add', 'second.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'second'], root).status, 0)

    const b = await begin({ root, task: 'Revision Base', base: 'main^', cfg, git, repo: null })
    assert.equal(b.ok, false)
    assert.match(b.error ?? '', /基分支不存在：main\^/)
    assert.equal(existsSync(join(vault, 'revision-base')), false)
    assert.equal(loadLedger(vault).records.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：base 为 @ 时按字面分支创建工作区并统计状态', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  let created = false
  try {
    assert.equal(gitOk(['branch', '@'], root).status, 0)
    writeFileSync(join(root, 'second.txt'), 'second\n')
    assert.equal(gitOk(['add', 'second.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'second'], root).status, 0)
    writeFileSync(join(root, 'third.txt'), 'third\n')
    assert.equal(gitOk(['add', 'third.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'third'], root).status, 0)

    const baseHead = gitOk(['rev-parse', 'refs/heads/@'], root).stdout.trim()
    const currentHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    assert.notEqual(baseHead, currentHead)

    const b = await begin({ root, task: 'At Base', base: '@', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    created = true
    const worktreePath = /** @type {string} */ (b.path)
    assert.equal(gitOk(['rev-parse', 'HEAD'], worktreePath).stdout.trim(), baseHead)

    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)

    const advancedBaseHead = gitOk(['rev-parse', 'main^'], root).stdout.trim()
    assert.notEqual(advancedBaseHead, baseHead)
    assert.equal(gitOk(['update-ref', 'refs/heads/@', advancedBaseHead], root).status, 0)

    const s = await listStatus({ root, cfg, git, repo: null })
    const row = s.rows?.find((x) => x.task === 'At Base')
    assert.deepEqual(row?.counts, { ahead: 1, behind: 1 })
  } finally {
    if (created) {
      const f = await finishTask({ root, task: 'At Base', mode: 'abandon', cfg, git, repo: null })
      assert.equal(f.ok, true, f.error ?? '')
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：status 对任务分支使用完整 refs/heads 引用（避免同名 tag）', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  let worktreePath
  try {
    const b = await begin({ root, task: 'Literal Ref Status', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)

    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
    assert.equal(gitOk(['tag', 'wtm/literal-ref-status'], root).status, 0)

    const s = await listStatus({ root, cfg, git, repo: null })
    assert.equal(s.ok, true, s.error ?? '')
    const row = s.rows?.find((x) => x.task === 'Literal Ref Status')
    assert.deepEqual(row?.counts, { ahead: 1, behind: 0 })
  } finally {
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['update-ref', '-d', 'refs/heads/wtm/literal-ref-status'], root)
    gitOk(['tag', '-d', 'wtm/literal-ref-status'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：merge 对任务分支使用完整 refs/heads 引用（避免同名 tag）', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  let worktreePath
  try {
    const b = await begin({ root, task: 'Literal Ref Merge', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)

    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
    assert.equal(gitOk(['tag', 'wtm/literal-ref-merge'], root).status, 0)

    const m = await mergeTask({ root, task: 'Literal Ref Merge', mode: 'commit', cfg, git, repo: null })
    assert.equal(m.ok, true, m.error ?? '')
    assert.equal(m.merged, true)
    assert.equal(readFileSync(join(root, 'task.txt'), 'utf8'), 'task\n')
  } finally {
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['update-ref', '-d', 'refs/heads/wtm/literal-ref-merge'], root)
    gitOk(['tag', '-d', 'wtm/literal-ref-merge'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：完整生命周期 begin → 修改 → status → finish(commit)', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
    const git = new GitRunner()
    try {
      // begin
      const b = await begin({ root, task: 'Add Search Box', cfg, git, repo: null })
      assert.equal(b.ok, true, b.error ?? "")
      assert.equal(typeof b.path, 'string', 'begin 应返回工作区路径')
      const bp = /** @type {string} */ (b.path)
      assert.equal(b.branch, 'wtm/add-search-box')
      assert.equal(bp, join(vault, 'add-search-box'))
      assert.equal(existsSync(bp), true)

      // 任务分支与主分支同一提交起点
      const before = gitOk(['rev-parse', 'main'], root).stdout.trim()
      const wtHead = gitOk(['rev-parse', 'HEAD'], bp).stdout.trim()
      assert.equal(wtHead, before)

      // 修改文件（跟踪文件 + 未跟踪文件）
      writeFileSync(join(bp, 'a.txt'), 'base\n+work\n')
      writeFileSync(join(bp, 'untracked.txt'), 'junk\n')

    // status 显示脏
    const s = await listStatus({ root, cfg, git, repo: null })
    assert.ok(s.rows, 'status 应有 rows')
    const row = s.rows.find((x) => x.task === 'Add Search Box')
    assert.ok(row, '应找到 Add Search Box 记录')
    assert.equal(row.dirty, true)
    assert.equal(row.exists, true)

    // finish(commit)：先快照提交（含未跟踪文件）再合并
    const f = await finishTask({ root, task: 'Add Search Box', mode: 'commit', cfg, git, repo: null })
    assert.equal(f.ok, true, f.error ?? "")

    // 主分支包含合并提交且文件内容已折叠
    const mainText = readFileSync(join(root, 'a.txt'), 'utf8')
    assert.match(mainText, /\+work/)
    assert.equal(existsSync(join(vault, 'add-search-box')), false, '工作区目录应已删除')
    // 分支已删除
    const branchCheck = gitOk(['show-ref', '--verify', 'refs/heads/wtm/add-search-box'], root)
    assert.notEqual(branchCheck.status, 0, '任务分支应已删除')
    // 账本清空
    assert.equal(loadLedger(vault).records.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('集成：merge 后工作区存活，可继续工作再 finish', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  try {
    const b = await begin({ root, task: 'Dark Mode', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? "")
    assert.equal(typeof b.path, 'string')
    const bp = /** @type {string} */ (b.path)
    writeFileSync(join(bp, 'a.txt'), 'base\n+dark\n')
    const m = await mergeTask({ root, task: 'Dark Mode', mode: 'commit', cfg, git, repo: null })
    assert.equal(m.ok, true, m.error ?? "")
    assert.equal(m.merged, true)
    assert.equal(existsSync(bp), true, 'merge 后工作区应保留')
    assert.match(readFileSync(join(root, 'a.txt'), 'utf8'), /\+dark/)
    // 再改一点，正常 finish
    writeFileSync(join(bp, 'a.txt'), 'base\n+dark\n+more\n')
    const f = await finishTask({ root, task: 'Dark Mode', mode: 'commit', cfg, git, repo: null })
    assert.equal(f.ok, true, f.error ?? "")
    assert.equal(existsSync(bp), false)
    assert.match(readFileSync(join(root, 'a.txt'), 'utf8'), /\+more/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('集成：merge 在基分支脏时拒绝', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  try {
    const b = await begin({ root, task: 'T1', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? "")
    assert.equal(typeof b.path, 'string')
    const bp = /** @type {string} */ (b.path)
    writeFileSync(join(bp, 'a.txt'), 'base\n+x\n')
    writeFileSync(join(root, 'a.txt'), 'base\n+dirty-main\n')
    const m = await mergeTask({ root, task: 'T1', mode: 'commit', cfg, git, repo: null })
    assert.equal(m.ok, false)
    assert.match(m.error ?? '', /未提交|基分支/)
    // 基分支仍保持脏状态未被改动
    assert.match(readFileSync(join(root, 'a.txt'), 'utf8'), /dirty-main/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('集成：GIT_CONFIG_PARAMETERS 中的 core.hooksPath 不能绕过 merge guard', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const git = new GitRunner()
  const priorParameters = process.env.GIT_CONFIG_PARAMETERS
  try {
    const b = await begin({ root, task: 'Merge Guard Inherited Hooks', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')

    const hookDirectory = join(vault, 'caller-hooks')
    const hookLog = join(vault, 'inherited-hook-config')
    installHook(hookDirectory, 'pre-merge-commit', `#!/bin/sh
git config --get wtm.testInheritedParameter > ${shellQuote(hookLog)} || exit $?
printf 'base\\n+hook-race\\n' > ${shellQuote(join(root, 'a.txt'))}
git add a.txt
`)
    const configPath = hookDirectory.replaceAll('\\', '/')
    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath'='${configPath}' 'wtm.testInheritedParameter'='preserved'`
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()

    const m = await mergeTask({ root, task: 'Merge Guard Inherited Hooks', mode: 'commit', cfg, git, repo: null })

    assert.equal(existsSync(hookLog), true, 'the original caller hook must be forwarded')
    assert.equal(m.ok, false, `caller hook changes must be rejected by the merge-time guard: ${JSON.stringify(m)}`)
    assert.match(m.error ?? '', /base index became dirty during merge/i)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead, 'guard must not commit the hook-modified tree')
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'base\n+hook-race\n', 'the caller hook must run through the guard wrapper')
    assert.equal(readFileSync(hookLog, 'utf8'), 'preserved\n', 'the caller hook must retain inherited Git configuration')
  } finally {
    if (priorParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS
    else process.env.GIT_CONFIG_PARAMETERS = priorParameters
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', 'wtm/merge-guard-inherited-hooks'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：最终检查后出现非冲突的基分支改动时 merge-time guard 拒绝', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const git = new MergeRaceGit(() => {
    writeFileSync(join(root, 'base-race.txt'), 'written after preflight\n')
  })
  try {
    const b = await begin({ root, task: 'Merge Guard Final Edit', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()

    const m = await mergeTask({ root, task: 'Merge Guard Final Edit', mode: 'commit', cfg, git, repo: null })

    assert.equal(m.ok, false)
    assert.match(m.error ?? '', /base worktree became dirty during merge/i)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead, 'base changes must not enter a merge commit')
  } finally {
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', 'wtm/merge-guard-final-edit'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：最终检查后切换基分支时 merge-time guard 拒绝', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const git = new MergeRaceGit(() => {
    assert.equal(gitOk(['checkout', '-b', 'develop'], root).status, 0)
  })
  try {
    const b = await begin({ root, task: 'Merge Guard Final Checkout', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()

    const m = await mergeTask({ root, task: 'Merge Guard Final Checkout', mode: 'commit', cfg, git, repo: null })

    assert.equal(m.ok, false)
    assert.match(m.error ?? '', /base branch changed during merge/i)
    assert.equal(gitOk(['branch', '--show-current'], root).stdout.trim(), 'develop')
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead, 'must not merge on the wrong branch')
  } finally {
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', 'wtm/merge-guard-final-checkout'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：commit hook 不能把受保护的 merge 重定向到其他分支', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const branch = 'wtm/merge-guard-redirect'
  try {
    assert.equal(gitOk(['branch', 'develop'], root).status, 0)
    const b = await begin({ root, task: 'Merge Guard Redirect', cfg, git: new GitRunner(), repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
    installHook(join(root, '.git', 'hooks'), 'prepare-commit-msg', `#!/bin/sh
git symbolic-ref HEAD refs/heads/develop
`)
    const baseHead = gitOk(['rev-parse', 'refs/heads/main'], root).stdout.trim()
    const otherHead = gitOk(['rev-parse', 'refs/heads/develop'], root).stdout.trim()

    const m = await mergeTask({ root, task: 'Merge Guard Redirect', mode: 'refuse', cfg, git: new GitRunner(), repo: null })

    assert.equal(m.ok, false, JSON.stringify(m))
    assert.match(m.error ?? '', /base (?:branch changed|index became dirty)|does not update the expected base ref/i)
    assert.equal(gitOk(['rev-parse', 'refs/heads/main'], root).stdout.trim(), baseHead)
    assert.equal(gitOk(['rev-parse', 'refs/heads/develop'], root).stdout.trim(), otherHead)
  } finally {
    gitOk(['symbolic-ref', 'HEAD', 'refs/heads/main'], root)
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', branch], root)
    gitOk(['branch', '-D', 'develop'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：snapshot ref transaction 守卫拒绝 commit 前的分支漂移', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new BranchSwitchBeforeSnapshotCommitGit()
  const branch = 'wtm/snapshot-branch-guard'
  let worktreePath
  try {
    assert.equal(gitOk(['branch', 'other'], root).status, 0)
    const b = await begin({ root, task: 'Snapshot Branch Guard', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'snapshot.txt'), 'task change\n')
    const taskHead = gitOk(['rev-parse', `refs/heads/${branch}`], root).stdout.trim()
    const otherHead = gitOk(['rev-parse', 'refs/heads/other'], root).stdout.trim()
    const baseHead = gitOk(['rev-parse', 'refs/heads/main'], root).stdout.trim()

    const m = await mergeTask({ root, task: 'Snapshot Branch Guard', mode: 'commit', cfg, git, repo: null })

    assert.equal(m.ok, false, JSON.stringify(m))
    assert.equal(git.switched, true)
    assert.equal(gitOk(['rev-parse', `refs/heads/${branch}`], root).stdout.trim(), taskHead)
    assert.equal(gitOk(['rev-parse', 'refs/heads/other'], root).stdout.trim(), otherHead)
    assert.equal(gitOk(['rev-parse', 'refs/heads/main'], root).stdout.trim(), baseHead)
    assert.match(m.error ?? '', /快照提交拒绝更新其他分支/)
  } finally {
    if (worktreePath) {
      gitOk(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], worktreePath)
      gitOk(['worktree', 'remove', '--force', worktreePath], root)
    }
    gitOk(['branch', '-D', branch], root)
    gitOk(['branch', '-D', 'other'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：快照提交继续调用原始 commit hooks', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  const git = new GitRunner()
  const hooksDirectory = join(root, '.git', 'hooks')
  const hookLog = join(vault, 'hook-log')
  let worktreePath
  try {
    const b = await begin({ root, task: 'Snapshot Hook Chain', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'snapshot.txt'), 'task change\n')
    for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      installHook(hooksDirectory, name, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(name)} >> ${shellQuote(hookLog)}\n`)
    }
    installHook(hooksDirectory, 'reference-transaction', `#!/bin/sh
printf 'reference-%s\\n' "$1" >> ${shellQuote(hookLog)}
cat >/dev/null
`)

    const m = await mergeTask({ root, task: 'Snapshot Hook Chain', mode: 'commit', cfg, git, repo: null })

    assert.equal(m.ok, true, m.error ?? '')
    assert.equal(m.merged, true)
    const events = readFileSync(hookLog, 'utf8').trim().split(/\r?\n/)
    assert.ok(events.indexOf('pre-commit') < events.indexOf('prepare-commit-msg'))
    assert.ok(events.indexOf('prepare-commit-msg') < events.indexOf('commit-msg'))
    assert.ok(events.indexOf('commit-msg') < events.indexOf('post-commit'))
    assert.equal(events.filter((event) => event === 'post-commit').length, 1)
    assert.ok(events.includes('reference-prepared'))
    assert.ok(events.includes('reference-committed'))
  } finally {
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', 'wtm/snapshot-hook-chain'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：merge-time guard 检查 status 隐藏的 hook 新增未跟踪文件', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const branch = 'wtm/merge-guard-untracked-hook'
  const hookFile = join(root, 'hook-only.txt')
  try {
    const b = await begin({ root, task: 'Merge Guard Untracked Hook', cfg, git: new GitRunner(), repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
    assert.equal(gitOk(['config', 'status.showUntrackedFiles', 'no'], root).status, 0)
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    installHook(join(root, '.git', 'hooks'), 'pre-merge-commit', `#!/bin/sh
printf 'hook data\\n' > ${shellQuote(hookFile)}
`)

    const m = await mergeTask({ root, task: 'Merge Guard Untracked Hook', mode: 'commit', cfg, git: new GitRunner(), repo: null })

    assert.equal(m.ok, false, JSON.stringify(m))
    assert.match(m.error ?? '', /untracked/i)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead)
    const status = gitOk(['status', '--porcelain'], root).stdout
    assert.match(status, /task\.txt/, 'the failed merge should leave its staged task tree recoverable')
    assert.doesNotMatch(status, /hook-only\.txt/, 'the configured status output should hide the untracked hook file')
    assert.equal(readFileSync(hookFile, 'utf8'), 'hook data\n')
  } finally {
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', branch], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：immutable merge guard pins the tree before hooks change merge configuration', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const branch = 'wtm/merge-guard-config-mutation'
  try {
    mkdirSync(join(root, 'old'))
    writeFileSync(join(root, 'old', 'base.txt'), 'base\n')
    assert.equal(gitOk(['add', 'old'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'directory base'], root).status, 0)
    assert.equal(gitOk(['config', 'merge.directoryRenames', 'true'], root).status, 0)
    const b = await begin({ root, task: 'Merge Guard Config Mutation', cfg, git: new GitRunner(), repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    assert.equal(gitOk(['mv', 'old', 'new'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'rename directory'], worktreePath).status, 0)
    writeFileSync(join(root, 'old', 'added.txt'), 'main\n')
    assert.equal(gitOk(['add', 'old/added.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'add under old directory'], root).status, 0)
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    const expectedTree = gitOk(['merge-tree', '--write-tree', 'HEAD', `refs/heads/${branch}`], root).stdout.trim()
    const alternateTree = gitOk(['-c', 'merge.directoryRenames=false', 'merge-tree', '--write-tree', 'HEAD', `refs/heads/${branch}`], root).stdout.trim()
    assert.notEqual(expectedTree, alternateTree, 'the changed merge config must yield a different clean tree')
    installHook(join(root, '.git', 'hooks'), 'pre-merge-commit', `#!/bin/sh
git config merge.directoryRenames false || exit $?
`)

    const m = await mergeTask({ root, task: 'Merge Guard Config Mutation', mode: 'refuse', cfg, git: new GitRunner(), repo: null })

    assert.equal(m.ok, true, JSON.stringify(m))
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim() === baseHead, false)
    assert.equal(gitOk(['rev-parse', 'HEAD^{tree}'], root).stdout.trim(), expectedTree)
    assert.equal(gitOk(['config', '--get', 'merge.directoryRenames'], root).stdout.trim(), 'false')
  } finally {
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', branch], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：tree preflight uses the same locale as the guarded merge driver', { skip: !HAS_GIT || process.platform === 'win32', timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const branch = 'wtm/merge-guard-locale-driver'
  const priorLang = process.env.LANG
  const priorLcAll = process.env.LC_ALL
  try {
    const driver = join(vault, 'locale-merge-driver.sh')
    writeFileSync(driver, '#!/bin/sh\nprintf \'%s\\n\' "$LANG" > "$2"\n')
    chmodSync(driver, 0o755)
    assert.equal(gitOk(['config', 'merge.locale.name', 'locale'], root).status, 0)
    assert.equal(gitOk(['config', 'merge.locale.driver', `${shellQuote(driver)} %O %A %B`], root).status, 0)
    writeFileSync(join(root, '.gitattributes'), 'conflict.txt merge=locale\n')
    writeFileSync(join(root, 'conflict.txt'), 'base\n')
    assert.equal(gitOk(['add', '.gitattributes', 'conflict.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'add locale merge driver'], root).status, 0)

    const b = await begin({ root, task: 'Merge Guard Locale Driver', cfg, git: new GitRunner(), repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'conflict.txt'), 'task\n')
    assert.equal(gitOk(['add', 'conflict.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task conflict'], worktreePath).status, 0)
    writeFileSync(join(root, 'conflict.txt'), 'main\n')
    assert.equal(gitOk(['add', 'conflict.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'main conflict'], root).status, 0)

    process.env.LANG = 'fr_TEST'
    delete process.env.LC_ALL
    const m = await mergeTask({ root, task: 'Merge Guard Locale Driver', mode: 'refuse', cfg, git: new GitRunner(), repo: null })

    assert.equal(m.ok, true, JSON.stringify(m))
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), 'C\n')
  } finally {
    if (priorLang === undefined) delete process.env.LANG
    else process.env.LANG = priorLang
    if (priorLcAll === undefined) delete process.env.LC_ALL
    else process.env.LC_ALL = priorLcAll
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', branch], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：proposed commit guard validates its immutable tree even when the index matches Git result', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const git = new GitRunner()
  const branch = 'wtm/merge-guard-proposed-tree'
  /** @type {{hooksPath: string} | undefined} */
  let guard
  try {
    assert.equal(gitOk(['checkout', '-b', branch], root).status, 0)
    writeFileSync(join(root, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], root).status, 0)
    const branchHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    assert.equal(gitOk(['checkout', 'main'], root).status, 0)
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    const expectedTree = gitOk(['merge-tree', '--write-tree', 'HEAD', `refs/heads/${branch}`], root).stdout.trim()
    const wrongTree = gitOk(['rev-parse', 'HEAD^{tree}'], root).stdout.trim()
    const wrongCommit = gitOk(['commit-tree', wrongTree, '-p', baseHead, '-p', branchHead, '-m', 'wrong merge tree'], root).stdout.trim()
    assert.ok(expectedTree)
    assert.ok(wrongCommit)
    assert.notEqual(wrongTree, expectedTree)

    guard = await createMergeGuard(root, git, undefined, 'main', {
      expectedTree,
      expectedBaseHead: baseHead,
      expectedMergeHead: branchHead,
    })
    const hookLog = join(root, 'reference-hook-ran')
    installHook(join(root, '.git', 'hooks'), 'reference-transaction', `#!/bin/sh
input=$(mktemp "\${TMPDIR:-/tmp}/wtm-reference-test.XXXXXX") || exit 1
trap 'rm -f "$input"' 0 HUP INT TERM
cat >"$input" || exit 1
if [ "$1" = prepared ] && grep -q ' refs/heads/main$' "$input"; then
  printf 'prepared\\n' > ${shellQuote(hookLog)}
  git read-tree ${shellQuote(expectedTree)} || exit $?
  git checkout-index -a -f || exit $?
fi
`)
    const result = spawnSync('git', [
      '-c', `core.hooksPath=${guard.hooksPath}`,
      'update-ref', 'refs/heads/main', wrongCommit, baseHead,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WTM_EXPECTED_BASE: 'main',
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /proposed merge commit tree/i)
    assert.equal(readFileSync(hookLog, 'utf8'), 'prepared\n')
    assert.equal(gitOk(['write-tree'], root).stdout.trim(), expectedTree)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead)
  } finally {
    if (guard) rmSync(guard.hooksPath, { recursive: true, force: true })
    gitOk(['branch', '-D', branch], root)
    rmSync(root, { recursive: true, force: true })
  }
})

test('集成：proposed commit guard pins its target and rejects extra parents', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  const git = new GitRunner()
  const branch = 'wtm/merge-guard-pinned-target'
  const otherBranch = 'wtm/merge-guard-wrong-target'
  /** @type {{hooksPath: string} | undefined} */
  let guard
  try {
    assert.equal(gitOk(['checkout', '-b', branch], root).status, 0)
    writeFileSync(join(root, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], root).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], root).status, 0)
    const expectedMergeHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    assert.equal(gitOk(['checkout', '-b', otherBranch], root).status, 0)
    assert.equal(gitOk(['commit', '--allow-empty', '-m', 'alternate target'], root).status, 0)
    const wrongMergeHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    assert.equal(gitOk(['checkout', 'main'], root).status, 0)
    const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()
    const expectedTree = gitOk(['merge-tree', '--write-tree', baseHead, expectedMergeHead], root).stdout.trim()
    const wrongParentTree = gitOk(['merge-tree', '--write-tree', 'HEAD', wrongMergeHead], root).stdout.trim()
    assert.equal(wrongParentTree, expectedTree)
    const wrongParentCommit = gitOk([
      'commit-tree', wrongParentTree, '-p', baseHead, '-p', wrongMergeHead, '-m', 'wrong merge target',
    ], root).stdout.trim()
    const extraParentCommit = gitOk([
      'commit-tree', expectedTree, '-p', baseHead, '-p', expectedMergeHead, '-p', wrongMergeHead, '-m', 'extra merge parent',
    ], root).stdout.trim()
    assert.ok(wrongParentTree)
    assert.ok(wrongParentCommit)
    assert.ok(extraParentCommit)

    guard = await createMergeGuard(root, git, undefined, 'main', {
      expectedTree,
      expectedBaseHead: baseHead,
      expectedMergeHead,
    })
    const hookLog = join(root, '.git', 'reference-hook-ran')
    installHook(join(root, '.git', 'hooks'), 'reference-transaction', `#!/bin/sh
input=$(mktemp "\${TMPDIR:-/tmp}/wtm-reference-test.XXXXXX") || exit 1
trap 'rm -f "$input"' 0 HUP INT TERM
cat >"$input" || exit 1
if [ "$1" = prepared ] && grep -q ' refs/heads/main$' "$input"; then
  printf 'prepared\\n' > ${shellQuote(hookLog)}
  git read-tree ${shellQuote(wrongParentTree)} || exit $?
  git checkout-index -a -f || exit $?
fi
`)
    const result = spawnSync('git', [
      '-c', `core.hooksPath=${guard.hooksPath}`,
      'update-ref', 'refs/heads/main', wrongParentCommit, baseHead,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WTM_EXPECTED_BASE: 'main',
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /proposed merge commit does not use the expected merge target/i)
    assert.equal(readFileSync(hookLog, 'utf8'), 'prepared\n')
    assert.equal(gitOk(['write-tree'], root).stdout.trim(), wrongParentTree)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead)

    const extraParentResult = spawnSync('git', [
      '-c', `core.hooksPath=${guard.hooksPath}`,
      'update-ref', 'refs/heads/main', extraParentCommit, baseHead,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WTM_EXPECTED_BASE: 'main',
      },
    })
    assert.notEqual(extraParentResult.status, 0, 'a guarded two-head merge must reject a proposed commit with a third parent')
    assert.match(extraParentResult.stderr, /exactly two parents/i)
    assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead)
  } finally {
    if (guard) rmSync(guard.hooksPath, { recursive: true, force: true })
    gitOk(['branch', '-D', branch], root)
    gitOk(['branch', '-D', otherBranch], root)
    rmSync(root, { recursive: true, force: true })
  }
})

test('集成：临时 merge hooks 保留原有 hook 链和继承配置', { skip: !HAS_GIT || process.platform === 'win32', timeout: 120000 }, async () => {
  const root = await makeRepo()
  const vault = makeVault()
  const originalHooksDirectory = join(vault, 'original hooks ')
  const cfg = {
    vault, prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
  let worktreePath
  const git = new GitRunner()
  const inheritedConfigEnv = Object.fromEntries(
    ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS']
      .map((name) => [name, process.env[name]]),
  )
  try {
    assert.equal(gitOk(['config', 'core.hooksPath', originalHooksDirectory], root).status, 0)
    const b = await begin({ root, task: 'Merge Hook Chain', cfg, git, repo: null })
    assert.equal(b.ok, true, b.error ?? '')
    worktreePath = /** @type {string} */ (b.path)
    writeFileSync(join(worktreePath, 'task.txt'), 'task\n')
    assert.equal(gitOk(['add', 'task.txt'], worktreePath).status, 0)
    assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)

    const hookLog = join(vault, 'hook-log')
    const nestedHookLog = join(vault, 'nested-hook-log')
    const referenceHookLog = join(vault, 'reference-hook-log')
    const inheritedConfigLog = join(vault, 'inherited-config-log')
    const inheritedParameterLog = join(vault, 'inherited-parameter-log')
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'wtm.testInheritedConfig'
    process.env.GIT_CONFIG_VALUE_0 = 'preserved'
    process.env.GIT_CONFIG_PARAMETERS = "'wtm.testInheritedParameter'='preserved'"
    installHook(originalHooksDirectory, 'pre-commit', `#!/bin/sh
printf '%s\\n' pre-commit >> ${shellQuote(hookLog)}
`)
    installHook(originalHooksDirectory, 'prepare-commit-msg', `#!/bin/sh
printf '%s\\n' prepare-commit-msg >> ${shellQuote(hookLog)}
`)
    installHook(originalHooksDirectory, 'commit-msg', `#!/bin/sh
printf '%s\\n' commit-msg >> ${shellQuote(hookLog)}
git config --get wtm.testInheritedConfig > ${shellQuote(inheritedConfigLog)}
git config --get wtm.testInheritedParameter > ${shellQuote(inheritedParameterLog)}
git rev-parse --git-path hooks > ${shellQuote(nestedHookLog)}
`)
    installHook(originalHooksDirectory, 'post-merge', `#!/bin/sh
printf '%s\\n' post-merge >> ${shellQuote(hookLog)}
`)
    installHook(originalHooksDirectory, 'reference-transaction', `#!/bin/sh
printf 'phase=%s\\n' "$1" >> ${shellQuote(referenceHookLog)}
cat >> ${shellQuote(referenceHookLog)}
git config --get wtm.testInheritedParameter >> ${shellQuote(referenceHookLog)}
`)

    const m = await mergeTask({ root, task: 'Merge Hook Chain', mode: 'refuse', cfg, git, repo: null })

    assert.equal(m.ok, true, m.error ?? '')
    assert.equal(m.merged, true)
    assert.equal(readFileSync(hookLog, 'utf8'), 'pre-commit\nprepare-commit-msg\ncommit-msg\npost-merge\n')
    assert.equal(readFileSync(inheritedConfigLog, 'utf8'), 'preserved\n')
    assert.equal(readFileSync(inheritedParameterLog, 'utf8'), 'preserved\n')
    assert.equal(readFileSync(nestedHookLog, 'utf8'), `${originalHooksDirectory}\n`)
    const referenceHookOutput = readFileSync(referenceHookLog, 'utf8')
    assert.match(referenceHookOutput, /phase=prepared/)
    assert.match(referenceHookOutput, /refs\/heads\/main/)
    assert.match(referenceHookOutput, /preserved/)
  } finally {
    for (const [name, value] of Object.entries(inheritedConfigEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    gitOk(['merge', '--abort'], root)
    if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
    gitOk(['branch', '-D', 'wtm/merge-hook-chain'], root)
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('集成：两 token 的 -s ours 与 -X theirs 的 guard 树匹配 Git 合并结果', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  for (const scenario of [
    { option: '-s ours', task: 'Merge Strategy Ours', oracle: 'base' },
    { option: "-s 'ours'", task: 'Merge Quoted Strategy Ours', oracle: 'base' },
    { option: '-X theirs', task: 'Merge X Theirs', oracle: 'merge-tree' },
    { option: "-X 'theirs'", task: 'Merge Quoted X Theirs', oracle: 'merge-tree' },
  ]) {
    const root = await makeRepo()
    const vault = makeVault()
    const cfg = {
      vault, prefix: 'wtm',
      commitMessage: 'snapshot {task}',
      mergeMessage: 'fold {task} into {base}',
      warnings: [],
    }
    let worktreePath
    const git = new GitRunner()
    const branch = `wtm/${scenario.task.toLowerCase().replaceAll(' ', '-')}`
    try {
      assert.equal(gitOk(['config', 'branch.main.mergeOptions', scenario.option], root).status, 0)
      const b = await begin({ root, task: scenario.task, cfg, git, repo: null })
      assert.equal(b.ok, true, b.error ?? '')
      worktreePath = /** @type {string} */ (b.path)
      writeFileSync(join(worktreePath, 'a.txt'), 'base\n+task\n')
      writeFileSync(join(worktreePath, 'task-only.txt'), 'task\n')
      assert.equal(gitOk(['add', '-A'], worktreePath).status, 0)
      assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
      writeFileSync(join(root, 'a.txt'), 'base\n+main\n')
      assert.equal(gitOk(['add', 'a.txt'], root).status, 0)
      assert.equal(gitOk(['commit', '-m', 'main'], root).status, 0)

      const baseTree = gitOk(['rev-parse', 'HEAD^{tree}'], root).stdout.trim()
      const expectedTree = scenario.oracle === 'base'
        ? baseTree
        : gitOk(['merge-tree', '--write-tree', '-X', 'theirs', 'HEAD', `refs/heads/${branch}`], root).stdout.trim().split(/\r?\n/)[0]
      assert.ok(expectedTree)
      const m = await mergeTask({ root, task: scenario.task, mode: 'refuse', cfg, git, repo: null })

      assert.equal(m.ok, true, m.error ?? '')
      assert.equal(m.merged, true)
      const actualTree = gitOk(['rev-parse', 'HEAD^{tree}'], root).stdout.trim()
      assert.equal(actualTree, expectedTree, 'guard must accept exactly the tree Git creates for the configured merge options')
    } finally {
      gitOk(['merge', '--abort'], root)
      if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
      gitOk(['branch', '-D', branch], root)
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  }
})

test('集成：guard 在启动 merge 前拒绝不支持的策略', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  for (const scenario of [
    { options: '-s subtree', task: 'Merge Unsupported Strategy', error: /不支持.*策略.*subtree/i },
    { options: '-s ours -s ort', task: 'Merge Multiple Strategies', error: /配置了多个 merge strategy/i },
  ]) {
    const root = await makeRepo()
    const vault = makeVault()
    const cfg = {
      vault, prefix: 'wtm',
      commitMessage: 'snapshot {task}',
      mergeMessage: 'fold {task} into {base}',
      warnings: [],
    }
    let worktreePath
    let mergeStarted = false
    const git = new MergeRaceGit(() => { mergeStarted = true })
    const branch = `wtm/${scenario.task.toLowerCase().replaceAll(' ', '-')}`
    try {
      assert.equal(gitOk(['config', 'branch.main.mergeOptions', scenario.options], root).status, 0)
      const b = await begin({ root, task: scenario.task, cfg, git, repo: null })
      assert.equal(b.ok, true, b.error ?? '')
      worktreePath = /** @type {string} */ (b.path)
      writeFileSync(join(worktreePath, 'task-only.txt'), 'task\n')
      assert.equal(gitOk(['add', 'task-only.txt'], worktreePath).status, 0)
      assert.equal(gitOk(['commit', '-m', 'task'], worktreePath).status, 0)
      writeFileSync(join(root, 'main-only.txt'), 'main\n')
      assert.equal(gitOk(['add', 'main-only.txt'], root).status, 0)
      assert.equal(gitOk(['commit', '-m', 'main'], root).status, 0)
      const baseHead = gitOk(['rev-parse', 'HEAD'], root).stdout.trim()

      const m = await mergeTask({ root, task: scenario.task, mode: 'refuse', cfg, git, repo: null })

      assert.equal(m.ok, false)
      assert.match(m.error ?? '', scenario.error)
      assert.equal(mergeStarted, false, 'unsupported strategies must be rejected before git merge starts')
      assert.equal(gitOk(['rev-parse', 'HEAD'], root).stdout.trim(), baseHead)
    } finally {
      gitOk(['merge', '--abort'], root)
      if (worktreePath) gitOk(['worktree', 'remove', '--force', worktreePath], root)
      gitOk(['branch', '-D', branch], root)
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  }
})

test('集成：resolveToplevel 真实解析子目录', { skip: !HAS_GIT, timeout: 120000 }, async () => {
  const root = await makeRepo()
  try {
    const git = new GitRunner()
    const sub = join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const r = await resolveToplevel(git, sub, undefined)
    assert.equal(r.ok, true)
    // git 在 Windows 上输出正斜杠路径，与本地拼出的反斜杠路径用 samePath 比较
    assert.equal(samePath(r.root, root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
