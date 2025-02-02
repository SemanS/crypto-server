const OpenAI = require('openai');
const { formatTS } = require('../utils/timeUtils');
// Predpokladáme, že externý modul offlineIndicators obsahuje funkcie:
// offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe
const { offlineDailyStats, offlineWeeklyStats, offlineIndicatorsForTimeframe } = require('./offlineIndicators');

// Vytvoríme jednorazovú inštanciu klienta
const openAiClient = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY
});

// Generátory promptov:

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

function buildIndicatorSummary(tfData) {
  if (!tfData) return 'N/A';
  const { timeframe, lastClose, lastRSI, lastMACD, lastSMA20, lastEMA50, lastBoll, lastADX, lastStochastic, lastATR, lastMFI, lastOBV } = tfData;
  const macdStr = lastMACD ? `MACD=${lastMACD.MACD?.toFixed(2)}, signal=${lastMACD.signal?.toFixed(2)}, hist=${lastMACD.histogram?.toFixed(2)}` : 'N/A';
  const bollStr = lastBoll ? `BollLower=${lastBoll.lower?.toFixed(2)}, mid=${lastBoll.mid?.toFixed(2)}, upper=${lastBoll.upper?.toFixed(2)}` : 'N/A';
  const adxStr = lastADX ? `ADX=${lastADX.adx?.toFixed(2)}, +DI=${lastADX.pdi?.toFixed(2)}, -DI=${lastADX.mdi?.toFixed(2)}` : 'N/A';

  return `
timeframe=${timeframe}, close=${lastClose?.toFixed(4)}
RSI(14)=${lastRSI?.toFixed(2)}
${macdStr}
SMA20=${lastSMA20?.toFixed(4)}
EMA50=${lastEMA50?.toFixed(4)}
${bollStr}
${adxStr}
Stoch=${lastStochastic ? `K=${lastStochastic.k?.toFixed(2)}, D=${lastStochastic.d?.toFixed(2)}` : 'N/A'}
ATR=${lastATR?.toFixed(4)}
MFI=${lastMFI?.toFixed(2)}
OBV=${lastOBV?.toFixed(2)}
`;
}

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
    fundamentalsText = 'Here are some fundamental/news articles:\n';
    fundamentals.articles.forEach((art, idx) => {
      fundamentalsText += `#${idx + 1} - "${art.title}" from ${art.source?.name || 'unknown'}, published at ${art.publishedAt}\n`;
    });
    fundamentalsText += '\nIncorporate relevant news into your conclusion.\n';
  }

  return `
We have daily macro: ${dailySummary}
We have weekly macro: ${weeklySummary}

Short-term analysis:
15m:
${sum15m}
1h:
${sum1h}
${dateRangeText}${fundamentalsText}
Use weightings:
- Daily macro: 30%
- Weekly macro: 40%
- Short-term (15m + 1h): 30%

Combine them into one final conclusion. Return JSON:
{
  "technical_signal_strength": 0, // value between 0 and 1
  "final_action": "BUY"|"SELL"|"HOLD",
  "comment": "short comment"
}
(No extra text.)
`;
}

// Helper funkcia na volanie OpenAI API
async function callOpenAI(prompt) {
  try {
    console.log('[GPTService] Sending prompt to OpenAI:', prompt);
    const response = await openAiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }]
    });
    let raw = response.choices[0]?.message?.content || '';
    raw = raw.replace(/```(\w+)?/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[GPTService] Error calling OpenAI:', err.message);
    return null;
  }
}

// Upravená hlavná funkcia reťazenej analýzy – teraz s parametrom fundamentals
async function analyzeSymbolChain(
  symbol,
  dailyDataSlice,
  weeklyDataSlice,
  min15DataSlice,
  hourDataSlice,
  fromTime,
  toTime,
  fundamentals  // nový parameter
) {
  let dailyStats, dailyMacro = { macro_view: 'NEUTRAL', macro_comment: 'No macro' };
  try {
    dailyStats = offlineDailyStats(dailyDataSlice);
    const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
    const dailyResult = await callOpenAI(dailyPrompt);
    if (dailyResult) dailyMacro = dailyResult;
  } catch (err) {
    console.error('[GPTService] Daily analysis error:', err.message);
  }

  let weeklyStats, weeklyMacro = { weekly_view: 'NEUTRAL', weekly_comment: 'No weekly' };
  try {
    weeklyStats = offlineWeeklyStats(weeklyDataSlice);
    const weeklyPrompt = buildWeeklyPrompt(symbol, weeklyStats);
    const weeklyResult = await callOpenAI(weeklyPrompt);
    if (weeklyResult) weeklyMacro = weeklyResult;
  } catch (err) {
    console.error('[GPTService] Weekly analysis error:', err.message);
  }

  let tf15m = null, tf1h = null;
  try {
    tf15m = offlineIndicatorsForTimeframe(min15DataSlice, '15m');
  } catch (err) {
    console.warn('[GPTService] 15m indicator error:', err.message);
  }
  try {
    tf1h = offlineIndicatorsForTimeframe(hourDataSlice, '1h');
  } catch (err) {
    console.warn('[GPTService] 1h indicator error:', err.message);
  }

  let finalSynergy = null;
  try {
    // Teraz odovzdáme aj fundamentals do generovania finálneho promptu
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
    finalSynergy = await callOpenAI(synergyPrompt);
  } catch (err) {
    console.error('[GPTService] Synergy analysis error:', err.message);
  }

  return {
    gptOutput: {
      final_action: finalSynergy?.final_action || 'HOLD',
      comment: finalSynergy?.comment || '',
      technical_signal_strength: finalSynergy?.technical_signal_strength || 0
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats,
    tfWeeklyStats: weeklyStats
  };
}

module.exports = { analyzeSymbolChain };