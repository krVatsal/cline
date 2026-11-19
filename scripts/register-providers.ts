/**
 * Script to register providers and models in TrueForge via @truefoundry/trueforge-sdk.
 * Reads API keys from environment variables (GROQ_API_KEY, GEMINI_API_KEY).
 *
 * Usage:
 *   $env:GROQ_API_KEY="your-groq-key"
 *   $env:GEMINI_API_KEY="your-gemini-key"
 *   bun scripts/register-providers.ts
 */
import { TrueForge } from "@truefoundry/trueforge-sdk";

const baseUrl = process.env.TRUEFORGE_BASE_URL || "http://localhost:8790";
const client = new TrueForge({ baseUrl });

async function main() {
	console.log(`Connecting to TrueForge at ${baseUrl}...`);

	const groqKey = process.env.GROQ_API_KEY;
	const geminiKey = process.env.GEMINI_API_KEY;

	if (groqKey) {
		console.log("Registering Groq provider...");
		try {
			await client.settings.modelProviders.createOrUpdate("groq", {
				type: "groq",
				apiKey: groqKey,
			} as any);
			console.log("Successfully registered Groq provider.");
		} catch (e: any) {
			console.warn("Could not register Groq provider:", e.message);
		}
	} else {
		console.log("Note: GROQ_API_KEY not set; skipping Groq registration.");
	}

	if (geminiKey) {
		console.log("Registering Google Gemini fallback provider...");
		try {
			await client.settings.modelProviders.createOrUpdate("google-gemini", {
				type: "google-gemini",
				apiKey: geminiKey,
			} as any);
			console.log("Successfully registered Google Gemini provider.");
		} catch (e: any) {
			console.warn("Could not register Gemini provider:", e.message);
		}
	} else {
		console.log("Note: GEMINI_API_KEY not set; skipping Gemini registration.");
	}

	const models = await client.models.list();
	console.log(`Available models in TrueForge (${models.data?.length ?? 0}):`);
	for (const m of models.data || []) {
		console.log(`  - ${m.name || m.modelId} (${m.provider?.name})`);
	}
}

main().catch(console.error);
