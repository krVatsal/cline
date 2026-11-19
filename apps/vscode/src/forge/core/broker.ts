/**
 * Review Broker for Forge.
 * Enforces the critical invariant:
 * "Nothing is ever written to disk without a recorded user approval.
 *  Writes come only from an approved propose_* tool call."
 *
 * Stores user approvals in-memory keyed by sha256(relativePath + "\0" + proposedTextLF).
 * Approvals are single-use and expire after 10 minutes (600,000 ms).
 */

import { forgeLogger } from "./logger";

export interface ApprovalEntry {
	key: string;
	acceptedHunkIds: string[];
	createdAt: number;
}

export const DEFAULT_APPROVAL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export class ReviewBroker {
	private readonly approvals = new Map<string, ApprovalEntry>();
	private readonly expiryMs: number;

	constructor(expiryMs: number = DEFAULT_APPROVAL_EXPIRY_MS) {
		this.expiryMs = expiryMs;
	}

	/**
	 * Records a user approval for a specific proposal hash.
	 */
	recordApproval(key: string, acceptedHunkIds: string[]): void {
		this.cleanExpired();
		this.approvals.set(key, {
			key,
			acceptedHunkIds: [...acceptedHunkIds],
			createdAt: Date.now(),
		});
		forgeLogger.log(`[ReviewBroker] Recorded approval for hash=${key}, hunks=${JSON.stringify(acceptedHunkIds)}`);
	}

	/**
	 * Checks if an unexpired approval exists for the given key without consuming it.
	 */
	hasApproval(key: string): boolean {
		this.cleanExpired();
		const entry = this.approvals.get(key);
		if (!entry) return false;
		if (Date.now() - entry.createdAt > this.expiryMs) {
			this.approvals.delete(key);
			return false;
		}
		return true;
	}

	/**
	 * Consumes a recorded approval (SINGLE-USE).
	 * If valid and not expired, returns the accepted hunk IDs and immediately DELETES the entry.
	 * If not found or expired, returns null.
	 */
	consumeApproval(key: string): { acceptedHunkIds: string[] } | null {
		this.cleanExpired();
		const entry = this.approvals.get(key);
		if (!entry) {
			return null;
		}

		if (Date.now() - entry.createdAt > this.expiryMs) {
			this.approvals.delete(key);
			return null;
		}

		// Single-use: delete immediately
		this.approvals.delete(key);
		forgeLogger.log(`[ReviewBroker] Consumed approval for hash=${key}`);
		return { acceptedHunkIds: entry.acceptedHunkIds };
	}

	/**
	 * Revokes/deletes an approval.
	 */
	revokeApproval(key: string): boolean {
		return this.approvals.delete(key);
	}

	/**
	 * Clears all approvals.
	 */
	clear(): void {
		this.approvals.clear();
	}

	/**
	 * Returns current number of active approvals.
	 */
	size(): number {
		this.cleanExpired();
		return this.approvals.size;
	}

	private cleanExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this.approvals.entries()) {
			if (now - entry.createdAt > this.expiryMs) {
				this.approvals.delete(key);
			}
		}
	}
}

// Global default singleton instance
export const reviewBroker = new ReviewBroker();
