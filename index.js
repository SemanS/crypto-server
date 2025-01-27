const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Sem NEvkladáme žiadny kód pre analýzy či GPT služby.
// Použijeme route súbory, ktoré importujeme nižšie.
const topmoversRouter = require('./src/routes/topmovers');
//const forexRouter = require('./src/routes/forex');

// Priradíme route moduly pod prefix /api
app.use('/api', topmoversRouter);
//app.use('/api', forexRouter);

// Spustenie servera
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});