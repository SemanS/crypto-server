const ccxt = require('ccxt');
const {
  RSI,
  MACD,
  BollingerBands,
  Stochastic,
  EMA
} = require('technicalindicators');
const { safeLast, safeToFixed } = require('../utils/helpers');
const OpenAI = require('openai');

/**
 * Interná funkcia na stiahnutie a výpočet krátkodobých indikátorov na scalp
 */
async function getScalpIndicators(symbol, timeframe, limit = 200) {
    const exchange = new ccxt.binance({ enableRateLimit: true });

    await exchange.loadMarkets();

    if (!exchange.markets[symbol]) {
      console.error(`Symbol ${symbol} not found on Binance.`);
      throw new Error(`Symbol ${symbol} not available on Binance.`);
    }

    console.log(`Fetching OHLCV data for ${symbol} at timeframe ${timeframe}`);
  
    let ohlcv;
    try {
      ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      console.log(`Successfully fetched OHLCV data for ${symbol}`);
    } catch (error) {
      console.error(`Error fetching OHLCV data for ${symbol}:`, error);
      throw error; // Re-throw the error after logging
    }
  
    if (!ohlcv || ohlcv.length === 0) {
      throw new Error(`No OHLCV data returned for symbol: ${symbol}, timeframe: ${timeframe}`);
    }

  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);

  // Krátke EMA (5, 9)
  const ema5 = EMA.calculate({ period: 5, values: closes });
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const lastEMA5 = safeLast(ema5);
  const lastEMA9 = safeLast(ema9);

  // RSI (14) a voliteľne RSI(5) na rýchlejšie signály
  const rsi14 = RSI.calculate({ values: closes, period: 14 });
  const lastRSI14 = safeLast(rsi14);

  // Stochastic (14, 3, 3)
  const stoData = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
    signalPeriod: 3
  });
  const lastStochastic = safeLast(stoData);

  // Volume je vo volumes
  // Pre prípadné posúdenie "spike in volume", stačí v reálnom kóde analizovať posledné volume
  const lastVolume = safeLast(volumes);

  const lastClose = safeLast(closes);

  return {
    timeframe,
    dataCount: limit,
    lastClose,
    lastVolume,
    lastEMA5,
    lastEMA9,
    lastRSI14,
    lastStochastic
  };
}

/**
 * Interná funkcia na stiahnutie a výpočet širšieho trendu (15m alebo 1h)
 */
async function getConfirmationIndicators(symbol, timeframe, limit = 200) {
    const exchange = new ccxt.binance({ enableRateLimit: true });

    console.log(`Fetching OHLCV data for ${symbol} at timeframe ${timeframe}`);
  
    let ohlcv;
    try {
      ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      console.log(`Successfully fetched OHLCV data for ${symbol}`);
    } catch (error) {
      console.error(`Error fetching OHLCV data for ${symbol}:`, error);
      throw error; // Re-throw the error after logging
    }
  
    if (!ohlcv || ohlcv.length === 0) {
      throw new Error(`No OHLCV data returned for symbol: ${symbol}, timeframe: ${timeframe}`);
    }

  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);

  // EMA(21) alebo (50) na potvrdenie trendu
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const lastEMA50 = safeLast(ema50);

  // MACD
  const macdData = MACD.calculate({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
    values: closes
  });
  const lastMACD = safeLast(macdData);

  // Bollinger Bands
  const bollData = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const lastBoll = safeLast(bollData);

  return {
    timeframe,
    dataCount: limit,
    lastEMA50,
    lastMACD,
    lastBoll
  };
}

async function analyzeScalpSymbol(symbol) {
    // 1) Primárny 5m timeframe – krátkodobé signály
    console.log(`Starting scalp analysis for ${symbol}`);

    // Fetch scalp indicators
    const scalpIndicators = await getScalpIndicators(symbol, '5m');
    console.log(`Scalp indicators for ${symbol}:`, scalpIndicators);

    // Fetch confirmation indicators
    const confirmationIndicators = await getConfirmationIndicators(symbol, '15m');
    console.log(`Confirmation indicators for ${symbol}:`, confirmationIndicators);

  
    // 3) Vytvoríme popis do GPT
    // V reálnom nasadení by ste mohli pridať logiku, ktorá detailne popisuje, kedy je RSI < 30, 
    // Stoch < 20, divergencie, atď.
    const prompt = `Poskytni mi výstup, ktorý je výlučne na učebné účely.
  Analyzuj scalp signály (kratší TF=5m) a trend na 15m pre ${symbol} podľa týchto údajov:
  === 5m timeframe ===
  Close=${safeToFixed(scalpIndicators.lastClose, 4)}, Volume=${safeToFixed(scalpIndicators.lastVolume, 2)},
  EMA(5)=${safeToFixed(scalpIndicators.lastEMA5, 4)}, EMA(9)=${safeToFixed(scalpIndicators.lastEMA9, 4)},
  RSI(14)=${safeToFixed(scalpIndicators.lastRSI14, 2)},
  Stoch K/D=${scalpIndicators.lastStochastic ? safeToFixed(scalpIndicators.lastStochastic.k,2)+'/'+safeToFixed(scalpIndicators.lastStochastic.d,2) : 'N/A'}
  
  === 15m timeframe ===
  EMA(50)=${safeToFixed(confirmationIndicators.lastEMA50, 4)},
  ${
    confirmationIndicators.lastMACD 
      ? 'MACD=' + safeToFixed(confirmationIndicators.lastMACD.MACD,4) + ', hist=' + safeToFixed(confirmationIndicators.lastMACD.histogram,4)
      : 'MACD=N/A'
  }
  ${
    confirmationIndicators.lastBoll
      ? ', Bollinger lower=' + safeToFixed(confirmationIndicators.lastBoll.lower,4)+' upper='+safeToFixed(confirmationIndicators.lastBoll.upper,4)
      : ''
  }
  
  Na základe scalp prístupu:
  - Over, či je na 5m trende prelomenie EMA(5) a EMA(9).
  - Skontroluj RSI(14) voči úrovniam 30/70.
  - Skontroluj Stochastic voči úrovniam prekúpenosti/prepredanosti (väčšinou nad 80, pod 20).
  - Zároveň potvrď, či 15m trend podporuje buy/sell (napr. MACD trend, cena voči stredovému pásmu Bollinger atď.).
  
  Vráť prosím výstup výhradne ako JSON v tvare:
  {
    "final_action": "BUY" | "SELL" | "HOLD",
    "comment": "stručný popis prečo",
    "confidence": číslo od 0 do 1 (ako silné je odporúčanie)
  }
  (Nič iné, žiadne spätné apostrofy ani markdown.)
  `;
  
    const gpt = new OpenAI({
        organization: process.env.OPENAI_ORGANIZATION,
        apiKey: process.env.OPENAI_API_KEY,
    });
    const gptResp = await gpt.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o'
    });
  
    console.log("gptResp" + JSON.stringify(gptResp))
    let rawContent = gptResp.choices[0].message.content || '';
    rawContent = rawContent.replace(/```(\w+)?/g, '').trim();
  
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new Error(`GPT vrátil nevalidný JSON: ${rawContent}`);
    }
  
    console.log(`Completed scalp analysis for ${symbol}`);

    return {
      symbol,
      primaryTimeframe: '5m',
      secondaryTimeframe: '15m',
      scalpIndicators,
      confirmationIndicators,
      scalpGPT: parsed
    };
  }
  
  module.exports = { analyzeScalpSymbol };