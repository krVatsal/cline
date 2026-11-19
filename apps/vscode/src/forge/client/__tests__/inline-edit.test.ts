import { describe, it, expect, mock } from "bun:test";
import { executeInlineEdit } from "../inline-edit";

describe("Phase 1: Inline Edit - Forge: Edit Selection", () => {
	it("prompts user and sends only relative path and line numbers without file contents", async () => {
		let capturedPrompt = "";
		let capturedOptions: any = null;

		const mockTurnRunnerInstance = {
			sessionId: "inline-session-123",
			runTurn: async (prompt: string, callbacks: any) => {
				capturedPrompt = prompt;
				return { text: "Done", status: "done" };
			},
			cancel: async () => {},
		};

		// Mock VS Code environment
		const mockDoc = {
			uri: { fsPath: "C:/project/src/flask/helpers.py" },
			lineCount: 100,
		};
		const mockEditor = {
			document: mockDoc,
			selection: {
				isEmpty: false,
				start: { line: 27 }, // 0-based: line 28
				end: { line: 33 }, // 0-based: line 34
			},
		};

		let showInputBoxPrompt = "";
		const mockVsCode = {
			window: {
				activeTextEditor: mockEditor,
				showInputBox: async (opts: any) => {
					showInputBoxPrompt = opts.prompt;
					return "Treat the values 'off' and 'n' as false as well, case-insensitively";
				},
				withProgress: async (opts: any, task: any) => {
					return task({ report: () => {} }, { onCancellationRequested: () => {} });
				},
				showInformationMessage: () => {},
				showErrorMessage: () => {},
			},
			workspace: {
				getWorkspaceFolder: () => ({ uri: { fsPath: "C:/project" } }),
			},
			Uri: {
				file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
			},
		};

		(globalThis as any).vscode = mockVsCode;

		const mockEditorServer = {
			url: "http://127.0.0.1:55555/mcp",
			token: "dummy-token",
			workspaceRoot: "C:/project",
			stop: async () => {},
		};

		// Run inline edit
		await executeInlineEdit({
			editorServer: mockEditorServer as any,
			model: "groq/openai-gpt-oss-20b",
			fallbackModel: "google-gemini/gemini-2.5-flash",
			runner: mockTurnRunnerInstance as any,
		});

		// Verify prompt formatting rule:
		// "The prompt sent to TrueForge contains the instruction plus the relative path (forward slashes) and the start/end line numbers ONLY, never file text."
		expect(capturedPrompt).toContain("Treat the values 'off' and 'n' as false as well, case-insensitively");
		expect(capturedPrompt).toContain("Target: src/flask/helpers.py:28-34");
		expect(capturedPrompt).not.toContain("def get_debug_flag");
		expect(capturedPrompt).not.toContain("FLASK_DEBUG");
		expect(capturedPrompt).not.toContain("<file_content");
	});
});
