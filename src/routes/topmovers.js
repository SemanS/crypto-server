const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const { adaptiveAnalyzeScalpCrypto } = require('../services/adaptiveAnalyzeScalpCrypto');

router.get('/topscalp', async (req, res) => {
  try {
    const investAmount = req.query.amount ? parseFloat(req.query.amount) : 1000;
    const exchange = new ccxt.binance({ enableRateLimit: true });
    await exchange.loadMarkets();

    // Fetch all tickers
    const allTickers = await exchange.fetchTickers();

    // Filter USDT symbols that have a "percentage" field
    const tickersArray = Object.values(allTickers).filter(t => {
      return t.symbol && t.symbol.endsWith('/USDT') && typeof t.percentage === 'number';
    });

    // Sort ascending/descending to get top gainers/losers
    const sortedAsc = [...tickersArray].sort((a, b) => a.percentage - b.percentage);
    const sortedDesc = [...tickersArray].sort((a, b) => b.percentage - a.percentage);

    const top10Losers = sortedAsc.slice(0, 10);
    const top10Gainers = sortedDesc.slice(0, 10);

    const topScalpCandidates = [...top10Gainers, ...top10Losers];

    // Analyze each candidate in parallel
    const analysisPromises = topScalpCandidates.map(t => (async () => {
      try {
        const analysis = await adaptiveAnalyzeScalpCrypto(t.symbol, investAmount);
        // Filter out if GPT didn't recommend a clear buy/sell or confidence is too low
        if (
          (analysis.scalpGPT?.final_action === 'BUY' || analysis.scalpGPT?.final_action === 'SELL') &&
          analysis.scalpGPT?.confidence > 0.5
        ) {
          return {
            symbol: t.symbol,
            percentage24h: t.percentage,
            ...analysis
          };
        } else {
          return null;
        }
      } catch (err) {
        console.error(`Chyba pri scalp analýze symbolu ${t.symbol}:`, err.message);
        return null;
      }
    })());

    const analysisResults = await Promise.all(analysisPromises);
    const results = analysisResults.filter(r => r !== null);

    res.json({
      investAmount,
      count: results.length,
      pairs: results
    });
  } catch (err) {
    console.error('Chyba na /api/topscalp', err);
    res.status(500).json({ error: 'Chyba na /api/topscalp', details: err.message });
  }
});

module.exports = router;