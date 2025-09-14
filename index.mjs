import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// ---- simple in-memory conversation history (per session) ----
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// demo job search (replace later with your real data)
async function searchJobsSvc() {
  return [
    {rate:"$205/hour", title:"CRNA – General Cases", city:"Tampa", state:"FL", job_id:"JO-00472", priority:"High", metaLine:"On-site • Locum • Mon–Fri"},
    {rate:"$3200/day", title:"Anesthesiology MD", city:"Harrisburg", state:"PA", job_id:"JO-00466", priority:"High", metaLine:"On-site • Locum"}
  ];
}

// SSE helpers
function sseHeaders(res){
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache, no-transform");
  res.setHeader("Connection","keep-alive");
}
function sseSend(res,obj){res.write(`data: ${JSON.stringify(obj)}\n\n`);}

// MAIN CHAT ENDPOINT (streams like ChatGPT + remembers context)
app.post("/api/chat", async (req, res) => {
  try {
    const { message = "", session_id = "anon" } = req.body;
    sseHeaders(res);

    const SYSTEM_PROMPT = `
You are a helpful, candid assistant for clinicians looking for jobs and guidance.
- Keep answers concise and conversational.
- If user asks about jobs, suggest realistic options and trade-offs.
- Never reveal facility names; show rate first, then title, then "City, ST", JO-ID, Priority.
    `.trim();

    const history = getHistory(session_id);
    const msgs = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }];

    pushMsg(session_id, { role: "user", content: message });

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",   // ✅ widely available model
      stream: true,
      temperature: 0.4,
      messages: msgs
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

    // quick demo: show sample job cards if the message smells like "jobs"
    if (/\b(crna|anesth|urology|radiology|urgent care|job|jobs|locum)\b/i.test(message)) {
      const items = await searchJobsSvc();
      sseSend(res, { type: "blocks", data: [{ type: "jobs", items }] });
    }

    res.end();
  } catch (e) {
    console.error("Chat error:", e.message);
    sseSend(res, { type: "text", data: "\n(Sorry, something went wrong.)" });
    res.end();
  }
});

// health check
app.get("/", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
