import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runTriggers } from '../src/triggers.js'

// 可注入的假 spawn：捕获调用并模拟子进程输出与退出
/**
 * @param {Array<{cmd: string, args: string[], opts: object}>} captured
 * @param {Record<string | number, {code?: number, stderr?: string, stdout?: string}>} [behaviors]
 */
function makeFakeSpawn(captured, behaviors = {}) {
  return (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object} */ opts) => {
    captured.push({ cmd, args, opts })
    const child = /** @type {any} */ (new EventEmitter())
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const b = behaviors[captured.length - 1] ?? behaviors.default ?? { code: 0 }
    queueMicrotask(() => {
      if (b.stderr) child.stderr.emit('data', Buffer.from(b.stderr))
      if (b.stdout) child.stdout.emit('data', Buffer.from(b.stdout))
      child.emit('exit', b.code ?? 0, null)
    })
    return child
  }
}

test('runTriggers：无命令时跳过且不产生警告', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const { warnings } = await runTriggers([], { task: 'T' }, { spawn: makeFakeSpawn(captured) })
  assert.equal(captured.length, 0)
  assert.deepEqual(warnings, [])
})

test('runTriggers：逐条执行命令并传入 WTM_* 环境变量', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const { warnings } = await runTriggers(
    ['cmd-a', 'cmd-b'],
    { task: 'T1', branch: 'wtm/t1', base: 'main', path: 'P', root: 'R' },
    { spawn: makeFakeSpawn(captured) },
  )
  assert.equal(captured.length, 2)
  for (const c of captured) {
    const env = /** @type {Record<string, string>} */ (/** @type {any} */ (c.opts).env)
    assert.equal(env.WTM_TASK, 'T1')
    assert.equal(env.WTM_BRANCH, 'wtm/t1')
    assert.equal(env.WTM_BASE, 'main')
    assert.equal(env.WTM_PATH, 'P')
    assert.equal(env.WTM_ROOT, 'R')
  }
  assert.deepEqual(warnings, [])
})

test('runTriggers：使用平台 shell（win32=cmd，其他=sh）', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  await runTriggers(['echo hi'], {}, { spawn: makeFakeSpawn(captured) })
  const { cmd, args } = captured[0]
  if (process.platform === 'win32') {
    assert.equal(cmd.toLowerCase(), 'cmd')
    assert.ok(args.some((/** @type {string} */ a) => /\/c/i.test(a)))
  } else {
    assert.equal(cmd, 'sh')
    assert.deepEqual(args, ['-c', 'echo hi'])
  }
})

test('runTriggers：命令失败产生警告，其余命令继续执行', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const behaviors = { default: { code: 0 }, 0: { code: 2, stderr: 'boom' } }
  const { warnings } = await runTriggers(['fail-cmd', 'ok-cmd'], {}, { spawn: makeFakeSpawn(captured, behaviors) })
  assert.equal(captured.length, 2, '失败命令不应中断后续命令')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /fail-cmd/)
  assert.match(warnings[0], /boom/)
})

test('runTriggers：进程信号（非 0 code）与错误事件都归为警告', async () => {
  /** @type {Array<any>} */
  const captured = []
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  captured.push('x')
  const w1 = await runTriggers(['sig-cmd'], {}, {
    spawn: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      return child
    },
  })
  assert.equal(w1.warnings.length, 1)
  assert.match(w1.warnings[0], /ENOENT/)
  const child2 = /** @type {any} */ (new EventEmitter())
  child2.stdout = new EventEmitter()
  child2.stderr = new EventEmitter()
  const w2 = await runTriggers(['sig-cmd2'], {}, {
    spawn: () => {
      queueMicrotask(() => child2.emit('exit', null, 'SIGKILL'))
      return child2
    },
  })
  assert.equal(w2.warnings.length, 1)
  assert.match(w2.warnings[0], /SIGKILL/)
})


