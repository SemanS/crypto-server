const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const { analyzeSymbolRobustChainingApproachOffline } = require('./analyzeSymbolRobustChainingApproachOffline');

// Pomocné funkcie
function tsToISO(ts) {
  return new Date(ts).toISOString();
}

function timeframeToMs(timeframe) {
  switch (timeframe) {
    case '1m':   return 60 * 1000;
    case '5m':   return 5  * 60 * 1000;
    case '15m':  return 15 * 60 * 1000;
    case '30m':  return 30 * 60 * 60 * 1000;
    case '1h':   return 60 * 60 * 1000;
    case '4h':   return 4  * 60 * 60 * 1000;
    case '1d':   return 24 * 60 * 60 * 1000;
    case '1w':   return 7  * 24 * 60 * 60 * 1000;
    default:     return 24 * 60 * 60 * 1000;
  }
}

/**
 * Nájde closePrice v 15-min candle, ktorá obsahuje targetTime.
 * Ak nenájde, vráti null (znamená, že nemáme dáta pre uzavretie obchodu).
 * Candle formát: [ts, open, high, low, close, volume], kde ts je začiatok 15m.
 * targetTime ∈ [ts, ts+15min)
 */
function find15mClosePriceAtTime(min15Candles, targetTime) {
  for (let i = 0; i < min15Candles.length; i++) {
    const cStart = min15Candles[i][0];
    const cEnd   = cStart + timeframeToMs('15m');
    if (cStart <= targetTime && targetTime < cEnd) {
      return min15Candles[i][4]; // close
    }
  }
  return null; // nenašli sme candle pokrývajúcu targetTime
}

async function fetchOHLCVInChunks(exchange, symbol, timeframe, fromTS, toTS, limit = 1000) {
  let allOhlcv = [];
  let since    = fromTS;
  const finalTS= toTS || Date.now();

  console.log(`[LOG] fetchOHLCVInChunks => symbol=${symbol}, timeframe=${timeframe}, fromTS=${tsToISO(fromTS)}, toTS=${tsToISO(toTS)}`);

  while (true) {
    console.log(`[LOG]   Attempt fetch since=${tsToISO(since)}`);
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, limit);

    if (!batch || batch.length === 0) {
      console.log('[LOG]   Batch is empty => break');
      break;
    }
    console.log(`[LOG]   Got batch size=${batch.length}. firstTS=${tsToISO(batch[0][0])}, lastTS=${tsToISO(batch[batch.length - 1][0])}`);
    allOhlcv = allOhlcv.concat(batch);

    const lastTS = batch[batch.length - 1][0];
    if (lastTS >= finalTS) {
      console.log('[LOG]   lastTS >= finalTS => break');
      break;
    }
    if (batch.length < limit) {
      console.log('[LOG]   batch.length < limit => probably end of available data => break');
      break;
    }

    since = lastTS + timeframeToMs(timeframe);
    if (since > finalTS) {
      console.log('[LOG]   since > finalTS => break');
      break;
    }
  }

  const filtered = allOhlcv.filter(c => c[0] <= finalTS);
  console.log(`[LOG] fetchOHLCVInChunks DONE => totalCandles=${filtered.length}, fromTS=${tsToISO(fromTS)}, toTS=${tsToISO(toTS)}`);
  if (filtered.length > 0) {
    console.log(`[LOG]   firstCandle=${tsToISO(filtered[0][0])}, lastCandle=${tsToISO(filtered[filtered.length - 1][0])}`);
  }
  return filtered;
}

/**
 * loadTimeframesForBacktest:
 *  - Warm-up 60 dní pre indikátory
 */
async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit    = 1000;

  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  const fromTimeWithBuffer = fromTime
    ? Math.max(0, fromTime - SIXTY_DAYS_MS)
    : 0;

  console.log(`[LOG] loadTimeframesForBacktest => symbol=${symbol}, fromTime=${tsToISO(fromTime)}, toTime=${tsToISO(toTime)}`);
  console.log(`[LOG] using fromTimeWithBuffer=${tsToISO(fromTimeWithBuffer)} (warm-up 60d)`);

  const ohlcvDailyAll  = await fetchOHLCVInChunks(exchange, symbol, '1d',  fromTimeWithBuffer, toTime, limit);
  const ohlcvWeeklyAll = await fetchOHLCVInChunks(exchange, symbol, '1w',  fromTimeWithBuffer, toTime, limit);
  const ohlcv1hAll     = await fetchOHLCVInChunks(exchange, symbol, '1h',  fromTimeWithBuffer, toTime, limit);
  const ohlcv15mAll    = await fetchOHLCVInChunks(exchange, symbol, '15m', fromTimeWithBuffer, toTime, limit);

  console.log(`[LOG] => daily=${ohlcvDailyAll.length}, weekly=${ohlcvWeeklyAll.length}, 1h=${ohlcv1hAll.length}, 15m=${ohlcv15mAll.length}`);
  return { ohlcvDailyAll, ohlcvWeeklyAll, ohlcv1hAll, ohlcv15mAll };
}

// ------------------------------------------------------------------------
// /backTest endpoint
// ------------------------------------------------------------------------
router.get('/backTest', async (req, res) => {
  try {
    const symbol          = req.query.symbol || 'OG/USDT';
    let fromTime          = req.query.fromDate ? new Date(req.query.fromDate).getTime() : undefined;
    let toTime            = req.query.toDate   ? new Date(req.query.toDate).getTime()   : undefined;
    if (isNaN(fromTime))  fromTime = undefined;
    if (isNaN(toTime))    toTime   = undefined;

    // Koľko hodín chceme nasimulovať
    const hoursToBacktest = parseInt(req.query.hoursToBacktest || '12');

    // 1) Načítame (s warm-up bufferom)
    const {
      ohlcvDailyAll,
      ohlcvWeeklyAll,
      ohlcv1hAll,
      ohlcv15mAll
    } = await loadTimeframesForBacktest(symbol, fromTime, toTime);

    // 2) Zachováme dáta max po toTime
    function filterInRange(data) {
      let out = data;
      if (toTime) out = out.filter(c => c[0] <= toTime);
      return out;
    }
    const dailyDataBacktest  = filterInRange(ohlcvDailyAll);
    const weeklyDataBacktest = filterInRange(ohlcvWeeklyAll);
    const hourDataBacktest   = filterInRange(ohlcv1hAll);
    const min15DataBacktest  = filterInRange(ohlcv15mAll);

    // 3) Nájdeme index prvej hour-sviečky >= fromTime
    if (!fromTime && hourDataBacktest.length > 0) {
      fromTime = hourDataBacktest[0][0];
    }
    const fromIndex = hourDataBacktest.findIndex(c => c[0] >= fromTime);
    if (fromIndex === -1) {
      throw new Error(`No hour data found at or after fromTime=${tsToISO(fromTime)}`);
    }

    console.log(`[LOG] fromIndex=${fromIndex}, hourDataBacktest[fromIndex]=${tsToISO(hourDataBacktest[fromIndex][0])}`);

    let runningPnL = 0;
    const results  = [];

    // 4) Spustíme backtest po hodinách, počnúc fromIndex
    for (let i = 0; i < hoursToBacktest; i++) {
      const cIndex = fromIndex + i;
      const hourCandle = hourDataBacktest[cIndex];
      if (!hourCandle) break;

      const lastHourTS = hourCandle[0];   // start time hour candle
      const hourClose  = hourCandle[4];   // close tejto hour sviečky (end hour price)
      console.log(`[LOG] iteration=${i}, cIndex=${cIndex}, lastHourTS=${tsToISO(lastHourTS)}`);

      // hourDataSlice: celé hourly dáta do cIndex
      const hourDataSlice = hourDataBacktest.slice(0, cIndex + 1);
      // min15Slice: len tie 15m, ktoré sú <= lastHourTS
      const min15Slice    = min15DataBacktest.filter(m => m[0] + timeframeToMs('15m') <= lastHourTS);

      // daily/weekly data
      const dailyAll  = dailyDataBacktest.filter(d => d[0] <= lastHourTS);
      const weeklyAll = weeklyDataBacktest.filter(w => w[0] <= lastHourTS);

      const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
      const ONE_WEEK_MS = 7  * ONE_DAY_MS;

      const dailyDataSlice  = dailyAll.filter(c => lastHourTS >= c[0] + ONE_DAY_MS);
      const weeklyDataSlice = weeklyAll.filter(c => lastHourTS >= c[0] + ONE_WEEK_MS);

      // 4A) GPT analýza
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        weeklyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const synergy = analysis.gptOutput || {};
      const finalAction = synergy.final_action || 'HOLD';

      // 4B) Otvorenie obchodu (ak BUY/SELL) na konci tejto hour sviečky
      let openPrice  = hourClose;
      let openTime   = lastHourTS + timeframeToMs('1h'); 
        // hourCandle[0] je start, +1h je reálny koniec hour sviečky

      // 4C) Uzavretie presne o 1h neskôr (využijeme 15m data)
      const closeTime = openTime + timeframeToMs('1h');  
        // presne 1h od konca tejto hour sviečky
      const closePrice = (finalAction === 'HOLD')
        ? openPrice  // ak je HOLD, spravíme PnL=0, je to len pre formálnu hodnotu
        : find15mClosePriceAtTime(min15DataBacktest, closeTime);

      if (closePrice === null) {
        // Nenašli sme 15m candle, ktorá by pokrývala closeTime => nemáme dáta => koniec
        console.log(`[LOG]   No 15m candle found for closeTime=${tsToISO(closeTime)} => break`);
        break;
      }

      // 4D) Vypočítame hypotetické PnL
      let tradePnL = 0;
      if (finalAction === 'BUY') {
        tradePnL = ((closePrice - openPrice) / openPrice) * 100;
      } else if (finalAction === 'SELL') {
        tradePnL = ((openPrice - closePrice) / openPrice) * 100;
      } else {
        // HOLD => 0
      }

      runningPnL += tradePnL;
      console.log(`[LOG]   finalAction=${finalAction}, openTime=${tsToISO(openTime)}, closeTime=${tsToISO(closeTime)}, openPrice=${openPrice}, closePrice=${closePrice}, tradePnL=${tradePnL.toFixed(3)}%, runningPnL=${runningPnL.toFixed(3)}%`);

      results.push({
        iteration: i,
        cIndex,
        lastHourTS,
        openTime,
        closeTime,
        finalAction,
        openPrice,
        closePrice,
        tradePnLPercent: tradePnL,
        runningPnLPercent: runningPnL
      });
    }

    console.log('[LOG] Final PnL(%) =', runningPnL.toFixed(3));

    // 5) Výstup
    return res.json({
      success: true,
      finalPnLPercent: runningPnL,
      detail: results
    });

  } catch (err) {
    console.error('[ERROR in /backTest]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;