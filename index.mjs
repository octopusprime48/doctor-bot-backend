// index.mjs
import express from "express";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// Allow ONLY your Lovable site (add other domains if you have staging)
app.use(cors({
  origin: ["https://career-clinician-chat.lovable.app"],
  methods: ["GET","POST","OPTIONS"],
}));

// --- Safe jobs load (won't crash if file missing/invalid) ---
let JOBS = [];
try {
  const raw = fs.readFileSync("./data/jobs.json", "utf8");
  JOBS = JSON.parse(raw);
  console.log(`[boot] Loaded ${JOBS.length} jobs`);
} catch (e) {
  console.error("[boot] jobs.json load failed:", e.message);
  JOBS = []; // keep app alive; endpoints just return []
}

// --- Helpers ---
const norm = s => String(s ?? "").trim();
const same = (a,b) => norm(a).toUpperCase() === norm(b).toUpperCase();

function filterJobs({ state, profession, specialty, unit, minRate }) {
  const min = Number(minRate) || 0;
  return JOBS.filter(j => {
    if (state && !same(j.state, state)) return false;
    if (profession && !same(j.profession, profession)) return false;
    if (specialty && !same(j.specialty, specialty)) return false;
    if (unit && norm(j.rate_unit).toLowerCase() !== norm(unit).toLowerCase()) return false;
    if (min && Number(j.rate_numeric || 0) < min) return false;
    return true;
  });
}

const NEIGHBORS = { TX:["NM","OK","AR","LA"], OK:["CO","KS","MO","AR","TX","NM"], NM:["AZ","UT","CO","OK","TX"], IN:["MI","OH","KY","IL"], /* …(rest optional)*/ };

function findWithNearby(filters, maxNeighborStates = 4) {
  const primary = filterJobs(filters);
  if (primary.length || !filters.state) return { matches: primary, usedStates: [filters.state].filter(Boolean) };
  const state = String(filters.state).toUpperCase();
  const neighbors = NEIGHBORS[state] || [];
  let alt = [];
  const tried = [state];
  for (const ns of neighbors.slice(0, maxNeighborStates)) {
    const pick = filterJobs({ ...filters, state: ns });
    if (pick.length) alt = alt.concat(pick);
    tried.push(ns);
    if (alt.length >= 10) break;
  }
  return { matches: alt, usedStates: tried };
}

// --- Basic endpoints (documented in your project summary) ---
app.get("/", (_, res) => res.type("text").send("OK")); // health check  
app.get("/api/jobs", (req, res) => res.json(JOBS));    // list           
app.get("/api/jobs/:id", (req, res) => {
  const j = JOBS.find(x => String(x.job_id) === String(req.params.id));
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

// Optional strict search endpoint for the UI
app.get("/api/search", (req, res) => {
  const { matches } = findWithNearby({
    state: req.query.state,
    profession: req.query.profession,
    specialty: req.query.specialty,
    unit: req.query.unit,
    minRate: req.query.minRate
  });
  res.json(matches); // may be []
});

// --- Grounded chat: can format & answer lifestyle, but NEVER invent jobs ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractFiltersFromText(text) {
  const out = {};
  const st = text.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i);
  if (st) out.state = st[0].toUpperCase();
  if (/\bCRNA\b/i.test(text)) out.profession = "CRNA";
  else if (/\bNP\b/i.test(text)) out.profession = "NP";
  else if (/\bPA\b/i.test(text)) out.profession = "PA";
  else if (/\bMD\b/i.test(text)) out.profession = "MD";
  if (/\bANESTH/i.test(text)) out.specialty = "Anesthesiology";
  if (/\bRADIOLOG/i.test(text)) out.specialty = "Diagnostic Radiology";
  const r = text.match(/(\$?\d{2,4})(?:\s*\/\s*(hour|hr|day))/i);
  if (r) { out.minRate = r[1].replace(/\$/g,""); out.unit = /day/i.test(r[2]) ? "day" : "hour"; }
  return out;
}

app.post("/api/chat", async (req, res) => {
  try {
    const message = norm(req.body.message || "");
    const clientFilters = req.body.filters || {};
    const parsed = extractFiltersFromText(message);
    const filters = { ...parsed, ...clientFilters };

    const { matches } = findWithNearby(filters);

    const system = `
You are a helpful healthcare career guide.

RULES:
- Never invent job openings or details. You may only reference jobs from MATCHES_JSON.
- If MATCHES_JSON is empty for the requested place, offer nearby alternatives (clearly labeled as nearby).
- You may answer lifestyle/region questions (weather, cost of living, things to do) with general knowledge,
  but do not claim a job exists if it isn’t in MATCHES_JSON.
- When listing jobs, include: title, city/state, rate (rate_numeric + rate_unit), and job_id. Keep it concise.
- Do not mention facility names.`;

    const user = `
User message: ${message}
Filters used: ${JSON.stringify(filters)}
MATCHES_JSON (the ONLY jobs you may reference):
${JSON.stringify(matches, null, 2)}
Task:
1) If user asked for jobs, list ONLY items from MATCHES_JSON (or say no current matches).
2) If user asked lifestyle/area questions, answer those too.
3) Never invent jobs; do not add items not present in MATCHES_JSON.`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    });

    res.json({ text: ai.choices?.[0]?.message?.content ?? "", jobs: matches });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    res.status(500).json({ error: "chat_failed" });
  }
});

// --- Always listen (prevents “exited early”) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
