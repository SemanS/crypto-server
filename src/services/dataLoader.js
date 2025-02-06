const ccxt = require('ccxt');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');

async function fetchOHLCVInChunks(exchange, symbol, timeframe, fromTS, toTS, limit = 1000) {
  let allOhlcv = [];
  let since = fromTS;
  const finalTS = toTS || Date.now();

  while (true) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (!batch || batch.length === 0) {
      break;
    }
    allOhlcv = allOhlcv.concat(batch);
    const lastTS = batch[batch.length - 1][0];
    if (lastTS >= finalTS) break;
    if (batch.length < limit) break;
    since = lastTS + timeframeToMs(timeframe);
    if (since > finalTS) break;
  }
  // Filter lenivých sviečok, ktoré skončili po finalTS
  const filtered = allOhlcv.filter(c => c[0] <= finalTS);
  return filtered;
}

async function loadTimeframesForBacktest(symbol, fromTime, toTime) {
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const limit = 1000;
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  const fromTimeWithBuffer = fromTime ? Math.max(0, fromTime - SIXTY_DAYS_MS) : 0;

  const [ohlcvDailyAll, ohlcvWeeklyAll, ohlcv1hAll, ohlcv15mAll, ohlcv5mAll, ohlcv1mAll] = await Promise.all([
    fetchOHLCVInChunks(exchange, symbol, '1d', fromTimeWithBuffer, toTime, limit),
    fetchOHLCVInChunks(exchange, symbol, '1w', fromTimeWithBuffer, toTime, limit),
    fetchOHLCVInChunks(exchange, symbol, '1h', fromTimeWithBuffer, toTime, limit),
    fetchOHLCVInChunks(exchange, symbol, '15m', fromTimeWithBuffer, toTime, limit),
    fetchOHLCVInChunks(exchange, symbol, '5m', fromTimeWithBuffer, toTime, limit),
    fetchOHLCVInChunks(exchange, symbol, '1m', fromTimeWithBuffer, toTime, limit)
  ]);
  return { ohlcvDailyAll, ohlcvWeeklyAll, ohlcv1hAll, ohlcv15mAll, ohlcv5mAll, ohlcv1mAll };
}

function find1mClosePriceAtTime(min1Candles, targetTime) {
  const oneMinuteMs = timeframeToMs('1m');
  for (let i = 0; i < min1Candles.length; i++) {
    const start = min1Candles[i][0];
    const end = start + oneMinuteMs;
    if (start <= targetTime && targetTime < end) {
      return min1Candles[i][4]; // Close price
    }
  }
  return null;
}

function find1mClosePriceAtTime(min1Candles, targetTime) {
  const oneMinuteMs = timeframeToMs('1m');
  for (let i = 0; i < min1Candles.length; i++) {
    const start = min1Candles[i][0];
    const end = start + oneMinuteMs;
    if (start <= targetTime && targetTime < end) {
      return min1Candles[i][4]; // Uzatváracia (close) cena
    }
  }
  return null;
}

// NOVÁ FUNKCIA: vráti otvorenie (open) ceny pre candle, ktorý pokrýva targetTime
function find1mOpenPriceAtTime(min1Candles, targetTime) {
  const oneMinuteMs = timeframeToMs('1m');
  for (let i = 0; i < min1Candles.length; i++) {
    const start = min1Candles[i][0];
    const end = start + oneMinuteMs;
    if (start <= targetTime && targetTime < end) {
      return min1Candles[i][1]; // Otváracia (open) cena
    }
  }
  return null;
}

module.exports = { fetchOHLCVInChunks, loadTimeframesForBacktest, find1mClosePriceAtTime, find1mOpenPriceAtTime };