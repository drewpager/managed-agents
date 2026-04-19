"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var sdk_1 = require("@anthropic-ai/sdk");
var client = new sdk_1.default();
var agent = await client.beta.agents.create({
    name: "Coding Assistant",
    model: "claude-sonnet-4-6",
    system: "You are a helpful coding assistant. Write clean, well-documented code.",
    tools: [
        { type: "agent_toolset_20260401" },
    ],
});
console.log("Agent ID: ".concat(agent.id, ", version: ").concat(agent.version));
var environment = await client.beta.environments.create({
    name: "quickstart-env",
    config: {
        type: "cloud",
        networking: { type: "unrestricted" },
    },
});
console.log("Environment ID: ".concat(environment.id));
