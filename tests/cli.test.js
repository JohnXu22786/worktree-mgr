import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const CLI = fileURLToPath(new URL('../bin/wtm.js', import.meta.url))

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCli(args, cwd) {
  const env = { ...process.env }
  delete env.WTM_ROOT
  delete env.WTM_VAULT
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  })
}

test('CLI：finish 的 --mode 缺少值时拒绝执行，不采用默认 commit', () => {
  const result = runCli(['finish', 'task', '--mode'], process.cwd())

  assert.equal(result.status, 2)
  assert.match(result.stderr, /--mode.*缺少值/)
})

test('CLI：begin 的 --base 缺少值时在解析阶段报错', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-base-'))
  try {
    const result = runCli(['begin', 'task', '--base'], cwd)

    assert.equal(result.status, 2)
    assert.match(result.stderr, /--base.*缺少值/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI：begin 的 --root 缺少值时拒绝回退到当前目录', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-root-'))
  try {
    const result = runCli(['begin', 'task', '--root'], cwd)

    assert.equal(result.status, 2)
    assert.match(result.stderr, /--root.*缺少值/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI：仓库配置读取失败时 --json 返回结构化错误', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtm-cli-config-'))
  try {
    execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' })
    mkdirSync(join(root, '.wtm.json'))
    const result = runCli(['status', '--root', root, '--json'], root)

    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.match(payload.error, /EISDIR/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI：status 将工作区分支漂移渲染为可操作提示而非工作区缺失', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wtm-cli-branch-drift-'))
  const vault = mkdtempSync(join(tmpdir(), 'wtm-cli-branch-drift-vault-'))
  const task = 'Add Search Box'
  const taskPath = join(vault, 'add-search-box')
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'wtm-test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'wtm@example.test'])
    writeFileSync(join(root, 'base.txt'), 'base\n')
    execFileSync('git', ['-C', root, 'add', 'base.txt'])
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'])
    writeFileSync(join(root, '.wtm.json'), JSON.stringify({ vault }))

    const begin = runCli(['begin', task, '--root', root], root)
    assert.equal(begin.status, 0, begin.stderr)
    assert.equal(existsSync(taskPath), true)

    execFileSync('git', ['-C', taskPath, 'switch', '--create', 'other'])
    const status = runCli(['status', '--root', root], root)

    assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`)
    assert.doesNotMatch(status.stdout, /工作区缺失/)
    assert.match(status.stdout, /分支漂移/)
    assert.match(status.stdout, /git -C ".+" switch "wtm\/add-search-box"/)
    assert.match(status.stdout, /wtm finish "Add Search Box" --mode keep/)
  } finally {
    if (existsSync(taskPath)) {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', taskPath], { stdio: 'ignore' })
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('CLI：当前目录被删除时 --json 返回结构化 root 解析错误', { skip: process.platform === 'win32' }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-missing-cwd-'))
  const env = { ...process.env }
  delete env.WTM_ROOT
  delete env.WTM_VAULT
  try {
    const script = [
      "import { rmSync } from 'node:fs'",
      `process.argv = [process.argv[0], ${JSON.stringify(CLI)}, 'status', '--json']`,
      `process.chdir(${JSON.stringify(cwd)})`,
      `rmSync(${JSON.stringify(cwd)}, { recursive: true, force: true })`,
      `await import(${JSON.stringify(pathToFileURL(CLI).href)})`,
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      encoding: 'utf8',
      env,
    })

    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr, '')
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.match(payload.error, /解析仓库路径失败/)
    assert.match(payload.error, /cwd|ENOENT|no such file/i)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI：非 JSON purge 输出每个任务的收尾警告', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wtm-cli-purge-warning-'))
  const vault = mkdtempSync(join(tmpdir(), 'wtm-cli-purge-warning-vault-'))
  let duplicateWorktree
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'wtm-test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'wtm@example.test'])
    writeFileSync(join(root, 'base.txt'), 'base\n')
    execFileSync('git', ['-C', root, 'add', 'base.txt'])
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'])
    writeFileSync(join(root, '.wtm.json'), JSON.stringify({ vault }))
    execFileSync('git', ['-C', root, 'add', '.wtm.json'])
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'configure vault'])

    const begin = runCli(['begin', 'purge-warning', '--root', root], root)
    assert.equal(begin.status, 0, begin.stderr)

    duplicateWorktree = mkdtempSync(join(tmpdir(), 'wtm-cli-purge-warning-duplicate-'))
    execFileSync('git', [
      '-C', root, 'worktree', 'add', '--force', '--quiet', duplicateWorktree, 'wtm/purge-warning',
    ])

    const purge = runCli(['purge', 'purge-warning', '--root', root], root)

    assert.equal(purge.status, 0, `${purge.stderr}\n${purge.stdout}`)
    assert.match(purge.stdout, /• purge-warning：完成/)
    assert.match(purge.stdout, /警告：分支删除失败（wtm\/purge-warning）/)
  } finally {
    if (duplicateWorktree) {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', duplicateWorktree], { stdio: 'ignore' })
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})

test('CLI：非 JSON 失败时仍输出工作区回滚警告', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wtm-cli-rollback-'))
  const vault = mkdtempSync(join(tmpdir(), 'wtm-cli-rollback-vault-'))
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'wtm-test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'wtm@example.test'])
    writeFileSync(join(root, 'base.txt'), 'base\n')
    execFileSync('git', ['-C', root, 'add', 'base.txt'])
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'])
    writeFileSync(join(root, '.wtm.json'), JSON.stringify({
      vault,
      triggers: {
        on_begin: [
          `rm -rf "$WTM_PATH" && touch "$WTM_PATH" && rm -f '${join(vault, 'index.json')}' && mkdir '${join(vault, 'index.json')}'`,
        ],
      },
    }))

    const result = runCli(['begin', 'rollback-warning', '--root', root], root)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /错误：创建失败/)
    assert.match(result.stdout, /警告：工作区创建未完成，且回滚失败/)
    assert.match(result.stdout, /请手动执行 git worktree remove \/ branch -D/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})
