const ccxt = require('ccxt');

/**
 * Convert timestamp (ms) to ISO string for logging/debug.
 */
function tsToISO(ts) {
  return new Date(ts).toISOString();
}

/**
 * Convert timeframe (e.g. '1m', '1h') to milliseconds.
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
    case '1w':   return 7  * 24 * 60 * 60 * 1000;
    default:     return 24 * 60 * 60 * 1000;
  }
}

/**
 * Fetch OHLCV data in batches until we reach toTS or run out.
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
 *  - Warm-up 60 dní: we adjust fromTime "backwards" to accommodate indicators
 */
async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit = 1000;

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
  // Also fetch 1m data if needed
  const ohlcv1mAll     = await fetchOHLCVInChunks(exchange, symbol, '1m', fromTimeWithBuffer, toTime, limit);

  console.log(`[LOG] => daily=${ohlcvDailyAll.length}, weekly=${ohlcvWeeklyAll.length}, 1h=${ohlcv1hAll.length}, 15m=${ohlcv15mAll.length}, 1m=${ohlcv1mAll.length}`);

  return {
    ohlcvDailyAll,
    ohlcvWeeklyAll,
    ohlcv1hAll,
    ohlcv15mAll,
    ohlcv1mAll
  };
}

// Export everything needed
module.exports = {
  loadTimeframesForBacktest,
  // If needed, you can also export the helper functions
  tsToISO,
  timeframeToMs,
  fetchOHLCVInChunks
};