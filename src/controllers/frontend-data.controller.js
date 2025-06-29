/**
 * Frontend Data Controller - plik przeliczeniowy danych backendu na frontend
 *
 * Lokalizacja: src/controllers/frontend-data.controller.js
 *
 * Odpowiedzialny za:
 * - Pobieranie historii kanału Hursta dla konkretnych instancji
 * - Przeliczanie danych backendu na format gotowy dla frontendu
 * - Zapewnienie zgodności parametrów z prawdziwymi instancjami
 * - Zwięzłe logowanie przez TradingLogger
 */

const instanceService = require("../services/instance.service");
const binanceService = require("../services/binance.service");
const { HurstChannel } = require("../utils/technical");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");

/**
 * Pobiera historię kanału Hursta dla konkretnej instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getHurstHistory = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { days = 4 } = req.query;

    // Waliduj parametr dni
    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 30) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Days parameter must be between 1 and 30",
      });
    }

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Pobierz parametry kanału Hursta z instancji
    const hurstParams = instance.strategy?.parameters?.hurst;
    if (!hurstParams) {
      return res.status(400).json({
        error: "Configuration Error",
        message: "Instance has no Hurst channel parameters",
      });
    }

    // Oblicz zakres dat
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - daysNum);

    // Pobierz dane historyczne 15m
    const historicalCandles = await binanceService.getHistoricalCandles(
      instance.symbol,
      "15m",
      daysNum * 24 * 4 + 50, // 4 świece na godzinę * 24h * dni + bufor
      startDate.getTime(),
      endDate.getTime()
    );

    if (!historicalCandles || historicalCandles.length < hurstParams.periods) {
      return res.status(400).json({
        error: "Insufficient Data",
        message: `Not enough historical data. Required: ${hurstParams.periods}, available: ${historicalCandles?.length || 0}`,
      });
    }

    // Utwórz instancję kalkulatora kanału Hursta z parametrami z instancji
    const hurstCalculator = new HurstChannel({
      periods: hurstParams.periods,
      upperDeviationFactor: hurstParams.upperDeviationFactor,
      lowerDeviationFactor: hurstParams.lowerDeviationFactor,
    });

    // Oblicz historię kanału Hursta
    const history = [];

    // Dla każdej świecy od 'periods' do końca, oblicz kanał na podstawie poprzednich 'periods' świec
    for (let i = hurstParams.periods - 1; i < historicalCandles.length; i++) {
      // Weź okresy świec dla tej pozycji
      const candlesForCalculation = historicalCandles.slice(
        i - hurstParams.periods + 1,
        i + 1
      );

      // Oblicz kanał Hursta dla tej grupy świec
      const hurstResult = hurstCalculator.calculate(candlesForCalculation);

      if (hurstResult) {
        // Dodaj punkt do historii
        history.push({
          time: Math.floor(historicalCandles[i].openTime / 1000), // TradingView format (sekundy)
          originalTime: historicalCandles[i].openTime, // Oryginalny timestamp (milisekundy)
          upperBand: hurstResult.upperBand,
          lowerBand: hurstResult.lowerBand,
          middleBand: hurstResult.middleBand,
          hurstExponent: hurstResult.hurstExponent,
          price: historicalCandles[i].close,
          // Dodatkowe dane diagnostyczne
          adaptiveUpperFactor: hurstResult.adaptiveUpperFactor,
          adaptiveLowerFactor: hurstResult.adaptiveLowerFactor,
        });
      }
    }

    // Zwięzły log operacji
    TradingLogger.logDebugThrottled(
      `frontend-hurst-${instanceId}`,
      `[FRONTEND] Hurst history: ${instance.symbol} | ${daysNum}d | ${historicalCandles.length}→${history.length} points | Instance: ${instanceId.slice(-8)}`,
      120000 // throttle na 2 minuty
    );

    // Zwróć historię
    res.json({
      success: true,
      instanceId,
      symbol: instance.symbol,
      days: daysNum,
      parameters: {
        periods: hurstParams.periods,
        upperDeviationFactor: hurstParams.upperDeviationFactor,
        lowerDeviationFactor: hurstParams.lowerDeviationFactor,
        interval: hurstParams.interval || "15m",
      },
      history,
      totalPoints: history.length,
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    TradingLogger.logTradingError(
      instanceId || "unknown",
      "CHART",
      error.message,
      "Hurst history calculation failed"
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while calculating Hurst channel history",
      details: error.message,
    });
  }
};

/**
 * Pobiera podstawowe informacje o parametrach instancji (bez obliczeń)
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getInstanceParameters = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Zwięzły log operacji
    TradingLogger.logDebugThrottled(
      `frontend-params-${instanceId}`,
      `[FRONTEND] Parameters: ${instance.symbol} | Instance: ${instanceId.slice(-8)}`,
      300000 // throttle na 5 minut
    );

    // Zwróć parametry instancji
    res.json({
      success: true,
      instanceId,
      symbol: instance.symbol,
      parameters: {
        hurst: instance.strategy?.parameters?.hurst || {},
        ema: instance.strategy?.parameters?.ema || {},
        signals: instance.strategy?.parameters?.signals || {},
        capitalAllocation:
          instance.strategy?.parameters?.capitalAllocation || {},
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    TradingLogger.logTradingError(
      instanceId || "unknown",
      "CHART",
      error.message,
      "Instance parameters fetch failed"
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance parameters",
    });
  }
};

/**
 * Endpoint informacyjny - lista dostępnych funkcji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAvailableFunctions = (req, res) => {
  res.json({
    success: true,
    message: "Frontend Data Controller - przelicznik danych backendu",
    availableEndpoints: [
      {
        method: "GET",
        path: "/api/v1/frontend-data/hurst-history/:instanceId",
        description: "Pobiera historię kanału Hursta dla instancji",
        parameters: {
          instanceId: "ID instancji",
          days: "Liczba dni historii (1-30, domyślnie 4)",
        },
        example: "/api/v1/frontend-data/hurst-history/abc123?days=4",
      },
      {
        method: "GET",
        path: "/api/v1/frontend-data/parameters/:instanceId",
        description: "Pobiera parametry instancji bez obliczeń",
        parameters: {
          instanceId: "ID instancji",
        },
        example: "/api/v1/frontend-data/parameters/abc123",
      },
    ],
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
  });
};

module.exports = {
  getHurstHistory,
  getInstanceParameters,
  getAvailableFunctions,
};
