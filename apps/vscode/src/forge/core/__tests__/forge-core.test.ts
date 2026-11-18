import { describe, it, expect, beforeEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	detectEol,
	normalizeToLf,
	restoreEol,
	normalizePath,
} from "../eol";
import { resolveSafePath } from "../path-safety";
import { computeHunks, applyHunks } from "../hunks";
import {
	applyEdits,
	computeProposalHash,
	createEditProposal,
	createWriteProposal,
} from "../proposals";
import { ReviewBroker } from "../broker";
import { ChangeLog } from "../change-log";
import { EventIndex } from "../event-index";

describe("forge/core - EOL handling", () => {
	it("detects CRLF and LF correctly", () => {
		expect(detectEol("line 1\r\nline 2\r\n")).toBe("\r\n");
		expect(detectEol("line 1\nline 2\n")).toBe("\n");
		expect(detectEol("single line without newline")).toBe("\n");
	});

	it("normalizes CRLF to LF", () => {
		const crlf = "foo\r\nbar\r\nbaz";
		expect(normalizeToLf(crlf)).toBe("foo\nbar\nbaz");
	});

	it("restores original EOL on round-trip", () => {
		const originalCrlf = "a\r\nb\r\nc";
		const lf = normalizeToLf(originalCrlf);
		expect(lf).toBe("a\nb\nc");
		const restored = restoreEol(lf, "\r\n");
		expect(restored).toBe(originalCrlf);
	});

	it("normalizes paths to forward slashes without leading ./", () => {
		expect(normalizePath("src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
		expect(normalizePath("./src/foo/bar.ts")).toBe("src/foo/bar.ts");
		expect(normalizePath(".\\src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
	});
});

describe("forge/core - Path Safety", () => {
	const tempDir = path.join(os.tmpdir(), `forge-path-test-${Date.now()}`);

	beforeEach(() => {
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
	});

	it("accepts valid relative paths inside root", () => {
		const result = resolveSafePath(tempDir, "src/index.ts");
		expect(result.safe).toBe(true);
		expect(result.relativePath).toBe("src/index.ts");
		expect(result.resolvedPath).toBe(path.resolve(tempDir, "src/index.ts"));
	});

	it("rejects path traversal attempting to escape root", () => {
		const result = resolveSafePath(tempDir, "../outside.txt");
		expect(result.safe).toBe(false);
		expect(result.error).toContain("escape root");
	});

	it("rejects complex traversal patterns like foo/../../bar", () => {
		const result = resolveSafePath(tempDir, "sub/../../escape.txt");
		expect(result.safe).toBe(false);
	});

	it("rejects empty root or empty path", () => {
		expect(resolveSafePath("", "foo.txt").safe).toBe(false);
		expect(resolveSafePath(tempDir, "").safe).toBe(false);
	});
});

describe("forge/core - Hunks (Compute and Arbitrary Subset Application)", () => {
	it("computes hunks accurately for modifications, inserts, and deletes", () => {
		const oldText = "line 1\nline 2\nline 3\nline 4\nline 5\n";
		const newText = "line 1\nline 2 modified\nline 3\nline 4\nline 5\nline 6\n";

		const hunks = computeHunks(oldText, newText);
		expect(hunks.length).toBe(2);
		expect(hunks[0].type).toBe("modify");
		expect(hunks[0].oldContent).toBe("line 2\n");
		expect(hunks[0].newContent).toBe("line 2 modified\n");
		expect(hunks[1].type).toBe("insert");
		expect(hunks[1].newContent).toBe("line 6\n");
	});

	it("returns empty hunks when text is unchanged", () => {
		expect(computeHunks("hello\nworld", "hello\nworld")).toEqual([]);
	});

	it("applies ALL hunks when all are accepted", () => {
		const oldText = "A\nB\nC\nD\nE";
		const newText = "A\nB-new\nC\nD-new\nE";
		const hunks = computeHunks(oldText, newText);
		expect(hunks.length).toBe(2);

		const allAccepted = [hunks[0].id, hunks[1].id];
		const result = applyHunks(oldText, hunks, allAccepted);
		expect(result).toBe(newText);
	});

	it("applies NO hunks when all are rejected", () => {
		const oldText = "A\nB\nC\nD\nE";
		const newText = "A\nB-new\nC\nD-new\nE";
		const hunks = computeHunks(oldText, newText);

		const result = applyHunks(oldText, hunks, []);
		expect(result).toBe(oldText);
	});

	it("applies ANY arbitrary subset of hunks (accept hunk 0, reject hunk 1)", () => {
		const oldText = "A\nB\nC\nD\nE";
		const newText = "A\nB-new\nC\nD-new\nE";
		const hunks = computeHunks(oldText, newText);

		// Accept ONLY the first hunk (B -> B-new), reject second (D stays D)
		const subset = [hunks[0].id];
		const result = applyHunks(oldText, hunks, subset);
		expect(result).toBe("A\nB-new\nC\nD\nE");

		// Accept ONLY the second hunk (D -> D-new), reject first (B stays B)
		const subset2 = [hunks[1].id];
		const result2 = applyHunks(oldText, hunks, subset2);
		expect(result2).toBe("A\nB\nC\nD-new\nE");
	});
});

describe("forge/core - Proposals & Safe String Replacement", () => {
	it("safely handles special replacement characters ($1, $&, $') via function-form replacement", () => {
		const original = 'const str = "hello";';
		const edits = [
			{
				old_text: '"hello"',
				new_text: '"$1 $& $\' $` test"',
			},
		];

		const res = applyEdits(original, edits);
		expect(res.error).toBeUndefined();
		expect(res.content).toBe('const str = "$1 $& $\' $` test";');
	});

	it("detects ambiguous edits where old_text appears multiple times", () => {
		const original = "repeated\nmiddle\nrepeated";
		const edits = [{ old_text: "repeated", new_text: "changed" }];

		const res = applyEdits(original, edits);
		expect(res.error).toBeDefined();
		expect(res.error).toContain("ambiguous");
	});

	it("returns error if old_text is not found", () => {
		const original = "const x = 1;";
		const edits = [{ old_text: "const y = 2;", new_text: "const z = 3;" }];

		const res = applyEdits(original, edits);
		expect(res.error).toBeDefined();
		expect(res.error).toContain("not found");
	});

	it("creates write proposal only for non-existent files", () => {
		const writeNew = createWriteProposal("new.txt", "content", false);
		expect(writeNew.result).toBeDefined();
		expect(writeNew.result?.hash).toBe(computeProposalHash("new.txt", "content"));

		const writeExisting = createWriteProposal("existing.txt", "content", true);
		expect(writeExisting.error).toBeDefined();
		expect(writeExisting.error).toContain("already exists");
	});

	it("produces deterministic SHA-256 proposal hash", () => {
		const hash1 = computeProposalHash("src/app.ts", "console.log('hi');\n");
		const hash2 = computeProposalHash("src/app.ts", "console.log('hi');\n");
		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64);
	});
});

describe("forge/core - Review Broker", () => {
	it("records approvals, verifies hasApproval, and consumes them ONCE (single-use)", () => {
		const broker = new ReviewBroker();
		const key = "test-hash-12345";
		const acceptedHunks = ["hunk-0", "hunk-1"];

		broker.recordApproval(key, acceptedHunks);
		expect(broker.hasApproval(key)).toBe(true);

		// First consume succeeds
		const consumed = broker.consumeApproval(key);
		expect(consumed).toEqual({ acceptedHunkIds: acceptedHunks });

		// Second consume MUST fail (single-use invariant!)
		expect(broker.consumeApproval(key)).toBeNull();
		expect(broker.hasApproval(key)).toBe(false);
	});

	it("expires approvals after the expiry threshold", async () => {
		const shortExpiryMs = 50; // 50ms for test
		const broker = new ReviewBroker(shortExpiryMs);
		const key = "test-expiring-hash";

		broker.recordApproval(key, ["hunk-0"]);
		expect(broker.hasApproval(key)).toBe(true);

		// Wait for expiration
		await new Promise((r) => setTimeout(r, 60));

		expect(broker.hasApproval(key)).toBe(false);
		expect(broker.consumeApproval(key)).toBeNull();
	});
});

describe("forge/core - Change Log", () => {
	it("pushes, peeks, and pops changes for undo", () => {
		const log = new ChangeLog();
		expect(log.canUndo()).toBe(false);

		log.pushChange({
			filePath: "/path/file.txt",
			relativePath: "file.txt",
			beforeText: "before",
			afterText: "after",
		});

		expect(log.canUndo()).toBe(true);
		expect(log.peekChange()?.beforeText).toBe("before");

		const popped = log.popChange();
		expect(popped?.beforeText).toBe("before");
		expect(log.canUndo()).toBe(false);
	});
});

describe("forge/core - Event Index", () => {
	it("merges message deltas and indexes tool calls across turns", () => {
		const index = new EventIndex();

		// Base message
		index.indexEvent({
			id: "msg-1",
			type: "model.message",
			role: "assistant",
			content: "I will edit the file.",
			toolCalls: [
				{
					id: "call-1",
					type: "function",
					function: {
						name: "propose_edit",
						arguments: '{"path": "test.txt", ',
					},
				},
			],
		});

		// Delta arrives
		index.mergeDelta({
			id: "msg-1",
			type: "model.message.delta",
			toolCalls: [
				{
					index: 0,
					function: {
						arguments: '"edits": []}',
					},
				},
			],
		});

		const toolCall = index.getToolCall("call-1");
		expect(toolCall).toBeDefined();
		expect(toolCall?.name).toBe("propose_edit");
		expect(toolCall?.arguments).toEqual({ path: "test.txt", edits: [] });

		// Test extractPendingApprovals
		const approvalEvent = {
			type: "tool.approval_required",
			toolCalls: [
				{
					id: "call-1",
					sourceEventId: "msg-1",
				},
			],
		};

		const pending = index.extractPendingApprovals(approvalEvent);
		expect(pending.length).toBe(1);
		expect(pending[0].toolCallId).toBe("call-1");
		expect(pending[0].toolName).toBe("propose_edit");
		expect(pending[0].arguments).toEqual({ path: "test.txt", edits: [] });
	});
});
