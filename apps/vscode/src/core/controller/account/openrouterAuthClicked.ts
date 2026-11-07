import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Controller } from ".."

/**
 * Initiates OpenRouter auth (disabled - all routing goes through TrueFoundry)
 */
export async function openrouterAuthClicked(_: Controller, __: EmptyRequest): Promise<Empty> {
	HostProvider.window.showMessage({
		type: ShowMessageType.INFO,
		message: "Direct provider authentication is disabled. All routing will go through TrueFoundry.",
	})
	return {}
}
