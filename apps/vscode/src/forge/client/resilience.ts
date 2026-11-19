import { forgeLogger } from "../core/logger";

export type TurnErrorType = "RETRYABLE" | "MODEL_FATAL" | "OTHER_FATAL";

/**
 * Classifies TrueForge turn errors according to Phase C1 requirements:
 * - RETRYABLE: HTTP 429, 502, 503, 504; socket hangup, ECONNRESET, ETIMEDOUT; rate limit/quota/overloaded/timeout/temporary
 * - MODEL_FATAL: model not found, invalid model, unsupported model, HTTP 400 with model message
 * - OTHER_FATAL: 401, 403, unparseable response, etc.
 */
export function classifyTurnError(error: any): TurnErrorType {
	const message = (error?.message || error?.state?.message || String(error)).toLowerCase();
	const status = error?.status || error?.statusCode || error?.response?.status;

	// Check status codes
	if (status === 429 || status === 502 || status === 503 || status === 504) {
		return "RETRYABLE";
	}
	if (status === 401 || status === 403) {
		return "OTHER_FATAL";
	}

	// Check for MODEL_FATAL
	if (
		/model .* not found/i.test(message) ||
		/model not found/i.test(message) ||
		/invalid model/i.test(message) ||
		/unsupported model/i.test(message) ||
		/does not exist/i.test(message) ||
		/model.*unknown/i.test(message) ||
		(status === 400 && /model/i.test(message))
	) {
		return "MODEL_FATAL";
	}

	// Check for RETRYABLE
	if (
		/rate.?limit/i.test(message) ||
		/429/.test(message) ||
		/quota/i.test(message) ||
		/overloaded/i.test(message) ||
		/timeout/i.test(message) ||
		/timed.?out/i.test(message) ||
		/temporary/i.test(message) ||
		/socket hang up/i.test(message) ||
		/econnreset/i.test(message) ||
		/etimedout/i.test(message) ||
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
 * Computes exponential backoff delay with jitter (C2).
 * initial: 1.5s, factor: 2, max: 10s
 */
export function computeBackoffDelay(
	attempt: number,
	initialDelayMs = 1500,
	factor = 2,
	maxDelayMs = 10000,
): number {
	const expDelay = initialDelayMs * Math.pow(factor, attempt - 1);
	const cappedDelay = Math.min(expDelay, maxDelayMs);
	const jitter = Math.floor(Math.random() * 500);
	return cappedDelay + jitter;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			return reject(new Error("Aborted while waiting"));
		}
		const timer = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(new Error("Aborted while waiting"));
				},
				{ once: true },
			);
		}
	});
}
