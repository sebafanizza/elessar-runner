// server.js — Elessar runner (CommonJS, pronto per Render)

const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');

// ───────────────────────────────────────────────────────────────────────────────
// fetch shim (per compatibilità; in Node >=18 spesso non serve)
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers Airtable
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

// ───────────────────────────────────────────────────────────────────────────────
// Helpers Tink (scope corretti: payment:write payment:read)
function ensureTinkEnv() {
  const { TINK_CLIENT_ID, TINK_CLIENT_SECRET, TINK_REDIRECT_URI } = process.env;
  if (!TINK_CLIENT_ID || !TINK_CLIENT_SECRET || !TINK_REDIRECT_URI) {
    throw new Error('Tink non configurato: TINK_CLIENT_ID / TINK_CLIENT_SECRET / TINK_REDIRECT_URI');
  }
}

async function tinkToken() {
  ensureTinkEnv();
  const { TINK_CLIENT_ID, TINK_CLIENT_SECRET } = process.env;
  const res = await fetch('https://api.tink.com/api/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TINK_CLIENT_ID,
      client_secret: TINK_CLIENT_SECRET,
      scope: 'payment:write payment:read'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Tink token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ✅ Payment Request (Tink): market + destinations (iban+name) + reference
async function tinkCreatePaymentRequest({ amountEur, iban, recipientName, description, market }) {
  const access = await tinkToken();

  // per affidabilità in sandbox: usa interi (12) la prima volta
  const amountInt = Math.round(Number(String(amountEur).replace(',', '.')));
  const payload = {
    amount: amountInt,                       // es. 12 = €12
    currency: 'EUR',
    market: market || (process.env.TINK_MARKET || 'IT'),
    destinations: [
      {
        type: 'iban',
        accountNumber: String(iban),
        name: recipientName || 'Beneficiario'
      }
    ],
    reference: description || 'Pagamento bolletta'
  };

  console.log('TINK PR payload:', payload);

  const res = await fetch('https://api.tink.com/api/v1/payments/requests', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('TINK PR error body:', data);
    throw new Error('Create payment request error: ' + JSON.stringify(data));
  }
  return { id: data.id };
}

function tinkPaymentLink(paymentRequestId, market) {
  const q = new URLSearchParams({
    client_id: process.env.TINK_CLIENT_ID || '',
    redirect_uri: process.env.TINK_REDIRECT_URI || '',
    payment_request_id: paymentRequestId,
    market: market || (process.env.TINK_MARKET || 'IT'),
    locale: process.env.TINK_LOCALE || 'it_IT'
  }).toString();
  return `https://link.tink.com/1.0/payments/pay?${q}`;
}

async function tinkGetStatus(paymentRequestId) {
  const access = await tinkToken();
  const url = `https://api.tink.com/api/v1/payments/requests/${paymentRequestId}/transfers`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${access}` } });
  const data = await res.json();
  if (!res.ok) throw new Error('Status error: ' + JSON.stringify(data));
  const s = JSON.stringify(data).toLowerCase();
  return (s.includes('executed') || s.includes('completed')) ? 'paid' : 'pending';
}

// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio → form-encoded
app.use(bodyParser.json());

// Health / Ping
app.get('/', (_req, res) => res.send('Elessar runner ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Test Airtable (crea una riga finta su Jobs)
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

// Stub pagamento (pagina finta che rimbalza alla callback)
app.get('/pay-bolletta-test', (req, res) => {
  const { importo = '49', iban = 'IT60X0542811101000000123456', ente = 'Fornitore Luce', scadenza = '2025-09-10' } = req.query;
  const url = new URL('/tink/callback', process.env.APP_URL || 'https://example.com');
  url.searchParams.set('status', 'ok');
  url.searchParams.set('ente', ente);
  url.searchParams.set('importo', importo);
  url.searchParams.set('iban', iban);
  url.searchParams.set('scadenza', scadenza);
  res.set('Content-Type', 'text/html; charset=utf-8').send(`
    <html><body style="font-family:system-ui;padding:24px">
      <h3>Autorizza pagamento (STUB)</h3>
      <p>Ente: <b>${ente}</b><br/>Importo: <b>€${importo}</b><br/>Scadenza: <b>${scadenza}</b><br/>IBAN: <code>${iban}</code></p>
      <a href="${url.toString()}" style="display:inline-block;padding:10px 14px;background:#16a34a;color:#fff;border-radius:8px;text-decoration:none">Autorizza</a>
    </body></html>
  `);
});

// Pagamento reale: genera Payment Request e reindirizza a Tink Link
app.get('/pay-bolletta', async (req, res) => {
  try {
    const { importo, iban, ente = 'Beneficiario', descr = 'Pagamento bolletta' } = req.query;
    if (!importo || !iban) return res.status(400).send('Manca importo o IBAN');

    ensureTinkEnv();
    const market = process.env.TINK_MARKET || 'IT';

    const { id } = await tinkCreatePaymentRequest({
      amountEur: importo,
      iban,
      recipientName: ente,       // obbligatorio
      description: descr,        // remittance semplice
      market
    });

    const link = tinkPaymentLink(id, market);
    return res.redirect(link);
  } catch (e) {
    return res.status(500).send('Errore Tink: ' + e.message);
  }
});

// Callback Tink: salva ricevuta
app.get('/tink/callback', async (req, res) => {
  try {
    const paymentRequestId = req.query.payment_request_id || req.query.paymentRequestId || null;
    const { ente = 'Sconosciuto', importo = '0', iban = '', scadenza = '' } = req.query;

    let status = 'pending';
    if (paymentRequestId) {
      try { status = await tinkGetStatus(paymentRequestId); } catch (_) {}
    }

    await airtableCreate('Receipts', {
      Ente: ente,
      Importo: Number(String(importo).replace(',', '.')),
      IBAN: iban,
      Scadenza: scadenza,
      PISP_ID: paymentRequestId || 'stub',
      Status: status
    });

    res.set('Content-Type', 'text/html; charset=utf-8').send(`
      <html><body style="font-family:system-ui;padding:24px">
        <h3>Pagamento ${status === 'paid' ? 'riuscito ✅' : 'in lavorazione ⏳'}</h3>
        <p>Registrato in Airtable → Receipts.</p>
        <a href="${process.env.APP_URL || '/'}" style="display:inline-block;margin-top:12px">Torna all'app</a>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Errore callback: ' + e.message);
  }
});

// Webhook WhatsApp (routing base)
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
  const base = process.env.APP_URL || '';

  if (tipo === 'bolletta') {
    const realUrl = `${base}/pay-bolletta?importo=12&iban=IT60X0542811101000000123456&ente=Fornitore%20Luce&descr=Bolletta`;
    const stubUrl = `${base}/pay-bolletta-test?importo=12&iban=IT60X0542811101000000123456&ente=Fornitore%20Luce&scadenza=2025-09-10`;
    msg.body(`Ok 👌 manda PDF/foto della bolletta.\nProva ora:\n• 🔵 Reale (Tink): ${realUrl}\n• ⚪️ Rapido (stub): ${stubUrl}`);
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
