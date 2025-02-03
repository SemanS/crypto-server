const OpenAI = require('openai');
const { formatTS } = require('../utils/timeUtils');
const {
  offlineDailyStats,
  offlineWeeklyStats,
  offlineIndicatorsForTimeframe
} = require('./offlineIndicators');

// Vytvoríme jednorazovú inštanciu OpenAI klienta
const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

// --------------------------------------------------------
// PROMPT GENERATORY
// --------------------------------------------------------

// Vytvorí prompt pre dennú analýzu na základe štatistík
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

// Vytvorí prompt pre týždennú analýzu
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

// Vytvorí krátky prehľad indikátorov pre daný timeframe
function buildIndicatorSummary(tfData) {
  if (!tfData) return 'N/A';
  
  let summary = `timeframe=${tfData.timeframe}, close=${tfData.lastClose?.toFixed(4)}\n`;
  
  // Trendové indikátory
  if (tfData.lastEMA9) summary += `EMA9=${tfData.lastEMA9.toFixed(2)}\n`;
  if (tfData.lastEMA21) summary += `EMA21=${tfData.lastEMA21.toFixed(2)}\n`;
  if (tfData.lastEMA50) summary += `EMA50=${tfData.lastEMA50.toFixed(2)}\n`;
  if (tfData.lastEMA200) summary += `EMA200=${tfData.lastEMA200.toFixed(2)}\n`;
  if (tfData.lastSupertrend) summary += `Supertrend=${tfData.lastSupertrend.toFixed(2)}\n`;
  if (tfData.lastPSAR) summary += `PSAR=${tfData.lastPSAR.toFixed(2)}\n`;
  if (tfData.lastVWAP) summary += `VWAP=${tfData.lastVWAP.toFixed(2)}\n`;
  if (tfData.lastHMA) summary += `HMA=${tfData.lastHMA.toFixed(2)}\n`;
  
  // Oscilátory
  if (tfData.lastRSI) summary += `RSI=${tfData.lastRSI.toFixed(2)}\n`;
  if (tfData.lastMACD) {
    summary += `MACD=${tfData.lastMACD.MACD?.toFixed(2)}, signal=${tfData.lastMACD.signal?.toFixed(2)}, hist=${tfData.lastMACD.histogram?.toFixed(2)}\n`;
  }
  if (tfData.lastStochastic) {
    summary += `Stoch: K=${tfData.lastStochastic.k?.toFixed(2)}, D=${tfData.lastStochastic.d?.toFixed(2)}\n`;
  }
  
  // Objemové indikátory
  if (tfData.lastOBV) summary += `OBV=${tfData.lastOBV.toFixed(2)}\n`;
  if (tfData.lastMFI) summary += `MFI=${tfData.lastMFI.toFixed(2)}\n`;
  
  // Volatilné indikátory
  if (tfData.lastBoll) {
    summary += `Bollinger Bands: lower=${tfData.lastBoll.lower?.toFixed(2)}, mid=${tfData.lastBoll.mid?.toFixed(2)}, upper=${tfData.lastBoll.upper?.toFixed(2)}\n`;
  }
  if (tfData.lastADX) {
    summary += `ADX=${tfData.lastADX.adx?.toFixed(2)}, +DI=${tfData.lastADX.pdi?.toFixed(2)}, -DI=${tfData.lastADX.mdi?.toFixed(2)}\n`;
  }
  if (tfData.lastATR) summary += `ATR=${tfData.lastATR.toFixed(2)}\n`;
  
  // Indikátory pre scalping
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

// Kombinuje všetky analyzy do finálneho synergického promptu
function buildFinalSynergyPrompt(symbol, dailyMacro, weeklyMacro, tf15m, tf1h, fromTime, toTime, fundamentals) {
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
  
  let fundamentalsText = '';
  if (fundamentals && fundamentals.articles && fundamentals.articles.length > 0) {
    fundamentalsText = 'Fundamental/News articles:\n';
    fundamentals.articles.forEach((art, idx) => {
      fundamentalsText += `#${idx + 1} - "${art.title}" from ${art.source?.name || 'unknown'}, published at ${art.publishedAt}\n`;
    });
    fundamentalsText += '\nIncorporate relevant news into your conclusion.\n';
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
${fundamentalsText}

Dynamic Weighting Instructions:
- Base weights (initially): Daily Macro = 30%, Weekly Macro = 40%, Short-term (15m + 1h) = 30%.
- Adjust weights based on market volatility (for example, if ATR is high, weight short-term signals higher).
- Factor in momentum from advanced indicators (EMA crossovers, MACD, etc.) and volume data.
- Incorporate fundamental news where applicable.

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

// --------------------------------------------------------
// FUNKCIA NA VOLANIE OPENAI API
// --------------------------------------------------------
async function callOpenAI(prompt) {
  try {
    console.log('[GPTService] Sending prompt to OpenAI:', prompt);
    const response = await openAiClient.chat.completions.create({
      model: 'o3-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    let raw = response.choices[0]?.message?.content || '';
    // Odstráni prípadné bloky s kódom (napr. "```")
    raw = raw.replace(/```(\w+)?/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[GPTService] Error calling OpenAI:', err.message);
    return null;
  }
}

// --------------------------------------------------------
// HLAVNÁ FUNKCIA: gptServiceOffline
// --------------------------------------------------------
/*
  Funkcia gptServiceOffline spája offline štatistiky a indikátory a vytvára
  finálny synergický prompt, ktorý odošle do OpenAI pomocou callOpenAI.
  
  Parametre:
    symbol          - názov páru/symbolu
    dailyDataSlice  - denné dáta pre backtest (pole)
    weeklyDataSlice - týždenné dáta pre backtest (pole)
    min15DataSlice  - 15minutové dáta
    hourDataSlice   - hodinové dáta
    fromTime, toTime- časové obdobie (užitočné pre prompt)
    fundamentals    - objekt s fundamentálnymi článkami/news (voliteľné)
  
  Vráti objekt s gptOutput (final_action, stop_loss, target_profit, comment)
  a dodatočnými štatistikami.
*/
async function gptServiceOffline(
  symbol,
  dailyDataSlice,
  weeklyDataSlice,
  min15DataSlice,
  hourDataSlice,
  fromTime,
  toTime,
  fundamentals
) {
  // Vypočítame denné a týždenné štatistiky
  const dailyStats = offlineDailyStats(dailyDataSlice);
  const weeklyStats = offlineWeeklyStats(weeklyDataSlice);
  
  // Zostavíme prompt pre dennú a týždennú analýzu a spustíme paralelné API volania
  const dailyPromise = callOpenAI(buildDailyPrompt(symbol, dailyStats))
    .catch(err => {
      console.error('[GPTService] Daily analysis error:', err.message);
      return { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
    });
  const weeklyPromise = callOpenAI(buildWeeklyPrompt(symbol, weeklyStats))
    .catch(err => {
      console.error('[GPTService] Weekly analysis error:', err.message);
      return { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };
    });
  
  // Paralelne získame indikátory pre timeframe 15m a 1h
  const [tf15m, tf1h] = await Promise.all([
    Promise.resolve(offlineIndicatorsForTimeframe(min15DataSlice, '15m'))
      .catch(err => {
        console.warn('[GPTService] 15m indicator error:', err.message);
        return null;
      }),
    Promise.resolve(offlineIndicatorsForTimeframe(hourDataSlice, '1h'))
      .catch(err => {
        console.warn('[GPTService] 1h indicator error:', err.message);
        return null;
      })
  ]);
  
  const [dailyResult, weeklyResult] = await Promise.all([dailyPromise, weeklyPromise]);
  
  const dailyMacro = dailyResult || { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
  const weeklyMacro = weeklyResult || { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };

  // Vytvoríme finálny synergy prompt
  const synergyPrompt = buildFinalSynergyPrompt(
    symbol,
    dailyMacro,
    weeklyMacro,
    tf15m,
    tf1h,
    fromTime,
    toTime,
    fundamentals
  );
  
  let finalSynergy = null;
  try {
    finalSynergy = await callOpenAI(synergyPrompt);
  } catch (err) {
    console.error('[GPTService] Synergy analysis error:', err.message);
  }
  
  console.log('[GPTService] Final Synergy:', JSON.stringify(finalSynergy));
  
  return {
    gptOutput: {
      final_action: finalSynergy?.final_action || 'HOLD',
      technical_signal_strength: finalSynergy?.technical_signal_strength || 0,
      stop_loss: finalSynergy?.stop_loss || null,
      target_profit: finalSynergy?.target_profit || null,
      comment: finalSynergy?.comment || ''
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats,
    tfWeeklyStats: weeklyStats
  };
}

// Export funkcií
module.exports = {
  gptServiceOffline,
  callOpenAI
};
