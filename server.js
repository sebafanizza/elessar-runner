import express from 'express';
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


// --- WhatsApp webhook (Twilio) ---
app.post('/whatsapp/webhook', async (req, res) => {
const from = req.body.From || '';
const text = (req.body.Body || '').trim();
const intent = await classify(text);
await replyWhatsApp(from, templateFor(intent));
res.sendStatus(200);
});


async function classify(text){
const sys = 'Router intenti: medico, bolletta, auto, sandwich, altro. Rispondi JSON con intent e slots.';
const r = await openai.createChatCompletion({
model: 'gpt-4o-mini',
messages: [{role:'system',content:sys},{role:'user',content:text}],
temperature: 0.1
});
try { return JSON.parse(r.data.choices[0].message.content); } catch { return {intent:'altro', slots:{}} }
}


async function replyWhatsApp(to, body){
const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
const form = new URLSearchParams({ To: to, From: process.env.TWILIO_WHATSAPP_NUMBER, Body: body });
await fetch(url, { method:'POST', headers:{
'Authorization':'Basic '+Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
'Content-Type':'application/x-www-form-urlencoded'
}, body: form });
}


function templateFor(r){
const i = r?.intent || 'altro';
if(i==='bolletta') return 'Inviami la foto/PDF della bolletta: estraggo dati e ti mando il link di autorizzazione del pagamento.';
if(i==='medico') return 'Ok, cerco uno slot per la visita. Preferenze orarie?';
if(i==='auto') return 'Posso proporti due opzioni vicine (express o tunnel). Che fascia oraria preferisci?';
if(i==='sandwich') return 'Indicami luogo, orario e budget. Ti mando 2–3 proposte.';
return 'Posso aiutarti con prenotazioni mediche, bollette, auto, babysitter/badanti/artigiani. Cosa ti serve?';
}


// --- Stripe webhook (escrow/caparra) ---
app.post('/stripe/webhook', (req, res) => {
const sig = req.headers['stripe-signature'];
let event;
try {
event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_ENDPOINT_SECRET);
} catch (err) {
return res.status(400).send(`Webhook Error: ${err.message}`);
}
if (event.type === 'payment_intent.succeeded') {
// TODO: aggiorna job su Airtable
}
res.json({ received: true });
});


// --- Tink callback (PISP) ---
app.get('/tink/callback', async (req, res) => {
const { paymentId, status } = req.query; // valori dipendono da Tink
// TODO: verifica stato e aggiorna Airtable + notifica WhatsApp all'utente
res.send('Pagamento ricevuto. Puoi chiudere questa finestra.');
});


app.get('/', (req,res)=>res.send('Elessar runner ok'));


app.listen(process.env.PORT || 8080, ()=>console.log('Runner up'));
