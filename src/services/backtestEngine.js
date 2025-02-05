const { find1mClosePriceAtTime } = require('./dataLoader');
const { tsToISO, timeframeToMs } = require('../utils/timeUtils');
const { analyzeSymbolChain } = require('./gptServiceOffline');

function computePnL(direction, openPrice, closePrice) {
  if (direction === 'BUY') {
    return ((closePrice - openPrice) / openPrice) * 100;
  } else if (direction === 'SELL') {
    return ((openPrice - closePrice) / openPrice) * 100;
  }
  return 0;
}

function aggregateCandlePairs(candle1, candle2) {
  const ts = candle1[0];
  const open = candle1[1];
  const high = Math.max(candle1[2], candle2[2]);
  const low = Math.min(candle1[3], candle2[3]);
  const close = candle2[4];
  const volume = candle1[5] + candle2[5];
  return [ts, open, high, low, close, volume];
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
  // Nastavenie percent pre take profit a stop loss
  const profitTargetPercent = 0.04;    // 4% take profit
  const lossTargetPercent = 0.08;      // 8% stop loss
  const decisionIntervalMs = timeframeToMs(decisionTF);
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
      aggregated30m.push(aggregateCandlePairs(source[i], source[i + 1]));
    }
    decisionData = aggregated30m;
  } else if (decisionTF === '1h' || decisionTF === '60m') {
    decisionData = hourData;
  } else {
    throw new Error(`Unsupported decisionTF value: ${decisionTF}`);
  }

  let currentIdx = decisionData.findIndex(c => c[0] >= fromTime);
  if (currentIdx === -1) {
    throw new Error(`No ${decisionTF} data found at or after ${tsToISO(fromTime)}`);
  }

  // Spustíme GPT analýzy pre každý rozhodovací interval
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

  // Pre každý 15‑minútový interval simulujeme obchod jednotlivo
  for (let i = currentIdx; i < decisionData.length; i++) {
    const decisionCandle = decisionData[i];
    const decisionTime = decisionCandle[0];
    if (toTime && decisionTime > toTime) break;

    const analysis = gptResults[i - currentIdx];
    if (!analysis || !analysis.gptOutput || typeof analysis.gptOutput.final_action === 'undefined') {
      throw new Error(`Missing final_action in analysis for decision time ${tsToISO(decisionTime)}`);
    }
    const finalAction = analysis.gptOutput.final_action; // "BUY", "SELL" alebo "HOLD"
    const signalStrength = Number(analysis.gptOutput.technical_signal_strength);

    let tradeOpenPrice = decisionCandle[1];   // Otváracia cena obchodu – z 15m sviečky
    let tradeClosePrice = decisionCandle[4];    // Predvolená zatváracia cena, ak nedôjde k skoršiemu exitu
    let tradePnL = 0;

    // Ak je signál na obchod a technická sila dosahuje prah, simulujeme obchod
    if ((finalAction === 'BUY' || finalAction === 'SELL') &&
        (signalStrength >= 70 || (signalStrength >= 7 && signalStrength <= 9))) {
      
      let tpPrice, slPrice;
      if (finalAction === 'BUY') {
        tpPrice = tradeOpenPrice * (1 + profitTargetPercent);
        slPrice = tradeOpenPrice * (1 - lossTargetPercent);
      } else { // SELL
        tpPrice = tradeOpenPrice * (1 - profitTargetPercent);
        slPrice = tradeOpenPrice * (1 + lossTargetPercent);
      }
      
      // Získame 1‑minútové dáta pre daný 15‑minútový interval
      const intervalStart = decisionCandle[0];
      const intervalEnd = intervalStart + decisionIntervalMs;
      const oneMinCandles = min1Data
        .filter(c => c[0] >= intervalStart && c[0] < intervalEnd)
        .sort((a, b) => a[0] - b[0]);

      let exitPrice = null;
      for (let candle of oneMinCandles) {
        if (finalAction === 'BUY') {
          if (candle[2] >= tpPrice) {
            exitPrice = tpPrice;
            break;
          } else if (candle[3] <= slPrice) {
            exitPrice = slPrice;
            break;
          }
        } else { // SELL
          if (candle[3] <= tpPrice) {
            exitPrice = tpPrice;
            break;
          } else if (candle[2] >= slPrice) {
            exitPrice = slPrice;
            break;
          }
        }
      }
      if (exitPrice !== null) {
        tradeClosePrice = exitPrice;
      }
      tradePnL = computePnL(finalAction, tradeOpenPrice, tradeClosePrice);
    }
    // Ak signál nie je obchodný ("HOLD"), zostáva obchod nevykonaný – tradePnL = 0

    runningPnL += tradePnL;
    const summaryRow = {
      iteration: i,
      timestamp: tsToISO(decisionCandle[0]),
      openPrice: tradeOpenPrice,
      closePrice: tradeClosePrice,
      tradePnLPercent: tradePnL,
      runningPnLPercent: runningPnL,
      position: (finalAction === 'BUY' || finalAction === 'SELL') ? finalAction : "HOLD",
      holdPosition: (finalAction === 'BUY' || finalAction === 'SELL') ? "Closed" : "No Trade",
      closedAt: tsToISO(decisionCandle[0]), // obchod uzavretý na konci intervalu
      gptComment: analysis?.gptOutput?.comment || "No comment",
      technical_signal_strength: signalStrength
    };
    ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
  }
  
  ws.send(JSON.stringify({ type: 'final', runningPnL }));
}

module.exports = { runBacktest };