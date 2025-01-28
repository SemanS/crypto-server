const OpenAI = require('openai');
const ccxt = require('ccxt');

const {
  RSI, MACD, SMA, BollingerBands, ADX,
  Stochastic, EMA, ATR, MFI, OBV
} = require('technicalindicators');

const { 
  calcMean, calcStdev, calcSkewness, calcKurtosis,
  safeLast, safeToFixed
} = require('../utils/helpers');

// =============== Pomocné funkcie na fetch 1d, 15m, 1h  ====================

async function fetchDailyStats(exchange, symbol, limit=200) {
  // fetch daily OHLC
  const ohlcv = await exchange.fetchOHLCV(symbol, '1d', undefined, limit);
  if (!ohlcv || ohlcv.length < 2) {
    throw new Error(`No enough daily data for symbol=${symbol}`);
  }
  const closes = ohlcv.map(c => c[4]);
  const returns = [];
  for (let i=1; i<closes.length; i++){
    const ret = (closes[i]-closes[i-1]) / closes[i-1];
    returns.push(ret);
  }
  // compute stats
  const meanVal = calcMean(returns);
  const stdevVal= calcStdev(returns, meanVal);
  const minVal  = Math.min(...returns);
  const maxVal  = Math.max(...returns);
  const skewVal = calcSkewness(returns, meanVal, stdevVal);
  const kurtVal = calcKurtosis(returns, meanVal, stdevVal);

  return {
    meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
  };
}

async function fetchIndicatorsForTimeframe(exchange, symbol, timeframe, limit=200) {
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  if (!ohlcv || ohlcv.length === 0) {
    throw new Error(`Nedá sa načítať OHLCV pre ${symbol}, timeframe=${timeframe}`);
  }
  const highs   = ohlcv.map(c => c[2]);
  const lows    = ohlcv.map(c => c[3]);
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);

  const rsiData = RSI.calculate({ values: closes, period: 14 });
  const lastRSI = safeLast(rsiData);

  const macdData = MACD.calculate({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator:false, SimpleMASignal:false,
    values: closes
  });
  const lastMACD = safeLast(macdData);

  const sma20 = SMA.calculate({ period:20, values: closes });
  const lastSMA20 = safeLast(sma20);

  const ema50 = EMA.calculate({ period:50, values: closes });
  const lastEMA50 = safeLast(ema50);

  const bollData = BollingerBands.calculate({ period:20, values: closes, stdDev:2 });
  const lastBoll = safeLast(bollData);

  const adxData = ADX.calculate({ close:closes, high:highs, low:lows, period:14 });
  const lastADX = safeLast(adxData);

  const stoData = Stochastic.calculate({
    high: highs, low: lows, close: closes,
    period:14, signalPeriod:3
  });
  const lastStochastic = safeLast(stoData);

  const atrData = ATR.calculate({ high:highs, low:lows, close:closes, period:14 });
  const lastATR = safeLast(atrData);

  const mfiData = MFI.calculate({ high:highs, low:lows, close:closes, volume:volumes, period:14 });
  const lastMFI = safeLast(mfiData);

  const obvData = OBV.calculate({ close: closes, volume: volumes });
  const lastOBV = safeLast(obvData);

  const lastClose = safeLast(closes);
  const last10Candles = ohlcv.slice(-10).map(([ts,openV,hV,lV,cV,vol])=>
    `timestamp=${ts}, open=${openV}, high=${hV}, low=${lV}, close=${cV}, volume=${vol}`
  ).join('\n');

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
    lastOBV,
    last10Candles
  };
}

// =============== Pomocné funkcie na zostavenie promptov ====================

function buildDailyPrompt(symbol, dailyStats) {
  const { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal } = dailyStats;
  return `
## Macro / daily TAKE:
We have daily stats for ${symbol}:
mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}

Give me a short "macro_view": "BULLISH" or "BEARISH" or "NEUTRAL" plus a reason. Return JSON:
{
  "macro_view": "BULLISH/BEARISH/NEUTRAL",
  "macro_comment": "..."
}
(No extra text, no backticks.)
`;
}

function buildShortPrompt(symbol, dailyMacro, tf15m, tf1h) {
  // dailyMacro = { macro_view, macro_comment }
  // Tvoríme synergy
  const dailySummary = `macro_view=${dailyMacro.macro_view}, reason=${dailyMacro.macro_comment}`;
  const sum15m = buildIndicatorSummary(tf15m);
  const sum1h  = buildIndicatorSummary(tf1h);

  return `
We got from daily approach => ${dailySummary}

Now we have short-term (15m,1h) indicators:

15m:
${sum15m}

1h:
${sum1h}

Combine everything: daily macro_view + intraday signals.
Return final short-term decision. Valid JSON only:

{
  "technical_signal_strength": 0.0-1.0,
  "fundamental_signal_strength": 0.0-1.0,
  "sentiment_signal_strength": 0.0-1.0,
  "final_action": "BUY" or "SELL" or "HOLD",
  "comment": "some short comment"
}
(No extra text.)
`;
}

// ======================= HLAVNÁ FUNKCIA ==============================

async function analyzeSymbolRobustChainingApproach(exchange, symbol) {
  // 1) Načítame dailyStats
  const dailyStats = await fetchDailyStats(exchange, symbol, 200);

  // 2) GPT call #1: macro daily
  const gpt = new OpenAI({
    organization: process.env.OPENAI_ORGANIZATION,
    apiKey: process.env.OPENAI_API_KEY
  });

  const dailyPrompt = buildDailyPrompt(symbol, dailyStats);
  const gptResp1 = await gpt.chat.completions.create({
    messages: [{ role: 'user', content: dailyPrompt }],
    model: 'gpt-4o'
  });
  let dailyRaw   = gptResp1.choices[0]?.message?.content || '';
  dailyRaw       = dailyRaw.replace(/```(\w+)?/g, '').trim();

  let dailyParsed = { macro_view:"NEUTRAL", macro_comment:"N/A" };
  try {
    dailyParsed = JSON.parse(dailyRaw);
  } catch(e) {
    console.warn("Chaining approach: GPT1 invalid JSON:", dailyRaw);
  }

  // 3) fetch 15m, 1h
  const tf15mData = await fetchIndicatorsForTimeframe(exchange, symbol, '15m', 200);
  const tf1hData  = await fetchIndicatorsForTimeframe(exchange, symbol, '1h' , 200);

  // 4) GPT call #2: synergy
  const synergyPrompt = buildShortPrompt(symbol, dailyParsed, tf15mData, tf1hData);
  const gptResp2 = await gpt.chat.completions.create({
    messages: [{ role: 'user', content: synergyPrompt }],
    model: 'gpt-4o'
  });
  let synergyRaw = gptResp2.choices[0]?.message?.content || '';
  synergyRaw     = synergyRaw.replace(/```(\w+)?/g, '').trim();

  let synergyParsed = null;
  try {
    synergyParsed = JSON.parse(synergyRaw);
  } catch(e) {
    console.warn("Chaining approach: GPT2 invalid JSON:", synergyRaw);
  }

  // 5) extrakcia
  let final_action = 'HOLD';
  let tech = 0;
  let fund = 0;
  let senti= 0;
  let comment = '';

  if(synergyParsed && synergyParsed.final_action){
    final_action = synergyParsed.final_action;
    tech = synergyParsed.technical_signal_strength || 0;
    fund = synergyParsed.fundamental_signal_strength||0;
    senti= synergyParsed.sentiment_signal_strength||0;
    comment= synergyParsed.comment || '';
  }

  const confidence = (tech+fund+senti)/3;

  // 6) Vrátime
  return {
    dailyStats,
    macroView: dailyParsed.macro_view,
    macroComment: dailyParsed.macro_comment,
    tf15m: tf15mData,
    tf1h:  tf1hData,
    gptOutput:{
      final_action,
      technical_signal_strength: tech,
      fundamental_signal_strength: fund,
      sentiment_signal_strength: senti,
      confidence,
      comment
    }
  };
}

// Exports
module.exports = {
  analyzeSymbolRobustChainingApproach
};

// Môžete potom v route /reevaluateSymbol rozoznať, ak approach= "robustChaining", tak
// analyzeSymbolRobustChainingApproach.  

//-------------------------------------------------------------------
// Pomocná funkcia buildIndicatorSummary - skrátene. Rovnaká ako v kóde
//-------------------------------------------------------------------
function buildIndicatorSummary(tfData) {
  const {
    timeframe,
    lastRSI,
    lastMACD,
    lastSMA20,
    lastEMA50,
    lastBoll,
    lastADX,
    lastStochastic,
    lastATR,
    lastMFI,
    lastOBV,
    lastClose,
  } = tfData;

  const macdStr = lastMACD
    ? `MACD=${safeToFixed(lastMACD.MACD,4)}, signal=${safeToFixed(lastMACD.signal,4)}, hist=${safeToFixed(lastMACD.histogram,4)}`
    : 'N/A';
  const bollStr = lastBoll
    ? `BollLower=${safeToFixed(lastBoll.lower,4)}, BollMid=${safeToFixed(lastBoll.mid,4)}, BollUpper=${safeToFixed(lastBoll.upper,4)}`
    : 'N/A';
  const adxStr  = lastADX
    ? `ADX=${safeToFixed(lastADX.adx,2)}, +DI=${safeToFixed(lastADX.pdi,2)}, -DI=${safeToFixed(lastADX.mdi,2)}`
    : 'N/A';

  return `
Timeframe=${timeframe}, close=${safeToFixed(lastClose,4)}
RSI(14)=${safeToFixed(lastRSI,2)}
${macdStr}
SMA20=${safeToFixed(lastSMA20,4)}
EMA50=${safeToFixed(lastEMA50,4)}
${bollStr}
${adxStr}
Stoch(14,3)=${lastStochastic?`K=${safeToFixed(lastStochastic.k,2)},D=${safeToFixed(lastStochastic.d,2)}`:'N/A'}
ATR(14)=${safeToFixed(lastATR,4)}
MFI(14)=${safeToFixed(lastMFI,2)}
OBV=${safeToFixed(lastOBV,2)}
`;
}


module.exports = {
    analyzeSymbolRobustChainingApproach
  };