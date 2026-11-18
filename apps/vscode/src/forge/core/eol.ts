/**
 * EOL handling utilities for Forge.
 * Normalizes text to LF for model viewing and diffing,
 * and restores original line endings (CRLF or LF) on disk write.
 */

export type EolType = "\r\n" | "\n";

/**
 * Detect the dominant EOL in the provided string.
 * Defaults to "\n" if text has no newlines or CRLF count <= LF count.
 */
export function detectEol(text: string): EolType {
	const crlfCount = (text.match(/\r\n/g) || []).length;
	const lfOnlyCount = (text.match(/[^\r]\n/g) || []).length;
	return crlfCount > lfOnlyCount ? "\r\n" : "\n";
}

/**
 * Normalizes all line endings in text to LF ("\n").
 */
export function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Restores the target EOL on a text string that was normalized to LF.
 */
export function restoreEol(text: string, targetEol: EolType): string {
	const lfNormalized = normalizeToLf(text);
	if (targetEol === "\r\n") {
		return lfNormalized.replace(/\n/g, "\r\n");
	}
	return lfNormalized;
}

/**
 * Normalizes file paths to use forward slashes and strips redundant leading/trailing separators.
 */
export function normalizePath(filePath: string): string {
	const forwardSlashes = filePath.replace(/\\/g, "/");
	// Remove leading './' if present
	const stripped = forwardSlashes.replace(/^\.\//, "");
	return stripped;
}
