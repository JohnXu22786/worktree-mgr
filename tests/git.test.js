import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorktreeList, parseAheadBehind, isDirty, samePath, resolveToplevel, GitRunner } from '../src/git.js'

test('samePath：Windows 风格分隔符差异不影响匹配', { skip: process.platform !== 'win32' }, () => {
  assert.equal(samePath('C:/wtm/vault/t1', 'C:\\wtm\\vault\\t1'), true)
  assert.equal(samePath('C:/a', 'C:/b'), false)
})

test('samePath：POSIX 下保留路径分隔符语义', { skip: process.platform === 'win32' }, () => {
  assert.equal(samePath('/wtm/vault/t1', '/wtm/vault/t1'), true)
  assert.equal(samePath('/wtm/vault/t1', '\\wtm\\vault\\t1'), false)
})

test('samePath：Windows 下忽略大小写', { skip: process.platform !== 'win32' }, () => {
  assert.equal(samePath('C:/wtm/vault/T1', 'c:\\wtm\\vault\\t1'), true)
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

test('parseWorktreeList：bare 记录后仍能解析普通工作区', () => {
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

test('parseWorktreeList：路径内类似 HEAD 字段时不提前截断', () => {
  const text = [
    'worktree /tmp/worktree\nHEAD 4444444444444444444444444444444444444444',
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/task-with-head-line',
    '',
  ].join('\n')
  assert.equal(parseWorktreeList(text)[0].path, '/tmp/worktree\nHEAD 4444444444444444444444444444444444444444')
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
