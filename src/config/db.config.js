/**
 * Database Configuration - konfiguracja połączenia z bazą danych MongoDB
 *
 * Odpowiedzialny za:
 * - Przechowywanie parametrów połączenia z MongoDB
 * - Dostarczanie URI połączenia
 * - Konfigurację opcji połączenia
 */

// Importuj zmienne środowiskowe
require("dotenv").config();

const config = {
  // URI połączenia z bazą danych
  uri: process.env.MONGO_URI,

  // Nazwa bazy danych
  database: "cryptobot",

  // Opcje połączenia - zaktualizowane dla nowszych wersji MongoDB
  options: {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    connectTimeoutMS: 30000,
    // Opcje autoryzacji są już zawarte w URI z MongoDB Atlas
  },

  // Konfiguracja połączeń w trybie produkcyjnym
  production: {
    // Dodatkowe ustawienia dla produkcji
    maxPoolSize: 10,
    ssl: true,
    tls: true,
    retryWrites: true,
    w: "majority",
  },

  // Konfiguracja połączenia w trybie rozwojowym
  development: {
    // Dodatkowe ustawienia dla developmentu
    maxPoolSize: 5,
    retryWrites: true,
  },

  // Konfiguracja połączenia w trybie testowym
  test: {
    // Dodatkowe ustawienia dla testów
    maxPoolSize: 5,
    autoReconnect: true,
  },
};

/**
 * Zwraca opcje połączenia na podstawie środowiska
 * @returns {Object} - Opcje połączenia
 */
const getConnectionOptions = () => {
  const env = process.env.NODE_ENV || "development";

  // Połącz podstawowe opcje z opcjami dla konkretnego środowiska
  return {
    ...config.options,
    ...(config[env] || {}),
  };
};

/**
 * Zwraca URI połączenia z bazą danych
 * @returns {string} - URI połączenia
 */
const getConnectionUri = () => {
  return config.uri;
};

/**
 * Sprawdza stan połączenia z bazą danych
 * @param {Object} mongoose - Instancja mongoose
 * @returns {Promise<boolean>} - Status połączenia
 */
const checkConnection = async (mongoose) => {
  try {
    // Sprawdzenie stanu połączenia
    const state = mongoose.connection.readyState;
    const logger = require("../utils/logger");

    switch (state) {
      case 0:
        logger.info("MongoDB: Rozłączono");
        break;
      case 1:
        logger.info("MongoDB: Połączono");
        break;
      case 2:
        logger.info("MongoDB: Łączenie w toku");
        break;
      case 3:
        logger.info("MongoDB: Rozłączanie w toku");
        break;
      default:
        logger.info(`MongoDB: Nieznany stan (${state})`);
    }

    return state === 1;
  } catch (error) {
    const logger = require("../utils/logger");
    logger.error(
      "MongoDB: Błąd podczas sprawdzania połączenia:",
      error.message
    );
    return false;
  }
};

module.exports = {
  config,
  getConnectionOptions,
  getConnectionUri,
  checkConnection,
};
