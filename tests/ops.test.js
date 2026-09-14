import { test } from 'node:test'
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { begin, mergeTask, finishTask, listStatus, purge } from '../src/ops.js'
import { EMPTY_LEDGER, loadLedger, saveLedger, upsertRecord, withLock } from '../src/vault.js'
import { resolveToplevel } from '../src/git.js'

// ---- 假 git 执行器 ---------------------------------------------------------

class FakeGit {
  /** @type {Array<{args: string[], cwd: string | undefined}>} */
  calls
  /** @type {Map<string, any>} */
  answers

  constructor() {
    this.calls = []
    this.answers = new Map()
  }
  /**
   * @param {string[]} args
   * @param {any} result
   */
  on(args, result) {
    this.answers.set(args.join(' '), result)
    return this
  }
  /**
   * @param {string[]} args
   * @param {{cwd?: string, signal?: AbortSignal}} [opts]
   */
  async run(args, opts = {}) {
    this.calls.push({ args, cwd: opts.cwd })
    const key = args.join(' ')
    const a = this.answers.get(key)
    if (a === undefined) throw new Error(`FakeGit: 未预设答案: ${key}`)
    return typeof a === 'function' ? a({ args, cwd: opts.cwd }) : a
  }
  /**
   * @param {string[]} args
   * @param {string | undefined} [cwd]
   */
  called(args, cwd) {
    return this.calls.some((c) => c.args.join(' ') === args.join(' ') && (cwd === undefined || c.cwd === cwd))
  }
  /** @param {string[]} args */
  count(args) {
    return this.calls.filter((c) => c.args.join(' ') === args.join(' ')).length
  }
}

const OK = (stdout = '', stderr = '') => ({ ok: true, code: 0, stdout, stderr })
const FAIL = (stderr = 'nope', code = 128) => ({ ok: false, code, stdout: '', stderr })

/** @returns {string} */
function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'wtm-ops-test-'))
}

/**
 * @param {string} tmp
 * @returns {{vault: string, prefix: string, commitMessage: string, mergeMessage: string, warnings: string[]}}
 */
function baseCfg(tmp) {
  return {
    vault: join(tmp, 'vault'),
    prefix: 'wtm',
    commitMessage: 'snapshot {task}',
    mergeMessage: 'fold {task} into {base}',
    warnings: [],
  }
}

// ---- resolveToplevel -------------------------------------------------------

test('resolveToplevel：非 git 目录报错', async () => {
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], FAIL('not a git repository'))
  const r = await resolveToplevel(git, 'C:/nowhere', undefined)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /git/i)
})

test('resolveToplevel：返回规范化顶层路径', async () => {
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK('C:/repo\n'))
  const r = await resolveToplevel(git, 'C:/repo/src', undefined)
  assert.equal(r.ok, true)
  assert.equal(r.root, 'C:/repo')
})

// ---- begin -----------------------------------------------------------------

test('begin：等待 vault 锁期间取消时返回取消错误', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const root = join(tmp, 'repo')
  let firstInside = false
  /** @type {((value?: unknown) => void) | undefined} */
  let release
  const gate = new Promise((r) => { release = r })
  const p1 = withLock(cfg.vault, async () => {
    firstInside = true
    await gate
  })
  while (!firstInside) await new Promise((r) => setTimeout(r, 5))

  const ac = new AbortController()
  const p2 = begin({ root, task: 'T', cfg, git: new FakeGit(), repo: null, signal: ac.signal })
  await new Promise((r) => setTimeout(r, 50))
  ac.abort()
  assert.ok(release, 'release 应已赋值')
  release()

  await p1
  const result = await p2
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /取消|abort/i)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：创建前检查：任务校验、重复任务、基分支存在、分支不冲突', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/add-search'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'vault', 'add-search'), '-b', 'wtm/add-search', 'refs/heads/main'], OK())

  // 重复任务
  const r1 = await begin({ root: 'C:/repo', task: 'Add Search', cfg, git, repo: null })
  assert.equal(r1.ok, true)
  const r2 = await begin({ root: 'C:/repo', task: 'Add Search', cfg, git, repo: null })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /已存在/)

  // 分支派生与账本
  const ledger = loadLedger(cfg.vault)
  assert.equal(ledger.records.length, 1)
  assert.equal(ledger.records[0].branch, 'wtm/add-search')
  assert.equal(ledger.records[0].base, 'main')
  assert.equal(ledger.records[0].path, join(tmp, 'vault', 'add-search'))
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：vault 位于仓库工作树内时拒绝（防主工作区被弄脏）', async () => {
  const tmp = makeTmp()
  const git = new FakeGit()
  const r = await begin({ root: 'C:/repo', task: 'T', cfg: baseCfg(join('C:/repo', '.wtm-vault')), git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /vault/)
  assert.equal(git.calls.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：vault 的 .. 路径别名解析到仓库内时拒绝', async () => {
  const tmp = makeTmp()
  const root = join(tmp, 'repo')
  const alias = join(tmp, 'repo-alias')
  mkdirSync(root, { recursive: true })
  mkdirSync(alias, { recursive: true })
  const git = new FakeGit()
  const cfg = { ...baseCfg(tmp), vault: `${alias}/../repo/.wtm-vault` }
  try {
    const r = await begin({ root, task: 'T', cfg, git, repo: null })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /vault/)
    assert.equal(git.calls.length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('begin：指向仓库内目录的 vault 符号链接时拒绝', async () => {
  const tmp = makeTmp()
  const root = join(tmp, 'repo')
  const link = join(tmp, 'vault-link')
  mkdirSync(root, { recursive: true })
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  const git = new FakeGit()
  const cfg = { ...baseCfg(tmp), vault: join(link, '.wtm-vault') }
  try {
    const r = await begin({ root, task: 'T', cfg, git, repo: null })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /vault/)
    assert.equal(git.calls.length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('begin：相对 vault 配置保留符号链接与 .. 的文件系统语义', { skip: process.platform === 'win32' }, async () => {
  const tmp = makeTmp()
  try {
    const root = join(tmp, 'repo')
    const outside = join(tmp, 'outside')
    const link = join(root, 'link')
    const vault = join(tmp, 'vault')
    const worktreePath = join(vault, 'task')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync('../outside', link)
    const cfg = { ...baseCfg(tmp), vault: `link${sep}..${sep}vault` }
    const git = new FakeGit()
    git.on(['branch', '--show-current'], OK('main\n'))
    git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
    git.on(['show-ref', '--verify', 'refs/heads/wtm/task'], FAIL())
    git.on(['status', '--porcelain'], OK())
    git.on(['worktree', 'add', worktreePath, '-b', 'wtm/task', 'refs/heads/main'], OK())

    const r = await begin({ root, task: 'Task', cfg, git, repo: null })
    assert.equal(r.ok, true)
    assert.equal(r.path, worktreePath)
    assert.equal(git.called(['worktree', 'add', worktreePath, '-b', 'wtm/task', 'refs/heads/main']), true)
    assert.equal(existsSync(join(root, 'vault')), false)
    assert.equal(loadLedger(vault).records[0].path, worktreePath)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('begin：任务名非法直接报错，不执行任何 git 写操作', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r = await begin({ root: 'C:/repo', task: '   ', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.equal(git.calls.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：Windows 设备名任务在任何 git 调用前拒绝', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r = await begin({ root: 'C:/repo', task: 'CON', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Windows.*设备名/)
  assert.equal(git.calls.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：显式分支非法报错', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r = await begin({ root: 'C:/repo', task: 'T', branch: '-evil', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /分支/i)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：detached HEAD 时要求显式 base', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK(''))
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /base/i)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：基分支不存在报错', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('develop\n'))
  git.on(['show-ref', '--verify', 'refs/heads/develop'], FAIL('unknown revision'))
  git.on(['rev-parse', '--verify', 'HEAD'], OK('abc\n')) // 仓库有提交 → 无空仓库提示
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /develop/)
  assert.doesNotMatch(r.error ?? '', /尚无任何提交/)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：空仓库（无提交）时报出明确提示', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], FAIL('unknown revision'))
  git.on(['rev-parse', '--verify', 'HEAD'], FAIL('unknown revision'))
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /尚无任何提交/)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：目标分支已存在于 git 时拒绝', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], OK('abc\n'))
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /已存在/)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：基分支有未提交改动时产生警告但不中断', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(' M dirty.txt\n'))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok((r.warnings ?? []).some((w) => /未提交/i.test(w)))
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：主工作区 git status 失败时终止创建', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], FAIL('fatal: index file smaller than expected'))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())

  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /主工作区.*状态失败/)
  assert.match(r.error ?? '', /index file smaller than expected/)
  assert.equal(git.count(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：worktree add 失败透传 stderr', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], FAIL('fatal: could not create worktree'))
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /could not create/)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：回滚命令返回失败对象时保留失败警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const worktreePath = join(tmp, 'vault', 't')
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', worktreePath, '-b', 'wtm/t', 'refs/heads/main'], OK())
  git.on(['worktree', 'remove', '--force', worktreePath], FAIL('fatal: cannot remove worktree'))
  git.on(['branch', '-D', 'wtm/t'], OK())

  const r = await begin({
    root: 'C:/repo',
    task: 'T',
    cfg,
    git,
    repo: { triggers: { on_begin: ['broken-trigger'] } },
    // 让 on_begin 在 worktree 创建后抛错，从而进入回滚路径。
    triggerSpawn: () => ({}),
  })

  assert.equal(r.ok, false)
  assert.ok((r.warnings ?? []).some((w) => /回滚失败/.test(w)), JSON.stringify(r))
  assert.ok((r.warnings ?? []).some((w) => /cannot remove worktree/.test(w)), JSON.stringify(r))
  assert.ok(!(r.warnings ?? []).some((w) => /已回滚/.test(w)), JSON.stringify(r))
  assert.ok(git.called(['branch', '-D', 'wtm/t']))
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：执行 on_begin 触发器并附带警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())
  const repo = { triggers: { on_begin: ['install.sh', 'fail.sh'] } }
  let triggerIdx = 0
  const r = await begin({
    root: 'C:/repo', task: 'T', cfg, git, repo,
    triggerSpawn: () => {
      // 第一条成功、第二条失败（通过外部状态计数，避免闭包引用未初始化的 r）
      const c = /** @type {any} */ (new EventEmitter())
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      const fail = triggerIdx === 1
      triggerIdx += 1
      queueMicrotask(() => {
        if (fail) {
          c.stderr.emit('data', Buffer.from('boom'))
          c.emit('close', 3, null)
        } else {
          c.emit('close', 0, null)
        }
      })
      return c
    },
  })
  assert.equal(r.ok, true)
  assert.ok((r.warnings ?? []).some((w) => /boom/.test(w)), JSON.stringify(r.warnings))
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：seed 文件从主仓库复制到新工作区', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())
  const repo = { seed: { files: ['docs/env.txt'] } }
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo })
  assert.equal(r.ok, true)
  rmSync(tmp, { recursive: true, force: true })
})

// ---- mergeTask -------------------------------------------------------------

/**
 * @param {string} tmp
 * @param {{taskDirty?: boolean, baseDirty?: boolean, taskBranch?: string}} [opts]
 */
function mergeFixture(tmp, { taskDirty = false, baseDirty = false, taskBranch = 'wtm/t' } = {}) {
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const vault = cfg.vault
  // 预置一条任务记录，并真实创建工作区目录（stale 判定依赖目录实存）
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, {
    task: 'T', branch: 'wtm/t', base: 'main',
    path: join(vault, 't'), createdAt: 'c', updatedAt: 'u',
  })
  saveLedger(vault, ledger)
  mkdirSync(join(vault, 't'), { recursive: true })
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD 1'.padEnd(40, '1') + '\nbranch refs/heads/main\n\nworktree ' + join(vault, 't') + '\nHEAD 2'.padEnd(40, '2') + '\nbranch refs/heads/' + taskBranch + '\n'))
  // status 答案按 cwd 区分：任务工作区脏与否 / 基工作区脏与否
  git.on(['status', '--porcelain'], (/** @type {{cwd: string | undefined}} */ ctx) => {
    if (ctx.cwd === join(vault, 't')) return taskDirty ? OK(' M f.txt\n') : OK('')
    return baseDirty ? OK(' M base.txt\n') : OK('')
  })
  git.on(['add', '-A'], OK())
  git.on(['commit', '-m', 'snapshot T'], OK('[wtm/t 9999999] snapshot T'))
  // mergeIntoBase 的新检查：主工作区当前分支 == 账本基分支；任务分支未合并
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], FAIL('not an ancestor', 1))
  git.on(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main'], OK('Merge made by the "ort" strategy.'))
  return { cfg, git, vault }
}

test('mergeTask：干净任务直接合并并更新记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.committed, false)
  assert.equal(r.merged, true)
  assert.ok(git.called(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main'], 'C:/repo'))
  const ledger = loadLedger(vault)
  assert.equal(ledger.records[0].updatedAt !== 'u', true)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：merge-base 致命失败时拒绝继续合并', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], FAIL('fatal: bad object wtm/t'))

  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /fatal: bad object wtm\/t/)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  assert.equal(loadLedger(vault).records[0].updatedAt, 'u')
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：脏任务在 commit 模式下先快照提交再合并', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp, { taskDirty: true })
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.committed, true)
  assert.ok(git.called(['add', '-A'], join(vault, 't')))
  assert.ok(git.called(['commit', '-m', 'snapshot T'], join(vault, 't')))
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：refuse 模式下脏任务拒绝合并', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp, { taskDirty: true })
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'refuse', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /未提交/)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：refuse 模式第二次状态检查发现改动时拒绝快照提交', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  let taskStatusChecks = 0
  git.on(['status', '--porcelain'], (/** @type {{cwd: string | undefined}} */ ctx) => {
    if (ctx.cwd === taskPath) {
      taskStatusChecks += 1
      return taskStatusChecks === 1 ? OK('') : OK(' M race.txt\n')
    }
    return OK('')
  })

  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'refuse', cfg, git, repo: null })

  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /未提交/)
  assert.equal(git.count(['add', '-A']), 0)
  assert.equal(git.count(['commit', '-m', 'snapshot T']), 0)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：基分支有未提交改动时拒绝（未提交改动检测）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp, { baseDirty: true })
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /基分支|未提交/)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：记录不存在报错；工作区已消失报错并提示 purge', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r1 = await mergeTask({ root: 'C:/repo', task: 'nope', cfg, git, repo: null })
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /不存在/)

    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: 'P', createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n'))
  const r2 = await mergeTask({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /工作区|purge/i)
  rmSync(tmp, { recursive: true, force: true })
})

// ---- finishTask ------------------------------------------------------------

test('finishTask：commit 模式执行 on_merge 触发器', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['worktree', 'remove', join(vault, 't')], OK())
  git.on(['branch', '-d', 'wtm/t'], OK('Deleted branch wtm/t'))
  /** @type {Array<{shell: string, args: string[], opts: object}>} */
  const triggerCalls = []
  const repo = { triggers: { on_merge: ['mark-merge'] } }
  const r = await finishTask({
    root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo,
    triggerSpawn: (shell, args, opts) => {
      triggerCalls.push({ shell, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    },
  })
  assert.equal(r.ok, true)
  assert.equal(triggerCalls.length, 1)
  assert.equal(/** @type {any} */ (triggerCalls[0].opts).cwd, 'C:/repo')
  assert.equal(/** @type {any} */ (triggerCalls[0].opts).env.WTM_TASK, 'T')
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：移除工作区失败时保留 on_merge 触发器警告', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['worktree', 'remove', join(vault, 't')], FAIL('cannot remove worktree'))

  const r = await finishTask({
    root: 'C:/repo',
    task: 'T',
    mode: 'commit',
    cfg,
    git,
    repo: { triggers: { on_merge: ['broken-merge-hook'] } },
    triggerSpawn: () => {
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('merge hook failed'))
        child.emit('close', 1, null)
      })
      return child
    },
  })

  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /cannot remove worktree/)
  assert.ok(r.warnings?.some((w) => /broken-merge-hook/.test(w)), JSON.stringify(r))
  assert.ok(r.warnings?.some((w) => /merge hook failed/.test(w)), JSON.stringify(r))
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：任务分支已合并时跳过 on_merge 触发器', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], OK())
  git.on(['worktree', 'remove', join(vault, 't')], OK())
  git.on(['branch', '-d', 'wtm/t'], OK('Deleted branch wtm/t'))
  let triggerCalls = 0

  const r = await finishTask({
    root: 'C:/repo',
    task: 'T',
    mode: 'commit',
    cfg,
    git,
    repo: { triggers: { on_merge: ['deploy.sh'] } },
    triggerSpawn: () => {
      triggerCalls += 1
      throw new Error('on_merge should not run for an already-merged branch')
    },
  })

  assert.equal(r.ok, true)
  assert.equal(r.merged, false)
  assert.equal(triggerCalls, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：commit 模式 = 提交 + 合并 + 删工作区 + 删分支 + 清记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp, { taskDirty: true })
  git.on(['worktree', 'remove', join(vault, 't')], OK())
  git.on(['branch', '-d', 'wtm/t'], OK('Deleted branch wtm/t'))
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.merged, true)
  assert.equal(r.committed, true)
  assert.equal(r.removed, true)
  assert.equal(r.branchDeleted, true)
  assert.ok(git.called(['worktree', 'remove', join(vault, 't')]))
  assert.ok(git.called(['branch', '-d', 'wtm/t']))
  assert.equal(loadLedger(vault).records.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：abandon 模式跳过提交与合并，强制删除', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp, { taskDirty: true })
  git.on(['worktree', 'remove', '--force', join(vault, 't')], OK())
  git.on(['branch', '-D', 'wtm/t'], OK())
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'abandon', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.merged, false)
  assert.equal(r.committed, false)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  assert.ok(git.called(['worktree', 'remove', '--force', join(vault, 't')]))
  assert.ok(git.called(['branch', '-D', 'wtm/t']))
  assert.equal(loadLedger(vault).records.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：abandon 模式发现工作区分支不一致时拒绝删除', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp, { taskBranch: 'other' })
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'abandon', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /分支与账本记录不一致/)
  assert.equal(git.count(['worktree', 'remove', '--force', join(vault, 't')]), 0)
  assert.equal(git.count(['branch', '-D', 'wtm/t']), 0)
  assert.deepEqual(loadLedger(vault).records.map((rec) => rec.branch), ['wtm/t'])
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：keep 模式仅解除管理，不触碰工作区与分支', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'keep', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(git.count(['worktree', 'remove', join(vault, 't')]), 0)
  assert.equal(git.count(['branch', '-d', 'wtm/t']), 0)
  assert.equal(loadLedger(vault).records.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：工作区已不存在时清记录并提示（stale 清理）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: 'P', createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n'))
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(loadLedger(cfg.vault).records.length, 0)
  assert.match(r.note ?? '', /已不存在/)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：工作区路径被普通文件替换时失败并保留记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  rmSync(taskPath, { recursive: true, force: true })
  fs.writeFileSync(taskPath, 'not a directory')

  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })

  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /工作区|目录/)
  assert.equal(loadLedger(vault).records.length, 1)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  assert.equal(git.count(['worktree', 'remove', taskPath]), 0)
  assert.equal(git.count(['branch', '-d', 'wtm/t']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：keep 模式工作区路径被普通文件替换时失败并保留记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  rmSync(taskPath, { recursive: true, force: true })
  fs.writeFileSync(taskPath, 'not a directory')

  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'keep', cfg, git, repo: null })

  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /工作区|目录/)
  assert.equal(loadLedger(vault).records.length, 1)
  assert.equal(git.count(['worktree', 'remove', taskPath]), 0)
  assert.equal(git.count(['branch', '-d', 'wtm/t']), 0)
  assert.equal(git.count(['branch', '-D', 'wtm/t']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：记录不存在报错；非法 mode 报错', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r1 = await finishTask({ root: 'C:/repo', task: 'nope', cfg, git, repo: null })
  assert.equal(r1.ok, false)
    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: 'P', createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\nworktree P\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n'))
  const r2 = await finishTask({ root: 'C:/repo', task: 'T', mode: 'bogus', cfg, git, repo: null })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /mode/i)
  rmSync(tmp, { recursive: true, force: true })
})

// ---- listStatus ------------------------------------------------------------

test('listStatus：计算存在性、脏状态与 ahead/behind', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T1', branch: 'wtm/t1', base: 'main', path: join(cfg.vault, 't1'), createdAt: 'c', updatedAt: 'u' })
  upsertRecord(ledger, { task: 'T2', branch: 'wtm/t2', base: 'main', path: join(cfg.vault, 't2'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(join(cfg.vault, 't1'), { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + join(cfg.vault, 't1') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t1\n',
  ))
  git.on(['status', '--porcelain'], OK(' M f.txt\n'))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t1'], OK('1\t2'))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t2'], FAIL())

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.rows, '应有 rows')
  const t1 = r.rows.find((x) => x.task === 'T1')
  const t2 = r.rows.find((x) => x.task === 'T2')
  assert.ok(t1, '应有 T1')
  assert.ok(t2, '应有 T2')
  assert.equal(t1.exists, true)
  assert.equal(t1.dirty, true)
  assert.deepEqual(t1.counts, { ahead: 2, behind: 1 })
  assert.equal(t2.exists, false)
  assert.equal(t2.counts, null)
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：git status 失败时标记状态未知并返回警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: join(cfg.vault, 't'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(join(cfg.vault, 't'), { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + join(cfg.vault, 't') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))
  git.on(['status', '--porcelain'], FAIL('fatal: damaged git metadata'))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], OK('0\t0'))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.rows, '应有 rows')
  assert.equal(r.rows[0].dirty, null, '无法读取时 dirty 必须为未知，而不是干净')
  assert.ok(r.warnings?.some((w) => /T/.test(w) && /damaged git metadata/.test(w)), JSON.stringify(r.warnings))
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：任务状态 Git 调用中止时返回取消结果而不继续统计', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))
  git.on(['status', '--porcelain'], { ok: false, code: -1, stdout: '', stderr: '', aborted: true })
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], OK('0\t0'))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /取消|abort/i)
  assert.equal(git.count(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：最后一次 Git 调用后 signal 中止时不返回部分结果', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })

  const ac = new AbortController()
  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))
  git.on(['status', '--porcelain'], OK(''))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], () => {
    ac.abort()
    return OK('0\t0')
  })

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /取消|abort/i)
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：rev-list 失败时保留未知计数并返回警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))
  git.on(['status', '--porcelain'], OK(''))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], FAIL('fatal: bad object'))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.rows?.[0].counts, null)
  assert.ok(r.warnings?.some((w) => /T/.test(w) && /bad object/.test(w)), JSON.stringify(r.warnings))
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：rev-list 输出格式异常时保留未知计数并返回警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))
  git.on(['status', '--porcelain'], OK(''))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], OK('not a count'))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.rows?.[0].counts, null)
  assert.ok(r.warnings?.some((w) => /T/.test(w) && /格式|计数|rev-list/i.test(w)), JSON.stringify(r.warnings))
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：工作区分支漂移时标记为不存在且不计算错误分支状态', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })

  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/other\n',
  ))
  git.on(['status', '--porcelain'], OK(' M wrong-branch.txt\n'))
  git.on(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t'], OK('1\t9'))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.rows, '应有 rows')
  assert.equal(r.rows[0].exists, false)
  assert.equal(r.rows[0].dirty, false)
  assert.equal(r.rows[0].counts, null)
  assert.equal(git.count(['status', '--porcelain']), 0, '分支漂移时不应读取错误工作区状态')
  assert.equal(git.count(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/heads/wtm/t']), 0, '分支漂移时不应计算错误分支计数')
  rmSync(tmp, { recursive: true, force: true })
})

// ---- purge -----------------------------------------------------------------

test('purge：commit 模式执行 on_merge 触发器', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['worktree', 'remove', join(vault, 't')], OK())
  git.on(['branch', '-d', 'wtm/t'], OK('Deleted branch wtm/t'))
  /** @type {Array<{shell: string, args: string[], opts: object}>} */
  const triggerCalls = []
  const repo = { triggers: { on_merge: ['mark-merge'] } }
  const r = await purge({
    root: 'C:/repo', tasks: ['T'], mode: 'commit', cfg, git, repo,
    triggerSpawn: (shell, args, opts) => {
      triggerCalls.push({ shell, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.results?.[0].ok, true)
  assert.equal(triggerCalls.length, 1)
  assert.equal(/** @type {any} */ (triggerCalls[0].opts).cwd, 'C:/repo')
  assert.equal(/** @type {any} */ (triggerCalls[0].opts).env.WTM_TASK, 'T')
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：保留收尾警告并报告分支删除失败', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  git.on(['worktree', 'remove', join(vault, 't')], OK())
  git.on(['branch', '-d', 'wtm/t'], FAIL('branch is not fully merged'))

  const r = await purge({ root: 'C:/repo', tasks: ['T'], mode: 'commit', cfg, git, repo: null })

  assert.equal(r.ok, true)
  const result = r.results?.[0]
  assert.ok(result, '应有 T 的收尾结果')
  assert.equal(result.branchDeleted, false)
  assert.ok(result.warnings?.some((w) => /分支删除失败/.test(w)), JSON.stringify(result))
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：批量清理，逐任务报告，单个失败不中断', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T1', branch: 'wtm/t1', base: 'main', path: join(cfg.vault, 't1'), createdAt: 'c', updatedAt: 'u' })
  upsertRecord(ledger, { task: 'T2', branch: 'wtm/t2', base: 'main', path: join(cfg.vault, 't2'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(join(cfg.vault, 't1'), { recursive: true })
  mkdirSync(join(cfg.vault, 't2'), { recursive: true })
  const wt = 'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + join(cfg.vault, 't1') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t1\n\n' +
    'worktree ' + join(cfg.vault, 't2') + '\nHEAD ' + '3'.repeat(40) + '\nbranch refs/heads/wtm/t2\n'
  git.on(['worktree', 'list', '--porcelain'], OK(wt))
  // T1 正常，T2 的 merge 失败
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t1', 'HEAD'], FAIL('not an ancestor', 1))
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t2', 'HEAD'], FAIL('not an ancestor', 1))
  git.on(['status', '--porcelain'], OK(''))
  git.on(['merge', '--no-ff', 'refs/heads/wtm/t1', '-m', 'fold T1 into main'], OK('merged'))
  git.on(['merge', '--no-ff', 'refs/heads/wtm/t2', '-m', 'fold T2 into main'], FAIL('conflict'))
  git.on(['worktree', 'remove', join(cfg.vault, 't1')], OK())
  git.on(['worktree', 'remove', join(cfg.vault, 't2')], OK())
  git.on(['branch', '-d', 'wtm/t1'], OK())
  git.on(['branch', '-d', 'wtm/t2'], OK())

  const r = await purge({ root: 'C:/repo', tasks: ['T1', 'T2'], cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.results, '应有 results')
  assert.equal(r.results.length, 2)
  const t1 = r.results.find((x) => x.task === 'T1')
  const t2 = r.results.find((x) => x.task === 'T2')
  assert.ok(t1, '应有 T1')
  assert.ok(t2, '应有 T2')
  assert.equal(t1.ok, true)
  assert.equal(t2.ok, false)
  assert.match(t2.error ?? '', /conflict/)
  assert.equal(loadLedger(cfg.vault).records.length, 1)
  assert.equal(loadLedger(cfg.vault).records[0].task, 'T2')
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：未指定 tasks 也未指定 all 时报错；未知任务单独报告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r1 = await purge({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r1.ok, false)
  const r2 = await purge({ root: 'C:/repo', tasks: ['ghost'], cfg, git, repo: null })
  assert.equal(r2.ok, true)
  assert.ok(r2.results, '应有 results')
  assert.equal(r2.results[0].ok, false)
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：all 模式处理全部记录', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
    const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T1', branch: 'wtm/t1', base: 'main', path: 'P1', createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  // 工作区已消失 → stale 清理分支
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n'))
  const r = await purge({ root: 'C:/repo', all: true, cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.results, '应有 results')
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, true)
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：工作区路径被普通文件替换时报告失败并保留记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  rmSync(taskPath, { recursive: true, force: true })
  fs.writeFileSync(taskPath, 'not a directory')

  const r = await purge({ root: 'C:/repo', tasks: ['T'], mode: 'commit', cfg, git, repo: null })

  assert.equal(r.ok, true)
  assert.equal(r.results?.[0].ok, false)
  assert.match(r.results?.[0].error ?? '', /工作区|目录/)
  assert.equal(loadLedger(vault).records.length, 1)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  assert.equal(git.count(['worktree', 'remove', taskPath]), 0)
  assert.equal(git.count(['branch', '-d', 'wtm/t']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('purge：keep 模式工作区路径被普通文件替换时报告失败并保留记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  rmSync(taskPath, { recursive: true, force: true })
  fs.writeFileSync(taskPath, 'not a directory')

  const r = await purge({ root: 'C:/repo', tasks: ['T'], mode: 'keep', cfg, git, repo: null })

  assert.equal(r.ok, true)
  assert.equal(r.results?.[0].ok, false)
  assert.match(r.results?.[0].error ?? '', /工作区|目录/)
  assert.equal(loadLedger(vault).records.length, 1)
  assert.equal(git.count(['worktree', 'remove', taskPath]), 0)
  assert.equal(git.count(['branch', '-d', 'wtm/t']), 0)
  assert.equal(git.count(['branch', '-D', 'wtm/t']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

// ── 第一轮审查补充的回归测试 ────────────────────────────────────────────────

test('mergeTask：工作区分支与账本不一致时拒绝（防静默错分支提交）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: join(cfg.vault, 't'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(join(cfg.vault, 't'), { recursive: true })
  // 工作区在别的分支上
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\nworktree ' + join(cfg.vault, 't') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/other\n'))
  const r = await mergeTask({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /不一致/)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0, '不应执行合并')
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：主工作区不在账本基分支时拒绝（防合入错误分支）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp)
  git.on(['branch', '--show-current'], OK('develop\n'))
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /develop/)
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：任务分支已合并时跳过重复合并（重试不再产生空 merge 提交）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp)
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], OK())
  const r = await mergeTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.merged, false)
  assert.ok((r.warnings ?? []).some((w) => /已包含/.test(w)))
  assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：任务分支已合并时跳过 on_merge 触发器', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp)
  git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], OK())
  let triggerCalls = 0

  const r = await mergeTask({
    root: 'C:/repo',
    task: 'T',
    mode: 'commit',
    cfg,
    git,
    repo: { triggers: { on_merge: ['deploy.sh'] } },
    triggerSpawn: () => {
      triggerCalls += 1
      throw new Error('on_merge should not run for an already-merged branch')
    },
  })

  assert.equal(r.ok, true)
  assert.equal(r.merged, false)
  assert.equal(triggerCalls, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask/finishTask：缺少任务名直接报错（不出现 undefined）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r1 = await mergeTask({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /task/)
  const r2 = await finishTask({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /task/)
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：seed 路径穿越被拦截并告警（不复制仓库外文件）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'vault', 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())
  const repo = { seed: { files: ['../evil.txt', '/abs/evil.txt'] } }
  const r = await begin({ root: 'C:/repo', task: 'T', cfg, git, repo })
  assert.equal(r.ok, true)
  const evilWarnings = (r.warnings ?? []).filter((w) => /越界/.test(w))
  assert.equal(evilWarnings.length, 2, JSON.stringify(r.warnings))
  rmSync(tmp, { recursive: true, force: true })
})

test('begin：不同任务派生同一 slug 时拒绝（工作区路径冲突）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  // 账本中已有任务 A-B 占用同一工作区路径（a b 与 a-b 的 slug 相同）
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'A-B', branch: 'wtm/a-b', base: 'main', path: join(cfg.vault, 'a-b'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/a-b'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  const r = await begin({ root: 'C:/repo', task: 'a b', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /工作区目录/)
  rmSync(tmp, { recursive: true, force: true })
})

// ── 第二轮审查补充的回归测试 ────────────────────────────────────────────────

test('finishTask：commit 模式工作区分支不一致时拒绝（收尾路径的分支漂移防护）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp, { taskDirty: true })
  // 工作区被切到其他分支
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\nworktree ' + join(cfg.vault, 't') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/other\n'))
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /不一致/)
  assert.equal(git.count(['commit', '-m', 'snapshot T']), 0, '不应执行快照提交')
  assert.equal(git.count(['worktree', 'remove', join(cfg.vault, 't')]), 0, '不应移除工作区')
  // 账本记录应保留
  assert.equal(loadLedger(cfg.vault).records.length, 1)
  rmSync(tmp, { recursive: true, force: true })
})

test('mergeTask：工作区目录被外部删除时按 stale 报错（注册表仍列出 prunable 条目）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp)
  // 删除目录（模拟外部 rm -rf），但 worktree list 仍列出该条目（git 未 prune）
  rmSync(join(cfg.vault, 't'), { recursive: true, force: true })
  const r = await mergeTask({ root: 'C:/repo', task: 'T', cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /已不存在/)
  assert.equal(git.count(['status', '--porcelain']), 0, '不应尝试在已删除目录上运行 git')
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：工作区目录被外部删除时清理记录（stale 清理真实可达）', async () => {
  const tmp = makeTmp()
  const { cfg, git } = mergeFixture(tmp)
  rmSync(join(cfg.vault, 't'), { recursive: true, force: true })
  const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.match(r.note ?? '', /已不存在/)
  assert.equal(loadLedger(cfg.vault).records.length, 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('finishTask：工作区暂时不可访问时失败并保留记录', async () => {
  const tmp = makeTmp()
  const { cfg, git, vault } = mergeFixture(tmp)
  const taskPath = join(vault, 't')
  const realStatSync = fs.statSync
  const inaccessible = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  mock.method(fs, 'statSync', (/** @type {string} */ target) => {
    if (target === taskPath) throw inaccessible
    return realStatSync(target)
  })
  syncBuiltinESMExports()

  try {
    const r = await finishTask({ root: 'C:/repo', task: 'T', mode: 'commit', cfg, git, repo: null })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /工作区/)
    assert.match(r.error ?? '', /permission denied/)
    assert.equal(loadLedger(vault).records.length, 1)
    assert.equal(git.count(['commit', '-m', 'snapshot T']), 0)
    assert.equal(git.count(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'fold T into main']), 0)
    assert.equal(git.count(['worktree', 'remove', taskPath]), 0)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('listStatus：工作区目录被外部删除时 exists=false（不谎报健康）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: join(cfg.vault, 't'), createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  // 注册表仍列出（prunable），但目录不存在
  git.on(['worktree', 'list', '--porcelain'], OK('worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\nworktree ' + join(cfg.vault, 't') + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n'))
  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.ok(r.rows, '应有 rows')
  assert.equal(r.rows[0].exists, false)
  assert.equal(git.count(['status', '--porcelain']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：工作区路径被普通文件替换时 exists=false（不在文件上运行 git）', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  fs.writeFileSync(taskPath, 'not a directory')
  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))

  const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
  assert.equal(r.ok, true)
  assert.equal(r.rows?.[0].exists, false)
  assert.equal(r.rows?.[0].dirty, false)
  assert.equal(r.rows?.[0].counts, null)
  assert.equal(git.count(['status', '--porcelain']), 0)
  rmSync(tmp, { recursive: true, force: true })
})

test('listStatus：工作区暂时不可访问时标记未知并返回警告', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const taskPath = join(cfg.vault, 't')
  const ledger = structuredClone(EMPTY_LEDGER)
  upsertRecord(ledger, { task: 'T', branch: 'wtm/t', base: 'main', path: taskPath, createdAt: 'c', updatedAt: 'u' })
  saveLedger(cfg.vault, ledger)
  mkdirSync(taskPath, { recursive: true })
  git.on(['worktree', 'list', '--porcelain'], OK(
    'worktree C:/repo\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n\n' +
    'worktree ' + taskPath + '\nHEAD ' + '2'.repeat(40) + '\nbranch refs/heads/wtm/t\n',
  ))

  const realStatSync = fs.statSync
  const inaccessible = Object.assign(new Error('I/O error'), { code: 'EIO' })
  mock.method(fs, 'statSync', (/** @type {string} */ target) => {
    if (target === taskPath) throw inaccessible
    return realStatSync(target)
  })
  syncBuiltinESMExports()

  try {
    const r = await listStatus({ root: 'C:/repo', cfg, git, repo: null })
    assert.equal(r.ok, true)
    assert.ok(r.rows, '应有 rows')
    assert.equal(r.rows[0].exists, false)
    assert.equal(r.rows[0].dirty, null)
    assert.equal(r.rows[0].counts, null)
    assert.ok(r.warnings?.some((w) => /T/.test(w) && /I\/O error/.test(w)), JSON.stringify(r.warnings))
    assert.equal(git.count(['status', '--porcelain']), 0)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('purge：all 与 tasks 同时指定时报错', async () => {
  const tmp = makeTmp()
  const cfg = baseCfg(tmp)
  const git = new FakeGit()
  const r = await purge({ root: 'C:/repo', tasks: ['T1'], all: true, cfg, git, repo: null })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /二选一/)
  rmSync(tmp, { recursive: true, force: true })
})
