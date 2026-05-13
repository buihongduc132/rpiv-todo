# rpiv-todo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Track tasks across long Pi Agent sessions with Claude-Code parity. `rpiv-todo` adds the `todo` tool, `/todos` slash command, and a persistent TodoOverlay widget above the editor to [Pi Agent](https://github.com/badlogic/pi-mono) — tasks survive session compact and `/reload` via branch replay.

## Features

- **`todo` tool** — full CRUD for tasks with 4-state lifecycle (pending → in_progress → completed, plus deleted)
- **`/todos` command** — print current task list grouped by status
- **TodoOverlay widget** — persistent TUI overlay above the editor, auto-renders when tasks exist
- **Branch replay persistence** — tasks survive session compact and `/reload`
- **Dependency tracking** — `blockedBy` with cycle detection
- **Smart overflow** — 12-line collapse threshold; completed tasks drop first, pending tasks truncate last
- **Auto-hide** — overlay disappears when the task list is empty

## Install

```bash
# In Pi settings.json packages array:
"https://github.com/buihongduc132/rpiv-todo"
```

Or from npm:

```bash
pi install npm:@juicesharp/rpiv-todo
```

Then restart your Pi session.

## Usage

### Tool: `todo`

Create, update, list, get, delete, or clear tasks. The 4-state machine:

```
pending → in_progress → completed
                      ↘ deleted (tombstone)
```

Supports `blockedBy` dependency tracking with cycle detection.

### Command: `/todos`

Print the current todo list grouped by status.

### Overlay Widget

The aboveEditor widget auto-renders whenever any non-deleted tasks exist. It:
- Collapses at 12 lines, dropping completed tasks first
- Truncates pending tasks last on overflow
- Auto-hides when the list is empty

## Development

```bash
npm install
npm test
```

## License

MIT © 2025 buihongduc132
