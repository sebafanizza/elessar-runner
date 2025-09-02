// server.js — Elessar MVP DEMO + OCR (immagini+PDF) + sessioni persistenti su Airtable
// Requisiti: Node 20+, package.json { "type": "module" }

import express from 'express';
import Stripe from 'stripe';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';
import { isValid as isValidIban } from 'iban';

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 8080;

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_MODE = process.env.APP_MODE || 'demo';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_TOKEN = process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY || '';

const AT_TABLE_JOBS = process.env.AT_TABLE_JOBS || 'Jobs';
const AT_TABLE_RECEIPTS = process.env.AT_TABLE_RECEIPTS || 'Receipts';
const AT_TABLE_SESSIONS = process.env.AT_TABLE_SESSIONS || 'Sessions';

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Guard-rail DEMO
if (APP_MODE === 'demo' && STRIPE_KEY.startsWith('sk_live_')) {
  console.error('ERROR: APP_MODE=demo ma chiave LIVE. Metti sk_test_...');
  process.exit(1);
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Utils ----------
function escapeXml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function replyTwilio(res, messageText) {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>${escapeXml(messageText)}</Message></Response>`;
  res.type('text/xml').send(body);
}
function parseAmount(input) {
  if (!input) return undefined;
  const m = String(input).replace(/[^\d.,]/g,'').replace(/\./g,'').replace(',', '.');
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : undefined;
}
function normalizeIban(s) {
  if (!s) return undefined;
  return s.replace(/\s+/g, '').toUpperCase();
}
function parseDateISO(s) {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // YYYY-MM-DD
  const m = s.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return undefined;
}
function buildPayLink({ amount, ente, iban, descr, scadenza }) {
  const u = new URL('/pay-card', APP_URL);
  if (amount) u.searchParams.set('amount', String(amount).replace(',', '.'));
  if (ente) u.searchParams.set('ente', ente);
  if (iban) u.searchParams.set('iban', iban);
  if (descr) u.searchParams.set('descr', descr);
  if (scadenza) u.searchParams.set('scadenza', scadenza);
  return u.toString();
}

// ---------- Airtable helpers ----------
async function atCreate(table, fields = {}) {
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) { console.error('Airtable env mancanti'); return null; }
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }] })
  });
  const text = await r.text();
  if (!r.ok) { console.error('Airtable error:', r.status, text); return null; }
  try { const j = JSON.parse(text); return j.records?.[0]?.id || null; }
  catch(e){ console.error('Airtable parse error:', e.message, text); return null; }
}
async function atUpdate(table, id, fields = {}) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method:'PATCH',
    headers:{ Authorization:`Bearer ${AIRTABLE_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ records: [{ id, fields }] })
  });
  return r.ok;
}
async function atDelete(table, id) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}/${id}`;
  const r = await fetch(url, { method:'DELETE', headers:{ Authorization:`Bearer ${AIRTABLE_TOKEN}` }});
  return r.ok;
}
function q(param){ return encodeURIComponent(param); }
function formulaEq(field, value) {
  const v = String(value).replace(/"/g,'\\"');
  return `({${field}}="${v}")`;
}
async function atFindOneByField(table, field, value) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}?maxRecords=1&filterByFormula=${q(formulaEq(field,value))}`;
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${AIRTABLE_TOKEN}` }});
  const j = await r.json();
  const rec = j.records?.[0];
  return rec ? { id: rec.id, fields: rec.fields||{} } : null;
}

// ---------- Sessions (persistenti) ----------
async function getSession(from) {
  const rec = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  if (!rec) return null;
  const step = Number(rec.fields.Step ?? 0);
  const dataRaw = rec.fields.Data || '{}';
  const ts = Number(rec.fields.TS ?? 0);
  let data = {};
  try { data = JSON.parse(dataRaw); } catch {}
  // timeout 30 minuti
  if (!ts || (Date.now() - ts > 30*60*1000)) return null;
  return { id: rec.id, step, data, ts };
}
async function setSession(from, { step, data }) {
  const now = Date.now();
  const existing = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  const fields = { From: from, Step: step, Data: JSON.stringify(data||{}), TS: now };
  if (existing) { await atUpdate(AT_TABLE_SESSIONS, existing.id, fields); return existing.id; }
  else { return await atCreate(AT_TABLE_SESSIONS, fields); }
}
async function deleteSession(from) {
  const existing = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  if (existing) await atDelete(AT_TABLE_SESSIONS, existing.id);
}

// ---------- OCR helpers ----------
const VISION_SYS = `Sei un assistente che estrae dati da bollette italiane.
Rispondi SOLO in JSON { "ente": string|null, "iban": string|null, "amount": number|null, "scadenza": "YYYY-MM-DD"|null, "descr": string|null }.
"amount" = TOTALE DA PAGARE in euro (punto come separatore).`;

async function analyzeImageBase64(b64, mime) {
  if (!openai) return {};
  const userContent = [
    { type: 'text', text: 'Estrai i campi richiesti dalla bolletta.' },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
  ];
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [{ role: 'system', content: VISION_SYS }, { role: 'user', content: userContent }]
  });
  const raw = r.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

function extractHeuristics(text) {
  const out = {};
  const ibanMatch = text.match(/IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}/i);
  if (ibanMatch) out.iban = ibanMatch[0].replace(/\s+/g,'').toUpperCase();
  const amountLine = (text.match(/(?:totale|da\s*pagare|importo).*?([€]?\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/i) || [])[1]
                  || (text.match(/([€]?\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)[^\S\r\n]*(?:€)?/i) || [])[1];
  if (amountLine) {
    const num = amountLine.replace(/[^\d.,]/g,'').replace(/\./g,'').replace(',', '.');
    out.amount = parseFloat(num);
  }
  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{2}[\/.-]\d{2}[\/.-]\d{4})\b/);
  if (dateMatch) {
    let d = dateMatch[1];
    if (/^\d{2}[\/.-]\d{2}[\/.-]\d{4}$/.test(d)) {
      const [dd, mm, yyyy] = d.replace(/[.-]/g,'/').split('/');
      d = `${yyyy}-${mm}-${dd}`;
    }
    out.scadenza = d;
  }
  const top = text.split('\n').slice(0,12).join(' ');
  const ente = (top.match(/\b(?:Enel|Acea|Iren|Hera|A2A|Acqua|TIM|Vodafone|WindTre|E\.?ON|Illumia|AGSM|Sorgenia|Italgas|Gori)[^\n]{0,30}/i) || [])[0];
  if (ente) out.ente = ente.trim();
  return out;
}

async function analyzePdfBuffer(buf) {
  const pdf = await pdfParse(buf).catch(() => ({ text:'' }));
  const text = pdf.text || '';
  const heur = extractHeuristics(text);
  // Mini LLM su testo
  let llm = {};
  if (openai) {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: VISION_SYS },
        { role: 'user', content: `Testo OCR/estratto bolletta:\n\n${text.slice(0,7000)}\n\nEstrai JSON.` }
      ]
    });
    const raw = r.choices?.[0]?.message?.content || '{}';
    try { llm = JSON.parse(raw); } catch { llm = {}; }
  }
  return { ...heur, ...llm };
}

async function fetchMediaToBuffer(url) {
  if (!TWILIO_SID || !TWILIO_TOKEN) throw new Error('Twilio SID/TOKEN mancanti');
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Health ----------
app.get('/', (_req, res) => res.status(200).send('Elessar runner ok'));

// ---------- WhatsApp webhook ----------
const STEPS = ['ente','importo','iban','scadenza'];

app.post('/whatsapp/webhook', async (req, res) => {
  try {
    const from = req.body.From || 'unknown';
    const body = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    // RESET
    if (/^annulla$/i.test(body)) {
      await deleteSession(from);
      return replyTwilio(res, 'Flusso annullato. Scrivi *bolletta* per ricominciare.');
    }

    // MEDIA FIRST: se arriva un file (foto/pdf), facciamo OCR diretto
    if (numMedia > 0) {
      try {
        const url = req.body.MediaUrl0;
        const ctype = req.body.MediaContentType0 || '';
        const buf = await fetchMediaToBuffer(url);

        let data = {};
        if (ctype.startsWith('image/')) {
          const b64 = buf.toString('base64');
          data = await analyzeImageBase64(b64, ctype);
        } else if (ctype === 'application/pdf') {
          data = await analyzePdfBuffer(buf);
        } else {
          return replyTwilio(res, 'Formato non supportato. Invia *foto* o *PDF* della bolletta.');
        }

        let { amount, iban, scadenza, ente, descr } = data || {};
        if (typeof amount === 'string') amount = parseAmount(amount);
        if (iban && !isValidIban(iban)) iban = undefined;
        if (!descr) descr = 'Bolletta';

        const link = buildPayLink({ amount, ente: ente || 'Ente', iban, descr, scadenza });

        // Log DEMO su Receipts
        await atCreate(AT_TABLE_RECEIPTS, {
          Ente: ente || null,
          Importo: amount || null,
          IBAN: iban || null,
          Scadenza: scadenza || null,
          Status: 'demo',
          PISP_ID: `demo_${Date.now()}`
        });

        const reply =
`🧪 DEMO • Nessun addebito
Ecco cosa ho trovato:
• Ente: ${ente || '—'}
• IBAN: ${iban || '—'}
• Importo: ${amount ? amount.toFixed(2)+' €' : '—'}
• Scadenza: ${scadenza || '—'}

👉 Link di prova:
${link}

Se qualcosa non è corretto, rispondi con il valore giusto (es. "importo 49.90", "iban IT...").`;
        return replyTwilio(res, reply);
      } catch (e) {
        console.error('OCR error:', e.message);
        return replyTwilio(res, 'Non riesco a leggere il file. Invia una foto più nitida o un PDF in buona qualità.');
      }
    }

    // START by keyword
    if (/^bolletta\b/i.test(body)) {
      await setSession(from, { step: 0, data: {} });
      return replyTwilio(
        res,
        '🧪 DEMO • Nessun addebito\n' +
        'Ok, ti aiuto a preparare il pagamento.\n' +
        '1/4 • Scrivi *Ente* (es. Enel, A2A, Gori…)\n\n' +
        '_Scrivi "annulla" per ricominciare_.'
      );
    }

    // Se non keyword: riprendi (o avvia se mancante)
    let s = await getSession(from);
    if (!s) { await setSession(from, { step: 0, data: {} }); s = await getSession(from); }

    const step = STEPS[s.step];

    if (step === 'ente') {
      s.data.ente = body;
      s.step++; await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '2/4 • Importo (es. 49,90)');
    }
    if (step === 'importo') {
      const amt = parseAmount(body);
      if (!amt) return replyTwilio(res, 'Formato importo non valido. Esempio: 49,90');
      s.data.amount = amt;
      s.step++; await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '3/4 • IBAN del fornitore (es. IT60 X054 2811 1010 0000 123456)');
    }
    if (step === 'iban') {
      const iban = normalizeIban(body);
      if (!iban || !isValidIban(iban))
        return replyTwilio(res, 'IBAN non valido. Invia un IBAN completo (es. IT60X0542811101000000123456).');
      s.data.iban = iban;
      s.step++; await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '4/4 • Scadenza (YYYY-MM-DD oppure DD/MM/YYYY). Se non c’è, scrivi "nessuna".');
    }
    if (step === 'scadenza') {
      let d; if (!/^nessuna$/i.test(body)) d = parseDateISO(body);
      if (!d && !/^nessuna$/i.test(body))
        return replyTwilio(res, 'Data non valida. Esempi: 2025-09-10 oppure 10/09/2025');

      s.data.scadenza = d;
      const { ente, amount, iban, scadenza } = s.data;
      const descr = 'Bolletta';
      const link = buildPayLink({ amount, ente, iban, descr, scadenza });

      await atCreate(AT_TABLE_RECEIPTS, {
        Ente: ente, Importo: amount, IBAN: iban, Scadenza: scadenza || null, Status: 'demo', PISP_ID: `demo_${Date.now()}`
      });
      await deleteSession(from);

      const msg =
`🧪 DEMO • Nessun addebito
Ecco il riepilogo:
• Ente: ${ente}
• Importo: € ${amount.toFixed(2)}
• IBAN: ${iban}
• Scadenza: ${scadenza || '—'}

👉 Link di prova:
${link}

Per il pagamento reale: usa il sito/app del fornitore o bonifico al loro IBAN.
Scrivi *bolletta* per inserirne un’altra.`;
      return replyTwilio(res, msg);
    }

    return replyTwilio(res, 'Non ho capito. Invia una *foto/PDF* della bolletta oppure scrivi *bolletta* per iniziare.');
  } catch (err) {
    console.error('WA webhook fatal:', err);
    return replyTwilio(res, 'Si è verificato un errore. Invia di nuovo o scrivi *bolletta* per riprovare.');
  }
});

// ---------- Stripe Checkout (TEST) ----------
app.get('/pay-card', async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe non configurato.');
    if (APP_MODE === 'demo' && STRIPE_KEY.startsWith('sk_live_')) {
      return res.status(403).send('Demo attivo: pagamenti LIVE disabilitati.');
    }
    const amount = parseAmount(req.query.amount);
    const ente = (req.query.ente || 'Ente').toString().slice(0, 60);
    const iban = normalizeIban(req.query.iban || '');
    const descr = (req.query.descr || 'Bolletta').toString().slice(0, 200);
    const scadenza = parseDateISO(req.query.scadenza || '');
    if (!amount || amount <= 0) return res.status(400).send('Importo non valido.');
    if (!iban) return res.status(400).send('IBAN richiesto.');
    const cents = Math.round(amount * 100);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${APP_URL}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/stripe/cancel`,
      currency: 'eur',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: cents,
          product_data: { name: `Pagamento ${ente}`, description: `${descr}${scadenza ? ` • Scadenza ${scadenza}` : ''}` }
        }
      }],
      metadata: { ente, iban, descr, scadenza: scadenza || '', app_mode: APP_MODE },
    });
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('pay-card error:', err);
    return res.status(500).send('Errore creazione Checkout.');
  }
});

// ---------- Success/Cancel ----------
app.get('/stripe/success', async (req, res) => {
  const sid = req.query.session_id;
  if (!sid) return res.status(400).send('Manca session_id.');
  try { await atCreate(AT_TABLE_RECEIPTS, { Status: 'demo', PISP_ID: String(sid) }); } catch(e){}
  res.status(200).send(
    `<html><body style="font-family: system-ui; padding: 24px">
      <h1>✅ Pagamento di prova completato</h1>
      <p>Transazione di TEST (DEMO). Nessun addebito reale.</p>
      <p><a href="/">Torna all'home</a></p>
    </body></html>`
  );
});
app.get('/stripe/cancel', (_req, res) => {
  res.status(200).send(
    `<html><body style="font-family: system-ui; padding: 24px">
      <h1>Pagamento annullato</h1>
      <p>Puoi riprovare in qualsiasi momento.</p>
      <p><a href="/">Torna all'home</a></p>
    </body></html>`
  );
});

// ---------- Test Airtable ----------
app.get('/test-airtable', async (_req, res) => {
  try {
    const id = await atCreate(AT_TABLE_JOBS, { Tipo: 'altro', Stato: 'nuovo', Note: `ping ${new Date().toISOString()}` });
    res.status(200).send(`OK: creato record Jobs ${id || '(no id)'}`);
  } catch (e) {
    res.status(500).send('Airtable non configurato o errore.');
  }
});
// --- IMPORT ---
import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import fetch from "node-fetch";
import pdfParse from "pdf-parse";
import { isValid as isValidIban } from "iban";
import OpenAI from "openai";
import path from "node:path";

// --- INIT ---
const app = express();
app.use(bodyParser.json({ limit: "15mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "15mb" }));

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utility: crea link pagamento già pronto
function buildPayLink({ amount, ente, iban, descr, scadenza }) {
  const base = `${process.env.BASE_URL || "https://elessar-runner-2.onrender.com"}/pay-card`;
  const params = new URLSearchParams();
  if (amount) params.set("amount", String(amount).replace(",", "."));
  if (ente) params.set("ente", ente);
  if (iban) params.set("iban", iban);
  if (descr) params.set("descr", descr);
  if (scadenza) params.set("scadenza", scadenza); // YYYY-MM-DD
  return `${base}?${params.toString()}`;
}

// Estrazione “grezza” da testo: fallback/regole rapide
function extractByRegex(text) {
  const clean = text.replace(/\s+/g, " ").trim();

  // IBAN (EU)
  const ibanMatch = clean.match(/[A-Z]{2}\d{2}[A-Z0-9]{1,30}/i);
  const iban = ibanMatch ? ibanMatch[0].toUpperCase() : undefined;
  const ibanValid = iban && isValidIban(iban) ? iban : undefined;

  // Importo: prende 1234,56 o 1.234,56 o 1234.56
  const amtMatch = clean.match(/(?<!\d)(\d{1,3}([.,]\d{3})*|\d+)([.,]\d{2})(?!\d)/);
  let amount;
  if (amtMatch) {
    const raw = amtMatch[0].replace(/\./g, "").replace(",", ".");
    amount = parseFloat(raw);
  }

  // Scadenza: YYYY-MM-DD o DD/MM/YYYY
  let scadenza;
  const iso = clean.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  const ita = clean.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
  if (iso) scadenza = iso[0];
  else if (ita) {
    const [ , d, m, y ] = ita;
    const dd = String(d).padStart(2,"0"), mm = String(m).padStart(2,"0");
    scadenza = `${y}-${mm}-${dd}`;
  }

  // Ente: heuristica (riga col “Bolletta”/”Fattura” o una riga in maiuscolo in testa)
  let ente;
  const candidates = (text.split(/\n|\r/g)).map(s => s.trim()).filter(Boolean);
  ente = candidates.find(s => /enel|hera|iren|a2a|abbanoa|acea|acqua|gas|luce|fattura|bolletta/i.test(s));
  if (!ente) {
    // prendi una riga corta in alto che sembri ragionevole
    ente = candidates.slice(0, 10).find(s => s.length > 3 && s.length < 50);
  }
  if (ente) {
    // pulizia ente
    ente = ente.replace(/^(fattura|bolletta)[:\s-]*/i,"").trim();
  }

  return { amount, iban: ibanValid, scadenza, ente };
}

// Vision prompt per estrazione strutturata
function ocrSystemPrompt() {
  return `You are a meticulous OCR & data extraction engine for Italian utility bills.
Return ONLY valid JSON with keys: ente, iban, amount, scadenza, descr.
- amount: number in euros with dot decimal (e.g., 49.90). If multiple, pick the bill TOTAL to pay.
- scadenza: due date in YYYY-MM-DD if present, else null.
- iban: payee IBAN if present and valid, else null.
- ente: merchant/utility/provider name (short).
- descr: short description like "Bolletta Agosto" if guessable (else null).`;
}

// Chiama OpenAI Vision su immagine (Buffer -> base64 data URL)
async function visionExtractFromImageBuffer(buf, mime="image/png") {
  const b64 = buf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ocrSystemPrompt() },
      { role: "user", content: [
          { type: "text", text: "Estrarre i campi in JSON." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0
  });
  const json = JSON.parse(resp.choices[0].message.content || "{}");
  return json;
}

// Chiama OpenAI su testo (da PDF) per consolidare campi + fallback regex
async function llmExtractFromText(text) {
  const fallback = extractByRegex(text);
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ocrSystemPrompt() },
      { role: "user", content: `Testo OCR:\n${text}\n\nEstrai JSON come richiesto.` }
    ],
    temperature: 0
  });
  const ai = JSON.parse(resp.choices[0].message.content || "{}");

  // merge intelligente: se LLM manca un campo, usa fallback
  return {
    ente: ai.ente || fallback.ente || null,
    iban: (ai.iban && isValidIban(ai.iban) ? ai.iban : (fallback.iban || null)) || null,
    amount: (typeof ai.amount === "number" && !isNaN(ai.amount)) ? ai.amount : (fallback.amount || null),
    scadenza: ai.scadenza || fallback.scadenza || null,
    descr: ai.descr || null
  };
}

// Scarica file remoto (es. MediaUrl0 di WhatsApp) -> Buffer + mime
async function fetchRemoteFile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  return { buf, contentType };
}

// --- ENDPOINT OCR: carica file o passa un URL ---
// POST /ocr/analyze  (multipart "file")  OPPURE  GET /ocr/analyze?url=<https://...>
app.post("/ocr/analyze", upload.single("file"), async (req, res) => {
  try {
    let buf, mime, filename;
    if (req.file) {
      buf = req.file.buffer;
      mime = req.file.mimetype || "application/octet-stream";
      filename = req.file.originalname || "upload";
    } else {
      return res.status(400).json({ error: "Nessun file. Usa form-data 'file'." });
    }

    let extracted;
    if (mime.includes("pdf") || path.extname(filename).toLowerCase() === ".pdf") {
      // PDF -> testo con pdf-parse
      const parsed = await pdfParse(buf);
      const text = parsed.text || "";
      extracted = await llmExtractFromText(text);
    } else if (mime.startsWith("image/")) {
      // Immagini -> Vision
      extracted = await visionExtractFromImageBuffer(buf, mime);
    } else {
      return res.status(415).json({ error: `Tipo file non supportato: ${mime}` });
    }

    // Validazioni leggere
    if (extracted.iban && !isValidIban(extracted.iban)) extracted.iban = null;

    // Crea descr se mancante
    if (!extracted.descr) {
      const guess = extracted.scadenza ? `Bolletta ${extracted.scadenza}` : "Bolletta";
      extracted.descr = guess;
    }

    const payLink = buildPayLink({
      amount: extracted.amount,
      ente: extracted.ente,
      iban: extracted.iban,
      descr: extracted.descr,
      scadenza: extracted.scadenza
    });

    return res.json({
      ok: true,
      data: extracted,
      pay_link: payLink
    });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(500).json({ error: "OCR failure", details: err.message });
  }
});

// Variante GET per URL remoto (es. media WhatsApp già pubblico)
// /ocr/analyze-by-url?url=https://...
app.get("/ocr/analyze-by-url", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Parametro 'url' mancante" });

    const { buf, contentType } = await fetchRemoteFile(url);
    let extracted;

    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdfParse(buf);
      const text = parsed.text || "";
      extracted = await llmExtractFromText(text);
    } else if (contentType.startsWith("image/")) {
      extracted = await visionExtractFromImageBuffer(buf, contentType);
    } else {
      return res.status(415).json({ error: `Tipo file non supportato: ${contentType}` });
    }

    if (extracted.iban && !isValidIban(extracted.iban)) extracted.iban = null;
    if (!extracted.descr) extracted.descr = extracted.scadenza ? `Bolletta ${extracted.scadenza}` : "Bolletta";

    const payLink = buildPayLink({
      amount: extracted.amount,
      ente: extracted.ente,
      iban: extracted.iban,
      descr: extracted.descr,
      scadenza: extracted.scadenza
    });

    return res.json({ ok: true, data: extracted, pay_link: payLink });
  } catch (err) {
    console.error("OCR URL error:", err);
    return res.status(500).json({ error: "OCR failure", details: err.message });
  }
});

// --- (opzionale) integrazione rapida WhatsApp: se arriva una media, OCR -> link ---
// Dentro al tuo webhook Twilio, aggiungi qualcosa così:
// if (numMedia > 0) {
//   const mediaUrl = req.body.MediaUrl0;
//   const result = await fetch(`${baseUrl}/ocr/analyze-by-url?url=${encodeURIComponent(mediaUrl)}`).then(r=>r.json());
//   const reply = result.ok
//     ? `Ho letto il documento:\n- Ente: ${result.data.ente || "-" }\n- IBAN: ${result.data.iban || "-" }\n- Importo: ${result.data.amount || "-" }\n- Scadenza: ${result.data.scadenza || "-" }\n\nPaga qui: ${result.pay_link}`
//     : "Non sono riuscito a leggere il file. Riprova con una foto più chiara o un PDF.";
//   return replyTwilio(res, reply);
// }

// --- START SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Runner up on ${PORT}`));


