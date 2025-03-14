/**
 * Database Configuration - konfiguracja połączenia z bazą danych MongoDB
 *
 * Odpowiedzialny za:
 * - Przechowywanie parametrów połączenia z MongoDB
 * - Dostarczanie URI połączenia
 * - Konfigurację opcji połączenia
 */

// Importuj zmienne środowiskowe (jeśli używamy dotenv)
// require('dotenv').config();

const config = {
  // URI połączenia z bazą danych
  // Format: mongodb://[username:password@]host:port/database
  uri:
    process.env.MONGODB_URI || "mongodb://localhost:27017/binance-trading-bot",

  // Nazwa bazy danych
  database: process.env.MONGODB_DB || "binance-trading-bot",

  // Opcje połączenia
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    // Opcje autoryzacji (jeśli wymagane)
    ...(process.env.MONGODB_USER && process.env.MONGODB_PASSWORD
      ? {
          auth: {
            username: process.env.MONGODB_USER,
            password: process.env.MONGODB_PASSWORD,
          },
        }
      : {}),
  },

  // Konfiguracja połączeń w trybie produkcyjnym
  production: {
    // Dodatkowe ustawienia dla produkcji
    poolSize: 10,
    ssl: true,
    sslValidate: true,
    retryWrites: true,
    w: "majority",
  },

  // Konfiguracja połączenia w trybie rozwojowym
  development: {
    // Dodatkowe ustawienia dla developmentu
    poolSize: 5,
    retryWrites: true,
  },

  // Konfiguracja połączenia w trybie testowym
  test: {
    // Dodatkowe ustawienia dla testów
    poolSize: 5,
    autoReconnect: false,
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

module.exports = {
  config,
  getConnectionOptions,
  getConnectionUri,
};
