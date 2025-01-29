const OpenAI = require('openai');
const {
  offlineDailyStats,
  offlineIndicatorsForTimeframe
} = require('./offlineIndicators'); // súbor s offlineDailyStats a offlineIndicatorsForTimeframe

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

function buildIndicatorSummaryOffline(tfData) {
  if (!tfData) return 'N/A tfData';

  const {
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

async function analyzeSymbolRobustChainingApproachOffline(
  symbol,
  dailyDataSlice,
  min15DataSlice,
  hourDataSlice
) {
  // 1) Získame štatistiky z daily timeframe (už nemá throw Error, ale fallback).
  let dailyStats;
  try {
    dailyStats = offlineDailyStats(dailyDataSlice);
  } catch (err) {
    // Tu vyslovene logneme, prečo offlineDailyStats padol
    console.error('[LOG:analyzeSymbolOffline] offlineDailyStats threw error:', err.message);
    console.warn('Skipping daily GPT macro analysis due to insufficient daily data (or invalid daily data).');
    // Vraceame fallback => GPT macro = NEUTRAL
    return {
      gptOutput: {
        final_action: 'HOLD',
        comment: 'Skipped daily macro due to insufficient daily data.'
      },
      tf15m: null,
      tf1h:  null,
      tfDailyStats: null
    };
  }

  // 2) Ak je dailyStats.hasEnoughData=true, vyrobíme dailyPrompt a pošleme GPT.
  let dailyParsed = { macro_view: 'NEUTRAL', macro_comment: 'N/A' };

    const openAiClient = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });

    const dailyPrompt = buildDailyPromptOffline(symbol, dailyStats);

    try {
      const resp1 = await openAiClient.chat.completions.create({
        messages: [{ role: 'user', content: dailyPrompt }],
        model: 'gpt-4o', // príklad, upravte podľa potreby
      });
      let raw1 = resp1.choices[0]?.message?.content || '';
      raw1     = raw1.replace(/```(\w+)?/g, '').trim();

      dailyParsed = JSON.parse(raw1);
    } catch (e) {
      console.warn("GPT offline macro daily parse error:", e.message);
    }

  // 3) Spočítame 15m a 1h indikátory
  const tf15m = offlineIndicatorsForTimeframe(min15DataSlice, '15m');
  const tf1h  = offlineIndicatorsForTimeframe(hourDataSlice, '1h');

  // 4) GPT #2 => synergy (krátkodobé)
  let synergyParsed = null;
  try {
    const openAiClient = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
    const synergyPrompt = buildShortPromptOffline(symbol, dailyParsed, tf15m, tf1h);

    const resp2 = await openAiClient.chat.completions.create({
      messages: [{ role: 'user', content: synergyPrompt }],
      model: 'gpt-4o',
    });
    let raw2 = resp2.choices[0]?.message?.content || '';
    raw2     = raw2.replace(/```(\w+)?/g, '').trim();
    synergyParsed = JSON.parse(raw2);
    console.log("synergyParsed", synergyParsed);
  } catch (e) {
    console.warn("GPT offline synergy parse error:", e.message);
  }

  // Spracovanie "final_action"
  let final_action = 'HOLD';
  let comment = '';
  if (synergyParsed && synergyParsed.final_action) {
    final_action = synergyParsed.final_action;
    comment = synergyParsed.comment || '';

    // Filtrovanie slabých signálov
    const techStr = synergyParsed.technical_signal_strength || 0;
    const fundStr = synergyParsed.fundamental_signal_strength || 0;
    const sentStr = synergyParsed.sentiment_signal_strength || 0;
    const avgStr  = (techStr + fundStr + sentStr) / 3;

    // Pod prahom 0.6 prepíšeme na HOLD
    if (avgStr < 0.6) {
      final_action = 'HOLD';
      comment += " [Signal overridden to HOLD due to low synergy score]";
    }
  }

  // Výstup
  return {
    gptOutput: {
      final_action,
      comment
    },
    tf15m,
    tf1h,
    tfDailyStats: dailyStats
  };
}

module.exports = {
  analyzeSymbolRobustChainingApproachOffline
};