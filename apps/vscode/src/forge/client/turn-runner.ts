import * as fs from "node:fs";
import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

function getVsCode(): any {
	try {
		return require("vscode");
	} catch {
		return (globalThis as any).vscode;
	}
}
import {
	EventIndex,
	PendingApproval,
	ProposalResult,
	createEditProposal,
	createWriteProposal,
	reviewBroker,
	resolveSafePath,
	forgeLogger,
} from "../core";
import { ForgeEditorServer } from "../server";
import { classifyTurnError, computeBackoffDelay, sleep } from "./resilience";

export interface ApprovalDecisionInput {
	allow: boolean;
	acceptedHunkIds?: string[];
	denyReason?: string;
}

export interface PendingToolApprovalDetail extends PendingApproval {
	proposal?: ProposalResult;
	error?: string;
}

export interface TurnRunnerCallbacks {
	onTextDelta?: (delta: string, accumulated: string) => void;
	onReasoningDelta?: (delta: string, accumulated: string) => void;
	onToolCallStarted?: (toolName: string, args: any) => void;
	onApprovalRequired?: (approval: PendingToolApprovalDetail) => Promise<ApprovalDecisionInput>;
	onStatusChange?: (status: string) => void;
	onError?: (error: Error) => void;
	onDone?: (result: { text: string; status: string }) => void;
}

export interface TurnRunnerOptions {
	client: TrueForge;
	editorServer: ForgeEditorServer;
	model: string;
	fallbackModel?: string;
	instructions?: string;
	iterationLimit?: number;
}

export class TurnRunner {
	private readonly client: TrueForge;
	private readonly editorServer: ForgeEditorServer;
	private activeModel: string;
	private readonly fallbackModel?: string;
	private readonly instructions?: string;
	private readonly iterationLimit: number;

	private currentSessionId: string | null = null;
	private readonly eventIndex = new EventIndex();
	private activeAbortController: AbortController | null = null;

	constructor(options: TurnRunnerOptions) {
		this.client = options.client;
		this.editorServer = options.editorServer;
		this.activeModel = options.model;
		this.fallbackModel = options.fallbackModel;
		this.instructions = options.instructions;
		this.iterationLimit = options.iterationLimit ?? 30;
	}

	get sessionId(): string | null {
		return this.currentSessionId;
	}

	get model(): string {
		return this.activeModel;
	}

	/**
	 * Registers or updates the editor MCP server in TrueForge settings.
	 */
	async registerMcpServer(): Promise<void> {
		await this.client.settings.mcpServers.createOrUpdate({
			manifest: {
				type: "remote",
				name: "forge-editor",
				description: "Local workspace file operations and diff proposals",
				url: this.editorServer.url,
				auth: {
					type: "header",
					headers: {
						Authorization: `Bearer ${this.editorServer.token}`,
					},
				},
			},
		});
		forgeLogger.log(`[MCP Server] Registered forge-editor at ${this.editorServer.url}`);
	}

	/**
	 * Creates a new session in TrueForge with the editor MCP server preloaded.
	 */
	async initSession(modelOverride?: string): Promise<string> {
		await this.registerMcpServer();

		const modelName = modelOverride || this.activeModel;
		this.activeModel = modelName;

		// Preload core file & diff tools; search_workspace remains deferred in enableTools (Phase D2)
		const coreTools = ["read_file", "list_dir", "propose_edit", "propose_write"];
		const allTools = ["read_file", "list_dir", "search_workspace", "propose_edit", "propose_write"];

		// Phase D1: Explicit Context: output requirement before proposing changes
		const defaultInstructions =
			"You are an expert AI software engineering partner assisting the user in their codebase. " +
			"Inspect files using read_file, search_workspace, and list_dir. " +
			"Before proposing your first edit in a turn, you MUST output a line of the form:\n" +
			"Context: <comma-separated list of relative file paths and line ranges you inspected>\n" +
			"Example: Context: src/flask/helpers.py:10-45, src/flask/sansio/scaffold.py:100-140\n" +
			"Do not guess line numbers; report the ranges you actually read using read_file.\n" +
			"When modifying files, propose changes using propose_edit or propose_write. " +
			"Edits will be presented to the user for approval before writing to disk.";

		const session = await this.client.sessions.create({
			agent: {
				spec: {
					model: {
						name: modelName,
						params: {
							parallelToolCalls: false,
						},
					},
					instructions: this.instructions || defaultInstructions,
					mcpServers: [
						{
							name: "forge-editor",
							preload: true,
							enableTools: allTools,
							preloadTools: coreTools,
							requireApprovalForTools: ["propose_edit", "propose_write"],
						},
					],
					config: {
						iterationLimit: this.iterationLimit,
						contextManagement: {
							compaction: {
								enabled: true,
							},
						},
						dynamicSubAgents: {
							enabled: true,
						},
					},
				},
			},
		});

		const sessionId = (session as any).data?.id || (session as any).id;
		if (!sessionId) {
			throw new Error("TrueForge did not return a valid session ID");
		}

		this.currentSessionId = sessionId;
		this.eventIndex.clear();
		forgeLogger.log(`[Session Created] id=${sessionId}, model=${modelName}`);
		return sessionId;
	}

	/**
	 * Runs a turn with resilience: error classification, backoff retry, and automatic model fallback.
	 */
	async runTurn(
		prompt: string,
		callbacks: TurnRunnerCallbacks = {},
		externalSignal?: AbortSignal,
	): Promise<{ text: string; status: string }> {
		const maxRetries = 3;
		let attempt = 0;

		while (true) {
			attempt++;
			try {
				return await this.executeTurnAttempt(prompt, callbacks, externalSignal);
			} catch (err: any) {
				if (externalSignal?.aborted || err.message?.includes("cancelled")) {
					throw err;
				}

				const errorClass = classifyTurnError(err);
				forgeLogger.log(`[Turn Error] attempt=${attempt}/${maxRetries}, class=${errorClass}, error=${err.message}`);

				// Handle RETRYABLE errors with exponential backoff
				if (errorClass === "RETRYABLE" && attempt < maxRetries) {
					const delayMs = computeBackoffDelay(attempt);
					forgeLogger.log(`[Retry] Retrying turn in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries}) due to: ${err.message}`);
					callbacks.onStatusChange?.(`Rate limit / temporary error: retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...`);
					await sleep(delayMs, externalSignal);
					continue;
				}

				// Handle MODEL_FATAL (or exhausted 429 retries) with automatic model fallback
				if (
					(errorClass === "MODEL_FATAL" || errorClass === "RETRYABLE") &&
					this.fallbackModel &&
					this.fallbackModel !== this.activeModel
				) {
					const oldModel = this.activeModel;
					const fallback = this.fallbackModel;
					forgeLogger.log(`[Model Fallback] Primary model "${oldModel}" failed (${err.message}). Switching to fallback "${fallback}"...`);
					
					try {
						const vs = getVsCode();
						if (typeof vs?.window?.showWarningMessage === "function") {
							vs.window.showWarningMessage(`Primary model ${oldModel} failed (${err.message}); switched to fallback ${fallback}`);
						}
					} catch {
						// ignore if outside vscode
					}

					callbacks.onStatusChange?.(`Switched to fallback model: ${fallback}`);
					// Start fresh session with the fallback model
					await this.initSession(fallback);
					// Reset attempt counter and retry turn under fallback session
					attempt = 0;
					continue;
				}

				// If error is MODEL_FATAL but no fallback model is configured:
				if (errorClass === "MODEL_FATAL") {
					const cleanMsg = `Model "${this.activeModel}" failed: ${err.message}. Please configure a valid model in cline.trueforge.modelId or provide a fallback in cline.trueforge.fallbackModelId.`;
					const cleanError = new Error(cleanMsg);
					callbacks.onError?.(cleanError);
					throw cleanError;
				}

				callbacks.onError?.(err);
				throw err;
			}
		}
	}

	/**
	 * Executes a single turn streaming attempt.
	 */
	private async executeTurnAttempt(
		prompt: string,
		callbacks: TurnRunnerCallbacks = {},
		externalSignal?: AbortSignal,
	): Promise<{ text: string; status: string }> {
		if (!this.currentSessionId) {
			try {
				await this.initSession();
			} catch (initErr: any) {
				if (this.fallbackModel && this.fallbackModel !== this.activeModel) {
					callbacks.onStatusChange?.(`Primary model failed. Falling back to ${this.fallbackModel}...`);
					await this.initSession(this.fallbackModel);
				} else {
					throw initErr;
				}
			}
		}

		const abortController = new AbortController();
		this.activeAbortController = abortController;

		const onAbort = () => abortController.abort();
		if (externalSignal) {
			externalSignal.addEventListener("abort", onAbort, { once: true });
		}

		let accumulatedText = "";
		let accumulatedReasoning = "";

		try {
			let turnInputs: any[] = [
				{
					type: "user.message",
					content: prompt,
				},
			];

			forgeLogger.log(`[Turn Start] sessionId=${this.currentSessionId}, prompt="${prompt.substring(0, 100)}"`);

			// Turn execution loop (continues across approval resumptions)
			while (true) {
				if (abortController.signal.aborted) {
					throw new Error("Turn cancelled by user");
				}

				callbacks.onStatusChange?.("Waiting for agent response...");

				const stream = await this.client.sessions.createTurnStream(
					this.currentSessionId!,
					{ input: turnInputs },
					{ abortSignal: abortController.signal },
				);

				let pendingApprovalEvent: any = null;
				let turnFinished = false;
				let finalStatus = "done";

				for await (const chunk of (stream as any).withMetadata ? (stream as any).withMetadata() : stream) {
					if (abortController.signal.aborted) {
						throw new Error("Turn cancelled by user");
					}

					const event = chunk.data ?? chunk;
					forgeLogger.log(`[Event: ${event.type}] (id=${chunk.id || event.id || "none"})`);

					if (event.type === "model.message.delta") {
						this.eventIndex.mergeDelta(event);

						const reasoning = (event as any).reasoningContent;
						if (reasoning) {
							accumulatedReasoning += reasoning;
							callbacks.onReasoningDelta?.(reasoning, accumulatedReasoning);
						}

						const delta = event.content ?? "";
						if (delta) {
							accumulatedText += delta;
							callbacks.onTextDelta?.(delta, accumulatedText);
						}
					} else if (event.type === "model.message") {
						this.eventIndex.indexEvent(event);
						if (event.toolCalls && event.toolCalls.length > 0) {
							for (const tc of event.toolCalls) {
								callbacks.onToolCallStarted?.(tc.toolName || tc.name, tc.arguments || tc.input);
								forgeLogger.log(`[Tool Call Requested] tool=${tc.toolName || tc.name}, args=${JSON.stringify(tc.arguments || tc.input || {})}`);
							}
						}
						if (event.content && !accumulatedText) {
							accumulatedText = event.content;
							callbacks.onTextDelta?.(event.content, accumulatedText);
						}
					} else if (event.type === "tool.approval_required") {
						pendingApprovalEvent = event;
					} else if (event.type === "turn.done") {
						turnFinished = true;
						finalStatus = event.state?.status || "done";

						const usage = event.usage || event.state?.usage;
						if (usage) {
							forgeLogger.log(`[Token Usage] input=${usage.inputTokens ?? 0}, output=${usage.outputTokens ?? 0}, total=${usage.totalTokens ?? 0}`);
						}

						if (finalStatus === "error") {
							const errorMsg = event.state?.message || "TrueForge turn ended with error";
							forgeLogger.log(`[Turn Error] status=error, message=${errorMsg}`);
							throw new Error(errorMsg);
						}
					}
				}

				// If an approval was required, resolve proposal and request user approval
				if (pendingApprovalEvent) {
					callbacks.onStatusChange?.("Waiting for user approval of proposed changes...");
					const pendingList = this.eventIndex.extractPendingApprovals(pendingApprovalEvent);
					const approvalInputs: any[] = [];

					for (const item of pendingList) {
						const detail: PendingToolApprovalDetail = { ...item };

						const fnName = item.toolName === "call_tool" ? item.arguments?.tool_name : item.toolName;
						const fnArgs = (item.toolName === "call_tool" && item.arguments?.input) ? item.arguments.input : item.arguments;

						if (fnName === "propose_edit") {
							const relPath = fnArgs?.path;
							const edits = fnArgs?.edits;
							const safe = resolveSafePath(this.editorServer.workspaceRoot, relPath || "");

							if (safe.safe && safe.resolvedPath && fs.existsSync(safe.resolvedPath)) {
								const originalContent = fs.readFileSync(safe.resolvedPath, "utf-8");
								const prop = createEditProposal(relPath, originalContent, edits || []);
								if (prop.result) {
									detail.proposal = prop.result;
								} else {
									detail.error = prop.error;
								}
							} else {
								detail.error = safe.error || `File not found: ${relPath}`;
							}
						} else if (fnName === "propose_write") {
							const relPath = fnArgs?.path;
							const content = fnArgs?.content || "";
							const prop = createWriteProposal(relPath, content, false);
							if (prop.result) {
								detail.proposal = prop.result;
							} else {
								detail.error = prop.error;
							}
						}

						forgeLogger.log(`[Approval Prompt Shown] toolCallId=${item.toolCallId}, toolName=${fnName}, hash=${detail.proposal?.hash || "none"}`);

						let decision: ApprovalDecisionInput = { allow: false, denyReason: "Denied by default" };
						if (callbacks.onApprovalRequired) {
							decision = await callbacks.onApprovalRequired(detail);
						}

						forgeLogger.log(`[User Decision] allow=${decision.allow}, acceptedHunks=${JSON.stringify(decision.acceptedHunkIds ?? [])}, denyReason=${decision.denyReason ?? "none"}`);

						if (decision.allow && detail.proposal) {
							const hunkIdsToAccept =
								decision.acceptedHunkIds && decision.acceptedHunkIds.length > 0
									? decision.acceptedHunkIds
									: detail.proposal.hunks.map((h) => h.id);

							reviewBroker.recordApproval(detail.proposal.hash, hunkIdsToAccept);

							approvalInputs.push({
								type: "user.tool_approval",
								threadId: pendingApprovalEvent.threadId,
								toolCallId: item.toolCallId,
								approval: { status: "allow" },
							});
						} else {
							approvalInputs.push({
								type: "user.tool_approval",
								threadId: pendingApprovalEvent.threadId,
								toolCallId: item.toolCallId,
								approval: {
									status: "deny",
									reason: decision.denyReason || "User rejected proposed changes",
								},
							});
						}
					}

					// Resume the turn with tool approvals
					turnInputs = approvalInputs;
					continue;
				}

				// If turn finished with no pending approvals, we are done
				forgeLogger.log(`[Turn Done] status=${finalStatus}, accumulatedTextLen=${accumulatedText.length}`);
				callbacks.onDone?.({ text: accumulatedText, status: finalStatus });
				return { text: accumulatedText, status: finalStatus };
			}
		} finally {
			if (externalSignal) {
				externalSignal.removeEventListener("abort", onAbort);
			}
			this.activeAbortController = null;
		}
	}

	/**
	 * Cancels the current running session in TrueForge.
	 */
	async cancel(): Promise<void> {
		forgeLogger.log(`[Cancel Requested] sessionId=${this.currentSessionId}`);
		if (this.activeAbortController) {
			this.activeAbortController.abort();
		}
		if (this.currentSessionId) {
			try {
				await this.client.sessions.cancel(this.currentSessionId);
				forgeLogger.log(`[Cancel Completed] sessionId=${this.currentSessionId}`);
			} catch (cancelErr: any) {
				forgeLogger.log(`[Cancel Error] sessionId=${this.currentSessionId}, error=${cancelErr.message}`);
				console.warn("[TurnRunner] Cancel error:", cancelErr);
			}
		}
	}
}
