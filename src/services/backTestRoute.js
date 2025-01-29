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
    
    // Change this to however many hours you want to go back.
    const hoursToBacktest = 250;

    // 1) Load data
    const { ohlcvDaily, ohlcv1h, ohlcv15m } = await loadAllTimeframes(symbol);
    
    const totalHourly = ohlcv1h.length;
    // We need at least 97 hourly candles to do a 96-hour simulation 
    // (because we open at cIndex and close at cIndex+1).
    if (totalHourly < hoursToBacktest + 1) {
      throw new Error(`Not enough hourly data for a ${hoursToBacktest}-hour backtest. We only have ${totalHourly} candles.`);
    }

    // 2) Sekvenčne voláme GPT pre každý krok backtestu:
    const results = [];
    for (let i = 0; i < hoursToBacktest; i++) {
      const cIndex = totalHourly - (hoursToBacktest + 1) + i;
      if (cIndex + 1 >= totalHourly) {
        break;
      }

      // Prepare slices for GPT, so we do not look into future data
      const hourDataSlice = ohlcv1h.slice(0, cIndex + 1);
      const min15Slice    = ohlcv15m.slice(0, cIndex * 4 + 1);
      const lastHourTimestamp = hourDataSlice[hourDataSlice.length - 1][0];
      const dailyDataSlice    = ohlcvDaily.filter(d => d[0] <= lastHourTimestamp);

      // Run GPT offline analysis (sekvenčne, s await)
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const finalAction = analysis.gptOutput.final_action || 'HOLD';

      // Compute PnL by opening at cIndex, closing at cIndex+1 
      const openPrice  = hourDataSlice[hourDataSlice.length - 1][4];  
      const closePrice = ohlcv1h[cIndex + 1][4];
      let tradePnL = 0;
      if (finalAction === 'BUY') {
        tradePnL = closePrice - openPrice;
      } else if (finalAction === 'SELL') {
        tradePnL = openPrice - closePrice;
      }

      results.push({ i, cIndex, finalAction, openPrice, closePrice, tradePnL });
    }

    // 3) Summarize PnL
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
    console.error('Error in 96h offline simulation:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;