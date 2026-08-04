/**
 * todo.test.ts — Baseline + RED stale-ctx tests for rpiv-todo
 *
 * Phase 1 (baseline): Pure reducer, state machine, cycle detection,
 *   session isolation, reconstructTodoState.
 * Phase 2 (RED): Stale-ctx tests that MUST FAIL until the
 *   stale-ctx fix lands (GREEN phase).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerExtension from "./index.js";
import {
	__resetState,
	activateSession,
	applyTaskMutation,
	detectCycle,
	deriveBlocks,
	getActiveSessionId,
	getNextId,
	getTodos,
	isTransitionValid,
	reconstructTodoState,
	type Task,
	type TaskAction,
	type TaskStatus,
} from "./todo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BranchEntry = {
	type: string;
	message: {
		role?: string;
		content?: unknown;
		toolName?: string;
		details?: unknown;
		customType?: string;
	};
};

function createCtx(
	sessionFile: string = "session-1",
	branch: BranchEntry[] = [],
) {
	let sessionManagerAccessCount = 0;

	const ctx = {
		cwd: "/tmp/test",
		hasUI: true,
		sessionManager: {
			getSessionFile: () => {
				sessionManagerAccessCount++;
				return sessionFile;
			},
			getBranch: () => {
				sessionManagerAccessCount++;
				return branch;
			},
		},
		ui: { notify: vi.fn() },
	};

	return {
		ctx,
		/** How many times ctx.sessionManager getters were called. */
		get accessCount() {
			return sessionManagerAccessCount;
		},
		/** Reset access counter. */
		resetAccessCount() {
			sessionManagerAccessCount = 0;
		},
	};
}

function makeBranchWithTodos(
	tasks: Array<{ id: number; subject: string; status: TaskStatus }>,
	nextId: number,
): BranchEntry[] {
	return [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "create",
					params: {},
					tasks,
					nextId,
				},
			},
		},
	];
}

const emptyState = { tasks: [] as Task[], nextId: 1 };

// ---------------------------------------------------------------------------
// Phase 1: Baseline tests
// ---------------------------------------------------------------------------

describe("state machine transitions", () => {
	it.each([
		["pending", "in_progress"],
		["pending", "completed"],
		["pending", "deleted"],
		["in_progress", "pending"],
		["in_progress", "completed"],
		["in_progress", "deleted"],
		["completed", "deleted"],
	] as [TaskStatus, TaskStatus][])(
		"allows %s → %s",
		(from, to) => {
			expect(isTransitionValid(from, to)).toBe(true);
		},
	);

	it.each([
		["completed", "pending"],
		["completed", "in_progress"],
		["deleted", "pending"],
		["deleted", "in_progress"],
		["deleted", "completed"],
	] as [TaskStatus, TaskStatus][])(
		"rejects %s → %s",
		(from, to) => {
			expect(isTransitionValid(from, to)).toBe(false);
		},
	);

	it("allows identity transition (pending → pending)", () => {
		expect(isTransitionValid("pending", "pending")).toBe(true);
	});
});

describe("applyTaskMutation — create", () => {
	beforeEach(() => {
		__resetState("__all__");
		activateSession("test-session");
	});

	it("creates a task with subject", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"create",
			{ subject: "Write tests" },
		);
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toMatchObject({
			id: 1,
			subject: "Write tests",
			status: "pending",
		});
		expect(result.state.nextId).toBe(2);
		expect(result.content[0].text).toContain("Created #1");
	});

	it("rejects create without subject", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"create",
			{ subject: "" },
		);
		expect(result.details.error).toContain("subject required");
	});

	it("creates with optional fields", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"create",
			{
				subject: "Task",
				description: "desc",
				activeForm: "working",
				owner: "alice",
				metadata: { key: "val" },
				blockedBy: [],
			},
		);
		const task = result.state.tasks[0];
		expect(task.description).toBe("desc");
		expect(task.activeForm).toBe("working");
		expect(task.owner).toBe("alice");
		expect(task.metadata).toEqual({ key: "val" });
	});

	it("rejects create with non-existent blockedBy", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"create",
			{ subject: "Task", blockedBy: [99] },
		);
		expect(result.details.error).toContain("#99 not found");
	});
});

describe("applyTaskMutation — update", () => {
	it("updates subject", () => {
		const state = {
			tasks: [{ id: 1, subject: "Old", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			subject: "New",
		});
		expect(result.state.tasks[0].subject).toBe("New");
	});

	it("rejects illegal status transition", () => {
		const state = {
			tasks: [{ id: 1, subject: "Done", status: "completed" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			status: "pending",
		});
		expect(result.details.error).toContain("illegal transition");
	});

	it("rejects update without id", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"update",
			{ subject: "X" },
		);
		expect(result.details.error).toContain("id required");
	});

	it("rejects update with no mutable fields", () => {
		const state = {
			tasks: [{ id: 1, subject: "T", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", { id: 1 });
		expect(result.details.error).toContain("at least one mutable field");
	});

	it("addBlockedBy / removeBlockedBy", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{ id: 2, subject: "B", status: "pending" as TaskStatus },
			],
			nextId: 3,
		};
		// Add dep to task 2 (task 2 now blocked by task 1)
		const r1 = applyTaskMutation(state, "update", {
			id: 2,
			addBlockedBy: [1],
		});
		const task2r1 = r1.state.tasks.find((t) => t.id === 2)!;
		expect(task2r1.blockedBy).toEqual([1]);

		// Remove dep from task 2
		const r2 = applyTaskMutation(r1.state, "update", {
			id: 2,
			removeBlockedBy: [1],
		});
		const task2r2 = r2.state.tasks.find((t) => t.id === 2)!;
		expect(task2r2.blockedBy).toBeUndefined();
	});

	it("rejects self-block", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			addBlockedBy: [1],
		});
		expect(result.details.error).toContain("cannot block #1 on itself");
	});

	it("merges metadata (null deletes key)", () => {
		const state = {
			tasks: [
				{
					id: 1,
					subject: "A",
					status: "pending" as TaskStatus,
					metadata: { a: 1, b: 2 },
				},
			],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			metadata: { b: null, c: 3 },
		});
		expect(result.state.tasks[0].metadata).toEqual({ a: 1, c: 3 });
	});
});

describe("applyTaskMutation — list", () => {
	it("lists non-deleted tasks", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{ id: 2, subject: "B", status: "deleted" as TaskStatus },
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "list", {});
		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).not.toContain("#2");
	});

	it("lists with status filter", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{ id: 2, subject: "B", status: "in_progress" as TaskStatus },
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "list", {
			status: "in_progress",
		});
		expect(result.content[0].text).toContain("#2");
		expect(result.content[0].text).not.toContain("#1");
	});

	it("shows empty message when no tasks", () => {
		const result = applyTaskMutation(
			{ tasks: [], nextId: 1 },
			"list",
			{},
		);
		expect(result.content[0].text).toBe("No tasks");
	});
});

describe("applyTaskMutation — get", () => {
	it("returns task details with blocks", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{
					id: 2,
					subject: "B",
					status: "pending" as TaskStatus,
					blockedBy: [1],
				},
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.content[0].text).toContain("#1");
		expect(result.content[0].text).toContain("blocks: #2");
	});

	it("returns not found for missing id", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"get",
			{ id: 99 },
		);
		expect(result.details.error).toContain("#99 not found");
	});
});

describe("applyTaskMutation — delete", () => {
	it("soft-deletes a task", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.state.tasks[0].status).toBe("deleted");
		expect(result.content[0].text).toContain("Deleted #1");
	});

	it("rejects double delete", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "deleted" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.details.error).toContain("already deleted");
	});
});

describe("applyTaskMutation — clear", () => {
	it("clears all tasks", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{ id: 2, subject: "B", status: "completed" as TaskStatus },
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "clear", {});
		expect(result.state.tasks).toEqual([]);
		expect(result.state.nextId).toBe(1);
		expect(result.content[0].text).toContain("Cleared 2 tasks");
	});
});

describe("detectCycle", () => {
	it("detects simple cycle", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus, blockedBy: [2] },
			{ id: 2, subject: "B", status: "pending" as TaskStatus, blockedBy: [1] },
		];
		expect(detectCycle(tasks, 1, [2])).toBe(true);
	});

	it("no cycle for independent tasks", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus },
			{ id: 2, subject: "B", status: "pending" as TaskStatus },
		];
		expect(detectCycle(tasks, 1, [2])).toBe(false);
	});

	it("detects indirect cycle", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus, blockedBy: [3] },
			{ id: 2, subject: "B", status: "pending" as TaskStatus, blockedBy: [1] },
			{ id: 3, subject: "C", status: "pending" as TaskStatus, blockedBy: [2] },
		];
		expect(detectCycle(tasks, 3, [1])).toBe(true);
	});
});

describe("deriveBlocks", () => {
	it("computes reverse dependency map", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus },
			{
				id: 2,
				subject: "B",
				status: "pending" as TaskStatus,
				blockedBy: [1],
			},
			{
				id: 3,
				subject: "C",
				status: "pending" as TaskStatus,
				blockedBy: [1],
			},
		];
		const blocks = deriveBlocks(tasks);
		expect(blocks.get(1)).toEqual([2, 3]);
		expect(blocks.has(2)).toBe(false);
	});
});

describe("session management", () => {
	beforeEach(() => {
		__resetState("__all__");
	});

	it("activateSession sets active ID", () => {
		activateSession("s1");
		expect(getActiveSessionId()).toBe("s1");
	});

	it("getTodos/getNextId use active session", () => {
		activateSession("s1");
		const result = applyTaskMutation(
			{ tasks: [], nextId: 1 },
			"create",
			{ subject: "Task" },
		);
		expect(result.state.tasks).toHaveLength(1);
	});

	it("sessions are isolated", () => {
		activateSession("s1");
		// Use reconstructTodoState to populate s1 via branch replay
		const ctx = {
			sessionManager: {
				getSessionFile: () => "s1",
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "todo",
							details: {
								action: "create",
								params: {},
								tasks: [{ id: 1, subject: "S1 Task", status: "pending" }],
								nextId: 2,
							},
						},
					},
				],
			},
		};
		reconstructTodoState(ctx);
		activateSession("s1");
		expect(getTodos()).toHaveLength(1);

		activateSession("s2");
		// s2 has no tasks yet
		expect(getTodos()).toEqual([]);

		activateSession("s1");
		// s1 still has its task
		expect(getTodos()).toHaveLength(1);
	});

	it("__resetState clears specific session", () => {
		activateSession("s1");
		applyTaskMutation({ tasks: [], nextId: 1 }, "create", {
			subject: "Task",
		});
		__resetState("s1");
		expect(getTodos()).toEqual([]);
	});
});

describe("reconstructTodoState", () => {
	beforeEach(() => {
		__resetState("__all__");
	});

	it("restores tasks from branch entries", () => {
		activateSession("ephemeral");
		const { ctx } = createCtx(
			"session-1",
			makeBranchWithTodos(
				[
					{ id: 1, subject: "Ship", status: "in_progress" },
					{ id: 2, subject: "Test", status: "pending" },
				],
				3,
			),
		);
		reconstructTodoState(ctx);
		activateSession("session-1");
		expect(getTodos()).toHaveLength(2);
		expect(getNextId()).toBe(3);
	});

	it("uses last valid snapshot (branch replay)", () => {
		activateSession("ephemeral");
		const { ctx } = createCtx("session-1", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						action: "create",
						params: {},
						tasks: [{ id: 1, subject: "First", status: "pending" }],
						nextId: 2,
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						action: "create",
						params: {},
						tasks: [
							{ id: 1, subject: "First", status: "completed" },
							{ id: 2, subject: "Second", status: "in_progress" },
						],
						nextId: 3,
					},
				},
			},
		]);
		reconstructTodoState(ctx);
		activateSession("session-1");
		expect(getTodos()).toHaveLength(2);
		expect(getTodos()[0].status).toBe("completed");
	});

	it("defaults to ephemeral when sessionFile is null", () => {
		activateSession("ephemeral");
		const { ctx } = createCtx(null as any, []);
		reconstructTodoState(ctx);
		expect(getActiveSessionId()).toBe("ephemeral");
	});

	it("ignores non-todo toolResults", () => {
		activateSession("ephemeral");
		const { ctx } = createCtx("session-1", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					details: { exitCode: 0 },
				},
			},
		]);
		reconstructTodoState(ctx);
		activateSession("session-1");
		expect(getTodos()).toEqual([]);
	});

	it("ignores malformed details", () => {
		activateSession("ephemeral");
		const { ctx } = createCtx("session-1", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { garbage: true },
				},
			},
		]);
		reconstructTodoState(ctx);
		activateSession("session-1");
		expect(getTodos()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: RED — Stale-ctx tests
//
// These tests MUST FAIL in the RED phase. They verify that
// reconstructTodoState does NOT access ctx.sessionManager after the
// initial capture (i.e., session ID + branch are cached, not re-read).
//
// The current implementation directly calls
// ctx.sessionManager.getSessionFile() and ctx.sessionManager.getBranch()
// inside reconstructTodoState — which is the stale-ctx bug.
//
// After the GREEN fix, these should pass because the session ID and
// branch data will be cached during session_start and not re-read
// from a potentially stale ctx.
// ---------------------------------------------------------------------------

describe("isTaskDetails type guard", () => {
	it("accepts valid TaskDetails", () => {
		// isTaskDetails is not exported but tested indirectly via reconstructTodoState
		// Here we verify it rejects invalid input via reconstruct behavior
		activateSession("ephemeral");
		const { ctx } = createCtx("session-1", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { tasks: [], nextId: 1 },
				},
			},
		]);
		reconstructTodoState(ctx);
		activateSession("session-1");
		// Empty tasks snapshot is still valid
		expect(getTodos()).toEqual([]);
		expect(getNextId()).toBe(1);
	});
});

describe("applyTaskMutation — edge cases", () => {
	it("create with blockedBy referencing deleted task", () => {
		const state = {
			tasks: [{ id: 1, subject: "Gone", status: "deleted" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "create", {
			subject: "New",
			blockedBy: [1],
		});
		expect(result.details.error).toContain("#1 is deleted");
	});

	it("update with description and activeForm", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "in_progress" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			description: "updated",
			activeForm: "updating",
		});
		expect(result.state.tasks[0].description).toBe("updated");
		expect(result.state.tasks[0].activeForm).toBe("updating");
	});

	it("update status transition with content message", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 1,
			status: "in_progress",
		});
		expect(result.content[0].text).toContain("pending → in_progress");
	});

	it("update not found for missing id", () => {
		const state = {
			tasks: [{ id: 1, subject: "A", status: "pending" as TaskStatus }],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "update", {
			id: 99,
			subject: "X",
		});
		expect(result.details.error).toContain("#99 not found");
	});

	it("delete not found for missing id", () => {
		const result = applyTaskMutation(
			{ ...emptyState },
			"delete",
			{ id: 99 },
		);
		expect(result.details.error).toContain("#99 not found");
	});

	it("list includes blockedBy glyph", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{
					id: 2,
					subject: "B",
					status: "pending" as TaskStatus,
					blockedBy: [1],
				},
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "list", {});
		expect(result.content[0].text).toContain("⛓");
	});

	it("list includes activeForm for in_progress", () => {
		const state = {
			tasks: [
				{
					id: 1,
					subject: "A",
					status: "in_progress" as TaskStatus,
					activeForm: "testing",
				},
			],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "list", {});
		expect(result.content[0].text).toContain("testing");
	});

	it("get with description and activeForm", () => {
		const state = {
			tasks: [
				{
					id: 1,
					subject: "A",
					status: "in_progress" as TaskStatus,
					description: "desc",
					activeForm: "working",
					owner: "alice",
				},
			],
			nextId: 2,
		};
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.content[0].text).toContain("description:");
		expect(result.content[0].text).toContain("activeForm:");
		expect(result.content[0].text).toContain("owner:");
	});

	it("list with includeDeleted shows deleted tasks", () => {
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as TaskStatus },
				{ id: 2, subject: "B", status: "deleted" as TaskStatus },
			],
			nextId: 3,
		};
		const result = applyTaskMutation(state, "list", { includeDeleted: true });
		expect(result.content[0].text).toContain("#2");
	});
});

describe("detectCycle — edge cases", () => {
	it("no cycle with empty blockedBy", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus },
		];
		expect(detectCycle(tasks, 1, [])).toBe(false);
	});

	it("detects self-cycle", () => {
		const tasks = [
			{ id: 1, subject: "A", status: "pending" as TaskStatus },
		];
		expect(detectCycle(tasks, 1, [1])).toBe(true);
	});
});

describe("[REGRESSION] stale-ctx: reconstructTodoState caches session data", () => {
	beforeEach(() => {
		__resetState("__all__");
	});

	it("caches sessionId — second call with stale ctx does not re-read sessionManager", () => {
		// Simulate: session_start captures the session ID once.
		// After that, reconstructTodoState should NOT call
		// ctx.sessionManager again (it may be stale).
		const { ctx, accessCount, resetAccessCount } = createCtx(
			"session-1",
			makeBranchWithTodos(
				[{ id: 1, subject: "A", status: "pending" }],
				2,
			),
		);

		// First call — captures session data (allowed to access ctx)
		resetAccessCount();
		reconstructTodoState(ctx);
		const firstCaptureAccess = accessCount;

		// Now simulate ctx going stale: make sessionManager throw
		const staleCtx = {
			...ctx,
			sessionManager: {
				getSessionFile: () => {
					throw new Error("stale ctx: sessionManager is no longer valid");
				},
				getBranch: () => {
					throw new Error("stale ctx: sessionManager is no longer valid");
				},
			},
		};

		// Second call with stale ctx — should NOT throw
		// because it should use cached data, NOT re-read ctx
		expect(() => {
			reconstructTodoState(staleCtx);
		}).not.toThrow();
	});

	it("caches branch data — second call with stale ctx does not re-read getBranch", () => {
		// The branch data should be cached so that calling
		// reconstructTodoState with a STALE ctx doesn't crash
		let branchAccessCount = 0;
		const freshCtx = {
			cwd: "/tmp/test",
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-1",
				getBranch: () => {
					branchAccessCount++;
					return makeBranchWithTodos(
						[{ id: 1, subject: "A", status: "pending" }],
						2,
					);
				},
			},
			ui: { notify: vi.fn() },
		};

		// First call — captures branch data
		reconstructTodoState(freshCtx);

		// Now simulate stale ctx (getBranch throws)
		const staleCtx = {
			cwd: "/tmp/test",
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-1",
				getBranch: () => {
					throw new Error("stale ctx: branch is no longer valid");
				},
			},
			ui: { notify: vi.fn() },
		};

		// Second call with stale ctx — should NOT throw
		// because branch should be cached, not re-read
		expect(() => {
			reconstructTodoState(staleCtx);
		}).not.toThrow();
	});

	it("returns safe defaults when no session has been captured", () => {
		// Before any reconstructTodoState call, the active session
		// should be a safe default
		__resetState("__all__");
		const sessionId = getActiveSessionId();
		expect(typeof sessionId).toBe("string");
		expect(sessionId.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: RED — Cross-session cache leak on /new
//
// Bug: module-level cachedSessionId/cachedBranch are set ONCE on first
// reconstructTodoState call and never cleared by session_shutdown.
// When pi-core creates a fresh session (/new), the extension module
// persists → cachedSessionId pins the OLD session → new session
// inherits OLD todos.
// ---------------------------------------------------------------------------

describe("[REGRESSION] cross-session leak: /new must clear todos", () => {
	beforeEach(() => {
		__resetState("__all__");
	});

	it("clears todos when a new session starts after shutdown", async () => {
		// Build minimal fake ExtensionAPI — capture lifecycle handlers
		const handlers = new Map<string, (...args: any[]) => Promise<void>>();
		const fakePi = {
			on: vi.fn((event: string, handler: (...args: any[]) => Promise<void>) => {
				handlers.set(event, handler);
			}),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
		} as any;

		// Register the extension (simulates pi loading the extension at startup)
		registerExtension(fakePi);

		// Verify lifecycle handlers were registered
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);

		const sessionStartHandler = handlers.get("session_start")!;
		const sessionShutdownHandler = handlers.get("session_shutdown")!;

		// --- Session A: has 2 todos ---
		const ctxA = {
			cwd: "/tmp/test",
			hasUI: false,
			sessionManager: {
				getSessionFile: () => "session-A",
				getBranch: () =>
					makeBranchWithTodos(
						[
							{ id: 1, subject: "Task A", status: "pending" as TaskStatus },
							{ id: 2, subject: "Task B", status: "pending" as TaskStatus },
						],
						3,
					),
			},
			ui: { notify: vi.fn() },
		};

		await sessionStartHandler({}, ctxA);

		// Session A should have 2 todos — verifies setup is correct
		expect(getActiveSessionId()).toBe("session-A");
		expect(getTodos()).toHaveLength(2);

		// --- Shutdown (simulates /new — pi-core tears down session) ---
		await sessionShutdownHandler({});

		// --- Session B: fresh session, empty branch ---
		const ctxB = {
			cwd: "/tmp/test",
			hasUI: false,
			sessionManager: {
				getSessionFile: () => "session-B",
				getBranch: () => [],
			},
			ui: { notify: vi.fn() },
		};

		await sessionStartHandler({}, ctxB);

		// BUG: session_shutdown did NOT call __resetState(), so:
		// - cachedSessionId is still "session-A" (never re-read from ctx)
		// - cachedBranch is still session-A's branch (never re-read from ctx)
		// - activeSessionId is set to cachedSessionId = "session-A"
		// - session-A's state (2 tasks) is replayed from the stale cache
		//
		// After the fix, session_shutdown should clear the cache so that
		// session_start for session-B reads fresh ctx and starts clean.
		expect(getActiveSessionId()).toBe("session-B");
		expect(getTodos()).toHaveLength(0);
	});
});
