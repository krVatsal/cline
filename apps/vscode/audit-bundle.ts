import fs from "node:fs";

const meta = JSON.parse(fs.readFileSync("apps/vscode/dist/metafile.json", "utf-8"));
const inputs = Object.keys(meta.inputs);
console.log("Total input files in bundle:", inputs.length);

const forbiddenPatterns = [
  "@cline/llms",
  "packages/llms",
  "anthropic",
  "openai",
  "google/generative-ai",
  "vertex",
  "bedrock",
  "ollama",
  "mistral",
  "groq",
  "cerebras",
  "together",
  "cohere",
  "azure",
  "ai-sdk",
  "langchain",
  "generativelanguage"
];

for (const pattern of forbiddenPatterns) {
  const matches = inputs.filter((p) => p.toLowerCase().includes(pattern.toLowerCase()));
  if (matches.length > 0) {
    console.log(`[ALERT] Matched '${pattern}': ${matches.length} files`);
    matches.slice(0, 5).forEach((m) => console.log(`   - ${m}`));
  } else {
    console.log(`[CLEAN] No '${pattern}' in bundle inputs`);
  }
}

// Check @cline/agents
const agentsMatches = inputs.filter((p) => p.includes("@cline/agents") || p.includes("packages/agents"));
console.log(`@cline/agents bundle inputs: ${agentsMatches.length} files`);
agentsMatches.forEach((m) => console.log(`   - ${m}`));

// String search in built dist/extension.js
const code = fs.readFileSync("apps/vscode/dist/extension.js", "utf-8");
const stringPatterns = [
  "api.anthropic.com",
  "api.openai.com",
  "openrouter",
  "bedrock",
  "generativelanguage",
  "aiplatform",
  "/v1/chat/completions",
  "/v1/messages"
];

console.log("\n--- Checking built output strings in dist/extension.js ---");
for (const str of stringPatterns) {
  let count = 0;
  let pos = code.indexOf(str);
  while (pos !== -1) {
    count++;
    pos = code.indexOf(str, pos + str.length);
  }
  if (count > 0) {
    console.log(`[FOUND STRING] "${str}": ${count} occurrences`);
  } else {
    console.log(`[CLEAN STRING] "${str}": 0 occurrences`);
  }
}
