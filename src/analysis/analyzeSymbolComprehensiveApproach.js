const OpenAI = require('openai');
const {
    RSI, MACD, SMA, BollingerBands, ADX, Stochastic, EMA, ATR, MFI, OBV
  } = require('technicalindicators');
const { calcKurtosis, calcSkewness, calcStdev, calcMean, safeLast, safeToFixed } = require('../utils/helpers');

async function fetchIndicatorsForTimeframe(exchange, symbol, timeframe, limit) {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    if (!ohlcv || ohlcv.length === 0) {
      throw new Error(`Nedá sa načítať OHLCV pre ${symbol}, timeframe=${timeframe}`);
    }
  
    // Rozdelenie stĺpcov
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);
    const volumes = ohlcv.map(c => c[5]);
  
    // Výpočet rôznych indikátorov
    const rsiData = RSI.calculate({ values: closes, period: 14 });
    const lastRSI = safeLast(rsiData);
  
    const macdData = MACD.calculate({
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
      values: closes
    });
    const lastMACD = safeLast(macdData);
  
    const sma20 = SMA.calculate({ period: 20, values: closes });
    const lastSMA20 = safeLast(sma20);
  
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const lastEMA50 = safeLast(ema50);
  
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
  
    // Uložíme posledných 10 sviečok do stringu, aby sme mohli poslať GPT
    const last10Candles = ohlcv.slice(-10).map(([ts, openV, highV, lowV, closeV, vol]) =>
      `timestamp=${ts}, open=${openV}, high=${highV}, low=${lowV}, close=${closeV}, volume=${vol}`
    ).join('\n');
  
    return {
      timeframe,
      ohlcv,          // celé dáta, ak by bolo treba
      last10Candles,  // string s poslednými 10 sviečkami
      // Indikátory
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

/**
 * Vytvorí reťazec s prehľadom indikátorov, podobne ako v pôvodnom analyzeSymbol.
 */
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
      last10Candles
    } = tfData;
  
    const macdStr = lastMACD
      ? `MACD=${safeToFixed(lastMACD.MACD, 4)}, signal=${safeToFixed(lastMACD.signal, 4)}, hist=${safeToFixed(lastMACD.histogram, 4)}`
      : 'N/A';
  
    const bollStr = lastBoll
      ? `lower=${safeToFixed(lastBoll.lower, 4)}, mid=${safeToFixed(lastBoll.mid, 4)}, upper=${safeToFixed(lastBoll.upper, 4)}`
      : 'N/A';
  
    const adxStr = lastADX
      ? `adx=${safeToFixed(lastADX.adx, 2)}, pdi=${safeToFixed(lastADX.pdi, 2)}, mdi=${safeToFixed(lastADX.mdi, 2)}`
      : 'N/A';
  
    const stochStr = lastStochastic
      ? `K=${safeToFixed(lastStochastic.k, 2)}, D=${safeToFixed(lastStochastic.d, 2)}`
      : 'N/A';
  
    return `
  === Timeframe: ${timeframe} ===
  Close: ${safeToFixed(lastClose, 4)}
  
  RSI(14): ${safeToFixed(lastRSI, 2)}
  MACD(12,26,9): ${macdStr}
  SMA(20): ${safeToFixed(lastSMA20, 4)}
  EMA(50): ${safeToFixed(lastEMA50, 4)}
  Boll(20,2): ${bollStr}
  ADX(14): ${adxStr}
  Stochastic(14,3): ${stochStr}
  ATR(14): ${safeToFixed(lastATR, 4)}
  MFI(14): ${safeToFixed(lastMFI, 2)}
  OBV: ${safeToFixed(lastOBV, 2)}
  
  == Posledných 10 sviečok (timeframe: ${timeframe}) ==
  ${last10Candles}
  `;
  }
  

  // ---------- Pomocná funkcia, ktorá vytvorí synergy Prompt pre GPT -----------
function buildComprehensivePrompt(symbol, { dailyStats, tf15mData, tf1hData }) {
    // dailyStats obsahuje meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
    const {
      meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
    } = dailyStats;
  
    // Napríklad sem vložíme krátky prehľad daily
    const dailyStatsStr = `
  ===== Daily Stats (1d, ~200 barov) =====
  mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)}
  `;
  
    const summary15m = buildIndicatorSummary(tf15mData);
    const summary1h  = buildIndicatorSummary(tf1hData);
  
    // Teraz vytvoríme synergy prompt
    // vyzveme GPT, aby zohľadnil daily štatistiky + 15m, 1h
    return `
  Na základe nasledujúcich dlhodobých (daily) štatistík a krátkodobých intradenných indikátorov:
  ${dailyStatsStr}
  
  ======== 15m Info ========
  ${summary15m}
  
  ======== 1h Info ========
  ${summary1h}
  
  Zohľadni prosím tieto dáta (mean, stdev, min, max, skew, kurt, RSI, MACD atď.)
  a rozhodni krátkodobý (intraday / scalp) signál pre symbol ${symbol}.
  
  Vráť výsledok IBA ako validný JSON v tvare:
  {
    "technical_signal_strength": 0.0-1.0,
    "fundamental_signal_strength": 0.0-1.0,
    "sentiment_signal_strength": 0.0-1.0,
    "final_action": "BUY" alebo "SELL" alebo "HOLD",
    "comment": "stručný komentár"
  }
  (žiadne backticky ani text okolo)
  `;
  }

async function analyzeSymbolComprehensiveApproach(exchange, symbol) {
    // (A) Najprv denné dáta -> štatistiky
    // Napr. 200 denné barov
    const dailyLimit = 200;
    const dailyOhlcv = await exchange.fetchOHLCV(symbol, '1d', undefined, dailyLimit);
    if (!dailyOhlcv || dailyOhlcv.length < 2) {
      throw new Error(`Nedostatok denných dát pre symbol=${symbol}`);
    }
    // Vypočítame daily returns
    const closes = dailyOhlcv.map(c => c[4]);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const ret = (closes[i] - closes[i-1]) / closes[i-1];
      returns.push(ret);
    }
    const meanVal = calcMean(returns);
    const stdevVal = calcStdev(returns, meanVal);
    const minVal = Math.min(...returns);
    const maxVal = Math.max(...returns);
    const skewVal = calcSkewness(returns, meanVal, stdevVal);
    const kurtVal = calcKurtosis(returns, meanVal, stdevVal);
  
    // (B) 15m, 1h analýza (bez GPT) – tj. spočítame indikátory
    // Pôžička z multiTF
    const data15m = await fetchIndicatorsForTimeframe(exchange, symbol, '15m', 200);
    const data1h  = await fetchIndicatorsForTimeframe(exchange, symbol, '1h', 200);
  
    // (C) Postavíme prompt aj pre daily stats + summary 15m, summary 1h
    const synergyPrompt = buildComprehensivePrompt(symbol, {
      dailyStats: { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal },
      tf15mData: data15m,
      tf1hData:  data1h
    });
  
    // (D) Zavoláme GPT
    const gpt = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
  
    const gptResp = await gpt.chat.completions.create({
      messages: [{ role: 'user', content: synergyPrompt }],
      model: 'gpt-4o'  // prispôsobte model
    });
    let rawContent = gptResp.choices[0]?.message?.content || '';
    rawContent = rawContent.replace(/```(\w+)?/g, '').trim();
  
    // (E) Parsovanie JSON
    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      console.warn("GPT invalid JSON synergy:", rawContent);
    }
  
    // (F) extrakcia
    let final_action = 'HOLD';
    let technical_strength = 0;
    let fundamental_strength = 0;
    let sentiment_strength = 0;
    let comment = '';
  
    if (parsed && parsed.final_action) {
      final_action = parsed.final_action;
      technical_strength = parsed.technical_signal_strength || 0;
      fundamental_strength = parsed.fundamental_signal_strength || 0;
      sentiment_strength = parsed.sentiment_signal_strength || 0;
      comment = parsed.comment || '';
    }
  
    const confidence = (technical_strength + fundamental_strength + sentiment_strength) / 3;
  
    // Vrátime podobný objekt
    return {
      tfDailyStats: {
        meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal
      },
      tf15m: data15m,
      tf1h:  data1h,
      gptOutput: {
        final_action,
        technical_signal_strength: technical_strength,
        fundamental_signal_strength: fundamental_strength,
        sentiment_signal_strength: sentiment_strength,
        confidence,
        comment
      }
    };
  }

  module.exports = {
    analyzeSymbolComprehensiveApproach
  };