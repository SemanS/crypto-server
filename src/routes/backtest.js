const express = require('express');
const router = express.Router();
const { loadTimeframesForBacktest } = require('../services/dataLoader');
const { runBacktest } = require('../services/backtestEngine');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');

function filterInRange(data, toTime) {
  if (!toTime) return data;
  return data.filter(c => c[0] <= toTime);
}

router.get('/backTest', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'OG/USDT';
    
    // Pokúsime sa dostať z query ISO stringy – ak sú prázdne, ostanú undefined
    let fromTime = req.query.fromDate && req.query.fromDate.trim() !== ''
      ? new Date(req.query.fromDate).getTime()
      : undefined;
    let toTime = req.query.toDate && req.query.toDate.trim() !== ''
      ? new Date(req.query.toDate).getTime()
      : undefined;
    
    if (isNaN(fromTime)) fromTime = undefined;
    if (isNaN(toTime)) toTime = undefined;
    
    console.log("Pred načítaním dát – from:", fromTime, "to:", toTime);
    
    // Načítame dáta z ccxt (načítajú sa všetky príslušné timeframe)
    const data = await loadTimeframesForBacktest(symbol, fromTime, toTime);
    const dailyData    = filterInRange(data.ohlcvDailyAll, toTime);
    const weeklyData   = filterInRange(data.ohlcvWeeklyAll, toTime);
    const hourData     = filterInRange(data.ohlcv1hAll, toTime);
    const min15Data    = filterInRange(data.ohlcv15mAll, toTime);
    const min5Data    = filterInRange(data.ohlcv5mAll, toTime);
    const min1Data     = filterInRange(data.ohlcv1mAll, toTime);
    
    // Ak nie je zadaný fromTime alebo toTime, odvodíme ich z načítaných hodinových dát
    if (hourData.length > 0) {
      if (!fromTime) {
        fromTime = hourData[0][0];
        console.log("fromTime odvodzene z hourData:", tsToISO(fromTime));
      }
      if (!toTime) {
        toTime = hourData[hourData.length - 1][0];
        console.log("toTime odvodzene z hourData:", tsToISO(toTime));
      }
    }
    
    // Ak klient explicitne nezadal hoursToBacktest, vypočítame ho z rozdielu toTime - fromTime
    let hoursToBacktest;
    if (req.query.hoursToBacktest) {
      hoursToBacktest = parseInt(req.query.hoursToBacktest);
    } else {
      hoursToBacktest = Math.floor((toTime - fromTime) / (60 * 60 * 1000));
    }
    
    console.log("hoursToBacktest:", hoursToBacktest);
    
    // Spustíme backtest s odvodzenými časovými hodnotami a počtom hodín
    const backtestResult = await runBacktest({ 
      symbol, 
      hoursToBacktest, 
      fromTime, 
      toTime, 
      dailyData, 
      weeklyData, 
      hourData, 
      min15Data, 
      min5Data, 
      min1Data 
    });
    
    return res.json({
      success: true,
      finalPnLPercent: backtestResult.runningPnL,
      detail: backtestResult.results  // každý objekt obsahuje iteration, timestamp, ceny, atď.
    });
  } catch (err) {
    console.error('[BackTest Route] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;