const { analyzeSymbol } = require('./analyzeSymbol');
const { computeAdaptiveSLTP } = require('../services/computeAdaptiveSLTP');
const { getBasicTimeAdvice } = require('../utils/helpers');

async function adaptiveAnalyzeCrypto(theSymbol, investAmount) {
  // Zmenené z '4h' na '15m'
  const baseAnalysis = await analyzeSymbol(theSymbol, '15m', 200);
  if (!baseAnalysis) return null;

  const sltpAdv = await computeAdaptiveSLTP(theSymbol, baseAnalysis, investAmount);

  // Scalp: znížime fallback stop-loss na 2 % a take-profit na 4 %
  let recommendedStopLossValue = investAmount * 0.02;
  let recommendedTakeProfitValue = investAmount * 0.04;
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

    // Pretože scalpujeme, môžeme fallback nastaviť napr. na 30–60 min
    recommendedHoldWindow = '45m'; // fallback pri scalpovaní
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

module.exports = { adaptiveAnalyzeCrypto };