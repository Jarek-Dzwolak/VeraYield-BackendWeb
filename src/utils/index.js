/**
 * Utils Index - indeks narzędzi
 *
 * Eksportuje wszystkie narzędzia pomocnicze do łatwego importu w innych częściach aplikacji
 */

const technical = require("./technical");
const logger = require("./logger");
const websocket = require("./websocket");
const validators = require("./validators");

module.exports = {
  technical,
  logger,
  websocket,
  validators,
};
