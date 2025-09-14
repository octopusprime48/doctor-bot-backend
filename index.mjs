import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";

// ---------- server setup ----------
const app = express();
app.use(cors());
app.use(express.json());

// keep-alive SSE headers (disable buffering & flush early)
function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------- session memory ----------
const sessions = new Map(); // session_id -> [{role, content}]
function getHistory(session_id) {
  if (!sessions.has(session_id)) sessions.set(session_id, []);
  return sessions.get(session_id);
}
function pushMsg(session_id, msg) {
  const h = getHistory(session_id);
  h.push(msg);
  if (h.length > 24) h.splice(0, h.length - 24); // keep last ~12 turns
}

// ---------- load jobs ----------
let JOBS = [];
try {
  JOBS = JSON.parse(fs.readFileSync("./data/jobs.json", "utf-8"));
} catch (e) {
  console.error("Failed to load ./data/jobs.json:", e.message);
  JOBS = [];
}

// ensure each job has a url (fallback to /jobs/:id if missing)
JOBS = JOBS.map(j => ({
  ...j,
  url: j.url || `https://your-site.com/jobs/${j.job_id}`,
}));

// ---------- intent parsing & search ----------
const STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY",
  "LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH",
  "OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY"
]);
const STATE_NAME = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
  "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC",
  "north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR","pennsylvania":"PA",
  "rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN","texas":"TX",
  "utah":"UT","vermont":"VT","virginia":"VA","washington":"WA","west virginia":"WV",
  "wisconsin":"WI","wyoming":"WY"
};

function parseAsk(text = "") {
  const t = text.toLowerCase();

  // profession / specialty (expand as needed)
  let profession = null, specialty = null;
  if (/\bcrna\b|anesth/i.test(t)) { profession = "CRNA"; specialty = "Anesthesia"; }
  if (/\burgent care\b/.test(t)) { profession = "Physician"; specialty = "Urgent Care"; }
  if (/\bnp\b|\bnurse practitioner\b/.test(t)) { profession = "NP"; }
  if (/\bpa\b(?!y)/.test(t)) { profession = "PA"; }
  if (/\bradiolog/i.test(t)) { profession = "Physician"; specialty = "Radiology"; }

  // state (2-letter or name)
  let state = null;
  const mState = t.match(/\b([A-Z]{2})\b/i);
  if (mState && STATES.has(mState[1].toUpperCase())) state = mState[1].toUpperCase();
  for (const [name, abbr] of Object.entries(STATE_NAME)) if (t.includes(name)) state = abbr;

  // pay (e.g., $200, 200/hr, 200 an hour, 3200/day)
  let minRate = null;
  const mPay = t.match(/\$?\s*(\d{2,4})\s*(?:\/?\s*(hr|hour|an hour|per hour|day|\/day))?/i);
  if (mPay) minRate = Number(mPay[1]);

  // unit (hour or day)
  let unit = null;
  if (/day|\/day/i.test(t)) unit = "day";
  if (/hr|hour/i.test(t)) unit = "hour";

  return { profession, specialty, state, minRate, unit };
}

function rateMeets(job, minRate, unit) {
  if (!minRate) return true;
  if (!unit) return job.rate_numeric >= minRate;
  if (unit === job.rate_unit) return job.rate_numeric >= minRate;
  return job.rate_numeric >= minRate; // naive fallback
}

function searchJobs({ profession, specialty, state, minRate, unit }) {
  // 1) exact filters
  let matches = JOBS.filter(j =>
    (!profession || j.profession === profession) &&
    (!specialty  || j.specialty  === specialty ) &&
    (!state      || j.state      === state     ) &&
    rateMeets(j, minRate, unit)
  );

  // rank: High priority first, then higher pay
  matches.sort((a, b) => (b.priority === "High") - (a.priority === "High") || (b.rate_numeric - a.rate_numeric));
  if (matches.length) return { matches, fallbackNote: null };

  // 2) same state, within ~15% of target pay
  if (minRate) {
    const slack = Math.round(minRate * 0.85);
    const near = JOBS.filter(j =>
      (!profession || j.profession === profession) &&
      (!specialty  || j.specialty  === specialty ) &&
      (!state      || j.state      === state     ) &&
      j.rate_numeric >= slack
    ).sort((a,b) => b.rate_numeric - a.rate_numeric);
    if (near.length) {
      return {
        matches: near,
        fallbackNote: `Nothing in ${state || "that location"} at $${minRate}, but here are options ≥ ~$${slack}.`
      };
    }
  }

  // 3) same specialty anywhere at requested pay
  if (minRate) {
    const any = JOBS.filter(j =>
      (!profession || j.profession === profession) &&
      (!specialty  || j.specialty  === specialty ) &&
      j.rate_numeric >= minRate
    ).sort((a,b) => b.rate_numeric - a.rate_numeric);
    if (any.length) {
      return {
        matches: any,
        fallbackNote: `No matches in ${state || "that location"}, but here are ${specialty || profession || "similar"} roles at your target pay in other states.`
      };
    }
  }

  // 4) strongest overall
  const best = [...JOBS].sort((a,b) => b.rate_numeric - a.rate_numeric).slice(0, 6);
  return { matches: best, fallbackNote: `No exact matches. Here are strong alternatives based on pay and relevance.` };
}

// small heuristic to decide if user is asking for jobs
function looksJobQuery(text="") {
  return /\b(job|jobs|locum|crna|anesth|urgent care|radiolog|np\b|pa\b|pay|rate|$\/?hr|per hour|\/day|day rate)\b/i.test(text);
}

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";

// ---------- CHAT API ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message = "", session_id = "anon" } = req.body;
    sseHeaders(res);

    const history = getHistory(session_id);
    pushMsg(session_id, { role: "user", content: message });

    // 1) Job logic first (deterministic, from your data)
    const intent = parseAsk(message);
    const { matches, fallbackNote } = searchJobs(intent);

    let lead = "";
    if (intent.profession || intent.specialty || intent.state || intent.minRate) {
      lead =
        `I looked for ${intent.specialty || intent.profession || "roles"}` +
        (intent.state ? ` in ${intent.state}` : "") +
        (intent.minRate ? ` at $${intent.minRate}/${intent.unit || "hr"}` : "") +
        ". ";
    }
    if (fallbackNote) lead += fallbackNote;
    if (lead) sseSend(res, { type: "text", data: lead + "\n\n" });

    // stream job cards back
    if (matches.length) {
      const items = matches.slice(0, 6).map(j => ({
        rate: j.rate || (j.rate_unit === "day" ? `$${j.rate_numeric}/day` : `$${j.rate_numeric}/hr`),
        title: j.title,
        city: j.city,
        state: j.state,
        job_id: j.job_id,
        priority: j.priority,
        metaLine: j.metaLine,
        url: j.url
      }));
      sseSend(res, { type: "blocks", data: [{ type: "jobs", items }] });
    }

    // 2) If it wasn’t a job query, use OpenAI for general guidance
    if (!looksJobQuery(message)) {
      const SYSTEM_PROMPT = `
You are a helpful, candid assistant for clinicians looking for jobs and guidance.
Keep answers concise and conversational. Never reveal facility names.
When discussing positions, show rate first, then title, then "City, ST", JO-ID, Priority.
      `.trim();

      const msgs = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }];

      const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        temperature: 0.4,
        max_tokens: 220,
        messages: msgs
      });

      sseSend(res, { type: "text", data: "" }); // prime client
      let assistantText = "";
      for await (const part of stream) {
        const delta = part?.choices?.[0]?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          sseSend(res, { type: "text", data: delta.content });
        }
      }
      if (assistantText) pushMsg(session_id, { role: "assistant", content: assistantText });
    }

    res.end();
  } catch (e) {
    console.error("Chat error:", e);
    sseSend(res, { type: "text", data: "\n(Sorry, something went wrong.)" });
    res.end();
  }
});

// health check & warm
app.get("/", (_req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => console.log("Server running"));

