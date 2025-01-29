const express = require('express');
const router = express.Router();

// ccxt a technicalindicators
const ccxt = require('ccxt');
const { RSI } = require('technicalindicators');

/**
 * 1) Funkcia na načítanie historických dát (bezprostredne tu len pre 1h).
 */
async function loadHistoricalData(symbol) {
  const exchange = new ccxt.binance({ enableRateLimit: true });

  // Napríklad načítame 300 hodinových sviečok.
  const limitH = 300;
  const now = Date.now();
  const sinceH = now - limitH * 60 * 60 * 1000;

  // 1h dáta
  const ohlcv1h = await exchange.fetchOHLCV(symbol, '1h', sinceH, limitH);

  // Ak chcete, môžete pridať fetch pre 15m, 1d, ...
  // a vrátiť z nich taktiež dáta:
  //const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', since15m, limit15m);
  //const ohlcv1d  = await exchange.fetchOHLCV(symbol, '1d',  since1d,  limit1d);

  return {
    ohlcv1h,
    //ohlcv15m,
    //ohlcv1d
  };
}

/**
 * 2) Jednoduchá funkcia, ktorá z oseknutých dát spočíta RSI(14) a vráti BUY/SELL/HOLD.
 */
function getIndicatorSignal(ohlcvSlice) {
  const closes = ohlcvSlice.map(c => c[4]);
  if (closes.length < 14) {
    return 'HOLD'; // Nedostatok dát
  }
  
  // Spočítaj RSI(14) z uzatváracích cien
  const rsiData = RSI.calculate({ values: closes, period: 14 });
  const lastRsi = rsiData[rsiData.length - 1];

  // Ak nedostaneme RSI, vrátime HOLD
  if (!lastRsi) return 'HOLD';

  // Jednoduchá podmienka
  if (lastRsi < 30) return 'BUY';
  if (lastRsi > 70) return 'SELL';
  return 'HOLD';
}

/**
 * 3) Hlavná funkcia backtestu:
 *    - Natiahne historické dáta
 *    - Prejde ich a simuluje jednoduchú stratégiu na základe RSI signálu
 */
async function backtest() {
  const symbol = 'HOT/USDT';

  // 1. Načítame si historické dáta (1h timeframe)
  const { ohlcv1h } = await loadHistoricalData(symbol);

  // Základné premenné pre stratégiu
  let summaryPnL = 0;
  const notional = 100000;   // napr. obchodujeme 100k kusov HOT
  let position = 0;          // 1 = long, -1 = short, 0 = žiadna pozícia
  let entryPrice = 0;        // Pamätáme si cenu vstupu

  // 2. Prejdeme každú sviečku od 14 až do poslednej - 1
  //    (aby sme mali pri indexe i aspoň 14 min. dát na výpočet RSI)
  for (let i = 14; i < ohlcv1h.length - 1; i++) {
    // Osekneme dáta do indexu i (tým sa vyhneme "look-ahead" biasu)
    const pastData = ohlcv1h.slice(0, i + 1);

    // Vypočítame signál z týchto starých dát
    const signal = getIndicatorSignal(pastData);

    // Zoberieme close cenu poslednej sviečky v pastData,
    // ktorá zodpovedá "aktuálnej" hodine i
    const closePrice = pastData[pastData.length - 1][4];

    // 3. Uzavrieme opačnú pozíciu, ak signál zmenil smer
    if (position === 1 && signal === 'SELL') {
      // Uzavrieme long => PnL = (close - entry) * notional
      const tradePnL = (closePrice - entryPrice) * notional;
      summaryPnL += tradePnL;
      position = 0;
      entryPrice = 0;
    } else if (position === -1 && signal === 'BUY') {
      // Uzavrieme short => PnL = (entry - close) * notional
      const tradePnL = (entryPrice - closePrice) * notional;
      summaryPnL += tradePnL;
      position = 0;
      entryPrice = 0;
    }

    // 4. Otvoríme novú pozíciu, ak sme bez pozície a signál hovorí BUY/SELL
    if (position === 0) {
      if (signal === 'BUY') {
        position = 1;
        entryPrice = closePrice;
      } else if (signal === 'SELL') {
        position = -1;
        entryPrice = closePrice;
      }
    }
  }

  // Ak ostane otvorená pozícia, môžete ju uzavrieť na poslednej cene
  // (voliteľné, vo vlastnej stratégii podľa pravidiel)
  // Nateraz to necháme tak.

  console.log(`Finálny PnL: ${summaryPnL.toFixed(4)} USDT`);
  return summaryPnL;
}

/**
 * 4) Route GET /backTest - spustí backtest a vráti JSON s výsledkom
 */
router.get('/backTest', async (req, res) => {
  try {
    const result = await backtest();
    return res.json({ 
      success: true, 
      finalPnL: Number(result.toFixed(4)) 
    });
  } catch (error) {
    console.error('[backTest] Chyba pri backteste:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;