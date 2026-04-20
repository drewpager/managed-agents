import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { toFile } from "@anthropic-ai/sdk";

const client = new Anthropic();

const agent = await client.beta.agents.create({
  name: "Automation Documentation Agent",
  model: "claude-sonnet-4-6",
  system: "You are a helpful documentation assistant so that my team understands what my automations do and to better understand my thinking/limitations. Write clean, descriptions of what the code does, what assumptions it makes, what input data it expects and what output data it produces. Use the @google-docs MCP server to create a new Google Doc for each project and use it to add the documentation.  Do not add any other text to the document other than the documentation.",
  // mcp_servers: [
  //   {
  //     type: "url",
  //     name: "google-docs",
  //     url: "https://google-docs-mcp-993416944584.europe-west3.run.app/mcp",
  //   }
  // ],
  mcp_servers: [
    {
      type: "url",
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
    },
  ],
  tools: [
    { type: "agent_toolset_20260401" },
    {
      type: "mcp_toolset",
      mcp_server_name: "github",
    },
  ],
  skills: [
    {
      type: "custom",
      skill_id: "skill_01LpEE3DGEStKjNiuHQfY9P5",
      version: "latest"
    },
    {
      type: "anthropic",
      skill_id: "doc-coauthoring"
    }
  ]
});

console.log(`Agent ID: ${agent.id}, version: ${agent.version}`);

const environment = await client.beta.environments.create({
  name: "auto-doc-env",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
});

console.log(`Environment ID: ${environment.id}`);

// Create a vault to store the GitHub MCP credential.
// The MCP server at api.githubcopilot.com/mcp/ needs a bearer token separate
// from the git clone token in resources[].authorization_token.
const vault = await client.beta.vaults.create({
  display_name: "GitHub MCP credentials",
});

await client.beta.vaults.credentials.create(vault.id, {
  display_name: "GitHub PAT for MCP",
  auth: {
    type: "static_bearer",
    mcp_server_url: "https://api.githubcopilot.com/mcp/",
    token: `${process.env.GITHUB_ORIGINAL_TOKEN}`,
  },
});

console.log(`Vault ID: ${vault.id}`);

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  title: "Automation Documentation session",
  vault_ids: [vault.id],
  resources: [
    {
      type: "github_repository",
      url: "https://github.com/drewpager/csat-scoring",
      mount_path: "/workspace/csat-scoring",
      authorization_token: `${process.env.GITHUB_ORIGINAL_TOKEN}`,
    },
  ],
});

console.log(`Session ID: ${session.id}`);

const stream = await client.beta.sessions.events.stream(session.id);

// Send the user message after the stream opens
await client.beta.sessions.events.send(session.id, {
  events: [
    {
      type: "user.message",
      content: [
        {
          type: "text",
          // text: "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt. Use @google-docs MCP server to create a new Google Doc with the title 'Fibonacci Sequence' and save the script to it.",
          text: "Review the repo in Github using @github MCP server and provide documentation using the skill_01LpEE3DGEStKjNiuHQfY9P5 skill. Write the documentation in a new file called 'documentation.md' in the root of the repository and create a pull request for this addition."
        },
      ],
    },
  ],
});

// Process streaming events
for await (const event of stream) {
  if (event.type === "agent.message") {
    for (const block of event.content) {
      process.stdout.write(block.text);
    }
  } else if (event.type === "agent.tool_use") {
    console.log(`\n[Using tool: ${event.name}]`);
  } else if (event.type === "session.status_idle") {
    console.log("\n\nAgent finished.");
    // break;
  } else if (event.type === "session.status_running") {
    console.log("\n\nAgent is running.");
  } else if (event.type === "session.error") {
    console.log(`ERROR: ${event.error.message}`)
    break;
  }
}

console.log(`\nUsage for session ${session.id}: ${session.usage.input_tokens} input tokens, ${session.usage.output_tokens} output tokens`)