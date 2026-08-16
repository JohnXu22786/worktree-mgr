import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { GitRunner, resolveToplevel, samePath } from '../src/git.js'
import { begin, mergeTask, finishTask, listStatus } from '../src/ops.js'
import { loadLedger } from '../src/vault.js'

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

