const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');
const { analyzeSymbolMultiTF } = require('../analysis/analyzeSymbolMultiTF');

// Príklad: "dummy" analýza, na demonštráciu
async function analyzeSymbolDummy(exchange, symbol) {
  // Napr. vráti čokoľvek
  return {
    tf15m: { note: "Dummy 15m" },
    tf1h:  { note: "Dummy 1h" },
    gptOutput: {
      final_action: "BUY",
      comment: "Dummy approach - reeval",
      technical_signal_strength: 0.8,
      fundamental_signal_strength: 0.3,
      sentiment_signal_strength: 0.5
    }
  };
}

// Uchovávame simulované obchody v pamäti
const paperTrades = {};

/**
 * GET /api/reevaluateSymbol?symbol=BTC/USDT&approach=multiTF
 * Opätovná analýza symbolu podľa parametru "approach"
 */
router.get('/reevaluateSymbol', async (req, res) => {
  try {
    const { symbol, approach } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'Chýba param. symbol' });
    }

    const exchange = new ccxt.binance({ enableRateLimit: true });
    let reevalData;

    if (approach === 'multiTF') {
      reevalData = await analyzeSymbolMultiTF(exchange, symbol);
    } else if (approach === 'dummy') {
      reevalData = await analyzeSymbolDummy(exchange, symbol);
    } else {
      // default fallback
      reevalData = await analyzeSymbolMultiTF(exchange, symbol);
    }

    const result = {
      symbol,
      finalAction: reevalData.gptOutput.final_action,
      commentGPT: reevalData.gptOutput.comment,
      tf15m: reevalData.tf15m,
      tf1h: reevalData.tf1h
    };

    res.json(result);

  } catch (err) {
    console.error("Chyba /reevaluateSymbol:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/startPaperTrade
 * Spustí nový paper trade s trailing stopLoss (2%) a voliteľným takeProfit
 */
router.post('/startPaperTrade', async (req, res) => {
  try {
    const { symbol, side, amountUSDT, takeProfitPct } = req.body;
    if (!symbol || !side || !amountUSDT) {
      return res.status(400).json({ error: 'Chýba symbol, side, amountUSDT' });
    }
    const exchange = new ccxt.binance({ enableRateLimit: true });
    const ticker = await exchange.fetchTicker(symbol);
    const lastPrice = ticker.last;
    if (!lastPrice) {
      return res.status(500).json({ error: `Nepodarilo sa získať cenu pre ${symbol}` });
    }

    const quantity = (amountUSDT / lastPrice).toFixed(5);
    const tradeId = 'PAPER-' + Date.now();

    const newTrade = {
      tradeId,
      symbol,
      side,
      amountUSDT,
      quantity: Number(quantity),
      entryPrice: lastPrice,
      status: 'OPEN',
      openTime: Date.now(),
      highestPrice: lastPrice,
      lowestPrice: lastPrice,
      stopLossTrigger: 0,
      closedTime: null,
      closedPrice: null,
      pnl: null,
      unrealizedPnl: 0,
      takeProfitPct: takeProfitPct || 0,
      takeProfitPrice: null
    };

    if (side.toUpperCase() === 'BUY') {
      newTrade.stopLossTrigger = lastPrice * (1 - 0.02);
      if (newTrade.takeProfitPct > 0) {
        newTrade.takeProfitPrice = lastPrice * (1 + newTrade.takeProfitPct);
      }
    } else {
      newTrade.stopLossTrigger = lastPrice * (1 + 0.02);
      if (newTrade.takeProfitPct > 0) {
        newTrade.takeProfitPrice = lastPrice * (1 - newTrade.takeProfitPct);
      }
    }

    paperTrades[tradeId] = newTrade;
    monitorPaperTrade(tradeId);

    res.json({ success: true, tradeId, tradeInfo: newTrade });

  } catch (err) {
    console.error('Chyba vo /startPaperTrade:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paperTrades
 * Vráti všetky obchody (OPEN aj CLOSED).
 */
router.get('/paperTrades', async (req, res) => {
  try {
    const allTrades = Object.values(paperTrades);
    if (allTrades.length === 0) {
      return res.json([]);
    }

    // Len tie open trades => fetchneme currentPrice
    const openTrades = allTrades.filter(t => t.status === 'OPEN');
    const uniqueSymbols = [...new Set(openTrades.map(t => t.symbol))];

    const exchange = new ccxt.binance({ enableRateLimit: true });
    const tickersMap = {};
    for (let sym of uniqueSymbols) {
      try {
        const tk = await exchange.fetchTicker(sym);
        if (tk.last) {
          tickersMap[sym] = tk.last;
        }
      } catch (err) {
        console.warn(`Chyba fetchTicker pre ${sym}:`, err.message);
      }
    }

    for (let t of allTrades) {
      if (t.status === 'OPEN') {
        const currentPrice = tickersMap[t.symbol] || t.entryPrice;
        t.currentPrice = currentPrice;
        if (t.side.toUpperCase() === 'BUY') {
          t.unrealizedPnl = Number(((currentPrice - t.entryPrice) * t.quantity).toFixed(2));
        } else {
          t.unrealizedPnl = Number(((t.entryPrice - currentPrice) * t.quantity).toFixed(2));
        }
      } else {
        t.currentPrice = t.closedPrice;
        t.unrealizedPnl = 0;
      }
    }

    res.json(allTrades);

  } catch (err) {
    console.error('Chyba vo /paperTrades:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Funkcia na priebežné sledovanie trailing stopLoss.
 */
function monitorPaperTrade(tradeId) {
  const CHECK_INTERVAL_MS = 5000;

  async function checkLoop() {
    const t = paperTrades[tradeId];
    if (!t || t.status !== 'OPEN') {
      return;
    }
    try {
      const exchange = new ccxt.binance({ enableRateLimit: true });
      const ticker = await exchange.fetchTicker(t.symbol);
      const currentPrice = ticker.last;

      if (t.side.toUpperCase() === 'BUY') {
        if (currentPrice > t.highestPrice) {
          t.highestPrice = currentPrice;
          t.stopLossTrigger = t.highestPrice * (1 - 0.02);
        }
        if (t.takeProfitPrice && currentPrice >= t.takeProfitPrice) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        } else if (currentPrice < t.stopLossTrigger) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
      }

      if (t.side.toUpperCase() === 'SELL') {
        if (currentPrice < t.lowestPrice) {
          t.lowestPrice = currentPrice;
          t.stopLossTrigger = t.lowestPrice * (1 + 0.02);
        }
        if (t.takeProfitPrice && currentPrice <= t.takeProfitPrice) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        } else if (currentPrice > t.stopLossTrigger) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
      }

      if (t.status === 'CLOSED' && t.closedPrice != null) {
        if (t.side.toUpperCase() === 'BUY') {
          t.pnl = Number(((t.closedPrice - t.entryPrice) * t.quantity).toFixed(2));
        } else {
          t.pnl = Number(((t.entryPrice - t.closedPrice) * t.quantity).toFixed(2));
        }
      }
    } catch (err) {
      console.error(`Chyba monitorPaperTrade(${tradeId}):`, err.message);
    }

    if (paperTrades[tradeId] && paperTrades[tradeId].status === 'OPEN') {
      setTimeout(checkLoop, CHECK_INTERVAL_MS);
    }
  }

  setTimeout(checkLoop, CHECK_INTERVAL_MS);
}

module.exports = router;