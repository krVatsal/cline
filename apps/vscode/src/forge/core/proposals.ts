import * as crypto from "node:crypto";
import { normalizeToLf, normalizePath } from "./eol";
import { computeHunks, Hunk } from "./hunks";

export interface EditOperation {
	old_text: string;
	new_text: string;
}

export interface ProposeEditInput {
	path: string;
	edits: EditOperation[];
}

export interface ProposeWriteInput {
	path: string;
	content: string;
}

export interface ProposalResult {
	relativePath: string;
	proposedContentLF: string;
	hunks: Hunk[];
	hash: string;
}

/**
 * Computes a SHA-256 fingerprint for a proposal:
 * sha256(relativePath + "\0" + proposedTextLF)
 */
export function computeProposalHash(relativePath: string, proposedTextLF: string): string {
	const normalizedRelPath = normalizePath(relativePath);
	const normalizedContent = normalizeToLf(proposedTextLF);
	return crypto
		.createHash("sha256")
		.update(`${normalizedRelPath}\0${normalizedContent}`)
		.digest("hex");
}

/**
 * Applies sequential text replacements to currentContent using function-form replacement.
 * Function-form replacement `str.replace(target, () => replacement)` guarantees
 * special replacement patterns like $1, $&, $', etc. are treated literally.
 */
export function applyEdits(
	currentContent: string,
	edits: EditOperation[],
): { content: string; error?: string } {
	let content = normalizeToLf(currentContent);

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		let oldText = normalizeToLf(edit.old_text);
		let newText = normalizeToLf(edit.new_text);

		if (!content.includes(oldText)) {
			// Fallback: check if the model included line number prefixes like "  1 | " or "1 | "
			const strippedOld = oldText.replace(/^\s*\d+\s*\|\s*/gm, "");
			const strippedNew = newText.replace(/^\s*\d+\s*\|\s*/gm, "");
			if (content.includes(strippedOld)) {
				oldText = strippedOld;
				newText = strippedNew;
			} else {
				return {
					content,
					error: `Edit at index ${i} failed: target text not found in document:\n"${edit.old_text.slice(0, 100)}"`,
				};
			}
		}

		// Ensure target text is unambiguous (appears exactly once in content)
		const firstIdx = content.indexOf(oldText);
		const secondIdx = content.indexOf(oldText, firstIdx + 1);
		if (secondIdx !== -1) {
			return {
				content,
				error: `Edit at index ${i} is ambiguous: target text appears multiple times. Provide more surrounding context.`,
			};
		}

		// Function-form replacement
		content = content.replace(oldText, () => newText);
	}

	return { content };
}

/**
 * Creates an edit proposal for an existing file.
 */
export function createEditProposal(
	relativePath: string,
	currentContent: string,
	edits: EditOperation[],
): { result?: ProposalResult; error?: string } {
	const currentLf = normalizeToLf(currentContent);
	const editResult = applyEdits(currentLf, edits);

	if (editResult.error) {
		return { error: editResult.error };
	}

	const proposedContentLF = editResult.content;
	const hunks = computeHunks(currentLf, proposedContentLF);
	const hash = computeProposalHash(relativePath, proposedContentLF);

	return {
		result: {
			relativePath: normalizePath(relativePath),
			proposedContentLF,
			hunks,
			hash,
		},
	};
}

/**
 * Creates a write proposal for a new file.
 * Returns an error if the file already exists (existing files must be modified via propose_edit).
 */
export function createWriteProposal(
	relativePath: string,
	content: string,
	fileExists: boolean,
): { result?: ProposalResult; error?: string } {
	if (fileExists) {
		return {
			error: `File "${relativePath}" already exists. Use propose_edit to modify existing files.`,
		};
	}

	const proposedContentLF = normalizeToLf(content);
	const hunks = computeHunks("", proposedContentLF);
	const hash = computeProposalHash(relativePath, proposedContentLF);

	return {
		result: {
			relativePath: normalizePath(relativePath),
			proposedContentLF,
			hunks,
			hash,
		},
	};
}
