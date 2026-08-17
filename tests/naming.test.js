import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugifyTask, deriveBranch, validateBranch, validateTask, validatePrefix } from '../src/naming.js'

test('slugifyTask：普通英文任务名转小写并保留连字符', () => {
  assert.equal(slugifyTask('Add Search Box'), 'add-search-box')
})

test('slugifyTask：CJK 字符保留为合法分支字符', () => {
  assert.equal(slugifyTask('实现深色模式'), '实现深色模式')
  assert.equal(slugifyTask('修复 bug 崩溃'), '修复-bug-崩溃')
})

test('slugifyTask：非法字符替换为连字符，连续连字符折叠', () => {
  assert.equal(slugifyTask('a b   c'), 'a-b-c')
  assert.equal(slugifyTask('a!b@c#d$'), 'a-b-c-d')
  assert.equal(slugifyTask('RATE:LIMIT!'), 'rate-limit')
})

test('slugifyTask：前后缀点与连字符剥离，不产生前导 -', () => {
  assert.equal(slugifyTask('-leading-dash'), 'leading-dash')
  assert.equal(slugifyTask('.hidden.'), 'hidden')
  assert.equal(slugifyTask('  spaced  '), 'spaced')
})

test('slugifyTask：保留多级斜杠分段，剔除空段与 . 和 .. 段', () => {
  assert.equal(slugifyTask('ui/dark-mode'), 'ui/dark-mode')
  assert.equal(slugifyTask('a//b'), 'a/b')
  assert.equal(slugifyTask('a/../b'), 'a/b')
  assert.equal(slugifyTask('a/./b'), 'a/b')
  assert.equal(slugifyTask('/leading-slash'), 'leading-slash')
})

test('slugifyTask：空输入与纯非法输入回退为 task', () => {
  assert.equal(slugifyTask(''), 'task')
  assert.equal(slugifyTask('   '), 'task')
  assert.equal(slugifyTask('!!!'), 'task')
  assert.equal(slugifyTask(null), 'task')
  assert.equal(slugifyTask(undefined), 'task')
})

test('slugifyTask：段内 .. / .lock 结尾 / 段首点 均修正为合法形态', () => {
  assert.equal(slugifyTask('a..b'), 'a-b')
  assert.equal(slugifyTask('a.lock'), 'a-lock')
  assert.equal(slugifyTask('x.a.lock'), 'x.a-lock')
  assert.equal(slugifyTask('a/.hidden'), 'a/hidden')
  // 修正后的 slug 必须通过分支校验（契约保证）
  for (const t of ['a..b', 'a.lock', 'x.a.lock', 'a/.hidden']) {
    assert.equal(validateBranch(deriveBranch(t)).ok, true, `派生分支应合法: ${t}`)
  }
})

test('slugifyTask：超长任务名被截断（含前缀仍不超 100 字符）', () => {
  const long = 'x'.repeat(300)
  const slug = slugifyTask(long)
  assert.ok(slug.length <= 60, `slug 长度 ${slug.length} 应 ≤ 60`)
  const branch = deriveBranch(long, 'wtm')
  assert.ok(branch.length <= 100, `分支名长度 ${branch.length} 应 ≤ 100`)
})

test('deriveBranch：默认前缀 wtm，支持自定义前缀', () => {
  assert.equal(deriveBranch('Dark Mode'), 'wtm/dark-mode')
  assert.equal(deriveBranch('Dark Mode', 'sandbox'), 'sandbox/dark-mode')
  assert.equal(deriveBranch('Deep/嵌套', 'isolate'), 'isolate/deep/嵌套')
})

test('validateBranch：接受合法分支名', () => {
  assert.deepEqual(validateBranch('wtm/feat-1'), { ok: true })
  assert.deepEqual(validateBranch('main'), { ok: true })
  assert.deepEqual(validateBranch('feature/深色/模式'), { ok: true })
})

test('validateBranch：拒绝 git 非法 ref（防注入）', () => {
  const bad = [
    '-leading-dash',
    'a..b',
    'a@{b',
    'a b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a/',
    '/a',
    'a//b',
    'a.lock',
    'x/.hidden',
    '.hidden',
    'a.',
    'a\u0007b',
    '@',
    '',
  ]
  for (const name of bad) {
    const r = validateBranch(name)
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(name)} 实际结果: ${JSON.stringify(r)}`)
  }
})

test('validateBranch：长度上限 255', () => {
  assert.equal(validateBranch('x'.repeat(255)).ok, true)
  assert.equal(validateBranch('x'.repeat(256)).ok, false)
})

test('validatePrefix：必须为单段合法 ref', () => {
  assert.equal(validatePrefix('wtm').ok, true)
  assert.equal(validatePrefix('a/b').ok, false)
  assert.equal(validatePrefix('-x').ok, false)
  assert.equal(validatePrefix('').ok, false)
})

test('validateTask：非空且长度受限', () => {
  assert.deepEqual(validateTask('Add search'), { ok: true })
  assert.equal(validateTask('').ok, false)
  assert.equal(validateTask('   ').ok, false)
  assert.equal(validateTask('x'.repeat(500)).ok, false)
})
