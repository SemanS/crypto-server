const {
    RSI, MACD, SMA, BollingerBands, ADX,
    Stochastic, EMA, ATR, MFI, OBV
  } = require('technicalindicators');
  const {
    safeLast
  } = require('../utils/helpers');
  
  // (A) offlineDailyStats – príklad funkcie
  function offlineDailyStats(dailyOhlcvSlice) {
    if (!dailyOhlcvSlice || dailyOhlcvSlice.length < 2) {
      throw new Error('Not enough daily data offline');
    }
    // dailyOhlcvSlice: [ [ts, open, high, low, close, volume], ... ]
    const closes = dailyOhlcvSlice.map(c => c[4]);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const ret = (closes[i] - closes[i - 1]) / closes[i - 1];
      returns.push(ret);
    }
    const meanVal = average(returns);
    const stdevVal = stdev(returns, meanVal);
    const minVal  = Math.min(...returns);
    const maxVal  = Math.max(...returns);
    const skewVal = skewness(returns, meanVal, stdevVal);
    const kurtVal = kurtosis(returns, meanVal, stdevVal);
    
    return { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal };
  }
  
  // (B) offlineWeeklyStats – analogické pre weekly
  function offlineWeeklyStats(weeklyOhlcvSlice) {
    if (!weeklyOhlcvSlice || weeklyOhlcvSlice.length < 2) {
      throw new Error("Not enough weekly data offline");
    }
    const closes = weeklyOhlcvSlice.map(c => c[4]);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const ret = (closes[i] - closes[i - 1]) / closes[i - 1];
      returns.push(ret);
    }
    const meanVal = average(returns);
    const stdevVal = stdev(returns, meanVal);
    const minVal  = Math.min(...returns);
    const maxVal  = Math.max(...returns);
    const skewVal = skewness(returns, meanVal, stdevVal);
    const kurtVal = kurtosis(returns, meanVal, stdevVal);
    
    return { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal };
  }
  
  // (C) offlineIndicatorsForTimeframe (15m/1h/...)
  function offlineIndicatorsForTimeframe(ohlcvSlice, timeframeLabel = 'offline') {
    if (!ohlcvSlice) {
      throw new Error(`No data for timeframe=${timeframeLabel}`);
    }
    
    if (!Array.isArray(ohlcvSlice)) {
      if (typeof ohlcvSlice === 'object' && ohlcvSlice !== null) {
        console.warn(`ohlcvSlice for timeframe=${timeframeLabel} is not an array. Attempting to convert using Object.values.`);
        ohlcvSlice = Object.values(ohlcvSlice);
      } else {
        throw new Error(`ohlcvSlice is not an array for timeframe=${timeframeLabel}`);
      }
    }
    
    if (ohlcvSlice.length === 0) {
      throw new Error(`No data for timeframe=${timeframeLabel}`);
    }
    
    // Predpoklad: každá položka má tvar [ts, open, high, low, close, volume]
    const highs   = ohlcvSlice.map(c => c[2]);
    const lows    = ohlcvSlice.map(c => c[3]);
    const closes  = ohlcvSlice.map(c => c[4]);
    const volumes = ohlcvSlice.map(c => c[5]);
  
    // Výpočet indikátorov
    const rsiData = RSI.calculate({ values: closes, period: 14 });
    const lastRSI = safeLast(rsiData);
  
    const macdData = MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
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
  
    const stoData = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
    const lastStochastic = safeLast(stoData);
  
    const atrData = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const lastATR = safeLast(atrData);
  
    const mfiData = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 });
    const lastMFI = safeLast(mfiData);
  
    const obvData = OBV.calculate({ close: closes, volume: volumes });
    const lastOBV = safeLast(obvData);
  
    const lastClose = safeLast(closes);
  
    return {
      timeframe: timeframeLabel,
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
      // Tu môžeš pridať ďalšie vlastnosti:
      // lastVWAP, pivotPoints, fibonacci, openingRange, psychLevels, atď.
    };
  }
  
  // ---- Pomocné štatistické funkcie na priemer, stdev, skew, kurt
  function average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((acc, v) => acc + v, 0) / arr.length;
  }
  function stdev(arr, mean) {
    if (arr.length < 2) return 0;
    const sqDiff = arr.map(v => (v - mean) * (v - mean));
    return Math.sqrt(average(sqDiff));
  }
  function skewness(arr, mean, std) {
    if (!std || std === 0) return 0;
    const n = arr.length;
    const sum3 = arr.reduce((acc, v) => acc + Math.pow(v - mean, 3), 0);
    return (n / ((n - 1)*(n - 2))) * (sum3 / Math.pow(std, 3));
  }
  function kurtosis(arr, mean, std) {
    if (!std || std === 0) return 0;
    const n = arr.length;
    const sum4 = arr.reduce((acc, v) => acc + Math.pow(v - mean, 4), 0);
    return ((n * (n+1))/((n-1)*(n-2)*(n-3))) * (sum4 / Math.pow(std,4))
             - (3 * (n-1)*(n-1))/((n-2)*(n-3));
  }
  
  module.exports = {
    offlineDailyStats,
    offlineWeeklyStats,
    offlineIndicatorsForTimeframe
  };