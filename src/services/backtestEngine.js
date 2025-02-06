const { find1mClosePriceAtTime, find1mOpenPriceAtTime } = require('./dataLoader');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');
const { analyzeSymbolChain } = require('./gptServiceOffline');

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

/**
 * Výpočet PnL v percentách.
 * Napr. pre BUY: ((currentPrice - referencePrice) / referencePrice)*100.
 */
function computePnL(direction, referencePrice, currentPrice) {
  if (direction === 'BUY') {
    return ((currentPrice - referencePrice) / referencePrice) * 100;
  } else if (direction === 'SELL') {
    return ((referencePrice - currentPrice) / referencePrice) * 100;
  }
  return 0;
}

/*
  runBacktest – táto verzia:
   • Otvára pozíciu na začiatku intervalu, pričom sa nastavia:
         originalEntryPrice – hodnota z momentu otvorenia (napr. 07:00) – ta sa NEaktualizuje!
         positionOpen = true a tradeEntryTime.
   • V každom ďalšom rozhodovacom intervale, ak je pozícia stále otvorená,
         do správy (update) sa uvedie "openPrice" získaná pre daný interval (napr. 07:15, 07:30, …),
         avšak kumulatívny PnL sa počíta z originalEntryPrice.
   • Ak kumulatívny PnL prekročí hranicu (profit alebo stop loss), potom sa obchod uzavrie a do Running PnL
         sa započíta fixná hodnota (profitTargetPercent alebo -lossTargetPercent).
   • Ak kumulatívny PnL je napriek tomu napr. -0.48% (pod limitom -0.8), Running PnL ostáva 0.
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
    // Rozhodovací interval, napr. "15m"
    decisionTF = '15m'
  }, ws) {
    let runningPnL = 0;
    // Nastavené thresholdy v percentách (realistickejšie)
    const profitTargetPercent = 0.4;   // profit target 0.4%
    const lossTargetPercent = 0.8;     // stop loss 0.8%
    const decisionIntervalMs = timeframeToMs(decisionTF);
  
    // Vyberáme dátovú sadu podľa decisionTF
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
  
    // Nájdeme index prvej candle v decisionData, ktorej timestamp je >= fromTime
    let startIdx = decisionData.findIndex(c => c[0] >= fromTime);
    if (startIdx === -1) {
      throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
    }
  
    console.log(`[BacktestEngine] Spúšťam backtest pre ${symbol} od ${tsToISO(fromTime)} do ${tsToISO(toTime)} s decisionTF=${decisionTF}`);
  
    // Paralelne spustíme GPT analýzy pre každý rozhodovací interval od startIdx
    const gptTasks = [];
    for (let i = startIdx; i < decisionData.length; i++) {
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
  
    // Stav obchodovania:
    // Ak obchod otvoríme, nastavíme:
    // – originalEntryPrice: z min1Data pre daný interval (napr. 07:00)
    // – positionOpen, positionDirection, tradeEntryTime.
    let positionOpen = false;
    let positionDirection = null;
    let originalEntryPrice = null;
    let tradeEntryTime = null;
  
    // Pre každý rozhodovací interval (iteráciu)
    for (let i = startIdx; i < decisionData.length; i++) {
      const decisionCandle = decisionData[i];
      const decisionTime = decisionCandle[0];
      if (toTime && decisionTime > toTime) break;
  
      const analysis = gptResults[i - startIdx];
      if (!analysis || !analysis.gptOutput || typeof analysis.gptOutput.final_action === 'undefined') {
        throw new Error(`Missing final_action v analýze pre čas ${tsToISO(decisionTime)}`);
      }
      const gptSignal = analysis.gptOutput.final_action;
      console.log(`[BacktestEngine] Iterácia ${i} – decisionTime: ${tsToISO(decisionTime)}, GPT odporúča: ${gptSignal}`);
  
      let summaryRow;
      if (!positionOpen && (gptSignal === 'BUY' || gptSignal === 'SELL')) {
        // Otvoríme novú pozíciu – použijeme open cenu z tohto intervalu (napr. 07:00)
        const openTime = decisionTime;
        const tradeOpenPrice = find1mOpenPriceAtTime(min1Data, openTime);
        if (tradeOpenPrice === null) {
          console.log(`[BacktestEngine] Neviem nájsť otváraciu cenu pre ${tsToISO(openTime)}`);
          summaryRow = {
            iteration: i,
            timestamp: tsToISO(decisionTime),
            openPrice: decisionCandle[1],
            closePrice: decisionCandle[4],
            tradePnLPercent: 0,
            runningPnLPercent: runningPnL,
            position: "HOLD",
            holdPosition: "No Trade",
            closedAt: tsToISO(decisionTime),
            gptComment: analysis.gptOutput.comment || "No comment",
            technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
          };
          // Odošleme update a pokračujeme do ďalšej iterácie.
          console.log(`[BacktestEngine] Odosielam update: ${JSON.stringify(summaryRow)}`);
          ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
          continue;
        } else {
          positionOpen = true;
          positionDirection = gptSignal;
          originalEntryPrice = tradeOpenPrice;  // Pôvodná vstupná cena – používa sa pre kumulatívny výpočet
          tradeEntryTime = openTime;
          console.log(`[BacktestEngine] Otvoril som ${positionDirection} obchod v čase ${tsToISO(openTime)} s originalEntryPrice ${originalEntryPrice}`);
          // Reportujeme otvorenie (môžete to aj neodosielať, ak chcete až po uzavretí)
          summaryRow = {
            iteration: i,
            timestamp: tsToISO(openTime),
            openPrice: tradeOpenPrice,
            closePrice: tradeOpenPrice,
            tradePnLPercent: 0,
            runningPnLPercent: runningPnL,
            position: positionDirection,
            holdPosition: "Opened",
            closedAt: "",
            gptComment: analysis.gptOutput.comment || "No comment",
            technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
          };
          console.log(`[BacktestEngine] Odosielam update: ${JSON.stringify(summaryRow)}`);
          ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
          continue;  // Pokračujeme do ďalšej iterácie
        }
      } else if (positionOpen) {
        // Ak je pozícia už otvorená, pre tento interval získame aktuálnu (roll-over) open cenu (napr. 07:15)
        const currentIntervalOpenPrice = find1mOpenPriceAtTime(min1Data, decisionTime);
        // Získame všetky 1m sviečky v intervale [decisionTime, decisionTime + decisionIntervalMs)
        const intervalStart = decisionTime;
        const intervalEnd = decisionTime + decisionIntervalMs;
        const oneMinCandles = min1Data
          .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
          .sort((a, b) => a[0] - b[0]);
        console.log(`[BacktestEngine] Interval ${tsToISO(intervalStart)} - ${tsToISO(intervalEnd)}: Nasiel som ${oneMinCandles.length} 1m sviečok.`);
  
        // Ak je v intervale aspoň jedna candle, použijeme poslednú pre výpočet kumulatívneho PnL (v percentách) z originalEntryPrice
        const lastCandle = oneMinCandles.length ? oneMinCandles[oneMinCandles.length - 1] : null;
        const cumulativePnL = lastCandle ? computePnL(positionDirection, originalEntryPrice, lastCandle[4]) : 0;
        console.log(`[BacktestEngine] Kumulatívny PnL od ${originalEntryPrice} do ${lastCandle ? lastCandle[4] : 'N/A'}: ${cumulativePnL.toFixed(2)}%`);
  
        // Ak kumulatívny PnL prekročí stop loss alebo profit target, uzavrieme pozíciu.
        if ((positionDirection === 'BUY' && (cumulativePnL <= -lossTargetPercent || cumulativePnL >= profitTargetPercent)) ||
            (positionDirection === 'SELL' && (cumulativePnL <= -lossTargetPercent || cumulativePnL >= profitTargetPercent))) {
          // Efektívny PnL je fixne nastavený na príslušný threshold.
          const effectivePnL = (cumulativePnL <= -lossTargetPercent) ? -lossTargetPercent : profitTargetPercent;
          console.log(`[BacktestEngine] Trigger exit: Efektívny PnL nastavujem na ${effectivePnL}%`);
          runningPnL += effectivePnL;
          summaryRow = {
            iteration: i,
            timestamp: tsToISO(lastCandle[0]),
            openPrice: currentIntervalOpenPrice,
            closePrice: lastCandle[4],
            tradePnLPercent: cumulativePnL,
            runningPnLPercent: runningPnL,
            position: positionDirection,
            holdPosition: "Closed",
            closedAt: tsToISO(lastCandle[0]),
            gptComment: analysis.gptOutput.comment || "No comment",
            technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
          };
          console.log(`[BacktestEngine] Uzavrel som obchod s efektívnym PnL: ${effectivePnL}%, Running PnL: ${runningPnL}%`);
          // Reset obchodného stavu
          positionOpen = false;
          positionDirection = null;
          originalEntryPrice = null;
          tradeEntryTime = null;
        } else {
          // Pozícia pokračuje – ale reportujeme, že v tomto intervale je kumulatívny PnL (v percentách)
          summaryRow = {
            iteration: i,
            timestamp: tsToISO(intervalEnd),
            openPrice: currentIntervalOpenPrice,  // aktualizovaná (roll-over) open cena
            closePrice: lastCandle ? lastCandle[4] : decisionCandle[4],
            tradePnLPercent: cumulativePnL,
            runningPnLPercent: runningPnL,
            position: positionDirection,
            holdPosition: "Held",
            closedAt: "",
            gptComment: analysis.gptOutput.comment || "No comment",
            technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
          };
          console.log(`[BacktestEngine] Pozícia zostáva otvorená; kumulatívny PnL = ${cumulativePnL.toFixed(2)}%`);
        }
      } else {
        // Ak nie je otvorená ani neexistuje signál, reportujeme HOLD na základe decision candle
        summaryRow = {
          iteration: i,
          timestamp: tsToISO(decisionTime),
          openPrice: decisionCandle[1],
          closePrice: decisionCandle[4],
          tradePnLPercent: 0,
          runningPnLPercent: runningPnL,
          position: "HOLD",
          holdPosition: "No Trade",
          closedAt: tsToISO(decisionTime),
          gptComment: analysis.gptOutput.comment || "No comment",
          technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
        };
      }
      console.log(`[BacktestEngine] Odosielam update: ${JSON.stringify(summaryRow)}`);
      ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
    }
  
    // Nútene uzavretie pozície, ak zostáva otvorená
    if (positionOpen) {
      const lastDecisionCandle = decisionData[decisionData.length - 1];
      const forcedClosePrice = find1mClosePriceAtTime(min1Data, lastDecisionCandle[0] + decisionIntervalMs) || lastDecisionCandle[4];
      const forcedCumulativePnL = computePnL(positionDirection, originalEntryPrice, forcedClosePrice);
      runningPnL += (forcedCumulativePnL <= -lossTargetPercent) ? -lossTargetPercent :
                      (forcedCumulativePnL >= profitTargetPercent) ? profitTargetPercent : forcedCumulativePnL;
      const finalRow = {
        iteration: decisionData.length,
        timestamp: tsToISO(lastDecisionCandle[0]),
        openPrice: originalEntryPrice,
        closePrice: forcedClosePrice,
        tradePnLPercent: forcedCumulativePnL,
        runningPnLPercent: runningPnL,
        position: positionDirection,
        holdPosition: "Closed",
        closedAt: tsToISO(Date.now()),
        gptComment: "Final trade closed",
        technical_signal_strength: 0
      };
      console.log(`[BacktestEngine] Nútene uzavrel som pozíciu: ${JSON.stringify(finalRow)}`);
      ws.send(JSON.stringify({ type: 'update', data: finalRow }));
    }
  
    ws.send(JSON.stringify({ type: 'final', runningPnL }));
    console.log(`[BacktestEngine] Backtest dokončený, runningPnL: ${runningPnL}`);
}
  
module.exports = { runBacktest };