import * as vscode from "vscode"
import { diffLines } from "diff"
import { Logger } from "@/shared/services/Logger"

export interface DiffHunk {
	id: number
	originalStart: number
	originalText: string
	originalLineCount: number
	newStart: number
	newText: string
	newLineCount: number
}

export interface ActiveFileReview {
	uri: vscode.Uri
	originalContent: string
	newContent: string
	hunks: DiffHunk[]
	acceptedHunkIds?: number[]
	onDecision?: (decision: { allow: boolean; acceptedHunkIds?: string[]; denyReason?: string }) => void
}

/**
 * Computes difference hunks between originalText and newText.
 */
export function computeHunks(originalText: string, newText: string): DiffHunk[] {
	const diff = diffLines(originalText, newText)
	const hunks: DiffHunk[] = []
	let origLine = 0
	let newLine = 0

	let i = 0
	while (i < diff.length) {
		const part = diff[i]
		if (!part.added && !part.removed) {
			origLine += part.count ?? 0
			newLine += part.count ?? 0
			i++
			continue
		}

		const hunk: DiffHunk = {
			id: hunks.length + 1,
			originalStart: origLine,
			originalText: "",
			originalLineCount: 0,
			newStart: newLine,
			newText: "",
			newLineCount: 0,
		}

		while (i < diff.length && (diff[i].added || diff[i].removed)) {
			const cur = diff[i]
			if (cur.removed) {
				hunk.originalText += cur.value
				hunk.originalLineCount += cur.count ?? 0
				origLine += cur.count ?? 0
			} else if (cur.added) {
				hunk.newText += cur.value
				hunk.newLineCount += cur.count ?? 0
				newLine += cur.count ?? 0
			}
			i++
		}

		hunks.push(hunk)
	}

	return hunks
}

export class InlineDiffReviewController implements vscode.CodeLensProvider, vscode.Disposable {
	private static instance: InlineDiffReviewController | undefined

	private readonly activeReviews = new Map<string, ActiveFileReview>()
	private readonly disposables: vscode.Disposable[] = []

	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>()
	readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event

	private readonly addedDecorationType: vscode.TextEditorDecorationType
	private readonly deletedIndicatorDecorationType: vscode.TextEditorDecorationType

	private constructor() {
		// Decoration for inserted/modified lines: subtle green tint with bold green left gutter border
		this.addedDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(46, 160, 67, 0.15)",
			isWholeLine: true,
			overviewRulerColor: "rgba(46, 160, 67, 0.8)",
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			border: "1px solid rgba(46, 160, 67, 0.35)",
			borderWidth: "1px 1px 1px 4px",
		})

		// Decoration for deletion indicator (when lines were deleted at a position)
		this.deletedIndicatorDecorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			overviewRulerColor: "rgba(248, 81, 73, 0.8)",
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			border: "1px dashed rgba(248, 81, 73, 0.8)",
			borderWidth: "2px 0 0 0",
		})

		// Register CodeLens provider
		this.disposables.push(vscode.languages.registerCodeLensProvider({ scheme: "file" }, this))

		// Register commands
		this.disposables.push(
			vscode.commands.registerCommand("cline.inlineReview.acceptHunk", (uriStr: string, hunkId: number) =>
				this.acceptHunk(uriStr, hunkId),
			),
			vscode.commands.registerCommand("cline.inlineReview.rejectHunk", (uriStr: string, hunkId: number) =>
				this.rejectHunk(uriStr, hunkId),
			),
			vscode.commands.registerCommand("cline.inlineReview.acceptAll", (uriStr: string) => this.acceptAll(uriStr)),
			vscode.commands.registerCommand("cline.inlineReview.rejectAll", (uriStr: string) => this.rejectAll(uriStr)),
			vscode.commands.registerCommand(
				"cline.inlineReview.start",
				(fileUri: vscode.Uri, originalContent: string, newContent: string) =>
					this.startReview(fileUri, originalContent, newContent),
			),
		)

		// Keep decorations synced when editor tab switches
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.applyDecorationsToEditor(editor)
				}
			}),
		)

		this.disposables.push(this.addedDecorationType, this.deletedIndicatorDecorationType)
	}

	static getInstance(): InlineDiffReviewController {
		if (!InlineDiffReviewController.instance) {
			InlineDiffReviewController.instance = new InlineDiffReviewController()
		}
		return InlineDiffReviewController.instance
	}

	async startReview(
		fileUri: vscode.Uri,
		originalContent: string,
		newContent: string,
		onDecision?: (decision: { allow: boolean; acceptedHunkIds?: string[]; denyReason?: string }) => void,
	): Promise<void> {
		if (originalContent === newContent) {
			onDecision?.({ allow: true })
			return
		}

		const hunks = computeHunks(originalContent, newContent)
		if (hunks.length === 0) {
			onDecision?.({ allow: true })
			return
		}

		const uriStr = fileUri.toString()
		this.activeReviews.set(uriStr, {
			uri: fileUri,
			originalContent,
			newContent,
			hunks,
			acceptedHunkIds: [],
			onDecision,
		})

		try {
			const doc = await vscode.workspace.openTextDocument(fileUri)
			const editor = await vscode.window.showTextDocument(doc, { preview: false })

			// NOTE (Auto-Save Safety): We do NOT mutate the doc buffer before approval!
			// Leaving the buffer untouched guarantees:
			// 1) doc.isDirty remains false.
			// 2) files.autoSave ("afterDelay" or "onFocusChange") never flushes unapproved changes to disk.
			// 3) Git status remains completely clean while review is pending.
			// Changes are rendered visually via decorations and CodeLenses targeting hunk.originalStart.

			this.applyDecorationsToEditor(editor)
			this.onDidChangeCodeLensesEmitter.fire()

			if (hunks.length > 0) {
				const targetLine = Math.min(Math.max(0, hunks[0].originalStart), Math.max(0, doc.lineCount - 1))
				const pos = new vscode.Position(targetLine, 0)
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
			}
		} catch (error) {
			Logger.warn(`[InlineDiffReviewController] Failed to open review for ${fileUri.fsPath}: ${error}`)
		}
	}

	cancelAllReviews(reason: string = "User stopped operation"): void {
		for (const [uriStr, review] of this.activeReviews.entries()) {
			review.onDecision?.({ allow: false, denyReason: reason })
			this.clearDecorationsForUri(uriStr)
		}
		this.activeReviews.clear()
		this.onDidChangeCodeLensesEmitter.fire()
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const review = this.activeReviews.get(document.uri.toString())
		if (!review || review.hunks.length === 0) {
			return []
		}

		const codeLenses: vscode.CodeLens[] = []
		const uriStr = document.uri.toString()

		// Top of file: Accept All / Reject All
		const topRange = new vscode.Range(0, 0, 0, 0)
		codeLenses.push(
			new vscode.CodeLens(topRange, {
				title: "$(check-all) Accept All",
				tooltip: "Accept all proposed changes in this file",
				command: "cline.inlineReview.acceptAll",
				arguments: [uriStr],
			}),
			new vscode.CodeLens(topRange, {
				title: "$(discard) Reject All",
				tooltip: "Reject all proposed changes (disk remains unchanged)",
				command: "cline.inlineReview.rejectAll",
				arguments: [uriStr],
			}),
		)

		// Each hunk: Accept / Reject
		for (const hunk of review.hunks) {
			const targetLine = Math.min(Math.max(0, hunk.originalStart), Math.max(0, document.lineCount - 1))
			const hunkRange = new vscode.Range(targetLine, 0, targetLine, 0)

			codeLenses.push(
				new vscode.CodeLens(hunkRange, {
					title: `$(check) Accept Hunk #${hunk.id}`,
					tooltip: `Accept hunk #${hunk.id}`,
					command: "cline.inlineReview.acceptHunk",
					arguments: [uriStr, hunk.id],
				}),
				new vscode.CodeLens(hunkRange, {
					title: `$(close) Reject Hunk #${hunk.id}`,
					tooltip: `Reject hunk #${hunk.id}`,
					command: "cline.inlineReview.rejectHunk",
					arguments: [uriStr, hunk.id],
				}),
			)
		}

		return codeLenses
	}

	async acceptHunk(uriStr: string, hunkId: number): Promise<void> {
		const review = this.activeReviews.get(uriStr)
		if (!review) return

		const index = review.hunks.findIndex((h) => h.id === hunkId)
		if (index === -1) return

		if (!review.acceptedHunkIds) {
			review.acceptedHunkIds = []
		}
		review.acceptedHunkIds.push(hunkId)
		review.hunks.splice(index, 1)

		if (review.hunks.length === 0) {
			const onDecision = review.onDecision
			const accepted = review.acceptedHunkIds
			this.activeReviews.delete(uriStr)
			this.clearDecorationsForUri(uriStr)
			vscode.window.showInformationMessage("All changes accepted.")
			onDecision?.({ allow: true, acceptedHunkIds: accepted.map((id) => `hunk-${id - 1}`) })
		} else {
			this.updateDecorationsForUri(uriStr)
			vscode.window.setStatusBarMessage(`Hunk #${hunkId} accepted`, 2500)
		}

		this.onDidChangeCodeLensesEmitter.fire()
	}

	async rejectHunk(uriStr: string, hunkId: number): Promise<void> {
		const review = this.activeReviews.get(uriStr)
		if (!review) return

		const index = review.hunks.findIndex((h) => h.id === hunkId)
		if (index === -1) return

		review.hunks.splice(index, 1)

		if (review.hunks.length === 0) {
			const onDecision = review.onDecision
			const accepted = review.acceptedHunkIds || []
			this.activeReviews.delete(uriStr)
			this.clearDecorationsForUri(uriStr)
			if (accepted.length > 0) {
				vscode.window.showInformationMessage("Hunk review complete.")
				onDecision?.({ allow: true, acceptedHunkIds: accepted.map((id) => `hunk-${id - 1}`) })
			} else {
				vscode.window.showInformationMessage("All changes rejected.")
				onDecision?.({ allow: false, denyReason: "User rejected all changes" })
			}
		} else {
			this.updateDecorationsForUri(uriStr)
			vscode.window.setStatusBarMessage(`Hunk #${hunkId} rejected`, 2500)
		}

		this.onDidChangeCodeLensesEmitter.fire()
	}

	async acceptAll(uriStr: string): Promise<void> {
		const review = this.activeReviews.get(uriStr)
		if (!review) return

		const onDecision = review.onDecision
		this.activeReviews.delete(uriStr)
		this.clearDecorationsForUri(uriStr)
		this.onDidChangeCodeLensesEmitter.fire()

		vscode.window.showInformationMessage("Accepted all changes.")
		onDecision?.({ allow: true })
	}

	async rejectAll(uriStr: string): Promise<void> {
		const review = this.activeReviews.get(uriStr)
		if (!review) return

		const onDecision = review.onDecision
		this.activeReviews.delete(uriStr)
		this.clearDecorationsForUri(uriStr)
		this.onDidChangeCodeLensesEmitter.fire()

		vscode.window.showInformationMessage("Rejected all changes.")
		onDecision?.({ allow: false, denyReason: "User rejected all changes" })
	}

	private applyDecorationsToEditor(editor: vscode.TextEditor): void {
		const review = this.activeReviews.get(editor.document.uri.toString())
		if (!review || review.hunks.length === 0) {
			editor.setDecorations(this.addedDecorationType, [])
			editor.setDecorations(this.deletedIndicatorDecorationType, [])
			return
		}

		const addedDecorations: vscode.DecorationOptions[] = []
		const deletedDecorations: vscode.DecorationOptions[] = []

		for (const hunk of review.hunks) {
			const hoverMsg = new vscode.MarkdownString()
			hoverMsg.appendMarkdown(`### Cline Diff Review (Hunk #${hunk.id})\n`)
			if (hunk.originalText.trim()) {
				hoverMsg.appendMarkdown(`**Current code to replace:**\n\`\`\`\n${hunk.originalText.trim()}\n\`\`\`\n\n`)
			}
			if (hunk.newText.trim()) {
				hoverMsg.appendMarkdown(`**Proposed new code:**\n\`\`\`\n${hunk.newText.trim()}\n\`\`\`\n`)
			}

			if (hunk.originalLineCount > 0) {
				const startLine = Math.min(hunk.originalStart, editor.document.lineCount - 1)
				const endLine = Math.min(hunk.originalStart + hunk.originalLineCount - 1, editor.document.lineCount - 1)
				const range = new vscode.Range(
					new vscode.Position(startLine, 0),
					new vscode.Position(endLine, Number.MAX_SAFE_INTEGER),
				)
				addedDecorations.push({
					range,
					hoverMessage: hoverMsg,
				})
			} else {
				// Pure insertion before originalStart
				const targetLine = Math.min(hunk.originalStart, editor.document.lineCount - 1)
				const range = new vscode.Range(
					new vscode.Position(targetLine, 0),
					new vscode.Position(targetLine, Number.MAX_SAFE_INTEGER),
				)
				deletedDecorations.push({
					range,
					hoverMessage: hoverMsg,
				})
			}
		}

		editor.setDecorations(this.addedDecorationType, addedDecorations)
		editor.setDecorations(this.deletedIndicatorDecorationType, deletedDecorations)
	}

	private updateDecorationsForUri(uriStr: string): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uriStr) {
				this.applyDecorationsToEditor(editor)
			}
		}
	}

	private clearDecorationsForUri(uriStr: string): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uriStr) {
				editor.setDecorations(this.addedDecorationType, [])
				editor.setDecorations(this.deletedIndicatorDecorationType, [])
			}
		}
	}

	dispose(): void {
		this.activeReviews.clear()
		this.onDidChangeCodeLensesEmitter.dispose()
		for (const d of this.disposables) {
			d.dispose()
		}
	}
}
