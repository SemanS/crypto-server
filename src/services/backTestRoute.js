const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const {
  analyzeSymbolRobustChainingApproachOffline
} = require('./analyzeSymbolRobustChainingApproachOffline');

// Pomocná funkcia na načítanie OHLCV z binance.
async function loadAllTimeframes(symbol) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  
  // Pre daily, hourly, 15m – zoberieme radšej “viac” záznamov, 
  // aby mali indikátory dostatok dát
  const ohlcvDaily = await exchange.fetchOHLCV(symbol, '1d', undefined, 200);
  const ohlcv1h    = await exchange.fetchOHLCV(symbol, '1h', undefined, 300);
  const ohlcv15m   = await exchange.fetchOHLCV(symbol, '15m', undefined, 300);
  
  return { ohlcvDaily, ohlcv1h, ohlcv15m };
}

// Nový endpoint pre 24h backtest
router.get('/backTest', async (req, res) => {
  try {
    // 1) Načítame symbol (default "OG/USDT")
    const symbol = req.query.symbol || 'ACH/USDT';

    // 2) Natiahneme dáta z ccxt
    const { ohlcvDaily, ohlcv1h, ohlcv15m } = await loadAllTimeframes(symbol);

    // Budeme rátať priebežný PnL
    let summaryPnL = 0;

    const notional = 1;

    // Pre test: posledných 24 hodinových sviečok
    const totalHourly = ohlcv1h.length; 
    if (totalHourly < 25) {
      throw new Error('Nemáme dosť hodinových dát na simuláciu 24h.');
    }
    
    // Prejdeme posledných 24 hodín (i=0 => 24 hodín dozadu, i=23 => 1 hodina dozadu)
    for (let i = 0; i < 24; i++) {
      const cIndex = totalHourly - 25 + i; 
      
      // Ak budeme otvárať a zatvárať za 1 hodinu, musíme mať cIndex+1
      if (cIndex + 1 >= totalHourly) {
        // už nie je kam “zatvoriť”
        break;
      }

      // Príprava vstupov pre analyzeSymbolRobustChainingApproachOffline
      //const dailyDataSlice = ohlcvDaily; // Jednoducho celé daily
      const hourDataSlice = ohlcv1h.slice(0, cIndex + 1);
      // Predpoklad 4x 15m za 1h:
      const min15Slice = ohlcv15m.slice(0, cIndex * 4 + 1);
      
      const lastHourTimestamp = hourDataSlice[hourDataSlice.length - 1][0];
      const dailyDataSlice = ohlcvDaily.filter(d => d[0] <= lastHourTimestamp);
      // 3) Spustíme offline GPT analýzu
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const finalAction = analysis.gptOutput.final_action || 'HOLD';

      // 4) Definujeme ceny (otvoríme a zatvoríme pozíciu)
      const openPrice = hourDataSlice[hourDataSlice.length - 1][4];  // close cIndex sviečky
      const closePrice = ohlcv1h[cIndex + 1][4];                     // close cIndex+1 sviečky

      let tradePnL = 0;
      if (finalAction === 'BUY') {
        // BUY teraz – predáme o 1 hodinu neskôr
        tradePnL = (closePrice - openPrice) * notional;
      } else if (finalAction === 'SELL') {
        // SELL teraz – kúpime spät o 1 hodinu neskôr
        tradePnL = (openPrice - closePrice) * notional;
      } 
      // Ak je HOLD, tradePnL = 0
      
      summaryPnL += tradePnL;

      // 5) Logovanie (po každej hodine)
      // Môžete zobraziť aj reálny dátum/hodinu, tu zobrazíme index a relevantné čísla
      console.log(`Hour #${i+1}, Index=${cIndex} => Action=${finalAction}, open=${openPrice}, close=${closePrice}, tradePnL=${tradePnL.toFixed(4)}, summaryPnL=${summaryPnL.toFixed(4)}`);
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