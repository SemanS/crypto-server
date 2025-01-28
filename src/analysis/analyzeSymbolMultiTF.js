const {
    RSI, MACD, SMA, BollingerBands, ADX, Stochastic, EMA, ATR, MFI, OBV
  } = require('technicalindicators');
  const { safeLast, safeToFixed } = require('../utils/helpers');
  const OpenAI = require('openai');
  
  /**
   * Hlavná funkcia, ktorá analyzuje symbol pre viac timeframov (napr. 15m a 1h)
   * a vyhodnotí intradenný signál na základe GPT.
   */
  async function analyzeSymbolMultiTF(exchange, symbol) {
    // 1) Získaj dáta a indikátory pre 15m
    const data15m = await fetchIndicatorsForTimeframe(exchange, symbol, '15m', 200);
  
    // 2) Získaj dáta a indikátory pre 1h
    const data1h = await fetchIndicatorsForTimeframe(exchange, symbol, '1h', 200);
  
    // 3) Postav prompt, ktorý zahŕňa podrobné info z oboch timeframe
    const prompt = buildGPTPrompt(symbol, data15m, data1h);
  
    // 4) Zavolaj GPT, napr. cez o1-preview model
    const gpt = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
  
    const gptResp = await gpt.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o'
    });
    let rawContent = gptResp.choices[0]?.message?.content || '';
    // Odstránenie backtickov, ak by sa vyskytli
    rawContent = rawContent.replace(/```(\w+)?/g, '').trim();
  
    // 5) Skús naparsovať výsledok ako JSON
    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      console.warn("GPT vrátil nevalidný JSON, budeme ignorovať:", rawContent);
    }
  
    // 6) Naparsujeme signál, ak je možný
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
  
    // Pre jednoduchosť confidence = priemer všetkých troch
    const confidence = (technical_strength + fundamental_strength + sentiment_strength) / 3;
  
    return {
      tf15m: data15m,
      tf1h: data1h,
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
  
  /**
   * Načítanie OHLCV dát z danej burzy, výpočet hlavných indikátorov + uschovanie
   * posledných 10 sviečok pre prompt do GPT.
   */
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
  
  /**
   * Postaví prompt pre GPT z dát dvoch timeframe (napr. 15m a 1h),
   * pričom sa použije detailný sumár indikátorov a posledných 10 sviečok.
   */
  function buildGPTPrompt(symbol, data15m, data1h) {
    const summary15m = buildIndicatorSummary(data15m);
    const summary1h  = buildIndicatorSummary(data1h);
  
    // Výzva pre GPT – pýtať sa na krátkodobý intradenný signál so zohľadnením oboch timeframe
    // a žiadať o VÝLUČNE validný JSON s kľúčmi:
    //   technical_signal_strength, fundamental_signal_strength,
    //   sentiment_signal_strength, final_action, comment
    return `
  Analyzuj krátkodobý (intradenný / scalp) trend na symbol ${symbol} na základe indikátorov a posledných 10 sviečok z dvoch timeframe: 15m a 1h.
  
  ========================
  Timeframe 15m - Detaily:
  ${summary15m}
  
  ========================
  Timeframe 1h - Detaily:
  ${summary1h}
  
  Vráť výsledok IBA ako validný JSON v tvare:
  {
    "technical_signal_strength": 0.0-1.0,
    "fundamental_signal_strength": 0.0-1.0,
    "sentiment_signal_strength": 0.0-1.0,
    "final_action": "BUY" alebo "SELL" alebo "HOLD",
    "comment": "Stručný komentár"
  }
  (Nič navyše, žiadne spätné apostrofy, žiadne vysvetlenia okolo.)
  `;
  }
  
  module.exports = {
    analyzeSymbolMultiTF
  };