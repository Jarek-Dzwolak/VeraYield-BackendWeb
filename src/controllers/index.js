/**
 * Controllers Index - indeks kontrolerów
 *
 * Eksportuje wszystkie kontrolery do łatwego importu w innych częściach aplikacji
 */

const authController = require("./auth.controller");
const marketController = require("./market.controller");
const signalController = require("./signal.controller");
const instanceController = require("./instance.controller");

module.exports = {
  auth: authController,
  market: marketController,
  signal: signalController,
  instance: instanceController,
};
