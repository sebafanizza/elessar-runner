const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');

// shim fetch per qualsiasi versione di Node
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// --- helpers Airtable ---
async function airtableCreateJob(fields) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Jobs`;
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
  return txt;
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ping
app.get('/', (_req, res) => res.send('Elessar runner ok'));

// 🔎 TEST: crea un record finto su Jobs
app.get('/test-airtable', async (_req, res) => {
  try {
    const out = await airtableCreateJob({
      Tipo: 'altro',
      Stato: 'nuovo',
      Utente: 'test',
      Dettagli: 'ping'
    });
    res.status(200).send('OK: ' + out);
  } catch (e) {
    res.status(500).send('ERR: ' + e.message);
  }
});

// WhatsApp webhook (come prima)
app.post('/whatsapp/webhook', async (req, res) => {
  const from = req.body.From || '';
  const text = (req.body.Body || '').trim().toLowerCase();

  let tipo = 'altro';
  if (text.includes('bolletta')) tipo = 'bolletta';
  else if (text.includes('medico')) tipo = 'medico';
  else if (text.includes('auto')) tipo = 'auto';
  else if (text.includes('lista') || text.includes('waitlist')) tipo = 'waitlist';

  try {
    await airtableCreateJob({ Tipo: tipo, Stato: 'nuovo', Utente: from, Dettagli: text });
  } catch (e) {
    console.error('Airtable error:', e.message);
  }

  const reply = new MessagingResponse();
  const msg = reply.message();
  if (tipo === 'bolletta') msg.body('Ok 👌 manda PDF/foto della bolletta e preparo il pagamento.');
  else if (tipo === 'medico') msg.body('Perfetto. Dimmi giorno/fascia oraria e provo a prenotare.');
  else if (tipo === 'auto') msg.body('Posso proporti due opzioni: express o tunnel. Che orario preferisci?');
  else if (text.includes('ciao')) msg.body('Ciao! Sono Elessar. Posso pagare bollette, prenotare medico/ristorante e gestire liste d’attesa.');
  else msg.body('Posso aiutarti con: bollette, prenotazioni mediche/ristoranti, waitlist. Scrivi "bolletta" o "medico".');

  res.type('text/xml').send(reply.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Runner up on ' + PORT));
