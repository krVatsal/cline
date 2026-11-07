import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { ShowMessageType } from "@shared/proto/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { Controller } from ".."

/**
 * Initiates OpenAI Codex OAuth authentication flow (disabled - all routing goes through TrueFoundry).
 */
export async function openAiCodexSignIn(_controller: Controller, _: EmptyRequest): Promise<Empty> {
	HostProvider.window.showMessage({
		type: ShowMessageType.INFO,
		message: "Direct provider authentication is disabled. All routing will go through TrueFoundry.",
	})
	return {}
}
