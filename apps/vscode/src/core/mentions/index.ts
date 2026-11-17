import { diagnosticsToProblemsString } from "@integrations/diagnostics"
import { openFile } from "@integrations/misc/open-file"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { telemetryService } from "@services/telemetry"
import { mentionRegexGlobal } from "@shared/context-mentions"
import { WorkspaceRoot } from "@shared/multi-root/types"
import { openExternal } from "@utils/env"
import { getCommitInfo, getWorkingState } from "@utils/git"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getLatestTerminalOutput } from "@/hosts/vscode/terminal/get-latest-output"
import { ShowMessageType } from "@/shared/proto/host/window"
import { DiagnosticSeverity } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import { getCwd } from "@/utils/path"
import { FileContextTracker } from "../context/context-tracking/FileContextTracker"
import type { WorkspaceRootManager } from "../workspace"

export async function openMention(mention?: string): Promise<void> {
	if (!mention) {
		return
	}

	const cwd = await getCwd()
	if (!cwd) {
		return
	}

	if (isFileMention(mention)) {
		const relPath = getFilePathFromMention(mention)
		const absPath = path.resolve(cwd, relPath)
		if (await isDirectory(absPath)) {
			await HostProvider.workspace.openInFileExplorerPanel({ path: absPath })
		} else {
			openFile(absPath)
		}
	} else if (mention === "problems") {
		await HostProvider.workspace.openProblemsPanel({})
	} else if (mention === "terminal") {
		await HostProvider.workspace.openTerminalPanel({})
	} else if (mention.startsWith("http")) {
		await openExternal(mention)
	}
}

export async function getFileMentionFromPath(filePath: string) {
	const cwd = await getCwd()
	const relativePath = cwd ? path.relative(cwd, filePath) : filePath
	const mentionPath = "/" + relativePath.toPosix()
	// Paths with spaces must be quoted, otherwise the mention regex cuts them off at the first space
	return mentionPath.includes(" ") ? `@"${mentionPath}"` : `@${mentionPath}`
}

export async function parseMentions(
	text: string,
	cwd: string,
	urlContentFetcher: UrlContentFetcher,
	fileContextTracker?: FileContextTracker,
	workspaceManager?: WorkspaceRootManager,
): Promise<string> {
	const mentions: Set<string> = new Set()
	let parsedText = text.replace(mentionRegexGlobal, (match, mention) => {
		mentions.add(mention)
		if (mention.startsWith("http")) {
			return `'${mention}' (see below for site content)`
		}
		if (isFileMention(mention)) {
			const mentionPath = getFilePathFromMention(mention)
			const workspaceHint = getWorkspaceHintFromMention(mention)
			// Return a lightweight reference only, never loading or expanding file contents
			if (workspaceHint) {
				return `'${workspaceHint}:${mentionPath}'`
			}
			return `'${mentionPath}'`
		}
		if (mention === "problems") {
			return `Workspace Problems (see below for diagnostics)`
		}
		if (mention === "terminal") {
			return `Terminal Output (see below for output)`
		}
		if (mention === "git-changes") {
			return `Working directory changes (see below for details)`
		}
		if (/^[a-f0-9]{7,40}$/.test(mention)) {
			return `Git commit '${mention}' (see below for commit info)`
		}
		return match
	})

	const urlMention = Array.from(mentions).find((mention) => mention.startsWith("http"))
	let launchBrowserError: Error | undefined
	if (urlMention) {
		try {
			await urlContentFetcher.launchBrowser()
		} catch (error) {
			launchBrowserError = error
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Error fetching content for ${urlMention}: ${error.message}`,
			})
		}
	}

	// Filter out duplicate mentions while preserving order
	const uniqueMentions = Array.from(new Set(mentions))

	for (const mention of uniqueMentions) {
		// Safety guard: skip a bare "/" mention. This can surface from parsed strings or tool output and would resolve to the
		// workspace root. Expanding it would scan the entire project, inflate context, and can trigger recursive loops.
		// If root-level expansion is ever desired, gate it behind an explicit syntax (e.g. "@root" or "@folder:/")
		// and enforce strict size/.clineignore limits instead.
		if (mention === "/") {
			continue
		}

		if (mention.startsWith("http")) {
			let result: string
			if (launchBrowserError) {
				result = `Error fetching content: ${launchBrowserError.message}`
				// Track failed URL mention
				telemetryService.captureMentionFailed("url", "network_error", launchBrowserError?.message || "")
			} else {
				try {
					const markdown = await urlContentFetcher.urlToMarkdown(mention)
					result = markdown
					// Track successful URL mention
					telemetryService.captureMentionUsed("url", markdown.length)
				} catch (error) {
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Error fetching content for ${mention}: ${error.message}`,
					})
					result = `Error fetching content: ${error.message}`
					// Track failed URL mention
					telemetryService.captureMentionFailed("url", "network_error", error.message)
				}
			}
			parsedText += `\n\n<url_content url="${mention}">\n${result}\n</url_content>`
		} else if (isFileMention(mention)) {
			const mentionPath = getFilePathFromMention(mention)
			const mentionType = mention.endsWith("/") ? "folder" : "file"
			if (fileContextTracker) {
				await fileContextTracker.trackFileContext(mentionPath, "file_mentioned")
			}
			telemetryService.captureMentionUsed(mentionType, mentionPath.length)
		} else if (mention === "problems") {
			try {
				const problems = await getWorkspaceProblems()
				parsedText += `\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
				// Track successful problems mention
				telemetryService.captureMentionUsed("problems", problems.length)
			} catch (error) {
				parsedText += `\n\n<workspace_diagnostics>\nError fetching diagnostics: ${error.message}\n</workspace_diagnostics>`
				// Track failed problems mention
				telemetryService.captureMentionFailed("problems", "unknown", error.message)
			}
		} else if (mention === "terminal") {
			try {
				const terminalOutput = await getLatestTerminalOutput()
				parsedText += `\n\n<terminal_output>\n${terminalOutput}\n</terminal_output>`
				// Track successful terminal mention
				telemetryService.captureMentionUsed("terminal", terminalOutput.length)
			} catch (error) {
				parsedText += `\n\n<terminal_output>\nError fetching terminal output: ${error.message}\n</terminal_output>`
				// Track failed terminal mention
				telemetryService.captureMentionFailed("terminal", "unknown", error.message)
			}
		} else if (mention === "git-changes") {
			try {
				const workingState = await getWorkingState(cwd)
				parsedText += `\n\n<git_working_state>\n${workingState}\n</git_working_state>`
				// Track successful git-changes mention
				telemetryService.captureMentionUsed("git-changes", workingState.length)
			} catch (error) {
				parsedText += `\n\n<git_working_state>\nError fetching working state: ${error.message}\n</git_working_state>`
				// Track failed git-changes mention
				telemetryService.captureMentionFailed("git-changes", "unknown", error.message)
			}
		} else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			try {
				const commitInfo = await getCommitInfo(mention, cwd)
				parsedText += `\n\n<git_commit hash="${mention}">\n${commitInfo}\n</git_commit>`
				// Track successful commit mention
				telemetryService.captureMentionUsed("commit", commitInfo.length)
			} catch (error) {
				parsedText += `\n\n<git_commit hash="${mention}">\nError fetching commit info: ${error.message}\n</git_commit>`
				// Track failed commit mention
				telemetryService.captureMentionFailed("commit", "unknown", error.message)
			}
		}
	}

	if (urlMention) {
		try {
			await urlContentFetcher.closeBrowser()
		} catch (error) {
			Logger.error(`Error closing browser: ${error.message}`)
		}
	}

	return parsedText
}

async function getWorkspaceProblems(): Promise<string> {
	const response = await HostProvider.workspace.getDiagnostics({})
	if (response.fileDiagnostics.length === 0) {
		return "No errors or warnings detected."
	}
	return diagnosticsToProblemsString(response.fileDiagnostics, [
		DiagnosticSeverity.DIAGNOSTIC_ERROR,
		DiagnosticSeverity.DIAGNOSTIC_WARNING,
	])
}

/**
 * Parse a workspace mention to extract workspace hint and path
 * @param mention The raw mention string (e.g., "workspace:name/path/to/file")
 * @returns Object with workspaceHint and path, or null if not a workspace mention
 */
function parseWorkspaceMention(mention: string): { workspaceHint: string; path: string } | null {
	// Match workspace:name/path or workspace:"name/path with spaces"
	const workspaceMatch = mention.match(/^([\w-]+):(.+)$/)
	if (!workspaceMatch) {
		return null
	}

	const [, workspaceHint, pathPart] = workspaceMatch

	// Check if it's actually a URL (has ://)
	if (mention.includes("://")) {
		return null
	}

	// Remove quotes from path if present
	const quotedPathMatch = pathPart.match(/^"(.*)"$/)
	const cleanPath = quotedPathMatch ? quotedPathMatch[1] : pathPart

	return { workspaceHint, path: cleanPath }
}

function isFileMention(mention: string): boolean {
	// Check for workspace-prefixed mentions first
	if (parseWorkspaceMention(mention)) {
		return true
	}
	// Check for regular file mentions
	return mention.startsWith("/") || mention.startsWith('"/')
}

function getFilePathFromMention(mention: string): string {
	// Check for workspace-prefixed mentions first
	const workspaceMention = parseWorkspaceMention(mention)
	if (workspaceMention) {
		// Return path without leading slash (already cleaned)
		return workspaceMention.path.startsWith("/") ? workspaceMention.path.slice(1) : workspaceMention.path
	}

	// Remove quotes
	const match = mention.match(/^"(.*)"$/)
	const filePath = match ? match[1] : mention
	// Remove leading slash
	return filePath.slice(1)
}

function getWorkspaceHintFromMention(mention: string): string | undefined {
	const workspaceMention = parseWorkspaceMention(mention)
	return workspaceMention?.workspaceHint
}
