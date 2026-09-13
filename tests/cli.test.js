import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('CLI：单任务命令拒绝多余的位置参数', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-positionals-'))
  try {
    for (const [command, args] of [
      ['begin', ['Task A', 'typo']],
      ['merge', ['Task A', 'typo']],
      ['finish', ['Task A', 'typo']],
      ['status', ['unexpected']],
      ['finish', ['Task A', '--json', 'typo']],
      ['status', ['--json', 'unexpected']],
    ]) {
      const result = runCli([command, ...args], cwd)

      assert.equal(result.status, 2, `${command} should reject extra positional arguments`)
      assert.match(result.stderr, /位置参数/)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI：未知选项拒绝执行，不把后续参数当作任务', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-unknown-option-'))
  try {
    execFileSync('git', ['init', '--quiet', cwd], { stdio: 'ignore' })
    writeFileSync(join(cwd, '.wtm.json'), JSON.stringify({ vault: join(cwd, 'vault') }))

    const result = runCli(['purge', '--typo', 'ExistingTask', '--mode', 'abandon', '--json'], cwd)

    assert.equal(result.status, 2)
    assert.match(result.stderr, /未知选项.*--typo/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI：布尔选项不吞掉后续位置参数', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-purge-positionals-'))
  try {
    execFileSync('git', ['init', '--quiet', cwd], { stdio: 'ignore' })
    writeFileSync(join(cwd, '.wtm.json'), JSON.stringify({ vault: join(cwd, 'vault') }))

    const result = runCli(['purge', 'Task A', '--json', 'Task B'], cwd)

    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.results.map((item) => item.task), ['Task A', 'Task B'])

    const allResult = runCli(['purge', '--all', 'Task B', '--json'], cwd)

    assert.equal(allResult.status, 1)
    const allPayload = JSON.parse(allResult.stdout)
    assert.match(allPayload.error, /all 与 tasks 不能同时指定/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

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
