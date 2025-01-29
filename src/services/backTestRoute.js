const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const {
  analyzeSymbolRobustChainingApproachOffline
} = require('./analyzeSymbolRobustChainingApproachOffline');

/**
 * Na prehľadné logovanie timestamp do ISO formátu.
 */
function tsToISO(ts) {
  return new Date(ts).toISOString();
}

/**
 * Konverzia timeframe na milisekundy.
 */
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
 * Sťahovanie OHLCV v "dávkach" (limit = 1000) a spájanie, kým nedosiahneme toTime alebo koniec histórie.
 * Pridali sme logy, aby ste videli, čo CCXT vrátilo v jednotlivých chunk-och.
 */
async function fetchOHLCVInChunks(exchange, symbol, timeframe, fromTS, toTS, limit = 1000) {
  let allOhlcv = [];
  let since = fromTS;
  const finalTS = toTS || Date.now();

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
      console.log(`[LOG]   lastTS >= finalTS => break`);
      break;
    }
    if (batch.length < limit) {
      console.log(`[LOG]   batch.length < limit => probably end of available data => break`);
      break;
    }

    since = lastTS + timeframeToMs(timeframe);
    if (since > finalTS) {
      console.log(`[LOG]   since > finalTS => break`);
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
 *  - Pre daily berieme starší "fromTimeDaily" => fromTime - buffer (60 dní),
 *    aby GPT videlo staršie daily candle.
 *  - Pre 1h, 15m berieme len [fromTime..toTime].
 */
async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit    = 1000;

  const dailyBufferMs = 60 * 24 * 60 * 60 * 1000;
  let fromTimeDaily   = 0;
  if (fromTime) {
    fromTimeDaily = fromTime - dailyBufferMs;
    if (fromTimeDaily < 0) fromTimeDaily = 0;
  }

  console.log(`[LOG] loadTimeframesForBacktest => symbol=${symbol}, fromTime=${tsToISO(fromTime)}, toTime=${tsToISO(toTime)}`);
  console.log(`[LOG] dailyBuffer => fromTimeDaily=${tsToISO(fromTimeDaily)}`);

  // Stiahneme daily
  const ohlcvDailyAll = await fetchOHLCVInChunks(
    exchange,
    symbol,
    '1d',
    fromTimeDaily,
    toTime,
    limit
  );
  // Stiahneme 1h a 15m
  const ohlcv1hAll = await fetchOHLCVInChunks(
    exchange,
    symbol,
    '1h',
    fromTime || 0,
    toTime,
    limit
  );
  const ohlcv15mAll = await fetchOHLCVInChunks(
    exchange,
    symbol,
    '15m',
    fromTime || 0,
    toTime,
    limit
  );

  console.log(`[LOG] => ohlcvDailyAll.length=${ohlcvDailyAll.length}, ohlcv1hAll.length=${ohlcv1hAll.length}, ohlcv15mAll.length=${ohlcv15mAll.length}`);
  return {
    ohlcvDailyAll,
    ohlcv1hAll,
    ohlcv15mAll
  };
}


/**
 * GET /backTest => spustenie backtestu (príklad).
 */
router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'BTC/USDT';
    
    let fromTime = req.query.fromDate ? new Date(req.query.fromDate).getTime() : undefined;
    let toTime   = req.query.toDate   ? new Date(req.query.toDate).getTime()   : undefined;
    if (isNaN(fromTime)) fromTime = undefined;
    if (isNaN(toTime))   toTime   = undefined;

    const hoursToBacktest = req.query.hoursToBacktest
      ? parseInt(req.query.hoursToBacktest)
      : 24;

    // 1) Načítame históriu
    const {
      ohlcvDailyAll,
      ohlcv1hAll,
      ohlcv15mAll
    } = await loadTimeframesForBacktest(symbol, fromTime, toTime);

    // 2) Osekáme hour a 15m … 
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
    console.log(`[LOG] totalHourly (after filter) = ${totalHourly}, hoursToBacktest = ${hoursToBacktest}`);

    if (totalHourly < hoursToBacktest + 1) {
      throw new Error(`Not enough hourly data => have ${totalHourly}, needed >= ${hoursToBacktest+1}.`);
    }

    console.log(`Hourly range size: ${totalHourly} [${tsToISO(fromTime||0)}..${tsToISO(toTime||Date.now())}]`);
    console.log(`Daily fetched (with buffer): ${ohlcvDailyAll.length} candle(s).`);

    const results   = [];
    let runningPnL  = 0;

    // 3) Backtest
    for (let i = 0; i < hoursToBacktest; i++) {
      const cIndex = totalHourly - (hoursToBacktest + 1) + i;
      if (cIndex + 1 >= totalHourly) break;

      // Hour slice
      const hourDataSlice = hourDataBacktest.slice(0, cIndex + 1);
      const min15Slice    = min15DataBacktest.slice(0, cIndex * 4 + 1);

      // lastHourTimestamp
      const lastHourTimestamp = hourDataSlice[hourDataSlice.length - 1][0];
      console.log(`[LOG] Iteration #${i}: cIndex=${cIndex}, lastHourTimestamp=${tsToISO(lastHourTimestamp)}`);

      // dailyDataSlice
      //const dailyDataSlice = ohlcvDailyAll.filter(d => d[0] <= lastHourTimestamp);
      const dailyDataSliceAll = ohlcvDailyAll.filter(d => d[0] <= lastHourTimestamp);
      
      // Odstránime "nedokončenú" daily candle, ak je short
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const dailyDataSlice = dailyDataSliceAll.filter(c => {
        return lastHourTimestamp >= c[0] + ONE_DAY_MS;
      });
      console.log(`[LOG]   dailyDataSlice.length = ${dailyDataSlice.length}`);
      if (dailyDataSlice.length < 2) {
        throw new Error(`Iteration #${i}: Not enough daily data => only ${dailyDataSlice.length}. Possibly partial daily candle.`);
      }
      if (dailyDataSlice.length > 0) {
        console.log(`[LOG]   dailyDataSlice.first=${tsToISO(dailyDataSlice[0][0])}, dailyDataSlice.last=${tsToISO(dailyDataSlice[dailyDataSlice.length - 1][0])}`);
      }
      // Voliteľne vypíšte detail každého daily candle:
      // dailyDataSlice.forEach((dc, idx) => {
      //   console.log(`[LOG]    #${idx}: ts=${tsToISO(dc[0])}, close=${dc[4]}`);
      // });

      // => tu, ak je dailyDataSlice < 2 => Error
      if (dailyDataSlice.length < 2) {
        throw new Error(`Iteration #${i}: Not enough daily data => only ${dailyDataSlice.length}.`);
      }

      // GPT analýza
      const analysis = await analyzeSymbolRobustChainingApproachOffline(
        symbol,
        dailyDataSlice,
        min15Slice,
        hourDataSlice
      );
      const finalAction = analysis.gptOutput.final_action || 'HOLD';

      // PnL
      const nextOHLC   = hourDataBacktest[cIndex + 1];
      const openPrice  = nextOHLC[1];
      const highPrice  = nextOHLC[2];
      const lowPrice   = nextOHLC[3];
      const closePrice = nextOHLC[4];
      const atr        = analysis.tf1h.lastATR || 0;
      const stopMult   = 2;

      let tradePnL = 0;
      if (finalAction === 'BUY') {
        const stopPrice = openPrice - stopMult * atr;
        if (lowPrice <= stopPrice) {
          tradePnL = stopPrice - openPrice;
        } else {
          tradePnL = closePrice - openPrice;
        }
      } else if (finalAction === 'SELL') {
        const stopPrice = openPrice + stopMult * atr;
        if (highPrice >= stopPrice) {
          tradePnL = openPrice - stopPrice;
        } else {
          tradePnL = openPrice - closePrice;
        }
      }
      runningPnL += tradePnL;

      console.log(`[LOG]   finalAction=${finalAction}, open=${openPrice.toFixed(2)}, close=${closePrice.toFixed(2)}, tradePnL=${tradePnL.toFixed(4)}, runningPnL=${runningPnL.toFixed(4)}`);

      results.push({
        iteration: i,
        cIndex,
        finalAction,
        openPrice,
        closePrice,
        tradePnL,
        runningPnL
      });
    }

    console.log('[LOG] Final PnL = ', runningPnL.toFixed(4));
    return res.json({ success: true, finalPnL: runningPnL, detail: results });
  } catch (err) {
    console.error('Error in simulation:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
