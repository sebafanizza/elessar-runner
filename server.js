const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Elessar runner ok'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Runner up on ' + PORT));



app.listen(process.env.PORT || 8080, ()=>console.log('Runner up'));
