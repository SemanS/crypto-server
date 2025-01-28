function safeLast(array) {
    if (!array || array.length === 0) return null;
    return array[array.length - 1];
  }
  
  function safeToFixed(value, digits = 2) {
    return (typeof value === 'number' && isFinite(value)) 
      ? value.toFixed(digits) 
      : 'N/A';
  }
  
  // Jednoduchá logika pre odporúčanie hold okna a reevaluácie (fallback)
  function getBasicTimeAdvice(finalAction) {
    if (finalAction === 'BUY') {
      return {
        recommendedHoldWindow: '2-3 days',
        recommendedReevaluateAfter: '12 hours'
      };
    } else if (finalAction === 'SELL') {
      return {
        recommendedHoldWindow: '0 days (exit as soon as feasible)',
        recommendedReevaluateAfter: 'Now'
      };
    } else {
      // HOLD alebo iné
      return {
        recommendedHoldWindow: '1 day',
        recommendedReevaluateAfter: '12 hours'
      };
    }
  }
  
  function calcMean(data) {
    if (!data.length) return 0;
    const sum = data.reduce((acc, v) => acc + v, 0);
    return sum / data.length;
  }
  function calcStdev(data, mean) {
    if (!data.length) return 0;
    const varSum = data.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    return Math.sqrt(varSum / data.length);
  }
  function calcSkewness(data, mean, stdev) {
    if (!data.length || stdev === 0) return 0;
    const n = data.length;
    let s3 = 0;
    for (let i = 0; i < n; i++) {
      s3 += (data[i] - mean) ** 3;
    }
    return (s3 / n) / (stdev ** 3);
  }
  function calcKurtosis(data, mean, stdev) {
    // tu rátame “raw” kurtosis (bez odčítania 3)
    if (!data.length || stdev === 0) return 0;
    const n = data.length;
    let s4 = 0;
    for (let i = 0; i < n; i++) {
      s4 += (data[i] - mean) ** 4;
    }
    return (s4 / n) / (stdev ** 4);
  }

  module.exports = {
    safeLast,
    safeToFixed,
    getBasicTimeAdvice,
    calcKurtosis,
    calcSkewness,
    calcStdev,
    calcMean
  };