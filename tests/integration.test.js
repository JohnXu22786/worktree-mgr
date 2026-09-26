import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { GitRunner, resolveToplevel, samePath } from '../src/git.js'
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
  writeFileSync(join(root, 'a.txt'), 'base\n')
  gitOk(['add', 'a.txt'], root)
  assert.equal(gitOk(['commit', '-m', 'init'], root).status, 0)
  return root
}

/** 集成测试的 vault 必须放在仓库之外（否则主工作区会被 vault 目录弄脏） */
function makeVault() {
  return mkdtempSync(join(tmpdir(), 'wtm-it-vault-'))
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
