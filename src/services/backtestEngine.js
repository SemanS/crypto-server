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
 * Napríklad pre BUY: ((currentPrice - referencePrice)/referencePrice)*100.
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
   • Keď sa pozícia otvára, nastavíme originalEntryPrice zo 1m sviečky (napr. 07:00).
   • Pre každý 1m interval (decisionTF === "1m") reportujeme:
         openTime = tsToISO(decisionTime)    (napr. 07:00:00.000Z),
         closeTime = tsToISO(decisionTime + decisionIntervalMs - 1)  (napr. 07:00:59.999Z)
   • V prvom intervale (i === startIdx) použijeme close cenu priamo z decisionCandle[4] – ak je taká v dátach.
   • Forced closure update sa odošle iba ak posledný update (podľa pomocnej premennej) nemá rovnaký closeTime.
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

function computePnL(direction, referencePrice, currentPrice) {
  if (direction === 'BUY') {
    return ((currentPrice - referencePrice) / referencePrice) * 100;
  } else if (direction === 'SELL') {
    return ((referencePrice - currentPrice) / referencePrice) * 100;
  }
  return 0;
}

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
  decisionTF = '15m'
}, ws) {
  let runningPnL = 0;
  const profitTargetPercent = 0.4;
  const lossTargetPercent = 0.8;
  const decisionIntervalMs = timeframeToMs(decisionTF);

  let lastCloseTimeSent = null;
  let decisionData;
  if (decisionTF === '1m') {
    decisionData = min1Data;
  } else if (decisionTF === '5m') {
    decisionData = min5Data;
  } else if (decisionTF === '15m') {
    decisionData = min15Data;
  } else if (decisionTF === '30m') {
    let source = min15Data;
    if (source.length % 2 !== 0) {
      source = source.slice(0, source.length - 1);
    }
    let aggregated30m = [];
    for (let i = 0; i < source.length; i += 2) {
      aggregated30m.push(aggregateCandlePairs(source[i], source[i+1]));
    }
    decisionData = aggregated30m;
  } else if (decisionTF === '1h' || decisionTF === '60m') {
    decisionData = hourData;
  } else {
    throw new Error(`Unsupported decisionTF value: ${decisionTF}`);
  }
  decisionData.sort((a, b) => a[0] - b[0]);

  let startIdx = decisionData.findIndex(c => c[0] >= fromTime);
  if (startIdx === -1) {
    throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
  }

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

  let positionOpen = false;
  let positionDirection = null;
  let originalEntryPrice = null;
  let tradeEntryTime = null;

  for (let i = startIdx; i < decisionData.length; i++) {
    const decisionCandle = decisionData[i];
    const decisionTime = decisionCandle[0];
    if (toTime && decisionTime > toTime) break;

    // Používame gptSynergyOutput.
    const analysis = gptResults[i - startIdx];
    if (!analysis || !analysis.gptSynergyOutput || typeof analysis.gptSynergyOutput.final_action === 'undefined') {
      throw new Error(`Missing final_action in analysis for time ${tsToISO(decisionTime)}`);
    }
    const gptSignal = analysis.gptSynergyOutput.final_action;

    // Zostavíme jednotný objekt gptData, ktorý obsahuje nielen macro_comment (alebo comment) 
    // ale aj final_action a technical_signal_strength pre všetky GPT výstupy.
    const gptData = {
      gptSynergyOutput: {
        final_action: analysis.gptSynergyOutput.final_action,
        technical_signal_strength: analysis.gptSynergyOutput.technical_signal_strength,
        comment: analysis.gptSynergyOutput.comment
      },
      gptOutputDaily: {
        final_action: analysis.gptOutputDaily.macro_view || "-",
        technical_signal_strength: analysis.gptOutputDaily.technical_signal_strength || 0,
        macro_comment: analysis.gptOutputDaily.macro_comment || "-"
      },
      gptOutputWeekly: {
        final_action: analysis.gptOutputWeekly.weekly_view || "-",
        technical_signal_strength: analysis.gptOutputWeekly.technical_signal_strength || 0,
        weekly_comment: analysis.gptOutputWeekly.weekly_comment || "-"
      },
      gptOutput15m: {
        final_action: analysis.gptOutput15m.macro_view || "-",
        technical_signal_strength: analysis.gptOutput15m.technical_signal_strength || 0,
        macro_comment: analysis.gptOutput15m.macro_comment || "-"
      },
      gptOutput5m: {
        final_action: analysis.gptOutput5m.macro_view || "-",
        technical_signal_strength: analysis.gptOutput5m.technical_signal_strength || 0,
        macro_comment: analysis.gptOutput5m.macro_comment || "-"
      },
      gptOutput1h: {
        final_action: analysis.gptOutput1h.macro_view || "-",
        technical_signal_strength: analysis.gptOutput1h.technical_signal_strength || 0,
        macro_comment: analysis.gptOutput1h.macro_comment || "-"
      }
    };

    let summaryRow;
    if (!positionOpen && (gptSignal === 'BUY' || gptSignal === 'SELL')) {
      const openTime = decisionTime;
      const tradeOpenPrice = find1mOpenPriceAtTime(min1Data, openTime);
      if (tradeOpenPrice === null) {
        summaryRow = {
          iteration: i,
          openTime: tsToISO(decisionTime),
          closeTime: tsToISO(decisionTime + decisionIntervalMs - 1),
          openPrice: decisionCandle[1],
          closePrice: decisionCandle[4],
          tradePnLPercent: 0,
          runningPnLPercent: runningPnL,
          position: "HOLD",
          holdPosition: "No Trade",
          closedAt: tsToISO(decisionTime),
          ...gptData
        };
        ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
        lastCloseTimeSent = summaryRow.closeTime;
        continue;
      } else {
        positionOpen = true;
        positionDirection = gptSignal;
        originalEntryPrice = tradeOpenPrice;
        tradeEntryTime = openTime;
        summaryRow = {
          iteration: i,
          openTime: tsToISO(openTime),
          closeTime: tsToISO(openTime + decisionIntervalMs - 1),
          openPrice: tradeOpenPrice,
          closePrice: decisionCandle[4],
          tradePnLPercent: 0,
          runningPnLPercent: runningPnL,
          position: positionDirection,
          holdPosition: "Opened",
          closedAt: "",
          ...gptData
        };
        ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
        lastCloseTimeSent = summaryRow.closeTime;
        continue;
      }
    }
    else if (positionOpen) {
      const intervalStart = decisionTime;
      const intervalEnd = decisionTime + decisionIntervalMs;
      const oneMinCandles = min1Data
        .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
        .sort((a, b) => a[0] - b[0]);

      let closePriceForInterval;
      if (i === startIdx) {
        closePriceForInterval = decisionCandle[4];
      } else {
        closePriceForInterval = find1mClosePriceAtTime(min1Data, intervalEnd - 1) ||
          (oneMinCandles.length ? oneMinCandles[oneMinCandles.length - 1][4] : decisionCandle[4]);
      }

      const cumulativePnL = oneMinCandles.length ? computePnL(positionDirection, originalEntryPrice, closePriceForInterval) : 0;

      if ((positionDirection === 'BUY' && (cumulativePnL <= -lossTargetPercent || cumulativePnL >= profitTargetPercent)) ||
          (positionDirection === 'SELL' && (cumulativePnL <= -lossTargetPercent || cumulativePnL >= profitTargetPercent))) {
        const effectivePnL = (cumulativePnL <= -lossTargetPercent) ? -lossTargetPercent : profitTargetPercent;
        runningPnL += effectivePnL;
        summaryRow = {
          iteration: i,
          openTime: tsToISO(intervalStart),
          closeTime: tsToISO(intervalEnd - 1),
          openPrice: find1mOpenPriceAtTime(min1Data, intervalStart),
          closePrice: closePriceForInterval,
          tradePnLPercent: cumulativePnL,
          runningPnLPercent: runningPnL,
          position: positionDirection,
          holdPosition: "Closed",
          closedAt: tsToISO(oneMinCandles.length ? oneMinCandles[oneMinCandles.length - 1][0] : (intervalEnd - 1)),
          ...gptData
        };
        positionOpen = false;
        positionDirection = null;
        originalEntryPrice = null;
        tradeEntryTime = null;
        lastCloseTimeSent = summaryRow.closeTime;
      } else {
        summaryRow = {
          iteration: i,
          openTime: tsToISO(intervalStart),
          closeTime: tsToISO(intervalEnd - 1),
          openPrice: find1mOpenPriceAtTime(min1Data, intervalStart),
          closePrice: closePriceForInterval,
          tradePnLPercent: cumulativePnL,
          runningPnLPercent: runningPnL,
          position: positionDirection,
          holdPosition: "Held",
          closedAt: "",
          ...gptData
        };
        lastCloseTimeSent = summaryRow.closeTime;
      }
    }
    else {
      summaryRow = {
        iteration: i,
        openTime: tsToISO(decisionTime),
        closeTime: tsToISO(decisionTime + decisionIntervalMs - 1),
        openPrice: decisionCandle[1],
        closePrice: decisionCandle[4],
        tradePnLPercent: 0,
        runningPnLPercent: runningPnL,
        position: "HOLD",
        holdPosition: "No Trade",
        closedAt: tsToISO(decisionTime),
        ...gptData
      };
    }
    ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
  }

  if (positionOpen) {
    const lastDecisionCandle = decisionData[decisionData.length - 1];
    const forcedCloseTime = lastDecisionCandle[0] + decisionIntervalMs;
    const forcedClosePrice = find1mClosePriceAtTime(min1Data, forcedCloseTime - 1) || lastDecisionCandle[4];
    const forcedCumulativePnL = computePnL(positionDirection, originalEntryPrice, forcedClosePrice);
    runningPnL += (forcedCumulativePnL <= -lossTargetPercent)
      ? -lossTargetPercent
      : (forcedCumulativePnL >= profitTargetPercent)
        ? profitTargetPercent
        : forcedCumulativePnL;
    const forcedCloseTimeStr = tsToISO(forcedCloseTime);
    if (lastCloseTimeSent === forcedCloseTimeStr) {
      console.log(`[BacktestEngine] Forced closure update with closeTime ${forcedCloseTimeStr} already sent, skipping.`);
    } else {
      lastCloseTimeSent = forcedCloseTimeStr;
      const finalRow = {
        iteration: decisionData.length,
        openTime: tsToISO(lastDecisionCandle[0]),
        closeTime: tsToISO(forcedCloseTime - 1),
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
      ws.send(JSON.stringify({ type: 'update', data: finalRow }));
    }
  }

  ws.send(JSON.stringify({ type: 'final', runningPnL }));
}

module.exports = { runBacktest };