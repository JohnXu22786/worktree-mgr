import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const MERGE_TREE_STRATEGIES = new Set(['ort', 'ours'])

/** @param {string} value @returns {string[] | null} */
function splitMergeOptions(value) {
  const options = []
  let option = ''
  let quote = ''
  let escaped = false
  let started = false
  for (const character of value) {
    if (escaped) {
      option += character
      escaped = false
      started = true
    } else if (quote === "'") {
      if (character === "'") quote = ''
      else option += character
      started = true
    } else if (quote === '"') {
      if (character === '"') quote = ''
      else if (character === '\\') escaped = true
      else option += character
      started = true
    } else if (character === '\\') {
      escaped = true
      started = true
    } else if (character === "'" || character === '"') {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) options.push(option)
      option = ''
      started = false
    } else {
      option += character
      started = true
    }
  }
  if (quote || escaped) return null
  if (started) options.push(option)
  return options
}

/**
 * Read the configured merge options and reject strategies the immutable-tree guard cannot model.
 * @param {string} root
 * @param {{run: Function}} git
 * @param {AbortSignal | undefined} signal
 * @param {string} expectedBase
 * @returns {Promise<{ok: true, value: string | null, strategy: string | null, treeOptions: string[]} | {ok: false, error: string}>}
 */
export async function readMergeOptions(root, git, signal, expectedBase) {
  const result = await git.run(['config', '--get', `branch.${expectedBase}.mergeOptions`], { cwd: root, signal })
  if (!result.ok && result.code === 1) return { ok: true, value: null, strategy: null, treeOptions: [] }
  if (!result.ok) {
    return { ok: false, error: `读取基分支 mergeOptions 失败：${result.stderr.trim() || 'git config 失败'}` }
  }

  const value = result.stdout.replace(/\r?\n$/, '')
  const options = splitMergeOptions(value)
  if (!options) {
    return { ok: false, error: '基分支 mergeOptions 包含未闭合引号或转义' }
  }
  let strategy = null
  let strategyCount = 0
  const treeOptions = []
  let allowUnrelated = false
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i]
    if (option === '-s' || option === '--strategy') {
      strategyCount += 1
      strategy = options[i + 1]
      if (!strategy || strategy.startsWith('-')) {
        return { ok: false, error: '基分支 mergeOptions 中的 merge strategy 缺少值' }
      }
      i += 1
    } else if (option.startsWith('--strategy=')) {
      strategyCount += 1
      strategy = option.slice('--strategy='.length)
    } else if (option.startsWith('-s') && option.length > 2) {
      strategyCount += 1
      strategy = option.slice(2).replace(/^=/, '')
    } else if (option === '-X' || option === '--strategy-option') {
      const value = options[i + 1]
      if (value === undefined || value === '') {
        return { ok: false, error: '基分支 mergeOptions 中的 merge strategy option 缺少值' }
      }
      treeOptions.push('-X', value)
      i += 1
    } else if (option.startsWith('--strategy-option=')) {
      const value = option.slice('--strategy-option='.length)
      if (!value) return { ok: false, error: '基分支 mergeOptions 中的 merge strategy option 缺少值' }
      treeOptions.push('-X', value)
    } else if (option.startsWith('-X') && option.length > 2) {
      const value = option.slice(2).replace(/^=/, '')
      if (!value) return { ok: false, error: '基分支 mergeOptions 中的 merge strategy option 缺少值' }
      treeOptions.push('-X', value)
    } else if (option === '--allow-unrelated-histories') {
      allowUnrelated = true
    } else if (option === '--no-allow-unrelated-histories') {
      allowUnrelated = false
    }
  }

  if (strategyCount > 1) {
    return { ok: false, error: '基分支 mergeOptions 配置了多个 merge strategy，当前 merge guard 不支持按顺序尝试多个策略' }
  }
  if (strategy !== null && !MERGE_TREE_STRATEGIES.has(strategy)) {
    return {
      ok: false,
      error: `基分支 mergeOptions 配置了当前 merge guard 不支持的策略：${strategy}（支持 ort 和 ours）`,
    }
  }
  if (allowUnrelated) treeOptions.push('--allow-unrelated-histories')
  return { ok: true, value, strategy, treeOptions }
}

/**
 * Calculate the merge tree before repository hooks can change merge configuration.
 * @param {string} root
 * @param {{run: Function}} git
 * @param {AbortSignal | undefined} signal
 * @param {string} baseHead
 * @param {string} mergeHead
 * @param {{strategy: string | null, treeOptions: string[]}} mergeOptions
 * @returns {Promise<{ok: true, tree: string} | {ok: false, error: string}>}
 */
export async function calculateMergeTree(root, git, signal, baseHead, mergeHead, mergeOptions) {
  const env = { LC_ALL: 'C', LANG: 'C' }
  const result = mergeOptions.strategy === 'ours'
    ? await git.run(['rev-parse', '--verify', `${baseHead}^{tree}`], { cwd: root, signal, env })
    : await git.run(['merge-tree', '--write-tree', ...mergeOptions.treeOptions, baseHead, mergeHead], { cwd: root, signal, env })
  if (!result.ok) {
    return {
      ok: false,
      error: `计算预期合并树失败：${result.stderr.trim() || (mergeOptions.strategy === 'ours' ? 'git rev-parse 失败' : 'git merge-tree 失败')}`,
    }
  }
  const tree = result.stdout.trim().split(/\r?\n/, 1)[0]
  if (!tree) return { ok: false, error: '计算预期合并树失败：git 未返回 tree' }
  return { ok: true, tree }
}

/**
 * Install a temporary reference-transaction guard for snapshot commits.
 * @param {string} worktree
 * @param {{run: Function}} git
 * @param {AbortSignal | undefined} signal
 * @param {string} expectedBranch
 * @param {string} expectedHead
 * @returns {Promise<{hooksPath: string}>}
 */
export async function createSnapshotGuard(worktree, git, signal, expectedBranch, expectedHead) {
  const hooks = await git.run(['rev-parse', '--git-path', 'hooks'], { cwd: worktree, signal })
  if (!hooks.ok) {
    throw new Error(`读取仓库 hooks 路径失败：${hooks.stderr.trim() || 'git rev-parse 失败'}`)
  }

  const originalHooksPath = resolve(worktree, hooks.stdout.replace(/\r?\n$/, ''))
  const hooksPath = mkdtempSync(join(tmpdir(), 'wtm-snapshot-hooks-'))
  try {
    const branchRef = `refs/heads/${expectedBranch}`
    /** @param {string} value */
    const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`
    const expectedRef = quote(branchRef)
    const expectedTip = quote(expectedHead)
    /** @param {string} name */
    const originalHook = (name) => quote(join(originalHooksPath, name))
    const inheritedParameters = process.env.GIT_CONFIG_PARAMETERS ?? ''
    const cleanConfig = `GIT_CONFIG_PARAMETERS=${quote(inheritedParameters)}`
    /** @param {string} name @param {string} body */
    const writeHook = (name, body) => {
      const hookPath = join(hooksPath, name)
      writeFileSync(hookPath, body, 'utf8')
      chmodSync(hookPath, 0o755)
    }

    for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      writeHook(name, `#!/bin/sh
hook=${originalHook(name)}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" || exit $?; fi
exit 0
`)
    }

    writeHook('reference-transaction', `#!/bin/sh
input=$(mktemp "\${TMPDIR:-/tmp}/wtm-snapshot-ref-transaction.XXXXXX") || {
  echo 'wtm: unable to create snapshot transaction input' >&2
  exit 1
}
cleanup() { rm -f "$input"; }
trap cleanup 0 HUP INT TERM
cat >"$input" || exit 1
hook=${originalHook('reference-transaction')}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" <"$input" || exit $?; fi
if [ "$1" = prepared ]; then
  if update=$(awk -v ref=${expectedRef} '$3 == ref { print $1 " " $2; count++ } END { exit count == 1 ? 0 : 1 }' "$input"); then
    current_branch=$(GIT_OPTIONAL_LOCKS=0 git symbolic-ref --quiet HEAD 2>/dev/null) || {
      echo 'wtm: snapshot commit has no symbolic task branch' >&2
      exit 1
    }
    if [ "$current_branch" != ${expectedRef} ]; then
      echo '快照提交拒绝更新其他分支或分支尖端' >&2
      exit 1
    fi
    old=\${update%% *}
    new=\${update#* }
    if [ "$old" != ${expectedTip} ]; then
      echo '快照提交拒绝更新其他分支或分支尖端' >&2
      exit 1
    fi
    parent=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --verify "$new^" 2>/dev/null) || {
      echo '快照提交拒绝更新其他分支或分支尖端' >&2
      exit 1
    }
    if [ "$parent" != ${expectedTip} ]; then
      echo '快照提交拒绝更新其他分支或分支尖端' >&2
      exit 1
    fi
  elif awk '$NF == "HEAD" || substr($3, 1, 11) == "refs/heads/" { found = 1 } END { exit found ? 0 : 1 }' "$input"; then
    echo '快照提交拒绝更新其他分支或分支尖端' >&2
    exit 1
  fi
fi
exit 0
`)

    return { hooksPath }
  } catch (err) {
    rmSync(hooksPath, { recursive: true, force: true })
    throw err
  }
}

/**
 * Install temporary hooks that validate the merge while Git prepares its ref transaction.
 * The returned directory must be removed after the merge command finishes.
 * @param {string} root
 * @param {{run: Function}} git
 * @param {AbortSignal | undefined} signal
 * @param {string} expectedBase
 * @param {{expectedTree: string, expectedBaseHead: string, expectedMergeHead: string}} expectedMerge
 * @returns {Promise<{hooksPath: string}>}
 */
export async function createMergeGuard(root, git, signal, expectedBase, expectedMerge) {
  const hooks = await git.run(['rev-parse', '--git-path', 'hooks'], { cwd: root, signal })
  if (!hooks.ok) {
    throw new Error(`读取仓库 hooks 路径失败：${hooks.stderr.trim() || 'git rev-parse 失败'}`)
  }

  const originalHooksPath = resolve(root, hooks.stdout.replace(/\r?\n$/, ''))
  const hooksPath = mkdtempSync(join(tmpdir(), 'wtm-merge-hooks-'))
  try {
    const guardPath = join(hooksPath, 'wtm-merge-guard')
    const baseRef = `refs/heads/${expectedBase}`
    /** @param {string} value */
    const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`
    const expectedTree = quote(expectedMerge.expectedTree)
    const expectedBaseHead = quote(expectedMerge.expectedBaseHead)
    const expectedMergeHead = quote(expectedMerge.expectedMergeHead)
    /** @param {string} name */
    const originalHook = (name) => quote(join(originalHooksPath, name))
    const inheritedParameters = process.env.GIT_CONFIG_PARAMETERS ?? ''
    // Git appends command-line config to GIT_CONFIG_PARAMETERS for hook processes.
    // Restore the caller's value before chaining an original repository hook.
    const cleanConfig = `GIT_CONFIG_PARAMETERS=${quote(inheritedParameters)}`
    /** @param {string} name @param {string} body */
    const writeHook = (name, body) => {
      const hookPath = join(hooksPath, name)
      writeFileSync(hookPath, body, 'utf8')
      chmodSync(hookPath, 0o755)
    }

    writeHook('wtm-merge-guard', `#!/bin/sh
check_state() {
  state=$(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch) || {
    echo "wtm: unable to read base worktree state during merge" >&2
    return 1
  }
  branch=$(printf '%s\\n' "$state" | sed -n 's/^# branch.head //p')
  if [ "$branch" != "$WTM_EXPECTED_BASE" ]; then
    printf 'wtm: base branch changed during merge (expected %s, got %s)\\n' "$WTM_EXPECTED_BASE" "$branch" >&2
    return 1
  fi
  if printf '%s\\n' "$state" | awk '
    {
      kind = substr($0, 1, 1)
      worktree = substr($0, 4, 1)
      if (kind == "?" || ((kind == "1" || kind == "2" || kind == "u") && worktree != ".")) dirty = 1
    }
    END { exit dirty ? 0 : 1 }
  '; then
    echo 'wtm: base worktree became dirty during merge' >&2
    return 1
  fi
  if [ -n "$(GIT_OPTIONAL_LOCKS=0 git ls-files --others --exclude-standard)" ]; then
    echo 'wtm: base worktree gained an untracked file during merge' >&2
    return 1
  fi
}

proposed_commit=\${1:-}
expected_old=\${2:-}

expected_left=HEAD
if [ -n "$proposed_commit" ]; then
  parent_count=$(GIT_OPTIONAL_LOCKS=0 git cat-file -p "$proposed_commit" | awk '$1 == "parent" { count += 1 } END { print count + 0 }')
  if [ "$parent_count" -ne 2 ]; then
    echo 'wtm: proposed merge commit must have exactly two parents' >&2
    exit 1
  fi
  expected_left=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --verify "$proposed_commit^1") || {
    echo 'wtm: unable to read proposed merge commit parent' >&2
    exit 1
  }
  proposed_right=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --verify "$proposed_commit^2") || {
    echo 'wtm: proposed reference update is not a merge commit' >&2
    exit 1
  }
  if [ "$proposed_right" != ${expectedMergeHead} ]; then
    echo 'wtm: proposed merge commit does not use the expected merge target' >&2
    exit 1
  fi
  if [ -n "$expected_old" ] && [ "$expected_left" != "$expected_old" ]; then
    echo 'wtm: proposed merge commit does not update the expected base tip' >&2
    exit 1
  fi
fi

if [ -z "$proposed_commit" ]; then
  expected_left=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --verify "$expected_left^{commit}") || {
    echo 'wtm: unable to read expected base tip during merge' >&2
    exit 1
  }
fi
if [ "$expected_left" != ${expectedBaseHead} ]; then
  echo 'wtm: base tip changed during merge' >&2
  exit 1
fi

expected_tree=${expectedTree}

if [ -n "$proposed_commit" ]; then
  proposed_tree=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --verify "$proposed_commit^{tree}") || {
    echo 'wtm: unable to read proposed merge commit tree' >&2
    exit 1
  }
  if [ "$proposed_tree" != "$expected_tree" ]; then
    echo 'wtm: proposed merge commit tree differs from the guarded merge result' >&2
    exit 1
  fi
fi

# Keep the mutable index check separate from the proposed commit object check:
# a repository hook may change the index after Git has created the commit.
actual_tree=$(GIT_OPTIONAL_LOCKS=0 git write-tree) || {
  echo 'wtm: unable to read merge index during merge' >&2
  exit 1
}
if [ "$actual_tree" != "$expected_tree" ]; then
  echo 'wtm: base index became dirty during merge' >&2
  exit 1
fi

# Recheck after calculating the expected tree before returning to Git.
check_state || exit $?
actual_tree=$(GIT_OPTIONAL_LOCKS=0 git write-tree) || {
  echo 'wtm: unable to read merge index during merge' >&2
  exit 1
}
if [ "$actual_tree" != "$expected_tree" ]; then
  echo 'wtm: base index became dirty during merge' >&2
  exit 1
fi
if [ -z "$proposed_commit" ]; then
  if ! GIT_OPTIONAL_LOCKS=0 git diff-files --quiet; then
    echo 'wtm: base worktree became dirty during merge' >&2
    exit 1
  fi
fi
exit 0
`)

    // Git falls back to pre-commit when pre-merge-commit is absent.
    writeHook('pre-merge-commit', `#!/bin/sh
guard=${quote(guardPath)}
"$guard" "$@" || exit $?
hook=${originalHook('pre-merge-commit')}
if [ ! -x "$hook" ]; then hook=${originalHook('pre-commit')}; fi
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" || exit $?; fi
exit 0
`)

    writeHook('prepare-commit-msg', `#!/bin/sh
hook=${originalHook('prepare-commit-msg')}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" || exit $?; fi
exit 0
`)

    writeHook('commit-msg', `#!/bin/sh
hook=${originalHook('commit-msg')}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" || exit $?; fi
exit 0
`)

    writeHook('post-merge', `#!/bin/sh
hook=${originalHook('post-merge')}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" || exit $?; fi
exit 0
`)

    // reference-transaction receives its input on stdin. Forward that exact stream before the final check.
    writeHook('reference-transaction', `#!/bin/sh
input=$(mktemp "\${TMPDIR:-/tmp}/wtm-reference-transaction.XXXXXX") || {
  echo 'wtm: unable to create reference transaction input' >&2
  exit 1
}
cleanup() { rm -f "$input"; }
trap cleanup 0 HUP INT TERM
cat >"$input" || exit 1
hook=${originalHook('reference-transaction')}
if [ -x "$hook" ]; then ${cleanConfig} "$hook" "$@" <"$input" || exit $?; fi
if [ "$1" = prepared ]; then
  guard=${quote(guardPath)}
  if update=$(awk -v ref=${quote(baseRef)} '$3 == ref { print $1 " " $2; found = 1 } END { exit found ? 0 : 1 }' "$input"); then
    set -- $update
    "$guard" "$2" "$1" || exit $?
  elif awk '$NF == "HEAD" || substr($3, 1, 11) == "refs/heads/" { found = 1 } END { exit found ? 0 : 1 }' "$input"; then
    "$guard" || exit $?
    echo 'wtm: prepared merge transaction does not update the expected base ref' >&2
    exit 1
  fi
fi
exit 0
`)

    return { hooksPath }
  } catch (err) {
    rmSync(hooksPath, { recursive: true, force: true })
    throw err
  }
}
