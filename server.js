// server.js (ESM, Node 18+)
// -------------------------------------------------------------
import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { isValid as isValidIban } from "iban";
import OpenAI from "openai";
import Stripe from "stripe";
import path from "node:path";

const fetch2 = globalThis.fetch;

// -------------------------------------------------------------
const app = express();
app.use(bodyParser.json({ limit: "15mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "15mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const BASE_URL =
  process.env.BASE_URL || "http://localhost:" + (process.env.PORT || 10000);

// Airtable (opzionale)
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_JOBS = process.env.AIRTABLE_TABLE_JOBS || "Jobs";

// -------------------------------------------------------------
// Utility
function buildPayLink({ amount, ente, iban, descr, scadenza }) {
  const url = new URL("/pay-card", BASE_URL);
  if (amount) url.searchParams.set("amount", String(amount).replace(",", "."));
  if (ente) url.searchParams.set("ente", ente);
  if (iban) url.searchParams.set("iban", iban);
  if (descr) url.searchParams.set("descr", descr);
  if (scadenza) url.searchParams.set("scadenza", scadenza);
  return url.toString();
}

function extractByRegex(text) {
  const clean = text.replace(/\s+/g, " ").trim();

  // IBAN
  const ibanMatch = clean.match(/[A-Z]{2}\d{2}[A-Z0-9]{1,30}/i);
  const iban = ibanMatch ? ibanMatch[0].toUpperCase() : undefined;
  const ibanValid = iban && isValidIban(iban) ? iban : undefined;

  // Importo (euro)
  const amtMatch = clean.match(
    /(?<!\d)(\d{1,3}(?:[.,]\d{3})*|\d+)([.,]\d{2})(?!\d)/
  );
  let amount;
  if (amtMatch) {
    const raw = amtMatch[0].replace(/\./g, "").replace(",", ".");
    amount = parseFloat(raw);
  }

  // Scadenza YYYY-MM-DD o DD/MM/YYYY
  let scadenza;
  const iso = clean.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  const ita = clean.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
  if (iso) scadenza = iso[0];
  else if (ita) {
    const [, d, m, y] = ita;
    scadenza = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(
      2,
      "0"
    )}`;
  }

  // Ente (heuristica)
  let ente;
  const candidates = text
    .split(/\n|\r/g)
    .map((s) => s.trim())
    .filter(Boolean);
  ente = candidates.find((s) =>
    /enel|hera|iren|a2a|abbanoa|acea|acqua|gas|luce|fattura|bolletta/i.test(s)
  );
  if (!ente) {
    ente = candidates.slice(0, 10).find((s) => s.length > 3 && s.length < 50);
  }
  if (ente) ente = ente.replace(/^(fattura|bolletta)[:\s-]*/i, "").trim();

  return { amount, iban: ibanValid, scadenza, ente };
}

function ocrSystemPrompt() {
  return `You are a meticulous OCR & data extraction engine for Italian utility bills.
Return ONLY valid JSON with keys: ente, iban, amount, scadenza, descr.
- amount: number in euros with dot decimal (e.g., 49.90). If multiple, pick the bill TOTAL to pay.
- scadenza: due date in YYYY-MM-DD if present, else null.
- iban: payee IBAN if present and valid, else null.
- ente: merchant/utility/provider name (short).
- descr: short description like "Bolletta Agosto" if guessable (else null).`;
}

async function visionExtractFromImageBuffer(buf, mime = "image/png") {
  const b64 = buf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ocrSystemPrompt() },
      {
        role: "user",
        content: [
          { type: "text", text: "Estrarre i campi in JSON." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
  });
  return JSON.parse(resp.choices[0].message.content || "{}");
}

async function llmExtractFromText(text) {
  const fallback = extractByRegex(text);
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ocrSystemPrompt() },
      { role: "user", content: `Testo OCR:\n${text}\n\nEstrai JSON come richiesto.` },
    ],
    temperature: 0,
  });
  const ai = JSON.parse(resp.choices[0].message.content || "{}");
  return {
    ente: ai.ente || fallback.ente || null,
    iban: ai.iban && isValidIban(ai.iban) ? ai.iban : fallback.iban || null,
    amount:
      typeof ai.amount === "number" && !isNaN(ai.amount)
        ? ai.amount
        : fallback.amount || null,
    scadenza: ai.scadenza || fallback.scadenza || null,
    descr: ai.descr || null,
  };
}

async function fetchRemoteFile(url) {
  const r = await fetch2(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  return { buf, contentType };
}

// -------------------------------------------------------------
// Health check
app.get("/", (_req, res) => res.send("Elessar runner ok"));

// -------------------------------------------------------------
// Stripe
app.get("/pay-card", async (req, res) => {
  try {
    if (!stripe) return res.status(500).send("Stripe non configurato");
    const { amount, ente, iban, descr, scadenza } = req.query;

    if (!amount) return res.status(400).send("Parametro 'amount' mancante");
    const amt = parseFloat(String(amount).replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).send("Importo non valido");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            unit_amount: Math.round(amt * 100),
            product_data: {
              name: ente ? `Pagamento ${ente}` : "Pagamento",
              description:
                descr ||
                (scadenza ? `Bolletta ${scadenza}` : "Pagamento con carta"),
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        ente: ente || "",
        iban: iban || "",
        descr: descr || "",
        scadenza: scadenza || "",
      },
      success_url: `${BASE_URL}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).send("Errore pagamento");
  }
});

app.get("/stripe/success", async (req, res) => {
  try {
    if (!stripe) return res.status(500).send("Stripe non configurato");
    const { session_id } = req.query;
    if (!session_id) return res.status(400).send("session_id mancante");

    const session = await stripe.checkout.sessions.retrieve(String(session_id));
    const amount = (session.amount_total || 0) / 100;
    const m = session.metadata || {};
    const html = `
      <html><body style="font-family: sans-serif">
        <h2>Pagamento completato ✅</h2>
        <p><b>Importo:</b> € ${amount.toFixed(2)}</p>
        <p><b>Ente:</b> ${m.ente || "-"}</p>
        <p><b>IBAN:</b> ${m.iban || "-"}</p>
        <p><b>Descrizione:</b> ${m.descr || "-"}</p>
        <p><b>Scadenza:</b> ${m.scadenza || "-"}</p>
        <p><a href="${BASE_URL}">Torna alla home</a></p>
      </body></html>`;
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err) {
    console.error("Stripe success error:", err);
    return res.status(500).send("Errore nel recupero della sessione");
  }
});

// -------------------------------------------------------------
// OCR: upload file
app.post("/ocr/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file inviato" });
    const buf = req.file.buffer;
    const mime = req.file.mimetype || "application/octet-stream";
    const filename = req.file.originalname || "upload";

    let extracted;
    if (mime.includes("pdf") || path.extname(filename).toLowerCase() === ".pdf") {
      const parsed = await pdfParse(buf);
      const text = parsed.text || "";
      extracted = await llmExtractFromText(text);
    } else if (mime.startsWith("image/")) {
      extracted = await visionExtractFromImageBuffer(buf, mime);
    } else {
      return res.status(415).json({ error: `Tipo file non supportato: ${mime}` });
    }

    if (extracted.iban && !isValidIban(extracted.iban)) extracted.iban = null;
    if (!extracted.descr)
      extracted.descr = extracted.scadenza
        ? `Bolletta ${extracted.scadenza}`
        : "Bolletta";

    const payLink = buildPayLink({
      amount: extracted.amount,
      ente: extracted.ente,
      iban: extracted.iban,
      descr: extracted.descr,
      scadenza: extracted.scadenza,
    });

    return res.json({ ok: true, data: extracted, pay_link: payLink });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(500).json({ error: "OCR failure", details: err.message });
  }
});

// OCR: da URL
app.get("/ocr/analyze-by-url", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Parametro 'url' mancante" });

    const { buf, contentType } = await fetchRemoteFile(String(url));
    let extracted;

    if (contentType.includes("pdf") || String(url).toLowerCase().endsWith(".pdf")) {
      const parsed = await pdfParse(buf);
      const text = parsed.text || "";
      extracted = await llmExtractFromText(text);
    } else if (contentType.startsWith("image/")) {
      extracted = await visionExtractFromImageBuffer(buf, contentType);
    } else {
      return res
        .status(415)
        .json({ error: `Tipo file non supportato: ${contentType}` });
    }

    if (extracted.iban && !isValidIban(extracted.iban)) extracted.iban = null;
    if (!extracted.descr)
      extracted.descr = extracted.scadenza
        ? `Bolletta ${extracted.scadenza}`
        : "Bolletta";

    const payLink = buildPayLink({
      amount: extracted.amount,
      ente: extracted.ente,
      iban: extracted.iban,
      descr: extracted.descr,
      scadenza: extracted.scadenza,
    });

    return res.json({ ok: true, data: extracted, pay_link: payLink });
  } catch (err) {
    console.error("OCR URL error:", err);
    return res.status(500).json({ error: "OCR failure", details: err.message });
  }
});

// -------------------------------------------------------------
// WhatsApp (Twilio) webhook
function replyTwilio(res, message) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${String(message).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Message></Response>`;
  res.set("Content-Type", "application/xml");
  return res.send(twiml);
}

app.post("/whatsapp/webhook", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const body = req.body.Body || "";
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const out = await (await fetch2(
        `${BASE_URL}/ocr/analyze-by-url?url=${encodeURIComponent(mediaUrl)}`
      )).json();

      if (out.ok) {
        const d = out.data || {};
        const msg =
          `Ho letto il documento:\n` +
          `• Ente: ${d.ente || "-" }\n` +
          `• IBAN: ${d.iban || "-" }\n` +
          `• Importo: ${d.amount != null ? `€ ${Number(d.amount).toFixed(2)}` : "-" }\n` +
          `• Scadenza: ${d.scadenza || "-" }\n\n` +
          `Paga qui: ${out.pay_link}`;
        return replyTwilio(res, msg);
      } else {
        return replyTwilio(res, "Non riesco a leggere il file. Riprova con una foto più chiara o un PDF.");
      }
    }

    const txt = body.trim().toLowerCase();
    if (txt.includes("ciao")) return replyTwilio(res, "Ciao! Inviami la foto o il PDF della bolletta per creare il link di pagamento.");
    if (txt.includes("bolletta"))
      return replyTwilio(
        res,
        "Perfetto: mandami la foto/PDF della bolletta. Ti risponderò con il link di pagamento precompilato."
      );
    if (txt.includes("medico"))
      return replyTwilio(
        res,
        "Dimmi giorno e fascia oraria preferita, ti propongo gli slot disponibili."
      );

    return replyTwilio(res, "Posso leggere bollette/fatture da foto o PDF e creare il link di pagamento. Invia il file!");
  } catch (err) {
    console.error("Twilio webhook err:", err);
    return replyTwilio(res, "Errore temporaneo. Riprova tra poco.");
  }
});

// -------------------------------------------------------------
// Airtable test
app.get("/test-airtable", async (_req, res) => {
  try {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return res.json({ ok: false, info: "Airtable non configurato" });
    }
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE_JOBS
    )}`;
    const now = new Date().toISOString();
    const payload = {
      records: [
        {
          fields: {
            Name: `Test Job ${now}`,
            Status: "Created",
            Source: "Runner",
            Timestamp: now,
          },
        },
      ],
    };
    const r = await fetch2(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: data });
    }
    return res.json({ ok: true, created: data });
  } catch (err) {
    console.error("Airtable err:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Avvio server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Runner up on ${PORT}`));
