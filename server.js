const express = require('express');
const bodyParser = require('body-parser');
const { twiml: { MessagingResponse } } = require('twilio');

const app = express();

// Twilio manda form-url-encoded
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Ping
app.get('/', (req, res) => res.send('Elessar runner ok'));

// Webhook WhatsApp
app.post('/whatsapp/webhook', (req, res) => {
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim().toLowerCase();

  const reply = new MessagingResponse();
  const msg = reply.message();

  if (body.includes('bolletta')) {
    msg.body('Ok 👌 manda PDF/foto della bolletta e preparo il pagamento.');
  } else if (body.includes('medico')) {
    msg.body('Perfetto. Dimmi giorno/fascia oraria e provo a prenotare.');
  } else if (body.includes('ciao')) {
    msg.body('Ciao! Sono Elessar. Posso pagare bollette, prenotare medico/ristorante, e gestire liste d’attesa.');
  } else {
    msg.body('Posso aiutarti con: bollette, prenotazioni mediche/ristoranti, waitlist. Scrivi "bolletta" o "medico".');
  }

  res.type('text/xml').send(reply.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Runner up on ' + PORT));
