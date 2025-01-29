const OpenAI = require('openai');
const {
  offlineDailyStats,
  offlineWeeklyStats,
  offlineIndicatorsForTimeframe
} = require('./offlineIndicators');

/** 
 * Rýchle generovanie promptu pre daily GPT 
 */
function buildDailyPromptOffline(symbol, dailyStats) {
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

/** 
 * Nová funkcia na generovanie promptu pre weekly GPT 
 */
function buildWeeklyPromptOffline(symbol, weeklyStats) {
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
 * Pôvodná pomocná funkcia na zhrnutie indikátorov pre ľubovoľný timeframe
 */
function buildIndicatorSummaryOffline(tfData) {
  if (!tfData) return 'N/A tfData';
  const {
    timeframe,
    lastClose, lastRSI, lastMACD, lastSMA20, lastEMA50,
    lastBoll, lastADX, lastStochastic, lastATR, lastMFI, lastOBV
  } = tfData;

  const macdStr = lastMACD
    ? `MACD=${lastMACD.MACD?.toFixed(2)}, signal=${lastMACD.signal?.toFixed(2)}, hist=${lastMACD.histogram?.toFixed(2)}`
    : 'N/A';
  const bollStr = lastBoll
    ? `BollLower=${lastBoll.lower?.toFixed(2)}, mid=${lastBoll.mid?.toFixed(2)}, upper=${lastBoll.upper?.toFixed(2)}`
    : 'N/A';
  const adxStr  = lastADX
    ? `ADX=${lastADX.adx?.toFixed(2)}, +DI=${lastADX.pdi?.toFixed(2)}, -DI=${lastADX.mdi?.toFixed(2)}`
    : 'N/A';

  return `
timeframe=${timeframe}, close=${lastClose?.toFixed(4)}
RSI(14)=${lastRSI?.toFixed(2)}
${macdStr}
SMA20=${lastSMA20?.toFixed(4)}
EMA50=${lastEMA50?.toFixed(4)}
${bollStr}
${adxStr}
Stoch=${lastStochastic? `K=${lastStochastic.k?.toFixed(2)},D=${lastStochastic.d?.toFixed(2)}` : 'N/A'}
ATR=${lastATR?.toFixed(4)}
MFI=${lastMFI?.toFixed(2)}
OBV=${lastOBV?.toFixed(2)}
`;
}

/**
 * Nová finálna synergia, ktorá zohľadní daily aj weekly makro a krátkodobé časové rámce.
 * Zadefinujeme váhy: daily = 30%, weekly = 40%, short-term(15m+1h) = 30%
 */
function buildFinalSynergyPromptOffline(symbol, dailyMacro, weeklyMacro, tf15m, tf1h) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const weeklySummary = `weekly_view=${weeklyMacro.weekly_view}, reason=${weeklyMacro.weekly_comment}`;

  const sum15m = buildIndicatorSummaryOffline(tf15m);
  const sum1h  = buildIndicatorSummaryOffline(tf1h);

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

/**
 * analyzeSymbolRobustChainingApproachOffline rozšírené o weekly:
 *  1) dailyStats
 *  2) GPT #1 => daily macro
 *  3) weeklyStats
 *  4) GPT #2 => weekly macro
 *  5) 15m, 1h indikátory
 *  6) GPT #3 => synergy (kombinujúca daily, weekly, short term)
 */
async function analyzeSymbolRobustChainingApproachOffline(
  symbol,
  dailyDataSlice,
  weeklyDataSlice,    // <--- Nový parameter pre weekly dáta
  min15DataSlice,
  hourDataSlice
) {
  // 1) dailyStats
  let dailyStats;
  try {
    dailyStats = offlineDailyStats(dailyDataSlice);
  } catch (err) {
    console.error('[LOG:analyzeSymbolOffline] offlineDailyStats error:', err.message);
    // Fallback => hold
    return {
      gptOutput: { final_action:'HOLD', comment:'Insufficient daily data => skip macro.' },
      tf15m: null, tf1h: null, tfDailyStats: null
    };
  }

  // 2) GPT #1 => daily macro
  let dailyParsed = { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
  try {
    const dailyPrompt = buildDailyPromptOffline(symbol, dailyStats);
    const openAiClient = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log("[LOG] dailyPrompt =>", dailyPrompt);
    const resp1 = await openAiClient.chat.completions.create({
      model: 'o1-preview',
      messages: [{ role: 'user', content: dailyPrompt }]
    });
    let raw1 = resp1.choices[0]?.message?.content || '';
    raw1 = raw1.replace(/```(\w+)?/g, '').trim();
    dailyParsed = JSON.parse(raw1);
    console.log("[LOG] dailyParsed =>", dailyParsed);
  } catch (e) {
    console.warn("GPT offline daily macro parse error:", e.message);
  }

  let weeklyStats;
  try {
    weeklyStats = offlineWeeklyStats(weeklyDataSlice);
  } catch (err) {
    console.error('[LOG:analyzeSymbolOffline] offlineWeeklyStats error:', err.message);
    // Fallback => no weekly
    weeklyStats = null;
  }

  // 4) GPT #2 => weekly macro
  let weeklyParsed = { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };
  if (weeklyStats) {
    try {
      const weeklyPrompt = buildWeeklyPromptOffline(symbol, weeklyStats);
      const openAiClient = new OpenAI({
        organization: process.env.OPENAI_ORGANIZATION,
        apiKey: process.env.OPENAI_API_KEY
      });
      console.log("[LOG] weeklyPrompt =>", weeklyPrompt);
      const resp2 = await openAiClient.chat.completions.create({
        model: 'o1-preview',
        messages: [{ role: 'user', content: weeklyPrompt }]
      });
      let raw2 = resp2.choices[0]?.message?.content || '';
      raw2 = raw2.replace(/```(\w+)?/g, '').trim();
      weeklyParsed = JSON.parse(raw2);
      console.log("[LOG] weeklyParsed =>", weeklyParsed);
    } catch (e) {
      console.warn("GPT offline weekly macro parse error:", e.message);
    }
  }

  // 5) 15m, 1h indicators (tu pridáme try-catch bloky)
  let tf15m = null;
  let tf1h  = null;

  try {
    tf15m = offlineIndicatorsForTimeframe(min15DataSlice, '15m');
  } catch (err) {
    console.warn(`[LOG] No 15m data for symbol=${symbol}:`, err.message);
    // tf15m ostáva null, v buildIndicatorSummaryOffline sa to zobrazí ako "N/A tfData"
  }

  try {
    tf1h  = offlineIndicatorsForTimeframe(hourDataSlice, '1h');
  } catch (err) {
    console.warn(`[LOG] No 1h data for symbol=${symbol}:`, err.message);
    // tf1h ostáva null
  }

  // 6) GPT #3 => synergy (combine daily, weekly, short-timeframe)
  let synergyParsed = null;
  try {
    const synergyPrompt = buildFinalSynergyPromptOffline(symbol, dailyParsed, weeklyParsed, tf15m, tf1h);
    const openAiClient = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
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
    console.warn("GPT offline synergy parse error:", e.message);
  }

  // Uložíme finálne rozhodnutie:
  let final_action = synergyParsed?.final_action || 'HOLD';
  let comment      = synergyParsed?.comment || '';

  return {
    gptOutput: {
      final_action,
      comment,
      technical_signal_strength: synergyParsed?.technical_signal_strength || 0,
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats,
    tfWeeklyStats: weeklyStats
  };
}

module.exports = {
  analyzeSymbolRobustChainingApproachOffline
};
