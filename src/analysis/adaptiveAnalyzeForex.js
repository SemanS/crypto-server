const { analyzeForexSymbol } = require('./analyzeForexSymbol');
const { computeAdaptiveSLTP } = require('../services/computeAdaptiveSLTP');
const { getBasicTimeAdvice } = require('../utils/helpers');

async function adaptiveAnalyzeForex(theSymbol, investAmount) {
  const baseAnalysis = await analyzeForexSymbol(theSymbol, '4h', 200);
  if (!baseAnalysis) return null;

  const sltpAdv = await computeAdaptiveSLTP(theSymbol, baseAnalysis, investAmount);

  let recommendedStopLossValue = investAmount * 0.05;
  let recommendedTakeProfitValue = investAmount * 0.10;
  let recommendedHoldWindow = '';
  let recommendedReevaluateTrigger = '';

  if (sltpAdv) {
    recommendedStopLossValue = sltpAdv.recommendedStopLossValue;
    recommendedTakeProfitValue = sltpAdv.recommendedTakeProfitValue;
    recommendedHoldWindow = sltpAdv.recommendedHoldWindow;
    recommendedReevaluateTrigger = sltpAdv.recommendedReevaluateTrigger;
  } else {
    // GPT zlyhalo => fallback
    const fallbackTime = getBasicTimeAdvice(baseAnalysis.finalAction);
    recommendedHoldWindow = fallbackTime.recommendedHoldWindow;
    recommendedReevaluateTrigger = fallbackTime.recommendedReevaluateAfter;
  }

  return {
    ...baseAnalysis,
    recommendedStopLossValue,
    recommendedTakeProfitValue,
    recommendedHoldWindow,
    recommendedReevaluateTrigger
  };
}

module.exports = { adaptiveAnalyzeForex };