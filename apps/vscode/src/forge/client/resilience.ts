import { forgeLogger } from "../core/logger";

export type TurnErrorType =
	| "RETRYABLE"
	| "AUTH"
	| "NETWORK"
	| "MODEL_FATAL"
	| "TRUEFORGE_DOWN"
	| "OTHER_FATAL";

/**
 * Classifies turn errors according to Task C requirements:
 * - AUTH: 401, 403, "invalid api key", "unauthorized", "authentication"
 * - NETWORK: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, "fetch failed", "connection refused" from model endpoint (e.g. "[Model Error] ...")
 * - TRUEFORGE_DOWN: the SDK call to the TrueForge base URL itself fails
 * - MODEL_FATAL: model not found, invalid model, unsupported model, HTTP 400 with model message, tool call schema validation failure
 * - RETRYABLE: HTTP 429, 502, 503, 504; socket hangup, ECONNRESET; rate limit, quota, overloaded, timeout, temporary
 * - OTHER_FATAL: other non-retryable errors
 */
export function classifyTurnError(error: any, isTrueForgeDirectCall: boolean = false): TurnErrorType {
	const message = (error?.message || error?.state?.message || String(error)).toLowerCase();
	const status = error?.status || error?.statusCode || error?.response?.status;
	const code = (error?.code || error?.cause?.code || "").toLowerCase();

	// 1. AUTH: 401, 403, "invalid api key", "unauthorized", "authentication"
	if (
		status === 401 ||
		status === 403 ||
		/invalid.?api.?key/i.test(message) ||
		/unauthorized/i.test(message) ||
		/authentication/i.test(message) ||
		/auth.*fail/i.test(message) ||
		/permission.*denied/i.test(message)
	) {
		return "AUTH";
	}

	// 2. TRUEFORGE_DOWN vs NETWORK:
	const isConnectionIssue =
		code === "econnrefused" ||
		code === "enotfound" ||
		code === "etimedout" ||
		/fetch failed/i.test(message) ||
		/econnrefused/i.test(message) ||
		/enotfound/i.test(message) ||
		/etimedout/i.test(message) ||
		/connection refused/i.test(message) ||
		/cannot connect to api/i.test(message);

	if (isConnectionIssue) {
		// When it comes from the model endpoint, TrueForge wraps it in a turn.done error message like "[Model Error] ..."
		if (
			/\[model error\]/i.test(message) ||
			/model.*endpoint/i.test(message) ||
			/cannot connect to api/i.test(message)
		) {
			return "NETWORK";
		}
		// If it is a direct SDK call failure or TrueForge server not reachable
		if (isTrueForgeDirectCall || /8790/.test(message) || /trueforge/i.test(message) || !message.includes("[model")) {
			return "TRUEFORGE_DOWN";
		}
		return "NETWORK";
	}

	// 3. MODEL_FATAL
	if (
		/model .* not found/i.test(message) ||
		/model not found/i.test(message) ||
		/invalid model/i.test(message) ||
		/unsupported model/i.test(message) ||
		/does not exist/i.test(message) ||
		/model.*unknown/i.test(message) ||
		(status === 400 && /model/i.test(message)) ||
		/tool call validation failed/i.test(message)
	) {
		return "MODEL_FATAL";
	}

	// 4. RETRYABLE
	if (
		status === 429 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		/rate.?limit/i.test(message) ||
		/429/.test(message) ||
		/quota/i.test(message) ||
		/overloaded/i.test(message) ||
		/timeout/i.test(message) ||
		/timed.?out/i.test(message) ||
		/temporary/i.test(message) ||
		/socket hang up/i.test(message) ||
		/econnreset/i.test(message) ||
		/too many requests/i.test(message) ||
		/502/.test(message) ||
		/503/.test(message) ||
		/504/.test(message)
	) {
		return "RETRYABLE";
	}

	return "OTHER_FATAL";
}

/**
 * Computes exponential backoff delay with jitter.
 * If the error message specifies "Please try again in X s", respects that delay.
 */
export function computeBackoffDelay(attempt: number, error?: any): number {
	const message = (error?.message || error?.state?.message || String(error || "")).toLowerCase();
	const retryMatch = message.match(/try again in\s+([\d.]+)\s*s/i);
	if (retryMatch) {
		const delaySec = parseFloat(retryMatch[1]);
		if (!isNaN(delaySec) && delaySec > 0 && delaySec <= 30) {
			return Math.ceil(delaySec * 1000) + 500;
		}
	}

	const baseDelayMs = 1500;
	const factor = 2;
	const maxDelayMs = 10000;
	const delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
	const jitter = Math.floor(Math.random() * 500);
	return delay + jitter;
}

/**
 * Strips stack traces and formats a clean error string suitable for the UI.
 */
export function cleanErrorMessage(msg: string): string {
	if (!msg) return "Unknown error";
	const firstLine = msg.split("\n")[0].trim();
	return firstLine.replace(/^Error:\s*/, "");
}

/**
 * Asynchronously sleeps for the given milliseconds, respecting an optional AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation cancelled"));
			return;
		}

		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const abortListener = () => {
			cleanup();
			reject(new Error("Operation cancelled"));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortListener);
		};

		signal?.addEventListener("abort", abortListener, { once: true });
	});
}
