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

/*
  Táto verzia runBacktest najprv (ak sú fromTime a toTime zadané)
  dynamicky spočíta hodiny medzi nimi.
  
  Potom pre každú hodinu (od fromIndex) spustíme asynchrónu úlohu, 
  ktorá získava “hour-specific” GPT analýzu – tieto volania bežia paralelne.
  
  Keď sa všetky GPT analýzy skončia (cez Promise.all), výsledky 
  sa zoradia podľa poradia hodín a potom sa sekvenčne spracujú na 
  aktualizáciu obchodného stavu (otvorenie/uzavretie obchodu, runningPnL, atď.).
  Takto je každý “krok” spracovaný izolovane a nedochádza k race condition.
  
  Poznámka: Ak je obchodný stav závislý medzi hodinami (napr. otvorená pozícia
  prechádza do ďalších hodín), je nutné následné rozhodnutia vykonávať sekvenčne.
*/
async function runBacktest({
  symbol,
  // Ak nie sú zadané fromTime/toTime použije default 12 hodín,
  // ale neskôr sa hoursToBacktest prepíše, ak sú obidva zadané.
  hoursToBacktest = 12,
  fromTime,
  toTime,
  dailyData,
  weeklyData,
  hourData,
  min15Data,
  min5Data,
  min1Data,
  stopLossThreshold = 0.80, // napr. 95%
  takeProfitGain = 1.10     // napr. 110%
}, ws) {
  let runningPnL = 0;

  // Ak sú zadané fromTime a toTime, prepočítame počet hodín
  if (fromTime && toTime) {
    const diffInMs = toTime - fromTime; // predpokladáme, že fromTime/toTime sú timestampy
    hoursToBacktest = Math.floor(diffInMs / (1000 * 60 * 60));
  }

  // Nájdeme index prvej hodinovej sviečky, ktorej timestamp je >= fromTime
  const fromIndex = hourData.findIndex(c => c[0] >= fromTime);
  if (fromIndex === -1) {
    throw new Error(`No hour data found at or after ${tsToISO(fromTime)}`);
  }
  console.log(`[BacktestEngine] Starting backtest from index ${fromIndex} (${tsToISO(hourData[fromIndex][0])}) for ${hoursToBacktest} hours`);

  // Pomocné premenne reprezentujúce aktuálny obchodný stav
  let positionOpen = false;
  let positionDirection = null; // 'BUY' alebo 'SELL'
  let positionOpenPrice = 0;
  let positionOpenTime = 0;

  // 1. Spustíme paralelne „hour tasks“ – každá úloha je izolovaná a získa
  //    GPT analýzu pre danú hodinu. Neovplyvňujú však navzájom obchodný stav.
  const hourTasks = [];
  for (let i = 0; i < hoursToBacktest; i++) {
    const curIndex = fromIndex + i;
    // Každá úloha spracuje len dáta do aktuálnej hodiny (slice) a vráti
    // výsledok, ktorý obsahuje:
    // - číslo iterácie, aktuálny timestamp (hourCandle[0])
    // - celú hodinovú sviečku (hourCandle)
    // - odporúčanie GPT (finalAction) pre danú hodinu
    hourTasks.push((async () => {
      const hourCandle = hourData[curIndex];
      if (!hourCandle) return null;
      const lastHourTS = hourCandle[0];
      const analysis = await analyzeSymbolChain(
        symbol,
        dailyData.slice(),    // použijeme všetky denné dáta
        weeklyData.slice(),   // všetky týždenné dáta
        min15Data.slice(),    // 15-minutové dáta
        hourData.slice(0, curIndex + 1),
        min5Data.slice(),
        fromTime,
        toTime,
      );
      if (!analysis || !analysis.synergy || typeof analysis.synergy.final_action === 'undefined') {
        throw new Error(`Missing final_action in analysis for iteration ${i}: analysis=${JSON.stringify(analysis)}`);
      }
      const finalAction = analysis.synergy.final_action;
      return {
        i,
        lastHourTS,
        hourCandle,
        finalAction,
        analysis
      };
    })());
  }

  // Všetky úlohy bežia paralelne
  const hourResults = await Promise.all(hourTasks);
  // Zoradíme výsledky podľa iterácie, aby sme ich mohli spracovať sekvenčne
  hourResults.sort((a, b) => a.i - b.i);

  // 2. Sekvenčne prechádzame výsledky – tu aktualizujeme obchodný stav,
  //    vykonávame kontrolu 1-min dát, uzatvárame/otvárame obchody, počítame PnL, atď.
  for (const res of hourResults) {
    if (!res) continue;
    const { i, lastHourTS, hourCandle, finalAction } = res;
    console.log(`[BacktestEngine] Hour iteration ${i} at ${tsToISO(lastHourTS)} – GPT recommends: ${finalAction}`);

    // Ak zatiaľ nie je otvorená žiadna pozícia a GPT odporúča BUY/SELL, otvoríme ju
    if (!positionOpen && (finalAction === 'BUY' || finalAction === 'SELL')) {
      const openTime = lastHourTS + timeframeToMs('1h'); // obchod sa otvorí v nasledujúcej hodine
      const openPrice = find1mClosePriceAtTime(min1Data, openTime);
      if (openPrice !== null) {
        positionOpen = true;
        positionDirection = finalAction;
        positionOpenPrice = openPrice;
        positionOpenTime = openTime;
        console.log(`[BacktestEngine] Opened ${positionDirection} position at ${openPrice} on ${tsToISO(openTime)}`);
      }
    }

    // Spracovanie obchodov pre aktuálnu hodinu:
    let summaryRow = null;
    let tradeClosed = false;
    let triggerCandle = null;
    if (positionOpen) {
      // Definujeme rozsah aktuálnej hodiny a získame všetky 1-minútové candles pre túto hodinu
      const hourStart = lastHourTS;
      const hourEnd = hourStart + timeframeToMs('1h');
      const oneMinCandles = min1Data
          .filter(c => c[0] >= hourStart && c[0] < hourEnd)
          .sort((a, b) => a[0] - b[0]);
      
      // Definujeme stop loss / take profit podľa smeru
      let slPrice, tpPrice;
  if (res.analysis?.gptOutput?.stop_loss != null && res.analysis.gptOutput.target_profit != null) {
    // Použijeme priamo absolútne hodnoty z gptServiceOffline
    slPrice = res.analysis.gptOutput.stop_loss;
    tpPrice = res.analysis.gptOutput.target_profit;
    console.log(`[BacktestEngine] Using GPT-defined stop loss: ${slPrice} and target profit: ${tpPrice}`);
  } else {
    // Fallback – použijeme default multiplikátory založené na otvorenej cene
    if (positionDirection === 'BUY') {
      slPrice = positionOpenPrice * stopLossThreshold;
      tpPrice = positionOpenPrice * takeProfitGain;
    } else { // pre short pozície
      slPrice = positionOpenPrice / stopLossThreshold;
      tpPrice = positionOpenPrice / takeProfitGain;
    }
    console.log(`[BacktestEngine] Using default multipliers: stop loss=${slPrice}, target profit=${tpPrice}`);
  }
      
      // Prejdeme všetky 1-min candle tejto hodiny a skontrolujeme podmienky pre uzatvorenie
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
        } else { // SELL
          if (candleHigh >= slPrice || candleLow <= tpPrice) {
            tradeClosed = true;
            triggerCandle = candle;
            break;
          }
        }
      }
      
      // Zvolíme 1-min candle pre "summary". Ak trade bol uzavretý, vyberieme trigger;
      // inak poslednú 1-min candle v danom období.
      let summaryCandle = null;
      if (tradeClosed && triggerCandle) {
        summaryCandle = triggerCandle;
      } else if (oneMinCandles.length) {
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
          // Aktualizujeme stav – uzatvárame otvorenú pozíciu
          positionOpen = false;
          positionDirection = null;
          positionOpenPrice = 0;
          positionOpenTime = 0;
        }
      }
    }
    
    // Ak počas tejto hodiny nedošlo k žiadnemu obchodnému kroku, vytvoríme len riadok s HOLD
    if (!positionOpen && !summaryRow) {
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
    
    // Odošleme výsledný riadok cez WebSocket
    if (summaryRow) {
      ws.send(JSON.stringify({ type: 'update', data: summaryRow }));
    }
  } // koniec sekvenčného spracovania jednotlivých hodín

  // Ak pozícia zostáva otvorená, vynútime jej uzavretie
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

  // Nakoniec odošleme finálnu správu cez WebSocket s konečným runningPnL
  ws.send(JSON.stringify({ type: 'final', runningPnL }));
}

module.exports = { runBacktest };
