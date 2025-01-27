const { analyzeScalpSymbol } = require('../analysis/analyzeScalpSymbol');
const { computeAdaptiveSLTP } = require('../services/computeAdaptiveSLTP');

async function adaptiveAnalyzeScalpCrypto(symbol, investAmount) {
  // 1) Najprv spravíme scalp analýzu
  console.log("IDEME")
  const scalpResult = await analyzeScalpSymbol(symbol);
  //console.log("scalpResult" + JSON.stringify(scalpResult))
  if (!scalpResult) return null;
  console.log("scalpResult" + JSON.stringify(scalpResult));

  // 2) Pridáme adaptívne odporúčanie pre SL/TP
  const sltpAdv = await computeAdaptiveSLTP(symbol, scalpResult, investAmount);
  console.log("sltpAdv" + JSON.stringify(sltpAdv))
  let recommendedStopLossValue = investAmount * 0.05;   // fallback 5%
  let recommendedTakeProfitValue = investAmount * 0.10; // fallback 10%
  let recommendedHoldWindow = '1h';                     // pri scalp často len minúty-hodiny
  let recommendedReevaluateTrigger = 'priceCrossEMA';   // fallback

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