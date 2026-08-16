# worktree-mgr

[简体中文](README.zh.md)

A plugin that provides **task-isolated workspaces** for **dsh** (DeepSeek Harness, a plugin-based harness running on the Cordis plugin framework).

When a model processes multiple tasks in parallel, each task is completed in its own **git workspace** (git worktree) on its own branch, without polluting the main workspace; when the task ends, the plugin commits, merges, and cleans up automatically. The full lifecycle — **create / sync / overview / finish / batch cleanup** — is covered by 5 tools + 1 CLI, with zero manual git operations throughout.

## Core Concepts

| Concept | Description |
|------|------|
| Task | A single unit of work, e.g. `add-search-box`. Tools take the task name as entry point |
| Branch | Derived automatically from the task name: `<prefix>/<task-slug>`, default `wtm/add-search-box`, or explicitly specified |
| Workspace | Located under the vault directory (default platform data dir `wtm/vaults/<repo-slug>/`), isolated from the main repository |
| Ledger | `index.json` under the vault, persisting the "task ↔ branch ↔ path" mapping (JSON format, atomic writes + mutex lock) |
| Base branch | The branch a task merges into; defaults to the main workspace's current branch |

## Features

- **Task-driven**: give the model a task name and the branch name, path, and ledger record are all generated automatically — no need to specify a branch
- **Branch name safety**: task name → slug normalization (illegal forms such as `..` within a segment, `.lock` suffix, leading dots in a segment are fixed at the source), with dual ref-validity checks; creation is rejected when different tasks derive the same slug
- **Uncommitted change detection**: merge is refused when the base branch is dirty (prevents mixing in unfinished work); uncommitted changes in the task workspace trigger an automatic snapshot commit by default
- **Merge target consistency**: before merging, the plugin validates "main workspace current branch == ledger base branch" and "task workspace current branch == ledger task branch"; any mismatch is refused — eliminating the silent error of reporting success while changes land on the wrong branch
- **Sync and finish separated**: `wtm_merge` only merges without cleanup, while `wtm_finish` commits → merges → deletes workspace → deletes branch → clears the record; retry scenarios automatically skip already-completed merges (no duplicate empty merge commits)
- **Batch cleanup**: `wtm_purge` finishes multiple tasks at once; a single task failure does not interrupt the rest, and any failure yields a non-zero exit code
- **Repository-level configuration**: `<repo-root>/.wtm.json` supports branch prefixes, message templates, seed files (with path-escape protection), and lifecycle triggers (fixed working directory)
- **Concurrency safety**: ledger writes hold a mutex — the lock contains a unique token with heartbeat refresh, stale locks are reclaimed only after a process crash, and release never mistakenly deletes a successor's lock
- **Failure recovery**: a failed create rolls back the created worktree and branch automatically; merge conflicts provide a `git merge --abort` recovery guide
- **Cross-platform**: triggers execute on Windows (cmd) and POSIX (sh); path comparison normalizes case and separators
- **Zero dependencies, no build**: pure Node ESM, `node >= 21` is enough — install and use

## Installing in DSH

Install the latest version into a profile from GitHub:

```bash
dsh plugin --profile demo add github:JohnXu22786/worktree-mgr
```

Remove it:

```bash
dsh plugin --profile demo remove worktree-mgr
```

### Option 1: install as a dsh bundle (recommended)

From a directory containing this package:

```bash
dsh plugin --profile demo add ./worktree-mgr
```

- `package.json` declares `dsh.bundle.patch → cordis.patch.yml`, so dsh automatically inserts the plugin line into the profile's configuration layer;
- That layer defaults to `root: !!js process.cwd()` (the dsh startup directory as the main repository), overridable as needed;
- This package is pure JavaScript with no build step, so installing from git never misses build artifacts.

### Option 2: overlay loading (without installing into a profile)

```bash
dsh --profile demo --patch ./examples/overlay.yml
```

`overlay.yml` shares the same structure as the plugin line configuration, suitable for temporary mounting or configuration tweaks.

### Option 3: standalone CLI

```bash
npm link            # or node bin/wtm.js ...
wtm begin "Add Search Box"
```

## Quick Start

```bash
# 1. Create an isolated workspace for the task (auto-derives branch wtm/add-search-box)
wtm begin "Add Search Box"

# 2. Edit code freely inside <vault>/add-search-box
#    (or let the model work inside the task workspace directory)

# 3. View the status of all tasks (dirty/ahead/behind)
wtm status

# 4. Sync only, without finishing: merge task changes back to the base branch, keeping the workspace
wtm merge "Add Search Box"

# 5. Finish: snapshot commit → merge → remove workspace → delete branch → clear ledger
wtm finish "Add Search Box"

# 6. Batch finish
wtm purge "Task A" "Task B"      # specified tasks
wtm purge --all                  # all tasks
```

All commands support `--json` for structured output, making them easy to consume from scripts and the harness.

## Tool Interface (Model-Facing)

| Tool | Purpose | Key parameters |
|------|------|----------|
| `wtm_begin` | Create an isolated workspace for a task | `task`(required), `base`, `branch`, `note`, `root` |
| `wtm_merge` | Sync: merge task branch back to base branch (workspace kept) | `task`(required), `mode`(commit/refuse), `message`, `root` |
| `wtm_finish` | Finish: commit→merge→clean up workspace and branch | `task`(required), `mode`(commit/abandon/keep), `message`, `root` |
| `wtm_status` | Task overview (existence/dirty state/ahead-behind) | `root` |
| `wtm_purge` | Batch finish | `tasks`, `all`, `mode`, `message`, `root` |

**`mode` semantics**

- `commit` (default): first snapshot-commit the uncommitted changes in the task workspace, then merge back to the base branch, then clean up
- `refuse`: refuse directly when the task workspace has uncommitted changes (only `wtm_merge`)
- `abandon`: discard all task changes, force-clean the workspace and delete the branch (irrecoverable, use with care)
- `keep`: only release management; workspace and branch remain untouched (only `wtm_finish`)

**Safety boundaries** (identical for tools and CLI):

- Base branch workspace has uncommitted changes → merge refused (`wtm_merge` / `wtm_finish` in commit mode)
- Main workspace current branch ≠ ledger base branch, or task workspace current branch ≠ ledger record → operation refused (prevents changes landing on the wrong branch)
- Task branch already exists, task already registered, workspace directory already exists, or different tasks deriving the same workspace path → creation refused
- Illegal task or branch name (git ref rules) → refused before any git operation
- Seed file path escapes (`../x` escaping the repo/workspace) → intercepted with a warning
- Call cancelled (`exec.signal` abort) → clean return; a failed create rolls back created worktrees and branches automatically

## Plugin Integration Notes (how the harness loads it)

This plugin follows dsh's standard plugin protocol, consisting of three pieces:

```
worktree-mgr/
├── package.json        # ① dsh.bundle manifest: declares this package as a configuration layer
├── cordis.patch.yml    # ② Configuration layer content: inserts the plugin line into the profile
├── index.js            # ③ Entry module: exports name / inject / apply
└── src/                # Implementation: naming/config/vault/git/triggers/ops/tools
```

**① Bundle manifest** (`package.json`):

```json
{
  "name": "worktree-mgr",
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**② Configuration layer** (`cordis.patch.yml`):

```yaml
- insert:
    - id: worktree-mgr
      name: worktree-mgr        # resolved by package name; Node module resolution finds index.js
      config:
        root: !!js process.cwd()
```

**③ Entry module** (`index.js`) exports:

```js
export const name = 'worktree-mgr'
export const inject = ['tools']              // declares dependency on the tools registry
export function apply(ctx, config = {}) {
  ctx.tools.register(...)                    // registers the 5 tools
}
```

Loading order: profile assembly → this bundle's patch layer inserts the plugin line → the loader waits for the `tools` service → calls `apply(ctx, config)` → tool schemas flow into the system prompt automatically, and the model can invoke them.

**Tool definition shape** (consistent with dsh tool conventions):

```js
{
  name: 'wtm_status',
  description: '...',                        // model-visible description
  parameters: {                              // flat property table; required: true means mandatory
    root: { type: 'string', description: 'repository path' }
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean', required: true }, ... } },
    render: (args, value) => [{ type: 'text', text: '...' }]   // model-visible content
  },
  async execute(args, exec) { ... }          // returns canonical JSON; exec.signal supports cancellation
}
```

**Events/hooks interface**: the plugin itself does not subscribe to harness events; lifecycle extensions go through **triggers** in the repository-level configuration — at the `on_begin` / `on_merge` / `on_finish` nodes, repo-configured shell commands run with `WTM_TASK` / `WTM_BRANCH` / `WTM_BASE` / `WTM_PATH` / `WTM_ROOT` environment variables injected. Triggers have fixed working directories: `on_begin` runs inside the new workspace, `on_merge` / `on_finish` run at the main repository root. Trigger failures only log warnings and never interrupt the main flow.

## Configuration

Precedence (low → high): **built-in defaults < plugin line config < repo `.wtm.json` < environment variables `WTM_*`**

| Key | Default | Description |
|----|------|------|
| `root` | `process.cwd()` | Main repository path (plugin line / tool parameter only) |
| `vault` | platform data dir `wtm/vaults/<repo-slug>/` | Directory for task workspaces and the ledger; relative paths resolve against the repo path |
| `prefix` | `wtm` | Branch prefix; derived branches are `<prefix>/<slug>` |
| `commitMessage` | `chore(wtm): snapshot {task}` | Snapshot commit template, placeholders `{task}` `{branch}` `{base}` |
| `mergeMessage` | `merge(wtm): fold {task} into {base}` | Merge commit template |

Environment variables: `WTM_ROOT` (effective for both tools and CLI), `WTM_VAULT`, `WTM_PREFIX`, `WTM_COMMIT_MESSAGE`, `WTM_MERGE_MESSAGE` (`WTM_ROOT` has lower precedence than tool parameters and plugin config).

### Repository-level config `<repo-root>/.wtm.json`

```json
{
  "prefix": "wtm",
  "vault": "D:/wtm-vaults",
  "commitMessage": "chore(wtm): snapshot {task}",
  "mergeMessage": "merge(wtm): fold {task} into {base}",
  "seed": { "files": ["docs/AGENTS.md"] },
  "triggers": {
    "on_begin": ["pnpm install"],
    "on_merge": ["pnpm lint"],
    "on_finish": []
  }
}
```

- `vault` **must be outside the repository working tree** (otherwise the vault directory would keep dirtying the main workspace, and the plugin refuses outright);
- `seed.files`: files copied from the main repository into the workspace when the task workspace is created (e.g. team convention docs); paths must stay within the repo/workspace — out-of-bounds entries are intercepted with a warning;
- `triggers.*`: lifecycle hook command arrays, see "Events/hooks interface" above.

Unknown keys produce a warning and are ignored; a corrupted `.wtm.json` never blocks operations, only warns.

## Security Notes (Important)

- **Repository config is code**: `.wtm.json`'s `seed.files` copies files from the repo into workspaces, and `triggers.*` runs arbitrary shell commands with your user's privileges. **Only enable this plugin in trusted repositories** — when cloning and operating on untrusted repositories, a repo-supplied `.wtm.json` is equivalent to granting it your execution permissions. Leave `seed`/`triggers` empty when you don't need this capability.
- **Snapshot commits include untracked files**: when the task workspace is dirty, the default snapshot `git add -A` commits everything (including untracked files such as build artifacts). To keep large directories out of history, maintain a `.gitignore` in the task workspace, or handle it manually with `refuse` mode.
- **abandon is irrecoverable**: `wtm_finish --mode abandon` and batch `wtm_purge` force-delete workspaces and delete task branches (`-D`); changes there cannot be recovered, so only use them when you have confirmed the discard.

## Ledger and Concurrency

- Ledger: `<vault>/index.json`, `{version: 1, records: [{task, branch, base, path, createdAt, updatedAt, note?}]}`
- Writes are atomic (temp file + rename) and hold a `.lock` mutex for the entire operation;
- The lock contains a unique holder token with a 30s heartbeat refresh: after a process crash, a lock older than 5 minutes is deemed stale and reclaimed; release validates the token so a successor's lock is never mistakenly deleted; the wait timeout defaults to 5 seconds.

## Development and Testing

```bash
npm test          # node --test, zero third-party dependencies
npm run typecheck # optional: requires dev-installed typescript + @types/node
```

Test coverage: naming rules, config merging, ledger (atomic writes/lock/stale reclamation/corruption recovery), git output parsing, triggers, lifecycle orchestration (fake git injection), tool schemas, plus integration tests against real git (full begin → modify files → status → finish chain).

## Directory Structure

```
worktree-mgr/
├── package.json          # bundle manifest + metadata
├── cordis.patch.yml      # plugin configuration layer
├── index.js              # dsh plugin entry (name/inject/apply)
├── bin/wtm.js            # standalone CLI
├── src/
│   ├── naming.js         # task name → branch mapping and ref validation
│   ├── config.js         # config merging and template rendering
│   ├── vault.js          # ledger persistence (atomic writes/lock)
│   ├── git.js            # git execution layer and output parsing
│   ├── triggers.js       # lifecycle triggers
│   ├── ops.js            # lifecycle orchestration (begin/merge/finish/status/purge)
│   └── tools.js          # dsh tool definitions
├── examples/
│   ├── .wtm.json.example # repository config example
│   └── overlay.yml       # dsh overlay example
└── tests/                # node:test unit + integration tests
```

## License

MIT — see [LICENSE](LICENSE).
