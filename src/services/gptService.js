const OpenAI = require('openai');
const { formatTS } = require('../utils/timeUtils');
const { offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe } = require('./offlineIndicators');

function buildDailyPrompt(symbol, dailyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
  return `
Daily stats for ${symbol}:
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

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
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

Please provide a "weekly_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a short reason. Return JSON:
{
  "weekly_view": "...",
  "weekly_comment": "..."
}
(No extra text.)
`;
}

// POMOCNÁ FUNKCIA NA VYTVORENIE SUMÁRA INDIKÁTOROV (pre všetky timeframy)
function buildIndicatorSummary(tfData) {
  if (!tfData) return 'N/A';
  let summary = `timeframe=${tfData.timeframe}, close=${tfData.lastClose?.toFixed(4)}\n`;
  if (tfData.lastEMA9) summary += `EMA9=${tfData.lastEMA9.toFixed(2)}\n`;
  if (tfData.lastEMA21) summary += `EMA21=${tfData.lastEMA21.toFixed(2)}\n`;
  if (tfData.lastEMA50) summary += `EMA50=${tfData.lastEMA50.toFixed(2)}\n`;
  if (tfData.lastEMA200) summary += `EMA200=${tfData.lastEMA200.toFixed(2)}\n`;
  if (tfData.lastSupertrend) summary += `Supertrend=${tfData.lastSupertrend.toFixed(2)}\n`;
  if (tfData.lastPSAR) summary += `PSAR=${tfData.lastPSAR.toFixed(2)}\n`;
  if (tfData.lastVWAP) summary += `VWAP=${tfData.lastVWAP.toFixed(2)}\n`;
  if (tfData.lastHMA) summary += `HMA=${tfData.lastHMA.toFixed(2)}\n`;
  if (tfData.lastRSI) summary += `RSI=${tfData.lastRSI.toFixed(2)}\n`;
  if (tfData.lastMACD) {
    summary += `MACD=${tfData.lastMACD.MACD?.toFixed(2)}, signal=${tfData.lastMACD.signal?.toFixed(2)}, hist=${tfData.lastMACD.histogram?.toFixed(2)}\n`;
  }
  if (tfData.lastStochastic) {
    summary += `Stoch: K=${tfData.lastStochastic.k?.toFixed(2)}, D=${tfData.lastStochastic.d?.toFixed(2)}\n`;
  }
  if (tfData.lastOBV) summary += `OBV=${tfData.lastOBV.toFixed(2)}\n`;
  if (tfData.lastMFI) summary += `MFI=${tfData.lastMFI.toFixed(2)}\n`;
  if (tfData.lastBoll) {
    summary += `Bollinger Bands: lower=${tfData.lastBoll.lower?.toFixed(2)}, mid=${tfData.lastBoll.mid?.toFixed(2)}, upper=${tfData.lastBoll.upper?.toFixed(2)}\n`;
  }
  if (tfData.lastADX) {
    summary += `ADX=${tfData.lastADX.adx?.toFixed(2)}, +DI=${tfData.lastADX.pdi?.toFixed(2)}, -DI=${tfData.lastADX.mdi?.toFixed(2)}\n`;
  }
  if (tfData.lastATR) summary += `ATR=${tfData.lastATR.toFixed(2)}\n`;
  if (tfData.lastCCI) summary += `CCI=${tfData.lastCCI.toFixed(2)}\n`;
  if (tfData.lastWilliamsR) summary += `Williams %R=${tfData.lastWilliamsR.toFixed(2)}\n`;
  if (tfData.lastKeltner) {
    summary += `Keltner Channel: lower=${tfData.lastKeltner.lower?.toFixed(2)}, mid=${tfData.lastKeltner.mid?.toFixed(2)}, upper=${tfData.lastKeltner.upper?.toFixed(2)}\n`;
  }
  if (tfData.lastDonchian) {
    summary += `Donchian: min=${tfData.lastDonchian.min?.toFixed(2)}, max=${tfData.lastDonchian.max?.toFixed(2)}\n`;
  }
  if (tfData.lastTTMSqueeze !== undefined) summary += `TTM Squeeze=${tfData.lastTTMSqueeze}\n`;
  if (tfData.lastIchimoku) {
    summary += `Ichimoku: Tenkan=${tfData.lastIchimoku.tenkan?.toFixed(2)}, Kijun=${tfData.lastIchimoku.kijun?.toFixed(2)}\n`;
  }
  if (tfData.lastScalperDream !== undefined) summary += `Scalper Dream=${tfData.lastScalperDream}\n`;
  return summary;
}

// NOVÉ MACRO PROMPT FUNKCIE pre kratkodobé timeframy s odporúčaniami

/* 5-minútové (Scalping, vysoká volatilita)
   Indikátory: EMA9, EMA21, VWAP, RSI (7 alebo 14), Bollinger Bands (20,2), MACD (12,26,9)
   Stratégia: Hľadaj breakouty cez Bollinger Bands, vstup pri potvrdení VWAP a MACD crossover.
*/
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

/* 15-minútové (Intraday trading, Swing)
   Indikátory: EMA20, EMA50, Fibonacci retracement levels, RSI (14), Stochastic RSI (3,3,14,14), OBV, ATR.
   Stratégia: Použi Fibonacci retracement na korekcie a potvrď trend pomocou EMA a diverzity v RSI.
*/
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

/* Hodinové (Swing trading, Momentum)
   Indikátory: EMA50, EMA200, Ichimoku Cloud, RSI (14) s diverziami, Volume Profile (VPVR), MACD (12,26,9) + Histogram.
   Stratégia: Počkaj na potvrdenie trendu cez EMA cross a vstúp po reteste dôležitých VPVR úrovní.
*/
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


// PROMPT PRE FINÁLNU SYNERGICKÚ ANALÝZU (ponechaný pôvodný)

function buildFinalSynergyPrompt(symbol, dailyMacro, weeklyMacro, tf15m, tf1h, fromTime, toTime) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const weeklySummary = `weekly_view=${weeklyMacro.weekly_view}, reason=${weeklyMacro.weekly_comment}`;
  const sum15m = buildIndicatorSummary(tf15m);
  const sum1h = buildIndicatorSummary(tf1h);
  let dateRangeText = '';
  if (fromTime || toTime) {
    const fromTxt = fromTime ? formatTS(fromTime) : 'N/A';
    const toTxt = toTime ? formatTS(toTime) : 'N/A';
    dateRangeText = `Offline data timeframe: from ${fromTxt} to ${toTxt}.\n`;
  }

  return `
We have the following analyses for ${symbol}:

Daily Macro: ${dailySummary}
Weekly Macro: ${weeklySummary}

Short-term Analysis:
15m timeframe:
${sum15m}

1h timeframe:
${sum1h}

${dateRangeText}

Dynamic Weighting Instructions:
- Base weights (initially): Daily Macro = 30%, Weekly Macro = 40%, Short-term (15m + 1h) = 30%.
- Adjust weights based on market volatility.
- Factor in momentum indicators and volume data.
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


// VOLANIE OPENAI API a HLAVNÁ FUNKCIA analyzeSymbolChain

const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

async function callOpenAI(prompt) {
  try {
    console.log('[GPTService] Sending prompt to OpenAI:', prompt);
    const response = await openAiClient.chat.completions.create({
      model: 'o3-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    let raw = response.choices[0]?.message?.content || '';
    raw = raw.replace(/```(\w+)?/g, '').trim();
    console.log("raw:" + raw);
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[GPTService] Error calling OpenAI:', err.message);
    return null;
  }
}

// Rozšírená funkcia analyzeSymbolChain vracia aj hodnotenia pre 5m, 15m a hodinové makro.
async function analyzeSymbolChain(
  symbol,
  dailyDataSlice,
  weeklyDataSlice,
  min15DataSlice,
  hourDataSlice,
  min5DataSlice,
  fromTime,
  toTime,
) {
  const dailyStats = offlineDailyStats(dailyDataSlice);
  const weeklyStats = offlineWeeklyStats(weeklyDataSlice);
  
  const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
  const weeklyPrompt = buildWeeklyPrompt(symbol, weeklyStats);
  
  const dailyPromise = callOpenAI(dailyPrompt).catch(err => {
    console.error('[GPTService] Daily analysis error:', err.message);
    return { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
  });
  const weeklyPromise = callOpenAI(weeklyPrompt).catch(err => {
    console.error('[GPTService] Weekly analysis error:', err.message);
    return { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };
  });
  
  const [tf15m, tf1h, tf5m] = await Promise.all([
    Promise.resolve(offlineIndicatorsForTimeframe(min15DataSlice, '15m')).catch(err => {
      console.warn('[GPTService] 15m indicator error:', err.message);
      return null;
    }),
    Promise.resolve(offlineIndicatorsForTimeframe(hourDataSlice, '1h')).catch(err => {
      console.warn('[GPTService] 1h indicator error:', err.message);
      return null;
    }),
    Promise.resolve(offlineIndicatorsForTimeframe(min5DataSlice, '5m')).catch(err => {
      console.warn('[GPTService] 5m indicator error:', err.message);
      return null;
    })
  ]);
  
  const [dailyResult, weeklyResult] = await Promise.all([dailyPromise, weeklyPromise]);
  const dailyMacro = dailyResult || { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
  const weeklyMacro = weeklyResult || { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };

  // Vytvorenie promptov pre makro hodnotenie pre hodinové, 15m a 5m timeframy
  const hourlyMacroPrompt = buildHourlyMacroPrompt(symbol, tf1h);
  const min15MacroPrompt = build15mMacroPrompt(symbol, tf15m);
  const min5MacroPrompt = build5mMacroPrompt(symbol, tf5m);

  const hourlyMacroPromise = callOpenAI(hourlyMacroPrompt).catch(err => {
    console.error('[GPTService] Hourly macro analysis error:', err.message);
    return { macro_view: 'NEUTRAL', macro_comment: 'No hourly macro' };
  });
  const min15MacroPromise = callOpenAI(min15MacroPrompt).catch(err => {
    console.error('[GPTService] 15m macro analysis error:', err.message);
    return { macro_view: 'NEUTRAL', macro_comment: 'No 15m macro' };
  });
  const min5MacroPromise = callOpenAI(min5MacroPrompt).catch(err => {
    console.error('[GPTService] 5m macro analysis error:', err.message);
    return { macro_view: 'NEUTRAL', macro_comment: 'No 5m macro' };
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
    tf1h,
    fromTime,
    toTime,
  );
  
  let finalSynergy = null;
  try {
    finalSynergy = await callOpenAI(synergyPrompt);
  } catch (err) {
    console.error('[GPTService] Synergy analysis error:', err.message);
  }

  return {
    dailyAnalysis: dailyMacro,
    weeklyAnalysis: weeklyMacro,
    hourlyMacro: hourlyMacro,
    min15Macro: min15Macro,
    min5Macro: min5Macro,
    tf15m: tf15m,
    tf1h: tf1h,
    tf5m: tf5m,
    indicatorSummary15m: buildIndicatorSummary(tf15m),
    indicatorSummary1h: buildIndicatorSummary(tf1h),
    indicatorSummary5m: buildIndicatorSummary(tf5m),
    synergy: {
      final_action: finalSynergy?.final_action || 'HOLD',
      technical_signal_strength: finalSynergy?.technical_signal_strength || 0,
      stop_loss: finalSynergy?.stop_loss || null,
      target_profit: finalSynergy?.target_profit || null,
      comment: finalSynergy?.comment || ''
    },
    dailyStats: dailyStats,
    weeklyStats: weeklyStats
  };
}

module.exports = { analyzeSymbolChain, callOpenAI };