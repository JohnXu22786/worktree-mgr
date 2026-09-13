import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('CLI：finish 的未知选项拒绝执行，不采用默认 commit', () => {
  const result = runCli(['finish', 'task', '--modee', 'abandon'], process.cwd())

  assert.equal(result.status, 2)
  assert.match(result.stderr, /未知选项：--modee/)
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
