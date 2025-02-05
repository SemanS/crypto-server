const { find1mClosePriceAtTime } = require('./dataLoader');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');
const { analyzeSymbolChain } = require('./gptServiceOffline');

// Výpočet PnL v percentách (výstup v percentách)
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
 * Timestamp novej sviečky je timestamp prvej sviečky.
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
  runBacktest – verzia, ktorá:
  • Definuje percentuálny target a stop loss (0,4 % zisk/strata)
  • Spúšťa GPT analýzy paralelne pre všetky rozhodovacie intervaly (Promise.all)
  • Pre každý rozhodovací interval prechádza 1‑minútové sviečky;
    ak je prekročený profit alebo SL, uzavrie obchod, pripočíta PnL a začne nový obchod.
  • Do update správ je pripojené pole technical_signal_strength.
*/
async function runBacktest({
    symbol,
    hoursToBacktest = 12,
    fromTime,
    toTime,
    dailyData,
    weeklyData,
    hourData,
    min15Data,
    min5Data,
    min1Data,
    // Použijeme iba parameter pre rozhodovací timeframe (napr. "15m")
    decisionTF = '15m'
  }, ws) {
    let runningPnL = 0;
  
    // Percentuálne nastavenie: 0,4 % zisk a 0,4 % strata
    const profitTargetPercent = 0.04; // 0,4%
    const lossTargetPercent = 0.08;   // 0,4%
  
    // Získame dĺžku rozhodovacieho intervalu v ms (napr. 15m)
    const decisionIntervalMs = timeframeToMs(decisionTF);
  
    // Vyberieme dátovú sadu podľa decisionTF
    let decisionData;
    if (decisionTF === '5m') {
      decisionData = min5Data;
    } else if (decisionTF === '15m') {
      decisionData = min15Data;
    } else if (decisionTF === '30m') {
      let source = min15Data;
      if (source.length % 2 !== 0) {
        source = source.slice(0, source.length - 1);
      }
      const aggregated30m = [];
      for (let i = 0; i < source.length; i += 2) {
        aggregated30m.push(aggregateCandlePairs(source[i], source[i+1]));
      }
      decisionData = aggregated30m;
    } else if (decisionTF === '1h' || decisionTF === '60m') {
      decisionData = hourData;
    } else {
      throw new Error(`Unsupported decisionTF value: ${decisionTF}`);
    }
  
    // Nájdeme index prvej sviečky v decisionData s timestampom >= fromTime
    let currentIdx = decisionData.findIndex(c => c[0] >= fromTime);
    if (currentIdx === -1) {
      throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
    }
    const startIdx = currentIdx;  // pre indexovanie paralelných GPT volaní
  
    console.log(`[BacktestEngine] Starting backtest for ${symbol} from ${tsToISO(fromTime)} to ${tsToISO(toTime)} (decisionTF=${decisionTF})`);
  
    // Paralelne spustíme GPT analýzy pre všetky rozhodovacie intervaly od currentIdx do konca
    const gptTasks = [];
    for (let i = currentIdx; i < decisionData.length; i++) {
      gptTasks.push(
        analyzeSymbolChain(
          symbol,
          dailyData.slice(),
          weeklyData.slice(),
          min15Data.slice(),
          hourData.slice(0, i + 1),
          min5Data.slice(),
          fromTime,
          toTime
        )
      );
    }
    const gptResults = await Promise.all(gptTasks);
  
    // Obchodný stav – zatiaľ žiadna pozícia
    let positionOpen = false;
    let positionDirection = null;
    let positionOpenPrice = 0;
    let positionOpenTime = 0;
  
    // Sekvenčná simulácia s pointerom currentIdx
    while (currentIdx < decisionData.length) {
      const decisionCandle = decisionData[currentIdx];
      const decisionTime = decisionCandle[0];
  
      // Ukončíme, ak sme mimo rozsahu
      if (toTime && decisionTime > toTime) break;
  
      // Použijeme predpočítaný GPT výsledok pre tento interval (index = currentIdx - startIdx)
      const analysis = gptResults[currentIdx - startIdx];
      if (!analysis || !analysis.gptOutput || typeof analysis.gptOutput.final_action === 'undefined') {
        throw new Error(`Missing final_action in analysis for decision time ${tsToISO(decisionTime)}`);
      }
      const finalAction = analysis.gptOutput.final_action;
      console.log(`[BacktestEngine] At ${tsToISO(decisionTime)} GPT recommends: ${finalAction}`);
  
      // Ak nie je otvorená pozícia a je signál, otvoríme obchod
      if (!positionOpen && (finalAction === 'BUY' || finalAction === 'SELL')) {
        const openTime = decisionTime + decisionIntervalMs;
        const openPrice = find1mClosePriceAtTime(min1Data, openTime);
        if (openPrice !== null) {
          positionOpen = true;
          positionDirection = finalAction;
          positionOpenPrice = openPrice;
          positionOpenTime = openTime;
          console.log(`[BacktestEngine] Opened ${positionDirection} at ${openPrice} on ${tsToISO(openTime)}`);
        }
      }
  
      // Spracovanie 1-minútových sviečok v rámci aktuálneho rozhodovacieho intervalu
      const intervalStart = decisionTime;
      const intervalEnd = intervalStart + decisionIntervalMs;
      const oneMinCandles = min1Data
        .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
        .sort((a, b) => a[0] - b[0]);
  
      if (positionOpen && oneMinCandles.length !== 0) {
        let tpPrice, slPrice;
        if (analysis?.gptOutput?.stop_loss != null && analysis.gptOutput.target_profit != null) {
          slPrice = analysis.gptOutput.stop_loss;
          tpPrice = analysis.gptOutput.target_profit;
          console.log(`[BacktestEngine] Using GPT-defined SL: ${slPrice} and TP: ${tpPrice}`);
        } else {
          if (positionDirection === 'BUY') {
            tpPrice = positionOpenPrice * (1 + profitTargetPercent);
            slPrice = positionOpenPrice * (1 - lossTargetPercent);
          } else {
            tpPrice = positionOpenPrice * (1 - profitTargetPercent);
            slPrice = positionOpenPrice * (1 + lossTargetPercent);
          }
          console.log(`[BacktestEngine] Using default percentages: TP=${tpPrice.toFixed(4)}, SL=${slPrice.toFixed(4)}`);
        }
  
        let tradeClosed = false;
        let triggerCandle = null;
        let candleIdx = 0;
        while (candleIdx < oneMinCandles.length) {
          const candle = oneMinCandles[candleIdx];
          const candleClose = candle[4];
          const currentPnL = computePnL(positionDirection, positionOpenPrice, candleClose);
          console.log(`[BacktestEngine] 1m ${tsToISO(candle[0])}: price=${candleClose}, PnL=${currentPnL.toFixed(2)}%`);
  
          if (positionDirection === 'BUY') {
            if (candle[2] >= tpPrice ||
                candle[3] <= slPrice ||
                currentPnL >= profitTargetPercent * 100 ||
                currentPnL <= -lossTargetPercent * 100) {
              tradeClosed = true;
              triggerCandle = candle;
              break;
            }
          }
          if (positionDirection === 'SELL') {
            if (candle[3] <= tpPrice ||
                candle[2] >= slPrice ||
                currentPnL >= profitTargetPercent * 100 ||
                currentPnL <= -lossTargetPercent * 100) {
              tradeClosed = true;
              triggerCandle = candle;
              break;
            }
          }
          candleIdx++;
        }
  
        const summaryCandle = tradeClosed && triggerCandle 
          ? triggerCandle 
          : (oneMinCandles.length ? oneMinCandles[oneMinCandles.length - 1] : null);
        if (summaryCandle) {
          const summaryPnL = computePnL(positionDirection, positionOpenPrice, summaryCandle[4]);
          if (tradeClosed) {
            runningPnL += summaryPnL;
          }
          // Pridávame aj technical_signal_strength do update správy
          const summaryRow = {
            iteration: currentIdx,
            timestamp: tsToISO(summaryCandle[0]),
            openPrice: positionOpenPrice,
            closePrice: summaryCandle[4],
            tradePnLPercent: summaryPnL,
            runningPnLPercent: runningPnL,
            position: positionDirection,
            holdPosition: tradeClosed ? "Closed" : "Held",
            closedAt: tradeClosed ? tsToISO(summaryCandle[0]) : "",
            gptComment: analysis?.gptOutput?.comment || "No comment",
            technical_signal_strength: analysis?.gptOutput?.technical_signal_strength || 0
          };
          ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
          if (tradeClosed) {
            console.log(`[BacktestEngine] Closed ${positionDirection} at ${summaryCandle[4]} on ${tsToISO(summaryCandle[0])} with PnL: ${summaryPnL.toFixed(2)}%`);
            // Uzatvoríme obchod a nastavíme pointer na prvú sviečku s timestampom väčším ako triggerCandle
            positionOpen = false;
            positionDirection = null;
            positionOpenPrice = 0;
            positionOpenTime = 0;
            const newIdx = decisionData.findIndex(c => c[0] > triggerCandle[0]);
            currentIdx = newIdx === -1 ? decisionData.length : newIdx;
            continue;
          }
        }
      }
      if (!positionOpen) {
        const summaryRow = {
          iteration: currentIdx,
          timestamp: tsToISO(decisionCandle[0]),
          openPrice: decisionCandle[4],
          closePrice: decisionCandle[4],
          tradePnLPercent: 0,
          runningPnLPercent: runningPnL,
          position: "HOLD",
          holdPosition: "No Trade",
          closedAt: tsToISO(decisionCandle[0]),
          gptComment: analysis?.gptOutput?.comment || "No comment",
          technical_signal_strength: analysis?.gptOutput?.technical_signal_strength || 0
        };
        ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
      }
      currentIdx++;
    }
  
    // Nútene uzavretie otvorenej pozície ak zostáva
    if (positionOpen) {
      const lastDecisionCandle = decisionData[currentIdx - 1];
      let finalClosePrice = positionOpenPrice;
      if (lastDecisionCandle) {
        const theoreticalCloseTime = lastDecisionCandle[0] + decisionIntervalMs;
        const foundPrice = find1mClosePriceAtTime(min1Data, theoreticalCloseTime);
        if (foundPrice !== null) finalClosePrice = foundPrice;
      }
      const finalTradePnL = computePnL(positionDirection, positionOpenPrice, finalClosePrice);
      runningPnL += finalTradePnL;
      const finalRow = {
        iteration: currentIdx,
        timestamp: lastDecisionCandle ? tsToISO(lastDecisionCandle[0]) : 'N/A',
        openPrice: positionOpenPrice,
        closePrice: finalClosePrice,
        tradePnLPercent: finalTradePnL,
        runningPnLPercent: runningPnL,
        position: positionDirection,
        holdPosition: positionOpen ? "Held" : "Closed",
        closedAt: tsToISO(Date.now()),
        gptComment: "Final trade closed",
        technical_signal_strength: 0
      };
      ws.send(JSON.stringify({ type: 'update', data: finalRow }));
      console.log(`[BacktestEngine] Forced close of open position with PnL: ${finalTradePnL.toFixed(2)}%`);
    }
  
    ws.send(JSON.stringify({ type: 'final', runningPnL }));
}
  
module.exports = { runBacktest };