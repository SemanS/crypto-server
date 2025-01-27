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
  
  module.exports = {
    safeLast,
    safeToFixed,
    getBasicTimeAdvice
  };