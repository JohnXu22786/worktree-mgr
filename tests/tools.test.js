import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolSet, readRepoConfig } from '../src/tools.js'
import { GitRunner } from '../src/git.js'
import { EMPTY_LEDGER, saveLedger, upsertRecord } from '../src/vault.js'

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
    return typeof a === 'function' ? a() : a
  }
}

const OK = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
const FAIL = (stderr = 'nope') => ({ ok: false, code: 128, stdout: '', stderr })

function makeSignal() {
  return new AbortController().signal
}

test('createToolSet：注册 5 个工具，参数为对象 schema 且 render 返回 text', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: { root: 'C:/repo' }, git })
  assert.equal(tools.length, 5)
  const names = tools.map((t) => t.name)
  assert.deepEqual(names.sort(), ['wtm_begin', 'wtm_finish', 'wtm_merge', 'wtm_purge', 'wtm_status'].sort())
  for (const t of tools) {
    assert.equal(typeof t.description, 'string')
    assert.ok(t.description.length > 20, `${t.name} 描述过短`)
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.parameters.properties, 'object')
    assert.ok(t.parameters.properties.task || t.name === 'wtm_status' || t.name === 'wtm_purge')
    assert.equal(typeof t.output, 'object')
    assert.ok(t.output.schema)
    assert.equal(typeof t.output.render, 'function')
    const rendered = t.output.render({}, { ok: true, rows: [] })
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    assert.equal(typeof t.execute, 'function')
  }
})

test('wtm_purge：渲染分支删除状态和收尾警告', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const purge = tools.find((t) => t.name === 'wtm_purge')
  assert.ok(purge, '工具 purge 应存在')

  const rendered = purge.output.render({}, {
    ok: true,
    results: [{
      task: 'T',
      ok: true,
      branchDeleted: false,
      warnings: ['分支删除失败（wtm/t）：branch is not fully merged'],
    }],
  })
  const text = rendered[0].text
  assert.match(text, /T/)
  assert.match(text, /分支未删除/)
  assert.match(text, /分支删除失败/)
})

test('wtm_purge：无任务时渲染顶层仓库配置警告', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  try {
    writeFileSync(join(tmp, '.wtm.json'), '{broken')
    const git = new FakeGit()
    git.on(['rev-parse', '--show-toplevel'], OK(tmp + '\n'))
    const tools = createToolSet({ config: { root: tmp, vault: join(tmp, 'vault') }, git })
    const purge = tools.find((t) => t.name === 'wtm_purge')
    assert.ok(purge, '工具 purge 应存在')

    const value = /** @type {{ok: boolean, results?: Array<object>, warnings?: string[]}} */ (
      await purge.execute({ all: true }, { signal: makeSignal() })
    )
    assert.equal(value.ok, true)
    assert.deepEqual(value.results, [])
    assert.ok(value.warnings?.some((w) => /\.wtm\.json/i.test(w)), JSON.stringify(value))

    const rendered = purge.output.render({}, value)
    assert.match(rendered[0].text, /批量清理完成（0 个任务）/)
    assert.match(rendered[0].text, /\.wtm\.json/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createToolSet：必填参数声明在 schema.required 中', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  const status = tools.find((t) => t.name === 'wtm_status')
  assert.ok(begin, '工具 begin 应存在')
  assert.ok(status, '工具 status 应存在')
  assert.deepEqual(begin.parameters.required, ['task'])
  assert.deepEqual(status.parameters.required, undefined)
})

test('wtm_begin：经工具入口完成创建并落账本', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK('C:/repo\n'))
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/new-task'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'new-task'), '-b', 'wtm/new-task', 'refs/heads/main'], OK())
  const tools = createToolSet({ config: { root: 'C:/repo', vault: tmp }, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')
  const value = /** @type {{ok: boolean, branch?: string, error?: string}} */ (await begin.execute({ task: 'New Task' }, { signal: makeSignal() }))
  assert.equal(value.ok, true)
  assert.equal(value.branch, 'wtm/new-task')
  assert.equal(existsSync(join(tmp, 'index.json')), true)
  rmSync(tmp, { recursive: true, force: true })
})

test('wtm_begin：失败时合并并渲染操作警告', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  const root = join(tmp, 'repo')
  const vault = join(tmp, 'vault')
  mkdirSync(root)
  const indexPath = join(vault, 'index.json')
  const worktreePath = join(vault, 't')
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK(`${root}\n`))
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
  git.on(['status', '--porcelain'], OK())
  git.on(['worktree', 'add', worktreePath, '-b', 'wtm/t', 'refs/heads/main'], () => {
    // 让 worktree 创建后账本写入失败，从而进入 begin() 的回滚路径。
    mkdirSync(indexPath)
    return OK()
  })
  git.on(['worktree', 'remove', '--force', worktreePath], FAIL('fatal: cannot remove worktree'))
  git.on(['branch', '-D', 'wtm/t'], OK())

  const tools = createToolSet({ config: { root, vault, unknown: true }, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')
  const value = /** @type {{ok: boolean, error?: string, warnings?: string[]}} */ (
    await begin.execute({ task: 'T' }, { signal: makeSignal() })
  )
  assert.equal(value.ok, false)
  assert.ok(value.warnings?.some((w) => /未知或类型不符/.test(w)), JSON.stringify(value))
  assert.ok(value.warnings?.some((w) => /cannot remove worktree/.test(w)), JSON.stringify(value))

  const rendered = begin.output.render({}, value)
  assert.match(rendered[0].text, /创建失败/)
  assert.match(rendered[0].text, /cannot remove worktree/)
  rmSync(tmp, { recursive: true, force: true })
})

test('wtm_begin：非 git 目录返回友好错误（不抛异常）', async () => {
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], FAIL('fatal: not a git repository'))
  const tools = createToolSet({ config: {}, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')
  const value = /** @type {{ok: boolean, error?: string}} */ (await begin.execute({ task: 'T' }, { signal: makeSignal() }))
  assert.equal(value.ok, false)
  assert.match(value.error ?? '', /git/i)
})

test('wtm_begin：显式 root 参数优先于配置', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-x-'))
  const git = new FakeGit()
  try {
    git.on(['rev-parse', '--show-toplevel'], OK('D:/explicit\n'))
    git.on(['branch', '--show-current'], OK('main\n'))
    git.on(['show-ref', '--verify', 'refs/heads/main'], OK())
    git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
    git.on(['status', '--porcelain'], OK(''))
    git.on(['worktree', 'add', join(tmp, 't'), '-b', 'wtm/t', 'refs/heads/main'], OK())
    const tools = createToolSet({ config: { root: 'C:/wrong', vault: tmp }, git })
    const begin = tools.find((t) => t.name === 'wtm_begin')
    assert.ok(begin, '工具 begin 应存在')
    const value = /** @type {{ok: boolean, branch?: string, error?: string}} */ (await begin.execute({ task: 'T', root: 'D:/explicit' }, { signal: makeSignal() }))
    // 参数 root 优先级高于 config.root：rev-parse 的 cwd 应为显式 root
    assert.equal(git.calls[0].cwd, 'D:/explicit')
    assert.equal(value.ok, true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('wtm_begin：aborted signal 直接返回取消错误，不执行任何 git 命令', async () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')
  const ac = new AbortController()
  ac.abort()
  const value = /** @type {{ok: boolean, error?: string}} */ (await begin.execute({ task: 'T' }, { signal: ac.signal }))
  assert.equal(value.ok, false)
  assert.match(value.error ?? '', /取消|abort/i)
  assert.equal(git.calls.length, 0)
})

test('wtm_begin：root 解析期间中止时返回取消错误而非非 git 仓库错误', async () => {
  const git = new FakeGit()
  const ac = new AbortController()
  git.on(['rev-parse', '--show-toplevel'], () => {
    ac.abort()
    return FAIL('rev-parse aborted')
  })
  const tools = createToolSet({ config: {}, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')

  const value = /** @type {{ok: boolean, error?: string}} */ (
    await begin.execute({ task: 'T' }, { signal: ac.signal })
  )
  assert.equal(value.ok, false)
  assert.match(value.error ?? '', /取消|abort/i)
  assert.doesNotMatch(value.error ?? '', /不是 git 仓库/)
})

test('wtm_status：损坏的仓库配置 .wtm.json 以警告呈现而非崩溃', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  writeFileSync(join(tmp, '.wtm.json'), '{broken')
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK(tmp + '\n'))
  git.on(['worktree', 'list', '--porcelain'], OK('worktree ' + tmp + '\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n'))
  const tools = createToolSet({ config: {}, git })
  const status = tools.find((t) => t.name === 'wtm_status')
  assert.ok(status, '工具 status 应存在')
  const value = /** @type {{ok: boolean, warnings?: string[], rows?: Array<object>}} */ (await status.execute({}, { signal: makeSignal() }))
  assert.equal(value.ok, true)
  assert.ok(value.warnings, '应有 warnings')
  assert.ok(value.warnings.length >= 1, JSON.stringify(value.warnings))
  assert.match(value.warnings[0], /\.wtm\.json/i)
  assert.deepEqual(value.rows, [])
  const rendered = status.output.render({}, value)
  assert.match(rendered[0].text, /\.wtm\.json/i)
  rmSync(tmp, { recursive: true, force: true })
})

test('wtm_status：root 解析同步失败时返回结构化错误而非抛异常', async () => {
  const tools = createToolSet({ config: {}, git: new GitRunner() })
  const status = tools.find((t) => t.name === 'wtm_status')
  assert.ok(status, '工具 status 应存在')

  const value = /** @type {{ok: boolean, error?: string}} */ (
    await status.execute({ root: 'bad\0path' }, { signal: makeSignal() })
  )
  assert.equal(value.ok, false)
  assert.match(value.error ?? '', /invalid|argument|path/i)
})

test('wtm_status：默认 root 的 cwd 不可用时返回结构化错误而非抛异常', async () => {
  const originalCwd = process.cwd()
  const unavailableCwd = mkdtempSync(join(tmpdir(), 'wtm-tools-cwd-'))
  const hadWtmRoot = Object.hasOwn(process.env, 'WTM_ROOT')
  const originalWtmRoot = process.env.WTM_ROOT
  delete process.env.WTM_ROOT
  process.chdir(unavailableCwd)
  rmSync(unavailableCwd, { recursive: true, force: true })

  try {
    const git = new FakeGit()
    const tools = createToolSet({ config: {}, git })
    const status = tools.find((t) => t.name === 'wtm_status')
    assert.ok(status, '工具 status 应存在')

    const value = /** @type {{ok: boolean, error?: string}} */ (
      await status.execute({}, { signal: makeSignal() })
    )
    assert.equal(value.ok, false)
    assert.match(value.error ?? '', /cwd|ENOENT|no such file/i)
    assert.equal(git.calls.length, 0)
  } finally {
    process.chdir(originalCwd)
    if (hadWtmRoot) process.env.WTM_ROOT = originalWtmRoot
    else delete process.env.WTM_ROOT
  }
})

test('wtm_merge/wtm_finish/wtm_purge：失败时渲染操作警告', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const warning = '仓库配置 .wtm.json 解析失败，已忽略'

  for (const name of ['wtm_merge', 'wtm_finish', 'wtm_purge']) {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool, `${name} 工具应存在`)
    const rendered = tool.output.render({}, {
      ok: false,
      error: '操作失败',
      warnings: [warning],
    })
    assert.match(rendered[0].text, /操作失败/)
    assert.match(rendered[0].text, /\.wtm\.json/)
  }
})

test('readRepoConfig：配置文件读取失败时传播文件系统错误', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  try {
    mkdirSync(join(tmp, '.wtm.json'))
    assert.throws(() => readRepoConfig(tmp), (error) => {
      assert.equal(error?.code, 'EISDIR')
      return true
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('工具调用：仓库配置读取失败时返回结构化错误', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  try {
    mkdirSync(join(tmp, '.wtm.json'))
    const git = new FakeGit()
    git.on(['rev-parse', '--show-toplevel'], OK(`${tmp}\n`))
    const tools = createToolSet({ config: {}, git })
    const status = tools.find((t) => t.name === 'wtm_status')
    assert.ok(status, '工具 status 应存在')
    const value = /** @type {{ok: boolean, error?: string}} */ (
      await status.execute({}, { signal: makeSignal() })
    )
    assert.equal(value.ok, false)
    assert.match(value.error ?? '', /EISDIR/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('wtm_finish 必填参数与默认 mode', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const finish = tools.find((t) => t.name === 'wtm_finish')
  assert.ok(finish, '工具 finish 应存在')
  const fp = /** @type {{type: 'object', properties: {task: object, mode?: {enum?: string[]}}, required?: string[]}} */ (
    /** @type {unknown} */ (finish.parameters)
  )
  assert.deepEqual(fp.required, ['task'])
  assert.equal(fp.properties.mode?.enum?.includes('commit'), true)
  assert.equal(fp.properties.mode?.enum?.includes('abandon'), true)
  assert.equal(fp.properties.mode?.enum?.includes('keep'), true)
})

test('wtm_finish：移除工作区失败时保留操作警告', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  try {
    const root = join(tmp, 'repo')
    const vault = join(tmp, 'vault')
    const worktreePath = join(vault, 't')
    mkdirSync(root, { recursive: true })
    mkdirSync(worktreePath, { recursive: true })
    const triggerCommand = 'wtm-test-missing-merge-hook'
    writeFileSync(join(root, '.wtm.json'), JSON.stringify({ triggers: { on_merge: [triggerCommand] } }))

    const ledger = structuredClone(EMPTY_LEDGER)
    upsertRecord(ledger, {
      task: 'T', branch: 'wtm/t', base: 'main', path: worktreePath,
      createdAt: 'c', updatedAt: 'u',
    })
    saveLedger(vault, ledger)

    const git = new FakeGit()
    git.on(['rev-parse', '--show-toplevel'], OK(`${root}\n`))
    git.on(['worktree', 'list', '--porcelain'], OK(
      `worktree ${root}\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\n` +
      `worktree ${worktreePath}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/wtm/t\n`,
    ))
    git.on(['status', '--porcelain'], OK())
    git.on(['branch', '--show-current'], OK('main\n'))
    git.on(['merge-base', '--is-ancestor', 'refs/heads/wtm/t', 'HEAD'], { ok: false, code: 1, stdout: '', stderr: 'not an ancestor' })
    git.on(['merge', '--no-ff', 'refs/heads/wtm/t', '-m', 'merge(wtm): fold T into main'], OK('merged'))
    git.on(['worktree', 'remove', worktreePath], FAIL('cannot remove worktree'))

    const tools = createToolSet({ config: { root, vault }, git })
    const finish = tools.find((t) => t.name === 'wtm_finish')
    assert.ok(finish, '工具 finish 应存在')
    const value = /** @type {{ok: boolean, error?: string, warnings?: string[]}} */ (
      await finish.execute({ task: 'T' }, { signal: makeSignal() })
    )

    assert.equal(value.ok, false)
    assert.match(value.error ?? '', /cannot remove worktree/)
    assert.ok(value.warnings?.some((w) => w.includes(triggerCommand)), JSON.stringify(value))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('wtm_status：无任务时返回空总览', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  mkdirSync(join(tmp, 'vault'))
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK(tmp + '\n'))
  git.on(['worktree', 'list', '--porcelain'], OK('worktree ' + tmp + '\nHEAD ' + '1'.repeat(40) + '\nbranch refs/heads/main\n'))
  const tools = createToolSet({ config: { root: tmp, vault: join(tmp, 'vault') }, git })
  const status = tools.find((t) => t.name === 'wtm_status')
  assert.ok(status, '工具 status 应存在')
  const value = /** @type {{ok: boolean, rows?: Array<object>}} */ (await status.execute({}, { signal: makeSignal() }))
  assert.equal(value.ok, true)
  assert.deepEqual(value.rows, [])
  rmSync(tmp, { recursive: true, force: true })
})
