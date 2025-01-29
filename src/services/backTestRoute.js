const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');

// Tu importujete svoju GPT analýzu:
const { analyzeSymbolRobustChainingApproachOffline } = require('./analyzeSymbolRobustChainingApproachOffline');

// Pomocné funkcie na logy a timeframe
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

  // Odstránime prípadné (timestamp > finalTS)
  const filtered = allOhlcv.filter(c => c[0] <= finalTS);
  console.log(`[LOG] fetchOHLCVInChunks DONE => totalCandles=${filtered.length}, fromTS=${tsToISO(fromTS)}, toTS=${tsToISO(toTS)}`);
  if (filtered.length > 0) {
    console.log(`[LOG]   firstCandle=${tsToISO(filtered[0][0])}, lastCandle=${tsToISO(filtered[filtered.length - 1][0])}`);
  }
  return filtered;
}

/**
 * loadTimeframesForBacktest:
 *   1) daily s bufferom 60 dní
 *   2) 1h a 15m od fromTime..toTime
 */
async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit    = 1000;

  // 60-dňový buffer pre daily
  const dailyBufferMs = 60 * 24 * 60 * 60 * 1000;
  let fromTimeDaily   = 0;
  if (fromTime) {
    fromTimeDaily = fromTime - dailyBufferMs;
    if (fromTimeDaily < 0) fromTimeDaily = 0;
  }

  console.log(`[LOG] loadTimeframesForBacktest => symbol=${symbol}, fromTime=${tsToISO(fromTime)}, toTime=${tsToISO(toTime)}`);
  console.log(`[LOG] dailyBuffer => fromTimeDaily=${tsToISO(fromTimeDaily)}`);

  const ohlcvDailyAll = await fetchOHLCVInChunks(exchange, symbol, '1d',  fromTimeDaily, toTime, limit);
  const ohlcv1hAll    = await fetchOHLCVInChunks(exchange, symbol, '1h',  fromTime || 0, toTime, limit);
  const ohlcv15mAll   = await fetchOHLCVInChunks(exchange, symbol, '15m', fromTime || 0, toTime, limit);

  console.log(`[LOG] => ohlcvDailyAll.length=${ohlcvDailyAll.length}, ohlcv1hAll.length=${ohlcv1hAll.length}, ohlcv15mAll.length=${ohlcv15mAll.length}`);
  return { ohlcvDailyAll, ohlcv1hAll, ohlcv15mAll };
}

// --------------------------
// GET /backTest
// --------------------------
router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'OG/USDT';

    let fromTime = req.query.fromDate ? (new Date(req.query.fromDate)).getTime() : undefined;
    let toTime   = req.query.toDate   ? (new Date(req.query.toDate)).getTime()   : undefined;
    if (isNaN(fromTime)) fromTime = undefined;
    if (isNaN(toTime))   toTime   = undefined;

    const hoursToBacktest = parseInt(req.query.hoursToBacktest || '12');

    // 1) Načítame daily( s bufferom ), 1h, 15m
    const { 
      ohlcvDailyAll,
      ohlcv1hAll,
      ohlcv15mAll
    } = await loadTimeframesForBacktest(symbol, fromTime, toTime);

    // 2) Odfiltrujeme 1h, 15m tak, aby boli len v [fromTime..toTime]
    let hourDataBacktest = ohlcv1hAll;
    if (fromTime) {
      hourDataBacktest = hourDataBacktest.filter(c => c[0] >= fromTime);
    }
    if (toTime) {
      hourDataBacktest = hourDataBacktest.filter(c => c[0] <= toTime);
    }

    let min15DataBacktest = ohlcv15mAll;
    if (fromTime) {
      min15DataBacktest = min15DataBacktest.filter(c => c[0] >= fromTime);
    }
    if (toTime) {
      min15DataBacktest = min15DataBacktest.filter(c => c[0] <= toTime);
    }

    const totalHourly = hourDataBacktest.length;
    console.log(`[LOG] totalHourly(after filter)=${totalHourly}, hoursToBacktest=${hoursToBacktest}`);
    if (totalHourly < hoursToBacktest + 1) {
      throw new Error(`Not enough hourly data => we have ${totalHourly}, needed >= ${hoursToBacktest+1}.`);
    }

    console.log(`Hourly range size: ${totalHourly} [${tsToISO(fromTime || 0)}..${tsToISO(toTime || Date.now())}]`);
    console.log(`Daily fetched (with buffer): ${ohlcvDailyAll.length} candle(s).`);

    // 3) Backtest
    let runningPnL = 0; // TOTO je kumulatívna premená
    const results  = [];

    for (let i = 0; i < hoursToBacktest; i++) {
      const cIndex = totalHourly - (hoursToBacktest + 1) + i;
      if (cIndex + 1 >= totalHourly) break;

      const hourDataSlice = hourDataBacktest.slice(0, cIndex + 1);
      const min15Slice    = min15DataBacktest.slice(0, cIndex * 4 + 1);
      const lastHourTS    = hourDataSlice[hourDataSlice.length - 1][0];

      console.log(`[LOG] iteration#${i}, cIndex=${cIndex}, lastHourTS=${tsToISO(lastHourTS)}`);

      // daily: <= lastHourTS a bez "nedokončenej" daily
      const dailyAll = ohlcvDailyAll.filter(d => d[0] <= lastHourTS);
      const ONE_DAY_MS = 24*60*60*1000;
      const dailyDataSlice = dailyAll.filter(c => lastHourTS >= c[0] + ONE_DAY_MS);

      console.log(`[LOG]   dailyDataSlice.length=${dailyDataSlice.length}`);
      if (dailyDataSlice.length < 2) {
        throw new Error(`Iteration #${i}: Not enough daily data => only ${dailyDataSlice.length}`);
      }

      // GPT analýza
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const synergy = analysis.gptOutput || {};
      console.log(`[LOG] synergyParsed =>`, synergy);

      // Ak GPT povie SELL => reálne SELL
      let finalAction = synergy.final_action || 'HOLD';

      // 4) PnL => v percentách voči openPrice (ukážka)
      const nextCandle = hourDataBacktest[cIndex + 1];
      const openPrice  = nextCandle[1];
      const highPrice  = nextCandle[2];
      const lowPrice   = nextCandle[3];
      const closePrice = nextCandle[4];

      // Čiarkový vs. bodkový formát atď. => V kóde je to reálne číslo
      let tradePnL = 0; // tentokrát len percentuálny
      if (finalAction==='BUY') {
        const percentMove = ((closePrice - openPrice) / openPrice) * 100;
        tradePnL = percentMove;
      }
      else if (finalAction==='SELL') {
        // Sell => short => ak close < open => +zisk, iné => -zisk
        const percentMove = ((openPrice - closePrice) / openPrice) * 100;
        tradePnL = percentMove;
      }
      else {
        tradePnL = 0; // HOLD
      }

      runningPnL += tradePnL;

      console.log(`[LOG]   finalActionUsed=${finalAction}, open=${openPrice.toFixed(3)}, close=${closePrice.toFixed(3)}, tradePnLPercent=${tradePnL.toFixed(3)}%, runningPnL=${runningPnL.toFixed(3)}%`);

      results.push({
        iteration: i,
        cIndex,
        finalAction,
        openPrice,
        closePrice,
        tradePnLPercent: tradePnL,
        runningPnLPercent: runningPnL
      });
    }

    console.log('[LOG] Final PnL(%)=', runningPnL.toFixed(3));
    return res.json({
      success: true,
      finalPnLPercent: runningPnL,
      detail: results
    });

  } catch(err) {
    console.error('[ERROR in /backTest]', err);
    return res.status(500).json({ success:false, error: err.message });
  }
});

module.exports = router;
