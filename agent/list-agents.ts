import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// List all assets
const environments = await client.beta.environments.list()
const sessions = await client.beta.sessions.list();
const vaults = await client.beta.vaults.list();
const files = await client.beta.files.list();

for await (const data of files) {
  console.log(`${data.filename} - ${data.id}: ${data.downloadable}`)
}

for await (const data of vaults) {
  console.log(`${data.display_name} - ${data.id}`)
}

for await (const data of environments) {
  console.log(`${data.name} - ${data.id}`)
}

for await (const data of sessions) {
  console.log(`${data.title} - ${data.status} - ${data.id}`)

  const events = await client.beta.sessions.events.list(data.id);
  for (const event of events.data) {
    console.log(`[${event.type}] ${event.processed_at}`);
  }

  console.log(`\nUsage for session ${data.id}: ${data.usage.input_tokens} input tokens, ${data.usage.output_tokens} output tokens`)
}