/**
 * Event Index for TrueForge streaming sessions.
 *
 * Maintains:
 * 1. Run-level map of messages across turns (id -> message object)
 * 2. Merging deltas into base messages in-place
 * 3. Tool call index (toolCallId -> { toolCall, sourceMessageId })
 * 4. Extraction of pending approvals from tool.approval_required
 */

export interface ToolCallInfo {
	id: string;
	name: string;
	arguments: any;
	rawArguments: string;
	sourceMessageId?: string;
}

export interface PendingApproval {
	toolCallId: string;
	sourceEventId: string;
	toolName: string;
	arguments: any;
	rawArguments: string;
}

export class EventIndex {
	// Run-level map of messages: eventId -> message
	private readonly messagesById = new Map<string, any>();
	// Tool call lookup: toolCallId -> ToolCallInfo
	private readonly toolCallsById = new Map<string, ToolCallInfo>();

	/**
	 * Records or updates a base event.
	 */
	indexEvent(event: any): void {
		if (!event || !event.type) return;

		if (event.type === "model.message" && event.id) {
			let msg = this.messagesById.get(event.id);
			if (!msg) {
				msg = { ...event, content: event.content ?? "", toolCalls: event.toolCalls ?? [] };
				this.messagesById.set(event.id, msg);
			} else {
				// Update properties
				if (event.content !== undefined) msg.content = event.content;
				if (event.toolCalls) {
					msg.toolCalls = event.toolCalls;
				}
			}
			this.indexToolCallsFromMessage(msg);
		}
	}

	/**
	 * Merges an event delta (model.message.delta) into its base message.
	 */
	mergeDelta(deltaEvent: any): any | null {
		if (!deltaEvent || deltaEvent.type !== "model.message.delta" || !deltaEvent.id) {
			return null;
		}

		let baseMessage = this.messagesById.get(deltaEvent.id);
		if (!baseMessage) {
			baseMessage = {
				id: deltaEvent.id,
				type: "model.message",
				role: deltaEvent.role ?? "assistant",
				content: "",
				toolCalls: [],
			};
			this.messagesById.set(deltaEvent.id, baseMessage);
		}

		// Append text content delta
		if (deltaEvent.content) {
			baseMessage.content = (baseMessage.content || "") + deltaEvent.content;
		}

		// Merge tool call chunks
		if (deltaEvent.toolCalls && Array.isArray(deltaEvent.toolCalls)) {
			if (!baseMessage.toolCalls) {
				baseMessage.toolCalls = [];
			}

			for (const chunk of deltaEvent.toolCalls) {
				const idx = typeof chunk.index === "number" ? chunk.index : baseMessage.toolCalls.length;
				let existing = baseMessage.toolCalls[idx];
				if (!existing) {
					existing = {
						id: chunk.id || "",
						type: "function",
						function: {
							name: chunk.function?.name || chunk.name || "",
							arguments: chunk.function?.arguments || chunk.arguments || "",
						},
					};
					baseMessage.toolCalls[idx] = existing;
				} else {
					if (chunk.id) existing.id = chunk.id;
					if (chunk.function?.name) existing.function.name = chunk.function.name;
					if (chunk.name) existing.function.name = chunk.name;
					const argChunk = chunk.function?.arguments || chunk.arguments || "";
					if (argChunk) {
						existing.function.arguments = (existing.function.arguments || "") + argChunk;
					}
				}
			}
			this.indexToolCallsFromMessage(baseMessage);
		}

		return baseMessage;
	}

	/**
	 * Indexes tool calls found within a model.message.
	 */
	private indexToolCallsFromMessage(msg: any): void {
		if (!msg || !Array.isArray(msg.toolCalls)) return;

		for (const tc of msg.toolCalls) {
			const id = tc.id;
			if (!id) continue;

			const name = tc.function?.name || tc.name || "";
			const rawArgs = tc.function?.arguments || tc.arguments || "{}";
			let parsedArgs: any = {};
			try {
				parsedArgs = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
			} catch {
				parsedArgs = rawArgs;
			}

			this.toolCallsById.set(id, {
				id,
				name,
				arguments: parsedArgs,
				rawArguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
				sourceMessageId: msg.id,
			});
		}
	}

	/**
	 * Looks up a tool call by its ID.
	 */
	getToolCall(id: string): ToolCallInfo | undefined {
		return this.toolCallsById.get(id);
	}

	/**
	 * Looks up a message by its event ID.
	 */
	getMessage(id: string): any | undefined {
		return this.messagesById.get(id);
	}

	/**
	 * Extracts pending approvals from a `tool.approval_required` event.
	 * Resolves tool name and arguments from the referenced sourceEventId (the model.message).
	 */
	extractPendingApprovals(event: any): PendingApproval[] {
		if (!event || event.type !== "tool.approval_required") {
			return [];
		}

		const approvals: PendingApproval[] = [];
		const toolCalls = event.toolCalls;

		if (!Array.isArray(toolCalls)) {
			return approvals;
		}

		for (const item of toolCalls) {
			const toolCallId = item.id;
			const sourceEventId = item.sourceEventId;

			// Look up in toolCallsById first
			let info = this.toolCallsById.get(toolCallId);

			// If not indexed, try to look up via sourceEventId
			if (!info && sourceEventId) {
				const sourceMsg = this.messagesById.get(sourceEventId);
				if (sourceMsg && Array.isArray(sourceMsg.toolCalls)) {
					const matched = sourceMsg.toolCalls.find((tc: any) => tc.id === toolCallId);
					if (matched) {
						this.indexToolCallsFromMessage(sourceMsg);
						info = this.toolCallsById.get(toolCallId);
					}
				}
			}

			approvals.push({
				toolCallId,
				sourceEventId,
				toolName: info?.name || item.name || "unknown",
				arguments: info?.arguments ?? {},
				rawArguments: info?.rawArguments ?? "",
			});
		}

		return approvals;
	}

	/**
	 * Clears all indexed events and messages.
	 */
	clear(): void {
		this.messagesById.clear();
		this.toolCallsById.clear();
	}
}
