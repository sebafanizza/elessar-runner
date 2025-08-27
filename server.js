// server.js — Elessar runner (Stripe + Airtable + WhatsApp) — FULL REPLACE

const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');
const Stripe = require('stripe');

// fetch shim (per compatibilità; in Node >=18 spesso non serve)
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio manda form-encoded
app.use(bodyParser.json());

// ───────────────────────────────────────────────────────────────────────────────
// ENV
const APP_URL = process.env.APP_URL || '';
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = new Stripe(stripeSecret, { apiVersion: '2024-04-10' });

// ───────────────────────────────────────────────────────────────────────────────
// Airtable helper
async function airtableCreate(table, fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!baseId || !apiKey) throw new Error('Airtable non configurato (AIRTABLE_BASE_ID / AIRTABLE_API_KEY)');

  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
}

// Normalizza stringa data verso YYYY-MM-DD; se non valida → undefined
function toIsoDate(s) {
  if (!s) return undefined;
  const str = String(s).trim();
  if (!str) return undefined;

  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // dd/mm/yyyy o dd-mm-yyyy o dd.mm.yyyy
  const m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const iso = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
    if (!isNaN(iso.getTime())) return iso.toISOString().slice(0, 10);
  }

  // fallback generico
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);

  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────────
// Health
app.get('/', (_req, res) => res.send('Elessar runner ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Test Airtable
app.get('/test-airtable', async (_req, res) => {
  try {
    const out = await airtableCreate('Jobs', {
      Tipo: 'altro', Stato: 'nuovo', Utente: 'test', Dettagli: 'ping'
    });
    res.status(200).send('OK: ' + JSON.stringify(out));
  } catch (e) {
    res.status(500).send('ERR: ' + e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// STRIPE: crea una Checkout Session (pagamento carta)
//
// Esempi:
// /pay-card?amount=12&ente=Test%20Enel&iban=IT60X0542811101000000123456&descr=Bolletta
// /pay-card?amount=49.90&ente=Acqua%20Spa&descr=Bolletta%20Agosto&scadenza=2025-09-10
app.get('/pay-card', async (req, res) => {
  try {
    if (!stripeSecret || !APP_URL) {
      return res.status(500).send('Stripe non configurato: STRIPE_SECRET_KEY o APP_URL mancante.');
    }

    const amountEurStr = String(req.query.amount || req.query.importo || '0').replace(',', '.');
    const amountCents = Math.round(parseFloat(amountEurStr) * 100);
    if (!amountCents || amountCents < 50) return res.status(400).send('Importo non valido (min 0,50€).');

    const ente = (req.query.ente || 'Pagamento Elessar').toString();
    const iban = (req.query.iban || '').toString();
    const descr = (req.query.descr || 'Pagamento').toString();
    const scadenza = (req.query.scadenza || '').toString(); // può essere vuota

    const productName = `Pagamento bolletta - ${ente}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: productName },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      metadata: { ente, iban, descr, scadenza }, // 👈 includiamo anche scadenza
      success_url: `${APP_URL}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/stripe/cancel`
    });

    return res.redirect(session.url);
  } catch (e) {
    console.error('Stripe create session error:', e);
    return res.status(500).send('Errore Stripe: ' + e.message);
  }
});

// Success: conferma e salva ricevuta su Airtable (Receipts)
app.get('/stripe/success', async (req, res) => {
  try {
    const sid = req.query.session_id;
    if (!sid) return res.status(400).send('Manca session_id.');

    const session = await stripe.checkout.sessions.retrieve(sid, { expand: ['payment_intent'] });

    const paid = session.payment_status === 'paid'
      || (session.payment_intent && session.payment_intent.status === 'succeeded');

    const amount = (session.amount_total || 0) / 100;
    const md = session.metadata || {};

    const fields = {
      Ente: md.ente || 'Sconosciuto',
      Importo: amount,
      IBAN: md.iban || '',
      PISP_ID: session.id,                 // usiamo l’id della sessione come riferimento
      Status: paid ? 'paid' : 'pending'
    };

    // aggiungi Scadenza solo se valida
    const isoScadenza = toIsoDate(md.scadenza);
    if (isoScadenza) fields.Scadenza = isoScadenza;

    await airtableCreate('Receipts', fields);

    res
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(`
        <html><body style="font-family:system-ui;padding:24px">
          <h3>Pagamento ${paid ? 'riuscito ✅' : 'in lavorazione ⏳'}</h3>
          <p>Ricevuta registrata in Airtable → Receipts.</p>
          <a href="${APP_URL}" style="display:inline-block;margin-top:12px">Torna all'app</a>
        </body></html>
      `);
  } catch (e) {
    console.error('Stripe success error:', e);
    res.status(500).send('Errore success: ' + e.message);
  }
});

// Cancel (opzionale)
app.get('/stripe/cancel', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`
    <html><body style="font-family:system-ui;padding:24px">
      <h3>Pagamento annullato ❌</h3>
      <a href="${APP_URL}" style="display:inline-block;margin-top:12px">Torna all'app</a>
    </body></html>
  `);
});

// ───────────────────────────────────────────────────────────────────────────────
// WhatsApp webhook (routing base → link a Stripe)
app.post('/whatsapp/webhook', async (req, res) => {
  const from = req.body.From || '';
  const text = (req.body.Body || '').trim().toLowerCase();

  let tipo = 'altro';
  if (text.includes('bolletta')) tipo = 'bolletta';
  else if (text.includes('medico')) tipo = 'medico';
  else if (text.includes('auto')) tipo = 'auto';
  else if (text.includes('lista') || text.includes('waitlist')) tipo = 'waitlist';

  try {
    await airtableCreate('Jobs', { Tipo: tipo, Stato: 'nuovo', Utente: from, Dettagli: text });
  } catch (e) {
    console.error('Airtable error:', e.message);
  }

  const reply = new MessagingResponse();
  const msg = reply.message();

  if (tipo === 'bolletta') {
    // link Stripe pronto (importo esempio 12€)
    const url = `${APP_URL}/pay-card?amount=12&ente=Fornitore%20Luce&iban=IT60X0542811101000000123456&descr=Bolletta`;
    msg.body(`Ok 👌 manda PDF/foto della bolletta.\nPer pagare subito con carta: ${url}`);
  } else if (tipo === 'medico') {
    msg.body('Perfetto. Dimmi giorno/fascia oraria e provo a prenotare.');
  } else if (tipo === 'auto') {
    msg.body('Posso proporti due opzioni: express o tunnel. Che orario preferisci?');
  } else if (text.includes('ciao')) {
    msg.body('Ciao! Sono Elessar. Posso pagare bollette, prenotare medico/ristorante e gestire liste d’attesa.');
  } else {
    msg.body('Posso aiutarti con: bollette, prenotazioni mediche/ristoranti, waitlist. Scrivi "bolletta" o "medico".');
  }

  res.type('text/xml').send(reply.toString());
});

// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Runner up on ' + PORT));

// --- imports in alto (aggiungi se mancanti) ---
import OpenAI from 'openai'; // se già presente ok
import crypto from 'crypto';

// Airtable via REST (niente librerie)
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_KEY  = process.env.AIRTABLE_API_KEY;

// DEMO guard: non permettere chiavi live in demo
function assertDemoGuard() {
  if (process.env.APP_MODE === 'demo' &&
      process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    throw new Error('Demo mode attivo: rimuovi chiavi LIVE da Render.');
  }
}
assertDemoGuard();

// helper Airtable
async function airtableCreate(table, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [{ fields }] })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('Airtable error:', t);
    throw new Error('Airtable create failed');
  }
  const json = await res.json();
  return json.records?.[0]?.id;
}

// build pay link
function buildPayLink({ amount, ente, iban, descr, scadenza }) {
  const u = new URL('/pay-card', process.env.APP_URL);
  if (amount) u.searchParams.set('amount', String(amount).replace(',', '.'));
  if (ente) u.searchParams.set('ente', ente);
  if (iban) u.searchParams.set('iban', iban);
  if (descr) u.searchParams.set('descr', descr);
  if (scadenza) u.searchParams.set('scadenza', scadenza);
  return u.toString();
}

// parser semplici
function parseAmount(s) {
  const m = (s || '').replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : undefined;
}
function normalizeIban(s) {
  if (!s) return undefined;
  return s.replace(/\s+/g, '').toUpperCase();
}
function parseDateISO(s) {
  if (!s) return undefined;
  // accetta YYYY-MM-DD o DD/MM/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return undefined;
}

// --- MEMORY semplice per chat WhatsApp (per MVP va benissimo) ---
const sessions = new Map(); // key: from, value: {step, data, ts}
const STEPS = ['ente','importo','iban','scadenza'];

// risponditore Twilio
function replyTwilio(res, msg) {
  const twiml = new (require('twilio').twiml.MessagingResponse)();
  twiml.message(msg);
  res.type('text/xml').send(twiml.toString());
}

// --- Webhook WhatsApp (sostituisci/integra la tua rotta esistente) ---
app.post('/whatsapp/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const from = req.body.From || 'unknown';
    const body = (req.body.Body || '').trim();

    // entrypoint
    if (/^bolletta\b/i.test(body) || !sessions.get(from)) {
      sessions.set(from, { step: 0, data: {}, ts: Date.now() });
      return replyTwilio(res,
        '🧪 DEMO • Nessun addebito\n' +
        'Ok, ti aiuto a preparare il pagamento della bolletta.\n' +
        '1/4 • Scrivi *Ente* (es. Enel, A2A, Gori…)\n\n' +
        '_Puoi sempre digitare "annulla" per ricominciare_.'
      );
    }

    // annulla
    if (/^annulla$/i.test(body)) {
      sessions.delete(from);
      return replyTwilio(res, 'Flusso annullato. Scrivi *bolletta* per ricominciare.');
    }

    // recupera sessione
    const s = sessions.get(from) || { step: 0, data: {} };

    // step corrente
    const step = STEPS[s.step];

    if (step === 'ente') {
      s.data.ente = body;
      s.step++;
      sessions.set(from, s);
      return replyTwilio(res, '2/4 • Importo (es. 49,90)');
    }

    if (step === 'importo') {
      const amt = parseAmount(body);
      if (!amt) return replyTwilio(res, 'Formato importo non valido. Esempio: 49,90');
      s.data.amount = amt;
      s.step++;
      sessions.set(from, s);
      return replyTwilio(res, '3/4 • IBAN del fornitore (es. IT60 X054 2811 1010 0000 123456)');
    }

    if (step === 'iban') {
      const iban = normalizeIban(body);
      if (!iban || !/^IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}$/.test(iban))
        return replyTwilio(res, 'IBAN non valido. Invia un IBAN italiano completo (es. IT60X0542811101000000123456).');
      s.data.iban = iban;
      s.step++;
      sessions.set(from, s);
      return replyTwilio(res, '4/4 • Scadenza (YYYY-MM-DD oppure DD/MM/YYYY). Se non c’è, scrivi "nessuna".');
    }

    if (step === 'scadenza') {
      let d = undefined;
      if (!/^nessuna$/i.test(body)) d = parseDateISO(body);
      if (!d && !/^nessuna$/i.test(body)) return replyTwilio(res, 'Data non valida. Esempi: 2025-09-10 oppure 10/09/2025');
      s.data.scadenza = d;
      // chiusura
      const { ente, amount, iban, scadenza } = s.data;
      const descr = 'Bolletta';
      const link = buildPayLink({ amount, ente, iban, descr, scadenza });

      // salva su Airtable come DEMO
      try {
        await airtableCreate('Receipts', {
          Ente: ente,
          Importo: amount,
          IBAN: iban,
          Scadenza: scadenza || null,
          Status: 'demo',
          PISP_ID: `demo_${Date.now()}`
        });
      } catch (e) {
        console.error('Airtable save failed (demo):', e.message);
      }

      sessions.delete(from);

      // messaggio finale
      const msg =
`🧪 DEMO • Nessun addebito
Ecco il riepilogo:
• Ente: ${ente}
• Importo: € ${amount.toFixed(2)}
• IBAN: ${iban}
• Scadenza: ${scadenza || '—'}

👉 Link di prova (solo ambiente test):
${link}

Per il pagamento reale: usa il sito/app del fornitore o bonifico al loro IBAN.
Scrivi *bolletta* per inserirne un’altra.`;
      return replyTwilio(res, msg);
    }

    // fallback
    replyTwilio(res, 'Non ho capito. Scrivi *bolletta* per iniziare, oppure *annulla* per uscire.');
  } catch (err) {
    console.error('WA webhook error:', err);
    return replyTwilio(res, 'Si è verificato un errore. Scrivi *bolletta* per riprovare.');
  }
});

// --- Guardiano su /pay-card (opzionale ma consigliato) ---
app.use((req, res, next) => {
  if (process.env.APP_MODE === 'demo' &&
      process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
    return res.status(403).send('Demo attivo: pagamenti LIVE disabilitati.');
  }
  next();
});

