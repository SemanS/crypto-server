const { calcKurtosis, calcSkewness, calcStdev, calcMean } = require('../utils/helpers');

async function analyzeSymbolResearchApproach(exchange, symbol) {
    // 1) fetch 1d OHLC (napr. 200 dní)
    const limit = 200;
    const timeframe = '1d';
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    if (!ohlcv || ohlcv.length < 2) {
      throw new Error(`No enough 1d OHLC data for symbol=${symbol}`);
    }
  
    // 2) Vypočítame denné výnosy (simple returns)
    //    r_t = (close[t] - close[t-1]) / close[t-1]
    const closes = ohlcv.map(c => c[4]);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const ret = (closes[i] - closes[i-1]) / closes[i-1];
      returns.push(ret);
    }
  
    // 3) Štatistiky
    const meanVal = calcMean(returns);
    const stdevVal = calcStdev(returns, meanVal);
    const minVal = Math.min(...returns);
    const maxVal = Math.max(...returns);
    const skewVal = calcSkewness(returns, meanVal, stdevVal);
    const kurtVal = calcKurtosis(returns, meanVal, stdevVal);
  
    // 4) Jednoduché rozhodnutie: ak priemer > 0 => BUY, inak SELL
    let final_action = 'SELL';
    if (meanVal > 0) {
      final_action = 'BUY';
    }
  
    const descComment = `ResearchApproach => mean=${meanVal.toFixed(4)}, stdev=${stdevVal.toFixed(4)}, min=${minVal.toFixed(4)}, max=${maxVal.toFixed(4)}, skew=${skewVal.toFixed(4)}, kurt=${kurtVal.toFixed(4)} => final=${final_action}`;
  
    return {
      // Môžete pridať nejaké "tfDaily" ak potrebujete
      tf15m: { note: "No 15m data used here" },
      tf1h:  { note: "No 1h data used here" },
      gptOutput: {
        final_action,
        technical_signal_strength: Math.min(Math.abs(meanVal * 100), 1), // len fake
        fundamental_signal_strength: 0.5,
        sentiment_signal_strength: 0.5,
        confidence: 0.5,
        comment: descComment
      }
    };
}

  module.exports = {
    analyzeSymbolResearchApproach
  };