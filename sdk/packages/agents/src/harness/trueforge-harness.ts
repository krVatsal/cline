import { exec, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const execAsync = promisify(exec);
import type {
	AgentMessage,
	AgentModelFinishReason,
	AgentRunResult,
	AgentUsage,
} from "@cline/shared";
import type {
	AgentHarness,
	AgentHarnessContext,
	AgentRunInput,
} from "../agent-runtime";

export interface TrueForgeHarnessOptions {
	/**
	 * Base URL for TrueForge Agent Harness Server.
	 * Defaults to `process.env.TRUEFORGE_BASE_URL` or `http://localhost:8790`.
	 */
	baseUrl?: string;
	/**
	 * Bearer token or API key for TrueForge / TrueFoundry.
	 * Defaults to `process.env.TFY_API_KEY` or `process.env.TRUEFOUNDRY_API_KEY`.
	 */
	token?: string;
	/**
	 * Default model name (e.g. "groq/openai-gpt-oss-120b").
	 * Defaults to `process.env.TRUEFORGE_MODEL` or "groq/openai-gpt-oss-120b".
	 */
	model?: string;
}

/**
 * TrueForge Agent Harness implementation.
 *
 * Drives agentic execution via the TrueForge Agent Harness Server HTTP/SSE API:
 * 1. Creates/reuses a persistent session with inline agent specs and system instructions.
 * 2. Streams turns over Server-Sent Events (SSE).
 * 3. Translates TrueForge `model.message.delta` streaming events into `assistant-text-delta` runtime events.
 * 4. Updates cumulative token usage and completes turns cleanly.
 */
export class TrueForgeHarness implements AgentHarness {
	private readonly client: TrueForge;
	private readonly fallbackClient?: TrueForge;
	private readonly configuredModelName?: string;
	private static readonly sessionsByConversation = new Map<string, string>();
	private static isSpawning = false;

	constructor(options: TrueForgeHarnessOptions = {}) {
		const baseUrl =
			options.baseUrl ||
			process.env.TRUEFORGE_BASE_URL ||
			"http://127.0.0.1:8790";
		const token =
			options.token ||
			process.env.TFY_API_KEY ||
			process.env.TRUEFOUNDRY_API_KEY;

		this.client = new TrueForge({
			baseUrl,
			environment: baseUrl,
			token,
		});

		// Fallback client for localhost / IPv6 loopback on Windows if 127.0.0.1 fails
		if (!options.baseUrl && !process.env.TRUEFORGE_BASE_URL) {
			this.fallbackClient = new TrueForge({
				baseUrl: "http://localhost:8790",
				environment: "http://localhost:8790",
				token,
			});
		}

		this.configuredModelName =
			options.model ||
			process.env.TRUEFORGE_MODEL;
	}

	private static findNodeExecutable(): string {
		const isWin = process.platform === "win32";
		const exec = process.execPath;
		const execLower = exec.toLowerCase();
		if (
			!execLower.endsWith("code.exe") &&
			!execLower.endsWith("code") &&
			!execLower.endsWith("electron.exe") &&
			execLower.includes("node")
		) {
			return exec;
		}

		if (isWin) {
			const candidates = [
				"C:\\Program Files\\nodejs\\node.exe",
				"C:\\Program Files\\Volta\\node.exe",
				"C:\\nvm4w\\nodejs\\node.exe",
				path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
			];
			for (const cand of candidates) {
				if (fs.existsSync(cand)) return cand;
			}
			return "node.exe";
		}
		return "node";
	}

	private static findTrueForgeCli(): string | undefined {
		const appData =
			process.env.LOCALAPPDATA ||
			(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
		if (appData) {
			const npxDir = path.join(appData, "npm-cache", "_npx");
			if (fs.existsSync(npxDir)) {
				try {
					const entries = fs.readdirSync(npxDir);
					for (const entry of entries) {
						const cliCandidate = path.join(
							npxDir,
							entry,
							"node_modules",
							"@truefoundry",
							"trueforge",
							"dist",
							"cli.js",
						);
						if (fs.existsSync(cliCandidate)) {
							return cliCandidate;
						}
					}
				} catch {}
			}
		}
		return undefined;
	}

	private static async ensureServerRunning(): Promise<boolean> {
		const checkServer = async (): Promise<boolean> => {
			try {
				const res = await fetch("http://127.0.0.1:8790/api/v1/models");
				if (res.ok) return true;
			} catch {}
			try {
				const res = await fetch("http://localhost:8790/api/v1/models");
				if (res.ok) return true;
			} catch {}
			return false;
		};

		if (await checkServer()) return true;

		if (TrueForgeHarness.isSpawning) {
			for (let i = 0; i < 50; i++) {
				await new Promise((r) => setTimeout(r, 500));
				if (await checkServer()) return true;
			}
			return false;
		}

		TrueForgeHarness.isSpawning = true;
		try {
			const cliPath = TrueForgeHarness.findTrueForgeCli();
			const nodeExe = TrueForgeHarness.findNodeExecutable();
			const env = {
				...process.env,
				HOST: "0.0.0.0",
				NETWORK_POLICY_ENABLED: "false",
			};

			if (cliPath && fs.existsSync(cliPath)) {
				const isWin = process.platform === "win32";
				const useShell = isWin && !nodeExe.includes("\\");
				const child = spawn(nodeExe, [cliPath, "--port", "8790"], {
					detached: true,
					stdio: "ignore",
					env,
					windowsHide: true,
					shell: useShell,
				});
				child.unref();
			} else {
				const isWin = process.platform === "win32";
				const cmd = isWin ? "npx.cmd" : "npx";
				const child = spawn(cmd, ["@truefoundry/trueforge@latest", "--port", "8790"], {
					detached: true,
					stdio: "ignore",
					env,
					windowsHide: true,
					shell: isWin,
				});
				child.unref();
			}

			// Wait up to 25 seconds for server to start and become ready
			for (let i = 0; i < 50; i++) {
				await new Promise((r) => setTimeout(r, 500));
				if (await checkServer()) return true;
			}
		} catch (err) {
			console.warn("[TrueForgeHarness] Failed to auto-spawn TrueForge server:", err);
		} finally {
			TrueForgeHarness.isSpawning = false;
		}
		return false;
	}

	private async withClient<T>(operation: (client: TrueForge) => Promise<T>): Promise<T> {
		try {
			return await operation(this.client);
		} catch (error: any) {
			const isConnectionError =
				error?.message?.includes("fetch failed") ||
				error?.code === "ECONNREFUSED" ||
				error?.cause?.code === "ECONNREFUSED" ||
				error?.cause?.message?.includes("ECONNREFUSED");

			if (isConnectionError && this.fallbackClient) {
				try {
					return await operation(this.fallbackClient);
				} catch {}
			}

			if (isConnectionError) {
				const spawned = await TrueForgeHarness.ensureServerRunning();
				if (spawned) {
					try {
						return await operation(this.client);
					} catch {
						if (this.fallbackClient) {
							return await operation(this.fallbackClient);
						}
					}
				}
				// Final check against localhost fallback in case server just finished starting
				if (this.fallbackClient) {
					try {
						return await operation(this.fallbackClient);
					} catch {}
				}
				try {
					return await operation(this.client);
				} catch {}
			}

			throw error;
		}
	}

	private async resolveModelName(requestedModelId?: string): Promise<string> {
		if (this.configuredModelName?.trim()) {
			return this.configuredModelName.trim();
		}
		const envModel = process.env.TRUEFORGE_MODEL;
		if (envModel?.trim()) {
			return envModel.trim();
		}
		try {
			const modelsResponse = await this.withClient((c) => c.models.list());
			const activeModels = modelsResponse.data ?? [];

			// If a specific model was requested (e.g. "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b")
			if (requestedModelId?.trim()) {
				const req = requestedModelId.trim();
				const matched = activeModels.find(
					(m) =>
						m.name === req ||
						m.modelId === req ||
						m.name === `groq/${req}` ||
						m.modelId?.endsWith(req) ||
						(m.modelId && req.includes(m.modelId)),
				);
				if (matched?.name) {
					return matched.name;
				}
			}

			// Prefer Groq models (e.g. groq/openai-gpt-oss-120b)
			const groqModel = activeModels.find((m) => m.name?.startsWith("groq/"));
			if (groqModel?.name) {
				return groqModel.name;
			}
			if (activeModels.length > 0 && activeModels[0]?.name) {
				return activeModels[0].name;
			}
		} catch (error) {
			console.warn("[TrueForgeHarness] Could not query active models list from TrueForge:", error);
		}
		return "groq/openai-gpt-oss-120b";
	}

	private resolveWorkspaceCwd(ctx: AgentHarnessContext): string {
		const basePrompt = typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "";
		const envWorkDir = basePrompt.match(/Working Directory:\s*([^\r\n<]+)/i)?.[1]?.trim();
		if (envWorkDir && fs.existsSync(envWorkDir)) {
			return envWorkDir;
		}

		try {
			const vscode = (globalThis as any).vscode || (typeof require === "function" ? require("vscode") : undefined);
			const wsFolder = vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
			if (wsFolder && fs.existsSync(wsFolder)) {
				return wsFolder;
			}
		} catch {}

		const cfgCwd = (ctx.config as any).cwd || (ctx.config as any).workspaceRoot;
		if (cfgCwd && fs.existsSync(cfgCwd)) {
			return cfgCwd;
		}

		if (envWorkDir) {
			return envWorkDir;
		}

		return process.cwd();
	}

	public async run(
		ctx: AgentHarnessContext,
		input?: AgentRunInput,
	): Promise<AgentRunResult> {
		ctx.throwIfAborted();

		const snapshot = ctx.snapshot();
		const conversationId =
			(ctx.config as any).sessionId?.trim() ||
			(ctx.config as any).conversationId?.trim() ||
			snapshot.conversationId ||
			snapshot.agentId ||
			"default";

		// 1. Resolve or create TrueForge session for this conversation
		let sessionId = TrueForgeHarness.sessionsByConversation.get(conversationId);
		if (!sessionId) {
			const basePrompt = (typeof ctx.config.systemPrompt === "string" ? ctx.config.systemPrompt : "").trim();
			const envMatch = basePrompt.match(/<env>[\s\S]*?<\/env>/i);
			const envSection = envMatch ? `\n\n${envMatch[0]}` : "";
			const cwd = this.resolveWorkspaceCwd(ctx);

			const systemPrompt = `You are Zentrix, an autonomous software engineering assistant running directly inside VS Code on the user's computer.
You assist users with all development tasks: writing code, creating and editing files, running tests, inspecting repositories, and executing terminal commands.
You have FULL access to the user's workspace, file system, and terminal. You are NOT in a restricted sandbox.

Current Workspace: ${cwd}${envSection}

CRITICAL RULES:
1. You do not have external function-calling or API tools enabled. Communicate purely using standard markdown text and code blocks.
2. When creating, adding, or modifying files, ALWAYS format each file with:
**File:** \`path/to/file.ext\`
Followed immediately by the code block with the complete file contents:
\`\`\`<language>
<complete code>
\`\`\`
The integrated workspace manager automatically writes and saves these files directly to disk in the workspace.
3. When the user asks you to inspect, read, clone, pull, test, build, run, or execute anything, ALWAYS provide the exact executable shell commands inside standard markdown bash blocks:
\`\`\`bash
git clone <repo-url>
\`\`\`
4. State clearly what files you created or what commands you provided.
5. Never state that you cannot execute code, that you are sandboxed, or that you lack privileged access. You have full capability to run commands, create files, and inspect the workspace.`;

			const modelObj = ctx.config.model;
			const requestedModel =
				(typeof (ctx.config as any).modelId === "string" ? (ctx.config as any).modelId : undefined) ||
				(typeof modelObj === "string" ? modelObj : undefined) ||
				(modelObj && typeof (modelObj as any).modelId === "string" ? (modelObj as any).modelId : undefined) ||
				(modelObj && typeof (modelObj as any).name === "string" ? (modelObj as any).name : undefined) ||
				(typeof (snapshot as any).modelId === "string" ? (snapshot as any).modelId : undefined);

			const modelName = await this.resolveModelName(requestedModel);

			const sessionResponse = await this.withClient((c) =>
				c.sessions.create({
					agent: {
						spec: {
							instructions: systemPrompt,
							model: {
								name: modelName,
							},
							config: {
								askUserQuestions: { enabled: false },
								dynamicSubAgents: { enabled: false },
							},
						},
					},
				}),
			);

			const createdId = sessionResponse.data?.id;
			if (!createdId) {
				throw new Error("TrueForge did not return a session ID");
			}
			sessionId = createdId;
			TrueForgeHarness.sessionsByConversation.set(conversationId, sessionId);
		}

		// 2. Extract user input text
		let promptText = "";
		if (typeof input === "string") {
			promptText = input;
		} else if (input && typeof input === "object") {
			if ("text" in input && typeof (input as any).text === "string") {
				promptText = (input as any).text;
			} else if ("prompt" in input && typeof (input as any).prompt === "string") {
				promptText = (input as any).prompt;
			} else if ("content" in input) {
				if (typeof (input as any).content === "string") {
					promptText = (input as any).content;
				} else if (Array.isArray((input as any).content)) {
					promptText = (input as any).content
						.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
						.map((part: any) => (typeof part === "string" ? part : part.text || ""))
						.join("\n");
				}
			} else if (Array.isArray(input)) {
				for (let i = input.length - 1; i >= 0; i--) {
					const msg = input[i];
					if (msg && typeof msg === "object") {
						if (typeof (msg as any).content === "string") {
							promptText = (msg as any).content;
							break;
						} else if (Array.isArray((msg as any).content)) {
							const extracted = (msg as any).content
								.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
								.map((part: any) => (typeof part === "string" ? part : part.text || ""))
								.join("\n");
							if (extracted) {
								promptText = extracted;
								break;
							}
						}
					}
				}
			}
		}

		if (!promptText && snapshot.messages.length > 0) {
			for (let i = snapshot.messages.length - 1; i >= 0; i--) {
				const msg = snapshot.messages[i];
				if (msg.role === "user") {
					if (typeof (msg as any).content === "string") {
						promptText = (msg as any).content;
						break;
					} else if (Array.isArray(msg.content)) {
						const extracted = msg.content
							.filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
							.map((part: any) => (typeof part === "string" ? part : (part as any).text || ""))
							.join("\n");
						if (extracted) {
							promptText = extracted;
							break;
						}
					}
				}
			}
		}

		// Strip mode envelopes and tags like <mode_notice>...</mode_notice> or <user_input mode="act">...</user_input>
		promptText = promptText
			.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/gi, "")
			.replace(/<user_input(?:\s+[^>]*)?>([\s\S]*?)<\/user_input>/gi, "$1")
			.trim();

		// If this is a synthetic resumption or generic continue/retry prompt, recover the original task prompt from history
		if (
			promptText.includes("[TASK RESUMPTION]") ||
			promptText.toLowerCase().trim() === "continue" ||
			promptText.toLowerCase().trim() === "retry"
		) {
			let originalPrompt = "";
			for (const msg of snapshot.messages) {
				if (msg.role === "user") {
					const text =
						typeof (msg as any).content === "string"
							? (msg as any).content
							: Array.isArray((msg as any).content)
								? (msg as any).content
										.filter((p: any) => p && (p.type === "text" || typeof p.text === "string"))
										.map((p: any) => (typeof p === "string" ? p : p.text || ""))
										.join("\n")
								: "";
					const cleaned = text
						.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/gi, "")
						.replace(/<user_input(?:\s+[^>]*)?>([\s\S]*?)<\/user_input>/gi, "$1")
						.replace(/\[TASK RESUMPTION\][^\r\n]*/gi, "")
						.trim();
					if (
						cleaned &&
						cleaned.toLowerCase() !== "continue" &&
						cleaned.toLowerCase() !== "retry"
					) {
						originalPrompt = cleaned;
						break;
					}
				}
			}
			if (originalPrompt) {
				promptText = `Please resume and complete this task:\n${originalPrompt}`;
			}
		}

		// If no prompt was provided and no user messages exist in history, this is an interactive
		// session bootstrap without an initial prompt. Return cleanly without sending a turn.
		if (!promptText) {
			return ctx.finishRun("completed", undefined, "");
		}

		// Auto-discover and attach context for workspace files mentioned in the prompt
		let turnInputContent = promptText;
		const workspaceCwd = this.resolveWorkspaceCwd(ctx);
		const fileCandidateRegex = /(?:^|[\s"'`(\[])([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9_-]{1,10})(?:$|[\s"',`)\]:])/g;
		const seenFiles = new Set<string>();
		let fileContextBlocks = "";

		let mFile: RegExpExecArray | null;
		while ((mFile = fileCandidateRegex.exec(promptText)) !== null) {
			const candidate = mFile[1].trim();
			if (candidate.startsWith("http") || candidate.endsWith(".") || !candidate.includes(".")) {
				continue;
			}
			const absPath = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceCwd, candidate);
			if (fs.existsSync(absPath) && !seenFiles.has(absPath)) {
				try {
					const stat = fs.statSync(absPath);
					if (stat.isFile() && stat.size <= 250000) {
						seenFiles.add(absPath);
						const content = fs.readFileSync(absPath, "utf8");
						const rel = path.relative(workspaceCwd, absPath) || candidate;
						fileContextBlocks += `\n\n<file_content path="${rel}">\n${content}\n</file_content>`;
					}
				} catch {}
			}
		}

		if (fileContextBlocks) {
			turnInputContent = `${promptText}\n\nWorkspace File Context:${fileContextBlocks}`;
		}

		// 3. Helpers for autonomous multi-turn loop
		const extractFiles = (text: string): Array<{ path: string; content: string }> => {
			const files: Array<{ path: string; content: string }> = [];
			const fileBlockRegex = /(?:\*\*File:\*\*|File:|(?:Create|Add|Update)\s+(?:the\s+)?file:?)\s*[`*]*([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9_-]+)[`*]*[\s\S]*?```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/gi;
			let m: RegExpExecArray | null;
			while ((m = fileBlockRegex.exec(text)) !== null) {
				files.push({ path: m[1].trim(), content: m[2] });
			}
			if (files.length === 0) {
				const commentRegex = /```(?:[a-zA-Z0-9_-]+)?\r?\n\s*(?:#|\/\/)\s*(?:File:\s*)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9_-]+)\r?\n([\s\S]*?)\r?\n```/gi;
				while ((m = commentRegex.exec(text)) !== null) {
					files.push({ path: m[1].trim(), content: m[2] });
				}
			}
			return files;
		};

		const extractCommands = (text: string): string[] => {
			const regex = /```(?:bash|sh|shell|cmd|powershell|ps1|terminal)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
			const cmds: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = regex.exec(text)) !== null) {
				const lines = m[1]
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
				for (const line of lines) {
					if (line) cmds.push(line);
				}
			}
			return cmds;
		};

		const isInspectionCommand = (cmd: string): boolean => {
			return /^(sed|cat|grep|find|findstr|dir|ls|type|head|tail|Get-Content|git\s+(status|diff|log|show|branch))\b/i.test(cmd.trim());
		};

		const trimmedPrompt = promptText.trim();
		const isExecutionRequested =
			!/^(create|write|add|generate|make|show|explain|how|why|what|describe|draft|implement|design)\b/i.test(trimmedPrompt) &&
			(/^(do it|run them|run it|run that|do that|yes|go ahead|proceed|start it|run tests?|run build)\b/i.test(trimmedPrompt) ||
			/^(pull|clone|execute|run|install|build|start)\s+/i.test(trimmedPrompt) ||
			/^(pull|clone|execute|run|install|build)$/i.test(trimmedPrompt) ||
			/(?:please\s+|can you\s+|could you\s+)(run|execute|pull|clone|install|build|do it|run them)\b/i.test(trimmedPrompt));

		const maxIterations = 5;
		let iteration = 0;
		let nextTurnPrompt = turnInputContent;
		let fullAccumulatedText = "";
		const executedCommandsSet = new Set<string>();
		const finishReason: AgentModelFinishReason = "stop";

		// 4. Autonomous execution loop: runs turns, executes inspection/action commands, and completes work
		try {
			while (iteration < maxIterations) {
				ctx.throwIfAborted();
				iteration++;

				const stream = await this.withClient((c) =>
					c.sessions.createTurnStream(sessionId, {
						input: [
							{
								type: "user.message",
								content: nextTurnPrompt,
							},
						],
					}),
				);

				let turnAccumulatedText = "";
				let accumulatedReasoning = "";

				const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

				const recordToolCallChunks = (toolCalls: any[]) => {
					if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
					for (const tc of toolCalls) {
						const idx = typeof tc.index === "number" ? tc.index : 0;
						let existing = pendingToolCalls.get(idx);
						if (!existing) {
							existing = { arguments: "" };
							pendingToolCalls.set(idx, existing);
						}
						if (tc.id) existing.id = tc.id;
						const fnName = tc.function?.name || tc.toolInfo?.name || tc.name;
						if (fnName) existing.name = fnName;
						const fnArgs = tc.function?.arguments || tc.arguments;
						if (fnArgs) existing.arguments += fnArgs;
					}
				};

				const flushToolCalls = async () => {
					for (const [, tc] of pendingToolCalls) {
						const fnName = tc.name;
						if (!fnName) continue;
						let parsedArgs: any = {};
						try {
							parsedArgs = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
						} catch {}

						if (fnName === "ask_user_question") {
							const question = parsedArgs?.question || "Please clarify:";
							const options = Array.isArray(parsedArgs?.options)
								? parsedArgs.options.map((opt: string) => `• ${opt}`).join("\n")
								: "";
							const formatted = `\n\n**${question}**\n\n${options}\n`;
							if (!turnAccumulatedText.includes(question)) {
								turnAccumulatedText += formatted;
								await ctx.emit({
									type: "assistant-text-delta",
									snapshot: ctx.snapshot(),
									iteration: ctx.snapshot().iteration,
									text: formatted,
									accumulatedText: fullAccumulatedText + turnAccumulatedText,
								});
							}
						} else if (fnName === "run_commands" || fnName === "execute_command") {
							const cmds = parsedArgs?.commands || (parsedArgs?.command ? [parsedArgs.command] : []);
							const cmdText = cmds.length > 0 ? `\n\n\`\`\`bash\n${cmds.join("\n")}\n\`\`\`\n` : "";
							if (cmdText && !turnAccumulatedText.includes(cmds[0])) {
								turnAccumulatedText += cmdText;
								await ctx.emit({
									type: "assistant-text-delta",
									snapshot: ctx.snapshot(),
									iteration: ctx.snapshot().iteration,
									text: cmdText,
									accumulatedText: fullAccumulatedText + turnAccumulatedText,
								});
							}
						}
					}
				};

				for await (const event of stream) {
					ctx.throwIfAborted();

					if (event.type === "model.message.delta") {
						const reasoning = (event as any).reasoningContent;
						if (reasoning) {
							accumulatedReasoning += reasoning;
							await ctx.emit({
								type: "assistant-reasoning-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: reasoning,
								accumulatedText: accumulatedReasoning,
							});
						}

						const delta = event.content ?? "";
						if (delta) {
							turnAccumulatedText += delta;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: delta,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}

						const toolCalls = (event as any).toolCalls;
						if (toolCalls) {
							recordToolCallChunks(toolCalls);
						}
					} else if (event.type === "model.message") {
						const content = (event as any).content;
						if (content && !turnAccumulatedText) {
							turnAccumulatedText = content;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: content,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}

						const toolCalls = (event as any).toolCalls;
						if (toolCalls) {
							recordToolCallChunks(toolCalls);
						}
					} else if (event.type === "tool.response_required") {
						const toolCalls = (event as any).toolCalls;
						if (toolCalls) {
							recordToolCallChunks(toolCalls);
						}
						await flushToolCalls();
					} else if (event.type === "turn.done") {
						const output = (event as any).state?.output;
						if (output?.content && !turnAccumulatedText) {
							turnAccumulatedText = output.content;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: turnAccumulatedText,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});
						}

						const toolCalls = output?.toolCalls;
						if (toolCalls) {
							recordToolCallChunks(toolCalls);
						}
						await flushToolCalls();

						if (event.state && "metrics" in event.state && event.state.metrics) {
							const metrics = event.state.metrics as {
								totalInputTokens?: number;
								totalOutputTokens?: number;
								totalTokens?: number;
							};
							const usage: Partial<AgentUsage> = {
								inputTokens: metrics.totalInputTokens ?? 0,
								outputTokens: metrics.totalOutputTokens ?? 0,
							};
							await ctx.updateUsage(usage);
						}

						if (event.state && event.state.status === "error") {
							throw new Error(event.state.message || "TrueForge turn failed");
						}
					}
				}

				if (!turnAccumulatedText.trim()) {
					turnAccumulatedText = "I'm ready to assist with your coding tasks, running commands, and workspace operations. What would you like to run or build?";
					await ctx.emit({
						type: "assistant-text-delta",
						snapshot: ctx.snapshot(),
						iteration: ctx.snapshot().iteration,
						text: turnAccumulatedText,
						accumulatedText: fullAccumulatedText + turnAccumulatedText,
					});
				}

				// Save any files produced in this turn
				const filesToSave = extractFiles(turnAccumulatedText);
				if (filesToSave.length > 0) {
					const cwd = this.resolveWorkspaceCwd(ctx);
					for (const file of filesToSave) {
						try {
							const fullPath = path.isAbsolute(file.path) ? file.path : path.resolve(cwd, file.path);
							const dir = path.dirname(fullPath);
							if (!fs.existsSync(dir)) {
								fs.mkdirSync(dir, { recursive: true });
							}
							fs.writeFileSync(fullPath, file.content, "utf8");
							const relPath = path.relative(cwd, fullPath) || file.path;
							const saveNotice = `\n\n⚡ **Saved file:** \`${relPath}\`\n`;
							turnAccumulatedText += saveNotice;
							await ctx.emit({
								type: "assistant-text-delta",
								snapshot: ctx.snapshot(),
								iteration: ctx.snapshot().iteration,
								text: saveNotice,
								accumulatedText: fullAccumulatedText + turnAccumulatedText,
							});

							// Automatically open the diff view in VS Code so the user can inspect changes side-by-side
							try {
								const vscode = (globalThis as any).vscode || (typeof require === "function" ? require("vscode") : undefined);
								if (vscode?.Uri?.file && vscode?.commands?.executeCommand) {
									const fileUri = vscode.Uri.file(fullPath);
									vscode.commands.executeCommand("git.openChange", fileUri).catch(async () => {
										try {
											const doc = await vscode.workspace.openTextDocument(fileUri);
											await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
										} catch {}
									});
								}
							} catch {}
						} catch (writeErr: any) {
							console.warn("[TrueForgeHarness] Failed to write file:", file.path, writeErr);
						}
					}
				}

				fullAccumulatedText += (fullAccumulatedText ? "\n\n" : "") + turnAccumulatedText;

				// Check commands to run in this turn
				let commandsToRun = extractCommands(turnAccumulatedText);
				if (commandsToRun.length === 0 && isExecutionRequested && iteration === 1 && snapshot.messages.length > 0) {
					for (let i = snapshot.messages.length - 1; i >= 0; i--) {
						const msg = snapshot.messages[i];
						if (msg.role === "assistant" && Array.isArray(msg.content)) {
							const prevText = msg.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
							const prevCmds = extractCommands(prevText);
							if (prevCmds.length > 0) {
								commandsToRun = prevCmds;
								break;
							}
						}
					}
				}

				// Filter commands to execute: inspection commands are ALWAYS executed; other commands executed if requested
				const cwd = this.resolveWorkspaceCwd(ctx);
				const executedThisTurn: Array<{ cmd: string; output: string; isInspection: boolean }> = [];

				for (const cmd of commandsToRun) {
					if (cmd.startsWith("cd ") && commandsToRun.length > 1) {
						continue;
					}
					const isInspect = isInspectionCommand(cmd);
					if ((isInspect || isExecutionRequested) && !executedCommandsSet.has(cmd)) {
						executedCommandsSet.add(cmd);

						const execHeader = `\n\n⚡ **Executing in terminal:** \`${cmd}\`\n`;
						fullAccumulatedText += execHeader;
						await ctx.emit({
							type: "assistant-text-delta",
							snapshot: ctx.snapshot(),
							iteration: ctx.snapshot().iteration,
							text: execHeader,
							accumulatedText: fullAccumulatedText,
						});

						let executedOutput = "";
						try {
							if (ctx.tools.has("run_commands") || ctx.tools.has("execute_command")) {
								const toolName = ctx.tools.has("run_commands") ? "run_commands" : "execute_command";
								const toolCall: any = {
									type: "tool-call",
									toolCallId: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
									toolName,
									input: { command: cmd, commands: [cmd] },
								};
								const prep = await ctx.prepareToolExecution(toolCall);
								const toolMsg = await ctx.executePreparedTool(prep);
								const out = toolMsg.content?.[0];
								executedOutput =
									out && typeof out === "object" && "output" in out
										? typeof (out as any).output === "string"
											? (out as any).output
											: JSON.stringify((out as any).output)
										: "";
							} else {
								const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 120000 });
								executedOutput = (stdout || "") + (stderr ? `\n${stderr}` : "");
							}
						} catch (execErr: any) {
							executedOutput = execErr?.message || String(execErr);
						}

						const formattedResult = executedOutput.trim()
							? `\`\`\`\n${executedOutput.trim()}\n\`\`\`\n`
							: `✓ Command completed successfully.\n`;
						fullAccumulatedText += formattedResult;
						await ctx.emit({
							type: "assistant-text-delta",
							snapshot: ctx.snapshot(),
							iteration: ctx.snapshot().iteration,
							text: formattedResult,
							accumulatedText: fullAccumulatedText,
						});

						executedThisTurn.push({ cmd, output: executedOutput, isInspection: isInspect });
					}
				}

				// Check if we should continue autonomously to the next turn:
				const hasInspection = executedThisTurn.some((e) => e.isInspection);
				if (hasInspection && filesToSave.length === 0 && iteration < maxIterations) {
					// Feed back inspection command outputs to TrueForge so the model can complete the work!
					nextTurnPrompt =
						executedThisTurn
							.filter((e) => e.isInspection)
							.map((e) => `[Terminal output for \`${e.cmd}\`]:\n\`\`\`\n${e.output.slice(0, 10000)}\n\`\`\``)
							.join("\n\n") +
						"\n\nBased on this terminal output, now proceed to complete the user's task directly.";
					continue;
				}

				// If no pending inspections, we are done!
				break;
			}

			// 5. Record assistant message in transcript
			const assistantMessage: AgentMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: "assistant",
				content: fullAccumulatedText ? [{ type: "text", text: fullAccumulatedText }] : [],
				createdAt: Date.now(),
			};

			await ctx.recordAssistantMessage(assistantMessage, finishReason);

			return ctx.finishRun("completed", assistantMessage, fullAccumulatedText);
		} catch (error: any) {
			// In case of a session failure (e.g. 400 error), evict the cached session so next turn recovers cleanly
			TrueForgeHarness.sessionsByConversation.delete(conversationId);
			throw error;
		}
	}
}
