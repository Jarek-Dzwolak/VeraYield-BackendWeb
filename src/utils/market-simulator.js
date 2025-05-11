/**
 * Market Simulator - narzędzie do symulacji warunków rynkowych
 *
 * UWAGA: Ten plik jest przeznaczony tylko do testowania i powinien być
 * usunięty przed wdrożeniem produkcyjnym.
 *
 * @temporary - Do usunięcia po testach
 */

const analysisService = require("../services/analysis.service");
const logger = require("./logger");

class MarketSimulator {
  /**
   * Symuluje dotknięcie dolnej bandy kanału Hursta
   */
  static simulateLowerBandTouch(instanceId, analysisState) {
    logger.info(
      `[SIMULATOR] Rozpoczęcie symulacji dotknięcia dolnej bandy dla instancji ${instanceId}`
    );

    const currentPrice = analysisState.lastPrice || 70000;
    const lowerBand =
      analysisState.hurstChannel?.lowerBand || currentPrice * 0.98;

    // Emituj sztuczny sygnał świecy która dotyka dolnej bandy
    analysisService.emit("kline", {
      candle: {
        symbol: analysisState.symbol,
        interval: "15m",
        open: currentPrice,
        high: currentPrice,
        low: lowerBand - 10, // Nieco poniżej bandy
        close: lowerBand + 5, // Zamknięcie tuż nad bandą
        volume: 100,
        isFinal: true,
        openTime: Date.now() - 15 * 60 * 1000,
        closeTime: Date.now(),
      },
      instanceId: instanceId,
    });

    // Po chwili symuluj normalną cenę
    setTimeout(() => {
      analysisService.emit("kline", {
        candle: {
          symbol: analysisState.symbol,
          interval: "15m",
          open: lowerBand + 5,
          high: lowerBand + 50,
          low: lowerBand + 5,
          close: lowerBand + 45,
          volume: 100,
          isFinal: false,
        },
        instanceId: instanceId,
      });
    }, 100);

    return {
      currentPrice,
      lowerBand,
      simulatedLow: lowerBand - 10,
      simulatedClose: lowerBand + 5,
    };
  }

  /**
   * Symuluje przekroczenie górnej bandy i powrót
   */
  static simulateUpperBandCross(instanceId, analysisState) {
    logger.info(
      `[SIMULATOR] Rozpoczęcie symulacji przekroczenia górnej bandy dla instancji ${instanceId}`
    );

    const currentPrice = analysisState.lastPrice || 70000;
    const upperBand =
      analysisState.hurstChannel?.upperBand || currentPrice * 1.02;

    // Najpierw symuluj przekroczenie górnej bandy
    analysisService.emit("kline", {
      candle: {
        symbol: analysisState.symbol,
        interval: "15m",
        open: currentPrice,
        high: upperBand + 100,
        low: currentPrice,
        close: upperBand + 50,
        volume: 100,
        isFinal: true,
      },
      instanceId: instanceId,
    });

    // Po chwili symuluj powrót poniżej bandy
    setTimeout(() => {
      analysisService.emit("kline", {
        candle: {
          symbol: analysisState.symbol,
          interval: "15m",
          open: upperBand + 50,
          high: upperBand + 50,
          low: upperBand - 100,
          close: upperBand - 50,
          volume: 100,
          isFinal: true,
        },
        instanceId: instanceId,
      });
    }, 5000); // 5 sekund opóźnienia

    return {
      upperBand,
      simulatedHigh: upperBand + 100,
      simulatedClose: upperBand - 50,
    };
  }

  /**
   * Symuluje warunki dla trailing stop
   */
  static simulateTrailingStop(instanceId, analysisState) {
    logger.info(
      `[SIMULATOR] Rozpoczęcie symulacji trailing stop dla instancji ${instanceId}`
    );

    const currentPrice = analysisState.lastPrice || 70000;
    const upperBand =
      analysisState.hurstChannel?.upperBand || currentPrice * 1.02;

    // Najpierw symuluj silny wzrost powyżej górnej bandy
    analysisService.emit("kline", {
      candle: {
        symbol: analysisState.symbol,
        interval: "15m",
        open: currentPrice,
        high: upperBand + 500, // Silny wzrost
        low: currentPrice,
        close: upperBand + 400,
        volume: 200,
        isFinal: true,
      },
      instanceId: instanceId,
    });

    // Po 10 sekundach symuluj spadek o 2% (aktywacja trailing stop)
    setTimeout(() => {
      const highPrice = upperBand + 500;
      const dropPrice = highPrice * 0.98; // 2% spadek

      analysisService.emit("kline", {
        candle: {
          symbol: analysisState.symbol,
          interval: "15m",
          open: upperBand + 400,
          high: upperBand + 400,
          low: dropPrice - 50,
          close: dropPrice,
          volume: 150,
          isFinal: true,
        },
        instanceId: instanceId,
      });
    }, 10000); // 10 sekund opóźnienia

    return {
      upperBand,
      simulatedHigh: upperBand + 500,
      expectedTrailingStopPrice: (upperBand + 500) * 0.98,
    };
  }
}

module.exports = MarketSimulator;
