/**
 * Stub for @cline/agents in the VS Code extension bundle.
 * Agentic execution is delegated exclusively to TrueForge.
 */

export class Agent {}

export function createAgentRuntime(...args: any[]): any {
	return {
		start: async () => ({ sessionId: "stub-session" }),
		send: async () => ({ text: "" }),
		abort: async () => {},
		dispose: async () => {},
	};
}

export class AgentRuntimeAbortError extends Error {
	constructor(message?: string) {
		super(message ?? "Agent runtime aborted");
		this.name = "AgentRuntimeAbortError";
	}
}
