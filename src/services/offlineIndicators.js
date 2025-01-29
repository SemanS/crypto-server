const {
    RSI, MACD, SMA, BollingerBands, ADX,
    Stochastic, EMA, ATR, MFI, OBV
  } = require('technicalindicators');
  const {
    safeLast, safeToFixed
  } = require('../utils/helpers');
  
  // offlineDailyStats – namiesto fetchDailyStats
  // Vypočíta "denné" štatistiky, ale z vami dodaného array (napr. dailyOHLCV.slice(0, i+1))
  function offlineDailyStats(dailyOhlcvSlice) {
    // dailyOhlcvSlice = array [ [ts, open, high, low, close, volume], ... ]
    if (!dailyOhlcvSlice || dailyOhlcvSlice.length < 2) {
      throw new Error('Not enough daily data offline');
    }
    const closes = dailyOhlcvSlice.map(c => c[4]);
    const returns = [];
    for (let i=1; i<closes.length; i++){
      const ret = (closes[i] - closes[i-1]) / closes[i-1];
      returns.push(ret);
    }
    // spočítať mean, stdev, min, max, ...
    const meanVal = average(returns);
    const stdevVal = stdev(returns, meanVal);
    const minVal  = Math.min(...returns);
    const maxVal  = Math.max(...returns);
    const skewVal = skewness(returns, meanVal, stdevVal);
    const kurtVal = kurtosis(returns, meanVal, stdevVal);
  
    return { meanVal, stdevVal, minVal, maxVal, skewVal, kurtVal };
  }
  
  // offlineIndicatorsForTimeframe – namiesto fetchIndicatorsForTimeframe
  function offlineIndicatorsForTimeframe(ohlcvSlice, timeframeLabel='offline') {
    if (!ohlcvSlice || ohlcvSlice.length === 0) {
      throw new Error(`Nedá sa načítať offline OHLCV pre ${timeframeLabel}`);
    }
    const highs   = ohlcvSlice.map(c => c[2]);
    const lows    = ohlcvSlice.map(c => c[3]);
    const closes  = ohlcvSlice.map(c => c[4]);
    const volumes = ohlcvSlice.map(c => c[5]);
  
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
  
    // Pre jednoduchý prompt:
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
    };
  }
  
  // Pomocné štatistické funkcie
  function average(arr) {
    return arr.reduce((acc, v) => acc + v, 0) / arr.length;
  }
  function stdev(arr, mean) {
    const sqDiff = arr.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(average(sqDiff));
  }
  function skewness(arr, mean, std) {
    if (!std || std === 0) return 0;
    const n = arr.length;
    const sum3 = arr.map(v => Math.pow(v - mean, 3)).reduce((a, b) => a + b, 0);
    return (n / ((n - 1) * (n - 2))) * sum3 / Math.pow(std, 3);
  }
  function kurtosis(arr, mean, std) {
    if (!std || std === 0) return 0;
    const n = arr.length;
    const sum4 = arr.map(v => Math.pow(v - mean, 4)).reduce((a, b) => a + b, 0);
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
           sum4 / Math.pow(std, 4)
           - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  }
  
  module.exports = {
    offlineDailyStats,
    offlineIndicatorsForTimeframe
  };