import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { TurnRunner, ApprovalDecisionInput } from "./turn-runner";
import { ForgeEditorServer } from "../server";
import { resolveSafePath, forgeLogger } from "../core";

function getVsCode(): any {
	if ((globalThis as any).vscode) {
		return (globalThis as any).vscode;
	}
	try {
		return require("vscode");
	} catch {
		return undefined;
	}
}

export interface InlineEditOptions {
	client?: TrueForge;
	editorServer: ForgeEditorServer;
	model: string;
	fallbackModel?: string;
	baseUrl?: string;
	runner?: TurnRunner;
}

/**
 * Executes an inline edit command on the user's active editor selection.
 * Flow:
 * 1. Checks active editor and selection.
 * 2. Asks for user instruction via input box.
 * 3. Builds prompt with ONLY relative path and start/end line numbers (never file text).
 * 4. Runs inline agent variant (enableTools/preloadTools: read_file, propose_edit; iterationLimit: 8).
 * 5. Shows progress notification with Cancel button wired to cancel path.
 * 6. Directs diff through InlineDiffReviewController for per-hunk review before disk commit.
 */
export async function executeInlineEdit(options: InlineEditOptions): Promise<void> {
	const vscode = getVsCode();
	if (!vscode) return;

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("No active editor.");
		return;
	}

	if (editor.selection.isEmpty) {
		vscode.window.showInformationMessage("No selection in the active editor. Select code to edit first.");
		return;
	}

	const doc = editor.document;
	const rootPath = options.editorServer.workspaceRoot;
	const relPath = path.relative(rootPath, doc.uri.fsPath).replace(/\\/g, "/");
	const startLine = editor.selection.start.line + 1;
	const endLine = editor.selection.end.line + 1;

	const instruction = await vscode.window.showInputBox({
		title: "Forge: Edit Selection",
		prompt: `Instruction for ${relPath}:${startLine}-${endLine}`,
		placeHolder: "Describe the change to apply to this selection...",
		ignoreFocusOut: true,
	});

	if (!instruction || !instruction.trim()) {
		return;
	}

	const prompt = `${instruction.trim()}\nTarget: ${relPath}:${startLine}-${endLine}`;

	const tfClient =
		options.client ??
		new TrueForge({
			baseUrl: options.baseUrl || "http://127.0.0.1:8790",
			environment: options.baseUrl || "http://127.0.0.1:8790",
		});

	const inlineInstructions =
		"You are an expert code editor. Change ONLY the selected region and its docstring in the specified file. " +
		"Do not explore or touch any other files or regions. " +
		"Use read_file to inspect the target file around the specified line numbers, then use propose_edit to propose exact replacements. " +
		"When calling propose_edit, provide path and edits, where each edit object contains BOTH 'old_text' (the exact text to replace) and 'new_text' (the replacement text). " +
		"Output your proposed changes via propose_edit.";

	const runner =
		options.runner ??
		new TurnRunner({
			client: tfClient,
			editorServer: options.editorServer,
			model: options.model,
			fallbackModel: options.fallbackModel,
			instructions: inlineInstructions,
			iterationLimit: 8,
			enableTools: ["read_file", "propose_edit"],
			preloadTools: ["read_file", "propose_edit"],
			requireApprovalForTools: ["propose_edit"],
		});

	forgeLogger.log(`[Inline Edit] Started: ${relPath}:${startLine}-${endLine}`);

	// Retrieve InlineDiffReviewController singleton
	let inlineReviewController: any;
	try {
		const { InlineDiffReviewController } = require("../../hosts/vscode/InlineDiffReviewController");
		inlineReviewController = InlineDiffReviewController.getInstance();
	} catch (e) {
		console.warn("[Inline Edit] Could not get InlineDiffReviewController:", e);
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation?.Notification ?? 15,
			title: `Forge: Editing ${relPath}:${startLine}-${endLine}`,
			cancellable: true,
		},
		async (progress: any, token: any) => {
			token.onCancellationRequested(async () => {
				forgeLogger.log(`[Inline Edit] Cancel requested by user`);
				await runner.cancel();
				if (inlineReviewController) {
					inlineReviewController.cancelAllReviews("User cancelled inline edit");
				}
			});

			try {
				await runner.runTurn(prompt, {
					onStatusChange: (status) => {
						progress.report({ message: status });
					},
					onApprovalRequired: async (detail) => {
						if (!detail.proposal) {
							return { allow: false, denyReason: detail.error || "No proposal generated" };
						}
						if (!inlineReviewController) {
							return { allow: true };
						}

						progress.report({ message: "Review pending diff in editor..." });

						return new Promise<ApprovalDecisionInput>((resolve) => {
							const safe = resolveSafePath(rootPath, detail.proposal!.relativePath);
							const fileUri = vscode.Uri.file(safe.resolvedPath || doc.uri.fsPath);

							inlineReviewController.startReview(
								fileUri,
								detail.proposal!.originalContent,
								detail.proposal!.newContent,
								(decision: any) => {
									resolve({
										allow: decision.allow,
										acceptedHunkIds: decision.acceptedHunkIds,
										denyReason: decision.denyReason,
									});
								}
							);
						});
					},
				});
			} catch (err: any) {
				vscode.window.showErrorMessage(`Forge Edit Selection error: ${err.message}`);
			}
		}
	);
}
