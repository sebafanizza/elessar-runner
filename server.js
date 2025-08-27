// server.js — Elessar MVP DEMO (WhatsApp step → link Stripe test → log Airtable)
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
const AIRTABLE_KEY  = process.env.AIRTABLE_API_KEY || '';

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
async function airtableCreate(table, fields) {
  if (!AIRTABLE_BASE || !AIRTABLE_KEY) return null; // silenzioso in assenza env
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('Airtable error:', t);
    return null;
  }
  const j = await r.json();
  return j.records?.[0]?.id || null;
}

// ---------- Health ----------
app.get('/', (_req, res) => {
  res.status(200).send('Elessar runner ok');
});

// ---------- WhatsApp (Sandbox) MVP: flusso a 4 step ----------
const sessions = new Map(); // key: From (numero mittente), value: { step, data, ts }
const STEPS = ['ente', 'importo', 'iban', 'scadenza'];

app.post('/whatsapp/webhook', async (req, res) => {
  try {
    const from = req.body.From || 'unknown';
    const body = (req.body.Body || '').trim();

    // start / reset
    if (/^bolletta\b/i.test(body) || !sessions.get(from)) {
      sessions.set(from, { step: 0, data: {}, ts: Date.now() });
      return replyTwilio(
        res,
        '🧪 DEMO • Nessun addebito\n' +
          'Ok, ti aiuto a preparare il pagamento.\n' +
          '1/4 • Scrivi *Ente* (es. Enel, A2A, Gori…)\n\n' +
          '_Scrivi "annulla" per ricominciare_.'
      );
    }

    if (/^annulla$/i.test(body)) {
      sessions.delete(from);
      return replyTwilio(res, 'Flusso annullato. Scrivi *bolletta* per ricominciare.');
    }

    const s = sessions.get(from) || { step: 0, data: {} };
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
        await airtableCreate('Receipts', {
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

      sessions.delete(from);
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
      // Metadati utili in Dashboard
      metadata: {
        ente,
        iban,
        descr,
        scadenza: scadenza || '',
        app_mode: APP_MODE,
      },
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

  // In DEMO segniamo come demo anche se "succeeded" in test
  try {
    const recordId = await airtableCreate('Receipts', {
      Status: 'demo',
      PISP_ID: String(sid),
    });
    console.log('Airtable saved demo receipt:', recordId);
  } catch (e) {
    console.error('Airtable save after success failed:', e.message);
  }

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
    const id = await airtableCreate('Jobs', {
      Tipo: 'altro',
      Stato: 'nuovo',
      Note: `ping ${new Date().toISOString()}`,
    });
    res.status(200).send(`OK: creato record Jobs ${id || '(no id)'}`);
  } catch (e) {
    res.status(500).send('Airtable non configurato o errore.');
  }
});

// ---------- Start ----------
app.listen(PORT, () => console.log('Runner up on', PORT, 'mode:', APP_MODE));
