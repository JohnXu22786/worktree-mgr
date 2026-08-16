import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaults,
  loadConfig,
  renderTemplate,
  parseRepoConfigText,
} from '../src/config.js'

test('loadConfig：默认值', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.prefix, 'wtm')
  assert.equal(cfg.vault, null)
  assert.match(cfg.commitMessage, /\{task\}/)
  assert.match(cfg.mergeMessage, /\{base\}/)
  assert.deepEqual(cfg.warnings, [])
})

test('loadConfig：优先级 默认 < 插件配置 < 仓库文件 < 环境变量', () => {
  const cfg = loadConfig({
    pluginConfig: { prefix: 'from-plugin', vault: 'P' },
    repoConfig: { prefix: 'from-repo', vault: 'R' },
    env: { WTM_PREFIX: 'from-env' },
  })
  assert.equal(cfg.prefix, 'from-env')
  assert.equal(cfg.vault, 'R') // 环境未提供 vault，取仓库文件值
})

test('loadConfig：仓库文件覆盖插件配置', () => {
  const cfg = loadConfig({
    pluginConfig: { prefix: 'plugin', vault: 'P' },
    repoConfig: { prefix: 'repo' },
  })
  assert.equal(cfg.prefix, 'repo')
  assert.equal(cfg.vault, 'P')
})

test('loadConfig：环境变量直接映射', () => {
  const cfg = loadConfig({
    env: {
      WTM_VAULT: 'D:/vault',
      WTM_PREFIX: 'iso',
      WTM_COMMIT_MESSAGE: 'snap {task}',
      WTM_MERGE_MESSAGE: 'fold {task}',
    },
  })
  assert.equal(cfg.vault, 'D:/vault')
  assert.equal(cfg.prefix, 'iso')
  assert.equal(cfg.commitMessage, 'snap {task}')
  assert.equal(cfg.mergeMessage, 'fold {task}')
})

test('loadConfig：非法前缀与非法消息产生警告而非崩溃', () => {
  const cfg = loadConfig({
    pluginConfig: { prefix: '-bad' },
    repoConfig: { prefix: 'a/b', commitMessage: 42 },
    env: { WTM_PREFIX: 'x y' },
  })
  assert.equal(cfg.prefix, 'wtm')
  assert.equal(cfg.commitMessage, defaults().commitMessage)
  assert.ok(cfg.warnings.length >= 2, `应有警告，实际: ${JSON.stringify(cfg.warnings)}`)
})

test('loadConfig：未知配置键产生警告，seed/triggers 属于仓库文件合法键', () => {
  const cfg = loadConfig({
    repoConfig: { seed: { files: ['a'] }, triggers: { on_begin: ['x'] }, bogusKey: 1 },
  })
  assert.equal(cfg.warnings.length, 1)
  assert.match(cfg.warnings[0], /bogusKey/)
})

test('renderTemplate：替换全部占位符，缺失占位符原样保留', () => {
  const out = renderTemplate('commit {task} on {base} {task}', { task: 'T', base: 'B' })
  assert.equal(out, 'commit T on B T')
  assert.equal(renderTemplate('no vars', {}), 'no vars')
  assert.equal(renderTemplate('{missing} here', {}), '{missing} here')
})

test('parseRepoConfigText：合法 JSON 解析', () => {
  const r = parseRepoConfigText('{"prefix": "iso", "seed": {"files": ["a"]}}')
  assert.equal(r.ok, true)
  assert.notEqual(r.value, null)
  assert.equal(/** @type {Record<string, unknown>} */ (r.value).prefix, 'iso')
})

test('parseRepoConfigText：非对象 JSON 拒绝', () => {
  assert.equal(parseRepoConfigText('42').ok, false)
  assert.equal(parseRepoConfigText('"str"').ok, false)
  assert.equal(parseRepoConfigText('[]').ok, false)
})

test('parseRepoConfigText：损坏 JSON 报错', () => {
  const r = parseRepoConfigText('{not json')
  assert.equal(r.ok, false)
  assert.match(r.error, /JSON/i)
})

test('parseRepoConfigText：空内容视为无仓库配置', () => {
  const r = parseRepoConfigText('')
  assert.equal(r.ok, true)
  assert.equal(r.value, null)
})
