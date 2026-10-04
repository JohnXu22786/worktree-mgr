import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTriggers } from '../src/triggers.js'

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_CANCEL_SETTLE_MS = 1500

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

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
      child.emit('close', b.code ?? 0, null)
    })
    return child
  }
}

/**
 * @param {{readdir?: (path: any, args: any[], original: Function) => any, readFile?: (path: any, args: any[], original: Function) => any}} mocks
 */
function mockProcFs(mocks) {
  const mutableFs = /** @type {any} */ (fs)
  const mutablePromises = /** @type {any} */ (fs.promises)
  const originalReaddir = mutablePromises.readdir
  const originalReadFile = mutableFs.readFileSync
  mutablePromises.readdir = (/** @type {any} */ path, /** @type {any[]} */ ...args) =>
    mocks.readdir ? mocks.readdir(path, args, originalReaddir) : originalReaddir(path, ...args)
  mutableFs.readFileSync = (/** @type {any} */ path, /** @type {any[]} */ ...args) =>
    mocks.readFile ? mocks.readFile(path, args, originalReadFile) : originalReadFile(path, ...args)
  syncBuiltinESMExports()
  return () => {
    mutablePromises.readdir = originalReaddir
    mutableFs.readFileSync = originalReadFile
    syncBuiltinESMExports()
  }
}

test('runTriggers：无命令时跳过且不产生警告', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const { warnings } = await runTriggers([], { task: 'T' }, { spawn: makeFakeSpawn(captured) })
  assert.equal(captured.length, 0)
  assert.deepEqual(warnings, [])
})

test('runTriggers：空触发列表返回后立即取消时确认没有进程需要清理', async () => {
  const controller = new AbortController()
  const resultPromise = runTriggers(undefined, {}, { signal: controller.signal })
  controller.abort()

  const result = await resultPromise
  assert.deepEqual(result.warnings, [])
  assert.equal(result.cleanupConfirmed, true)
})

test('runTriggers：非法命令配置类型产生警告', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const invalid = /** @type {any} */ ('invalid')
  const { warnings } = await runTriggers(invalid, {}, { spawn: makeFakeSpawn(captured) })
  assert.equal(captured.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /触发器|类型/)
})

test('runTriggers：非法命令条目产生警告且不阻止合法命令', async () => {
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const invalidEntries = /** @type {any} */ ([42, null, { command: 'not-a-string' }, 'valid-cmd'])
  const { warnings } = await runTriggers(invalidEntries, {}, { spawn: makeFakeSpawn(captured) })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].args.at(-1), 'valid-cmd')
  assert.equal(warnings.length, 3)
  assert.ok(warnings.every((warning) => /索引/.test(warning) && /字符串/.test(warning)))
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

test('runTriggers：关闭真实子进程 stdin 后等待其正常退出', async () => {
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = []
  const script = process.platform === 'win32'
    ? 'const fs = require("node:fs"); fs.readFileSync(0)'
    : 'const fs = require("node:fs"); fs.readFileSync(3); fs.readFileSync(0)'
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer

  try {
    const result = /** @type {Promise<{warnings: string[]}>} */ (Promise.race([
      runTriggers(['read-from-stdin'], {}, {
        spawn: (_shell, _args, opts) => {
          const child = spawn(process.execPath, ['--input-type=commonjs', '-e', script], opts)
          children.push(child)
          return child
        },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          for (const child of children) child.kill()
          reject(new Error('runTriggers 未在 stdin EOF 后完成'))
        }, 2000)
      }),
    ]))
    const { warnings } = await result

    assert.deepEqual(warnings, [])
    assert.equal(children.length, 1)
    assert.equal(children[0].exitCode, 0)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    for (const child of children) child.kill()
  }
})

test('runTriggers：未提供 AbortSignal 时跳过 Linux 全进程扫描', { skip: process.platform !== 'linux' }, async () => {
  let procScans = 0
  const restoreProcFs = mockProcFs({ readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
    if (String(path) === '/proc') procScans += 1
    return originalReaddir(path, ...args)
  } })

  try {
    const result = await runTriggers(['no-cancellation-needed'], {}, {
      platform: 'linux',
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = 2147483011
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        queueMicrotask(() => child.emit('close', 0, null))
        return child
      },
    })

    assert.deepEqual(result, { warnings: [] })
    assert.equal(procScans, 0, 'ordinary triggers without cancellation must not synchronously scan /proc')
  } finally {
    restoreProcFs()
  }
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
    assert.equal(args[0], '-c')
    assert.equal(args.at(-1), 'echo hi')
    assert.match(args[1], /read -r .*<&3/)
    assert.match(args[1], /exec 3<&-/)
    assert.deepEqual(/** @type {any} */ (captured[0].opts).stdio, ['pipe', 'pipe', 'pipe', 'pipe'])
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

test('runTriggers：等待 close 事件后再读取失败输出', async () => {
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let closeSeen = false

  const { warnings } = await runTriggers(['delayed-failure'], {}, {
    spawn: () => {
      queueMicrotask(() => {
        child.emit('exit', 2, null)
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('late boom'))
          closeSeen = true
          child.emit('close', 2, null)
        })
      })
      return child
    },
  })

  assert.equal(closeSeen, true)
  assert.match(warnings[0], /late boom/)
})

test('runTriggers：stderr 跨 chunk 的 UTF-8 字符保持完整', async () => {
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()

  const { warnings } = await runTriggers(['split-utf8-failure'], {}, {
    spawn: () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from([0xe4]))
        child.stderr.emit('data', Buffer.from([0xb8, 0xad]))
        child.emit('close', 1, null)
      })
      return child
    },
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /退出码 1: 中/)
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
      queueMicrotask(() => child2.emit('close', null, 'SIGKILL'))
      return child2
    },
  })
  assert.equal(w2.warnings.length, 1)
  assert.match(w2.warnings[0], /SIGKILL/)
})

test('runTriggers：取消会停止后续命令并明确返回取消状态', async () => {
  const controller = new AbortController()
  /** @type {string[]} */
  const commands = []
  const { warnings, cancelled } = await runTriggers(['cancel-me', 'must-not-run'], {}, {
    signal: controller.signal,
    spawn: (shell, args) => {
      commands.push(args.at(-1) ?? '')
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = (/** @type {NodeJS.Signals} */ signal) => {
        queueMicrotask(() => child.emit('close', null, signal))
        return true
      }
      const fallbackClose = setTimeout(() => child.emit('close', 1, null), 200)
      child.once('close', () => clearTimeout(fallbackClose))
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  assert.equal(cancelled, true)
  assert.deepEqual(commands, ['cancel-me'])
  assert.deepEqual(warnings, [])
})

test('runTriggers：取消时保留已收到的 stdout 和 stderr 诊断', async () => {
  const controller = new AbortController()
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end() {} }
  child.kill = (/** @type {NodeJS.Signals} */ signal) => {
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }
  const promise = runTriggers(['cancel-with-output'], {}, {
    signal: controller.signal,
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('partial stdout'))
        child.stderr.emit('data', Buffer.from('partial stderr'))
        controller.abort()
      })
      return child
    },
  })

  const result = await promise
  assert.equal(result.cancelled, true)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /cancel-with-output/)
  assert.match(result.warnings[0], /partial stdout/)
  assert.match(result.warnings[0], /partial stderr/)
})

test('runTriggers：spawn 同步失败时取消确认没有子进程需要清理', async () => {
  const controller = new AbortController()
  const result = await runTriggers(['spawn-throws'], {}, {
    signal: controller.signal,
    spawn: () => {
      controller.abort()
      throw new Error('spawn failed before creating a child')
    },
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, true)
  assert.match(result.warnings[0] ?? '', /spawn failed before creating a child/)
})

test('runTriggers：spawn 异步失败与取消竞态时确认没有子进程需要清理', async () => {
  const controller = new AbortController()
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end() {} }
  child.kill = () => {
    queueMicrotask(() => {
      const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      child.emit('error', error)
      child.emit('close', -2, null)
    })
    return true
  }
  const result = await runTriggers(['spawn-async-fails'], {}, {
    signal: controller.signal,
    spawn: () => {
      controller.abort()
      return child
    },
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, true)
  assert.match(result.warnings[0] ?? '', /spawn ENOENT/)
})

test('runTriggers：Windows spawn 异步失败与取消竞态时确认无需清理进程树', async () => {
  const controller = new AbortController()
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end() {} }
  child.kill = () => {
    queueMicrotask(() => {
      const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      child.emit('error', error)
      child.emit('close', -2, null)
    })
    return true
  }
  const result = await runTriggers(['spawn-async-fails'], {}, {
    platform: 'win32',
    signal: controller.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      controller.abort()
      return child
    },
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, true)
  assert.match(result.warnings[0] ?? '', /spawn ENOENT/)
  assert.equal(captured.some(({ cmd }) => cmd === 'taskkill.exe'), false, 'no PID exists for taskkill')
})

test('runTriggers：非 Linux POSIX 在 startup gate 关闭时通过 EOF 退出 wrapper', async () => {
  const controller = new AbortController()
  let gateClosed = false
  const child = /** @type {any} */ (new EventEmitter())
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end() {} }
  child.stdio = [undefined, undefined, undefined, {
    end() {
      gateClosed = true
      child.emit('close', 0, null)
    },
  }]
  child.kill = (/** @type {NodeJS.Signals} */ signal) => {
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }

  const result = await runTriggers(['must-not-start'], {}, {
    platform: 'darwin',
    signal: controller.signal,
    spawn: () => {
      controller.abort()
      return child
    },
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, true)
  assert.equal(gateClosed, true, 'EOF must let the wrapper exit without opening the trigger command')
})

test('runTriggers：Linux startup gate 关闭时通过 EOF 退出 wrapper 而不发未验证 PID 信号', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483048
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const numericSignals = []
  /** @type {NodeJS.Signals[]} */
  const childSignals = []
  let gateClosed = false
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) =>
      String(path) === '/proc' ? [String(pid)] : originalReaddir(path, ...args),
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    numericSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['must-not-start'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.stdio = [undefined, undefined, undefined, {
          end() {
            gateClosed = true
            child.exitCode = 0
            child.emit('exit', 0, null)
            child.emit('close', 0, null)
          },
        }]
        child.kill = (/** @type {NodeJS.Signals} */ signal) => {
          childSignals.push(signal)
          queueMicrotask(() => child.emit('close', null, signal))
          return true
        }
        controller.abort()
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, true, JSON.stringify(result))
    assert.equal(gateClosed, true, 'EOF must let the wrapper exit without opening the trigger command')
    assert.deepEqual(childSignals, [], 'an unverified ChildProcess PID must not be signalled')
    assert.deepEqual(numericSignals, [], 'no numeric PID or process-group signal is needed before command startup')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：真实 wrapper 收到 startup gate EOF 后不会执行触发命令', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-gate-eof-'))
  const sideEffectPath = join(tmp, 'started')
  const controller = new AbortController()
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran')`)}`

  try {
    const result = await Promise.race([
      runTriggers([command], {}, {
        signal: controller.signal,
        spawn: (shell, args, opts) => {
          child = spawn(shell, args, opts)
          controller.abort()
          return child
        },
      }),
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('pre-start wrapper did not close after startup gate EOF') }),
    ])

    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, true, JSON.stringify(result))
    await delay(50)
    assert.equal(existsSync(sideEffectPath), false, 'EOF must exit before the trigger command starts')
  } finally {
    controller.abort()
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* child may already have exited */ }
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：Windows shell 退出但后代保留输出管道时有界返回清理不确定', async () => {
  const controller = new AbortController()
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  let directKills = 0
  const resultPromise = runTriggers(['cancel-me'], {}, {
    platform: 'win32',
    signal: controller.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      child.pid = 42
      child.kill = () => {
        directKills += 1
        return true
      }
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  const start = Date.now()
  const result = await Promise.race([
    resultPromise,
    delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('Windows trigger cancellation did not settle promptly') }),
  ])
  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
  assert.match(result.cleanupError ?? '', /进程树|输出管道/i)
  assert.equal(directKills, 1, 'the shell should receive a best-effort signal through its ChildProcess handle')
  assert.equal(captured.some(({ cmd }) => cmd === 'taskkill.exe'), false, 'do not target an unverified numeric PID')
  assert.ok(Date.now() - start < MAX_CANCEL_SETTLE_MS)
})

test('runTriggers：Windows shell 终止失败时保留进程树清理不确定结果', async () => {
  const controller = new AbortController()
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  /** @type {any} */
  let triggerChild
  const resultPromise = runTriggers(['cancel-me'], {}, {
    platform: 'win32',
    signal: controller.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      triggerChild = child
      child.pid = 43
      child.exitCode = null
      child.signalCode = null
      child.kill = () => false
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  const result = await resultPromise
  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, false)
  assert.match(result.cleanupError ?? '', /kill returned false|进程树/i)
  assert.equal(captured.some(({ cmd }) => cmd === 'taskkill.exe'), false)
  assert.ok(triggerChild)
})

test('runTriggers：Windows 无法验证进程 PID 时只尽力终止 shell 并在有限时间内报告不确定', async () => {
  const controller = new AbortController()
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  let directKills = 0
  /** @type {any} */
  let triggerChild
  const resultPromise = runTriggers(['cancel-me'], {}, {
    platform: 'win32',
    signal: controller.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      if (cmd === 'taskkill.exe') {
        queueMicrotask(() => {
          triggerChild.emit('close', null, 'SIGTERM')
          child.emit('close', 0, null)
        })
        return child
      }
      triggerChild = child
      child.pid = 42
      child.kill = (/** @type {NodeJS.Signals} */ signal) => {
        directKills += 1
        queueMicrotask(() => child.emit('close', null, signal))
        return true
      }
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  const start = Date.now()
  const result = await Promise.race([
    resultPromise,
    delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('Windows trigger cancellation did not settle promptly') }),
  ])
  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
  assert.match(result.cleanupError ?? '', /进程树|descendant|process/i)
  assert.ok(directKills > 0, 'terminate the shell through the ChildProcess handle')
  assert.equal(captured.some(({ cmd }) => cmd === 'taskkill.exe'), false, 'do not target an unverified numeric PID')
  assert.ok(Date.now() - start < MAX_CANCEL_SETTLE_MS)
})

test('runTriggers：Windows shell 已退出后取消不对可能复用的 PID 执行 taskkill', async () => {
  const controller = new AbortController()
  /** @type {Array<{cmd: string, args: string[], opts: object}>} */
  const captured = []
  const resultPromise = runTriggers(['exit-before-close'], {}, {
    platform: 'win32',
    signal: controller.signal,
    spawn: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      const child = /** @type {any} */ (new EventEmitter())
      child.pid = 42
      child.exitCode = null
      child.signalCode = null
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      child.kill = () => true
      if (cmd === 'taskkill.exe') {
        queueMicrotask(() => child.emit('close', 0, null))
        return child
      }
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        controller.abort()
      })
      return child
    },
  })

  const result = await resultPromise
  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
  assert.match(result.cleanupError ?? '', /PID|进程树|pipe|管道/i)
  assert.equal(captured.some(({ cmd }) => cmd === 'taskkill.exe'), false, 'do not taskkill a numeric PID after the shell exit was observed')
})

test('runTriggers：无法枚举 escaped 后代的 POSIX 平台不确认进程组清理完成', async () => {
  const controller = new AbortController()
  const resultPromise = runTriggers(['cancel-me'], {}, {
    platform: 'darwin',
    signal: controller.signal,
    spawn: () => {
      const child = /** @type {any} */ (new EventEmitter())
      child.pid = 2147483000
      child.exitCode = null
      child.signalCode = null
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      child.kill = (/** @type {NodeJS.Signals} */ signal) => {
        queueMicrotask(() => child.emit('close', null, signal))
        return true
      }
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  const result = await resultPromise
  assert.equal(result.cancelled, true)
  assert.equal(result.cleanupConfirmed, false)
  assert.match(result.cleanupError ?? '', /无法检查 escaped 后代/)
})

test('runTriggers：非 Linux POSIX shell 退出后跳过无法验证的数字 PID 信号', async () => {
  const controller = new AbortController()
  const originalKill = process.kill
  /** @type {number[]} */
  const processSignals = []
  let childKillCount = 0
  process.kill = (/** @type {number} */ target) => {
    processSignals.push(target)
    return true
  }

  try {
    const result = await runTriggers(['exit-before-close'], {}, {
      platform: 'darwin',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = 2147483012
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => { childKillCount += 1; return true }
        queueMicrotask(() => {
          child.exitCode = 0
          child.emit('exit', 0, null)
          controller.abort()
        })
        return child
      },
    })

    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.ok(processSignals.length === 0, 'an unverified numeric process group must not be signalled after shell exit')
    assert.equal(childKillCount, 0, 'the stale ChildProcess PID must not be signalled after shell exit')
  } finally {
    controller.abort()
    process.kill = originalKill
  }
})

test('runTriggers：进程检查异常不会阻止尽力终止 shell 与进程组', async () => {
  const controller = new AbortController()
  const pid = 2147483002
  const unreadablePid = 2147483007
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const groupSignals = []
  let childKillCount = 0
  const rootFields = Array(20).fill('0')
  rootFields[0] = 'S'
  rootFields[1] = String(process.pid)
  rootFields[2] = String(pid)
  rootFields[19] = '100'
  const rootStat = `${pid} (trigger-shell) ${rootFields.join(' ')}`
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      // Keep the identity fixture independent of the host OS: Windows does not
      // have /proc, but this test supplies the identities needed to exercise it.
      return [String(process.pid), String(pid), String(unreadablePid)]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) return rootStat
      if (String(path) === `/proc/${unreadablePid}/stat`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    groupSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = (/** @type {NodeJS.Signals} */ signal) => {
          childKillCount += 1
          queueMicrotask(() => child.emit('close', null, signal))
          return true
        }
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.match(result.cleanupError ?? '', /无法完整检查/)
    assert.ok(groupSignals.some(({ pid: target, signal }) => target === -pid && signal === 'SIGTERM'))
    assert.ok(groupSignals.some(({ pid: target, signal }) => target === -pid && signal === 'SIGKILL'))
    assert.ok(childKillCount > 0, 'the direct shell should receive a best-effort signal')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：触发器 PID 重用且进程检查不完整时不向新进程组发送信号', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483004
  const unreadablePid = 2147483005
  const trackedPid = 2147483006
  const otherTrackedPid = 2147483010
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const processSignals = []
  let rootStatReads = 0
  let unreadableStatReads = 0
  let childKillCount = 0
  let rootReused = false
  /** @param {number} targetPid @param {number} startTime @param {number} [parentPid] @returns {string} */
  const makeStat = (targetPid, startTime, parentPid = 1) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(parentPid)
    fields[2] = String(targetPid)
    fields[3] = String(targetPid)
    fields[19] = String(startTime)
    return `${targetPid} (trigger-shell) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: async (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      const entries = /** @type {string[]} */ (await originalReaddir(path, ...args))
      return [...new Set([...entries, String(pid), String(unreadablePid), String(trackedPid), String(otherTrackedPid)])]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) {
        rootStatReads += 1
        return makeStat(pid, rootReused ? 200 : 100)
      }
      if (String(path) === `/proc/${unreadablePid}/stat`) {
        unreadableStatReads += 1
        if (unreadableStatReads >= 3) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return makeStat(unreadablePid, 300, pid)
      }
      if (String(path) === `/proc/${trackedPid}/stat`) return makeStat(trackedPid, 400, pid)
      if (String(path) === `/proc/${otherTrackedPid}/stat`) return makeStat(otherTrackedPid, 500, pid)
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    processSignals.push({ pid: target, signal })
    if (target === trackedPid && signal === 'SIGTERM') {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.stdio = [undefined, undefined, undefined, {
          end() {
            rootReused = true
            child.exitCode = 0
            child.emit('exit', 0, null)
            controller.abort()
          },
        }]
        child.kill = (/** @type {NodeJS.Signals} */ signal) => {
          childKillCount += 1
          queueMicrotask(() => child.emit('close', null, signal))
          return true
        }
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.match(result.cleanupError ?? '', /process group.*(reused|inspection incomplete)|child identity.*could not be verified/i)
    assert.equal(processSignals.some(({ pid: target }) => target === -pid), false, 'the reused process-group ID must not be signalled')
    assert.ok(processSignals.some(({ pid: target, signal }) => target === trackedPid && signal === 'SIGTERM'), 'other tracked descendants should receive SIGTERM')
    assert.ok(processSignals.some(({ pid: target, signal }) => target === trackedPid && signal === 'SIGKILL'), 'other tracked descendants should receive SIGKILL')
    assert.ok(processSignals.some(({ pid: target, signal }) => target === otherTrackedPid && signal === 'SIGTERM'), 'a signal error must not prevent later descendants from receiving SIGTERM')
    assert.ok(processSignals.some(({ pid: target, signal }) => target === otherTrackedPid && signal === 'SIGKILL'), 'later descendants should also receive SIGKILL')
    assert.equal(childKillCount, 0, 'the stale ChildProcess PID must not be signalled after PID reuse')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：初始 shell 身份读取失败后不把重用 PID 当作原进程组', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483049
  const mutableProcess = /** @type {any} */ (process)
  const originalKill = process.kill
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const numericSignals = []
  let rootReads = 0
  /** @param {number} startTime @returns {string} */
  const makeStat = (startTime) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(process.pid)
    fields[2] = String(pid)
    fields[3] = String(pid)
    fields[19] = String(startTime)
    return `${pid} (replacement-child) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) =>
      String(path) === '/proc' ? [String(pid)] : originalReaddir(path, ...args),
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) !== `/proc/${pid}/stat`) return originalReadFile(path, ...args)
      rootReads += 1
      if (rootReads === 1) throw Object.assign(new Error('transient proc read failure'), { code: 'EACCES' })
      return makeStat(200)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    numericSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['must-not-run'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.stdio = [undefined, undefined, undefined, {
          end() {
            child.exitCode = 0
            child.emit('exit', 0, null)
            controller.abort()
          },
        }]
        child.kill = () => {
          assert.fail('an already-exited ChildProcess must not be signalled')
        }
        return child
      },
    })

    assert.equal(rootReads >= 2, true, 'the later scan should observe the sibling process reusing the PID')
    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.equal(numericSignals.some(({ pid: target }) => target === -pid), false, 'the replacement process group must not be signalled')
    assert.deepEqual(numericSignals, [], 'the unopened startup gate has no descendants to signal by PID')
    assert.match(result.cleanupError ?? '', /process group root identity could not be verified/)
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：shell 退出后不把重用 PGID 的新进程组当作触发器后代', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483050
  const unrelatedMemberPid = 2147483051
  const mutableProcess = /** @type {any} */ (process)
  const originalKill = process.kill
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const numericSignals = []
  let originalRootExited = false
  let startupGateOpened = false
  /** @param {number} targetPid @param {number} ppid @param {number} pgrp @param {number} startTime @returns {string} */
  const makeStat = (targetPid, ppid, pgrp, startTime) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(ppid)
    fields[2] = String(pgrp)
    fields[3] = String(pgrp)
    fields[19] = String(startTime)
    return `${targetPid} (trigger-process) ${fields.join(' ')}`
  }
  const rootStat = makeStat(pid, process.pid, pid, 100)
  const unrelatedMemberStat = makeStat(unrelatedMemberPid, 1, pid, 200)
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      return originalRootExited ? [String(unrelatedMemberPid)] : [String(pid)]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) {
        if (originalRootExited) throw Object.assign(new Error('process exited'), { code: 'ENOENT' })
        return rootStat
      }
      if (String(path) === `/proc/${unrelatedMemberPid}/stat`) return unrelatedMemberStat
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    numericSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['cancel-after-shell-exit'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.stdio = [undefined, undefined, undefined, {
          end() {
            startupGateOpened = true
            originalRootExited = true
            child.exitCode = 0
            child.emit('exit', 0, null)
            controller.abort()
          },
        }]
        child.kill = () => {
          assert.fail('an exited trigger shell must not be signalled')
        }
        return child
      },
    })

    assert.equal(startupGateOpened, true)
    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.deepEqual(numericSignals, [], 'unrelated processes in a reused numeric process group must not be signalled')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：向一个后代发信号后会重新验证后续 PID 身份', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483020
  const firstDescendantPid = 2147483021
  const reusedDescendantPid = 2147483022
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {number[]} */
  const processSignals = []
  let reusedDescendant = false
  /** @param {number} targetPid @param {number} startTime @param {number} parentPid @returns {string} */
  const makeStat = (targetPid, startTime, parentPid) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(parentPid)
    fields[2] = String(targetPid)
    fields[3] = String(targetPid)
    fields[19] = String(startTime)
    return `${targetPid} (trigger-child) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: async (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      const entries = /** @type {string[]} */ (await originalReaddir(path, ...args))
      return [...new Set([...entries, String(pid), String(firstDescendantPid), String(reusedDescendantPid)])]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) return makeStat(pid, 100, 1)
      if (String(path) === `/proc/${firstDescendantPid}/stat`) return makeStat(firstDescendantPid, 200, pid)
      if (String(path) === `/proc/${reusedDescendantPid}/stat`) {
        return makeStat(reusedDescendantPid, reusedDescendant ? 400 : 300, pid)
      }
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    processSignals.push(target)
    if (target === firstDescendantPid && signal === 'SIGTERM') reusedDescendant = true
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => true
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.equal(reusedDescendant, true)
    assert.equal(processSignals.includes(reusedDescendantPid), false, 'a later reused PID must be skipped after revalidation')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：已验证的进程组后代调用 setsid 后仍按 PID 终止', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483044
  const descendantPid = 2147483045
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const processSignals = []
  let descendantGroup = pid
  /** @param {number} targetPid @param {number} startTime @param {number} parentPid @param {number} groupId @returns {string} */
  const makeStat = (targetPid, startTime, parentPid, groupId) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(parentPid)
    fields[2] = String(groupId)
    fields[3] = String(groupId)
    fields[19] = String(startTime)
    return `${targetPid} (trigger-child) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: async (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      const entries = /** @type {string[]} */ (await originalReaddir(path, ...args))
      return [...new Set([...entries, String(pid), String(descendantPid)])]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) return makeStat(pid, 100, process.pid, pid)
      if (String(path) === `/proc/${descendantPid}/stat`) return makeStat(descendantPid, 200, pid, descendantGroup)
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    processSignals.push({ pid: target, signal })
    if (target === -pid && signal === 'SIGTERM') descendantGroup = descendantPid
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => true
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.ok(processSignals.some(({ pid: target, signal }) => target === descendantPid && signal === 'SIGTERM'))
    assert.ok(processSignals.some(({ pid: target, signal }) => target === descendantPid && signal === 'SIGKILL'))
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：无法验证触发器 PID 时不向未知进程组发送信号', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483008
  const groupMemberPid = 2147483009
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {number[]} */
  const processSignals = []
  let childKillCount = 0
  const restoreProcFs = mockProcFs({
    readdir: async (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      const entries = /** @type {string[]} */ (await originalReaddir(path, ...args))
      return [...new Set([...entries, String(pid), String(groupMemberPid)])]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      if (String(path) === `/proc/${groupMemberPid}/stat`) {
        const fields = Array(20).fill('0')
        fields[0] = 'S'
        fields[1] = '1'
        fields[2] = String(pid)
        fields[19] = '500'
        return `${groupMemberPid} (unrelated-group-member) ${fields.join(' ')}`
      }
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target) => {
    processSignals.push(target)
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => {
          childKillCount += 1
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
          return true
        }
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.match(result.cleanupError ?? '', /root identity.*verified|process group inspection/i)
    assert.equal(processSignals.includes(-pid), false, 'an unverified process-group ID must not be signalled')
    assert.equal(processSignals.includes(groupMemberPid), false, 'unverified group membership must not be signalled as a tracked descendant')
    assert.equal(childKillCount, 0, 'an unverified child PID must not be signalled through the stale ChildProcess handle')
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：首次 shell 身份读取失败后跳过无法验证的数字信号', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483032
  const descendantPid = 2147483033
  const originalKill = process.kill
  const mutableProcess = /** @type {any} */ (process)
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const processSignals = []
  let rootStatReads = 0
  let childKillCount = 0
  /** @param {number} targetPid @param {number} startTime @param {number} parentPid @param {number} groupId @returns {string} */
  const makeStat = (targetPid, startTime, parentPid, groupId) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(parentPid)
    fields[2] = String(groupId)
    fields[3] = String(groupId)
    fields[19] = String(startTime)
    return `${targetPid} (trigger-process) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: async (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) => {
      if (String(path) !== '/proc') return originalReaddir(path, ...args)
      const entries = /** @type {string[]} */ (await originalReaddir(path, ...args))
      return [...new Set([...entries, String(pid), String(descendantPid)])]
    },
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) === `/proc/${pid}/stat`) {
        rootStatReads += 1
        if (rootStatReads === 1) throw Object.assign(new Error('transient permission failure'), { code: 'EACCES' })
        return makeStat(pid, 100, process.pid, pid)
      }
      if (String(path) === `/proc/${descendantPid}/stat`) return makeStat(descendantPid, 200, pid, pid)
      return originalReadFile(path, ...args)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    processSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => {
          childKillCount += 1
          return true
        }
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.ok(rootStatReads > 0)
    assert.deepEqual(processSignals, [], 'a PID that could not be anchored on the initial read must not be signalled later')
    assert.equal(childKillCount, 0, 'the ChildProcess handle is not a pinned PID identity')
    assert.match(result.cleanupError ?? '', /identity could not be verified|无法完整检查/i)
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：初次身份读取失败后不通过 ChildProcess PID 信号重用的同 PID 子进程', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const pid = 2147483052
  const mutableProcess = /** @type {any} */ (process)
  const originalKill = process.kill
  /** @type {Array<{pid: number, signal: NodeJS.Signals}>} */
  const numericSignals = []
  /** @type {NodeJS.Signals[]} */
  const childSignals = []
  let rootReads = 0
  let pidReused = false
  /** @param {number} startTime @returns {string} */
  const makeStat = (startTime) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(process.pid)
    fields[2] = String(pid)
    fields[3] = String(pid)
    fields[19] = String(startTime)
    return `${pid} (replacement-node-child) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) =>
      String(path) === '/proc' ? [String(pid)] : originalReaddir(path, ...args),
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      if (String(path) !== `/proc/${pid}/stat`) return originalReadFile(path, ...args)
      rootReads += 1
      if (!pidReused && rootReads === 1) {
        throw Object.assign(new Error('transient proc read failure'), { code: 'EACCES' })
      }
      return makeStat(200)
    },
  })
  mutableProcess.kill = (/** @type {number} */ target, /** @type {NodeJS.Signals} */ signal) => {
    numericSignals.push({ pid: target, signal })
    return true
  }

  try {
    const result = await runTriggers(['must-not-kill-reused-pid'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = pid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.stdio = [undefined, undefined, undefined, {
          end() {
            pidReused = true
            controller.abort()
          },
        }]
        child.kill = (/** @type {NodeJS.Signals} */ signal) => {
          childSignals.push(signal)
          queueMicrotask(() => child.emit('close', null, signal))
          return true
        }
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false)
    assert.equal(pidReused, true, 'the startup gate presents a replacement process at the former shell PID')
    assert.deepEqual(numericSignals, [], 'an unanchored numeric process group must not be signalled')
    assert.deepEqual(childSignals, [], 'the ChildProcess handle must not signal an unanchored PID')
    assert.match(result.cleanupError ?? '', /identity could not be verified|cannot be confirmed|无法确认|无法完整检查/i)
  } finally {
    controller.abort()
    restoreProcFs()
    mutableProcess.kill = originalKill
  }
})

test('runTriggers：/proc 进程扫描不会阻塞取消期限', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const originalReaddirSync = fs.readdirSync
  const mutableFs = /** @type {any} */ (fs)
  const rootPid = 2147483034
  const fakePids = Array.from({ length: 1200 }, (_, index) => String(2000000 + index))
  const procEntries = [...fakePids, String(rootPid)]
  /** @param {number} pid @returns {string} */
  const makeStat = (pid) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(pid === rootPid ? process.pid : 1)
    fields[2] = String(pid)
    fields[3] = String(pid)
    fields[19] = String(pid)
    return `${pid} (process-scan-test) ${fields.join(' ')}`
  }
  mutableFs.readdirSync = (/** @type {any} */ path, /** @type {any[]} */ ...args) =>
    String(path) === '/proc' ? procEntries : originalReaddirSync(path, ...args)
  syncBuiltinESMExports()
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) =>
      String(path) === '/proc' ? procEntries : originalReaddir(path, ...args),
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      const match = /^\/proc\/(\d+)\/stat$/.exec(String(path))
      if (match) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
        return makeStat(Number(match[1]))
      }
      return originalReadFile(path, ...args)
    },
  })

  const startedAt = Date.now()
  try {
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = rootPid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = () => true
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.ok(Date.now() - startedAt < 1000, 'cancellation must resolve before the full process scan completes')
    assert.equal(result.cleanupConfirmed, false)
    assert.match(result.cleanupError ?? '', /清理超时/)
  } finally {
    mutableFs.readdirSync = originalReaddirSync
    syncBuiltinESMExports()
    restoreProcFs()
  }
})

test('runTriggers：慢速 /proc 扫描时跳过未验证 PID 且取消仍有界返回', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController()
  const rootPid = 2147483040
  const fakePids = Array.from({ length: 1200 }, (_, index) => String(2000000 + index))
  const procEntries = [...fakePids, String(rootPid)]
  const childSignals = /** @type {NodeJS.Signals[]} */ ([])
  /** @param {number} pid @returns {string} */
  const makeStat = (pid) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = String(pid === rootPid ? process.pid : 1)
    fields[2] = String(pid)
    fields[3] = String(pid)
    fields[19] = String(pid)
    return `${pid} (process-scan-test) ${fields.join(' ')}`
  }
  const restoreProcFs = mockProcFs({
    readdir: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReaddir) =>
      String(path) === '/proc' ? procEntries : originalReaddir(path, ...args),
    readFile: (/** @type {any} */ path, /** @type {any[]} */ args, /** @type {Function} */ originalReadFile) => {
      const match = /^\/proc\/(\d+)\/stat$/.exec(String(path))
      if (match) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
        return makeStat(Number(match[1]))
      }
      return originalReadFile(path, ...args)
    },
  })

  try {
    const startedAt = Date.now()
    const result = await runTriggers(['cancel-me'], {}, {
      platform: 'linux',
      signal: controller.signal,
      spawn: () => {
        const child = /** @type {any} */ (new EventEmitter())
        child.pid = rootPid
        child.exitCode = null
        child.signalCode = null
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdin = { end() {} }
        child.kill = (/** @type {NodeJS.Signals} */ signal) => {
          childSignals.push(signal)
          return true
        }
        queueMicrotask(() => controller.abort())
        return child
      },
    })

    assert.equal(result.cancelled, true)
    assert.ok(Date.now() - startedAt < 1000, 'cancellation must remain bounded by the cleanup deadline')
    assert.equal(result.cleanupConfirmed, false)
    assert.match(result.cleanupError ?? '', /清理超时/)
    assert.deepEqual(childSignals, [], 'the unanchored ChildProcess PID must not be signalled')
  } finally {
    controller.abort()
    restoreProcFs()
  }
})

test('runTriggers：shell 退出后取消仍清理 setsid 后代并在有限时间内结束', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-abort-'))
  const pidPath = join(tmp, 'descendant.pid')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  let shellExited = false
  let shellClosed = false
  let closeSeenBeforeAbort = false
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1000)`
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'inherit' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 200)',
  ].join(';')
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      shellChild.once('close', () => { shellClosed = true })
      shellChild.once('exit', () => {
        shellExited = true
        closeSeenBeforeAbort = shellClosed
        controller.abort()
      })
      return shellChild
    },
  })

  try {
    const start = Date.now()
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    const elapsed = Date.now() - start

    assert.equal(shellExited, true)
    assert.equal(closeSeenBeforeAbort, false, 'the shell must still have an inherited pipe open when cancellation arrives')
    assert.ok(existsSync(pidPath), 'the escaped descendant should have started before the shell exited')
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /无法排除未跟踪的 escaped 后代/)
    assert.ok(elapsed < MAX_CANCEL_SETTLE_MS, `cancellation took ${elapsed}ms`)
    await delay(1100)
    assert.equal(existsSync(sideEffectPath), false, `the escaped descendant must not run its delayed side effect: ${JSON.stringify(result)}`)
  } finally {
    controller.abort()
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may not have started */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：较早触发器的后台后代使后续命令取消结果保持不确定', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-prior-descendant-'))
  const pidPath = join(tmp, 'descendant.pid')
  const controller = new AbortController()
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let firstShell
  let spawnCount = 0
  const descendantScript = 'setTimeout(() => {}, 5000)'
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 150)',
  ].join(';')
  const resultPromise = runTriggers([
    `${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`,
    'cancel-during-second-trigger',
  ], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      spawnCount += 1
      if (spawnCount === 1) {
        firstShell = spawn(shell, args, opts)
        return firstShell
      }
      const child = /** @type {any} */ (new EventEmitter())
      child.pid = 2147483003
      child.exitCode = null
      child.signalCode = null
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end() {} }
      child.kill = (/** @type {NodeJS.Signals} */ signal) => {
        queueMicrotask(() => child.emit('close', null, signal))
        return true
      }
      queueMicrotask(() => controller.abort())
      return child
    },
  })

  try {
    const result = await resultPromise
    assert.equal(spawnCount, 2)
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /此前完成的触发器命令可能仍有 escaped 后代/)
    assert.ok(existsSync(pidPath), 'the earlier command should have left an escaped process')
  } finally {
    controller.abort()
    if (firstShell?.pid) {
      try { process.kill(-firstShell.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { firstShell.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may not have started */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：shell 退出后未捕获的同组后代使清理保持不确定', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-group-abort-'))
  const pidPath = join(tmp, 'descendant.pid')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1000)`
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'inherit' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 200)',
  ].join(';')
  globalThis.setInterval = /** @type {typeof setInterval} */ (/**
   * @param {(...args: any[]) => void} _callback
   * @param {number | undefined} _ms
   * @param {...any} _args
   */ function (_callback, _ms, ..._args) {
    const timer = originalSetInterval(() => {}, 60_000)
    timer.unref?.()
    return timer
  })
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      shellChild.once('exit', () => controller.abort())
      return shellChild
    },
  })

  try {
    const start = Date.now()
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true)
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /process group root identity could not be verified|无法排除未跟踪的 escaped 后代/)
    assert.ok(existsSync(pidPath), 'the same-group descendant should start before the shell exits')
    assert.ok(Date.now() - start < MAX_CANCEL_SETTLE_MS)
    const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
    const stat = readFileSync(`/proc/${Number(pidText)}/stat`, 'utf8')
    const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    assert.equal(actualStartTime, expectedStartTime, 'an untracked same-group child remains alive only with explicit uncertainty')
    assert.equal(existsSync(sideEffectPath), false, 'the fixture should be cleaned before the delayed side effect')
  } finally {
    globalThis.setInterval = originalSetInterval
    controller.abort()
    if (shellChild && shellChild.exitCode === null && shellChild.signalCode === null) {
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may not have started */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：首次进程扫描前 shell 已退出时不信任未锚定的进程组', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-missed-root-'))
  const groupInfoPath = join(tmp, 'group-info')
  const descendantInfoPath = join(tmp, 'descendant-info')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let supervisor
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1000)`
  const rootScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(descendantInfoPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
  ].join(';')
  const supervisorScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const root = spawn(process.execPath, ['-e', ${JSON.stringify(rootScript)}], { detached: true, stdio: 'ignore' })`,
    `root.once('exit', () => { const [childPid, startTime] = fs.readFileSync(${JSON.stringify(descendantInfoPath)}, 'utf8').trim().split(/\\s+/); fs.writeFileSync(${JSON.stringify(groupInfoPath)}, root.pid + ' ' + childPid + ' ' + startTime); setTimeout(() => {}, 5000) })`,
  ].join(';')
  const triggerPromise = runTriggers(['cancel-me'], {}, {
    signal: controller.signal,
    spawn: () => {
      supervisor = spawn(process.execPath, ['-e', supervisorScript], { stdio: 'ignore' })
      const deadline = Date.now() + 3000
      const blocker = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(groupInfoPath) && Date.now() < deadline) Atomics.wait(blocker, 0, 0, 5)
      if (!existsSync(groupInfoPath)) throw new Error('detached process group did not start')
      const [rootPidText] = readFileSync(groupInfoPath, 'utf8').trim().split(/\s+/)
      const facade = {
        pid: Number(rootPidText),
        get exitCode() { return supervisor?.exitCode },
        get signalCode() { return supervisor?.signalCode },
        kill: supervisor.kill.bind(supervisor),
        on: supervisor.on.bind(supervisor),
        once: supervisor.once.bind(supervisor),
      }
      controller.abort()
      return facade
    },
  })

  try {
    const start = Date.now()
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /process group root identity could not be verified|无法排除未跟踪的 escaped 后代/)
    assert.ok(Date.now() - start < MAX_CANCEL_SETTLE_MS)
    const [pidText, expectedStartTime] = readFileSync(descendantInfoPath, 'utf8').trim().split(/\s+/)
    const stat = readFileSync(`/proc/${Number(pidText)}/stat`, 'utf8')
    const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    assert.equal(actualStartTime, expectedStartTime, 'an unanchored same-group child remains alive only with explicit uncertainty')
    assert.equal(existsSync(sideEffectPath), false, 'the fixture should be cleaned before the delayed side effect')
  } finally {
    controller.abort()
    if (supervisor) {
      try { supervisor.kill('SIGKILL') } catch { /* supervisor may already be gone */ }
    }
    let descendantPid = Number.NaN
    let expectedStartTime
    try {
      const [pidText, startTime] = readFileSync(descendantInfoPath, 'utf8').trim().split(/\s+/)
      descendantPid = Number(pidText)
      expectedStartTime = startTime
    } catch {
      try {
        const [, pidText, startTime] = readFileSync(groupInfoPath, 'utf8').trim().split(/\s+/)
        descendantPid = Number(pidText)
        expectedStartTime = startTime
      } catch { /* descendant may not have started */ }
    }
    if (Number.isInteger(descendantPid) && descendantPid > 0 && expectedStartTime) {
      try {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      } catch { /* descendant may already be gone */ }
    }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：首次后代轮询前逃逸的 setsid 后代使清理结果不确定', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-first-scan-escaped-'))
  const escapedInfoPath = join(tmp, 'escaped-info')
  const rootReadyPath = join(tmp, 'root-ready')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  const escapedScriptPath = join(tmp, 'escaped.js')
  const intermediaryScriptPath = join(tmp, 'intermediary.js')
  const launcherScriptPath = join(tmp, 'launcher.js')
  fs.writeFileSync(escapedScriptPath, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1200)`)
  fs.writeFileSync(intermediaryScriptPath, [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, [${JSON.stringify(escapedScriptPath)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(escapedInfoPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
  ].join(';'))
  fs.writeFileSync(launcherScriptPath, [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const intermediary = spawn(process.execPath, [${JSON.stringify(intermediaryScriptPath)}], { detached: true, stdio: 'ignore' })`,
    `intermediary.once('exit', () => { fs.writeFileSync(${JSON.stringify(rootReadyPath)}, 'ready'); setTimeout(() => {}, 5000) })`,
  ].join(';'))
  globalThis.setInterval = /** @type {typeof setInterval} */ (/**
   * @param {(...args: any[]) => void} _callback
   * @param {number | undefined} _ms
   * @param {...any} _args
   */ function (_callback, _ms, ..._args) {
    const timer = originalSetInterval(() => {}, 60_000)
    timer.unref?.()
    return timer
  })
  const abortWatcher = originalSetInterval(() => {
    if (existsSync(rootReadyPath)) controller.abort()
  }, 2)
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} ${shellQuote(launcherScriptPath)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      return shellChild
    },
  })

  try {
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /首次.*扫描|escaped 后代/)
    const [pidText, expectedStartTime] = readFileSync(escapedInfoPath, 'utf8').trim().split(/\s+/)
    const escapedPid = Number(pidText)
    const stat = readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
    const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    assert.equal(actualStartTime, expectedStartTime, 'the escaped descendant should remain alive but untracked')
    assert.equal(existsSync(sideEffectPath), false, 'the fixture cleanup must happen before the delayed side effect')
  } finally {
    globalThis.setInterval = originalSetInterval
    clearInterval(abortWatcher)
    controller.abort()
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(escapedInfoPath, 'utf8').trim().split(/\s+/)
      const escapedPid = Number(pidText)
      if (Number.isInteger(escapedPid) && escapedPid > 0) {
        const stat = readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(escapedPid, 'SIGKILL')
      }
    } catch { /* escaped descendant may already be gone */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：两次后代轮询之间逃逸的 setsid 后代使清理结果不确定', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-between-scans-'))
  const escapedInfoPath = join(tmp, 'escaped-info')
  const rootReadyPath = join(tmp, 'root-ready')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  let trackerPolls = 0
  const escapedScriptPath = join(tmp, 'escaped.js')
  const intermediaryScriptPath = join(tmp, 'intermediary.js')
  const launcherScriptPath = join(tmp, 'launcher.js')
  fs.writeFileSync(escapedScriptPath, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1200)`)
  fs.writeFileSync(intermediaryScriptPath, [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, [${JSON.stringify(escapedScriptPath)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(escapedInfoPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
  ].join(';'))
  fs.writeFileSync(launcherScriptPath, [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    'setTimeout(() => {',
    `const intermediary = spawn(process.execPath, [${JSON.stringify(intermediaryScriptPath)}], { detached: true, stdio: 'ignore' })`,
    `intermediary.once('exit', () => { fs.writeFileSync(${JSON.stringify(rootReadyPath)}, 'ready'); setTimeout(() => {}, 5000) })`,
    '}, 100)',
  ].join(';'))
  globalThis.setInterval = /** @type {typeof setInterval} */ (/**
   * @param {(...args: any[]) => void} callback
   * @param {number | undefined} ms
   * @param {...any} args
   */ function (callback, ms, ...args) {
    if (ms === 10 && trackerPolls === 0) {
      trackerPolls += 1
      const timer = originalSetInterval(() => {
        clearInterval(timer)
        callback(...args)
      }, ms)
      return timer
    }
    const timer = originalSetInterval(() => {}, 60_000)
    timer.unref?.()
    return timer
  })
  const abortWatcher = originalSetInterval(() => {
    if (existsSync(rootReadyPath)) controller.abort()
  }, 2)
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} ${shellQuote(launcherScriptPath)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      return shellChild
    },
  })

  try {
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(trackerPolls, 1, 'one descendant scan must precede the escaped child')
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /命令已启动|escaped 后代/)
    const [pidText, expectedStartTime] = readFileSync(escapedInfoPath, 'utf8').trim().split(/\s+/)
    const escapedPid = Number(pidText)
    const stat = readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    assert.equal(fields[19], expectedStartTime, 'the escaped descendant should remain alive but untracked')
    assert.ok(!['Z', 'X'].includes(fields[0]), 'the escaped descendant must still be running after cancellation')
    assert.equal(existsSync(sideEffectPath), false, 'the delayed side effect should not happen before fixture cleanup')
  } finally {
    globalThis.setInterval = originalSetInterval
    clearInterval(abortWatcher)
    controller.abort()
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(escapedInfoPath, 'utf8').trim().split(/\s+/)
      const escapedPid = Number(pidText)
      if (Number.isInteger(escapedPid) && escapedPid > 0) {
        const stat = readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
        if (fields[19] === expectedStartTime) process.kill(escapedPid, 'SIGKILL')
      }
    } catch { /* escaped descendant may already be gone */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：OS shell 已退出但 Node 尚未观察到 exit 时不能确认 escaped 后代已清理', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-undelivered-exit-'))
  const pidPath = join(tmp, 'descendant.pid')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let abortWatcher
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1000)`
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 150)',
  ].join(';')
  globalThis.setInterval = /** @type {typeof setInterval} */ (/**
   * @param {(...args: any[]) => void} _callback
   * @param {number | undefined} _ms
   * @param {...any} _args
   */ function (_callback, _ms, ..._args) {
    const timer = originalSetInterval(() => {}, 60_000)
    timer.unref?.()
    return timer
  })
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      return shellChild
    },
  })
  abortWatcher = originalSetInterval(() => {
    if (!existsSync(pidPath) || !shellChild?.pid) return
    const blocker = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 1500
    let rootState = ''
    while (Date.now() < deadline) {
      try {
        const stat = readFileSync(`/proc/${shellChild.pid}/stat`, 'utf8')
        rootState = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0]
      } catch { /* retain the prior process state */ }
      if (rootState === 'Z') break
      Atomics.wait(blocker, 0, 0, 2)
    }
    if (rootState === 'Z') {
      clearInterval(abortWatcher)
      controller.abort()
    }
  }, 2)

  try {
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /shell 在取消前已退出|escaped 后代/)
    const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
    const descendantPid = Number(pidText)
    const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
    const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    assert.equal(actualStartTime, expectedStartTime, 'the escaped descendant should remain visible only to the test fixture')
    assert.equal(existsSync(sideEffectPath), false, 'the delayed side effect should not happen before fixture cleanup')
  } finally {
    globalThis.setInterval = originalSetInterval
    if (abortWatcher !== undefined) clearInterval(abortWatcher)
    controller.abort()
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may already be gone */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：shell close 后才取消且有未被轮询到的 setsid 后代时返回清理不确定', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-unseen-escaped-'))
  const pidPath = join(tmp, 'descendant.pid')
  const controller = new AbortController()
  const originalSetInterval = globalThis.setInterval
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  const descendantScript = "setTimeout(() => {}, 5000)"
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 150)',
  ].join(';')
  globalThis.setInterval = /** @type {typeof setInterval} */ (/**
   * @param {(...args: any[]) => void} _callback
   * @param {number | undefined} _ms
   * @param {...any} _args
   */ function (_callback, _ms, ..._args) {
    const timer = originalSetInterval(() => {}, 60_000)
    timer.unref?.()
    return timer
  })
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      shellChild.once('close', () => queueMicrotask(() => controller.abort()))
      return shellChild
    },
  })

  try {
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /无法排除未跟踪的 escaped 后代/)
    const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
    const descendantPid = Number(pidText)
    const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
    const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    assert.equal(actualStartTime, expectedStartTime, 'the escaped process remains identifiable only to the test fixture')
  } finally {
    globalThis.setInterval = originalSetInterval
    controller.abort()
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may not have started */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runTriggers：已清理后代但尚未观察到 close 时不能确认清理完成', { skip: process.platform !== 'linux' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtm-trigger-close-confirm-'))
  const pidPath = join(tmp, 'descendant.pid')
  const sideEffectPath = join(tmp, 'side-effect')
  const controller = new AbortController()
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let shellChild
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let delayedCloseTimer
  const descendantScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran'), 1000)`
  const launcherScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' })`,
    `const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8')`,
    "const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, child.pid + ' ' + startTime)`,
    'child.unref()',
    'setTimeout(() => {}, 200)',
  ].join(';')
  const triggerPromise = runTriggers([`${shellQuote(process.execPath)} -e ${shellQuote(launcherScript)}`], {}, {
    signal: controller.signal,
    spawn: (shell, args, opts) => {
      shellChild = spawn(shell, args, opts)
      const originalEmit = shellChild.emit.bind(shellChild)
      const childForTest = /** @type {any} */ (shellChild)
      childForTest.emit = /** @type {(event: string, ...eventArgs: any[]) => boolean} */ (
        (event, ...eventArgs) => {
          if (event === 'close') {
            // Keep the event undispatched past the bounded cancellation window even
            // when synchronous /proc scans are slow on a busy runner.
            delayedCloseTimer = setTimeout(() => originalEmit(event, ...eventArgs), 3000)
            delayedCloseTimer.unref?.()
            return true
          }
          return originalEmit(event, ...eventArgs)
        }
      )
      shellChild.once('exit', () => controller.abort())
      return shellChild
    },
  })

  try {
    const result = await Promise.race([
      triggerPromise,
      delay(MAX_CANCEL_SETTLE_MS).then(() => { throw new Error('trigger cancellation did not settle promptly') }),
    ])
    assert.equal(result.cancelled, true, JSON.stringify(result))
    assert.equal(result.cleanupConfirmed, false, JSON.stringify(result))
    assert.match(result.cleanupError ?? '', /输出管道仍未关闭|清理超时/)
    await delay(1100)
    assert.equal(existsSync(sideEffectPath), false, 'the cleaned descendant must not run its delayed side effect')
  } finally {
    controller.abort()
    if (delayedCloseTimer !== undefined) clearTimeout(delayedCloseTimer)
    if (shellChild?.pid) {
      try { process.kill(-shellChild.pid, 'SIGKILL') } catch { /* shell group may already be gone */ }
      try { shellChild.kill('SIGKILL') } catch { /* shell may already be gone */ }
    }
    try {
      const [pidText, expectedStartTime] = readFileSync(pidPath, 'utf8').trim().split(/\s+/)
      const descendantPid = Number(pidText)
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        const stat = readFileSync(`/proc/${descendantPid}/stat`, 'utf8')
        const actualStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
        if (actualStartTime === expectedStartTime) process.kill(descendantPid, 'SIGKILL')
      }
    } catch { /* descendant may not have started */ }
    await delay(20)
    rmSync(tmp, { recursive: true, force: true })
  }
})
