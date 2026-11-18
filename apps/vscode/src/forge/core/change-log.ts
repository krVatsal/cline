/**
 * Change Log for Forge.
 * Maintains a stack of applied file changes to support "Undo last Forge change".
 */

export interface ChangeRecord {
	filePath: string; // Absolute resolved path on disk
	relativePath: string;
	beforeText: string | null; // null if file was newly created
	afterText: string | null; // null if file was deleted
	timestamp: number;
	description?: string;
}

export class ChangeLog {
	private readonly stack: ChangeRecord[] = [];
	private readonly maxRecords: number;

	constructor(maxRecords: number = 100) {
		this.maxRecords = maxRecords;
	}

	pushChange(record: Omit<ChangeRecord, "timestamp">): void {
		this.stack.push({
			...record,
			timestamp: Date.now(),
		});
		if (this.stack.length > this.maxRecords) {
			this.stack.shift();
		}
	}

	popChange(): ChangeRecord | undefined {
		return this.stack.pop();
	}

	peekChange(): ChangeRecord | undefined {
		return this.stack[this.stack.length - 1];
	}

	canUndo(): boolean {
		return this.stack.length > 0;
	}

	clear(): void {
		this.stack.length = 0;
	}

	size(): number {
		return this.stack.length;
	}

	getAll(): readonly ChangeRecord[] {
		return this.stack;
	}
}

export const changeLog = new ChangeLog();
