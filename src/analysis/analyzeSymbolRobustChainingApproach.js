const OpenAI = require('openai');
const {
  RSI, MACD, SMA, BollingerBands, ADX, Stochastic, EMA, ATR, MFI, OBV
} = require('technicalindicators');

/**
 * You’ll need utility functions for mean, stdev, skewness, etc.
 * Adapt or replace these with your own implementations.
 */
const { 
  calcMean, calcStdev, calcSkewness, calcKurtosis,
  safeLast, safeToFixed
} = require('../utils/helpers');

/* ------------------------------------------------------------------
   1) Fetching OUTLOOK STATS (daily and weekly) 
   ------------------------------------------------------------------ */

/**
 * Fetches daily OHLC data, calculates returns, and then computes stats:
 * mean, stdev, min, max, skew, kurtosis.
 */
async function fetchDailyStats(exchange, symbol, limit = 200) {
  const ohlcv = await exchange.fetchOHLCV(symbol, '1d', undefined, limit);
  if (!ohlcv || ohlcv.length < 2) {
    throw new Error(`Not enough daily data for symbol=${symbol}`);
  }
  const closes = ohlcv.map(c => c[4]);

  // Build simple returns array
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const ret = (closes[i] - closes[i - 1]) / closes[i - 1];
    returns.push(ret);
  }

  // Compute stats
  const meanVal = calcMean(returns);
  const stdevVal = calcStdev(returns, meanVal);
  const minVal = Math.min(...returns);
  const maxVal = Math.max(...returns);
  const skewVal = calcSkewness(returns, meanVal, stdevVal);
  const kurtVal = calcKurtosis(returns, meanVal, stdevVal);

  return {
    meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
  };
}

/**
 * Same as daily, but fetching '1w' timeframe for weekly stats.
 */
async function fetchWeeklyStats(exchange, symbol, limit = 100) {
  const ohlcv = await exchange.fetchOHLCV(symbol, '1w', undefined, limit);
  if (!ohlcv || ohlcv.length < 2) {
    throw new Error(`Not enough weekly data for symbol=${symbol}`);
  }
  const closes = ohlcv.map(c => c[4]);

  // Build returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const ret = (closes[i] - closes[i - 1]) / closes[i - 1];
    returns.push(ret);
  }

  // Compute stats
  const meanVal = calcMean(returns);
  const stdevVal = calcStdev(returns, meanVal);
  const minVal = Math.min(...returns);
  const maxVal = Math.max(...returns);
  const skewVal = calcSkewness(returns, meanVal, stdevVal);
  const kurtVal = calcKurtosis(returns, meanVal, stdevVal);

  return {
    meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
  };
}

/* ------------------------------------------------------------------
   2) Fetching INDICATORS (for any timeframe: 15m, 1h, etc.)
   ------------------------------------------------------------------ */
async function fetchIndicatorsForTimeframe(exchange, symbol, timeframe, limit = 200) {
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  if (!ohlcv || ohlcv.length === 0) {
    throw new Error(`Could not load OHLCV for ${symbol}, timeframe=${timeframe}`);
  }
  const highs   = ohlcv.map(c => c[2]);
  const lows    = ohlcv.map(c => c[3]);
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);

  // RSI(14)
  const rsiData = RSI.calculate({ values: closes, period: 14 });
  const lastRSI = safeLast(rsiData);

  // MACD(12,26,9)
  const macdData = MACD.calculate({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
    values: closes
  });
  const lastMACD = safeLast(macdData);

  // SMA(20)
  const sma20 = SMA.calculate({ period: 20, values: closes });
  const lastSMA20 = safeLast(sma20);

  // EMA(50)
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const lastEMA50 = safeLast(ema50);

  // Bollinger Bands(20,2)
  const bollData = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const lastBoll = safeLast(bollData);

  // ADX(14)
  const adxData = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });
  const lastADX = safeLast(adxData);

  // Stochastic(14,3)
  const stoData = Stochastic.calculate({
    high: highs, low: lows, close: closes, period: 14, signalPeriod: 3
  });
  const lastStochastic = safeLast(stoData);

  // ATR(14)
  const atrData = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const lastATR = safeLast(atrData);

  // MFI(14)
  const mfiData = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 });
  const lastMFI = safeLast(mfiData);

  // OBV
  const obvData = OBV.calculate({ close: closes, volume: volumes });
  const lastOBV = safeLast(obvData);

  const lastClose = safeLast(closes);

  return {
    timeframe,
    lastClose,
    lastRSI,
    lastMACD,
    lastSMA20,
    lastEMA50,
    lastBoll,
    lastADX,
    lastStochastic,
    lastATR,
    lastMFI,
    lastOBV
  };
}

/* ------------------------------------------------------------------
   3) BUILDING PROMPTS for the 3 GPT calls:
      - daily macro
      - weekly macro
      - final synergy
   ------------------------------------------------------------------ */

/** For daily macro GPT call */
function buildDailyPrompt(symbol, dailyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
  return `
Daily stats for ${symbol}:
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

Please give me a "macro_view": "BULLISH" or "BEARISH" or "NEUTRAL" and a reason. Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

/** For weekly macro GPT call */
function buildWeeklyPrompt(symbol, weeklyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = weeklyStats;
  return `
Weekly stats for ${symbol}:
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

Please give me a "weekly_view": "BULLISH" or "BEARISH" or "NEUTRAL" and a reason. Return JSON:
{
  "weekly_view": "...",
  "weekly_comment": "..."
}
(No extra text.)
`;
}

/** 
 * Helper to build a short textual summary of indicators for any timeframe,
 * used inside the synergy prompt.
 */
function buildIndicatorSummary(tfData) {
  if (!tfData) return 'N/A tfData';

  const {
    timeframe,
    lastClose, lastRSI, lastMACD, lastSMA20, lastEMA50,
    lastBoll, lastADX, lastStochastic, lastATR, lastMFI, lastOBV
  } = tfData;

  const macdStr = lastMACD
    ? `MACD=${safeToFixed(lastMACD.MACD,2)}, signal=${safeToFixed(lastMACD.signal,2)}, hist=${safeToFixed(lastMACD.histogram,2)}`
    : 'N/A';
  const bollStr = lastBoll
    ? `BollLower=${safeToFixed(lastBoll.lower,2)}, mid=${safeToFixed(lastBoll.mid,2)}, upper=${safeToFixed(lastBoll.upper,2)}`
    : 'N/A';
  const adxStr  = lastADX
    ? `ADX=${safeToFixed(lastADX.adx,2)}, +DI=${safeToFixed(lastADX.pdi,2)}, -DI=${safeToFixed(lastADX.mdi,2)}`
    : 'N/A';

  return `
timeframe=${timeframe}, close=${safeToFixed(lastClose,4)}
RSI(14)=${safeToFixed(lastRSI,2)}
${macdStr}
SMA20=${safeToFixed(lastSMA20,4)}
EMA50=${safeToFixed(lastEMA50,4)}
${bollStr}
${adxStr}
Stoch(14,3)=${lastStochastic ? `K=${safeToFixed(lastStochastic.k,2)},D=${safeToFixed(lastStochastic.d,2)}` : 'N/A'}
ATR(14)=${safeToFixed(lastATR,4)}
MFI(14)=${safeToFixed(lastMFI,2)}
OBV=${safeToFixed(lastOBV,2)}
`;
}

/** 
 * Final synergy prompt. We combine:
 *   - daily macro (30%)
 *   - weekly macro (40%)
 *   - short-term (15m + 1h) = 30%
 */
function buildFinalSynergyPrompt(symbol, dailyMacro, weeklyMacro, tf15m, tf1h) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const weeklySummary = `weekly_view=${weeklyMacro.weekly_view}, reason=${weeklyMacro.weekly_comment}`;
  
  const sum15m = buildIndicatorSummary(tf15m);
  const sum1h  = buildIndicatorSummary(tf1h);

  return `
We have daily macro => ${dailySummary}
We have weekly macro => ${weeklySummary}

Now short-term (15m,1h) analysis:
15m:
${sum15m}
1h:
${sum1h}

Consider these weights in your final decision:
- Daily macro: 30%
- Weekly macro: 40%
- Short-term (15m + 1h technicals): 30%

Combine them into one final conclusion. Return JSON:
{
  "technical_signal_strength": 0.0-1.0,
  "final_action": "BUY"/"SELL"/"HOLD",
  "comment": "some short comment"
}
(No extra text.)
`;
}

/* ------------------------------------------------------------------
   4) MAIN FUNCTION: analyzeSymbolRobustChainingApproach
   ------------------------------------------------------------------ */

async function analyzeSymbolRobustChainingApproach(exchange, symbol) {
  // Prepare an OpenAI client
  const openAiClient = new OpenAI({
    organization: process.env.OPENAI_ORGANIZATION,
    apiKey: process.env.OPENAI_API_KEY
  });

  /* 1) Fetch daily stats */
  let dailyStats;
  try {
    dailyStats = await fetchDailyStats(exchange, symbol);
  } catch (err) {
    console.error(`[LOG] fetchDailyStats error:`, err.message);
    // Not enough data => fallback
    return {
      gptOutput: {
        final_action: 'HOLD',
        comment: 'Insufficient daily data => skipping macro.'
      },
      tf15m: null,
      tf1h: null,
      tfDailyStats: null,
      tfWeeklyStats: null
    };
  }

  /* 2) GPT #1 => daily macro */
  let dailyParsed = { macro_view: 'NEUTRAL', macro_comment: 'No daily macro' };
  try {
    const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
    console.log("[LOG] dailyPrompt =>", dailyPrompt);

    const resp1 = await openAiClient.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: dailyPrompt }]
    });
    let raw1 = resp1.choices[0]?.message?.content || '';
    raw1 = raw1.replace(/```(\w+)?/g, '').trim();
    dailyParsed = JSON.parse(raw1);
    console.log("[LOG] dailyParsed =>", dailyParsed);
  } catch (e) {
    console.warn("GPT daily macro parse error:", e.message);
  }

  /* 3) Fetch weekly stats */
  let weeklyStats;
  try {
    weeklyStats = await fetchWeeklyStats(exchange, symbol);
  } catch (err) {
    console.error('[LOG] fetchWeeklyStats error:', err.message);
    // Fallback => no weekly
    weeklyStats = null;
  }

  /* 4) GPT #2 => weekly macro */
  let weeklyParsed = { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly data' };
  if (weeklyStats) {
    try {
      const weeklyPrompt = buildWeeklyPrompt(symbol, weeklyStats);
      console.log("[LOG] weeklyPrompt =>", weeklyPrompt);

      const resp2 = await openAiClient.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: weeklyPrompt }]
      });
      let raw2 = resp2.choices[0]?.message?.content || '';
      raw2 = raw2.replace(/```(\w+)?/g, '').trim();
      weeklyParsed = JSON.parse(raw2);
      console.log("[LOG] weeklyParsed =>", weeklyParsed);
    } catch (e) {
      console.warn("GPT weekly macro parse error:", e.message);
    }
  }

  /* 5) Fetch short-term indicators: 15m, 1h */
  // You can tune the “limit” if you need more or fewer bars
  let tf15m = null;
  let tf1h  = null;

  try {
    tf15m = await fetchIndicatorsForTimeframe(exchange, symbol, '15m', 200);
  } catch (err) {
    console.warn(`[LOG] No 15m data for symbol=${symbol}:`, err.message);
  }

  try {
    tf1h  = await fetchIndicatorsForTimeframe(exchange, symbol, '1h', 200);
  } catch (err) {
    console.warn(`[LOG] No 1h data for symbol=${symbol}:`, err.message);
  }

  /* 6) GPT #3 => synergy (combine daily, weekly, short-term) */
  let synergyParsed = null;
  try {
    const synergyPrompt = buildFinalSynergyPrompt(symbol, dailyParsed, weeklyParsed, tf15m, tf1h);
    console.log("[LOG synergyPrompt] =>", synergyPrompt);

    const resp3 = await openAiClient.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: synergyPrompt }]
    });
    let raw3 = resp3.choices[0]?.message?.content || '';
    raw3 = raw3.replace(/```(\w+)?/g, '').trim();
    synergyParsed = JSON.parse(raw3);
    console.log("[LOG synergy] synergyParsed =>", synergyParsed);
  } catch (e) {
    console.warn("GPT synergy parse error:", e.message);
  }

  /* 7) Prepare final action */
  const final_action = synergyParsed?.final_action || 'HOLD';
  const comment      = synergyParsed?.comment || '';
  const techStr      = synergyParsed?.technical_signal_strength || 0;

  // Return everything
  return {
    gptOutput: {
      final_action,
      comment,
      technical_signal_strength: techStr
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats,
    tfWeeklyStats: weeklyStats
  };
}

module.exports = {
  analyzeSymbolRobustChainingApproach
};