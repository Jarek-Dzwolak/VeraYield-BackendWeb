/**
 * Models Index - indeks modeli
 *
 * Eksportuje wszystkie modele do łatwego importu w innych częściach aplikacji
 */

const Instance = require("./instance.model");
const Signal = require("./signal.model");
const MarketData = require("./market-data.model");
const User = require("./user.model");

module.exports = {
  Instance,
  Signal,
  MarketData,
  User,
};
