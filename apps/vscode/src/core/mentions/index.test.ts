import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import * as gitModule from "@utils/git"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as path from "path"
import * as sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as terminalModule from "@/hosts/vscode/terminal/get-latest-output"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { getFileMentionFromPath, parseMentions } from "."

describe("parseMentions", () => {
	let sandbox: sinon.SinonSandbox
	let urlContentFetcherStub: sinon.SinonStubbedInstance<UrlContentFetcher>
	let fileContextTrackerStub: sinon.SinonStubbedInstance<FileContextTracker>
	let getLatestTerminalOutputStub: sinon.SinonStub
	let getWorkingStateStub: sinon.SinonStub
	let getCommitInfoStub: sinon.SinonStub
	let showMessageStub: sinon.SinonStub

	const cwd = "/test/project"

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		setVscodeHostProviderMock()
		// Create stubs for dependencies
		urlContentFetcherStub = {
			launchBrowser: sandbox.stub().resolves(),
			closeBrowser: sandbox.stub().resolves(),
			urlToMarkdown: sandbox.stub().resolves("# Example Website\n\nContent here"),
		} as any

		fileContextTrackerStub = {
			trackFileContext: sandbox.stub().resolves(),
		} as any

		// Stub other modules
		getLatestTerminalOutputStub = sandbox.stub(terminalModule, "getLatestTerminalOutput")
		getWorkingStateStub = sandbox.stub(gitModule, "getWorkingState")
		getCommitInfoStub = sandbox.stub(gitModule, "getCommitInfo")
		showMessageStub = sandbox.stub(HostProvider.window, "showMessage")
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("File mentions", () => {
		it("should handle simple file mention as lightweight reference", async () => {
			const text = "Check @/src/index.ts for details"

			const result = await parseMentions(text, cwd, urlContentFetcherStub, fileContextTrackerStub)

			const expectedOutput = "Check 'src/index.ts' for details"

			expect(result).to.equal(expectedOutput)
			expect(fileContextTrackerStub.trackFileContext.calledWith("src/index.ts", "file_mentioned")).to.be.true
		})

		it("should handle quoted file paths with spaces", async () => {
			const text = 'Open @"/path with spaces/file.txt"'

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Open 'path with spaces/file.txt'"

			expect(result).to.equal(expectedOutput)
		})

		it("should handle binary files without loading content", async () => {
			const text = "Check @/image.png"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Check 'image.png'"

			expect(result).to.equal(expectedOutput)
		})
	})

	describe("Folder mentions", () => {
		it("should handle folder mention as reference", async () => {
			const text = "Look in @/src/ folder"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Look in 'src/' folder"

			expect(result).to.equal(expectedOutput)
		})
	})

	describe("URL mentions", () => {
		it("should handle URL mention", async () => {
			const text = "Visit @https://example.com for info"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `Visit 'https://example.com' (see below for site content) for info

<url_content url="https://example.com">
# Example Website

Content here
</url_content>`

			expect(result).to.equal(expectedOutput)
			expect(urlContentFetcherStub.launchBrowser.called).to.be.true
			expect(urlContentFetcherStub.urlToMarkdown.calledWith("https://example.com")).to.be.true
			expect(urlContentFetcherStub.closeBrowser.called).to.be.true
		})

		it("should handle browser launch errors", async () => {
			const text = "Visit @https://example.com"

			urlContentFetcherStub.launchBrowser.rejects(new Error("Browser launch failed"))

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `Visit 'https://example.com' (see below for site content)

<url_content url="https://example.com">
Error fetching content: Browser launch failed
</url_content>`

			expect(result).to.equal(expectedOutput)
			expect(showMessageStub.called).to.be.true
		})

		it("should handle URL fetch errors", async () => {
			const text = "Visit @https://example.com"

			urlContentFetcherStub.urlToMarkdown.rejects(new Error("Network error"))

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `Visit 'https://example.com' (see below for site content)

<url_content url="https://example.com">
Error fetching content: Network error
</url_content>`

			expect(result).to.equal(expectedOutput)
			expect(showMessageStub.called).to.be.true
		})
	})

	describe("Special mentions", () => {
		it("should handle @terminal mention", async () => {
			const text = "See @terminal output"

			getLatestTerminalOutputStub.resolves("$ npm test\nAll tests passed!")

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `See Terminal Output (see below for output) output

<terminal_output>
$ npm test
All tests passed!
</terminal_output>`

			expect(result).to.equal(expectedOutput)
		})

		it("should handle @git-changes mention", async () => {
			const text = "Review @git-changes"

			getWorkingStateStub.resolves("M  src/index.ts\nA  src/new-file.ts")

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `Review Working directory changes (see below for details)

<git_working_state>
M  src/index.ts
A  src/new-file.ts
</git_working_state>`

			expect(result).to.equal(expectedOutput)
		})
	})

	describe("Multiple mentions", () => {
		it("should handle multiple mentions in order as references", async () => {
			const text = "Check @/file1.txt and @/file2.txt"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Check 'file1.txt' and 'file2.txt'"

			expect(result).to.equal(expectedOutput)
		})

		it("should handle duplicate mentions as references", async () => {
			const text = "Check @/file.txt and again @/file.txt"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Check 'file.txt' and again 'file.txt'"

			expect(result).to.equal(expectedOutput)
		})

		it("should handle mixed mention types", async () => {
			const text = "Check @/file.txt, and @https://example.com"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = `Check 'file.txt', and 'https://example.com' (see below for site content)

<url_content url="https://example.com">
# Example Website

Content here
</url_content>`

			expect(result).to.equal(expectedOutput)
		})
	})

	describe("Edge cases", () => {
		it("should handle text with no mentions", async () => {
			const text = "This is plain text without any mentions"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			expect(result).to.equal(text)
		})

		it("should handle empty text", async () => {
			const result = await parseMentions("", cwd, urlContentFetcherStub)

			expect(result).to.equal("")
		})

		it("should handle mentions with trailing punctuation", async () => {
			const text = "Check @/file.txt!"

			const result = await parseMentions(text, cwd, urlContentFetcherStub)

			const expectedOutput = "Check 'file.txt'!"

			expect(result).to.equal(expectedOutput)
		})
	})

	describe("getFileMentionFromPath", () => {
		it("should quote paths containing spaces", async () => {
			// getCwd() shifts the paths array, so return a fresh object per call
			sandbox.stub(HostProvider.workspace, "getWorkspacePaths").callsFake(async () => ({ paths: [cwd] }) as any)

			expect(await getFileMentionFromPath(path.join(cwd, "src", "index.ts"))).to.equal("@/src/index.ts")
			expect(await getFileMentionFromPath("/Library/Application Support/typst/sections.typ")).to.equal(
				'@"/../../Library/Application Support/typst/sections.typ"',
			)
		})
	})

	describe("Multiroot workspace mentions", () => {
		let workspaceManagerStub: any

		beforeEach(() => {
			workspaceManagerStub = {
				getRoots: sandbox.stub().returns([
					{ name: "frontend", path: "/test/frontend" },
					{ name: "backend", path: "/test/backend" },
				]),
				getRootByName: sandbox.stub().callsFake((name: string) => {
					const roots = [
						{ name: "frontend", path: "/test/frontend" },
						{ name: "backend", path: "/test/backend" },
					]
					return roots.find((r) => r.name === name)
				}),
			}
		})

		it("should handle workspace-prefixed file mention as reference", async () => {
			const text = "Check @frontend:/src/index.ts"

			const result = await parseMentions(text, cwd, urlContentFetcherStub, fileContextTrackerStub, workspaceManagerStub)

			const expectedOutput = "Check 'frontend:src/index.ts'"

			expect(result).to.equal(expectedOutput)
			expect(fileContextTrackerStub.trackFileContext.calledWith("src/index.ts", "file_mentioned")).to.be.true
		})
	})
})
