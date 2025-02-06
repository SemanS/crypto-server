const OpenAI = require('openai');
// formatTS slúži na formátovanie timestampov pre prompt
const { formatTS } = require('../utils/timeUtils');
// offlineDailyStats, offlineWeeklyStats a offlineIndicatorsForTimeframe slúžia na získanie súhrnných štatistík a indikátorov z dát
const { offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe } = require('./offlineIndicators');

// Inicializujeme klienta OpenAI s nastavením z .env
const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

// Pomocná funkcia formatNumber – formátuje číslo na 4 desatinné miesta
function formatNumber(num) {
  return Number(num.toFixed(4));
}

/*
  Funkcia buildDailyPrompt:
  - Vytvára prompt pre OpenAI na analyzovanie denných štatistík.
  - Prompt obsahuje hodnoty (mean, stdev, min, max, skew, kurt) a žiadosť, aby AI vrátila "macro_view":
    "BULLISH", "BEARISH" alebo "NEUTRAL", spolu s krátkym komentárom.
  - Komentáre vám pomôžu skontrolovať, či predpoveď vychádza z reálnych štatistík.
*/
function buildDailyPrompt(symbol, dailyStats) {
    const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
    return `
  Daily stats for ${symbol}:
  mean=${formatNumber(meanVal)}, stdev=${formatNumber(stdevVal)}, min=${formatNumber(minVal)}, max=${formatNumber(maxVal)}, skew=${formatNumber(skewVal)}, kurt=${formatNumber(kurtVal)}
  
  Based on these daily statistics, please provide a "macro_view" for ${symbol}:
  - If you believe the market is trending upward, respond with "BULLISH".
  - If you believe the market is trending downward, respond with "BEARISH".
  - Otherwise, respond with "NEUTRAL".
  Also, provide a short comment explaining key factors.
  Return JSON exactly in this format:
  {
    "macro_view": "...",
    "macro_comment": "..."
  }
  (No extra text.)
  `;
}

/*
  Funkcia buildWeeklyPrompt:
  - Podobne ako buildDailyPrompt, ale pracuje so týždennými štatistikami.
  - Vráti predpoveď, či je týždenný pohľad bullish, bearish alebo neutral.
*/
function buildWeeklyPrompt(symbol, weeklyStats) {
    const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = weeklyStats;
    return `
  Weekly stats for ${symbol}:
  mean=${formatNumber(meanVal)}, stdev=${formatNumber(stdevVal)}, min=${formatNumber(minVal)}, max=${formatNumber(maxVal)}, skew=${formatNumber(skewVal)}, kurt=${formatNumber(kurtVal)}
  
  Based on these weekly statistics, please provide a "weekly_view" for ${symbol}:
  - Respond with "BULLISH" if you expect upward momentum,
  - "BEARISH" for downward motion, or "NEUTRAL" otherwise.
  Also provide a short comment with your reasoning.
  Return JSON exactly in this format:
  {
    "weekly_view": "...",
    "weekly_comment": "..."
  }
  (No extra text.)
  `;
}

/*
  Funkcia buildIndicatorSummary:
  - Zostaví textový súhrn indikátorov pre daný timeframe.
  - Pre každý časový rámec (napr. 5m, 15m, 1h, denné, týždenné) vypíše relevantné indikátory.
  - Tento text sa potom vloží do promptu, aby ste si mohli overiť, či predpoveď AI (bullish, bearish) koreluje s indikátormi.
*/
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
      // 15-minútový
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
      // 1-hodinový: pre swing trading
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
      // Denný
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
      // Týždenný
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
  
/*
  Funkcia build5mMacroPrompt:
  - Vytvára prompt na analýzu 5-minútových indikátorov.
  - Výstup (macro_view a macro_comment) má pomôcť určiť, či sú signály bullish alebo bearish.
  - Komentáre v prompt-e vám umožnia skontrolovať, či sú indikátory interpretované správne.
*/
function build5mMacroPrompt(symbol, min5Indicators) {
  const summary = buildIndicatorSummary(min5Indicators, "5m");
  return `
5-minute summary (Scalping, high volatility) for ${symbol}:
Indicators considered:
- EMA9 and EMA21: Used for detecting rapid trend direction changes.
- VWAP: Average price weighted by volume.
- RSI (7 or 14): Overbought if above 70, oversold if below 30.
- Bollinger Bands (20,2): Identify price breakouts and volatility squeezes.
- MACD (12,26,9): Crossover signals for momentum shifts.
Strategy: Check for Bollinger Band breakouts confirmed by VWAP and a MACD crossover.
Computed indicators summary:
${summary}

Based on the above, provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a brief reason.
Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

/*
  Funkcia build15mMacroPrompt:
  - Vytvára prompt pre 15-minútové indikátory.
  - Vracia predpoveď o intradennom (swing) trende – bullish, bearish alebo neutral.
  - Komentár macro_comment by mal objasniť, prečo podľa indikátorov očakávame daný trend.
*/
function build15mMacroPrompt(symbol, min15Indicators) {
  const summary = buildIndicatorSummary(min15Indicators, "15m");
  return `
15-minute summary (Intraday Trading, Swing) for ${symbol}:
Indicators considered:
- EMA20 and EMA50: Identify short-term and medium-term trends.
- Fibonacci retracement levels: Used to find potential support/resistance.
- RSI (14) and Stochastic RSI: Indicate overbought or oversold conditions.
- OBV: Accumulation/distribution based on volume.
- ATR: Measures market volatility.
Strategy: Use Fibonacci retracement to identify correction levels and confirm trend with EMA and RSI divergences.
Computed indicators summary:
${summary}

Based on the above, provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a brief reason.
Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

/*
  Funkcia buildHourlyMacroPrompt:
  - Vytvára prompt pre hodinové indikátory.
  - Pomáha určiť dlhodobý trend a momentum.
  - Macro_view a macro_comment by mali jasne uviesť, či je trh bullish, bearish alebo neutral.
*/
function buildHourlyMacroPrompt(symbol, hourlyIndicators) {
  const summary = buildIndicatorSummary(hourlyIndicators, "1h");
  return `
Hourly summary (Swing Trading, Momentum) for ${symbol}:
Indicators considered:
- EMA50 and EMA200: Long-term trend identification.
- Ichimoku Cloud: Provides support and resistance levels and overall market sentiment.
- RSI (14): To detect potential reversals.
- Volume Profile (VPVR): Identifies key liquidity zones.
- MACD (12,26,9): Looks for momentum shifts.
Strategy: Wait for EMA crossover confirmation, then consider entries after retesting key support/resistance zones.
Computed indicators summary:
${summary}

Based on the above, provide a "macro_view" ("BULLISH", "BEARISH", or "NEUTRAL") and a brief reason.
Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

/*
  Funkcia buildFinalSynergyPrompt:
  - Kombinuje výsledky denných, týždenných a rôznych časových rámcov (15m, 5m, 1h) do finálneho promptu.
  - Cieľom je vytvoriť synergický pohľad, ktorý slúži ako konečné odporúčanie.
  - Do promptu sú zahrnuté aj komentáre od jednotlivých analýz, aby ste si mohli overiť, či celkový obraz vychádza bullish, bearish alebo neutral.
*/
function buildFinalSynergyPrompt(symbol, dailyMacro, weeklyMacro, tf15m, tf5m, tf1h, fromTime, toTime) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const weeklySummary = `weekly_view=${weeklyMacro.weekly_view}, reason=${weeklyMacro.weekly_comment}`;
  const sum15m = buildIndicatorSummary(tf15m, "15m");
  const sum5m = buildIndicatorSummary(tf5m, "5m");
  const sum1h = buildIndicatorSummary(tf1h, "1h");
  let dateRangeText = '';
  if (fromTime || toTime) {
    const fromTxt = fromTime ? formatTS(fromTime) : 'N/A';
    const toTxt = toTime ? formatTS(toTime) : 'N/A';
    dateRangeText = `Offline data timeframe: from ${fromTxt} to ${toTxt}.\n`;
  }
  return `
We have the following analyses for ${symbol}:

Daily Analysis:
${dailySummary}

Weekly Analysis:
${weeklySummary}

Short-term Analysis:
15m timeframe indicators:
${sum15m}
5m timeframe indicators:
${sum5m}
1h timeframe indicators:
${sum1h}

${dateRangeText}

Dynamic Weighting Instructions:
- Base weights: Short-term 5m = 50%, 15m = 25%, 1h = 25%.
- Adjust weights based on market volatility (if ATR is high, increase weight of short-term signals).
- Factor in momenta from indicators (EMA crossovers, MACD, etc.) and volume.

Risk Management:
- Determine stop_loss and target_profit levels based on ATR and Bollinger Bands.

Combine the above and return JSON in the following format (no extra text):
{
  "technical_signal_strength": <number>, 
  "final_action": "BUY" | "SELL" | "HOLD",
  "stop_loss": <number>,
  "target_profit": <number>,
  "comment": "short comment"
}
`;
}

/*
  Funkcia callOpenAI – volá OpenAI API s daným promptom a vracia JSON odpoveď.
  Výpisy logov tu vám pomôžu skontrolovať, či API odpovedá očakávaným formátom.
*/
async function callOpenAI(prompt) {
  try {
    console.log("[GPTServiceOffline] Volám OpenAI s promptom:\n", prompt);
    const response = await openAiClient.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: prompt }]
    });
    let raw = response.choices[0]?.message?.content || "";
    raw = raw.replace(/```(\w+)?/g, "").trim();
    console.log("[GPTServiceOffline] Raw odpoveď od OpenAI:", raw);
    const parsed = JSON.parse(raw);
    console.log("[GPTServiceOffline] Parsed odpoveď:", parsed);
    return parsed;
  } catch (err) {
    console.warn("[GPTServiceOffline] Error calling OpenAI:", err.message);
    return null;
  }
}

/*
  Funkcia analyzeSymbolChain:
  - Zostavuje analýzu pre daný symbol pomocou offline štatistík a indikátorov pre rôzne časové rámce.
  - Vytvára prompt-y pre dennú a týždennú analýzu, potom pre krátkodobé indikátory.
  - Nakoniec kombinuje tieto výsledky do finálneho synergického promptu, ktorý sa posiela OpenAI.
  - Výstup obsahuje hodnotenia (macro_view, weekly_view, final_action, atď.) a komentáre, ktoré vám umožnia skontrolovať, či je predpoveď "BULLISH", "BEARISH" alebo "NEUTRAL".
*/
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
  // Získame denné a týždenné štatistiky
  const dailyStats = offlineDailyStats(dailyDataSlice);
  const weeklyStats = offlineWeeklyStats(weeklyDataSlice);
  
  // Vytvoríme prompt pre dennú analýzu a získame odpoveď
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
  
  // Získame indikátory pre 15m, 1h a 5m timeframe
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
  
  // Vytvoríme prompt-y pre hodinovú, 15m a 5m analýzu – tieto pomôžu upresniť krátkodobý pohľad
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
  
  // Finálny synergický prompt, ktorý kombinuje denné, týždenné a krátkodobé analýzy
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
  
  // Vrátime objekt s výsledkami. Kampane "macro" komentáre vám pomôžu skontrolovať, či
  // API predpovedá BULLISH, BEARISH alebo NEUTRAL na základe poskytnutých indikátorov.
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