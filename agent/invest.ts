import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { toFile } from "@anthropic-ai/sdk";

const client = new Anthropic();

const agent = await client.beta.agents.create({
  name: "Value Investor",
  model: "claude-sonnet-4-6",
  system: "You are a board of directors each with deep expertise in investment and finance. Each director should deliberate and come to a consensus on investment opportunities and provide a recommendation. You should research investment opportunties using the tools available.",
  tools: [
    { type: "agent_toolset_20260401" },
  ],
  skills: [
    {
      type: "custom",
      //value-investing skill
      skill_id: "skill_01L29jJi9y8HJGZ12hgnXgcf",
      version: "latest"
    },
    {
      type: "anthropic",
      skill_id: "pdf"
    },
    {
      type: "anthropic",
      skill_id: "xlsx"
    },
    {
      type: "anthropic",
      skill_id: "pptx"
    }
  ]
});

console.log(`Agent ID: ${agent.id}, version: ${agent.version}`);

// const file = await client.beta.files.upload({
//   file: await toFile(readFile("./agent/docs/investment_memo.pdf"), "investment_memo.pdf", { type: "application/pdf" })
// })

// console.log(`File ID: ${file.id}`);

const environment = await client.beta.environments.create({
  name: "value-investing-env",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
});

console.log(`Environment ID: ${environment.id}`);

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  title: "Value Investing session",
  resources: [
    {
      type: "file",
      file_id: "file_011CaFDrpFhbpbp9jeoEv7SK",
      mount_path: "/workspace/MRNA-10k.pdf",
    },
    {
      type: "file",
      file_id: "file_011CaK33maGqeKzjqHt4t5Sr",
      mount_path: "/workspace/investment-memo.pdf",
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
          text: "What is your assessment of the investment potential of $MRNA (see their 10k filing in \"MRNA-10k.pdf\")? Please provide a recommendation on whether I should invest in this company now, wait until certain conditions are met, or not at all. Please justify your answer using the tools available. Please add your work to a new file called 'investment-memo-[TICKER]'. Use the investment-memo.pdf file as a template for the format. Please download the file you create to ./investment-memos folder."
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