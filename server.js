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
