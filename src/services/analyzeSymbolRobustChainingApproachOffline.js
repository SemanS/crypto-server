const OpenAI = require('openai');
const {
  offlineDailyStats,
  offlineIndicatorsForTimeframe
} = require('./offlineIndicators');

/** 
 * Rýchle generovanie daily prompt a synergy prompt 
 */
function buildDailyPromptOffline(symbol, dailyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
  return `
Offline daily stats for ${symbol}:
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

Please give me a "macro_view": "BULLISH" or "BEARISH" or "NEUTRAL" and a reason. Return JSON:
{
  "macro_view": "...",
  "macro_comment": "..."
}
(No extra text.)
`;
}

function buildShortPromptOffline(symbol, dailyMacro, tf15m, tf1h) {
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const sum15m = buildIndicatorSummaryOffline(tf15m);
  const sum1h  = buildIndicatorSummaryOffline(tf1h);

  return `
We have offline daily macro => ${dailySummary}

Now short-term (15m,1h) analysis:
15m:
${sum15m}
1h:
${sum1h}

Combine them. Return JSON:
{
  "technical_signal_strength": 0.0-1.0,
  "fundamental_signal_strength": 0.0-1.0,
  "sentiment_signal_strength": 0.0-1.0,
  "final_action": "BUY"/"SELL"/"HOLD",
  "comment": "some short comment"
}
(No extra text.)
`;
}

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
 * analyzeSymbolRobustChainingApproachOffline:
 *  - spočíta dailyStats, 1h, 15m
 *  - GPT daily => macro
 *  - GPT synergy => short term
 *  - NEOVERRIDE final_action => vrátime tak, ako GPT prikázala.
 */
async function analyzeSymbolRobustChainingApproachOffline(
  symbol,
  dailyDataSlice,
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
    const resp1 = await openAiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: dailyPrompt }]
    });
    let raw1 = resp1.choices[0]?.message?.content || '';
    raw1 = raw1.replace(/```(\w+)?/g, '').trim();
    dailyParsed = JSON.parse(raw1);
  } catch (e) {
    console.warn("GPT offline macro daily parse error:", e.message);
  }

  // 3) 15m, 1h indicators
  const tf15m = offlineIndicatorsForTimeframe(min15DataSlice, '15m');
  const tf1h  = offlineIndicatorsForTimeframe(hourDataSlice, '1h');

  // 4) GPT #2 => synergy
  let synergyParsed = null;
  try {
    const synergyPrompt = buildShortPromptOffline(symbol, dailyParsed, tf15m, tf1h);
    const openAiClient = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
    const resp2 = await openAiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: synergyPrompt }]
    });
    let raw2 = resp2.choices[0]?.message?.content || '';
    raw2 = raw2.replace(/```(\w+)?/g, '').trim();
    synergyParsed = JSON.parse(raw2);
    console.log("[LOG synergy] synergyParsed =>", synergyParsed);
  } catch (e) {
    console.warn("GPT offline synergy parse error:", e.message);
  }

  // V minulom kóde sme prepisovali SELL->HOLD ak synergyAvg<0.6
  // -> to spôsobovalo 0 PnL. Teraz to NEROBÍME => vrátime final_action priamo z synergy.

  let final_action = synergyParsed?.final_action || 'HOLD';
  let comment      = synergyParsed?.comment || '';

  return {
    gptOutput: {
      final_action,
      comment,
      technical_signal_strength: synergyParsed?.technical_signal_strength || 0,
      fundamental_signal_strength: synergyParsed?.fundamental_signal_strength || 0,
      sentiment_signal_strength: synergyParsed?.sentiment_signal_strength || 0
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats
  };
}

module.exports = {
  analyzeSymbolRobustChainingApproachOffline
};