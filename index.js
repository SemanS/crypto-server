const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const topmoversRouter = require('./src/routes/topmovers');

// Priradíme route moduly pod prefix /api
app.use('/api', topmoversRouter);

// Spustenie servera
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});