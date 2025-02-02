const { find1mClosePriceAtTime } = require('./dataLoader');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');
const { analyzeSymbolChain } = require('./gptService');

// Výpočet PnL v percentách
function computePnL(direction, openPrice, closePrice) {
  if (direction === 'BUY') {
    return ((closePrice - openPrice) / openPrice) * 100;
  } else if (direction === 'SELL') {
    return ((openPrice - closePrice) / openPrice) * 100;
  }
  return 0;
}

// Upravená funkcia runBacktest: pridali sme parameter ws
async function runBacktest({
  symbol,
  hoursToBacktest = 12,
  fromTime,
  toTime,
  dailyData,
  weeklyData,
  hourData,
  min15Data,
  min1Data,
  stopLossThreshold = 0.95, // napríklad 95%
  takeProfitGain = 1.10      // napríklad 110%
}, ws) {
  let runningPnL = 0;

  // Nájdeme index prvej hodiny, ktorá je >= fromTime
  const fromIndex = hourData.findIndex(c => c[0] >= fromTime);
  if (fromIndex === -1) throw new Error(`No hour data found at or after ${tsToISO(fromTime)}`);

  console.log(`[BacktestEngine] Starting backtest from index ${fromIndex} (${tsToISO(hourData[fromIndex][0])}) for ${hoursToBacktest} hours`);

  let positionOpen = false;
  let positionDirection = null; // 'BUY' alebo 'SELL'
  let positionOpenPrice = 0;
  let positionOpenTime = 0;

  for (let i = 0; i < hoursToBacktest; i++) {
    const curIndex = fromIndex + i;
    const hourCandle = hourData[curIndex];
    if (!hourCandle) break;
    const lastHourTS = hourCandle[0];
    console.log(`[BacktestEngine] Hour iteration ${i}, timestamp: ${tsToISO(lastHourTS)}`);

    // Príprava slice dát a fundamentálna analýza – (podľa Vášho pôvodného kódu)
    // ...

    // Volanie GPT analýzy
    const analysis = await analyzeSymbolChain(
      symbol,
      dailyData.slice(), // prípadne prispôsobte slice podľa logiky
      weeklyData.slice(),
      min15Data.slice(),
      hourData.slice(0, curIndex + 1),
      fromTime,
      toTime,
      null  // v ukážke zjednodušíme fundamentálne dáta
    );
    const finalAction = analysis.gptOutput.final_action || 'HOLD';
    console.log(`[BacktestEngine] GPT recommended: ${finalAction}`);

    // Otvorenie pozície, ak ešte nie je otvorená a odporúčanie je BUY/SELL
    if (!positionOpen && (finalAction === 'BUY' || finalAction === 'SELL')) {
      const openTime = lastHourTS + timeframeToMs('1h'); // otvorenie v nasledujúcej hodine
      const openPrice = find1mClosePriceAtTime(min1Data, openTime);
      if (openPrice !== null) {
        positionOpen = true;
        positionDirection = finalAction;
        positionOpenPrice = openPrice;
        positionOpenTime = openTime;
        console.log(`[BacktestEngine] Opened ${positionDirection} position at ${openPrice} on ${tsToISO(openTime)}`);
      }
    }

    let summaryRow = null;
    let tradeClosed = false;
    let triggerCandle = null;

    if (positionOpen) {
      const hourStart = lastHourTS;
      const hourEnd = hourStart + timeframeToMs('1h');
      const oneMinCandles = min1Data
        .filter(c => c[0] >= hourStart && c[0] < hourEnd)
        .sort((a, b) => a[0] - b[0]);

      let slPrice, tpPrice;
      if (positionDirection === 'BUY') {
        slPrice = positionOpenPrice * stopLossThreshold;
        tpPrice = positionOpenPrice * takeProfitGain;
      } else {
        slPrice = positionOpenPrice / stopLossThreshold;
        tpPrice = positionOpenPrice / takeProfitGain;
      }

      for (const candle of oneMinCandles) {
        const candleTS = candle[0];
        const candleClose = candle[4];
        const candleHigh = candle[2];
        const candleLow = candle[3];
        const currentPnL = computePnL(positionDirection, positionOpenPrice, candleClose);
        console.log(`[BacktestEngine] 1m ${tsToISO(candleTS)}: price=${candleClose}, PnL=${currentPnL.toFixed(2)}%`);

        if (positionDirection === 'BUY') {
          if (candleLow <= slPrice || candleHigh >= tpPrice) {
            tradeClosed = true;
            triggerCandle = candle;
            break;
          }
        } else { // SELL
          if (candleHigh >= slPrice || candleLow <= tpPrice) {
            tradeClosed = true;
            triggerCandle = candle;
            break;
          }
        }
      }

      let summaryCandle = null;
      if (tradeClosed && triggerCandle) {
        summaryCandle = triggerCandle;
      } else if (oneMinCandles.length > 0) {
        summaryCandle = oneMinCandles[oneMinCandles.length - 1];
      }

      if (summaryCandle) {
        const summaryPnL = computePnL(positionDirection, positionOpenPrice, summaryCandle[4]);
        if (tradeClosed) {
          runningPnL += summaryPnL;
        }
        summaryRow = {
          iteration: i,
          timestamp: tsToISO(summaryCandle[0]),
          openPrice: positionOpenPrice,
          closePrice: summaryCandle[4],
          tradePnLPercent: summaryPnL,
          runningPnLPercent: runningPnL,
          position: positionDirection,
          holdPosition: tradeClosed ? "Closed" : "Held",
          closedAt: tradeClosed ? tsToISO(summaryCandle[0]) : ""
        };
        if (tradeClosed) {
          console.log(`[BacktestEngine] Closed ${positionDirection} at ${summaryCandle[4]} on ${tsToISO(summaryCandle[0])} with PnL: ${summaryPnL.toFixed(2)}%`);
          positionOpen = false;
          positionDirection = null;
          positionOpenPrice = 0;
          positionOpenTime = 0;
        }
      }
    }

    if (!positionOpen && !summaryRow) {
      // Ak nebola vykonaná žiadna obchodná operácia, vytvoríme summary riadok
      summaryRow = {
        iteration: i,
        timestamp: tsToISO(lastHourTS),
        openPrice: hourCandle[4],
        closePrice: hourCandle[4],
        tradePnLPercent: 0,
        runningPnLPercent: runningPnL,
        position: "HOLD",
        holdPosition: "No Trade",
        closedAt: tsToISO(lastHourTS)
      };
    }

    if (summaryRow) {
      // Odosielame každý riadok ako update cez WebSocket
      ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
    }
  } // koniec cyklu

  // Ak pozícia stále zostáva otvorená, vynútime jej uzavretie
  if (positionOpen) {
    const lastHourCandle = hourData[fromIndex + hoursToBacktest - 1];
    let finalClosePrice = positionOpenPrice;
    if (lastHourCandle) {
      const theoreticalCloseTime = lastHourCandle[0] + timeframeToMs('1h');
      const foundPrice = find1mClosePriceAtTime(min1Data, theoreticalCloseTime);
      if (foundPrice !== null) finalClosePrice = foundPrice;
    }
    const finalTradePnL = computePnL(positionDirection, positionOpenPrice, finalClosePrice);
    runningPnL += finalTradePnL;
    const finalRow = {
      iteration: hoursToBacktest,
      timestamp: lastHourCandle ? tsToISO(lastHourCandle[0]) : 'N/A',
      openPrice: positionOpenPrice,
      closePrice: finalClosePrice,
      tradePnLPercent: finalTradePnL,
      runningPnLPercent: runningPnL,
      position: positionDirection,
      holdPosition: positionOpen ? "Held" : "Closed",
      closedAt: tsToISO(Date.now())
    };
    ws.send(JSON.stringify({ type: 'update', data: finalRow }));
    console.log(`[BacktestEngine] Forced close position with PnL: ${finalTradePnL.toFixed(2)}%`);
  }

  // Nakoniec odošleme finálnu správu s konečným runningPnL
  ws.send(JSON.stringify({ type: 'final', runningPnL }));
}

module.exports = { runBacktest };