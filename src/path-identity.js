import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Resolve the existing prefix of a path and append any missing tail.
 * @param {string} path
 * @returns {string}
 */
function resolveExistingPrefix(path) {
  if (process.platform !== 'win32' && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))) {
    return path
  }
  let current = path
  /** @type {string[]} */
  const tail = []
  while (true) {
    try {
      let resolved = realpathSync.native(current)
      for (let i = tail.length - 1; i >= 0; i -= 1) resolved = join(resolved, tail[i])
      return resolved
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      const name = basename(current)
      if (name === '') return path
      tail.push(name)
      current = parent
    }
  }
}

/**
 * Normalize Windows path aliases for identity and containment comparisons.
 * @param {string} path
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizePathForComparison(path, platform = process.platform) {
  if (platform !== 'win32') return path

  const resolved = resolveExistingPrefix(path)
  let normalized = resolved.replace(/\\/g, '/')
  if (/^\/\/\?\/UNC\//i.test(normalized)) {
    normalized = normalized.replace(/^\/\/\?\/UNC\//i, '//')
  } else if (normalized.startsWith('//?/') || normalized.startsWith('/??/')) {
    normalized = normalized.slice(4)
  }
  return normalized.toLowerCase()
}

/**
 * Compare path identity using Windows filesystem aliases where applicable.
 * @param {string} a
 * @param {string} b
 * @param {string} [platform]
 * @returns {boolean}
 */
export function samePathIdentity(a, b, platform = process.platform) {
  return normalizePathForComparison(a, platform) === normalizePathForComparison(b, platform)
}
