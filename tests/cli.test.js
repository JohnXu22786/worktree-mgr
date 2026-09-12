import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('CLI：非 JSON 失败结果仍输出 warnings', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wtm-cli-warning-'))
  const vault = mkdtempSync(join(tmpdir(), 'wtm-cli-warning-vault-'))
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
    execFileSync('git', ['config', 'user.email', 'wtm-tests@example.invalid'], { cwd })
    execFileSync('git', ['config', 'user.name', 'wtm tests'], { cwd })
    writeFileSync(join(cwd, 'README'), 'test\n')
    execFileSync('git', ['add', 'README'], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd })
    execFileSync('git', ['branch', 'wtm/existing'], { cwd })
    writeFileSync(join(cwd, '.wtm.json'), JSON.stringify({ vault, unknown: true }))

    const result = runCli(['begin', 'existing'], cwd)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /错误：.*分支已存在/)
    assert.match(result.stdout, /未知或类型不符的配置键/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  }
})
