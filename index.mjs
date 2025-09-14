// ==========================
// index.mjs (complete server)
// ==========================

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { readFileSync } from "node:fs";

const app = express();
app.use(cors());
app.use(express.json());

// --------------------------
// In-memory session memory
// --------------------------
const sessions = new Map(); // session_id -> [{role, content}]
function getHistory(session_id) {
  if (!sessions.has(session_id)) sessions.set(session_id, []);
  return sessions.get(session_id);
}
function pushMsg(session_id, msg) {
  const h = getHistory(session_id);
  h.push(msg);
  if (h.length > 24) h.splice(0, h.length - 24); // keep ~12 turns
}

// --------------------------
// OpenAI client
// --------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------------
// SSE helpers
// --------------------------
function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// --------------------------
// CHAT: streams like ChatGPT
// --------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { message = "", session_id = "anon" } = req.body || {};
    sseHeaders(res);

    const SYSTEM_PROMPT = `
You are a helpful, candid assistant for clinicians looking for jobs and guidance.
- Keep answers concise and conversational.
- If the user asks about jobs, suggest realistic options and trade-offs.
- Never reveal facility names; show rate first, then title, then "City, ST", JO-ID, Priority.
    `.trim();

    const history = getHistory(session_id);
    const msgs = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ];

    pushMsg(session_id, { role: "user", content: message });

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini", // fast & inexpensive
      stream: true,
      temperature: 0.4,
      messages: msgs,
    });

    let assistantText = "";
    sseSend(res, { type: "text", data: "" }); // prime client

    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta;
      if (delta?.content) {
        assistantText += delta.content;
        sseSend(res, { type: "text", data: delta.content });
      }
    }

    if (assistantText) pushMsg(session_id, { role: "assistant", content: assistantText });

    // Add jobs block if user asked about jobs
    if (/\b(crna|anesth|urology|radiology|urgent care|job|jobs|locum)\b/i.test(message)) {
      const items = JOBS.slice(0, 3);
      sseSend(res, { type: "blocks", data: [{ type: "jobs", items }] });
    }

    res.end();
  } catch (e) {
    console.error(e);
    sseSend(res, { type: "text", data: "\n(Sorry, something went wrong.)" });
    res.end();
  }
});

// --------------------------
// JOBS API (from data/jobs.json)
// --------------------------
const jobsData = JSON.parse(
  readFileSync(new URL("./data/jobs.json", import.meta.url), "utf8")
);

const JOBS = jobsData.map((j) => ({
  ...j,
  rate:
    j.rate ||
    (j.rate_numeric && j.rate_unit
      ? `$${j.rate_numeric}/${j.rate_unit === "day" ? "day" : "hr"}`
      : undefined),
  url: j.url || `/jobs/${j.job_id}`,
}));

app.get("/api/jobs", (_req, res) => {
  res.json(JOBS);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = JOBS.find((j) => String(j.job_id) === String(req.params.id));
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({
    ...job,
    description:
      job.description ||
      "Details coming soon. Contact us for the full scope, schedule, and site information.",
  });
});

// --------------------------
// Health check
// --------------------------
app.get("/", (_req, res) => res.send("OK"));

// --------------------------
// Start server
// --------------------------
app.listen(process.env.PORT || 3000, () => console.log("Server running"));
