const express = require('express');
const cors = require('cors');
const http = require('http');
require('dotenv').config();
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// Vytvoríme HTTP server a zároveň WS server naviazaný na tento server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Import backtest engine a data loader funkcie
const { runBacktest } = require('./src/services/backtestEngine');
const { loadTimeframesForBacktest } = require('./src/services/dataLoader');
const { tsToISO, timeframeToMs } = require('./src/utils/timeUtils');

// Helper pre filtrovanie dát do určitého rozsahu
function filterInRange(data, toTime) {
  if (!toTime) return data;
  return data.filter(c => c[0] <= toTime);
}

// Pridáme existujúce Express routy, ak sú potrebné
const topmoversRouter = require('./src/routes/topmovers');
const tradingPaperRoutes = require('./src/routes/tradingPaper');
const backTestRoute = require('./src/services/backTestRoute');
const backTestRouter = require('./src/routes/backtest');

app.use('/api', topmoversRouter);
app.use('/api', tradingPaperRoutes);
app.use('/api', backTestRoute);
app.use('/api', backTestRouter);

// WS spojenie: keď sa klient pripojí, čakáme na správu so spustením backtestu
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'startBacktest') {

        // Extrahujeme hodnoty od klienta
        const { symbol, hoursToBacktest, fromDate, toDate } = msg;
        
        // Konvertujeme ISO stringy na timestampy, ak sú zadané
        let fromTime = (fromDate && fromDate.trim() !== '')
          ? new Date(fromDate).getTime()
          : undefined;
        let toTime = (toDate && toDate.trim() !== '')
          ? new Date(toDate).getTime()
          : undefined;
          
        // Ošetrenie prípadných NaN hodnôt
        if (isNaN(fromTime)) fromTime = undefined;
        if (isNaN(toTime)) toTime = undefined;
        
        console.log("WS Backtest – from:", fromTime, "to:", toTime);

        // Načítame dáta pre backtest použitím pôvodnej funkcie
        const data = await loadTimeframesForBacktest(symbol, fromTime, toTime);
        const dailyData = filterInRange(data.ohlcvDailyAll, toTime);
        const weeklyData = filterInRange(data.ohlcvWeeklyAll, toTime);
        const hourData = filterInRange(data.ohlcv1hAll, toTime);
        const min15Data = filterInRange(data.ohlcv15mAll, toTime);
        const min5Data = filterInRange(data.ohlcv5mAll, toTime);
        const min1Data = filterInRange(data.ohlcv1mAll, toTime);

        // Ak nie je zadaný fromTime, nastavíme ho na prvý timestamp z hodinových dát
        if (!fromTime && hourData.length > 0) {
          fromTime = hourData[0][0];
        }

        // Spustíme backtest – výsledky sa budú priebežne odosielať cez WebSocket pomocou ws.send
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
      console.error("Error parsing WebSocket message:", e);
    }
  });
});

// Spustíme server—inštancia HTTP servera (server) musí byť spustená namiesto app.listen,
// aby WebSocket aj HTTP používali ten istý port.
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});