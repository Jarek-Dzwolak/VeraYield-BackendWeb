/**
 * Binance Service - obsługa komunikacji z API i WebSocketami Binance
 *
 * Odpowiedzialny za:
 * - Inicjalizację z danymi historycznymi przez REST API
 * - Streaming danych w czasie rzeczywistym przez WebSockety
 * - Utrzymywanie połączenia WebSocket (pinging)
 */

const WebSocket = require("ws");
const axios = require("axios");
const logger = require("../utils/logger");
const { EventEmitter } = require("events");

// Stałe konfiguracyjne
const BINANCE_API_BASE_URL = "https://api.binance.com";
const BINANCE_WS_BASE_URL = "wss://stream.binance.com:9443/ws";
const PING_INTERVAL = 30 * 60 * 1000; // 30 minut

class BinanceService extends EventEmitter {
  constructor() {
    super();
    this.wsConnections = new Map(); // Mapa połączeń WebSocket (symbol -> wsConnection)
    this.candleData = new Map(); // Mapa danych świecowych (symbol+interval -> array of candles)
    this.pingIntervals = new Map(); // Mapa interwałów pingowania
  }

  /**
   * Pobiera historyczne dane świecowe przez REST API
   * @param {string} symbol - Para handlowa (np. 'BTCUSDT')
   * @param {string} interval - Interwał czasowy (np. '15m', '1h')
   * @param {number} limit - Liczba świec do pobrania
   * @returns {Promise<Array>} - Tablica danych świecowych
   */
  async getHistoricalCandles(symbol, interval, limit = 100) {
    try {
      const url = `${BINANCE_API_BASE_URL}/api/v3/klines`;
      const response = await axios.get(url, {
        params: {
          symbol: symbol.toUpperCase(),
          interval,
          limit,
        },
      });

      const candles = response.data.map((candle) => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6],
        quoteAssetVolume: parseFloat(candle[7]),
        numberOfTrades: parseInt(candle[8]),
        takerBuyBaseAssetVolume: parseFloat(candle[9]),
        takerBuyQuoteAssetVolume: parseFloat(candle[10]),
      }));

      // Zapisz dane w pamięci
      const key = `${symbol}-${interval}`;
      this.candleData.set(key, candles);

      logger.info(
        `Pobrano ${candles.length} historycznych świec dla ${symbol} (${interval})`
      );
      return candles;
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania historycznych danych: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Nawiązuje połączenie WebSocket dla kanału świecowego
   * @param {string} symbol - Para handlowa (np. 'BTCUSDT')
   * @param {string} interval - Interwał czasowy (np. '15m', '1h')
   * @param {string} instanceId - Identyfikator instancji strategii
   */
  subscribeToKlines(symbol, interval, instanceId) {
    const lowerSymbol = symbol.toLowerCase();
    const wsKey = `${lowerSymbol}-${interval}-${instanceId}`;

    // Sprawdź, czy połączenie już istnieje
    if (this.wsConnections.has(wsKey)) {
      logger.info(`Połączenie WebSocket dla ${wsKey} już istnieje`);
      return;
    }

    const wsUrl = `${BINANCE_WS_BASE_URL}/${lowerSymbol}@kline_${interval}`;
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      logger.info(`Połączenie WebSocket nawiązane dla ${wsKey}`);

      // Uruchom regularne wysyłanie pingów dla utrzymania połączenia
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          logger.debug(`Wysłano ping dla ${wsKey}`);
        }
      }, PING_INTERVAL);

      this.pingIntervals.set(wsKey, pingInterval);
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);

        // Sprawdź, czy to dane świecowe
        if (message.e === "kline") {
          const candle = {
            openTime: message.k.t,
            open: parseFloat(message.k.o),
            high: parseFloat(message.k.h),
            low: parseFloat(message.k.l),
            close: parseFloat(message.k.c),
            volume: parseFloat(message.k.v),
            closeTime: message.k.T,
            isFinal: message.k.x, // Czy świeca jest zamknięta
            symbol: message.s,
            interval: message.k.i,
          };

          // Zaktualizuj dane w pamięci
          const dataKey = `${symbol}-${interval}`;
          const existingCandles = this.candleData.get(dataKey) || [];

          // Jeśli to nowa świeca, dodajemy ją do listy
          if (candle.isFinal) {
            // Znajdź i zastąp istniejącą świecę o tym samym czasie otwarcia, jeśli istnieje
            const existingIndex = existingCandles.findIndex(
              (c) => c.openTime === candle.openTime
            );

            if (existingIndex !== -1) {
              existingCandles[existingIndex] = candle;
            } else {
              // Dodaj nową świecę i ogranicz rozmiar tablicy
              existingCandles.push(candle);

              // Utrzymuj określoną liczbę świec (100 dla 1h, 25 dla 15m)
              const maxCandles = interval === "1h" ? 100 : 25;
              if (existingCandles.length > maxCandles) {
                existingCandles.shift(); // Usuń najstarszą świecę
              }
            }

            this.candleData.set(dataKey, existingCandles);
          }

          // Emituj zdarzenie z danymi
          this.emit("kline", {
            candle,
            instanceId,
          });

          // Emituj specjalne zdarzenie, jeśli świeca została zamknięta
          if (candle.isFinal) {
            this.emit("klineClosed", {
              candle,
              instanceId,
              allCandles: this.candleData.get(dataKey),
            });
          }
        }
      } catch (error) {
        logger.error(
          `Błąd podczas przetwarzania wiadomości WebSocket: ${error.message}`
        );
      }
    });

    ws.on("error", (error) => {
      logger.error(`Błąd WebSocket dla ${wsKey}: ${error.message}`);
    });

    ws.on("close", (code, reason) => {
      logger.warn(
        `Połączenie WebSocket zamknięte dla ${wsKey}: kod=${code}, powód=${reason}`
      );

      // Wyczyść interwał pingowania
      const pingInterval = this.pingIntervals.get(wsKey);
      if (pingInterval) {
        clearInterval(pingInterval);
        this.pingIntervals.delete(wsKey);
      }

      // Usuń połączenie z mapy
      this.wsConnections.delete(wsKey);

      // Spróbuj ponownie połączyć po 5 sekundach
      setTimeout(() => {
        logger.info(`Próba ponownego połączenia dla ${wsKey}`);
        this.subscribeToKlines(symbol, interval, instanceId);
      }, 5000);
    });

    // Dodaj połączenie do mapy
    this.wsConnections.set(wsKey, ws);
  }

  /**
   * Zamyka połączenie WebSocket
   * @param {string} symbol - Para handlowa
   * @param {string} interval - Interwał czasowy
   * @param {string} instanceId - Identyfikator instancji strategii
   */
  unsubscribeFromKlines(symbol, interval, instanceId) {
    const wsKey = `${symbol.toLowerCase()}-${interval}-${instanceId}`;

    // Sprawdź, czy połączenie istnieje
    if (!this.wsConnections.has(wsKey)) {
      logger.warn(`Brak aktywnego połączenia WebSocket dla ${wsKey}`);
      return;
    }

    // Pobierz połączenie WebSocket
    const ws = this.wsConnections.get(wsKey);

    // Wyczyść interwał pingowania
    const pingInterval = this.pingIntervals.get(wsKey);
    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(wsKey);
    }

    // Zamknij połączenie
    ws.close();

    // Usuń połączenie z mapy
    this.wsConnections.delete(wsKey);

    logger.info(`Zamknięto połączenie WebSocket dla ${wsKey}`);
  }

  /**
   * Inicjalizuje dane dla instancji strategii
   * @param {string} symbol - Para handlowa
   * @param {Array<string>} intervals - Tablica interwałów czasowych
   * @param {string} instanceId - Identyfikator instancji strategii
   */
  async initializeInstanceData(symbol, intervals, instanceId) {
    try {
      // Pobierz dane historyczne dla każdego interwału
      const dataPromises = intervals.map((interval) => {
        const limit = interval === "1h" ? 100 : 25;
        return this.getHistoricalCandles(symbol, interval, limit);
      });

      await Promise.all(dataPromises);

      // Subskrybuj WebSockety dla każdego interwału
      intervals.forEach((interval) => {
        this.subscribeToKlines(symbol, interval, instanceId);
      });

      logger.info(
        `Zainicjalizowano dane dla instancji ${instanceId} (${symbol})`
      );
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas inicjalizacji danych dla instancji ${instanceId}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Pobiera aktualne dane świecowe z pamięci
   * @param {string} symbol - Para handlowa
   * @param {string} interval - Interwał czasowy
   * @returns {Array|null} - Tablica danych świecowych lub null, jeśli brak danych
   */
  getCachedCandles(symbol, interval) {
    const key = `${symbol}-${interval}`;
    return this.candleData.get(key) || null;
  }

  /**
   * Pobiera aktualną cenę przez REST API
   * @param {string} symbol - Para handlowa
   * @returns {Promise<Object>} - Obiekt zawierający cenę
   */
  async getCurrentPrice(symbol) {
    try {
      const url = `${BINANCE_API_BASE_URL}/api/v3/ticker/price`;
      const response = await axios.get(url, {
        params: {
          symbol: symbol.toUpperCase(),
        },
      });

      return {
        symbol: response.data.symbol,
        price: parseFloat(response.data.price),
      };
    } catch (error) {
      logger.error(`Błąd podczas pobierania aktualnej ceny: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera informacje o wszystkich dostępnych parach handlowych
   * @returns {Promise<Array>} - Tablica dostępnych par handlowych
   */
  async getExchangeInfo() {
    try {
      const url = `${BINANCE_API_BASE_URL}/api/v3/exchangeInfo`;
      const response = await axios.get(url);

      return response.data.symbols.map((symbol) => ({
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: symbol.status,
      }));
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania informacji o giełdzie: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Zamyka wszystkie połączenia WebSocket
   */
  closeAllConnections() {
    // Zamknij wszystkie połączenia WebSocket
    for (const [key, ws] of this.wsConnections.entries()) {
      ws.close();
      logger.info(`Zamknięto połączenie WebSocket dla ${key}`);
    }

    // Wyczyść wszystkie interwały pingowania
    for (const interval of this.pingIntervals.values()) {
      clearInterval(interval);
    }

    // Wyczyść mapy
    this.wsConnections.clear();
    this.pingIntervals.clear();

    logger.info("Zamknięto wszystkie połączenia WebSocket");
  }
}

// Eksportuj singleton
const binanceService = new BinanceService();
module.exports = binanceService;
