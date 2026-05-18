# rpiv-todo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/rpiv-todo.svg)](https://www.npmjs.com/package/rpiv-todo)
[![GitHub](https://img.shields.io/badge/GitHub-buihongduc132%2Frpiv--todo-181717?logo=github)](https://github.com/buihongduc132/rpiv-todo)

Task overlay extension for [Pi Agent](https://github.com/badlogic/pi-mono) — visual task tracking in the TUI with persistent overlay widget, priority management, and Claude-Code parity.

## Features

- **`todo` tool** — full CRUD for tasks with 4-state lifecycle (`pending` → `in_progress` → `completed`, plus `deleted`)
- **`/todos` command** — print current task list grouped by status
- **TodoOverlay widget** — persistent TUI overlay above the editor, auto-renders when tasks exist
- **Branch replay persistence** — tasks survive session compact and `/reload` via branch replay
- **Dependency tracking** — `blockedBy` with cycle detection
- **Priority management** — assign and filter tasks by priority
- **Smart overflow** — 12-line collapse threshold; completed tasks drop first, pending tasks truncate last
- **Auto-hide** — overlay disappears when the task list is empty

## Installation

### For Humans

```bash
pi install npm:rpiv-todo
```

Then restart your Pi session.

### For AI Agents

Add to your `settings.json` packages array:

```json
{
  "packages": [
    "npm:rpiv-todo"
  ]
}
```

Agent prompt reference: [AGENTS.md](https://github.com/buihongduc132/rpiv-todo/blob/main/AGENTS.md)

### For Pi git-sourced

Add the git URL to your `settings.json` packages array:

```json
{
  "packages": [
    "https://github.com/buihongduc132/rpiv-todo"
  ]
}
```

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
