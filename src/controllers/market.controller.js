/**
 * Market Controller - kontroler danych rynkowych
 *
 * Odpowiedzialny za:
 * - Pobieranie danych rynkowych z Binance
 * - Dostarczanie danych świecowych i cen
 * - Obsługę streamingu danych w czasie rzeczywistym
 */

const binanceService = require("../services/binance.service");
const analysisService = require("../services/analysis.service");
const logger = require("../utils/logger");
const MarketData = require("../models/market-data.model");
const { isValidSymbol, isValidInterval } = require("../utils/validators");

/**
 * Pobieranie informacji o WebSocket
 * @route GET /api/v1/market/ws-info
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Object} - Informacje o WebSocket
 */
const getWebSocketInfo = (req, res, next) => {
  try {
    // Pobierz host i protokół z nagłówków
    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol === "https" ? "wss" : "ws";

    // Zwróć informacje o WebSocket
    res.status(200).json({
      webSocketUrl: `${protocol}://${host}`,
      endpoints: {
        trading: "/trading",
        marketData: "/market-data",
      },
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
      messageFormat: {
        subscribe: {
          type: "subscribe",
          symbol: "BTCUSDT",
          interval: "15m",
        },
        unsubscribe: {
          type: "unsubscribe",
          symbol: "BTCUSDT",
          interval: "15m",
        },
        getStatus: {
          type: "getStatus",
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Pobiera aktualną cenę dla pary handlowej
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getCurrentPrice = async (req, res) => {
  try {
    const { symbol } = req.params;

    // Waliduj symbol
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    // Pobierz aktualną cenę
    const priceData = await binanceService.getCurrentPrice(symbol);

    res.json(priceData);
  } catch (error) {
    logger.error(`Błąd podczas pobierania aktualnej ceny: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching current price",
    });
  }
};

/**
 * Pobiera historyczne dane świecowe
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getHistoricalCandles = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = "1h", limit = 100 } = req.query;

    // Waliduj parametry
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    if (!isValidInterval(interval)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid interval format",
      });
    }

    // Pobierz dane historyczne
    const candles = await binanceService.getHistoricalCandles(
      symbol,
      interval,
      parseInt(limit)
    );

    res.json({
      symbol,
      interval,
      count: candles.length,
      candles,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania historycznych świec: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching historical candles",
    });
  }
};

/**
 * Pobiera dane świecowe dla określonego interwału
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getHistoricalCandlesByInterval = async (req, res) => {
  try {
    const { symbol, interval } = req.params;
    const { limit = 100, startTime, endTime } = req.query;

    // Waliduj parametry
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    if (!isValidInterval(interval)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid interval format",
      });
    }

    // Pobierz dane historyczne
    const candles = await binanceService.getHistoricalCandles(
      symbol,
      interval,
      parseInt(limit),
      startTime ? parseInt(startTime) : undefined,
      endTime ? parseInt(endTime) : undefined
    );

    res.json({
      symbol,
      interval,
      count: candles.length,
      candles,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania historycznych świec: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching historical candles",
    });
  }
};

/**
 * Pobiera listę dostępnych par handlowych
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAvailableSymbols = async (req, res) => {
  try {
    // Pobierz listę dostępnych par
    const symbols = await binanceService.getExchangeInfo();

    // Filtruj aktywne pary
    const activeSymbols = symbols.filter((s) => s.status === "TRADING");

    res.json({
      count: activeSymbols.length,
      symbols: activeSymbols,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania dostępnych par: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching available symbols",
    });
  }
};

/**
 * Streaming aktualnych danych rynkowych (SSE)
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const streamMarketData = (req, res) => {
  try {
    const { symbol } = req.params;

    // Waliduj symbol
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    // Konfiguruj nagłówki SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Utwórz unikatowy identyfikator dla tego połączenia
    const connectionId = Date.now().toString();

    // Funkcja do wysyłania danych
    const sendData = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Wysyłaj ping co 30 sekund, aby utrzymać połączenie
    const pingInterval = setInterval(() => {
      sendData({ type: "ping", timestamp: Date.now() });
    }, 30000);

    // Subskrybuj WebSocket i przesyłaj dane
    const handleKlineData = (data) => {
      if (data.symbol === symbol) {
        sendData({
          type: "kline",
          symbol: data.symbol,
          interval: data.interval,
          candle: data.candle,
          timestamp: Date.now(),
        });
      }
    };

    // Nasłuchuj zdarzenia kline
    binanceService.on("kline", handleKlineData);

    // Obsługa zamknięcia połączenia
    req.on("close", () => {
      clearInterval(pingInterval);
      binanceService.removeListener("kline", handleKlineData);
      logger.debug(`Zamknięto połączenie SSE dla ${symbol}`);
    });

    // Wyślij potwierdzenie nawiązania połączenia
    sendData({
      type: "connected",
      symbol,
      timestamp: Date.now(),
    });

    logger.debug(`Nawiązano połączenie SSE dla ${symbol}`);
  } catch (error) {
    logger.error(`Błąd podczas streamingu danych: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while streaming market data",
    });
  }
};

/**
 * Pobiera aktualne wskaźniki techniczne dla pary
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getIndicators = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { instanceId } = req.query;

    // Waliduj symbol
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    // Sprawdź, czy instancja istnieje
    if (instanceId) {
      const instanceState =
        analysisService.getInstanceAnalysisState(instanceId);

      if (!instanceState) {
        return res.status(404).json({
          error: "Not Found",
          message: "Instance not found or not active",
        });
      }

      // Zwróć wskaźniki dla konkretnej instancji
      res.json(instanceState);
    } else {
      // Pobierz dane świecowe
      const candles15m = binanceService.getCachedCandles(symbol, "15m");
      const candles1h = binanceService.getCachedCandles(symbol, "1h");

      // Jeśli nie ma danych, pobierz je
      if (!candles15m || !candles1h) {
        return res.status(404).json({
          error: "Not Found",
          message: "No market data available for this symbol",
        });
      }

      // Utwórz tymczasowe instancje wskaźników
      const hurstChannel = new (require("../utils/technical").HurstChannel)();
      const ema =
        new (require("../utils/technical").ExponentialMovingAverage)();

      // Oblicz wskaźniki
      const hurstResult = hurstChannel.calculate(candles15m);
      const emaValue = ema.calculate(candles1h);

      // Zwróć wyniki
      res.json({
        symbol,
        hurstChannel: hurstResult,
        ema: emaValue,
        lastUpdate: new Date(),
      });
    }
  } catch (error) {
    logger.error(`Błąd podczas pobierania wskaźników: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching indicators",
    });
  }
};

/**
 * Pobiera analizę rynku dla pary
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getMarketAnalysis = async (req, res) => {
  try {
    const { symbol } = req.params;

    // Waliduj symbol
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    // Pobierz dane świecowe
    const candles15m = binanceService.getCachedCandles(symbol, "15m");
    const candles1h = binanceService.getCachedCandles(symbol, "1h");

    // Jeśli nie ma danych, pobierz je
    if (!candles15m || !candles1h) {
      return res.status(404).json({
        error: "Not Found",
        message: "No market data available for this symbol",
      });
    }

    // Pobierz aktualną cenę
    const priceData = await binanceService.getCurrentPrice(symbol);

    // Utwórz tymczasowe instancje wskaźników
    const hurstChannel = new (require("../utils/technical").HurstChannel)();
    const ema = new (require("../utils/technical").ExponentialMovingAverage)();

    // Oblicz wskaźniki
    const hurstResult = hurstChannel.calculate(candles15m);
    const emaValue = ema.calculate(candles1h);

    // Określ trend
    let trend = "neutral";
    if (hurstResult) {
      if (hurstResult.trend === "up" && priceData.price > emaValue) {
        trend = "bullish";
      } else if (hurstResult.trend === "down" && priceData.price < emaValue) {
        trend = "bearish";
      }
    }

    // Generuj sygnały
    let signals = [];
    if (hurstResult && emaValue) {
      // Sprawdź pozycję ceny względem kanału Hursta
      if (priceData.price <= hurstResult.lowerBand) {
        signals.push({
          type: "buy",
          strength: "strong",
          reason: "Price at or below Hurst channel lower band",
        });
      } else if (priceData.price >= hurstResult.upperBand) {
        signals.push({
          type: "sell",
          strength: "strong",
          reason: "Price at or above Hurst channel upper band",
        });
      }

      // Sprawdź pozycję ceny względem EMA
      if (priceData.price > emaValue) {
        signals.push({
          type: "buy",
          strength: "moderate",
          reason: "Price above EMA",
        });
      } else if (priceData.price < emaValue) {
        signals.push({
          type: "sell",
          strength: "moderate",
          reason: "Price below EMA",
        });
      }
    }

    // Zwróć analizę
    res.json({
      symbol,
      price: priceData.price,
      trend,
      signals,
      indicators: {
        hurstChannel: hurstResult,
        ema: emaValue,
      },
      lastUpdate: new Date(),
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania analizy rynku: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching market analysis",
    });
  }
};

/**
 * Pobiera dane o wolumenie dla pary
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getVolumeData = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = "1h", limit = 24 } = req.query;

    // Waliduj parametry
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    if (!isValidInterval(interval)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid interval format",
      });
    }

    // Pobierz dane historyczne
    const candles = await binanceService.getHistoricalCandles(
      symbol,
      interval,
      parseInt(limit)
    );

    // Przygotuj dane o wolumenie
    const volumeData = candles.map((candle) => ({
      time: candle.openTime,
      volume: candle.volume,
      quoteVolume: candle.quoteAssetVolume,
      numberOfTrades: candle.numberOfTrades,
    }));

    // Oblicz średni wolumen i inne statystyki
    const totalVolume = volumeData.reduce((sum, data) => sum + data.volume, 0);
    const avgVolume = totalVolume / volumeData.length;
    const maxVolume = Math.max(...volumeData.map((data) => data.volume));

    res.json({
      symbol,
      interval,
      volumeData,
      stats: {
        totalVolume,
        avgVolume,
        maxVolume,
      },
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania danych o wolumenie: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching volume data",
    });
  }
};

/**
 * Pobiera dane statystyczne dotyczące rynku
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getMarketStats = async (req, res) => {
  try {
    const { symbol } = req.params;

    // Waliduj symbol
    if (!isValidSymbol(symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid symbol format",
      });
    }

    // Pobierz dane z różnych interwałów
    const candles1h = await binanceService.getHistoricalCandles(
      symbol,
      "1h",
      24
    );
    const candles1d = await binanceService.getHistoricalCandles(
      symbol,
      "1d",
      7
    );

    // Oblicz zmianę ceny
    const currentPrice = candles1h[candles1h.length - 1].close;
    const price24hAgo = candles1h[0].open;
    const price7dAgo = candles1d[0].open;

    const change24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;
    const change7d = ((currentPrice - price7dAgo) / price7dAgo) * 100;

    // Oblicz wolumen
    const volume24h = candles1h.reduce((sum, candle) => sum + candle.volume, 0);
    const volume7d = candles1d.reduce((sum, candle) => sum + candle.volume, 0);

    // Oblicz najwyższą i najniższą cenę
    const high24h = Math.max(...candles1h.map((candle) => candle.high));
    const low24h = Math.min(...candles1h.map((candle) => candle.low));

    const high7d = Math.max(...candles1d.map((candle) => candle.high));
    const low7d = Math.min(...candles1d.map((candle) => candle.low));

    // Oblicz zmienność (volatility)
    const volatility24h = ((high24h - low24h) / low24h) * 100;
    const volatility7d = ((high7d - low7d) / low7d) * 100;

    res.json({
      symbol,
      currentPrice,
      priceChange: {
        "24h": {
          absolute: currentPrice - price24hAgo,
          percentage: change24h,
        },
        "7d": {
          absolute: currentPrice - price7dAgo,
          percentage: change7d,
        },
      },
      volume: {
        "24h": volume24h,
        "7d": volume7d,
      },
      priceRange: {
        "24h": {
          high: high24h,
          low: low24h,
        },
        "7d": {
          high: high7d,
          low: low7d,
        },
      },
      volatility: {
        "24h": volatility24h,
        "7d": volatility7d,
      },
      lastUpdate: new Date(),
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania statystyk rynkowych: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching market statistics",
    });
  }
};

module.exports = {
  getCurrentPrice,
  getHistoricalCandles,
  getHistoricalCandlesByInterval,
  getAvailableSymbols,
  streamMarketData,
  getIndicators,
  getMarketAnalysis,
  getVolumeData,
  getMarketStats,
  getWebSocketInfo,
};
