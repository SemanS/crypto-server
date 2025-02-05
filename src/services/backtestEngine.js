const { find1mClosePriceAtTime } = require('./dataLoader');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');
const { analyzeSymbolChain } = require('./gptServiceOffline');

// Výpočet PnL v percentách
function computePnL(direction, openPrice, closePrice) {
  if (direction === 'BUY') {
    return ((closePrice - openPrice) / openPrice) * 100;
  } else if (direction === 'SELL') {
    return ((openPrice - closePrice) / openPrice) * 100;
  }
  return 0;
}

/**
 * Agregácia dvoch sviečok do jednej 30m sviečky.
 * Predpokladáme formát: [timestamp, open, high, low, close, volume].
 * Timestamp novej sviečky bude timestamp prvej sviečky.
 */
function aggregateCandlePairs(candle1, candle2) {
  const ts = candle1[0];
  const open = candle1[1];
  const high = Math.max(candle1[2], candle2[2]);
  const low = Math.min(candle1[3], candle2[3]);
  const close = candle2[4];
  const volume = candle1[5] + candle2[5];
  return [ts, open, high, low, close, volume];
}

/*
  runBacktest – táto verzia umožňuje konfigurovať rozhodovací interval pomocou parametra decisionTF,
  ktorý môže mať hodnoty napr. "5m", "15m", "30m", "1h" (alebo "60m").
  
  Počet intervalov sa vypočíta ako floor((toTime - fromTime) / (rozhodovací interval)).
  Pri otváraní/ukončení obchodu sa čas posúva o rozhodovací interval.
  Ostatné dáta pre výpočet indikátorov (dailyData, weeklyData, min15Data, min5Data, min1Data, hourData)
  ostávajú nezmenené.
*/
async function runBacktest({
  symbol,
  hoursToBacktest = 12, // pôvodná hodnota – dynamicky prepísaná
  fromTime,
  toTime,
  dailyData,
  weeklyData,
  hourData,
  min15Data,
  min5Data,
  min1Data,
  stopLossThreshold = 0.80,
  takeProfitGain = 1.10,
  // Nový parameter – rozhodovací interval (výpis: "30m", "15m", "5m", "1h" alebo "60m")
  decisionTF = '15m'
}, ws) {
  let runningPnL = 0;
  
  // Vypočítame dĺžku rozhodovacieho intervalu v ms
  const decisionIntervalMs = timeframeToMs(decisionTF);
  
  // Počet intervalov = floor((toTime - fromTime) / decisionIntervalMs)
  let intervalsToBacktest = fromTime && toTime 
    ? Math.floor((toTime - fromTime) / decisionIntervalMs)
    : 12;
  
  // Vyberieme dátovú sadu, ktorá sa použije pre rozhodovanie, podľa decisionTF.
  // Podporované hodnoty: "5m", "15m", "30m" (agregované z 15m) a "1h"/"60m" (hodinové dáta).
  let decisionData;
  if (decisionTF === '5m') {
    decisionData = min5Data;
  } else if (decisionTF === '15m') {
    decisionData = min15Data;
  } else if (decisionTF === '30m') {
    // Agregácia dvoch 15m sviečok -> 30m sviečka
    let source = min15Data;
    if (source.length % 2 !== 0) {
      // Odstránime poslednú, aby bolo párne
      source = source.slice(0, source.length - 1);
    }
    const aggregated30m = [];
    for (let i = 0; i < source.length; i += 2) {
      aggregated30m.push(aggregateCandlePairs(source[i], source[i + 1]));
    }
    decisionData = aggregated30m;
  } else if (decisionTF === '1h' || decisionTF === '60m') {
    decisionData = hourData;
  } else {
    throw new Error(`Unsupported decisionTF value: ${decisionTF}. Allowed values: "5m", "15m", "30m", "1h"`);
  }
  
  // Nájdeme index prvej sviečky v decisionData, ktorej timestamp >= fromTime
  const fromIndex = decisionData.findIndex(c => c[0] >= fromTime);
  if (fromIndex === -1) {
    throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
  }
  
  // Obmedzíme počet intervalov tak, aby sme nepresiahli dostupné dáta
  const availableIntervals = decisionData.length - fromIndex;
  intervalsToBacktest = Math.min(intervalsToBacktest, availableIntervals);
  
  console.log(`[BacktestEngine] Starting backtest for ${symbol} from ${tsToISO(fromTime)} to ${tsToISO(toTime)} (decisionTF=${decisionTF}, interval=${decisionIntervalMs} ms), total intervals: ${intervalsToBacktest}`);
  
  // Obchodný stav
  let positionOpen = false;
  let positionDirection = null;
  let positionOpenPrice = 0;
  let positionOpenTime = 0;
  
  // 1. Spustíme paralelne "interval tasks" – každá úloha spracúva jeden rozhodovací interval.
  const intervalTasks = [];
  for (let i = 0; i < intervalsToBacktest; i++) {
    const curIndex = fromIndex + i;
    intervalTasks.push((async () => {
      const decisionCandle = decisionData[curIndex];
      if (!decisionCandle) return null;
      const lastDecisionTS = decisionCandle[0];
      const analysis = await analyzeSymbolChain(
        symbol,
        dailyData.slice(),
        weeklyData.slice(),
        min15Data.slice(),
        hourData.slice(0, curIndex + 1),
        min5Data.slice(),
        fromTime,
        toTime
      );
      if (!analysis || !analysis.gptOutput || typeof analysis.gptOutput.final_action === 'undefined') {
        throw new Error(`Missing final_action in analysis for interval iteration ${i}: analysis=${JSON.stringify(analysis)}`);
      }
      const finalAction = analysis.gptOutput.final_action;
      return { i, lastDecisionTS, decisionCandle, finalAction, analysis };
    })());
  }
  
  // Počkame na dokončenie všetkých interval tasks a filtrovanie null hodnôt
  const rawIntervalResults = await Promise.all(intervalTasks);
  const intervalResults = rawIntervalResults.filter(r => r !== null);
  intervalResults.sort((a, b) => a.i - b.i);
  
  // 2. Sekvenčné spracovanie – vyhodnocovanie 1-minútových dát pre každý interval
  for (const res of intervalResults) {
    const { i, lastDecisionTS, decisionCandle, finalAction } = res;
    console.log(`[BacktestEngine] Interval iteration ${i} (${decisionTF}) at ${tsToISO(lastDecisionTS)} – GPT recommends: ${finalAction}`);
    
    // Otváranie obchodu, ak nie je otvorená pozícia a odporúča BUY/SELL
    if (!positionOpen && (finalAction === 'BUY' || finalAction === 'SELL')) {
      const openTime = lastDecisionTS + decisionIntervalMs;
      const openPrice = find1mClosePriceAtTime(min1Data, openTime);
      if (openPrice !== null) {
        positionOpen = true;
        positionDirection = finalAction;
        positionOpenPrice = openPrice;
        positionOpenTime = openTime;
        console.log(`[BacktestEngine] Opened ${positionDirection} position at ${openPrice} on ${tsToISO(openTime)}`);
      }
    }
    
    // Spracovanie 1-minútových dát v rámci tohto intervalu
    let summaryRow = null;
    let tradeClosed = false;
    let triggerCandle = null;
    if (positionOpen) {
      const intervalStart = lastDecisionTS;
      const intervalEnd = intervalStart + decisionIntervalMs;
      const oneMinCandles = min1Data
        .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
        .sort((a, b) => a[0] - b[0]);
      
      let slPrice, tpPrice;
      if (res.analysis?.gptOutput?.stop_loss != null && res.analysis.gptOutput.target_profit != null) {
        slPrice = res.analysis.gptOutput.stop_loss;
        tpPrice = res.analysis.gptOutput.target_profit;
        console.log(`[BacktestEngine] Using GPT-defined stop loss: ${slPrice} and target profit: ${tpPrice}`);
      } else {
        if (positionDirection === 'BUY') {
          slPrice = positionOpenPrice * stopLossThreshold;
          tpPrice = positionOpenPrice * takeProfitGain;
        } else {
          slPrice = positionOpenPrice / stopLossThreshold;
          tpPrice = positionOpenPrice / takeProfitGain;
        }
        console.log(`[BacktestEngine] Using default multipliers: stop loss=${slPrice}, target profit=${tpPrice}`);
      }
      
      for (const candle of oneMinCandles) {
        const candleClose = candle[4];
        const candleHigh = candle[2];
        const candleLow = candle[3];
        const currentPnL = computePnL(positionDirection, positionOpenPrice, candleClose);
        console.log(`[BacktestEngine] 1m ${tsToISO(candle[0])}: price=${candleClose}, PnL=${currentPnL.toFixed(2)}%`);
        if (positionDirection === 'BUY') {
          if (candleLow <= slPrice || candleHigh >= tpPrice) {
            tradeClosed = true;
            triggerCandle = candle;
            break;
          }
        } else {
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
      } else if (oneMinCandles.length) {
        summaryCandle = oneMinCandles[oneMinCandles.length - 1];
      }
      
      if (summaryCandle) {
        const summaryPnL = computePnL(positionDirection, positionOpenPrice, summaryCandle[4]);
        if (tradeClosed) runningPnL += summaryPnL;
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
      summaryRow = {
        iteration: i,
        timestamp: tsToISO(lastDecisionTS),
        openPrice: decisionCandle[4],
        closePrice: decisionCandle[4],
        tradePnLPercent: 0,
        runningPnLPercent: runningPnL,
        position: "HOLD",
        holdPosition: "No Trade",
        closedAt: tsToISO(lastDecisionTS)
      };
    }
    
    if (summaryRow) {
      ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
    }
  }
  
  // Ak pozícia zostáva otvorená, vynútime jej uzavretie
  if (positionOpen) {
    const lastDecisionCandle = decisionData[fromIndex + intervalsToBacktest - 1];
    let finalClosePrice = positionOpenPrice;
    if (lastDecisionCandle) {
      const theoreticalCloseTime = lastDecisionCandle[0] + decisionIntervalMs;
      const foundPrice = find1mClosePriceAtTime(min1Data, theoreticalCloseTime);
      if (foundPrice !== null) finalClosePrice = foundPrice;
    }
    const finalTradePnL = computePnL(positionDirection, positionOpenPrice, finalClosePrice);
    runningPnL += finalTradePnL;
    const finalRow = {
      iteration: intervalsToBacktest,
      timestamp: lastDecisionCandle ? tsToISO(lastDecisionCandle[0]) : 'N/A',
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
  
  ws.send(JSON.stringify({ type: 'final', runningPnL }));
}

module.exports = { runBacktest };