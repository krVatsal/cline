/**
 * Stub for @cline/agents in the VS Code extension bundle.
 * Agentic execution is delegated exclusively to TrueForge.
 */

export class Agent {
	subscribe(_listener?: (event: any) => void): () => void {
		return () => {};
	}

	async run(_input?: any): Promise<any> {
		return {
			messages: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			status: "done",
			outputText: "",
		};
	}

	async continue(_input?: any): Promise<any> {
		return {
			messages: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			status: "done",
			outputText: "",
		};
	}

	abort(_reason?: string): void {}

	snapshot(): any {
		return {
			agentId: "agent-stub",
			agentRole: undefined,
			parentAgentId: undefined,
			conversationId: undefined,
			runId: undefined,
			status: "idle",
			iteration: 0,
			messages: [],
			pendingToolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			lastError: undefined,
			lastErrorClass: undefined,
		};
	}

	restore(_messages?: any): void {}

	async start(..._args: any[]): Promise<any> {
		return { sessionId: "stub-session" };
	}

	async send(..._args: any[]): Promise<any> {
		return { text: "" };
	}

	async dispose(): Promise<void> {}
}

export const AgentRuntime = Agent;

export function createAgentRuntime(..._args: any[]): any {
	const agent = new Agent();
	return new Proxy(agent, {
		get(target: any, prop: string | symbol) {
			if (prop in target) {
				return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
			}
			return () => ({});
		},
	});
}

export const createAgent = createAgentRuntime;

export class AgentRuntimeAbortError extends Error {
	constructor(message?: string) {
		super(message ?? "Agent runtime aborted");
		this.name = "AgentRuntimeAbortError";
	}
}
