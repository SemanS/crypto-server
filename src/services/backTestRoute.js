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
    case '30m':  return 30 * 60 * 1000;
    case '1h':   return 60 * 60 * 1000;
    case '4h':   return 4  * 60 * 60 * 1000;
    case '1d':   return 24 * 60 * 60 * 1000;
    case '1w':   return 7  * 24 * 60 * 60 * 1000;
    default:     return 24 * 60 * 60 * 1000;
  }
}

/**
 * Nájde closePrice v 1-min candle, ktorá obsahuje targetTime.
 * Ak nenájde, vráti null.
 * Candle formát: [ts, open, high, low, close, volume], kde ts je začiatok 1m.
 * targetTime ∈ [ts, ts+1min)
 */
function find1mClosePriceAtTime(min1Candles, targetTime) {
  for (let i = 0; i < min1Candles.length; i++) {
    const cStart = min1Candles[i][0];
    const cEnd   = cStart + timeframeToMs('1m');
    if (cStart <= targetTime && targetTime < cEnd) {
      return min1Candles[i][4]; // close
    }
  }
  return null;
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

  // NOVÉ: stiahneme si aj 1m dáta
  const ohlcv1mAll     = await fetchOHLCVInChunks(exchange, symbol, '1m', fromTimeWithBuffer, toTime, limit);

  console.log(`[LOG] => daily=${ohlcvDailyAll.length}, weekly=${ohlcvWeeklyAll.length}, 1h=${ohlcv1hAll.length}, 15m=${ohlcv15mAll.length}, 1m=${ohlcv1mAll.length}`);
  return { ohlcvDailyAll, ohlcvWeeklyAll, ohlcv1hAll, ohlcv15mAll, ohlcv1mAll };
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

    // 1) Načítame všetky časové rámce (s warm-up)
    const {
      ohlcvDailyAll,
      ohlcvWeeklyAll,
      ohlcv1hAll,
      ohlcv15mAll,
      ohlcv1mAll
    } = await loadTimeframesForBacktest(symbol, fromTime, toTime);

    // 2) Prípadné orezanie dát po toTime
    function filterInRange(data) {
      if (!toTime) return data;
      return data.filter(c => c[0] <= toTime);
    }
    const dailyDataBacktest  = filterInRange(ohlcvDailyAll);
    const weeklyDataBacktest = filterInRange(ohlcvWeeklyAll);
    const hourDataBacktest   = filterInRange(ohlcv1hAll);
    const min15DataBacktest  = filterInRange(ohlcv15mAll);
    const min1DataBacktest   = filterInRange(ohlcv1mAll);

    // 3) Zistíme fromIndex, prvú hour-sviečku >= fromTime
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
    const stopLossThreshold = 0.95; // -5%

    // 4) Spustíme backtest po jednotlivých hodinách
    for (let i = 0; i < hoursToBacktest; i++) {
      const cIndex = fromIndex + i;
      const hourCandle = hourDataBacktest[cIndex];
      if (!hourCandle) break;

      const lastHourTS = hourCandle[0]; // začiatok hour sviečky
      console.log(`[LOG] iteration=${i}, cIndex=${cIndex}, lastHourTS=${tsToISO(lastHourTS)}`);

      // hourDataSlice: všetky Hour sviečky do cIndex
      const hourDataSlice = hourDataBacktest.slice(0, cIndex + 1);
      // min15Slice <= lastHourTS
      const min15Slice    = min15DataBacktest.filter(m => m[0] + timeframeToMs('15m') <= lastHourTS);

      // daily + weekly => berieme tie, čo skončili pred lastHourTS
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

      // 4B) Cena otvorenia => 1h candle končí v openTime
      const openTime = lastHourTS + timeframeToMs('1h');
      const openPrice = find1mClosePriceAtTime(min1DataBacktest, openTime);
      if (openPrice === null) {
        console.log(`[LOG]   No 1m candle found for openTime=${tsToISO(openTime)} => break`);
        break;
      }

      // 4C) Uzavretie (s kontrolou stop-lossu -5%)
      let closePrice;
      const closeTime = openTime + timeframeToMs('1h');

      if (finalAction === 'HOLD') {
        // neotvárame žiadny obchod => PnL = 0
        closePrice = openPrice;
      } else {
        // BUY alebo SELL => skontrolujeme 1m sviečky
        let tradeClosed = false;
        let lastSeenPrice = openPrice;

        // Pre BUY: ak cena klesne o 5% => stopLossPrice = 0.95 * openPrice
        // Pre SELL: ak cena stúpne o 5% => stopLossPrice = openPrice / 0.95
        const stopLossPrice = (finalAction === 'BUY')
          ? openPrice * stopLossThreshold
          : openPrice / stopLossThreshold;

        // 1m sviečky v rozmedzí [openTime, closeTime)
        const oneMinCandlesInHour = min1DataBacktest
          .filter(c => c[0] >= openTime && c[0] < closeTime)
          .sort((a, b) => a[0] - b[0]);

        for (const c of oneMinCandlesInHour) {
          // c: [ ts, open, high, low, close, volume ]
          const candleLow  = c[3];
          const candleHigh = c[2];
          const candleClose= c[4];
          lastSeenPrice    = candleClose;

          if (finalAction === 'BUY') {
            // ak minima <= stopLossPrice => triggered
            if (candleLow <= stopLossPrice) {
              closePrice = stopLossPrice;
              tradeClosed = true;
              break;
            }
          } else {
            // SELL => ak maxima >= stopLossPrice => triggered
            if (candleHigh >= stopLossPrice) {
              closePrice = stopLossPrice;
              tradeClosed = true;
              break;
            }
          }
        }

        if (!tradeClosed) {
          // Stoploss sa nespustil => zatvoríme na konci hodiny
          closePrice = find1mClosePriceAtTime(min1DataBacktest, closeTime);
          if (closePrice === null) {
            console.log(`[LOG]   No 1m candle found for closeTime=${tsToISO(closeTime)} => break`);
            break;
          }
        }
      }

      // 4D) Výpočet PnL
      let tradePnL = 0;
      if (finalAction === 'BUY') {
        tradePnL = ((closePrice - openPrice) / openPrice) * 100;
      } else if (finalAction === 'SELL') {
        tradePnL = ((openPrice - closePrice) / openPrice) * 100;
      } // HOLD => 0

      runningPnL += tradePnL;
      console.log(`[LOG]   finalAction=${finalAction}, open=${openPrice}, close=${closePrice}, tradePnL=${tradePnL.toFixed(3)}%, runningPnL=${runningPnL.toFixed(3)}%`);

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