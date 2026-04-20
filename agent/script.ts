import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const environments = await client.beta.environments.list()
const sessions = await client.beta.sessions.list();
const vaults = await client.beta.vaults.list();

for await (const data of vaults) {
  console.log(`${data.display_name} - ${data.id}`)
}

for await (const data of environments) {
  console.log(`${data.name} - ${data.id}`)
}

for await (const data of sessions) {
  console.log(`${data.title} - ${data.status} - ${data.id}`)
  console.log(`\nUsage for session ${data.id}: ${data.usage.input_tokens} input tokens, ${data.usage.output_tokens} output tokens`)
}

// // Delete all environments
// for await (const data of environments) {
//   console.log(`${data.name} - ${data.id}`)
//   await client.beta.environments.delete(data.id);
//   console.log(`Deleted ${data.name} - ${data.id}`)
// }

// // Delete all sessions
// for await (const data of sessions) {
//   console.log(`${data.title} - ${data.status}`)
//   if (data.status === "idle") {
//     await client.beta.sessions.delete(data.id);
//     console.log(`Deleted ${data.title} - ${data.id}`)
//   }
//   if (data.status === "running") {
//     const session = await client.beta.sessions.retrieve(data.id);
//     await client.beta.sessions.events.send(session.id, {
//       events: [
//         {
//           type: "user.interrupt",
//         }
//       ]
//     })
//     console.log(`Interrupted ${data.title} - ${data.id}`)
//   }
// }

// // Delete all vault ids
// for await (const data of vaults) {
//   console.log(`${data.display_name} - ${data.id}`)
//   await client.beta.vaults.delete(data.id);
//   console.log(`Deleted ${data.display_name} - ${data.id}`)
// }