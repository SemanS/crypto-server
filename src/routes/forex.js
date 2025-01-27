const express2 = require('express');
const router2 = express2.Router();
const { adaptiveAnalyzeForex } = require('../analysis/adaptiveAnalyzeForex');

router2.get('/forex', async (req, res) => {
  try {
    const investAmount = req.query.amount ? parseFloat(req.query.amount) : 1000;
    const forexPairs = [
      'EUR/USD',
      'GBP/USD',
      'USD/JPY',
      'AUD/USD',
      'USD/CAD',
      'NZD/USD',
      'USD/CHF',
    ];

    const analysisPromises = forexPairs.map(pair => (async () => {
      try {
        const analysis = await adaptiveAnalyzeForex(pair, investAmount);
        if (!analysis) return null;
        // Prípadne tu môžete robiť filter
        return { symbol: pair, ...analysis };
      } catch (err) {
        console.error(`Chyba pri analýze forex symbolu ${pair}:`, err.message);
        return null;
      }
    })());

    const analysisResults = await Promise.all(analysisPromises);
    const results = analysisResults.filter(r => r !== null);

    res.json({
      investAmount,
      count: results.length,
      forex: results
    });
  } catch (err) {
    console.error('Chyba na /api/forex:', err);
    res.status(500).json({ error: 'Chyba na /api/forex', details: err.message });
  }
});

module.exports = router2;