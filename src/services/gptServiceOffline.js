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
      return min1Candles[i][4];
    }
  }
  return null;
}

module.exports = { fetchOHLCVInChunks, loadTimeframesForBacktest, find1mClosePriceAtTime };


/* gptServiceOffline.js */
const OpenAI = require('openai');
const { formatTS } = require('../utils/timeUtils');
const { offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe } = require('./offlineIndicators');

const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

function formatNumber(num) {
  return Number(num.toFixed(4));
}

function buildDailyPrompt(symbol, dailyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
  return `
  Daily stats for ${symbol}:
  mean=${formatNumber(meanVal)}, stdev=${formatNumber(stdevVal)}, min=${formatNumber(minVal)}, max=${formatNumber(maxVal)}, skew=${formatNumber(skewVal)}, kurt=${formatNumber(kurtVal)}
  
  Please provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
  {
    "macro_view": "...",
    "macro_comment": "..."
  }
  (No extra text.)
  `;
}

function buildWeeklyPrompt(symbol, weeklyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = weeklyStats;
  return `
  Weekly stats for ${symbol}:
  mean=${formatNumber(meanVal)}, stdev=${formatNumber(stdevVal)}, min=${formatNumber(minVal)}, max=${formatNumber(maxVal)}, skew=${formatNumber(skewVal)}, kurt=${formatNumber(kurtVal)}
  
  Please provide a "weekly_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
  {
    "weekly_view": "...",
    "weekly_comment": "..."
  }
  (No extra text.)
  `;
}

function buildIndicatorSummary(tfData, timeframe) {
  if (!tfData) return 'N/A';
  let summary = `timeframe=${timeframe}, close=${formatNumber(tfData.lastClose)}\n`;
  if (timeframe === '5m') {
    if (tfData.lastEMA9 !== undefined) summary += `EMA9=${formatNumber(tfData.lastEMA9)}\n`;
    if (tfData.lastEMA21 !== undefined) summary += `EMA21=${formatNumber(tfData.lastEMA21)}\n`;
    if (tfData.lastBoll) {
      const lower = tfData.lastBoll.lower !== undefined ? formatNumber(tfData.lastBoll.lower) : 'N/A';
      const mid = tfData.lastBoll.mid !== undefined ? formatNumber(tfData.lastBoll.mid) : 'N/A';
      const upper = tfData.lastBoll.upper !== undefined ? formatNumber(tfData.lastBoll.upper) : 'N/A';
      summary += `Bollinger Bands: lower=${lower}, mid=${mid}, upper=${upper}\n`;
    }
    if (tfData.lastATR !== undefined) summary += `ATR=${formatNumber(tfData.lastATR)}\n`;
  } else if (timeframe === '15m') {
    if (tfData.lastEMA9 !== undefined) summary += `EMA9=${formatNumber(tfData.lastEMA9)}\n`;
    if (tfData.lastEMA21 !== undefined) summary += `EMA21=${formatNumber(tfData.lastEMA21)}\n`;
    if (tfData.lastEMA50 !== undefined) summary += `EMA50=${formatNumber(tfData.lastEMA50)}\n`;
    if (tfData.lastSMA50 !== undefined) summary += `SMA50=${formatNumber(tfData.lastSMA50)}\n`;
    if (tfData.lastRSI !== undefined) summary += `RSI=${formatNumber(tfData.lastRSI)}\n`;
    if (tfData.lastMACD && tfData.lastMACD.MACD !== undefined) {
      summary += `MACD=${formatNumber(tfData.lastMACD.MACD)}, signal=${formatNumber(tfData.lastMACD.signal)}, hist=${formatNumber(tfData.lastMACD.histogram)}\n`;
    }
    if (tfData.lastStochastic !== undefined) {
      summary += `Stochastic: K=${formatNumber(tfData.lastStochastic.k)}, D=${formatNumber(tfData.lastStochastic.d)}\n`;
    }
    if (tfData.fibonacci !== undefined) {
      summary += `Fibonacci retracement=${formatNumber(tfData.fibonacci)}\n`;
    }
  } else if (timeframe === '1h' || timeframe === '60m') {
    if (tfData.lastEMA21 !== undefined) summary += `EMA21=${formatNumber(tfData.lastEMA21)}\n`;
    if (tfData.lastEMA50 !== undefined) summary += `EMA50=${formatNumber(tfData.lastEMA50)}\n`;
    if (tfData.lastEMA200 !== undefined) summary += `EMA200=${formatNumber(tfData.lastEMA200)}\n`;
    if (tfData.lastSMA50 !== undefined) summary += `SMA50=${formatNumber(tfData.lastSMA50)}\n`;
    if (tfData.lastRSI !== undefined) summary += `RSI=${formatNumber(tfData.lastRSI)}\n`;
    if (tfData.lastMACD && tfData.lastMACD.MACD !== undefined) {
      summary += `MACD=${formatNumber(tfData.lastMACD.MACD)}, signal=${formatNumber(tfData.lastMACD.signal)}, hist=${formatNumber(tfData.lastMACD.histogram)}\n`;
    }
    if (tfData.lastVWAP !== undefined) summary += `VWAP=${formatNumber(tfData.lastVWAP)}\n`;
    if (tfData.supportResistance !== undefined) summary += `Support/Resistance=${tfData.supportResistance}\n`;
    if (tfData.pivotPoints !== undefined) summary += `Pivot Points=${tfData.pivotPoints}\n`;
    if (tfData.fibonacci !== undefined) summary += `Fibonacci retracement=${formatNumber(tfData.fibonacci)}\n`;
  } else if (timeframe === 'daily') {
    if (tfData.lastSMA50 !== undefined) summary += `SMA50=${formatNumber(tfData.lastSMA50)}\n`;
    if (tfData.lastSMA100 !== undefined) summary += `SMA100=${formatNumber(tfData.lastSMA100)}\n`;
    if (tfData.lastSMA200 !== undefined) summary += `SMA200=${formatNumber(tfData.lastSMA200)}\n`;
    if (tfData.lastEMA21 !== undefined) summary += `EMA21=${formatNumber(tfData.lastEMA21)}\n`;
    if (tfData.lastEMA50 !== undefined) summary += `EMA50=${formatNumber(tfData.lastEMA50)}\n`;
    if (tfData.lastEMA200 !== undefined) summary += `EMA200=${formatNumber(tfData.lastEMA200)}\n`;
    if (tfData.lastRSI !== undefined) summary += `RSI=${formatNumber(tfData.lastRSI)}\n`;
    if (tfData.lastMACD && tfData.lastMACD.MACD !== undefined) {
      summary += `MACD=${formatNumber(tfData.lastMACD.MACD)}, signal=${formatNumber(tfData.lastMACD.signal)}, hist=${formatNumber(tfData.lastMACD.histogram)}\n`;
    }
    if (tfData.supportResistance !== undefined) summary += `Support/Resistance=${tfData.supportResistance}\n`;
    if (tfData.pivotPoints !== undefined) summary += `Pivot Points=${tfData.pivotPoints}\n`;
    if (tfData.trendLines !== undefined) summary += `Trend Lines=${tfData.trendLines}\n`;
  } else if (timeframe === 'weekly') {
    if (tfData.lastSMA50 !== undefined) summary += `SMA50=${formatNumber(tfData.lastSMA50)}\n`;
    if (tfData.lastSMA100 !== undefined) summary += `SMA100=${formatNumber(tfData.lastSMA100)}\n`;
    if (tfData.lastSMA200 !== undefined) summary += `SMA200=${formatNumber(tfData.lastSMA200)}\n`;
    if (tfData.lastRSI !== undefined) summary += `RSI=${formatNumber(tfData.lastRSI)}\n`;
    if (tfData.lastMACD && tfData.lastMACD.MACD !== undefined) {
      summary += `MACD=${formatNumber(tfData.lastMACD.MACD)}, signal=${formatNumber(tfData.lastMACD.signal)}, hist=${formatNumber(tfData.lastMACD.histogram)}\n`;
    }
    if (tfData.supportResistance !== undefined) summary += `Support/Resistance=${tfData.supportResistance}\n`;
    if (tfData.pivotPoints !== undefined) summary += `Pivot Points=${tfData.pivotPoints}\n`;
  }
  return summary;
}

function build5mMacroPrompt(symbol, min5Indicators) {
  const summary = buildIndicatorSummary(min5Indicators);
  return `
5-minute summary (Scalping, high volatility) for ${symbol}:
Indicators considered:
- EMA9 and EMA21: Short-term moving averages to quickly identify trend direction.
- VWAP: Volume Weighted Average Price to determine average price based on volume.
- RSI (7 or 14): To identify overbought (above 70) or oversold (below 30) conditions.
- Bollinger Bands (20,2): To detect breakouts and volatility squeezes.
- MACD (12,26,9): Crossovers can indicate short-term momentum shifts.
Strategy: Look for breakouts through Bollinger Bands and confirm entry with VWAP and a MACD crossover.
Computed indicators summary:
${summary}

Based on the above, please provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

function build15mMacroPrompt(symbol, min15Indicators) {
  const summary = buildIndicatorSummary(min15Indicators);
  return `
15-minute summary (Intraday Trading, Swing) for ${symbol}:
Indicators considered:
- EMA20 and EMA50: Identify short-term and mid-term trends.
- Fibonacci retracement levels (e.g., 0.618): To find potential entry correction levels.
- RSI (14) and Stochastic RSI (3,3,14,14): To detect extreme conditions and momentum shifts.
- OBV: For accumulation/distribution of volume.
- ATR: To measure market volatility.
Strategy: Use Fibonacci retracement for corrections and confirm the trend with EMA and RSI divergence.
Computed indicators summary:
${summary}

Based on the above, please provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

function buildHourlyMacroPrompt(symbol, hourlyIndicators) {
  const summary = buildIndicatorSummary(hourlyIndicators);
  return `
Hourly summary (Swing Trading, Momentum) for ${symbol}:
Indicators considered:
- EMA50 and EMA200: To identify the long-term trend.
- Ichimoku Cloud: For support, resistance, and overall market sentiment.
- RSI (14) with divergence analysis: To spot potential trend reversals.
- Volume Profile (VPVR): To reveal key liquidity zones and points of control (POC).
- MACD (12,26,9) and Histogram: For momentum and confirmation of crossovers.
Strategy: Wait for trend confirmation via an EMA crossover, then enter after retesting key VPVR levels.
Computed indicators summary:
${summary}

Based on the above, please provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

function buildFinalSynergyPrompt(symbol, dailyMacro, weeklyMacro, tf15m, tf5m, tf1h, fromTime, toTime) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const weeklySummary = `weekly_view=${weeklyMacro.weekly_view}, reason=${weeklyMacro.weekly_comment}`;
  const sum15m = buildIndicatorSummary(tf15m);
  const sum5m = buildIndicatorSummary(tf5m);
  const sum1h = buildIndicatorSummary(tf1h);
  let dateRangeText = '';
  if (fromTime || toTime) {
    const fromTxt = fromTime ? formatTS(fromTime) : 'N/A';
    const toTxt = toTime ? formatTS(toTime) : 'N/A';
    dateRangeText = `Offline data timeframe: from ${fromTxt} to ${toTxt}.\n`;
  }
  return `
We have the following analyses for ${symbol}:


Short-term Analysis:
15m timeframe:
${sum15m}
5m timeframe:
${sum5m}
1h timeframe:
${sum1h}

${dateRangeText}

Dynamic Weighting Instructions:
- Base weights (initially): Short-term 5m = 50%, 15m = 25%, 1h = 25%.
- Adjust weights based on market volatility (for example, if ATR is high, weight short-term signals higher).
- Factor in momentum from advanced indicators (EMA crossovers, MACD, etc.) and volume data.
- Incorporate fundamental news when applicable.

Risk Management:
- Assess current price in relation to ATR and Bollinger Bands.
- Suggest stop_loss and target_profit levels accordingly.

Combine all the above into one final conclusion. Return JSON in the following format (no extra text):
{
  "technical_signal_strength": 0, 
  "final_action": "BUY"|"SELL"|"HOLD",
  "stop_loss": <number>,
  "target_profit": <number>,
  "comment": "short comment"
}
`;
}

async function callOpenAI(prompt) {
  try {
    const response = await openAiClient.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }]
    });
    let raw = response.choices[0]?.message?.content || "";
    raw = raw.replace(/```(\w+)?/g, "").trim();
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn("[GPTServiceOffline] Error calling OpenAI:", err.message);
    return null;
  }
}

async function analyzeSymbolChain(
  symbol,
  dailyDataSlice,
  weeklyDataSlice,
  min15DataSlice,
  hourDataSlice,
  min5DataSlice,
  fromTime,
  toTime
) {
  const dailyStats = offlineDailyStats(dailyDataSlice);
  const weeklyStats = offlineWeeklyStats(weeklyDataSlice);
  const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
  const weeklyPrompt = buildWeeklyPrompt(symbol, weeklyStats);
  const dailyPromise = callOpenAI(dailyPrompt).catch((err) => {
    console.error("[GPTServiceOffline] Daily analysis error:", err.message);
    return { macro_view: "NEUTRAL", macro_comment: "No macro" };
  });
  const weeklyPromise = callOpenAI(weeklyPrompt).catch((err) => {
    console.error("[GPTServiceOffline] Weekly analysis error:", err.message);
    return { weekly_view: "NEUTRAL", weekly_comment: "No weekly" };
  });
  const [tf15m, tf1h, tf5m] = await Promise.all([
    Promise.resolve(offlineIndicatorsForTimeframe(min15DataSlice, "15m")).catch((err) => {
      console.warn("[GPTServiceOffline] 15m indicator error:", err.message);
      return null;
    }),
    Promise.resolve(offlineIndicatorsForTimeframe(hourDataSlice, "1h")).catch((err) => {
      console.warn("[GPTServiceOffline] 1h indicator error:", err.message);
      return null;
    }),
    Promise.resolve(offlineIndicatorsForTimeframe(min5DataSlice, "5m")).catch((err) => {
      console.warn("[GPTServiceOffline] 5m indicator error:", err.message);
      return null;
    })
  ]);
  const [dailyResult, weeklyResult] = await Promise.all([dailyPromise, weeklyPromise]);
  const dailyMacro = dailyResult || {
    macro_view: "NEUTRAL",
    macro_comment: "No macro"
  };
  const weeklyMacro = weeklyResult || {
    weekly_view: "NEUTRAL",
    weekly_comment: "No weekly"
  };
  const hourlyMacroPrompt = buildHourlyMacroPrompt(symbol, tf1h);
  const min15MacroPrompt = build15mMacroPrompt(symbol, tf15m);
  const min5MacroPrompt = build5mMacroPrompt(symbol, tf5m);
  const hourlyMacroPromise = callOpenAI(hourlyMacroPrompt).catch((err) => {
    console.error("[GPTServiceOffline] Hourly macro analysis error:", err.message);
    return { macro_view: "NEUTRAL", macro_comment: "No hourly macro" };
  });
  const min15MacroPromise = callOpenAI(min15MacroPrompt).catch((err) => {
    console.error("[GPTServiceOffline] 15m macro analysis error:", err.message);
    return { macro_view: "NEUTRAL", macro_comment: "No 15m macro" };
  });
  const min5MacroPromise = callOpenAI(min5MacroPrompt).catch((err) => {
    console.error("[GPTServiceOffline] 5m macro analysis error:", err.message);
    return { macro_view: "NEUTRAL", macro_comment: "No 5m macro" };
  });
  const [hourlyMacro, min15Macro, min5Macro] = await Promise.all([
    hourlyMacroPromise,
    min15MacroPromise,
    min5MacroPromise
  ]);
  const synergyPrompt = buildFinalSynergyPrompt(
    symbol,
    dailyMacro,
    weeklyMacro,
    tf15m,
    tf5m,
    tf1h,
    fromTime,
    toTime
  );
  let finalSynergy = null;
  try {
    finalSynergy = await callOpenAI(synergyPrompt);
  } catch (err) {
    console.error("[GPTServiceOffline] Synergy analysis error:", err.message);
  }
  if (!finalSynergy) {
    console.warn("[GPTServiceOffline] finalSynergy is undefined – setting default fallback object");
    finalSynergy = {
      final_action: "HOLD",
      technical_signal_strength: 0,
      stop_loss: null,
      target_profit: null,
      comment: "No valid synergy result obtained"
    };
  }
  return {
    gptOutput: {
      final_action: finalSynergy.final_action,
      technical_signal_strength: finalSynergy.technical_signal_strength,
      stop_loss: finalSynergy.stop_loss,
      target_profit: finalSynergy.target_profit,
      comment: finalSynergy.comment
    },
    tf15m,
    tf1h,
    tf5m,
    tfDailyStats: dailyStats,
    tfWeeklyStats: weeklyStats,
    hourlyMacro,
    min15Macro,
    min5Macro
  };
}

module.exports = {
  analyzeSymbolChain,
  callOpenAI
};