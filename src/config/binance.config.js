/**
 * Binance Configuration - konfiguracja API Binance
 *
 * Odpowiedzialny za:
 * - Przechowywanie adresów URL API i WebSocket
 * - Konfigurację limitów zapytań
 * - Konfigurację opcji połączenia
 */

// Importuj zmienne środowiskowe (jeśli używamy dotenv)
// require('dotenv').config();

const config = {
  // Adresy bazowe REST API
  apiBaseUrl: "https://api.binance.com",
  apiBaseUrlTestnet: "https://testnet.binance.vision",

  // Adresy bazowe WebSocket
  wsBaseUrl: "wss://stream.binance.com:9443/ws",
  wsBaseUrlTestnet: "wss://testnet.binance.vision/ws",

  // Domyślne limity zapytań
  // Binance ma limit 1200 zapytań wagowych na minutę
  // Szczegóły: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#limits
  requestLimits: {
    weight: {
      minute: 1200,
    },
    orders: {
      second: 10,
      day: 100000,
    },
  },

  // Interwały ping/pong dla WebSocket (ms)
  webSocketOptions: {
    pingInterval: 30 * 60 * 1000, // 30 minut
    pongTimeout: 10000, // 10 sekund
    reconnectTimeout: 5000, // 5 sekund
    maxReconnectAttempts: 5,
  },

  // Domyślne timeframes używane przez system
  timeframes: {
    hurstCalculation: "15m",
    emaCalculation: "1h",
  },

  // Domyślne dane historyczne
  historicalData: {
    "15m": {
      limit: 25, // Liczba świec 15m potrzebnych do kanału Hursta
    },
    "1h": {
      limit: 100, // Liczba świec 1h potrzebnych do EMA
    },
  },

  // Wspierane interwały czasowe
  supportedIntervals: [
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
  ],

  // Czy używać testnet
  useTestnet: process.env.USE_BINANCE_TESTNET === "true",
};

/**
 * Zwraca bazowy URL API na podstawie konfiguracji
 * @returns {string} - URL bazowy API
 */
const getApiBaseUrl = () => {
  return config.useTestnet ? config.apiBaseUrlTestnet : config.apiBaseUrl;
};

/**
 * Zwraca bazowy URL WebSocket na podstawie konfiguracji
 * @returns {string} - URL bazowy WebSocket
 */
const getWsBaseUrl = () => {
  return config.useTestnet ? config.wsBaseUrlTestnet : config.wsBaseUrl;
};

module.exports = {
  config,
  getApiBaseUrl,
  getWsBaseUrl,
};
