// backend/server.js — OpenRouter primary for DeepSeek; direct OpenAI for GPT models (stable)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
require("dotenv").config();
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "history.json");
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || ""; // direct OpenAI key (optional)

if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}");

// MODEL MAP
const MODEL_MAP = {
  "deepseek_r1_0528_qwen3_8b": { openrouter: "deepseek/deepseek-r1-0528-qwen3-8b:free", openai: null, note:"Qwen3 8B (unstable)" },
  "deepseek_r1_0528":          { openrouter: "deepseek/deepseek-r1-0528:free", openai: null, note:"Balanced general" },
  "deepseek_v3_0324":          { openrouter: "deepseek/deepseek-v3-0324:free", openai: null, note:"Fast + concise" },
  "deepseek_r1_distill_70b":   { openrouter: "deepseek/deepseek-r1-distill-llama-70b:free", openai: null, note:"Large detailed" },
  "deepseek_r1":               { openrouter: "deepseek/deepseek-r1:free", openai: null, note:"Stable general" },

  // Grok (default you wanted)
  "grok_4_1_fast":             { openrouter: "x-ai/grok-4.1-fast:free", openai: null, note:"Grok 4.1 Fast (xAI) via OpenRouter" },

  // OpenAI options (optional; will require OPENAI_KEY to work)
  "gpt4o_mini":                { openrouter: "openai/gpt-4o-mini", openai: "gpt-4o-mini", note:"OpenAI gpt-4o-mini" },
  "gpt4o_latest":              { openrouter: "openai/gpt-4o", openai: "gpt-4o", note:"OpenAI gpt-4o (powerful)" }
};

// DB helpers (single definitions)
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); }
  catch (e) { return {}; }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// Serve static frontend if exists
const PUBLIC_DIR = path.join(__dirname, "..", "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}
app.get("/", (req, res) => {
  const idx = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  return res.status(404).send("Frontend not found. Put index.html inside public/");
});

// sanitize reply: remove long non-ascii runs (mitigates Qwen-8B Urdu/Arabic bug)
function sanitizeReply(text) {
  if (!text || typeof text !== "string") return text || "";
  let cleaned = text.replace(/[^\x00-\x7F]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

// OpenRouter call with retry on 429
async function callOpenRouterWithRetry(modelId, messages, opts = {}) {
  if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY_MISSING");
  const maxTries = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxTries) {
    attempt++;
    try {
      const body = {
        model: modelId,
        messages,
        max_tokens: opts.max_tokens || 1500,
        temperature: typeof opts.temperature !== "undefined" ? opts.temperature : 0.7
      };
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await resp.json();
      if (resp.ok) return { ok: true, json: j };
      if (resp.status === 429) {
        lastErr = { status: resp.status, json: j };
        const backoff = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return { ok: false, status: resp.status, json: j };
    } catch (err) {
      lastErr = err;
      const backoff = 500 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  return { ok: false, status: 429, json: { error: "rate_limited", raw: lastErr } };
}

// Direct OpenAI call (used for GPT models when OPENAI_KEY is provided)
async function callOpenAIDirect(modelId, messages, opts = {}) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  const body = {
    model: modelId,
    messages,
    max_tokens: opts.max_tokens || 1500,
    temperature: typeof opts.temperature !== "undefined" ? opts.temperature : 0.7
  };
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await resp.json();
  return { ok: resp.ok, status: resp.status, json: j };
}

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    // default model is grok_4_1_fast (you requested Grok as default)
    const modelKey = req.body.model || "grok_4_1_fast";
    const mapping = MODEL_MAP[modelKey];

    if (!message) return res.status(400).json({ error: "message required" });
    if (!mapping) return res.status(400).json({ error: "invalid model", detail: modelKey });

    // Save user message
    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role: "user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // system persona
    const system = `You are Indresh 2.0, created by Indresh Dangi. Speak politely using "aap". If asked "tum kaun ho" reply exactly "Main Indresh 2.0 hoon. Mujhe Indresh Dangi ne banaya hai."`;
    const messages = [{ role: "system", content: system }, { role: "user", content: message }];

    // If model has direct OpenAI mapping, use direct OpenAI (requires OPENAI_KEY)
    if (mapping.openai) {
      if (!OPENAI_KEY) {
        const errMsg = "Selected model requires a direct OpenAI key. Set OPENAI_API_KEY in backend/.env or choose another model.";
        db[convId].push({ role: "assistant", content: errMsg, created_at: new Date().toISOString(), meta: { error: true } });
        saveDB(db);
        return res.status(400).json({ error: "openai_key_missing", message: errMsg });
      }

      try {
        const openaiResp = await callOpenAIDirect(mapping.openai, messages, { max_tokens: 2000, temperature: 0.7 });
        if (!openaiResp.ok) {
          console.warn("OpenAI direct failed:", openaiResp.status, openaiResp.json);
          const detail = openaiResp.json?.error?.message || JSON.stringify(openaiResp.json);
          return res.status(502).json({ error: "openai_direct_failed", detail });
        }
        let reply = openaiResp.json?.choices?.[0]?.message?.content || openaiResp.json?.choices?.[0]?.text || "";
        reply = reply.replace(/OpenAI|ChatGPT/gi, "Indresh 2.0");
        reply = sanitizeReply(reply);

        db[convId].push({ role: "assistant", content: reply, created_at: new Date().toISOString() });
        saveDB(db);
        return res.json({ output: { role: "assistant", content: reply, via: "openai_direct" } });
      } catch (e) {
        console.error("OpenAI direct exception:", e);
        const errMsg = "Direct OpenAI request failed (exception).";
        db[convId].push({ role: "assistant", content: errMsg, created_at: new Date().toISOString(), meta: { error: true } });
        saveDB(db);
        return res.status(500).json({ error: "openai_exception", detail: String(e) });
      }
    }

    // Default: use OpenRouter for non-OpenAI models (DeepSeek, Grok via OpenRouter)
    if (!OPENROUTER_KEY) {
      const errMsg = "OpenRouter API key not set. Set OPENROUTER_API_KEY in backend/.env to use these models.";
      db[convId].push({ role: "assistant", content: errMsg, created_at: new Date().toISOString(), meta: { error: true } });
      saveDB(db);
      return res.status(400).json({ error: "openrouter_key_missing", message: errMsg });
    }

    // Attempt OpenRouter (with retry)
    const orModelId = mapping.openrouter;
    if (!orModelId) {
      const errMsg = "Selected model not available via OpenRouter.";
      db[convId].push({ role: "assistant", content: errMsg, created_at: new Date().toISOString(), meta: { error: true } });
      saveDB(db);
      return res.status(400).json({ error: "model_not_on_openrouter", message: errMsg });
    }

    const call = await callOpenRouterWithRetry(orModelId, messages, { max_tokens: 1800, temperature: 0.7 });
    let replyText = null;

    if (call.ok) {
      const j = call.json;
      replyText = j?.choices?.[0]?.message?.content || j?.output?.content || (typeof j === "string" ? j : JSON.stringify(j));
    } else {
      console.warn("OpenRouter call failed:", call.status, call.json?.error || call.json);

      // fallback: if user provided direct OPENAI_KEY and mapping.openai exists -> try OpenAI direct
      if (OPENAI_KEY && mapping.openai) {
        try {
          const openaiCall = await callOpenAIDirect(mapping.openai, messages, { max_tokens: 2000 });
          if (openaiCall.ok) {
            replyText = openaiCall.json?.choices?.[0]?.message?.content || openaiCall.json?.choices?.[0]?.text || JSON.stringify(openaiCall.json);
          } else {
            console.warn("OpenAI direct failed during fallback:", openaiCall.status, openaiCall.json);
          }
        } catch (e) {
          console.warn("OpenAI fallback exception:", e);
        }
      }

      // Another fallback: try more stable deepseek_r1 via OpenRouter
      if (!replyText && MODEL_MAP["deepseek_r1"]) {
        try {
          const fallbackCall = await callOpenRouterWithRetry(MODEL_MAP["deepseek_r1"].openrouter, messages, { max_tokens: 1200 });
          if (fallbackCall.ok) {
            replyText = fallbackCall.json?.choices?.[0]?.message?.content || fallbackCall.json?.output?.content || JSON.stringify(fallbackCall.json);
          } else {
            console.warn("Fallback OpenRouter model also failed:", fallbackCall.status, fallbackCall.json);
          }
        } catch (e) {
          console.warn("Fallback attempt error:", e);
        }
      }
    }

    if (!replyText) {
      const errMsg = "Provider temporarily unavailable (rate-limited). Try another model or set direct OpenAI key for fallback.";
      db[convId].push({ role: "assistant", content: errMsg, created_at: new Date().toISOString(), meta: { fallback: true } });
      saveDB(db);
      return res.status(502).json({ error: "provider_unavailable", message: errMsg, hint: "try different model or add OPENAI_API_KEY to .env" });
    }

    // sanitize & enforce identity
    replyText = (replyText || "").replace(/OpenAI|ChatGPT/gi, "Indresh 2.0");
    replyText = sanitizeReply(replyText);

    db[convId].push({ role: "assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role: "assistant", content: replyText, via: "openrouter" } });

  } catch (err) {
    console.error("Server /api/chat error:", err);

    return res.status(500).json({
      error: "server_error",
      details: err && err.message ? err.message : String(err)
    });
  }

}); // end POST /api/chat

// history & clear
app.get("/api/history/:id", (req, res) => {
  const db = loadDB();
  res.json({ messages: db[req.params.id] || [] });
});
app.post("/api/clear/:id", (req, res) => {
  const db = loadDB();
  db[req.params.id] = [];
  saveDB(db);
  res.json({ ok: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!OPENROUTER_KEY) console.log("WARNING: OPENROUTER_API_KEY not set — OpenRouter unavailable.");
  if (!OPENAI_KEY) console.log("NOTE: OPENAI_API_KEY not set — OpenAI direct models unavailable.");
});
