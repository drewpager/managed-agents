import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const environments = await client.beta.environments.list()
const sessions = await client.beta.sessions.list();

// Delete all environments
for await (const data of environments) {
  console.log(`${data.name} - ${data.id}`)
  await client.beta.environments.delete(data.id);
  console.log(`Deleted ${data.name} - ${data.id}`)
}

for await (const data of sessions) {
  console.log(`${data.title} - ${data.status}`)
  if (data.status === "idle") {
    await client.beta.sessions.delete(data.id);
    console.log(`Deleted ${data.title} - ${data.id}`)
  }
}