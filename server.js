// server.js — Elessar MVP DEMO + sessioni WhatsApp persistenti su Airtable
// ES Module (package.json: { "type": "module" })

import express from 'express';
import Stripe from 'stripe';

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_MODE = process.env.APP_MODE || 'demo';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_TOKEN = process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY || '';

// tabelle Airtable
const AT_TABLE_JOBS = process.env.AT_TABLE_JOBS || 'Jobs';
const AT_TABLE_RECEIPTS = process.env.AT_TABLE_RECEIPTS || 'Receipts';
const AT_TABLE_SESSIONS = process.env.AT_TABLE_SESSIONS || 'Sessions';

// Guard-rail: in DEMO rifiuta chiavi live
if (APP_MODE === 'demo' && STRIPE_KEY.startsWith('sk_live_')) {
  console.error('ERROR: APP_MODE=demo ma hai una chiave LIVE. Metti sk_test_... su Render.');
  process.exit(1);
}

// Stripe client (ok anche in test)
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Utils ----------
function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function replyTwilio(res, messageText) {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>${escapeXml(messageText)}</Message></Response>`;
  res.type('text/xml').send(body);
}
function parseAmount(input) {
  if (!input) return undefined;
  const m = String(input).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
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
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    console.error('Airtable missing env:', { AIRTABLE_BASE: !!AIRTABLE_BASE, AIRTABLE_TOKEN: !!AIRTABLE_TOKEN });
    return null;
  }
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error('Airtable error:', r.status, text);
    return null;
  }
  try {
    const j = JSON.parse(text);
    return j.records?.[0]?.id || null;
  } catch (e) {
    console.error('Airtable parse error:', e.message, text);
    return null;
  }
}
async function atUpdate(table, id, fields = {}) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ id, fields }] }),
  });
  return r.ok;
}
async function atDelete(table, id) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}/${id}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  return r.ok;
}
function q(param) { return encodeURIComponent(param); }
function formulaEq(field, value) {
  // usa stringhe con doppi apici; escape dei doppi apici
  const v = String(value).replace(/"/g, '\\"');
  return `({${field}}="${v}")`;
}
async function atFindOneByField(table, field, value) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}?maxRecords=1&filterByFormula=${q(formulaEq(field, value))}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  const j = await r.json();
  const rec = j.records?.[0];
  return rec ? { id: rec.id, fields: rec.fields || {} } : null;
}

// ---------- Sessions (persistenti su Airtable) ----------
async function getSession(from) {
  const rec = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  if (!rec) return null;
  const step = Number(rec.fields.Step ?? 0);
  const dataRaw = rec.fields.Data || '{}';
  const ts = Number(rec.fields.TS ?? 0);
  let data = {};
  try { data = JSON.parse(dataRaw); } catch {}
  // timeout: se la sessione è vecchia > 30 min, considerala scaduta
  if (Date.now() - ts > 30 * 60 * 1000) return null;
  return { id: rec.id, step, data, ts };
}
async function setSession(from, { step, data }) {
  const now = Date.now();
  const existing = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  const fields = { From: from, Step: step, Data: JSON.stringify(data || {}), TS: now };
  if (existing) {
    await atUpdate(AT_TABLE_SESSIONS, existing.id, fields);
    return existing.id;
  } else {
    return await atCreate(AT_TABLE_SESSIONS, fields);
  }
}
async function deleteSession(from) {
  const existing = await atFindOneByField(AT_TABLE_SESSIONS, 'From', from);
  if (existing) await atDelete(AT_TABLE_SESSIONS, existing.id);
}

// ---------- Health ----------
app.get('/', (_req, res) => {
  res.status(200).send('Elessar runner ok');
});

// ---------- WhatsApp (Sandbox) MVP con sessioni persistenti ----------
const STEPS = ['ente', 'importo', 'iban', 'scadenza'];

app.post('/whatsapp/webhook', async (req, res) => {
  try {
    const from = req.body.From || 'unknown';
    const body = (req.body.Body || '').trim();

    // start / reset
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

    if (/^annulla$/i.test(body)) {
      await deleteSession(from);
      return replyTwilio(res, 'Flusso annullato. Scrivi *bolletta* per ricominciare.');
    }

    let s = await getSession(from);
    if (!s) {
      // nessuna sessione valida → ricomincia
      await setSession(from, { step: 0, data: {} });
      return replyTwilio(
        res,
        '🧪 DEMO • Nessun addebito\n' +
          'Sessione nuova.\n' +
          '1/4 • Scrivi *Ente* (es. Enel, A2A, Gori…)\n'
      );
    }

    const step = STEPS[s.step];

    if (step === 'ente') {
      s.data.ente = body;
      s.step++;
      await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '2/4 • Importo (es. 49,90)');
    }

    if (step === 'importo') {
      const amt = parseAmount(body);
      if (!amt) return replyTwilio(res, 'Formato importo non valido. Esempio: 49,90');
      s.data.amount = amt;
      s.step++;
      await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '3/4 • IBAN del fornitore (es. IT60 X054 2811 1010 0000 123456)');
    }

    if (step === 'iban') {
      const iban = normalizeIban(body);
      if (!iban || !/^IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}$/.test(iban))
        return replyTwilio(res, 'IBAN non valido. Invia un IBAN italiano completo (es. IT60X0542811101000000123456).');
      s.data.iban = iban;
      s.step++;
      await setSession(from, { step: s.step, data: s.data });
      return replyTwilio(res, '4/4 • Scadenza (YYYY-MM-DD oppure DD/MM/YYYY). Se non c’è, scrivi "nessuna".');
    }

    if (step === 'scadenza') {
      let d;
      if (!/^nessuna$/i.test(body)) d = parseDateISO(body);
      if (!d && !/^nessuna$/i.test(body))
        return replyTwilio(res, 'Data non valida. Esempi: 2025-09-10 oppure 10/09/2025');

      s.data.scadenza = d;
      const { ente, amount, iban, scadenza } = s.data;
      const descr = 'Bolletta';
      const link = buildPayLink({ amount, ente, iban, descr, scadenza });

      // Log Airtable in DEMO
      try {
        await atCreate(AT_TABLE_RECEIPTS, {
          Ente: ente,
          Importo: amount,
          IBAN: iban,
          Scadenza: scadenza || null,
          Status: 'demo',
          PISP_ID: `demo_${Date.now()}`,
        });
      } catch (e) {
        console.error('Airtable save failed (demo):', e.message);
      }

      await deleteSession(from);

      const msg =
        `🧪 DEMO • Nessun addebito\n` +
        `Ecco il riepilogo:\n` +
        `• Ente: ${ente}\n` +
        `• Importo: € ${amount.toFixed(2)}\n` +
        `• IBAN: ${iban}\n` +
        `• Scadenza: ${scadenza || '—'}\n\n` +
        `👉 Link di prova (solo ambiente test):\n${link}\n\n` +
        `Per il pagamento reale: usa il sito/app del fornitore o bonifico al loro IBAN.\n` +
        `Scrivi *bolletta* per inserirne un’altra.`;
      return replyTwilio(res, msg);
    }

    // fallback
    return replyTwilio(res, 'Non ho capito. Scrivi *bolletta* per iniziare, oppure *annulla* per uscire.');
  } catch (err) {
    console.error('WA webhook error:', err);
    return replyTwilio(res, 'Si è verificato un errore. Scrivi *bolletta* per riprovare.');
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
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: cents,
            product_data: {
              name: `Pagamento ${ente}`,
              description: `${descr}${scadenza ? ` • Scadenza ${scadenza}` : ''}`,
            },
          },
        },
      ],
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
  try {
    await atCreate(AT_TABLE_RECEIPTS, { Status: 'demo', PISP_ID: String(sid) });
  } catch (e) {}
  res
    .status(200)
    .send(
      `<html><body style="font-family: system-ui; padding: 24px">
         <h1>✅ Pagamento di prova completato</h1>
         <p>Questa è una transazione di TEST (DEMO). Nessun addebito reale.</p>
         <p><a href="/">Torna all'home</a></p>
       </body></html>`
    );
});
app.get('/stripe/cancel', (_req, res) => {
  res
    .status(200)
    .send(
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

// ---------- Start ----------
app.listen(PORT, () => console.log('Runner up on', PORT, 'mode:', APP_MODE));
