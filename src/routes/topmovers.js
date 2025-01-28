const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const { analyzeSymbolMultiTF } = require('../analysis/analyzeSymbolMultiTF');

router.get('/topscalp', async (req, res) => {
  try {
    const investAmount = req.query.amount ? parseFloat(req.query.amount) : 1000;
    const exchange = new ccxt.binance({ enableRateLimit: true });
    await exchange.loadMarkets();

    // 1. Stiahneme všetky tickery
    const allTickers = await exchange.fetchTickers();

    // 2. Filtrovanie len na /USDT páry a také, ktoré majú definované percento zmeny
    let tickersArray = Object.values(allTickers).filter(t => {
      return t.symbol && t.symbol.endsWith('/USDT') && typeof t.percentage === 'number';
    });

    // 3. Filtrovanie na základe 24h volume (napr. min. 10M USD)
    const MIN_VOLUME = 10_000_000;
    tickersArray = tickersArray.filter(t => {
      // baseVolume * last je hrubý odhad USDT volume.
      // Nie je 100%-né, ale postačí ako základné sito.
      const volUSDT = t.baseVolume * (t.last || 0);
      return volUSDT >= MIN_VOLUME;
    });

    // 4. Zoradenie top gainerov a top loserov
    const sortedAsc = [...tickersArray].sort((a, b) => a.percentage - b.percentage);
    const sortedDesc = [...tickersArray].sort((a, b) => b.percentage - a.percentage);

    const top10Losers = sortedAsc.slice(0, 10);
    const top10Gainers = sortedDesc.slice(0, 10);

    // Spojíme do jedného zoznamu
    const topScalpCandidates = [...top10Gainers, ...top10Losers];

    // 5. Analyzujeme v paralelných promise
    const analysisPromises = topScalpCandidates.map(t => (async () => {
      const symbol = t.symbol;
      try {
        // a) Pozrieme sa aj na orderbook (spread)
        const orderbook = await exchange.fetchOrderBook(symbol, 50);
        const bestBid = orderbook.bids.length ? orderbook.bids[0][0] : 0;
        const bestAsk = orderbook.asks.length ? orderbook.asks[0][0] : 0;
        if (bestBid === 0 || bestAsk === 0) {
          // Neplatné dáta, preskočíme
          return null;
        }
        const spreadRatio = (bestAsk - bestBid) / bestBid;
        // Napr. ak je spread väčší ako 0.5% -> preskočiť
        if (spreadRatio > 0.005) {
          return null;
        }

        // b) Zavoláme viac-timeframe analýzu (15m + 1h)
        const analysis = await analyzeSymbolMultiTF(exchange, symbol);

        // c) Minimálny ATR filter na 15m timeframe (príklad)
        // Ak je priemerná volatilita príliš malá, scalp je možno nezaujímavý
        if (analysis.tf15m?.lastATR && analysis.tf15m.lastATR < 0.0005) {
          return null;
        }

        // d) Vytvoríme si vlastné “score” z indikátorov pre 15m + 1h
        const technicalScore15m = getCustomTechScore(analysis.tf15m);
        const technicalScore1h = getCustomTechScore(analysis.tf1h);

        // e) Skombinujeme signál z GPT s “technicalScore”
        // GPT vráti final_action a confidence => spočítame to do jedného finálneho
        const gpt = analysis.gptOutput; // z analyzy
        if (!gpt) return null;

        const finalAction = gpt.final_action; 
        let finalConfidence = gpt.confidence || 0;
        // Napr. priemerná hodnota z GPT (0-1) a náš “score” (tiež 0-1)
        const combinedScore = (finalConfidence + technicalScore15m + technicalScore1h) / 3;

        // Minimálny prah, aby sme považovali signál za platný (napr. 0.5)
        if (combinedScore < 0.5) {
          return null;
        }

        // f) Výsledný záznam
        return {
          symbol,
          percentage24h: t.percentage,
          spreadRatio,
          combinedScore,
          finalAction,
          commentGPT: gpt.comment,
          // Diagnostické dáta
          tf15m: analysis.tf15m,
          tf1h: analysis.tf1h
        };

      } catch (err) {
        console.error(`Chyba pri scalp analýze symbolu ${symbol}:`, err.message);
        return null;
      }
    })());

    const analysisResults = await Promise.all(analysisPromises);
    const filteredResults = analysisResults.filter(r => r !== null);

    res.json({
      investAmount,
      count: filteredResults.length,
      pairs: filteredResults
    });
  } catch (err) {
    console.error('Chyba na /api/topscalp', err);
    res.status(500).json({ error: 'Chyba na /api/topscalp', details: err.message });
  }
});

// Príklad funkcie pre základné bodovanie indikátorov:
function getCustomTechScore(tfData) {
  if (!tfData) return 0;
  let score = 0;
  let count = 0;

  // RSI - ak je neutrálne (cca 40-60), pridaj stredné body, pri extrémnom oversold/overbought urob malé úpravy
  if (tfData.lastRSI) {
    count++;
    if (tfData.lastRSI < 30) score += 0.8; // oversold = bullish
    else if (tfData.lastRSI > 70) score += 0.2; // overbought = risk
    else score += 0.5;
  }

  // MACD - ak je histogram > 0, berieme bullish
  if (tfData.lastMACD && tfData.lastMACD.histogram) {
    count++;
    if (tfData.lastMACD.histogram > 0) score += 0.7;
    else score += 0.3;
  }

  // ADX - ak je adx > 25, je trend silnejší
  if (tfData.lastADX && tfData.lastADX.adx) {
    count++;
    if (tfData.lastADX.adx > 25) score += 0.7;
    else score += 0.4;
  }

  // atď. Môžete ďalej dopĺňať logiku.
  if (count === 0) return 0;
  return score / count; // priemer
}

module.exports = router;