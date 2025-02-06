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
 * Vracia hodnotu v percentách, napr. 0.03 znamená 0.03%.
 */
function computePnL(direction, openPrice, closePrice) {
  if (direction === 'BUY') {
    return ((closePrice - openPrice) / openPrice) * 100;
  } else if (direction === 'SELL') {
    return ((openPrice - closePrice) / openPrice) * 100;
  }
  return 0;
}

/*
  runBacktest – nová verzia, ktorá:
   • Spracováva každý rozhodovací interval ("iteráciu") nezávisle.
   • Obchod sa otvára ihneď na začiatku intervalu (napr. 08:00, 08:15, …), pričom sa využíva otváracia cena
     1‑minútovej sviečky daného intervalu.
   • Exit sa vyhodnocuje cez iteráciu 1‑minútových sviečok v rámci intervalu [decisionTime, decisionTime + interval).
   • Výsledná update správa obsahuje openPrice príslušného intervalu.
   • Running PnL sa aktualizuje len vtedy, keď dosiahneme minimálny profit či loss threshold:
        – Pre BUY: len ak trade PnL >= 0.04 %, započítame 0.04 %
        – Pre loss (alebo SELL analogicky): len ak trade PnL <= -0.8 %, započítame -0.8 %
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
    // Nastavené hodnoty – teraz lossTargetPercent je 0.8 (t.j. 0.8 %)
    const profitTargetPercent = 0.4;
    const lossTargetPercent = 0.8;
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
  
    // Určíme, od ktorej candle v decisionData začať
    let startIdx = decisionData.findIndex(c => c[0] >= fromTime);
    if (startIdx === -1) {
      throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
    }
  
    console.log(`[BacktestEngine] Spúšťam backtest pre ${symbol} od ${tsToISO(fromTime)} do ${tsToISO(toTime)} s decisionTF=${decisionTF}`);
  
    // Spustíme paralelne GPT analýzy pre každý rozhodovací interval od startIdx
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
  
    // Spracovanie každého rozhodovacieho intervalu nezávisle
    for (let i = startIdx; i < decisionData.length; i++) {
      const decisionCandle = decisionData[i];
      const decisionTime = decisionCandle[0];
      if (toTime && decisionTime > toTime) break;
  
      const analysis = gptResults[i - startIdx];
      if (!analysis || !analysis.gptOutput || typeof analysis.gptOutput.final_action === 'undefined') {
        throw new Error(`Missing final_action v analýze pre čas ${tsToISO(decisionTime)}`);
      }
      const finalAction = analysis.gptOutput.final_action;
      console.log(`[BacktestEngine] Iterácia ${i} – decisionTime: ${tsToISO(decisionTime)}, GPT odporúča: ${finalAction}`);
  
      let summaryRow;
      if (finalAction === 'BUY' || finalAction === 'SELL') {
        // Obchod otvárame ihneď na začiatku intervalu (napr. 08:00)
        const openTime = decisionTime;
        const openPrice = find1mOpenPriceAtTime(min1Data, openTime);
        if (openPrice === null) {
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
        } else {
          console.log(`[BacktestEngine] Otváram obchod na ${tsToISO(openTime)} so openPrice ${openPrice}`);
  
          // Definujeme interval, počas ktorého budeme vyhodnocovať exit signál: [decisionTime, decisionTime + decisionIntervalMs)
          const intervalStart = decisionTime;
          const intervalEnd = decisionTime + decisionIntervalMs;
          const oneMinCandles = min1Data
            .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
            .sort((a, b) => a[0] - b[0]);
          console.log(`[BacktestEngine] Interval ${tsToISO(intervalStart)} - ${tsToISO(intervalEnd)}: Našiel som ${oneMinCandles.length} 1m sviečok.`);
  
          // Vyhodnotíme exit v rámci intervalu – použijeme upravené podmienky:
          // Pri BUY trade: ak maximum ceny (candle[2]) dosiahne openPrice * (1 + profitTargetPercent/100)
          // alebo ak minimum (candle[3]) klesne pod openPrice*(1 - lossTargetPercent/100)
          // alebo ak computePnL v percentách prekročí threshold (profitTargetPercent alebo -lossTargetPercent)
          let tradeClosed = false;
          let triggerCandle = null;
          for (let candle of oneMinCandles) {
            const currentPnL = computePnL(finalAction, openPrice, candle[4]);
            console.log(`[BacktestEngine] 1m sviečka ${tsToISO(candle[0])}: cena=${candle[4]}, PnL=${currentPnL.toFixed(2)}%`);
            if (finalAction === 'BUY') {
              if (
                candle[2] >= openPrice * (1 + profitTargetPercent/100) ||
                candle[3] <= openPrice * (1 - lossTargetPercent/100) ||
                currentPnL >= profitTargetPercent ||
                currentPnL <= -lossTargetPercent
              ) {
                tradeClosed = true;
                triggerCandle = candle;
                console.log(`[BacktestEngine] BUY exit podmienky splnené na sviečke ${tsToISO(candle[0])}`);
                break;
              }
            } else if (finalAction === 'SELL') {
              if (
                candle[3] <= openPrice * (1 - profitTargetPercent/100) ||
                candle[2] >= openPrice * (1 + lossTargetPercent/100) ||
                currentPnL >= profitTargetPercent ||
                currentPnL <= -lossTargetPercent
              ) {
                tradeClosed = true;
                triggerCandle = candle;
                console.log(`[BacktestEngine] SELL exit podmienky splnené na sviečke ${tsToISO(candle[0])}`);
                break;
              }
            }
          }
  
          // Ak bol obchod ukončený exit signálom, summary candle je triggerCandle,
          // inak použijeme poslednú sviečku v intervale
          const summaryCandle = (tradeClosed && triggerCandle)
              ? triggerCandle
              : (oneMinCandles.length ? oneMinCandles[oneMinCandles.length - 1] : null);
          // Vypočítame trade PnL zo získanej summary candle
          const summaryPnL = summaryCandle ? computePnL(finalAction, openPrice, summaryCandle[4]) : 0;
          // Upravená logika: Running PnL sa aktualizuje len, ak PnL daného obchodu prekročí threshold.
          // V opačnom prípade sa do runningPnL nič nezapocíta.
          let effectivePnL = 0;
          if (summaryPnL >= profitTargetPercent) {
            effectivePnL = profitTargetPercent;
          } else if (summaryPnL <= -lossTargetPercent) {
            effectivePnL = -lossTargetPercent;
          }
          console.log(`[BacktestEngine] Pre túto iteráciu summaryPnL: ${summaryPnL.toFixed(2)}%, effectivePnL (zapocítané): ${effectivePnL.toFixed(2)}%`);
          runningPnL += effectivePnL;
  
          summaryRow = {
            iteration: i,
            timestamp: summaryCandle ? tsToISO(summaryCandle[0]) : tsToISO(decisionTime),
            openPrice: openPrice, 
            closePrice: summaryCandle ? summaryCandle[4] : decisionCandle[4],
            tradePnLPercent: summaryPnL,
            runningPnLPercent: runningPnL,
            position: finalAction,
            holdPosition: tradeClosed ? "Closed" : "Held",
            closedAt: tradeClosed ? tsToISO(summaryCandle[0]) : "",
            gptComment: analysis.gptOutput.comment || "No comment",
            technical_signal_strength: analysis.gptOutput.technical_signal_strength || 0
          };
        }
      } else {
        // Ak GPT neodporúča obchod (žiadny signál), použijeme údaje decision candle
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
  
    ws.send(JSON.stringify({ type: 'final', runningPnL }));
    console.log(`[BacktestEngine] Backtest dokončený, runningPnL: ${runningPnL}`);
}
  
module.exports = { runBacktest };