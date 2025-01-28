const express = require('express');
const router = express.Router();
const ccxt = require('ccxt');

// V pamäti držíme simulované obchody
const paperTrades = {};

/**
 * POST /api/startPaperTrade
 * Vytvorí nový simulovaný (paper) obchod s trailing stopLoss a (voliteľne) takeProfit.
 */
router.post('/startPaperTrade', async (req, res) => {
  try {
    const { symbol, side, amountUSDT, takeProfitPct } = req.body;
    if (!symbol || !side || !amountUSDT) {
      return res.status(400).json({ error: 'Chýba symbol, side alebo amountUSDT' });
    }

    const exchange = new ccxt.binance({ enableRateLimit: true });
    const ticker = await exchange.fetchTicker(symbol);
    const lastPrice = ticker.last;
    if (!lastPrice) {
      return res.status(500).json({ error: `Nepodarilo sa získať cenu pre symbol ${symbol}` });
    }

    // Jednoduchý výpočet množstva (quantity)
    const quantity = (amountUSDT / lastPrice).toFixed(5);

    // Unikátne ID obchodu
    const tradeId = 'PAPER-' + Date.now();

    // Základná štruktúra obchodu v pamäti
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
      takeProfitPct: takeProfitPct || 0, // napr. 0.05 znamená 5%
      takeProfitPrice: null
    };

    // Príklad trailing stopLoss ±2%
    if (side.toUpperCase() === 'BUY') {
      newTrade.stopLossTrigger = lastPrice * (1 - 0.02);
      if (newTrade.takeProfitPct > 0) {
        newTrade.takeProfitPrice = lastPrice * (1 + newTrade.takeProfitPct);
      }
    } else {
      // SELL
      newTrade.stopLossTrigger = lastPrice * (1 + 0.02);
      if (newTrade.takeProfitPct > 0) {
        newTrade.takeProfitPrice = lastPrice * (1 - newTrade.takeProfitPct);
      }
    }

    paperTrades[tradeId] = newTrade;

    // Spustíme monitor, ktorý sleduje trailing stop a prípadne uzavrie obchod
    monitorPaperTrade(tradeId);

    return res.json({ success: true, tradeId, tradeInfo: newTrade });

  } catch (err) {
    console.error('Chyba vo /startPaperTrade:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paperTrades
 * Vráti VŠETKY obchody (akceptujeme, že môžu byť desiatky).
 * Pre tie, ktoré sú ešte OPEN, dynamicky zistíme currentPrice z burzy
 * a dopočítame unrealizedPnl. Uzavreté obchody (CLOSED) už majú final PnL.
 */
router.get('/paperTrades', async (req, res) => {
  try {
    // Vezmeme všetky obchody z pamäte
    const allTrades = Object.values(paperTrades);
    if (allTrades.length === 0) {
      return res.json([]); // prázdne
    }

    // Vyfiltrujeme open obchody, aby sme fetchovali current cenu len na tie symboly
    const openTrades = allTrades.filter(t => t.status === 'OPEN');

    // Zistíme unikátne symboly
    const uniqueSymbols = [...new Set(openTrades.map(t => t.symbol))];

    // Fetchneme tickery pre všetky open symboly
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

    // Pre každý open trade doplníme currentPrice a spočítame unrealizedPnl
    // Pre CLOSED nebudeme nič meniť, tam už je final PnL.
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
        // CLOSED
        t.currentPrice = t.closedPrice;
        t.unrealizedPnl = 0;
      }
    }

    return res.json(allTrades);
  } catch (err) {
    console.error('Chyba vo /paperTrades:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Funkcia na priebežné sledovanie trailing stopLoss / takeProfit.
 * Zavoláme ju pri štarte obchodu a potom v pauzach 5s = 5000ms.
 */
function monitorPaperTrade(tradeId) {
  const CHECK_INTERVAL_MS = 5000;

  async function checkLoop() {
    const t = paperTrades[tradeId];
    if (!t || t.status !== 'OPEN') {
      // Ukončíme ak trade neexistuje alebo už je CLOSED
      return;
    }

    try {
      // fetch aktuálnu cenu
      const exchange = new ccxt.binance({ enableRateLimit: true });
      const ticker = await exchange.fetchTicker(t.symbol);
      const currentPrice = ticker.last;

      if (t.side.toUpperCase() === 'BUY') {
        // posúvame highestPrice a stopLoss, ak rastie
        if (currentPrice > t.highestPrice) {
          t.highestPrice = currentPrice;
          t.stopLossTrigger = t.highestPrice * (1 - 0.02);
        }
        // check takeProfit
        if (t.takeProfitPrice && currentPrice >= t.takeProfitPrice) {
          // close
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
        // check stopLoss
        else if (currentPrice < t.stopLossTrigger) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
      }

      if (t.side.toUpperCase() === 'SELL') {
        // posúvame lowestPrice
        if (currentPrice < t.lowestPrice) {
          t.lowestPrice = currentPrice;
          t.stopLossTrigger = t.lowestPrice * (1 + 0.02);
        }
        if (t.takeProfitPrice && currentPrice <= t.takeProfitPrice) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
        else if (currentPrice > t.stopLossTrigger) {
          t.status = 'CLOSED';
          t.closedTime = Date.now();
          t.closedPrice = currentPrice;
        }
      }

      // Ak sa stalo CLOSED, spočítame final PnL
      if (t.status === 'CLOSED' && t.closedPrice != null) {
        if (t.side.toUpperCase() === 'BUY') {
          t.pnl = Number(((t.closedPrice - t.entryPrice) * t.quantity).toFixed(2));
        } else {
          t.pnl = Number(((t.entryPrice - t.closedPrice) * t.quantity).toFixed(2));
        }
      }

    } catch (err) {
      console.error(`Chyba pri monitorPaperTrade(${tradeId}):`, err.message);
    }

    // Ak ostal OPEN, o 5s skúsime znova
    if (paperTrades[tradeId] && paperTrades[tradeId].status === 'OPEN') {
      setTimeout(checkLoop, CHECK_INTERVAL_MS);
    }
  }

  // Spustíme prvý check po 5s
  setTimeout(checkLoop, CHECK_INTERVAL_MS);
}

module.exports = router;