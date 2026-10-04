import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { parseWorktreeList, parseAheadBehind, isDirty, samePath, resolveToplevel, runGit, GitRunner } from '../src/git.js'

test('samePath：Windows 风格分隔符差异不影响匹配', { skip: process.platform !== 'win32' }, () => {
  assert.equal(samePath('C:/wtm/vault/t1', 'C:\\wtm\\vault\\t1'), true)
  assert.equal(samePath('C:/a', 'C:/b'), false)
})

test('samePath：Windows 扩展长度路径前缀与普通路径等价', () => {
  assert.equal(samePath('C:/Repo', '\\\\?\\c:\\repo', 'win32'), true)
})

test('samePath：POSIX 下保留路径分隔符语义', { skip: process.platform === 'win32' }, () => {
  assert.equal(samePath('/wtm/vault/t1', '/wtm/vault/t1'), true)
  assert.equal(samePath('/wtm/vault/t1', '\\wtm\\vault\\t1'), false)
})

test('samePath：Windows 下忽略大小写', { skip: process.platform !== 'win32' }, () => {
  assert.equal(samePath('C:/wtm/vault/T1', 'c:\\wtm\\vault\\t1'), true)
})

test('samePath：Windows 下规范化真实路径别名和扩展长度路径', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-same-path-'))
  try {
    const real = realpathSync.native(dir)
    assert.equal(samePath(dir, real), true)
    assert.equal(samePath(real, toNamespacedPath(real)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('samePath：Windows 下解析未创建子路径的目录别名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-same-path-alias-'))
  const target = join(dir, 'target')
  const alias = join(dir, 'alias')
  mkdirSync(target)
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    assert.equal(samePath(join(alias, 'vault'), join(target, 'vault'), 'win32'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveToplevel：保留仓库路径末尾的空格', async () => {
  const git = {
    run: async () => ({ ok: true, code: 0, stdout: '/tmp/repo \n', stderr: '', aborted: false }),
  }
  const result = await resolveToplevel(git, '/tmp/repo ')
  assert.deepEqual(result, { ok: true, root: '/tmp/repo ' })
})

test('resolveToplevel：保留仓库路径末尾的回车符', async () => {
  const git = {
    run: async () => ({ ok: true, code: 0, stdout: '/tmp/repo\r\n', stderr: '', aborted: false }),
  }
  const result = await resolveToplevel(git, '/tmp/repo\r')
  assert.deepEqual(result, { ok: true, root: '/tmp/repo\r' })
})

test('parseWorktreeList：解析 porcelain 输出（含空格路径与锁定标记）', () => {
  const text = [
    'worktree C:/my repo/main',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree D:/wtm-vaults/task-one',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/wtm/task-one',
    'locked some reason',
    '',
  ].join('\n')
  const list = parseWorktreeList(text)
  assert.equal(list.length, 2)
  assert.equal(list[0].path, 'C:/my repo/main')
  assert.equal(list[0].branch, 'main')
  assert.equal(list[0].locked, false)
  assert.equal(list[1].path, 'D:/wtm-vaults/task-one')
  assert.equal(list[1].branch, 'wtm/task-one')
  assert.equal(list[1].locked, true)
})

test('parseWorktreeList：detached 与 bare 工作区', () => {
  const text = [
    'worktree /a',
    'HEAD 1111111111111111111111111111111111111111',
    'detached',
    '',
    'worktree /b',
    'HEAD 2222222222222222222222222222222222222222',
    'bare',
    '',
  ].join('\n')
  const list = parseWorktreeList(text)
  assert.equal(list[0].branch, null)
  assert.equal(list[0].detached, true)
  assert.equal(list[1].bare, true)
})

test('parseWorktreeList：无 HEAD 的 bare 记录后仍能解析普通工作区', () => {
  const text = [
    'worktree /bare.git',
    'bare',
    '',
    'worktree /linked',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/linked',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/bare.git',
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }, {
    path: '/linked',
    branch: 'linked',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：EOF bare 记录的 CRLF 路径分隔符不进入路径', () => {
  assert.deepEqual(parseWorktreeList('worktree /bare.git\r\nbare'), [{
    path: '/bare.git',
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }])
})

test('parseWorktreeList：LF 输出中的 EOF bare 路径末尾回车符仍是路径数据', () => {
  const text = [
    'worktree /normal',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/normal',
    '',
    'worktree /bare\r',
    'bare',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/normal',
    branch: 'normal',
    detached: false,
    bare: false,
    locked: false,
  }, {
    path: '/bare\r',
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }])
})

test('parseWorktreeList：CRLF bare 记录不保留分隔符回车符', () => {
  const text = [
    'worktree /bare.git\r',
    'bare\r',
    '\r',
    'worktree /linked\r',
    'HEAD 2222222222222222222222222222222222222222\r',
    'branch refs/heads/linked\r',
    '\r',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/bare.git',
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }, {
    path: '/linked',
    branch: 'linked',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：bare 路径中的 HEAD 字段不提前截断', () => {
  const text = [
    'worktree /bare',
    'HEAD 4444444444444444444444444444444444444444',
    'bare',
    '',
    'worktree /linked',
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/linked',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/bare\nHEAD 4444444444444444444444444444444444444444',
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }, {
    path: '/linked',
    branch: 'linked',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：普通路径中的 bare 字段不提前截断', () => {
  const text = [
    'worktree /normal',
    'bare',
    'HEAD 6666666666666666666666666666666666666666',
    'branch refs/heads/normal',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/normal\nbare',
    branch: 'normal',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：普通路径中的 bare 后 locked 字段不提前截断', () => {
  const text = [
    'worktree /normal',
    'bare',
    'locked path metadata',
    'HEAD 7777777777777777777777777777777777777777',
    'branch refs/heads/normal',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/normal\nbare\nlocked path metadata',
    branch: 'normal',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：空输出返回空数组', () => {
  assert.deepEqual(parseWorktreeList(''), [])
})

test('parseWorktreeList：NUL 分隔保留换行、引号与末尾空白路径', () => {
  const paths = ['/vault\nreview/task', '/vault "quoted"/task', '/vault/space \t\r']
  const text = paths.map((path) => [
    `worktree ${path}`,
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/wtm/task',
    'locked reason\nwith newline',
    '',
    '',
  ].join('\0')).join('')
  const list = parseWorktreeList(text)
  assert.deepEqual(list.map((entry) => entry.path), paths)
  assert.ok(list.every((entry) => entry.branch === 'wtm/task' && entry.locked))
})

test('parseWorktreeList：NUL 路径中的元数据样式文本不产生伪记录', () => {
  const path = '/vault\nHEAD deadbeef\nbranch refs/heads/other\n\nworktree /fake'
  const text = [
    `worktree ${path}`, 'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/real', '',
    'worktree /bare', 'bare', '',
    'worktree /detached', 'HEAD 2222222222222222222222222222222222222222',
    'detached', '', '',
  ].join('\0')
  assert.deepEqual(parseWorktreeList(text), [
    { path, branch: 'real', detached: false, bare: false, locked: false },
    { path: '/bare', branch: null, detached: false, bare: true, locked: false },
    { path: '/detached', branch: null, detached: true, bare: false, locked: false },
  ])
})

test('parseWorktreeList：prunable 条目正常解析（目录被删后的残留）', () => {
  // git worktree list --porcelain 对已删除目录的工作区输出 prunable 行，
  // 解析器必须保留该条目与其分支信息（ops.js 结合目录实存判定 stale）。
  const text = [
    'worktree C:/main',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree D:/wtm-vaults/gone',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/wtm/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n')
  const list = parseWorktreeList(text)
  assert.equal(list.length, 2)
  assert.equal(list[1].path, 'D:/wtm-vaults/gone')
  assert.equal(list[1].branch, 'wtm/gone')
  assert.equal(list[1].locked, false)
})

test('parseWorktreeList：保留旧版 porcelain 中路径内的换行', () => {
  const text = [
    'worktree /tmp/worktree',
    'with-newline',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/task-with-newline',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text), [{
    path: '/tmp/worktree\nwith-newline',
    branch: 'task-with-newline',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：NUL porcelain 保留路径内的元数据样式换行', () => {
  const path = '/tmp/wt\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/path-text'
  const text = [
    `worktree ${path}`,
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/actual',
    '',
  ].join('\0')

  assert.deepEqual(parseWorktreeList(text), [{
    path,
    branch: 'actual',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：路径内类似 HEAD 字段时不提前截断', () => {
  const text = [
    'worktree /tmp/worktree\nHEAD 4444444444444444444444444444444444444444',
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/task-with-head-line',
    '',
  ].join('\n')
  assert.equal(parseWorktreeList(text)[0].path, '/tmp/worktree\nHEAD 4444444444444444444444444444444444444444')
})

test('parseWorktreeList：路径内 HEAD 和 branch 字段不提前截断', () => {
  const path = '/tmp/wt\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/path-text'
  const text = [
    `worktree ${path}`,
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/actual',
    '',
  ].join('\n')

  assert.deepEqual(parseWorktreeList(text), [{
    path,
    branch: 'actual',
    detached: false,
    bare: false,
    locked: false,
  }])
})

test('parseWorktreeList：路径内 HEAD 和 branch 字段在 bare 记录中不提前截断', () => {
  const path = '/tmp/wt\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/path-text'
  const text = [`worktree ${path}`, 'bare', ''].join('\n')

  assert.deepEqual(parseWorktreeList(text), [{
    path,
    branch: null,
    detached: false,
    bare: true,
    locked: false,
  }])
})

test('parseWorktreeList：多行锁定原因中的 HEAD 字段不影响记录边界', () => {
  const text = [
    'worktree /tmp/wt',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/task',
    'locked reason before newline',
    'HEAD 4444444444444444444444444444444444444444',
    'locked reason after newline',
    '',
  ].join('\n')

  assert.deepEqual(parseWorktreeList(text), [{
    path: '/tmp/wt',
    branch: 'task',
    detached: false,
    bare: false,
    locked: true,
  }])
})

test('parseWorktreeList：保留路径末尾的换行', () => {
  const text = [
    'worktree /tmp/worktree\n',
    'HEAD 6666666666666666666666666666666666666666',
    'branch refs/heads/task-with-trailing-newline',
    '',
  ].join('\n')
  assert.equal(parseWorktreeList(text)[0].path, '/tmp/worktree\n')
})

test('parseWorktreeList：保留 POSIX 路径末尾的回车符', () => {
  const text = [
    'worktree /tmp/worktree\r',
    'HEAD 7777777777777777777777777777777777777777',
    'branch refs/heads/task-with-trailing-carriage-return',
    '',
  ].join('\n')
  assert.equal(parseWorktreeList(text)[0].path, '/tmp/worktree\r')
})

test('parseAheadBehind：按 base...branch 语义映射 rev-list 计数', () => {
  // rev-list 的第一个计数是基分支独有提交（任务落后），第二个是任务分支独有提交（任务领先）。
  assert.deepEqual(parseAheadBehind('3\t5'), { ahead: 5, behind: 3 })
  assert.deepEqual(parseAheadBehind('0\t0'), { ahead: 0, behind: 0 })
  assert.equal(parseAheadBehind('garbage'), null)
  assert.equal(parseAheadBehind(''), null)
})

test('isDirty：porcelain 输出非空即脏', () => {
  assert.equal(isDirty(''), false)
  assert.equal(isDirty(' M file.txt\n'), true)
  assert.equal(isDirty('?? untracked.txt\n'), true)
})

test('runGit：跨 chunk 的 UTF-8 路径保持完整', async () => {
  const spawnImpl = () => {
    const child = /** @type {any} */ (new EventEmitter())
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from([0xe4, 0xb8]))
      child.stdout.emit('data', Buffer.from([0xad]))
      child.stderr.emit('data', Buffer.from([0xc3]))
      child.stderr.emit('data', Buffer.from([0xa9]))
      child.emit('close', 0, null)
    })
    return child
  }

  const result = await runGit(['status'], { spawnImpl })
  assert.equal(result.stdout, '中')
  assert.equal(result.stderr, 'é')
})

test('runGit：AbortError 后等待 close 再完成', async () => {
  let child = /** @type {any} */ (null)
  const spawnImpl = () => {
    child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    return child
  }

  const resultPromise = runGit(['status'], { spawnImpl })
  let settled = false
  resultPromise.then(() => { settled = true })

  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  child.emit('error', error)
  await Promise.resolve()
  assert.equal(settled, false)

  child.emit('close', null, 'SIGTERM')
  assert.deepEqual(await resultPromise, {
    ok: false,
    code: -1,
    stdout: '',
    stderr: '',
    aborted: true,
  })
})

test('runGit：未中止的 AbortSignal 遇到外部 SIGTERM/SIGKILL 时不标记 aborted', async () => {
  for (const codeSig of ['SIGTERM', 'SIGKILL']) {
    let child = /** @type {any} */ (null)
    const spawnImpl = () => {
      child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', null, codeSig))
      return child
    }
    const ac = new AbortController()

    const result = await runGit(['status'], { signal: ac.signal, spawnImpl })

    assert.equal(ac.signal.aborted, false)
    assert.deepEqual(result, {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      aborted: false,
    })
  }
})

test('GitRunner.run：真实 git 可用时返回结构 {ok, code, stdout, stderr}', { skip: !GitRunner.probe() }, async () => {
  const git = new GitRunner()
  const r = await git.run(['--version'], { cwd: process.cwd() })
  assert.equal(r.ok, true)
  assert.match(r.stdout, /git version/)
})

test('GitRunner.run：命令失败时 ok=false 且保留 stderr', { skip: !GitRunner.probe() }, async () => {
  const git = new GitRunner()
  // 注意：git ≥2.45 将 rev-parse 的未知 -- 选项当作待解析 ref 处理并返回 0，
  // 因此用不存在的子命令制造确定的失败（任意 git 版本退出码均非 0）。
  const r = await git.run(['does-not-exist-command'], { cwd: process.cwd() })
  assert.equal(r.ok, false)
  assert.ok(r.code !== 0)
})

test('GitRunner.run：尊重 signal 中止', { skip: !GitRunner.probe() }, async () => {
  const git = new GitRunner()
  const ac = new AbortController()
  ac.abort()
  const r = await git.run(['--version'], { cwd: process.cwd(), signal: ac.signal })
  assert.equal(r.ok, false)
  assert.equal(r.aborted, true)
})
