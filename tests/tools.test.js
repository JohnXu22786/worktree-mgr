import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolSet } from '../src/tools.js'

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

test('createToolSet：注册 5 个工具，schema 完整且 render 返回 text', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: { root: 'C:/repo' }, git })
  assert.equal(tools.length, 5)
  const names = tools.map((t) => t.name)
  assert.deepEqual(names.sort(), ['wtm_begin', 'wtm_finish', 'wtm_merge', 'wtm_purge', 'wtm_status'].sort())
  for (const t of tools) {
    assert.equal(typeof t.description, 'string')
    assert.ok(t.description.length > 20, `${t.name} 描述过短`)
    assert.equal(typeof t.parameters, 'object')
    assert.ok(t.parameters.task || t.name === 'wtm_status' || t.name === 'wtm_purge')
    assert.equal(typeof t.output, 'object')
    assert.ok(t.output.schema)
    assert.equal(typeof t.output.render, 'function')
    const rendered = t.output.render({}, { ok: true, rows: [] })
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    assert.equal(typeof t.execute, 'function')
  }
})

test('createToolSet：必填参数声明 required: true', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  const status = tools.find((t) => t.name === 'wtm_status')
  assert.ok(begin, '工具 begin 应存在')
  assert.ok(status, '工具 status 应存在')
  assert.equal(/** @type {{required?: boolean}} */ (begin.parameters.task).required, true)
  assert.equal(/** @type {{root?: {required?: boolean}}} */ (status.parameters).root?.required, undefined)
})

test('wtm_begin：经工具入口完成创建并落账本', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-tools-test-'))
  const git = new FakeGit()
  git.on(['rev-parse', '--show-toplevel'], OK('C:/repo\n'))
  git.on(['branch', '--show-current'], OK('main\n'))
  git.on(['rev-parse', '--verify', 'refs/heads/main'], OK())
  git.on(['show-ref', '--verify', 'refs/heads/wtm/new-task'], FAIL())
  git.on(['status', '--porcelain'], OK(''))
  git.on(['worktree', 'add', join(tmp, 'new-task'), '-b', 'wtm/new-task', 'main'], OK())
  const tools = createToolSet({ config: { root: 'C:/repo', vault: tmp }, git })
  const begin = tools.find((t) => t.name === 'wtm_begin')
  assert.ok(begin, '工具 begin 应存在')
  const value = /** @type {{ok: boolean, branch?: string, error?: string}} */ (await begin.execute({ task: 'New Task' }, { signal: makeSignal() }))
  assert.equal(value.ok, true)
  assert.equal(value.branch, 'wtm/new-task')
  assert.equal(existsSync(join(tmp, 'index.json')), true)
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
    git.on(['rev-parse', '--verify', 'refs/heads/main'], OK())
    git.on(['show-ref', '--verify', 'refs/heads/wtm/t'], FAIL())
    git.on(['status', '--porcelain'], OK(''))
    git.on(['worktree', 'add', join(tmp, 't'), '-b', 'wtm/t', 'main'], OK())
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
  rmSync(tmp, { recursive: true, force: true })
})

test('wtm_finish 必填参数与默认 mode', () => {
  const git = new FakeGit()
  const tools = createToolSet({ config: {}, git })
  const finish = tools.find((t) => t.name === 'wtm_finish')
  assert.ok(finish, '工具 finish 应存在')
  const fp = /** @type {{task: {required?: boolean}, mode?: {required?: boolean, enum?: string[]}}} */ (finish.parameters)
  assert.equal(fp.task.required, true)
  assert.equal(fp.mode?.required, undefined) // 可选，默认 commit
  assert.equal(fp.mode?.enum?.includes('commit'), true)
  assert.equal(fp.mode?.enum?.includes('abandon'), true)
  assert.equal(fp.mode?.enum?.includes('keep'), true)
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



