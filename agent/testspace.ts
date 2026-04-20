// import Anthropic from "@anthropic-ai/sdk";
// import { readFile } from "node:fs/promises";
// import { toFile } from "@anthropic-ai/sdk";

// const client = new Anthropic();

// const rubric = await client.beta.files.upload({
//   file: await toFile(readFile("./agent/rubric.md"), "rubric.md")
// });

// console.log(`Rubric uploaded: ${rubric.id}`)

// await client.beta.sessions.events.send(session.id, {
//   events: [
//     {
//       content: [{
//         type: "user.define_outcome",
//         description: "Build a DCF model for Costco in .xlsx",
//         rubric: { type: "file", file_id: "file_011CaDpeSnN7jZnVFHYGTbRd" },
//       }]
//     }
//   ]
// });