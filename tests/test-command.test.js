import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('npm test uses Node test discovery without passing tests/ as a module', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )

  assert.equal(packageJson.scripts.test, 'node --test')
})
