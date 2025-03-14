/**
 * Middleware Index - indeks middleware'ów
 *
 * Eksportuje wszystkie middleware'y do łatwego importu w innych częściach aplikacji
 */

const authMiddleware = require("./auth.middleware");
const validatorMiddleware = require("./validator.middleware");

module.exports = {
  auth: authMiddleware,
  validator: validatorMiddleware,
};
