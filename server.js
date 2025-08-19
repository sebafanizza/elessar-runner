const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');

// shim fetch (compatibilità)
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// --- Airtable helpers ---
async function airtableCreate(table, fields) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt);
  return JSON.parse(txt);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio usa form-encoded
app.use(bodyParser.json());

// Ping
app.get('/', (_req, res) => res.send('Elessar runner ok'));

// 🔎 TEST rapido: crea un Job finto
app.get('/test-airtable', async (_req, res) => {
  try {
    const out = await airtableCreate('Jobs', { Tipo: 'altro', Stato: 'nuovo', Utente: 'test', Dettagli: 'ping' });
    res.status(200).send('OK: ' + JSON.stringify(out));
  } catch (e) {
    res.status(500).send('ERR: ' + e.message);
  }
});

// 🧪 PREPAGA (STUB): genera un “link banca” finto
app.get('/pay-bolletta-test', (req, res) => {
  const { importo = '49.90', iban = 'IT00A0000000000000000000000', ente = 'Fornitore Luce', scadenza = '2025-09-10' } = req.query;
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
      <p style="margin-top:20px;color:#64748b">Nota: test senza banca. Dopo il click torni al tuo server e salvo la ricevuta.</p>
    </body></html>
  `);
});
// === ROUTE REALE: genera link banca via Tink ===
app.get('/pay-bolletta', async (req, res) => {
  const { importo, iban, ente = 'Fornitore', descr = 'Pagamento bolletta' } = req.query;

  // Controllo env: se manca qualcosa, meglio dirlo chiaro
  if (!process.env.TINK_CLIENT_ID || !process.env.TINK_CLIENT_SECRET || !process.env.TINK_REDIRECT_URI) {
    return res
      .status(500)
      .send('Tink non configurato: imposta TINK_CLIENT_ID, TINK_CLIENT_SECRET, TINK_REDIRECT_URI su Render.');
  }

  try {
    // 1) token client-credentials
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TINK_CLIENT_ID,
      client_secret: process.env.TINK_CLIENT_SECRET,
      scope: 'payments:write payments:read'
    });
    const tokRes = await fetch('https://api.tink.com/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const tok = await tokRes.json();
    if (!tokRes.ok) throw new Error('Token: ' + JSON.stringify(tok));

    // 2) crea payment request (importo in centesimi)
    const payload = {
      amount: { value: Math.round(Number(importo) * 100), currency: 'EUR' },
      recipient: { iban, name: ente },
      description: descr
    };
    const prRes = await fetch('https://api.tink.com/api/v1/payments/requests', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const pr = await prRes.json();
    if (!prRes.ok) throw new Error('Create PR: ' + JSON.stringify(pr));

    // 3) costruisci Tink Link e reindirizza
    const q = new URLSearchParams({
      client_id: process.env.TINK_CLIENT_ID,
      redirect_uri: process.env.TINK_REDIRECT_URI,
      payment_request_id: pr.id,
      market: process.env.TINK_MARKET || 'IT',
      locale: process.env.TINK_LOCALE || 'it_IT'
    }).toString();
    return res.redirect(`https://link.tink.com/1.0/payments/pay?${q}`);
  } catch (e) {
    return res.status(500).send('Errore Tink: ' + e.message);
  }
});

// ✅ CALLBACK “banca” (STUB): salva ricevuta
app.get('/tink/callback', async (req, res) => {
  try {
    const { status, ente, importo, iban, scadenza } = req.query;
    const fields = {
      Ente: ente || 'Sconosciuto',
      Importo: importo ? Number(importo) : 0,
      IBAN: iban || '',
      Scadenza: scadenza || '',
      PISP_ID: 'stub',
      Status: status === 'ok' ? 'paid' : 'failed',
    };
    await airtableCreate('Receipts', fields);
    res.set('Content-Type', 'text/html; charset=utf-8').send(`
      <html><body style="font-family:system-ui;padding:24px">
        <h3>Pagamento ${status === 'ok' ? 'riuscito ✅' : 'fallito ❌'}</h3>
        <p>La ricevuta è stata salvata in Airtable → Receipts.</p>
        <a href="${process.env.APP_URL}" style="display:inline-block;margin-top:12px">Torna all'app</a>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Errore salvataggio ricevuta: ' + e.message);
  }
});

// WhatsApp webhook (routing semplice)
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
    const testUrl = (process.env.APP_URL || '') + '/pay-bolletta-test?importo=49.90&iban=IT00A0000000000000000000000&ente=Fornitore%20Luce&scadenza=2025-09-10';
    msg.body(`Ok 👌 manda PDF/foto della bolletta.\nPer provare ORA il flusso, clicca qui (test): ${testUrl}`);
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Runner up on ' + PORT));
