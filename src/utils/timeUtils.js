const tsToISO = (ts) => new Date(ts).toISOString();

const timeframeToMs = (timeframe) => {
  switch (timeframe) {
    case '1m': return 60 * 1000;
    case '5m': return 5 * 60 * 1000;
    case '15m': return 15 * 60 * 1000;
    case '30m': return 30 * 60 * 1000;
    case '1h': return 60 * 60 * 1000;
    case '4h': return 4 * 60 * 60 * 1000;
    case '1d': return 24 * 60 * 60 * 1000;
    case '1w': return 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
};

const formatTS = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

module.exports = { tsToISO, timeframeToMs, formatTS };