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
 * fetchOHLCVInChunks:
 *   Sťahuje OHLCV po "limit" candle v cykle, až kým nedosiahneme toTime alebo kým burza neprestane vracať dáta.
 */
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
 * Tu je podstatný trik – ak príde fromTime (prvý deň simulácie),
 * znížime ho o 60 dní a takto fetchneme dáta. Tých 60 dní nám
 * slúži ako warm-up, aby indikátory neboli "undefined" hneď
 * pri fromTime. Avšak reálne simulovanie začína až v /backTest kóde od fromTime.
 */
async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit    = 1000;

  // 60-dňový buffer pre daily / weekly / 1h / 15m
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

  // Ak fromTime nie je definované, tak fetchujeme od nuly. 
  // Inak fetchujeme od (fromTime - 60 dní).
  const fromTimeWithBuffer = fromTime
    ? Math.max(0, fromTime - SIXTY_DAYS_MS)
    : 0;

  console.log(`[LOG] loadTimeframesForBacktest => symbol=${symbol}, fromTime=${tsToISO(fromTime)}, toTime=${tsToISO(toTime)}`);
  console.log(`[LOG] using fromTimeWithBuffer=${tsToISO(fromTimeWithBuffer)} (warm-up 60d)`);

  const ohlcvDailyAll  = await fetchOHLCVInChunks(exchange, symbol, '1d',  fromTimeWithBuffer,  toTime, limit);
  const ohlcvWeeklyAll = await fetchOHLCVInChunks(exchange, symbol, '1w',  fromTimeWithBuffer,  toTime, limit);
  const ohlcv1hAll     = await fetchOHLCVInChunks(exchange, symbol, '1h',  fromTimeWithBuffer,  toTime, limit);
  const ohlcv15mAll    = await fetchOHLCVInChunks(exchange, symbol, '15m', fromTimeWithBuffer,  toTime, limit);

  console.log(`[LOG] => daily=${ohlcvDailyAll.length}, weekly=${ohlcvWeeklyAll.length}, 1h=${ohlcv1hAll.length}, 15m=${ohlcv15mAll.length}`);
  return { ohlcvDailyAll, ohlcvWeeklyAll, ohlcv1hAll, ohlcv15mAll };
}

// ------------------------------------------------------------------------
// Tu je /backTest end-point
// ------------------------------------------------------------------------
router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'OG/USDT';

    let fromTime = req.query.fromDate ? new Date(req.query.fromDate).getTime() : undefined;
    let toTime   = req.query.toDate   ? new Date(req.query.toDate).getTime()   : undefined;
    if (isNaN(fromTime)) fromTime = undefined;
    if (isNaN(toTime))   toTime   = undefined;

    const hoursToBacktest = parseInt(req.query.hoursToBacktest || '12');

    // 1) Načítame dáta (aj buffer)
    const {
      ohlcvDailyAll,
      ohlcvWeeklyAll,
      ohlcv1hAll,
      ohlcv15mAll
    } = await loadTimeframesForBacktest(symbol, fromTime, toTime);

    // 2) Zachováme celé dáta (vrátane bufferu) až po toTime
    function filterInRange(data) {
      let out = data;
      if (toTime) out = out.filter(c => c[0] <= toTime);
      return out;
    }
    const dailyDataBacktest  = filterInRange(ohlcvDailyAll);
    const weeklyDataBacktest = filterInRange(ohlcvWeeklyAll);
    const hourDataBacktest   = filterInRange(ohlcv1hAll);
    const min15DataBacktest  = filterInRange(ohlcv15mAll);

    // Skontrolujeme, či máme dosť hour-sviečok na hoursToBacktest
    const totalHourly = hourDataBacktest.length;
    console.log(`[LOG] totalHourly(after filter)=${totalHourly}, hoursToBacktest=${hoursToBacktest}`);
    if (totalHourly < hoursToBacktest + 1) {
      throw new Error(`Not enough hourly data => we have ${totalHourly}, needed >= ${hoursToBacktest + 1}.`);
    }

    // 3) Spustíme backtest: iterujeme od najstaršej sviečky (z backtest setu) po najnovšiu,
    //    ale v praxi sa posúvame len hoursToBacktest hodín smerom ku koncu.
    let runningPnL = 0;
    const results  = [];

    for (let i = 0; i < hoursToBacktest; i++) {
      // cIndex = index do hourDataBacktest, ktorý sa posúva smerom k poslednej sviečke
      const cIndex = totalHourly - (hoursToBacktest + 1) + i;
      if (cIndex + 1 >= totalHourly) break;

      // hourDataSlice = historické hour-dáta do tohto momentu (vrátane)
      const hourDataSlice = hourDataBacktest.slice(0, cIndex + 1);

      // min15Slice = historické 15m-dáta do tohto momentu
      // (hrubý príklad, 1h = 4 × 15m)
      const min15Slice = min15DataBacktest.slice(0, cIndex * 4 + 1);

      const lastHourTS = hourDataBacktest[cIndex][0];
      console.log(`[LOG] iteration#=${i}, cIndex=${cIndex}, lastHourTS=${tsToISO(lastHourTS)}`);

      // daily/weekly: vyberieme tie, ktoré majú timestamp <= lastHourTS
      const dailyAll  = dailyDataBacktest.filter(d => d[0] <= lastHourTS);
      const weeklyAll = weeklyDataBacktest.filter(w => w[0] <= lastHourTS);

      const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
      const ONE_WEEK_MS = 7  * ONE_DAY_MS;

      // Filtrujeme len tie daily/weekly, ktoré sú kompletne uzavreté do lastHourTS
      const dailyDataSlice  = dailyAll.filter(c => lastHourTS >= c[0] + ONE_DAY_MS);
      const weeklyDataSlice = weeklyAll.filter(c => lastHourTS >= c[0] + ONE_WEEK_MS);

      // 4) GPT analýza s 5 parametrami (daily, weekly, 15m, 1h)
      //    dôležité: do analyzy idú len tie dáta, ktoré reálne existovali do lastHourTS
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        weeklyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const synergy = analysis.gptOutput || {};

      // 5) Vypočítame hypotetický zisk alebo stratu
      const finalAction = synergy.final_action || 'HOLD';
      const nextCandle  = hourDataBacktest[cIndex + 1];
      const openPrice   = nextCandle[1];
      const closePrice  = nextCandle[4];

      let tradePnL = 0;
      if (finalAction === 'BUY') {
        tradePnL = ((closePrice - openPrice) / openPrice) * 100;
      } else if (finalAction === 'SELL') {
        tradePnL = ((openPrice - closePrice) / openPrice) * 100;
      }

      runningPnL += tradePnL;
      console.log(`[LOG]   finalAction=${finalAction}, open=${openPrice}, close=${closePrice}, tradePnL=${tradePnL.toFixed(3)}%, runningPnL=${runningPnL.toFixed(3)}%`);

      // Uložíme krok
      results.push({
        iteration: i,
        cIndex,
        lastHourTS,
        finalAction,
        openPrice,
        closePrice,
        tradePnLPercent: tradePnL,
        runningPnLPercent: runningPnL
      });
    }

    console.log('[LOG] Final PnL(%)=', runningPnL.toFixed(3));

    // 6) Vrátime výsledok
    return res.json({
      success: true,
      finalPnLPercent: runningPnL,
      detail: results
    });

  } catch (err) {
    console.error('[ERROR in /backTest]', err);
    return res.status(500).json({ success:false, error: err.message });
  }
});

module.exports = router;