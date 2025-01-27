const { analyzeScalpSymbol } = require('../analysis/analyzeScalpSymbol');
const { computeAdaptiveSLTP } = require('../services/computeAdaptiveSLTP');

async function adaptiveAnalyzeScalpCrypto(symbol, investAmount) {
  // 1) Najprv spravíme scalp analýzu
  console.log("IDEME")
  const scalpResult = await analyzeScalpSymbol(symbol);
  if (!scalpResult) return null;
  console.log("scalpResult" + JSON.stringify(scalpResult));

  // 2) Pridáme adaptívne odporúčanie pre SL/TP
  const sltpAdv = await computeAdaptiveSLTP(symbol, scalpResult, investAmount);
  console.log("sltpAdv" + JSON.stringify(sltpAdv))

  // Pri scalpovaní nechávame fallback menší SL (2 %) a menší TP (4 %)
  let recommendedStopLossValue = investAmount * 0.02;   
  let recommendedTakeProfitValue = investAmount * 0.04; 
  // Držanie 30–60 min
  let recommendedHoldWindow = '45m';                     
  let recommendedReevaluateTrigger = 'priceCrossEMA';    

  if (sltpAdv) {
    recommendedStopLossValue = sltpAdv.recommendedStopLossValue;
    recommendedTakeProfitValue = sltpAdv.recommendedTakeProfitValue;
    recommendedHoldWindow = sltpAdv.recommendedHoldWindow;
    recommendedReevaluateTrigger = sltpAdv.recommendedReevaluateTrigger;
  }

  // Vrátime kombinovaný výsledok
  return {
    ...scalpResult,
    recommendedStopLossValue,
    recommendedTakeProfitValue,
    recommendedHoldWindow,
    recommendedReevaluateTrigger
  };
}

module.exports = { adaptiveAnalyzeScalpCrypto };