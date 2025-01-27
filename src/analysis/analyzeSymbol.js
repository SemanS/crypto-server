const ccxt = require('ccxt');
const {
  RSI,
  MACD,
  SMA,
  BollingerBands,
  ADX,
  Stochastic,
  EMA,
  ATR,
  MFI,
  OBV
} = require('technicalindicators');
const { safeLast, safeToFixed } = require('../utils/helpers');
const OpenAI = require('openai');

async function analyzeSymbol(symbol, timeframe = '4h', limit = 200) {
  const exchange = new ccxt.binance({ enableRateLimit: true });

  // 1) Stiahneme OHLCV
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  if (!ohlcv || ohlcv.length === 0) {
    throw new Error(`Nedá sa načítať OHLCV z Binance pre symbol: ${symbol}`);
  }

  // Spracovanie stĺpcov
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);

  // Výpočet indikátorov
  const rsiData = RSI.calculate({ values: closes, period: 14 });
  const lastRSI = safeLast(rsiData);

  const macdData = MACD.calculate({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
    values: closes
  });
  const lastMACD = safeLast(macdData);

  const smaData = SMA.calculate({ period: 20, values: closes });
  const lastSMA20 = safeLast(smaData);

  const emaData = EMA.calculate({ period: 50, values: closes });
  const lastEMA50 = safeLast(emaData);

  const bollData = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const lastBoll = safeLast(bollData);

  const adxData = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });
  const lastADX = safeLast(adxData);

  const stoData = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
    signalPeriod: 3
  });
  const lastStochastic = safeLast(stoData);

  const atrData = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const lastATR = safeLast(atrData);

  const mfiData = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 });
  const lastMFI = safeLast(mfiData);

  const obvData = OBV.calculate({ close: closes, volume: volumes });
  const lastOBV = safeLast(obvData);

  const lastClose = safeLast(closes);

  // 2) GPT prompt - posledných 10 sviečok
  const lastCandles = ohlcv.slice(-10).map(([ts, openV, highV, lowV, closeV, volumeV]) =>
    `timestamp=${ts}, open=${openV}, high=${highV}, low=${lowV}, close=${closeV}, volume=${volumeV}`
  ).join('\n');

  const indicatorsStr = `
  === Indikátory (z ${limit} sviečok, timeframe=${timeframe}) === 
RSI(14): ${safeToFixed(lastRSI, 2)}
MACD(12,26,9): ${
  lastMACD
    ? `MACD=${safeToFixed(lastMACD.MACD, 4)}, signal=${safeToFixed(lastMACD.signal, 4)}, hist=${safeToFixed(lastMACD.histogram, 4)}`
    : 'N/A'
}
SMA(20): ${safeToFixed(lastSMA20, 4)}
EMA(50): ${safeToFixed(lastEMA50, 4)}
Boll(20,2): ${
  lastBoll
    ? `lower=${safeToFixed(lastBoll.lower, 4)}, mid=${safeToFixed(lastBoll.mid, 4)}, upper=${safeToFixed(lastBoll.upper, 4)}`
    : 'N/A'
}
ADX(14): ${
  lastADX
    ? `adx=${safeToFixed(lastADX.adx, 2)}, pdi=${safeToFixed(lastADX.pdi, 2)}, mdi=${safeToFixed(lastADX.mdi, 2)}`
    : 'N/A'
}
Stoch(14,3): ${
  lastStochastic
    ? `K=${safeToFixed(lastStochastic.k, 2)}, D=${safeToFixed(lastStochastic.d, 2)}`
    : 'N/A'
}
ATR(14): ${safeToFixed(lastATR, 4)}
MFI(14): ${safeToFixed(lastMFI, 2)}
OBV: ${safeToFixed(lastOBV, 2)}

== Posledných 10 OHLCV ==
${lastCandles}
`;

  const trendPrompt = `
Analyzuj strednodobý trend (timeframe: ${timeframe}) na ${symbol} na základe týchto indikátorov a posledných 10 OHLCV dát:
${indicatorsStr}

Vráť výsledok IBA ako validný JSON tvaru:
{
  "technical_signal_strength": číslo 0-1,
  "fundamental_signal_strength": číslo 0-1,
  "sentiment_signal_strength": číslo 0-1,
  "final_action": "BUY" alebo "SELL" alebo "HOLD",
  "comment": "Stručný komentár"
}
(Nič iné, žiadne backticky, žiadny text okolo.)
`;

  // 3) Zavoláme GPT
  const gpt = new OpenAI({
    organization: process.env.OPENAI_ORGANIZATION,
    apiKey: process.env.OPENAI_API_KEY,
  });
  const gptResp = await gpt.chat.completions.create({
    messages: [{ role: 'user', content: trendPrompt }],
    model: 'gpt-4o'
  });
  let rawContent = gptResp.choices[0].message.content || '';
  console.log("rawContent" + JSON.stringify(rawContent))
  rawContent = rawContent.replace(/```(\w+)?/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`GPT vrátil nevalidný JSON pre symbol ${symbol}:\n${rawContent}`);
  }

  const tech = parsed.technical_signal_strength || 0;
  const fund = parsed.fundamental_signal_strength || 0;
  const senti = parsed.sentiment_signal_strength || 0;
  const finalAction = parsed.final_action || 'HOLD';
  const comment = parsed.comment || '';
  const overallStrength = (tech + fund + senti) / 3.0;

  return {
    symbol,
    finalAction,
    comment,
    technical_signal_strength: tech,
    fundamental_signal_strength: fund,
    sentiment_signal_strength: senti,
    overallStrength,
    lastClose,
    // Diagnostické
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
  };
}

module.exports = { analyzeSymbol };