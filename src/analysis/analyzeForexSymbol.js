const alpha = require('alphavantage')({ key: 'Azou22DB5v3w3Rl0MXF8Qj0s9G3Llq0V' });
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

async function analyzeForexSymbol(symbol, timeframe = '4h', limit = 200) {
  const [base, quote] = symbol.split('/');
  const interval = '60min'; // 1h

  // Upravené podľa novej dokumentácie (volanie s objektom)
  const avData = await alpha.forex.intraday({
    from_symbol: base,
    to_symbol: quote,
    interval: interval,
    outputsize: 'full',
    datatype: 'json'
  });

  const timeSeries = avData?.['Time Series FX (60min)'];
  if (!timeSeries) {
    throw new Error(`Chýbajú intraday dáta pre symbol ${symbol}`);
  }

  let ohlcv = Object.entries(timeSeries).map(([dateStr, candle]) => {
    const ts = new Date(dateStr).getTime();
    const openVal = parseFloat(candle['1. open']);
    const highVal = parseFloat(candle['2. high']);
    const lowVal = parseFloat(candle['3. low']);
    const closeVal = parseFloat(candle['4. close']);
    const volumeVal = 0; // alpha vantage vo forexe volume neposkytuje
    return [ts, openVal, highVal, lowVal, closeVal, volumeVal];
  });
  ohlcv.sort((a,b) => a[0] - b[0]);
  if (ohlcv.length > limit) {
    ohlcv = ohlcv.slice(-limit);
  }
  if (!ohlcv || ohlcv.length === 0) {
    throw new Error(`Nedostatok OHLCV dát pre ${symbol}`);
  }

  // Výpočet indikátorov
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);

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

  // GPT prompt
  const lastCandles = ohlcv.slice(-10).map(([ts, o, h, l, c, vol]) =>
    `timestamp=${ts}, open=${o}, high=${h}, low=${l}, close=${c}, volume=${vol}`
  ).join('\n');

  const indicatorsStr = `
=== Forex Indikátory (z ${ohlcv.length} sviečok, timeframe=${interval}) ===
RSI(14): ${safeToFixed(lastRSI, 2)}
MACD: ${
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

== Posledných 10 OHLCV (forex) ==
${lastCandles}
`;


  const promptText = `
Analyzuj trend na forex symbole ${symbol} (timeframe ~${interval}) na základe týchto indikátorov a posledných 10 OHLCV dát:
${indicatorsStr}

Vráť výsledok IBA ako validný JSON tvaru:
{
  "technical_signal_strength": číslo 0-1,
  "fundamental_signal_strength": číslo 0-1,
  "sentiment_signal_strength": číslo 0-1,
  "final_action": "BUY" alebo "SELL" alebo "HOLD",
  "comment": "Stručný komentár"
}
`;

  // Zavoláme GPT
  const gpt = new OpenAI({
    organization: process.env.OPENAI_ORGANIZATION,
    apiKey: process.env.OPENAI_API_KEY,
  });
  const gptResp = await gpt.chat.completions.create({
    messages: [{ role: 'user', content: promptText }],
    model: 'o1-preview'
  });
  let rawContent = gptResp.choices[0].message.content || '';
  rawContent = rawContent.replace(/```(\w+)?/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`GPT vrátil nevalidný JSON pre forex symbol ${symbol}:\n${rawContent}`);
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

module.exports = { analyzeForexSymbol };