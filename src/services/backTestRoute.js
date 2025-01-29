const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const {
  analyzeSymbolRobustChainingApproachOffline
} = require('./analyzeSymbolRobustChainingApproachOffline');

// Helper for loading OHLCV from Binance
async function loadAllTimeframes(symbol) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  
  // Fetch daily, hourly, 15m data (200-300 candles for each)
  const ohlcvDaily = await exchange.fetchOHLCV(symbol, '1d', undefined, 200);
  const ohlcv1h    = await exchange.fetchOHLCV(symbol, '1h', undefined, 300);
  const ohlcv15m   = await exchange.fetchOHLCV(symbol, '15m', undefined, 300);

  return { ohlcvDaily, ohlcv1h, ohlcv15m };
}

router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'OG/USDT';
    // Nastavenie počtu hodín, ktoré chceme spätne testovať
    const hoursToBacktest = 12;

    // 1) Načítame dáta
    const { ohlcvDaily, ohlcv1h, ohlcv15m } = await loadAllTimeframes(symbol);
    
    const totalHourly = ohlcv1h.length;
    // Kontrola, či máme dosť hourly dát
    if (totalHourly < hoursToBacktest + 1) {
      throw new Error(
        `Not enough hourly data for a ${hoursToBacktest}-hour backtest. We only have ${totalHourly} candles.`
      );
    }

    // 2) Sekvenčne voláme GPT pre každý krok backtestu
    const results = [];
    for (let i = 0; i < hoursToBacktest; i++) {
      // cIndex reprezentuje index "aktuálnej" hodinovej sviečky (ktorú uzatvárame)
      const cIndex = totalHourly - (hoursToBacktest + 1) + i;

      // Ak nemáme k dispozícii nasledujúcu sviečku (cIndex+1), končíme
      if (cIndex + 1 >= totalHourly) {
        break;
      }

      // 2a) Pripravíme slice tak, aby GPT nevidelo budúcnosť
      const hourDataSlice = ohlcv1h.slice(0, cIndex + 1); // až po close cIndex
      const min15Slice    = ohlcv15m.slice(0, cIndex * 4 + 1);
      const lastHourTimestamp = hourDataSlice[hourDataSlice.length - 1][0];
      const dailyDataSlice    = ohlcvDaily.filter(d => d[0] <= lastHourTimestamp);

      // 2b) Spustíme analýzu s GPT (sekvenčne)
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const finalAction = analysis.gptOutput.final_action || 'HOLD';

      // 3) Výpočet PnL podľa prístupu:
      //    Signál vzniká na close cIndex (to GPT pozná),
      //    obchod otvoríme na open cIndex+1,
      //    obchod zatvoríme na close cIndex+1 (držím 1 hodinu).
      //
      //    Layout OHLCV je typicky [timestamp, open, high, low, close, volume]
      const openPrice  = ohlcv1h[cIndex + 1][1]; // open nasledujúcej sviečky
      const closePrice = ohlcv1h[cIndex + 1][4]; // close nasledujúcej sviečky

      let tradePnL = 0;
      if (finalAction === 'BUY') {
        tradePnL = closePrice - openPrice;
      } else if (finalAction === 'SELL') {
        tradePnL = openPrice - closePrice;
      } 
      // (Ak je "HOLD", tak tradePnL = 0)

      // Uložíme výsledok danej iterácie
      results.push({ 
        i, 
        cIndex, 
        finalAction, 
        openPrice, 
        closePrice, 
        tradePnL 
      });
    }

    // 4) Sumár PnL
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
    console.error('Error in simulation:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;