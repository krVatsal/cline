import * as fs from "node:fs";
import * as path from "node:path";
import { createEditorAgentSpec } from "../apps/vscode/src/forge/client/turn-runner";
import { createInlineAgentSpec } from "../apps/vscode/src/forge/client/inline-edit";

const rootDir = path.resolve(__dirname, "..");
const agentDir = path.join(rootDir, "agent");

if (!fs.existsSync(agentDir)) {
	fs.mkdirSync(agentDir, { recursive: true });
}

// Generate editor-agent.json
const editorSpec = createEditorAgentSpec({ model: "groq/openai-gpt-oss-20b" });
const editorPath = path.join(agentDir, "editor-agent.json");
fs.writeFileSync(editorPath, JSON.stringify(editorSpec, null, 2) + "\n", "utf8");
console.log(`Generated ${editorPath}`);

// Generate inline-agent.json
const inlineSpec = createInlineAgentSpec({ model: "groq/openai-gpt-oss-20b" });
const inlinePath = path.join(agentDir, "inline-agent.json");
fs.writeFileSync(inlinePath, JSON.stringify(inlineSpec, null, 2) + "\n", "utf8");
console.log(`Generated ${inlinePath}`);
