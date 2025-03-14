/**
 * Config Index - indeks konfiguracji
 *
 * Eksportuje wszystkie konfiguracje do łatwego importu w innych częściach aplikacji
 */

const dbConfig = require("./db.config");
const binanceConfig = require("./binance.config");
const instanceConfig = require("./instance.config");

module.exports = {
  db: dbConfig,
  binance: binanceConfig,
  instance: instanceConfig,
};
