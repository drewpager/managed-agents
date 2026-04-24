import Anthropic, { toFile } from "@anthropic-ai/sdk";
import express from "express";
import type { Request, Response } from "express";
import multer from "multer";

const client = new Anthropic();
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileInfo {
  id: string;
  filename: string;
  mountPath: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface OutputFile {
  id: string;
  filename: string;
  size: number;
}

interface SessionInfo {
  sessionId: string;
  environmentId: string;
  ticker: string;
  files: FileInfo[];
  startedAt: string;
  completedAt?: string;
  status: "running" | "complete" | "error";
  tokenUsage: TokenUsage;
  outputFiles: OutputFile[];
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

// claude-sonnet-4-6 pricing per token
const PRICE = {
  input: 3.00 / 1_000_000,
  output: 15.00 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
  cacheRead: 0.30 / 1_000_000,
};

function calcCost(u: TokenUsage): number {
  return (
    u.inputTokens * PRICE.input +
    u.outputTokens * PRICE.output +
    u.cacheCreationTokens * PRICE.cacheWrite +
    u.cacheReadTokens * PRICE.cacheRead
  );
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

// ─── State ────────────────────────────────────────────────────────────────────

// Ordered newest-first for the history panel
const sessionList: SessionInfo[] = [];
const sessionMap = new Map<string, SessionInfo>();
let agentId: string | null = null;

// ─── Agent ────────────────────────────────────────────────────────────────────

async function getOrCreateAgent(): Promise<string> {
  if (agentId) return agentId;
  const envId = process.env["INVEST_AGENT_ID"];
  if (envId) { agentId = envId; console.log(`Using agent: ${agentId}`); return agentId; }

  const agent = await client.beta.agents.create({
    name: "Value Investor",
    model: "claude-sonnet-4-6",
    system:
      "You are a board of directors each with deep expertise in investment and finance. " +
      "Each director should deliberate and come to a consensus on investment opportunities " +
      "and provide a recommendation. You should research investment opportunities using the tools available.",
    tools: [{ type: "agent_toolset_20260401" }],
    skills: [
      { type: "custom", skill_id: "skill_01L29jJi9y8HJGZ12hgnXgcf", version: "latest" },
      { type: "anthropic", skill_id: "pdf" },
      { type: "anthropic", skill_id: "xlsx" },
      { type: "anthropic", skill_id: "pptx" },
    ],
  });

  agentId = agent.id;
  console.log(`\n✅ Agent created: ${agentId}`);
  console.log(`   Save to .env: INVEST_AGENT_ID=${agentId}\n`);
  return agentId;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | undefined>)[name];
  return v ?? "";
}

// ─── File Routes ──────────────────────────────────────────────────────────────

app.get("/api/files", async (_req: Request, res: Response) => {
  try {
    const list = await client.beta.files.list();
    res.json(list.data.map(f => ({ id: f.id, filename: f.filename, size: f.size_bytes })));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/api/files", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: "No file provided" }); return; }
  try {
    const list = await client.beta.files.list();
    const dup = list.data.find(f => f.filename === req.file!.originalname);
    if (dup) { res.json({ id: dup.id, filename: dup.filename, size: dup.size_bytes, isDuplicate: true }); return; }
    const up = await client.beta.files.upload({
      file: await toFile(req.file.buffer, req.file.originalname, { type: req.file.mimetype }),
    });
    res.json({ id: up.id, filename: up.filename, size: up.size_bytes, isDuplicate: false });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.delete("/api/files/:id", async (req: Request, res: Response) => {
  try { await client.beta.files.delete(param(req, "id")); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Session Routes ───────────────────────────────────────────────────────────

// List all sessions (history)
app.get("/api/sessions", (_req: Request, res: Response) => {
  res.json(sessionList.map(s => ({
    sessionId: s.sessionId,
    ticker: s.ticker,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    tokenUsage: s.tokenUsage,
    cost: calcCost(s.tokenUsage),
    outputFiles: s.outputFiles,
    fileCount: s.files.length,
  })));
});

// Get single session detail
app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const info = sessionMap.get(param(req, "id"));
  if (!info) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ ...info, cost: calcCost(info.tokenUsage) });
});

// Create analysis session
app.post("/api/sessions", async (req: Request, res: Response) => {
  const body = req.body as { ticker?: string; files?: Array<{ id: string; filename: string }> };
  const ticker = body.ticker?.trim().toUpperCase() ?? "";
  const files = body.files ?? [];
  if (!ticker || !files.length) { res.status(400).json({ error: "ticker and files are required" }); return; }

  try {
    const aid = await getOrCreateAgent();
    const env = await client.beta.environments.create({
      name: `invest-${ticker.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Date.now()}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    const fileInfos: FileInfo[] = files.map(f => ({
      id: f.id, filename: f.filename, mountPath: `/workspace/${f.filename}`,
    }));
    const session = await client.beta.sessions.create({
      agent: aid,
      environment_id: env.id,
      title: `${ticker} Investment Analysis`,
      resources: fileInfos.map(f => ({ type: "file" as const, file_id: f.id, mount_path: f.mountPath })),
    });
    const info: SessionInfo = {
      sessionId: session.id,
      environmentId: env.id,
      ticker,
      files: fileInfos,
      startedAt: new Date().toISOString(),
      status: "running",
      tokenUsage: emptyUsage(),
      outputFiles: [],
    };
    sessionMap.set(session.id, info);
    sessionList.unshift(info); // newest first
    res.json({ sessionId: session.id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// SSE stream — stream-first then send user message
app.get("/api/sessions/:id/stream", async (req: Request, res: Response) => {
  const sessionId = param(req, "id");
  const info = sessionMap.get(sessionId);
  if (!info) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit = (type: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const fileDesc = info.files.map(f => `"${f.filename}" at ${f.mountPath}`).join(", ");
  const prompt =
    `What is your assessment of the investment potential of $${info.ticker}? ` +
    `The following documents are available: ${fileDesc}. ` +
    `Provide a detailed buy/wait/avoid recommendation with justification using all available tools. ` +
    `Save a comprehensive investment memo to "/mnt/session/outputs/investment-memo-${info.ticker}.md". ` +
    `Use any provided investment memo templates as a format guide.`;

  try {
    const stream = await client.beta.sessions.events.stream(sessionId);
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });

    for await (const event of stream) {
      emit(event.type, event);

      // Accumulate token usage and emit a running cost update
      if (event.type === "span.model_request_end") {
        const mu = (event as unknown as { model_usage?: Record<string, number> }).model_usage;
        if (mu) {
          info.tokenUsage.inputTokens += mu["input_tokens"] ?? 0;
          info.tokenUsage.outputTokens += mu["output_tokens"] ?? 0;
          info.tokenUsage.cacheCreationTokens += mu["cache_creation_input_tokens"] ?? 0;
          info.tokenUsage.cacheReadTokens += mu["cache_read_input_tokens"] ?? 0;
          emit("stream.usage", { tokenUsage: info.tokenUsage, cost: calcCost(info.tokenUsage) });
        }
      }

      if (event.type === "session.error") {
        info.status = "error";
        info.completedAt = new Date().toISOString();
        emit("stream.error", { message: (event as { error?: { message?: string } }).error?.message ?? "Session error" });
        break;
      }
      if (event.type === "session.status_terminated") { info.status = "error"; info.completedAt = new Date().toISOString(); break; }
      if (event.type === "session.status_idle") {
        const sr = (event as { stop_reason?: { type: string } }).stop_reason;
        if (sr?.type !== "requires_action") break;
      }
    }

    // Fetch output files with retry for indexing lag
    if (info.status === "running") {
      info.status = "complete";
      info.completedAt = new Date().toISOString();
    }

    emit("stream.done", { message: "Analysis complete", cost: calcCost(info.tokenUsage), tokenUsage: info.tokenUsage });

    // Poll for output files (up to 4 attempts, 2s apart)
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 1500));
      try {
        const outputList = await client.beta.files.list({
          scope_id: sessionId,
          betas: ["managed-agents-2026-04-01"],
        } as Parameters<typeof client.beta.files.list>[0]);
        if (outputList.data.length > 0) {
          info.outputFiles = outputList.data.map(f => ({ id: f.id, filename: f.filename, size: f.size_bytes ?? 0 }));
          emit("stream.outputs", { files: info.outputFiles });
          break;
        }
      } catch { /* indexing not ready yet */ }
    }
  } catch (err) {
    info.status = "error";
    info.completedAt = new Date().toISOString();
    emit("stream.error", { message: String(err) });
  }

  res.end();
});

// List output files for a completed session
app.get("/api/sessions/:id/outputs", async (req: Request, res: Response) => {
  const sessionId = param(req, "id");
  const info = sessionMap.get(sessionId);
  if (!info) { res.status(404).json({ error: "Session not found" }); return; }
  try {
    // Return cached output files if available
    if (info.outputFiles.length > 0) { res.json(info.outputFiles); return; }
    // Otherwise fetch from API
    const list = await client.beta.files.list({
      scope_id: sessionId,
      betas: ["managed-agents-2026-04-01"],
    } as Parameters<typeof client.beta.files.list>[0]);
    info.outputFiles = list.data.map(f => ({ id: f.id, filename: f.filename, size: f.size_bytes ?? 0 }));
    res.json(info.outputFiles);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Proxy download of a session output file
app.get("/api/sessions/:sessionId/outputs/:fileId/download", async (req: Request, res: Response) => {
  const fileId = param(req, "fileId");
  try {
    const meta = await client.beta.files.retrieveMetadata(fileId);
    const content = await client.beta.files.download(fileId);
    const safe = meta.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    const buf = Buffer.from(await content.arrayBuffer());
    res.send(buf);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Delete session + environment
app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
  const sessionId = param(req, "id");
  const info = sessionMap.get(sessionId);
  if (!info) { res.status(404).json({ error: "Session not found" }); return; }

  const errors: string[] = [];
  for (let i = 0; i < 10; i++) {
    try { const s = await client.beta.sessions.retrieve(sessionId); if (s.status !== "running") break; } catch { break; }
    await new Promise(r => setTimeout(r, 300));
  }
  try { await client.beta.sessions.delete(sessionId); } catch (e) { errors.push(`Session: ${String(e)}`); }
  try { await client.beta.environments.delete(info.environmentId); } catch (e) { errors.push(`Environment: ${String(e)}`); }

  sessionMap.delete(sessionId);
  const idx = sessionList.findIndex(s => s.sessionId === sessionId);
  if (idx !== -1) sessionList.splice(idx, 1);

  res.json({ success: errors.length === 0, errors });
});

// ─── Dashboard UI ─────────────────────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Investment Analysis Dashboard</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f1f5f9; --card: #ffffff; --primary: #2563eb; --primary-dark: #1d4ed8;
  --primary-light: #eff6ff; --danger: #dc2626; --danger-light: #fef2f2;
  --success: #16a34a; --success-light: #f0fdf4; --warning: #d97706;
  --warning-light: #fffbeb; --text: #1e293b; --text-muted: #64748b;
  --border: #e2e8f0; --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.07),0 2px 4px rgba(0,0,0,0.06);
}
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; }

/* Header */
.header { background:var(--card); border-bottom:1px solid var(--border); padding:0 24px; height:56px; display:flex; align-items:center; justify-content:space-between; box-shadow:var(--shadow); position:sticky; top:0; z-index:10; }
.header-title { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:700; }
.header-title .icon { font-size:22px; }
.cost-display { display:flex; align-items:center; gap:16px; }
.cost-pill { display:flex; align-items:center; gap:6px; padding:4px 12px; border-radius:99px; font-size:12px; font-weight:600; background:var(--primary-light); color:var(--primary); border:1px solid #bfdbfe; }
.cost-pill.has-cost { background:#fefce8; color:#854d0e; border-color:#fde68a; }
.token-detail { font-size:11px; color:var(--text-muted); }

/* Layout */
.layout { display:flex; flex:1; height:calc(100vh - 56px); overflow:hidden; }

/* Sidebar */
.sidebar { width:340px; min-width:340px; background:var(--card); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
.tab-nav { display:flex; border-bottom:1px solid var(--border); flex-shrink:0; }
.tab-btn { flex:1; padding:10px; font-size:13px; font-weight:600; cursor:pointer; background:none; border:none; border-bottom:2px solid transparent; color:var(--text-muted); transition:all 0.15s; }
.tab-btn.active { color:var(--primary); border-bottom-color:var(--primary); background:var(--primary-light); }
.tab-panel { flex:1; overflow-y:auto; display:none; flex-direction:column; }
.tab-panel.active { display:flex; }

.sidebar-section { padding:16px 20px; border-bottom:1px solid var(--border); }
.section-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); margin-bottom:12px; }

/* Dropzone */
.dropzone { border:2px dashed var(--border); border-radius:var(--radius); padding:18px; text-align:center; cursor:pointer; transition:all 0.15s; background:var(--bg); }
.dropzone:hover,.dropzone.drag-over { border-color:var(--primary); background:var(--primary-light); }
.dropzone p { font-size:13px; color:var(--text-muted); margin-bottom:6px; }
.btn-link { background:none; border:none; color:var(--primary); font-size:13px; font-weight:500; cursor:pointer; text-decoration:underline; }

/* File list */
.file-list { display:flex; flex-direction:column; gap:4px; margin-top:10px; }
.file-item { display:flex; align-items:center; gap:6px; padding:7px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); }
.file-item.selected { border-color:var(--primary); background:var(--primary-light); }
.file-item label { display:flex; align-items:center; gap:8px; flex:1; cursor:pointer; min-width:0; }
.file-item input[type="checkbox"] { width:15px; height:15px; accent-color:var(--primary); flex-shrink:0; }
.file-icon { font-size:14px; flex-shrink:0; }
.file-name { font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px; }
.file-size { font-size:11px; color:var(--text-muted); flex-shrink:0; margin-left:auto; }
.icon-btn { background:none; border:none; cursor:pointer; color:var(--text-muted); font-size:12px; padding:2px 4px; border-radius:4px; flex-shrink:0; transition:all 0.1s; }
.icon-btn:hover { background:var(--danger-light); color:var(--danger); }
.file-actions { display:flex; gap:8px; margin-top:6px; }
.empty-state { font-size:13px; color:var(--text-muted); text-align:center; padding:10px 0; }

/* Form */
.form-group { display:flex; flex-direction:column; gap:6px; }
.label { font-size:13px; font-weight:500; }
.input { width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:6px; font-size:14px; font-weight:600; letter-spacing:0.05em; background:var(--bg); color:var(--text); outline:none; transition:border-color 0.15s; }
.input:focus { border-color:var(--primary); background:white; }
.input::placeholder { font-weight:400; letter-spacing:0; color:var(--text-muted); }

/* Buttons */
.btn { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:10px 16px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; border:none; transition:all 0.15s; }
.btn:disabled { opacity:0.45; cursor:not-allowed; }
.btn-primary { background:var(--primary); color:white; }
.btn-primary:hover:not(:disabled) { background:var(--primary-dark); }
.btn-danger { background:var(--danger-light); color:var(--danger); border:1px solid #fca5a5; }
.btn-danger:hover:not(:disabled) { background:#fee2e2; }
.btn + .btn { margin-top:8px; }

/* History list */
.history-item { display:flex; flex-direction:column; gap:4px; padding:12px 16px; border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.1s; }
.history-item:hover { background:var(--bg); }
.history-item.active-view { background:var(--primary-light); border-left:3px solid var(--primary); }
.history-item.active-view:hover { background:var(--primary-light); }
.history-row1 { display:flex; align-items:center; gap:8px; }
.history-ticker { font-size:14px; font-weight:700; }
.history-status { font-size:11px; padding:2px 7px; border-radius:99px; font-weight:600; }
.status-complete-pill { background:var(--success-light); color:var(--success); }
.status-running-pill { background:#dbeafe; color:#1e40af; }
.status-error-pill { background:var(--danger-light); color:var(--danger); }
.history-row2 { display:flex; align-items:center; gap:12px; }
.history-meta { font-size:11px; color:var(--text-muted); }
.history-cost { font-size:11px; font-weight:600; color:#854d0e; }
.history-files-count { font-size:11px; color:var(--primary); }
.no-history { padding:32px 20px; text-align:center; color:var(--text-muted); font-size:13px; }

/* Main panel */
.main-panel { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

/* Status bar */
.status-bar { display:flex; align-items:center; gap:10px; padding:8px 20px; background:var(--card); border-bottom:1px solid var(--border); flex-wrap:wrap; }
.status-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:99px; font-size:12px; font-weight:600; }
.status-ready { background:var(--bg); color:var(--text-muted); }
.status-running { background:#dbeafe; color:#1e40af; }
.status-idle { background:#f1f5f9; color:#475569; }
.status-complete { background:var(--success-light); color:var(--success); }
.status-error { background:var(--danger-light); color:var(--danger); }
.status-warning { background:var(--warning-light); color:var(--warning); }
.spinner { width:15px; height:15px; border:2px solid #bfdbfe; border-top-color:var(--primary); border-radius:50%; animation:spin 0.7s linear infinite; flex-shrink:0; }
@keyframes spin { to { transform:rotate(360deg); } }
.token-bar { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-muted); }
.token-bar .tok-val { font-weight:600; color:var(--text); }
.token-bar .tok-cost { font-weight:700; color:#854d0e; background:#fefce8; padding:2px 8px; border-radius:99px; border:1px solid #fde68a; }
.session-id-label { font-size:10px; color:var(--text-muted); font-family:monospace; }

/* Content area */
.content-area { display:flex; flex:1; overflow:hidden; }

/* Output */
.output-panel { flex:1; display:flex; flex-direction:column; padding:14px 18px; gap:8px; overflow:hidden; }
.panel-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); flex-shrink:0; }
.output-box { flex:1; overflow-y:auto; background:#0f172a; border-radius:var(--radius); padding:16px; font-family:"Menlo","Monaco","Courier New",monospace; font-size:13px; line-height:1.65; color:#e2e8f0; white-space:pre-wrap; word-break:break-word; border:1px solid #1e293b; box-shadow:var(--shadow-md); }
.out-text { color:#e2e8f0; }
.out-error { color:#f87171; }
.out-complete { color:#4ade80; }
.out-placeholder { color:#475569; font-style:italic; }

/* History detail */
.history-detail { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
.detail-card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); }
.detail-card h3 { font-size:13px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em; margin-bottom:12px; }
.detail-ticker { font-size:28px; font-weight:800; color:var(--primary); }
.detail-meta { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
.detail-meta-item { display:flex; flex-direction:column; gap:2px; }
.detail-meta-label { font-size:11px; color:var(--text-muted); }
.detail-meta-value { font-size:13px; font-weight:600; }
.cost-table { width:100%; border-collapse:collapse; font-size:13px; }
.cost-table td { padding:5px 0; color:var(--text); }
.cost-table td:last-child { text-align:right; font-weight:600; font-family:monospace; }
.cost-table .cost-total { border-top:1px solid var(--border); font-weight:700; font-size:14px; color:var(--primary); }
.cost-table .cost-total td { padding-top:8px; }
.output-files-list { display:flex; flex-direction:column; gap:6px; }
.output-file-item { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg); border-radius:6px; border:1px solid var(--border); }
.output-file-item .of-icon { font-size:16px; flex-shrink:0; }
.output-file-item .of-name { flex:1; font-size:13px; font-weight:500; word-break:break-all; }
.output-file-item .of-size { font-size:11px; color:var(--text-muted); flex-shrink:0; }
.download-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 10px; background:var(--primary); color:white; border:none; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; text-decoration:none; transition:background 0.15s; flex-shrink:0; }
.download-btn:hover { background:var(--primary-dark); }
.no-outputs { font-size:13px; color:var(--text-muted); text-align:center; padding:20px; }

/* Right panel (activity + downloads) */
.right-panel { width:280px; min-width:280px; border-left:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; background:var(--card); }
.right-panel-section { border-bottom:1px solid var(--border); }
.right-panel-section.grows { flex:1; overflow:hidden; display:flex; flex-direction:column; }
.section-header { padding:10px 14px; flex-shrink:0; }
.activity-list { flex:1; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:2px; }
.activity-item { display:flex; align-items:flex-start; gap:7px; padding:6px 9px; border-radius:6px; font-size:12px; line-height:1.4; border:1px solid transparent; }
.activity-item .ai-icon { flex-shrink:0; font-size:13px; }
.activity-item .ai-content { display:flex; flex-direction:column; gap:1px; min-width:0; }
.activity-item .ai-label { font-weight:600; color:var(--text); }
.activity-item .ai-detail { color:var(--text-muted); word-break:break-word; }
.activity-tool { background:#f8fafc; border-color:var(--border); }
.activity-tokens { background:#fafaf9; border-color:#e7e5e4; }
.activity-upload,.activity-state { background:var(--primary-light); border-color:#bfdbfe; }
.activity-success { background:var(--success-light); border-color:#bbf7d0; }
.activity-error { background:var(--danger-light); border-color:#fca5a5; }
.activity-duplicate { background:var(--warning-light); border-color:#fde68a; }

/* Downloads section in right panel */
.downloads-section { padding:10px 14px; flex-shrink:0; max-height:40%; overflow-y:auto; }
.download-file-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); }
.download-file-row:last-child { border-bottom:none; }
.dfr-icon { font-size:14px; flex-shrink:0; }
.dfr-name { flex:1; font-size:12px; font-weight:500; word-break:break-all; color:var(--text); }
.dfr-size { font-size:11px; color:var(--text-muted); flex-shrink:0; }

/* Toast */
.toast { position:fixed; bottom:20px; right:20px; padding:10px 16px; border-radius:var(--radius); font-size:13px; font-weight:500; box-shadow:var(--shadow-md); z-index:100; animation:slideIn 0.2s ease; }
.toast-success { background:var(--success-light); color:var(--success); border:1px solid #86efac; }
.toast-error { background:var(--danger-light); color:var(--danger); border:1px solid #fca5a5; }
.toast-warning { background:var(--warning-light); color:var(--warning); border:1px solid #fcd34d; }
.toast-info { background:var(--primary-light); color:var(--primary); border:1px solid #93c5fd; }
@keyframes slideIn { from{transform:translateY(10px);opacity:0} to{transform:translateY(0);opacity:1} }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
</style>
</head>
<body>

<header class="header">
  <div class="header-title">
    <span class="icon">📈</span>
    Investment Analysis Dashboard
  </div>
  <div class="cost-display">
    <span class="token-detail" id="header-tokens" style="display:none"></span>
    <span class="cost-pill" id="header-cost" style="display:none"></span>
    <span style="font-size:12px;color:var(--text-muted)">Powered by Claude Managed Agents</span>
  </div>
</header>

<div class="layout">

  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="tab-nav">
      <button class="tab-btn active" id="tab-analysis" onclick="switchTab('analysis')">📋 Analysis</button>
      <button class="tab-btn" id="tab-history" onclick="switchTab('history')">🕓 History</button>
    </div>

    <!-- Analysis Tab -->
    <div class="tab-panel active" id="panel-analysis">
      <div class="sidebar-section">
        <div class="section-title">📂 Documents</div>
        <div class="dropzone" id="dropzone">
          <p>Drop files here or</p>
          <button class="btn-link" onclick="document.getElementById('file-input').click()">Browse files</button>
          <input type="file" id="file-input" multiple accept=".pdf,.xlsx,.pptx,.docx,.csv,.txt" style="display:none">
        </div>
        <div class="file-list" id="file-list"><p class="empty-state">Loading…</p></div>
        <div class="file-actions" id="file-actions" style="display:none">
          <button class="btn-link" onclick="selectAll()">Select all</button>
          <button class="btn-link" onclick="clearAll()">Clear</button>
        </div>
      </div>

      <div class="sidebar-section">
        <div class="section-title">🎯 Analysis</div>
        <div class="form-group">
          <label class="label" for="ticker">Ticker Symbol</label>
          <input class="input" type="text" id="ticker" placeholder="e.g. AAPL" maxlength="10" autocomplete="off">
        </div>
      </div>

      <div class="sidebar-section">
        <div class="section-title">⚡ Actions</div>
        <button class="btn btn-primary" id="analyze-btn" onclick="startAnalysis()" disabled>▶ Run Analysis</button>
        <button class="btn btn-danger" id="delete-btn" onclick="deleteSession()" disabled>🗑 Delete Session &amp; Environment</button>
      </div>
    </div>

    <!-- History Tab -->
    <div class="tab-panel" id="panel-history">
      <div id="history-list" style="flex:1;overflow-y:auto">
        <div class="no-history">No analyses yet.<br>Run one to see it here.</div>
      </div>
    </div>
  </aside>

  <!-- Main Panel -->
  <main class="main-panel">

    <!-- Status Bar -->
    <div class="status-bar">
      <span class="status-badge status-ready" id="status-badge">Ready</span>
      <div class="spinner" id="spinner" style="display:none"></div>
      <span class="session-id-label" id="session-id-label" style="display:none"></span>
      <div class="token-bar" id="token-bar" style="display:none">
        <span>In: <span class="tok-val" id="tok-in">0</span></span>
        <span>Out: <span class="tok-val" id="tok-out">0</span></span>
        <span>Cached: <span class="tok-val" id="tok-cache">0</span></span>
        <span class="tok-cost" id="tok-cost">$0.0000</span>
      </div>
    </div>

    <!-- Content Area -->
    <div class="content-area">

      <!-- Analysis view -->
      <div id="analysis-view" style="display:flex;flex:1;overflow:hidden">
        <div class="output-panel">
          <div class="panel-title">Analysis Output</div>
          <div class="output-box" id="output">
            <span class="out-placeholder">Analysis output will appear here. Select documents, enter a ticker, and run the analysis.</span>
          </div>
        </div>

        <div class="right-panel">
          <div class="right-panel-section grows">
            <div class="section-header">
              <div class="panel-title">Activity</div>
            </div>
            <div class="activity-list" id="activity-list"></div>
          </div>
          <div class="right-panel-section" id="downloads-section" style="display:none">
            <div class="section-header" style="display:flex;align-items:center;justify-content:space-between">
              <div class="panel-title">📥 Output Files</div>
              <span id="downloads-loading" style="font-size:11px;color:var(--text-muted)"></span>
            </div>
            <div class="downloads-section" id="downloads-list"></div>
          </div>
        </div>
      </div>

      <!-- History detail view -->
      <div id="history-view" style="display:none;flex:1;overflow:hidden">
        <div class="history-detail" id="history-detail-content">
          <p style="color:var(--text-muted);font-size:13px">Select a session from the history to view details.</p>
        </div>
      </div>

    </div>
  </main>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────

let files = [];
let activeSessionId = null;
let eventSource = null;
let outputStarted = false;
let currentView = 'analysis';     // 'analysis' | 'history'
let viewingSessionId = null;      // session shown in history detail
let runningTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

// ── Pricing (matching server) ─────────────────────────────────────────────────

const PRICE = { input: 3.00/1e6, output: 15.00/1e6, cacheWrite: 3.75/1e6, cacheRead: 0.30/1e6 };

function calcCost(u) {
  return u.inputTokens * PRICE.input + u.outputTokens * PRICE.output +
    u.cacheCreationTokens * PRICE.cacheWrite + u.cacheReadTokens * PRICE.cacheRead;
}

function fmtCost(c) { return '$' + c.toFixed(4); }
function fmtNum(n) { return (n || 0).toLocaleString(); }
function fmtBytes(b) { if(!b) return '—'; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
function fmtDate(iso) { if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fileIcon(name) { if(name.endsWith('.pdf')) return '📄'; if(name.endsWith('.xlsx')||name.endsWith('.csv')) return '📊'; if(name.endsWith('.pptx')) return '📑'; return '📝'; }

// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById('tab-analysis').classList.toggle('active', tab==='analysis');
  document.getElementById('tab-history').classList.toggle('active', tab==='history');
  document.getElementById('panel-analysis').classList.toggle('active', tab==='analysis');
  document.getElementById('panel-history').classList.toggle('active', tab==='history');
  if(tab==='history') { loadHistory(); }
}

// ── View switching ────────────────────────────────────────────────────────────

function showAnalysisView() {
  currentView = 'analysis';
  document.getElementById('analysis-view').style.display = 'flex';
  document.getElementById('history-view').style.display = 'none';
  viewingSessionId = null;
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active-view'));
}

function showHistoryView(sessionId) {
  currentView = 'history';
  viewingSessionId = sessionId;
  document.getElementById('analysis-view').style.display = 'none';
  document.getElementById('history-view').style.display = 'flex';
  document.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active-view', el.dataset.sid === sessionId));
  renderHistoryDetail(sessionId);
}

// ── File Management ───────────────────────────────────────────────────────────

async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    const prev = new Map(files.map(f => [f.id, f.selected]));
    files = data.map(f => ({ ...f, selected: prev.get(f.id) ?? false }));
    renderFileList();
  } catch(e) { addActivity('error','Load files failed',String(e)); }
}

function renderFileList() {
  const el = document.getElementById('file-list');
  const act = document.getElementById('file-actions');
  if(!files.length) { el.innerHTML = '<p class="empty-state">No files uploaded yet</p>'; act.style.display='none'; updateControls(); return; }
  act.style.display = 'flex';
  el.innerHTML = files.map(f => \`<div class="file-item \${f.selected?'selected':''}" data-id="\${f.id}">
    <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;min-width:0">
      <input type="checkbox" \${f.selected?'checked':''} onchange="toggleFile('\${f.id}')" style="width:15px;height:15px;accent-color:var(--primary);flex-shrink:0">
      <span class="file-icon">\${fileIcon(f.filename)}</span>
      <span class="file-name" title="\${escHtml(f.filename)}">\${escHtml(f.filename)}</span>
    </label>
    <span class="file-size">\${fmtBytes(f.size)}</span>
    <button class="icon-btn" onclick="deleteFile('\${f.id}')" title="Remove">✕</button>
  </div>\`).join('');
  updateControls();
}

function toggleFile(id) { const f=files.find(f=>f.id===id); if(f) f.selected=!f.selected; renderFileList(); }
function selectAll() { files.forEach(f=>f.selected=true); renderFileList(); }
function clearAll() { files.forEach(f=>f.selected=false); renderFileList(); }

async function uploadFiles(fileList) {
  for(const file of fileList) {
    const actId = addActivity('upload','Uploading',file.name);
    const fd = new FormData(); fd.append('file',file);
    try {
      const res = await fetch('/api/files',{method:'POST',body:fd});
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      if(data.isDuplicate) {
        updateActivity(actId,'duplicate','Already uploaded',data.filename);
        if(!files.find(f=>f.id===data.id)) files.push({...data,selected:true});
      } else {
        updateActivity(actId,'success','Uploaded',data.filename);
        files.push({...data,selected:true});
      }
      renderFileList();
    } catch(e) { updateActivity(actId,'error','Upload failed',String(e)); }
  }
}

async function deleteFile(id) {
  if(!confirm('Remove this file from Anthropic?')) return;
  try {
    await fetch('/api/files/'+id,{method:'DELETE'});
    files = files.filter(f=>f.id!==id); renderFileList(); showToast('File removed','success');
  } catch(e) { showToast('Delete failed: '+String(e),'error'); }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

async function startAnalysis() {
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  const selected = files.filter(f=>f.selected);
  if(!ticker) { showToast('Enter a ticker symbol','warning'); return; }
  if(!selected.length) { showToast('Select at least one document','warning'); return; }

  // Reset
  document.getElementById('output').innerHTML = '';
  document.getElementById('activity-list').innerHTML = '';
  document.getElementById('downloads-section').style.display = 'none';
  document.getElementById('downloads-list').innerHTML = '';
  outputStarted = false;
  runningTokens = { input:0, output:0, cacheCreation:0, cacheRead:0 };
  setStatus('starting'); showSpinner(true);
  document.getElementById('analyze-btn').disabled = true;
  document.getElementById('token-bar').style.display = 'none';
  document.getElementById('header-cost').style.display = 'none';
  document.getElementById('header-tokens').style.display = 'none';

  // Switch to analysis view
  showAnalysisView();
  switchTab('analysis');

  try {
    const res = await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ticker, files: selected.map(f=>({id:f.id,filename:f.filename}))})});
    const data = await res.json();
    if(data.error) throw new Error(data.error);

    activeSessionId = data.sessionId;
    document.getElementById('delete-btn').disabled = false;
    document.getElementById('session-id-label').textContent = data.sessionId;
    document.getElementById('session-id-label').style.display = 'inline';

    openStream(data.sessionId);
  } catch(e) {
    setStatus('error'); showSpinner(false);
    appendOutput('\\n⚠️ Failed to start: '+String(e),'out-error');
    document.getElementById('analyze-btn').disabled = false;
  }
}

// ── SSE Stream ────────────────────────────────────────────────────────────────

function openStream(sessionId) {
  if(eventSource) { eventSource.close(); eventSource=null; }
  eventSource = new EventSource('/api/sessions/'+sessionId+'/stream');

  eventSource.addEventListener('agent.message', e => {
    const ev = JSON.parse(e.data);
    for(const block of (ev.content||[])) {
      if(block.type==='text'&&block.text) {
        if(!outputStarted) { document.getElementById('output').innerHTML=''; outputStarted=true; }
        appendOutput(block.text,'out-text');
      }
    }
  });

  eventSource.addEventListener('agent.tool_use', e => {
    const ev = JSON.parse(e.data);
    addActivity('tool', ev.name||ev.tool_name||'tool', truncate(JSON.stringify(ev.input||{}),80));
  });
  eventSource.addEventListener('agent.mcp_tool_use', e => {
    const ev = JSON.parse(e.data);
    addActivity('tool','MCP: '+(ev.tool_name||ev.name||'tool'),'');
  });
  eventSource.addEventListener('agent.custom_tool_use', e => {
    const ev = JSON.parse(e.data);
    addActivity('tool','Custom: '+(ev.tool_name||ev.name||'tool'),'');
  });

  eventSource.addEventListener('session.status_running', () => { setStatus('running'); showSpinner(true); });
  eventSource.addEventListener('session.status_idle', e => {
    const ev = JSON.parse(e.data);
    const reason = ev.stop_reason && ev.stop_reason.type;
    if(reason==='requires_action') { setStatus('waiting'); addActivity('state','Waiting for action',''); }
    else if(reason==='retries_exhausted') { setStatus('error'); showSpinner(false); appendOutput('\\n⚠️ Retries exhausted.','out-error'); }
    else { setStatus('idle'); showSpinner(false); }
  });
  eventSource.addEventListener('session.status_rescheduled', () => { addActivity('state','Rescheduling…',''); });
  eventSource.addEventListener('session.status_terminated', () => { setStatus('idle'); showSpinner(false); closeStream(); });

  eventSource.addEventListener('session.error', e => {
    const ev = JSON.parse(e.data);
    const msg = (ev.error&&ev.error.message)||'Session error';
    appendOutput('\\n⚠️ '+msg,'out-error'); setStatus('error'); showSpinner(false);
    addActivity('error','Session error',msg); closeStream();
  });

  // Running cost update from server
  eventSource.addEventListener('stream.usage', e => {
    const { tokenUsage, cost } = JSON.parse(e.data);
    updateTokenDisplay(tokenUsage, cost);
  });

  eventSource.addEventListener('stream.done', e => {
    const { cost, tokenUsage } = JSON.parse(e.data);
    setStatus('complete'); showSpinner(false);
    appendOutput('\\n\\n✅ Analysis complete.','out-complete');
    updateTokenDisplay(tokenUsage, cost);
    addActivity('success','Complete', fmtCost(cost)+' total');
    document.getElementById('analyze-btn').disabled = false;
    closeStream();
    document.getElementById('downloads-section').style.display = 'block';
    document.getElementById('downloads-loading').textContent = 'Checking for files…';
    loadHistory();
  });

  eventSource.addEventListener('stream.outputs', e => {
    const { files } = JSON.parse(e.data);
    document.getElementById('downloads-loading').textContent = '';
    renderDownloads(activeSessionId, files);
  });

  eventSource.addEventListener('stream.error', e => {
    const data = JSON.parse(e.data);
    appendOutput('\\n⚠️ '+(data.message||'Stream error'),'out-error');
    setStatus('error'); showSpinner(false);
    addActivity('error','Stream error',data.message||'');
    document.getElementById('analyze-btn').disabled = false;
    closeStream(); loadHistory();
  });

  eventSource.onerror = () => {
    if(eventSource&&eventSource.readyState===EventSource.CLOSED) return;
    if(eventSource&&eventSource.readyState===EventSource.CONNECTING) return;
    appendOutput('\\n⚠️ Connection lost.','out-error');
    setStatus('error'); showSpinner(false);
    document.getElementById('analyze-btn').disabled = false;
    closeStream();
  };
}

function closeStream() { if(eventSource) { eventSource.close(); eventSource=null; } }

function updateTokenDisplay(tokenUsage, cost) {
  const bar = document.getElementById('token-bar');
  bar.style.display = 'flex';
  document.getElementById('tok-in').textContent = fmtNum(tokenUsage.inputTokens);
  document.getElementById('tok-out').textContent = fmtNum(tokenUsage.outputTokens);
  document.getElementById('tok-cache').textContent = fmtNum(tokenUsage.cacheReadTokens);
  document.getElementById('tok-cost').textContent = fmtCost(cost);

  // Header pill
  const pill = document.getElementById('header-cost');
  pill.style.display = 'inline-flex';
  pill.textContent = fmtCost(cost);
  pill.classList.add('has-cost');
  const tokDetail = document.getElementById('header-tokens');
  tokDetail.style.display = 'inline';
  tokDetail.textContent = fmtNum(tokenUsage.inputTokens+tokenUsage.outputTokens)+' total tokens';
}

function renderDownloads(sessionId, outputFiles) {
  const el = document.getElementById('downloads-list');
  if(!outputFiles||!outputFiles.length) { el.innerHTML='<p class="no-outputs">No output files found.</p>'; return; }
  el.innerHTML = outputFiles.map(f => \`
    <div class="download-file-row">
      <span class="dfr-icon">\${fileIcon(f.filename)}</span>
      <span class="dfr-name" title="\${escHtml(f.filename)}">\${escHtml(f.filename)}</span>
      <span class="dfr-size">\${fmtBytes(f.size)}</span>
      <a class="download-btn" href="/api/sessions/\${sessionId}/outputs/\${f.id}/download" download="\${escHtml(f.filename)}">⬇ Download</a>
    </div>
  \`).join('');
}

// ── Delete Session ────────────────────────────────────────────────────────────

async function deleteSession() {
  if(!activeSessionId) return;
  if(!confirm('Delete this session and environment? Uploaded files in Anthropic are preserved.')) return;
  const btn = document.getElementById('delete-btn');
  btn.disabled = true; closeStream();
  try {
    const res = await fetch('/api/sessions/'+activeSessionId,{method:'DELETE'});
    const data = await res.json();
    if(data.errors&&data.errors.length) showToast('Partial cleanup: '+data.errors.join('; '),'warning');
    else showToast('Session deleted','success');
    activeSessionId = null;
    document.getElementById('session-id-label').style.display='none';
    document.getElementById('token-bar').style.display='none';
    document.getElementById('header-cost').style.display='none';
    document.getElementById('header-tokens').style.display='none';
    setStatus('ready');
    document.getElementById('analyze-btn').disabled = !canAnalyze();
    loadHistory();
  } catch(e) { showToast('Delete failed: '+String(e),'error'); btn.disabled=false; }
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    renderHistoryList(sessions);
  } catch(e) { /* silent */ }
}

function renderHistoryList(sessions) {
  const el = document.getElementById('history-list');
  if(!sessions||!sessions.length) { el.innerHTML='<div class="no-history">No analyses yet.<br>Run one to see it here.</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const statusPill = s.status==='complete' ? 'status-complete-pill' : s.status==='error' ? 'status-error-pill' : 'status-running-pill';
    const statusLabel = s.status==='complete' ? '✅ Done' : s.status==='error' ? '❌ Error' : '⏳ Running';
    const dt = fmtDate(s.startedAt);
    const cost = s.cost ? fmtCost(s.cost) : '—';
    const outCount = s.outputFiles&&s.outputFiles.length ? s.outputFiles.length+' file'+(s.outputFiles.length>1?'s':'') : '';
    return \`<div class="history-item" data-sid="\${s.sessionId}" onclick="handleHistoryClick('\${s.sessionId}')">
      <div class="history-row1">
        <span class="history-ticker">$\${escHtml(s.ticker)}</span>
        <span class="history-status \${statusPill}">\${statusLabel}</span>
        \${outCount ? '<span class="history-files-count">'+escHtml(outCount)+'</span>' : ''}
      </div>
      <div class="history-row2">
        <span class="history-meta">\${dt}</span>
        \${cost!=='—' ? '<span class="history-cost">'+cost+'</span>' : ''}
      </div>
    </div>\`;
  }).join('');
  // Re-apply active state
  if(viewingSessionId) {
    document.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active-view', el.dataset.sid===viewingSessionId));
  }
}

function handleHistoryClick(sessionId) {
  switchTab('history');
  showHistoryView(sessionId);
}

async function renderHistoryDetail(sessionId) {
  const el = document.getElementById('history-detail-content');
  el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:20px">Loading…</p>';
  try {
    const res = await fetch('/api/sessions/'+sessionId);
    const s = await res.json();

    const u = s.tokenUsage || {};
    const cost = s.cost || 0;
    const dur = s.startedAt&&s.completedAt
      ? (((new Date(s.completedAt)-new Date(s.startedAt))/1000)|0)+'s'
      : '—';

    // Fetch outputs if not already on the session
    let outputFiles = s.outputFiles || [];
    if(!outputFiles.length) {
      try {
        const oRes = await fetch('/api/sessions/'+sessionId+'/outputs');
        outputFiles = await oRes.json();
      } catch { /* no outputs yet */ }
    }

    const filesHtml = outputFiles.length
      ? outputFiles.map(f => \`
        <div class="output-file-item">
          <span class="of-icon">\${fileIcon(f.filename)}</span>
          <span class="of-name" title="\${escHtml(f.filename)}">\${escHtml(f.filename)}</span>
          <span class="of-size">\${fmtBytes(f.size)}</span>
          <a class="download-btn" href="/api/sessions/\${sessionId}/outputs/\${f.id}/download" download="\${escHtml(f.filename)}">⬇ Download</a>
        </div>
      \`).join('')
      : '<p class="no-outputs">No output files found.</p>';

    el.innerHTML = \`
      <div class="detail-card">
        <div class="detail-ticker">$\${escHtml(s.ticker)}</div>
        <div class="detail-meta">
          <div class="detail-meta-item"><span class="detail-meta-label">Status</span><span class="detail-meta-value">\${s.status==='complete'?'✅ Complete':s.status==='error'?'❌ Error':'⏳ Running'}</span></div>
          <div class="detail-meta-item"><span class="detail-meta-label">Duration</span><span class="detail-meta-value">\${dur}</span></div>
          <div class="detail-meta-item"><span class="detail-meta-label">Started</span><span class="detail-meta-value">\${fmtDate(s.startedAt)}</span></div>
          <div class="detail-meta-item"><span class="detail-meta-label">Source files</span><span class="detail-meta-value">\${s.files?s.files.length:0}</span></div>
        </div>
      </div>

      <div class="detail-card">
        <h3>Cost Breakdown</h3>
        <table class="cost-table">
          <tr><td>Input tokens</td><td>\${fmtNum(u.inputTokens)}</td><td>\${fmtCost((u.inputTokens||0)*PRICE.input)}</td></tr>
          <tr><td>Output tokens</td><td>\${fmtNum(u.outputTokens)}</td><td>\${fmtCost((u.outputTokens||0)*PRICE.output)}</td></tr>
          <tr><td>Cache write</td><td>\${fmtNum(u.cacheCreationTokens)}</td><td>\${fmtCost((u.cacheCreationTokens||0)*PRICE.cacheWrite)}</td></tr>
          <tr><td>Cache read</td><td>\${fmtNum(u.cacheReadTokens)}</td><td>\${fmtCost((u.cacheReadTokens||0)*PRICE.cacheRead)}</td></tr>
          <tr class="cost-total"><td colspan="2">Total cost</td><td>\${fmtCost(cost)}</td></tr>
        </table>
      </div>

      <div class="detail-card">
        <h3>Output Files</h3>
        <div class="output-files-list">\${filesHtml}</div>
      </div>
    \`;
  } catch(e) { el.innerHTML='<p style="color:var(--text-muted);padding:20px">Failed to load: '+escHtml(String(e))+'</p>'; }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function appendOutput(text, cls) {
  const el = document.getElementById('output');
  const span = document.createElement('span');
  if(cls) span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

const ICONS = { tool:'🔧', tokens:'📊', upload:'📤', success:'✅', error:'❌', duplicate:'♻️', state:'⚙️' };
let actCount = 0;
function addActivity(type, label, detail) {
  const id = 'act-'+(++actCount);
  const el = document.getElementById('activity-list');
  const div = document.createElement('div');
  div.id = id; div.className='activity-item activity-'+type;
  div.innerHTML = \`<span class="ai-icon">\${ICONS[type]||'•'}</span><span class="ai-content"><span class="ai-label">\${escHtml(label)}</span>\${detail?'<span class="ai-detail">'+escHtml(detail)+'</span>':''}</span>\`;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
  return id;
}
function updateActivity(id, type, label, detail) {
  const el = document.getElementById(id); if(!el) return;
  el.className='activity-item activity-'+type;
  el.innerHTML=\`<span class="ai-icon">\${ICONS[type]||'•'}</span><span class="ai-content"><span class="ai-label">\${escHtml(label)}</span>\${detail?'<span class="ai-detail">'+escHtml(detail)+'</span>':''}</span>\`;
}

const STATUS_CFG = {
  ready:{text:'Ready',cls:'status-ready'}, starting:{text:'Starting…',cls:'status-running'},
  running:{text:'Running',cls:'status-running'}, waiting:{text:'Waiting',cls:'status-warning'},
  idle:{text:'Idle',cls:'status-idle'}, complete:{text:'Complete',cls:'status-complete'},
  error:{text:'Error',cls:'status-error'},
};
function setStatus(state) {
  const cfg = STATUS_CFG[state]||{text:state,cls:'status-idle'};
  const b = document.getElementById('status-badge');
  b.className = 'status-badge '+cfg.cls;
  if(state==='running') {
    b.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;animation:pulse 1.2s infinite"></span> '+escHtml(cfg.text);
  } else { b.textContent = cfg.text; }
}
function showSpinner(v) { document.getElementById('spinner').style.display=v?'block':'none'; }
function canAnalyze() { return files.some(f=>f.selected)&&document.getElementById('ticker').value.trim().length>0&&!eventSource; }
function updateControls() { document.getElementById('analyze-btn').disabled=!canAnalyze()||!!activeSessionId; }
function truncate(s,n) { return s.length>n?s.slice(0,n)+'…':s; }
function showToast(msg,type) {
  const t=document.createElement('div'); t.className='toast toast-'+(type||'info'); t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3500);
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', e=>{ e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()=>dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e=>{ e.preventDefault(); dropzone.classList.remove('drag-over'); uploadFiles([...e.dataTransfer.files]); });
document.getElementById('file-input').addEventListener('change', e=>{ uploadFiles([...e.target.files]); e.target.value=''; });
document.getElementById('ticker').addEventListener('input', e=>{
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9.]/g,'');
  updateControls();
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadFiles();
loadHistory();
</script>
</body>
</html>`;

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 3000);

app.listen(PORT, async () => {
  console.log(`\n🚀 Investment Dashboard at http://localhost:${PORT}\n`);
  await getOrCreateAgent().catch(err => console.error("⚠️  Agent init failed:", String(err)));
});
