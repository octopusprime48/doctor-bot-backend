import express from "express";
import fs from "fs";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(cors({ origin: ["https://career-clinician-chat.lovable.app"] }));

// Load jobs once at startup (Render-safe)
const JOBS = JSON.parse(fs.readFileSync("./data/jobs.json", "utf8"));

// --- tiny helpers ---
const norm = (s) => String(s || "").trim();
const same = (a, b) => norm(a).toUpperCase() === norm(b).toUpperCase();

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

// very lightweight “intent/filters” extractor
function extractFiltersFromText(text) {
  const out = {};
  const mState = text.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i);
  if (mState) out.state = mState[0].toUpperCase();

  // trivial profession/specialty grab
  if (/\bCRNA\b/i.test(text)) out.profession = "CRNA";
  else if (/\bANESTH(ESIA|ESIOLOG(Y|IST))\b/i.test(text)) out.specialty = "Anesthesiology";
  else if (/\bRAD(IOLOGY|IOLOGIST)\b/i.test(text)) out.specialty = "Diagnostic Radiology";
  else if (/\bNP\b/i.test(text)) out.profession = "NP";
  else if (/\bPA\b/i.test(text)) out.profession = "PA";
  else if (/\bMD\b/i.test(text)) out.profession = "MD";

  const rate = text.match(/(\$?\d{2,4})(?:\s*\/\s*(hour|hr|day))/i);
  if (rate) {
    out.minRate = rate[1].replace(/\$/g, "");
    out.unit = /day/i.test(rate[2]) ? "day" : "hour";
  }
  return out;
}

// --- the grounded chat endpoint ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    const message = norm(req.body.message || "");
    const clientFilters = req.body.filters || {};
    const parsed = extractFiltersFromText(message);
    const filters = { ...parsed, ...clientFilters }; // UI can pass structured filters too

    // Run a real search over JSON
    const matches = filterJobs(filters);

    // Build a strict system message: model may NOT invent jobs
    const system = `
You are a helpful healthcare career guide.
RULES:
- You may NOT invent job openings or details. You can only mention jobs contained in MATCHES_JSON.
- If MATCHES_JSON is empty, say there are no current matches and ask clarifying preferences (state, specialty, profession, rate).
- You ARE allowed to answer lifestyle/region questions (weather, cost of living, things to do) using general knowledge,
  but do not claim a job exists if it's not in MATCHES_JSON.
- When listing jobs, show: title, city/state, rate (rate_numeric + rate_unit), and job_id. Keep it concise.
`;

    const user = `
User message: ${message}

Filters used: ${JSON.stringify(filters)}

MATCHES_JSON (these are the ONLY jobs you may reference):
${JSON.stringify(matches, null, 2)}

Task:
1) If user intent includes "find/show jobs", list ONLY the jobs from MATCHES_JSON (or say none).
2) If the user also asked general questions (about an area, commute, lifestyle, etc.), answer those normally.
3) Never invent jobs, titles, or rates.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3, // keep it factual
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    res.json({
      text: completion.choices?.[0]?.message?.content || "",
      jobs: matches // let the frontend also render cards from real data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "chat_failed" });
  }
});

