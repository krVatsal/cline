import * as fs from "node:fs";
import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import {
	EventIndex,
	PendingApproval,
	ProposalResult,
	createEditProposal,
	createWriteProposal,
	reviewBroker,
	resolveSafePath,
} from "../core";
import { ForgeEditorServer } from "../server";

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
	private readonly model: string;
	private readonly fallbackModel?: string;
	private readonly instructions?: string;
	private readonly iterationLimit: number;

	private currentSessionId: string | null = null;
	private readonly eventIndex = new EventIndex();
	private activeAbortController: AbortController | null = null;

	constructor(options: TurnRunnerOptions) {
		this.client = options.client;
		this.editorServer = options.editorServer;
		this.model = options.model;
		this.fallbackModel = options.fallbackModel;
		this.instructions = options.instructions;
		this.iterationLimit = options.iterationLimit ?? 30;
	}

	get sessionId(): string | null {
		return this.currentSessionId;
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
	}

	/**
	 * Creates a new session in TrueForge with the editor MCP server preloaded.
	 */
	async initSession(modelOverride?: string): Promise<string> {
		await this.registerMcpServer();

		const modelName = modelOverride || this.model;
		const coreTools = ["read_file", "list_dir", "search_workspace", "propose_edit", "propose_write"];

		const session = await this.client.sessions.create({
			agent: {
				spec: {
					model: {
						name: modelName,
						params: {
							parallelToolCalls: false,
						},
					},
					instructions:
						this.instructions ||
						"You are an expert AI software engineering partner assisting the user in their codebase. " +
						"Inspect files using read_file, search_workspace, and list_dir. " +
						"When modifying files, propose changes using propose_edit or propose_write. " +
						"Edits will be presented to the user for approval before writing to disk.",
					mcpServers: [
						{
							name: "forge-editor",
							enableTools: coreTools,
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
		return sessionId;
	}

	/**
	 * Runs a turn with a user message prompt and handles streaming events, approvals, and completions.
	 */
	async runTurn(
		prompt: string,
		callbacks: TurnRunnerCallbacks = {},
		externalSignal?: AbortSignal,
	): Promise<{ text: string; status: string }> {
		if (!this.currentSessionId) {
			try {
				await this.initSession();
			} catch (initErr: any) {
				if (this.fallbackModel && this.fallbackModel !== this.model) {
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
						if (event.content && !accumulatedText) {
							accumulatedText = event.content;
							callbacks.onTextDelta?.(event.content, accumulatedText);
						}
					} else if (event.type === "tool.approval_required") {
						pendingApprovalEvent = event;
					} else if (event.type === "turn.done") {
						turnFinished = true;
						finalStatus = event.state?.status || "done";

						if (finalStatus === "error") {
							throw new Error(event.state?.message || "TrueForge turn ended with error");
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

						// Prepare proposal detail for diff visualization
						if (item.toolName === "propose_edit") {
							const relPath = item.arguments?.path;
							const edits = item.arguments?.edits;
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
						} else if (item.toolName === "propose_write") {
							const relPath = item.arguments?.path;
							const content = item.arguments?.content || "";
							const prop = createWriteProposal(relPath, content, false);
							if (prop.result) {
								detail.proposal = prop.result;
							} else {
								detail.error = prop.error;
							}
						}

						let decision: ApprovalDecisionInput = { allow: false, denyReason: "Denied by default" };
						if (callbacks.onApprovalRequired) {
							decision = await callbacks.onApprovalRequired(detail);
						}

						if (decision.allow && detail.proposal) {
							// Record user approval in ReviewBroker so MCP server allows writing
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
				callbacks.onDone?.({ text: accumulatedText, status: finalStatus });
				return { text: accumulatedText, status: finalStatus };
			}
		} catch (error: any) {
			callbacks.onError?.(error);
			throw error;
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
		if (this.activeAbortController) {
			this.activeAbortController.abort();
		}
		if (this.currentSessionId) {
			try {
				await this.client.sessions.cancel(this.currentSessionId);
			} catch (cancelErr) {
				console.warn("[TurnRunner] Cancel error:", cancelErr);
			}
		}
	}
}
