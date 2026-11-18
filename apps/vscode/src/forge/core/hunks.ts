import { diffLines, Change } from "diff";
import { normalizeToLf } from "./eol";

export interface Hunk {
	id: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	oldContent: string;
	newContent: string;
	type: "insert" | "delete" | "modify";
}

/**
 * Computes context-free diff hunks between oldText and newText.
 * Operates on LF-normalized text to avoid CRLF mismatch artifacts.
 */
export function computeHunks(oldText: string, newText: string): Hunk[] {
	const oldLf = normalizeToLf(oldText);
	const newLf = normalizeToLf(newText);

	if (oldLf === newLf) {
		return [];
	}

	const changes: Change[] = diffLines(oldLf, newLf);
	const hunks: Hunk[] = [];

	let oldLine = 1;
	let newLine = 1;
	let hunkIndex = 0;

	for (let i = 0; i < changes.length; i++) {
		const change = changes[i];

		if (!change.added && !change.removed) {
			const count = change.count ?? getLineCount(change.value);
			oldLine += count;
			newLine += count;
			continue;
		}

		// Group contiguous removed and/or added blocks into a single hunk
		let oldContent = "";
		let newContent = "";
		let oldStart = oldLine;
		let newStart = newLine;
		let removedCount = 0;
		let addedCount = 0;

		while (i < changes.length && (changes[i].added || changes[i].removed)) {
			const curr = changes[i];
			const count = curr.count ?? getLineCount(curr.value);
			if (curr.removed) {
				oldContent += curr.value;
				removedCount += count;
				oldLine += count;
			} else if (curr.added) {
				newContent += curr.value;
				addedCount += count;
				newLine += count;
			}
			i++;
		}
		// Step back one since outer for-loop will increment i
		i--;

		let type: "insert" | "delete" | "modify" = "modify";
		if (removedCount === 0 && addedCount > 0) {
			type = "insert";
		} else if (removedCount > 0 && addedCount === 0) {
			type = "delete";
		}

		hunks.push({
			id: `hunk-${hunkIndex++}`,
			oldStart,
			oldLines: removedCount,
			newStart,
			newLines: addedCount,
			oldContent,
			newContent,
			type,
		});
	}

	return hunks;
}

/**
 * Applies a chosen subset of hunks to oldText.
 * For any hunk whose ID is NOT in acceptedIds, the change is rejected (oldContent remains).
 * For any hunk whose ID IS in acceptedIds, newContent is applied.
 */
export function applyHunks(
	oldText: string,
	hunks: Hunk[],
	acceptedIds: Set<string> | string[],
): string {
	const acceptedSet = acceptedIds instanceof Set ? acceptedIds : new Set(acceptedIds);

	if (hunks.length === 0) {
		return oldText;
	}

	const oldLf = normalizeToLf(oldText);
	// Split lines keeping line terminators or reconstruct line by line
	// We split by \n, keeping empty lines
	const oldLines = oldLf.split("\n");

	// Sort hunks by oldStart ascending
	const sortedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

	let result = "";
	let currentOldLine = 1; // 1-based line index in oldText

	for (const hunk of sortedHunks) {
		// Output unchanged lines between currentOldLine and hunk.oldStart
		while (currentOldLine < hunk.oldStart) {
			const lineIdx = currentOldLine - 1;
			if (lineIdx < oldLines.length) {
				result += (result.length > 0 || lineIdx > 0 ? "" : "") + oldLines[lineIdx] + (lineIdx < oldLines.length - 1 ? "\n" : "");
			}
			currentOldLine++;
		}

		const isAccepted = acceptedSet.has(hunk.id);
		if (isAccepted) {
			result += hunk.newContent;
		} else {
			result += hunk.oldContent;
		}

		// Advance currentOldLine by the number of old lines consumed by this hunk
		currentOldLine += hunk.oldLines;
	}

	// Output any remaining lines after the last hunk
	while (currentOldLine - 1 < oldLines.length) {
		const lineIdx = currentOldLine - 1;
		result += oldLines[lineIdx];
		if (lineIdx < oldLines.length - 1) {
			result += "\n";
		}
		currentOldLine++;
	}

	return result;
}

function getLineCount(str: string): number {
	if (!str) return 0;
	const matches = str.match(/\n/g);
	return matches ? matches.length : 1;
}
