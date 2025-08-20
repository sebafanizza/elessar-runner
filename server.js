// server.js — Elessar runner (Stripe + Airtable + WhatsApp)

const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');
const Stripe = require('stripe');

// ───────────────────────────────────────────────────────────────────────────────
// fetch shim (per compatibilità; in Node >=18 spesso non serve)
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// ───────────────────────────────────────────────────────────────────────────────
// Config & helpers
const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio manda form-encoded
app.use(bodyParser.json());

const APP_URL = process.env.APP_URL || '';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-04-10' });

// Airtable helper
async function airtableCreate(table, fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!baseId || !apiKey) throw new Error('Airtable non configurato');

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
// STRIPE: crea Checkout Session (pagamento carta)
// URL: /pay-card?amount=49.90&ente=Fornitore%20Luce&iban=IT60X0542811101000000123456&descr=Bolletta%20Agosto
app.get('/pay-card', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY || !APP_URL) {
      return res.status(500).send('Stripe non configurato: STRIPE_SECRET_KEY o APP_URL mancante.');
    }

    const amountEur = String(req.query.amount || req.query.importo || '0').replace(',', '.');
    const amountCents = Math.round(parseFloat(amountEur) * 100);
    if (!amountCents || amountCents < 50) return res.status(400).send('Importo non valido.');

    const ente = (req.query.ente || 'Pagamento Elessar').toString();
    const iban = (req.query.iban || '').toString();
    const descr = (req.query.descr || 'Pagamento').toString();

    // La descrizione del prodotto include l’ente
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
      metadata: { ente, iban, descr },
      success_url: `${APP_URL}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/stripe/cancel`
    });

    return res.redirect(session.url);
  } catch (e) {
    console.error('Stripe create session error:', e);
    return res.status(500).send('Errore Stripe: ' + e.message);
  }
});

// Success page: conferma e salva su Airtable (Receipts)
app.get('/stripe/success', async (req, res) => {
  try {
    const sid = req.query.session_id;
    if (!sid) return res.status(400).send('Manca session_id.');

    const session = await stripe.checkout.sessions.retrieve(sid, { expand: ['payment_intent'] });

    const paid = session.payment_status === 'paid' || (session.payment_intent && session.payment_intent.status === 'succeeded');
    const amount = (session.amount_total || 0) / 100;
    const md = session.metadata || {};

    await airtableCreate('Receipts', {
      Ente: md.ente || 'Sconosciuto',
      Importo: amount,
      IBAN: md.iban || '',
      Scadenza: '',                       // opzionale
      PISP_ID: session.id,                // usiamo id sessione come riferimento
      Status: paid ? 'paid' : 'pending'
    });

    res.set('Content-Type', 'text/html; charset=utf-8').send(`
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

// Facoltativo: pagina cancel
app.get('/stripe/cancel', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`
    <html><body style="font-family:system-ui;padding:24px">
      <h3>Pagamento annullato ❌</h3>
      <a href="${APP_URL}" style="display:inline-block;margin-top:12px">Torna all'app</a>
    </body></html>
  `);
});

// ───────────────────────────────────────────────────────────────────────────────
// WhatsApp webhook (routing base). Risponde con link Stripe
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
  } catch (e) { console.error('Airtable error:', e.message); }

  const reply = new MessagingResponse();
  const msg = reply.message();

  if (tipo === 'bolletta') {
    const url = `${APP_URL}/pay-card?amount=12.00&ente=Fornitore%20Luce&iban=IT60X0542811101000000123456&descr=Bolletta`;
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
