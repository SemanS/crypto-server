const OpenAI = require('openai');
// Pozn.: V reálnom projekte si kľúč a organization ID dajte do prostredia .env
const client = new OpenAI({
  organization: process.env.OPENAI_ORGANIZATION,
  apiKey: process.env.OPENAI_API_KEY,
});

async function computeAdaptiveSLTP(symbol, analysis, investAmount) {
  // Rozbaľte si ďalšie indikátory pre detailnejší prompt
  const {
    lastClose,
    finalAction,
    confidence,
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
  } = analysis;

  const prompt = `
Symbol: ${symbol}
Last Close Price: ${lastClose}
Final Action: ${finalAction}
RSI(14): ${lastRSI !== undefined ? lastRSI.toFixed(2) : 'N/A'}
MACD: ${
  lastMACD
    ? `MACD=${lastMACD.MACD?.toFixed(4)}, signal=${lastMACD.signal?.toFixed(4)}, hist=${lastMACD.histogram?.toFixed(4)}`
    : 'N/A'
}
SMA(20): ${lastSMA20 !== undefined ? lastSMA20.toFixed(4) : 'N/A'}
EMA(50): ${lastEMA50 !== undefined ? lastEMA50.toFixed(4) : 'N/A'}
Boll(20,2): ${
  lastBoll
    ? `lower=${lastBoll.lower?.toFixed(4)}, mid=${lastBoll.mid?.toFixed(4)}, upper=${lastBoll.upper?.toFixed(4)}`
    : 'N/A'
}
ADX(14): ${
  lastADX
    ? `adx=${lastADX.adx?.toFixed(2)}, pdi=${lastADX.pdi?.toFixed(2)}, mdi=${lastADX.mdi?.toFixed(2)}`
    : 'N/A'
}
Stoch(14,3): ${
  lastStochastic
    ? `K=${lastStochastic.k?.toFixed(2)}, D=${lastStochastic.d?.toFixed(2)}`
    : 'N/A'
}
ATR(14): ${lastATR !== undefined ? lastATR.toFixed(4) : 'N/A'}
MFI(14): ${lastMFI !== undefined ? lastMFI.toFixed(2) : 'N/A'}
OBV: ${lastOBV !== undefined ? lastOBV.toFixed(2) : 'N/A'}

Úloha: Navrhni taký stop-loss a take-profit (v USD, nie v %) pre investíciu vo výške ${investAmount} USD, aby sme maximalizovali profit. 
Zároveň navrhni, pri akej cene alebo podmienke (čas, percento, atď.) by sa mal urobiť re-check (reevaluation) tejto pozície.

Vráť výsledok striktne ako validný JSON tvaru:
{
  "recommended_stop_loss_value": číslo,
  "recommended_take_profit_value": číslo,
  "recommended_hold_window": "napr. '2 days', '30 hodín', ...",
  "recommended_reevaluate_trigger": "podmienka/násobok ceny/konkrétna cena"
}
(Nič iné, žiadny text okolo.)
`;

  try {
    const gptResp = await client.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o'
    });
    let raw = gptResp.choices[0].message.content || '';
    raw = raw.replace(/```(\w+)?/g, '').trim();

    const parsed = JSON.parse(raw);
    const recommendedStopLossValue = parsed.recommended_stop_loss_value || null;
    const recommendedTakeProfitValue = parsed.recommended_take_profit_value || null;
    const recommendedHoldWindow = parsed.recommended_hold_window || '';
    const recommendedReevaluateTrigger = parsed.recommended_reevaluate_trigger || '';

    // Ak všetko ok, vrátime
    if (recommendedStopLossValue && recommendedTakeProfitValue) {
      return {
        recommendedStopLossValue,
        recommendedTakeProfitValue,
        recommendedHoldWindow,
        recommendedReevaluateTrigger
      };
    } 
    return null;

  } catch (err) {
    console.error('computeAdaptiveSLTP: GPT error', err.message);
    return null;
  }
}

module.exports = { computeAdaptiveSLTP };