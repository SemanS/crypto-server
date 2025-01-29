const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const {
  analyzeSymbolRobustChainingApproachOffline
} = require('./analyzeSymbolRobustChainingApproachOffline');

async function loadAllTimeframes(symbol) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const ohlcvDaily = await exchange.fetchOHLCV(symbol, '1d', undefined, 200);
  const ohlcv1h    = await exchange.fetchOHLCV(symbol, '1h', undefined, 300);
  const ohlcv15m   = await exchange.fetchOHLCV(symbol, '15m', undefined, 300);
  return { ohlcvDaily, ohlcv1h, ohlcv15m };
}

router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'OG/USDT';

    // 1) Načítame dáta
    const { ohlcvDaily, ohlcv1h, ohlcv15m } = await loadAllTimeframes(symbol);
    
    const totalHourly = ohlcv1h.length;
    if (totalHourly < 25) {
      throw new Error('Nemáme dosť hodinových dát na simuláciu 24h.');
    }

    // 2) Naberieme si "tasky" do poľa (každá hodinová analýza zvlášť)
    const tasks = [];
    for (let i = 0; i < 24; i++) {
      const cIndex = totalHourly - 25 + i;
      // Skontrolujeme, či ideme otvoriť a zatvoriť ešte v rozmedzí
      if (cIndex + 1 >= totalHourly) {
        break;
      }

      // Každý i spracujeme v paralelnom Promise
      tasks.push(
        (async () => {
          // Tu si pripravíme slice-y pre GPT, 
          // aby sme náhodou nesiahali do "budúcich" dát:
          const hourDataSlice = ohlcv1h.slice(0, cIndex + 1);
          const min15Slice = ohlcv15m.slice(0, cIndex * 4 + 1);

          const lastHourTimestamp = hourDataSlice[hourDataSlice.length - 1][0];
          const dailyDataSlice = ohlcvDaily.filter(d => d[0] <= lastHourTimestamp);

          // Spustíme GPT analýzu
          const analysis = await analyzeSymbolRobustChainingApproachOffline(
            symbol,
            dailyDataSlice,
            min15Slice,
            hourDataSlice
          );
          const finalAction = analysis.gptOutput.final_action || 'HOLD';

          // Na výpočet PnL budeme otvárať a zatvárať o 1 hodinu neskôr
          const openPrice = hourDataSlice[hourDataSlice.length - 1][4];  
          const closePrice = ohlcv1h[cIndex + 1][4];
          let tradePnL = 0;
          if (finalAction === 'BUY') {
            tradePnL = closePrice - openPrice;
          } else if (finalAction === 'SELL') {
            tradePnL = openPrice - closePrice;
          }

          // Vrátime dáta, čo potrebujeme na finálnu rekapituláciu
          return {
            i,
            cIndex,
            finalAction,
            openPrice,
            closePrice,
            tradePnL
          };
        })()
      );
    }

    // 3) Počkáme, kým všetky GPT dopyty skončia
    const results = await Promise.all(tasks);

    // 4) Následne spočítame sumárny PnL a zalogujeme
    let summaryPnL = 0;
    for (const r of results) {
      summaryPnL += r.tradePnL;
      console.log(
        `Hour #${r.i + 1}, Index=${r.cIndex} => 
         Action=${r.finalAction}, open=${r.openPrice}, close=${r.closePrice}, 
         tradePnL=${r.tradePnL.toFixed(4)}, summaryPnL=${summaryPnL.toFixed(4)}`
      );
    }

    console.log('Final PnL =', summaryPnL);
    return res.json({
      success: true,
      finalPnL: summaryPnL
    });
  } catch (err) {
    console.error('Chyba pri 24h simulácii offline:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;