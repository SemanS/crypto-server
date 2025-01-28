const { analyzeSymbolMultiTF } = require('../analysis/analyzeSymbolMultiTF');
const { analyzeSymbolComprehensiveApproach } = require('../analysis/analyzeSymbolComprehensiveApproach');
const { analyzeSymbolResearchApproach } = require('../analysis/analyzeSymbolResearchApproach');
const { analyzeSymbolRobustChainingApproach } = require('../analysis/analyzeSymbolRobustChainingApproach');

// V pamäti držíme simulované obchody (paper trades)
const paperTrades = {};

//----------------------------------------------------------------------
// 1) bestCandidates - stiahneme top USDT pairs, dáme GPT
//----------------------------------------------------------------------
router.get('/bestCandidates', async (req, res) => {
  try {
    const exchange = new ccxt.binance({ enableRateLimit: true });
    await exchange.loadMarkets();

    const allSymbols = Object.keys(exchange.markets);
    const usdtPairs = allSymbols.filter(s => s.endsWith('/USDT'));
    const top50 = usdtPairs.slice(0, 50);

    const tickers = await exchange.fetchTickers(top50);

    let arr = [];
    for (let sym of top50) {
      const t = tickers[sym];
      if (t) {
        const volume = t.baseVolume || 0;
        const perc   = t.percentage || 0;
        arr.push({ symbol:sym, baseVolume: volume, percentage: perc });
      }
    }
    arr.sort((a,b) => b.baseVolume - a.baseVolume);
    const topCandidatesText = arr.slice(0, 20).map(x =>
      `symbol=${x.symbol}, volume=${x.baseVolume}, 24h%=${x.percentage}`
    ).join('\n');

    const prompt = `
We have these top symbols from Binance USDT (desc by volume):
${topCandidatesText}

Pick 5 best coins to trade now, consider 24h% = momentum, volume=liquidity. Return as valid JSON:
{
  "pairs": [
    {
      "symbol": "SYM1",
      "reason": "short reason"
    },
    ...
  ]
}
(No extra text.)
`;

    const OpenAI = require('openai');
    const gpt = new OpenAI({
      organization: process.env.OPENAI_ORGANIZATION,
      apiKey: process.env.OPENAI_API_KEY
    });
    const resp = await gpt.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4'
    });

    let raw = resp.choices[0]?.message?.content || '';
    raw = raw.replace(/```/g, '').trim();

    let parsed = { pairs:[] };
    try {
      parsed = JSON.parse(raw);
    } catch(e) {
      console.warn("GPT bestCandidates invalid JSON:", raw);
    }

    return res.json(parsed);

  } catch(err) {
    console.error("Error /bestCandidates:", err.message);
    res.status(500).json({ error: err.message });
  }
});

//----------------------------------------------------------------------
// 2) reevaluateSymbol
//----------------------------------------------------------------------
router.get('/reevaluateSymbol', async (req, res) => {
  try {
    const { symbol, approach } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'chýba param symbol' });
    }

    const exchange = new ccxt.binance({ enableRateLimit: true });
    let reevalData;

    if (approach === 'multiTF') {
      reevalData = await analyzeSymbolMultiTF(exchange, symbol);
    } else if (approach === 'research') {
      reevalData = await analyzeSymbolResearchApproach(exchange, symbol);
    } else if (approach === 'comprehensive') {
      reevalData = await analyzeSymbolComprehensiveApproach(exchange, symbol);
    } else if (approach === 'robust') {
      reevalData = await analyzeSymbolRobustChainingApproach(exchange, symbol);
    } else {
      reevalData = await analyzeSymbolMultiTF(exchange, symbol);
    }

    const result = {
      symbol,
      finalAction: reevalData.gptOutput.final_action,
      commentGPT: reevalData.gptOutput.comment,
      tf15m: reevalData.tf15m,
      tf1h: reevalData.tf1h,
      tfDailyStats: reevalData.tfDailyStats || null
    };
    return res.json(result);

  } catch (err) {
    console.error('Chyba /reevaluateSymbol:', err.message);
    res.status(500).json({ error: err.message });
  }
});

//----------------------------------------------------------------------
// 3) POST /api/startPaperTrade
//----------------------------------------------------------------------
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
      return res.status(500).json({ error: `Nepodarilo sa získať cenu pre symbol ${symbol}` });
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
      pnl:        null,
      unrealizedPnl: 0,
      takeProfitPct: takeProfitPct || 0,
      takeProfitPrice: null
    };

    if (side.toUpperCase() === 'BUY') {
      newTrade.stopLossTrigger = lastPrice * (1 - 0.02);
      if (newTrade.takeProfitPct>0) {
        newTrade.takeProfitPrice = lastPrice * (1 + newTrade.takeProfitPct);
      }
    } else {
      newTrade.stopLossTrigger = lastPrice * (1 + 0.02);
      if (newTrade.takeProfitPct>0) {
        newTrade.takeProfitPrice = lastPrice * (1 - newTrade.takeProfitPct);
      }
    }

    // Uložíme a monitorujeme
    paperTrades[tradeId] = newTrade;
    monitorPaperTrade(tradeId);

    return res.json({ success:true, tradeId, tradeInfo: newTrade });

  } catch(err) {
    console.error('Chyba vo /startPaperTrade:', err.message);
    res.status(500).json({ error: err.message });
  }
});

//----------------------------------------------------------------------
// 4) GET /api/paperTrades
//----------------------------------------------------------------------
router.get('/paperTrades', async (req, res) => {
  try {
    const allTrades = Object.values(paperTrades);
    if (!allTrades.length) {
      return res.json([]);
    }
    const openTrades = allTrades.filter(t => t.status==='OPEN');
    const uniqueSymbols = [...new Set(openTrades.map(t => t.symbol))];

    const exchange = new ccxt.binance({ enableRateLimit:true });
    const tickersMap = {};

    for (let sym of uniqueSymbols) {
      try {
        const tk = await exchange.fetchTicker(sym);
        if (tk && tk.last) {
          tickersMap[sym] = tk.last;
        } else {
          console.warn("No last price for symbol:", sym);
        }
      } catch(e) {
        console.warn(`Chyba fetchTicker pre ${sym}:`, e.message);
      }
    }

    for (let t of allTrades) {
      if (t.status==='OPEN') {
        const fetchedPrice = tickersMap[t.symbol];
        if (fetchedPrice) {
          t.currentPrice = fetchedPrice;
        } else {
          // fallback ak nevieme zohnať last price
          t.currentPrice = t.entryPrice;
        }
        if (t.side.toUpperCase()==='BUY') {
          t.unrealizedPnl = Number(((t.currentPrice - t.entryPrice)*t.quantity).toFixed(2));
        } else {
          t.unrealizedPnl = Number(((t.entryPrice - t.currentPrice)*t.quantity).toFixed(2));
        }
      } else {
        t.currentPrice = t.closedPrice;
        t.unrealizedPnl = 0;
      }
    }

    return res.json(allTrades);

  } catch(err){
    console.error('Chyba vo /paperTrades:', err.message);
    res.status(500).json({ error: err.message });
  }
});

//----------------------------------------------------------------------
// 5) monitorPaperTrade => trailing stopLoss
//----------------------------------------------------------------------
function monitorPaperTrade(tradeId){
  const CHECK_INTERVAL_MS = 5000;

  async function checkLoop(){
    const t = paperTrades[tradeId];
    if (!t || t.status!=='OPEN') {
      return;
    }
    try {
      const exchange = new ccxt.binance({ enableRateLimit:true });
      const ticker = await exchange.fetchTicker(t.symbol);
      let currentPrice = t.entryPrice;
      if (ticker && ticker.last) {
        currentPrice = ticker.last;
      } else {
        console.warn(`monitorPaperTrade: no 'last' for symbol ${t.symbol}, fallback to entryPrice`);
      }

      if (t.side.toUpperCase()==='BUY') {
        if (currentPrice > t.highestPrice) {
          t.highestPrice= currentPrice;
          t.stopLossTrigger = t.highestPrice*(1-0.02);
        }
        if (t.takeProfitPrice && currentPrice>=t.takeProfitPrice) {
          t.status='CLOSED';
          t.closedTime=Date.now();
          t.closedPrice=currentPrice;
        } else if (currentPrice< t.stopLossTrigger) {
          t.status='CLOSED';
          t.closedTime=Date.now();
          t.closedPrice=currentPrice;
        }
      } else {
        // SELL
        if (currentPrice< t.lowestPrice) {
          t.lowestPrice= currentPrice;
          t.stopLossTrigger= t.lowestPrice*(1+0.02);
        }
        if (t.takeProfitPrice && currentPrice<= t.takeProfitPrice) {
          t.status='CLOSED';
          t.closedTime=Date.now();
          t.closedPrice=currentPrice;
        } else if (currentPrice > t.stopLossTrigger) {
          t.status='CLOSED';
          t.closedTime=Date.now();
          t.closedPrice= currentPrice;
        }
      }

      if (t.status==='CLOSED' && t.closedPrice!=null) {
        if (t.side.toUpperCase()==='BUY') {
          t.pnl= Number(((t.closedPrice- t.entryPrice)* t.quantity).toFixed(2));
        } else {
          t.pnl= Number(((t.entryPrice- t.closedPrice)* t.quantity).toFixed(2));
        }
      }

    } catch(e) {
      console.error(`Chyba monitorPaperTrade(${tradeId}):`, e.message);
    }
    // zreťazíme
    if(paperTrades[tradeId] && paperTrades[tradeId].status==='OPEN'){
      setTimeout(checkLoop, CHECK_INTERVAL_MS);
    }
  }

  setTimeout(checkLoop, CHECK_INTERVAL_MS);
}


module.exports = router;