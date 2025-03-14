/**
 * Konfiguracja połączenia z bazą danych MongoDB
 */

const mongoose = require("mongoose");
const logger = require("../utils/logger");

/**
 * Nawiązuje połączenie z bazą danych MongoDB
 * @returns {Promise} Obietnica połączenia z bazą danych
 */
const connectDB = async () => {
  try {
    const mongoURI =
      process.env.MONGO_URI || "mongodb://localhost:27017/binance-bot";

    logger.info(`Łączenie z bazą danych: ${mongoURI.split("@").pop()}`); // Log URI bez danych uwierzytelniających

    const connection = await mongoose.connect(mongoURI);

    logger.info(
      `Połączono z bazą danych MongoDB: ${connection.connection.host}`
    );
    return connection;
  } catch (error) {
    logger.error(`Błąd połączenia z MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Zamyka połączenie z bazą danych MongoDB
 * @returns {Promise} Obietnica zamknięcia połączenia
 */
const closeDB = async () => {
  try {
    await mongoose.connection.close();
    logger.info("Połączenie MongoDB zamknięte");
    return true;
  } catch (error) {
    logger.error(
      `Błąd podczas zamykania połączenia z MongoDB: ${error.message}`
    );
    throw error;
  }
};

/**
 * Sprawdza stan połączenia z bazą danych
 * @returns {Object} Informacje o stanie połączenia
 */
const getDBStatus = () => {
  return {
    connected: mongoose.connection.readyState === 1,
    state: mongoose.connection.readyState,
    host: mongoose.connection.host,
    name: mongoose.connection.name,
  };
};

module.exports = {
  connectDB,
  closeDB,
  getDBStatus,
};
