const OpenAI = require('openai');
const { formatTS } = require('../utils/timeUtils');
const { offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe } = require('./offlineIndicators');

const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

// Helper function for consistent number formatting
function formatNumber(num) {
  return Number(num.toFixed(4));
}

// ------------------------------
// PROMPT GENERATORS
// ------------------------------

// Daily prompt remains the same
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

// Weekly prompt remains the same
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

// Generic function for indicator summary (for all timeframes)
function buildIndicatorSummary(tfData, timeframe) {
    if (!tfData) return 'N/A';
    let summary = `timeframe=${timeframe}, close=${formatNumber(tfData.lastClose)}\n`;
    
    if (timeframe === '5m') {
      // 5-minútový: vhodný pre scalping a rýchle signály
      if (tfData.lastEMA9 !== undefined) summary += `EMA9=${formatNumber(tfData.lastEMA9)}\n`;
      if (tfData.lastEMA21 !== undefined) summary += `EMA21=${formatNumber(tfData.lastEMA21)}\n`;
      if (tfData.lastBoll) {
        const lower = tfData.lastBoll.lower !== undefined ? formatNumber(tfData.lastBoll.lower) : 'N/A';
        const mid   = tfData.lastBoll.mid !== undefined ? formatNumber(tfData.lastBoll.mid) : 'N/A';
        const upper = tfData.lastBoll.upper !== undefined ? formatNumber(tfData.lastBoll.upper) : 'N/A';
        summary += `Bollinger Bands: lower=${lower}, mid=${mid}, upper=${upper}\n`;
      }
      if (tfData.lastATR !== undefined) summary += `ATR=${formatNumber(tfData.lastATR)}\n`;
    } else if (timeframe === '15m') {
      // 15-minútový: pre intradenné obchodovanie / swing trading
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
      // 1-hodinový: pre swing trading a kombinovanú analýzu
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
      // Denný: pre strednodobú investičnú analýzu
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
      // Týždenný: pre dlhodobú analýzu
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

// ------------------------------
// NEW MACRO PROMPT FUNCTIONS (for 5m, 15m, and hourly) with recommendations
// ------------------------------

/* 5-minute macro for scalping (high volatility) */
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

/* 15-minute macro for intraday trading/swing */
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

/* Hourly macro for swing trading/momentum */
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

// Final synergy prompt (kept as before)
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

// ------------------------------
// CALL OPENAI API function
// ------------------------------
async function callOpenAI(prompt) {
    try {
      console.log("[GPTServiceOffline] Sending prompt to OpenAI:\n", prompt);
      
      const response = await openAiClient.chat.completions.create({
        model: "o3-mini", // use the same model as online
        messages: [{ role: "user", content: prompt }]
      });
      console.log("[GPTServiceOffline] Raw response from OpenAI:", response);
  
      let raw = response.choices[0]?.message?.content || "";
      console.log("[GPTServiceOffline] Raw content extracted:", raw);
  
      // Clean the response from extra markdown formatting:
      raw = raw.replace(/```(\w+)?/g, "").trim();
      console.log("[GPTServiceOffline] Cleaned raw content:", raw);
      
      // Parse JSON and log the result:
      const parsed = JSON.parse(raw);
      console.log("[GPTServiceOffline] Parsed JSON:", parsed);
      return parsed;
    } catch (err) {
      console.warn("[GPTServiceOffline] Error calling OpenAI:", err.message);
      return null;
    }
  }
  
  // MAIN FUNCTION: analyzeSymbolChain – with added console logging
  async function analyzeSymbolChain(
    symbol,
    dailyDataSlice,
    weeklyDataSlice,
    min15DataSlice,
    hourDataSlice,
    min5DataSlice,  // NEW parameter for 5-minute data
    fromTime,
    toTime
  ) {
    console.log("[GPTServiceOffline] Starting analyzeSymbolChain for:", symbol);
    
    // Calculate statistics
    const dailyStats = offlineDailyStats(dailyDataSlice);
    console.log("[GPTServiceOffline] Calculated dailyStats:", dailyStats);
    const weeklyStats = offlineWeeklyStats(weeklyDataSlice);
    console.log("[GPTServiceOffline] Calculated weeklyStats:", weeklyStats);
  
    // Build the prompt strings
    const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
    console.log("[GPTServiceOffline] Built daily prompt:", dailyPrompt);
    const weeklyPrompt = buildWeeklyPrompt(symbol, weeklyStats);
    console.log("[GPTServiceOffline] Built weekly prompt:", weeklyPrompt);
  
    // Get daily and weekly macro responses
    const dailyPromise = callOpenAI(dailyPrompt).catch((err) => {
      console.error("[GPTServiceOffline] Daily analysis error:", err.message);
      return { macro_view: "NEUTRAL", macro_comment: "No macro" };
    });
    const weeklyPromise = callOpenAI(weeklyPrompt).catch((err) => {
      console.error("[GPTServiceOffline] Weekly analysis error:", err.message);
      return { weekly_view: "NEUTRAL", weekly_comment: "No weekly" };
    });
  
    // Get indicators for 15m, 1h, and 5m timeframes in parallel:
    console.log("[GPTServiceOffline] Starting to fetch indicator data for 15m, 1h, and 5m");
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
      }),
    ]);
    console.log("[GPTServiceOffline] Retrieved indicators for 15m:", tf15m, "1h:", tf1h, "5m:", tf5m);
  
    const [dailyResult, weeklyResult] = await Promise.all([dailyPromise, weeklyPromise]);
    console.log("[GPTServiceOffline] Daily result:", dailyResult, "Weekly result:", weeklyResult);
    
    const dailyMacro = dailyResult || {
      macro_view: "NEUTRAL",
      macro_comment: "No macro"
    };
    const weeklyMacro = weeklyResult || {
      weekly_view: "NEUTRAL",
      weekly_comment: "No weekly"
    };
  
    // Build macro prompts for hourly, 15m and 5m timeframes
    const hourlyMacroPrompt = buildHourlyMacroPrompt(symbol, tf1h);
    console.log("[GPTServiceOffline] Built hourly macro prompt:", hourlyMacroPrompt);
    const min15MacroPrompt = build15mMacroPrompt(symbol, tf15m);
    console.log("[GPTServiceOffline] Built 15m macro prompt:", min15MacroPrompt);
    const min5MacroPrompt = build5mMacroPrompt(symbol, tf5m);
    console.log("[GPTServiceOffline] Built 5m macro prompt:", min5MacroPrompt);
    
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
    console.log("[GPTServiceOffline] Macro results - Hourly:", hourlyMacro, "15m:", min15Macro, "5m:", min5Macro);
  
    // Build final synergy prompt from all previous responses
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
    console.log("[GPTServiceOffline] Built final synergy prompt:", synergyPrompt);
    
    let finalSynergy = null;
    try {
      finalSynergy = await callOpenAI(synergyPrompt);
      console.log("[GPTServiceOffline] Final synergy object received:", finalSynergy);
    } catch (err) {
      console.error("[GPTServiceOffline] Synergy analysis error:", err.message);
    }
    
    // In case finalSynergy is null or undefined, set a default fallback:
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
    
    console.log(
      "[GPTServiceOffline] Returning final analysis result:",
      finalSynergy
    );
    
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
      hourlyMacro,  // New field
      min15Macro,   // New field
      min5Macro     // New field
    };
  }
  
  module.exports = {
    analyzeSymbolChain,
    callOpenAI
  };