import { realpathSync } from 'node:fs'

/**
 * Normalize Windows path aliases for identity and containment comparisons.
 * @param {string} path
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizePathForComparison(path, platform = process.platform) {
  if (platform !== 'win32') return path

  let resolved = path
  try {
    resolved = realpathSync.native(path)
  } catch {
    // A missing or inaccessible path can still be compared lexically.
  }

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
