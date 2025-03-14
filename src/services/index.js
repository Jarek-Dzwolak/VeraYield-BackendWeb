/**
 * Services Index - indeks serwisów
 *
 * Eksportuje wszystkie serwisy do łatwego importu w innych częściach aplikacji
 */

const binanceService = require("./binance.service");
const analysisService = require("./analysis.service");
const signalService = require("./signal.service");
const instanceService = require("./instance.service");
const dbService = require("./db.service");

module.exports = {
  binanceService,
  analysisService,
  signalService,
  instanceService,
  dbService,
};
