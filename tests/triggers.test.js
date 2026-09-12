import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      child.emit('close', b.code ?? 0, null)
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
      queueMicrotask(() => {
        child.emit('error', new Error('spawn ENOENT'))
        child.emit('close', null, null)
      })
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
      queueMicrotask(() => {
        child2.emit('exit', null, 'SIGKILL')
        child2.emit('close', null, 'SIGKILL')
      })
      return child2
    },
  })
  assert.equal(w2.warnings.length, 1)
  assert.match(w2.warnings[0], /SIGKILL/)
})

test('runTriggers：触发器期间 abort 时传播 signal 并停止后续命令', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const ac = new AbortController()
  const result = await runTriggers(['abort-cmd', 'later-cmd'], {}, {
    signal: ac.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        ac.abort()
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return child
    },
  })
  assert.equal(captured.length, 1)
  assert.equal(/** @type {any} */ (captured[0].opts).signal, ac.signal)
  assert.deepEqual(result.warnings, [])
})

test('runTriggers：AbortError 后等待 close 再返回', async () => {
  const ac = new AbortController()
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let closed = false
  const pending = runTriggers(['abort-cmd'], {}, {
    signal: ac.signal,
    spawn: () => {
      queueMicrotask(() => {
        ac.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        child.emit('error', err)
        setTimeout(() => {
          closed = true
          child.emit('close', null, 'SIGTERM')
        }, 30)
      })
      return child
    },
  })
  let settled = false
  const result = pending.then((value) => {
    settled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(settled, false)
  const { warnings } = await result
  assert.equal(closed, true)
  assert.deepEqual(warnings, [])
})

test('runTriggers：abort 后不会让 shell 子进程继续执行', { skip: process.platform === 'win32' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-abort-'))
  const marker = join(tmp, 'completed')
  const ac = new AbortController()
  try {
    await runTriggers([`trap '' TERM; sleep 0.4 && touch ${marker}`], {}, {
      signal: ac.signal,
      spawn: (cmd, args, opts) => {
        const child = spawn(cmd, args, opts)
        setTimeout(() => ac.abort(), 20)
        return child
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
