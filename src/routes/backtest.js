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
    // Oprava: kontrolujeme zadané hodnoty oboch parametrov zvlášť
    let fromTime = req.query.fromDate && req.query.fromDate.trim() !== ''
      ? new Date(req.query.fromDate).getTime()
      : undefined;
    let toTime = req.query.toDate && req.query.toDate.trim() !== ''
      ? new Date(req.query.toDate).getTime()
      : undefined;

    // Pre istotu, ak vzniknú NaN hodnoty, tak nastavíme undefined
    if (isNaN(fromTime)) fromTime = undefined;
    if (isNaN(toTime)) toTime = undefined;
    
    console.log("from", fromTime, "to", toTime); // pre debug

    const hoursToBacktest = parseInt(req.query.hoursToBacktest || '12');

    const data = await loadTimeframesForBacktest(symbol, fromTime, toTime);
    const dailyData = filterInRange(data.ohlcvDailyAll, toTime);
    const weeklyData = filterInRange(data.ohlcvWeeklyAll, toTime);
    const hourData = filterInRange(data.ohlcv1hAll, toTime);
    const min15Data = filterInRange(data.ohlcv15mAll, toTime);
    const min1Data = filterInRange(data.ohlcv1mAll, toTime);

    // Ak nie je zadaný fromTime, vyberieme prvý timestamp z hodinových dát
    if (!fromTime && hourData.length > 0) {
      fromTime = hourData[0][0];
    }

    const backtestResult = await runBacktest({ 
      symbol, hoursToBacktest, fromTime, toTime, 
      dailyData, weeklyData, hourData, min15Data, min1Data 
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