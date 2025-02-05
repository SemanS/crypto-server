const express = require('express');
const cors = require('cors');
const http = require('http');
require('dotenv').config();
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// Vytvoríme HTTP server a WS server, spojené na rovnakom porte
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Import backtest engine a data loader funkcie
const { runBacktest } = require('./src/services/backtestEngine');
const { loadTimeframesForBacktest } = require('./src/services/dataLoader');
const { tsToISO } = require('./src/utils/timeUtils');

// Helper pre filtrovanie dát do určitého rozsahu
function filterInRange(data, toTime) {
  if (!toTime) return data;
  return data.filter(c => c[0] <= toTime);
}

// Pridáme existujúce routy, ak sú potrebné
const topmoversRouter = require('./src/routes/topmovers');
const tradingPaperRoutes = require('./src/routes/tradingPaper');
const backTestRoute = require('./src/services/backTestRoute');
const backTestRouter = require('./src/routes/backtest');

app.use('/api', topmoversRouter);
app.use('/api', tradingPaperRoutes);
app.use('/api', backTestRoute);
app.use('/api', backTestRouter);

// WS spojenie: klient odosiela správu na spustenie backtestu
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'startBacktest') {

        const { symbol, hoursToBacktest, fromDate, toDate } = msg;
        
        let fromTime = (fromDate && fromDate.trim() !== '')
          ? new Date(fromDate).getTime()
          : undefined;
        let toTime = (toDate && toDate.trim() !== '')
          ? new Date(toDate).getTime()
          : undefined;
        
        if (isNaN(fromTime)) fromTime = undefined;
        if (isNaN(toTime)) toTime = undefined;
        
        console.log("WS Backtest – from:", fromTime, "to:", toTime);

        const data = await loadTimeframesForBacktest(symbol, fromTime, toTime);
        const dailyData = filterInRange(data.ohlcvDailyAll, toTime);
        const weeklyData = filterInRange(data.ohlcvWeeklyAll, toTime);
        const hourData = filterInRange(data.ohlcv1hAll, toTime);
        const min15Data = filterInRange(data.ohlcv15mAll, toTime);
        const min5Data = filterInRange(data.ohlcv5mAll, toTime);
        const min1Data = filterInRange(data.ohlcv1mAll, toTime);

        if (!fromTime && hourData.length > 0) {
          fromTime = hourData[0][0];
        }

        runBacktest({
          symbol,
          hoursToBacktest,
          fromTime,
          toTime,
          dailyData,
          weeklyData,
          hourData,
          min15Data,
          min5Data,
          min1Data
        }, ws)
        .catch(err => {
          console.error('Error during backtest:', err);
          ws.send(JSON.stringify({ type: "error", error: err.message }));
        });
      }
    } catch (e) {
      console.error("Error parsing WS message:", e);
    }
  });
});

// Spustenie servera (na porte 3001 alebo podľa PORT v .env)
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});
