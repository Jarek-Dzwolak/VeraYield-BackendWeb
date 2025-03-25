/**
 * Analysis Service - serwis analizy danych
 *
 * Odpowiedzialny za:
 * - Obliczanie kanału Hursta dla danych 15-minutowych
 * - Obliczanie EMA dla danych godzinowych
 * - Wykrywanie sygnałów na podstawie przecięć
 */

const {
  HurstChannel,
  ExponentialMovingAverage,
  CrossDetector,
} = require("../utils/technical");
const binanceService = require("./binance.service");
const logger = require("../utils/logger");
const { EventEmitter } = require("events");

class AnalysisService extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map(); // Mapa aktywnych instancji analizy (instanceId -> config)
    this.indicators = new Map(); // Mapa wskaźników (instanceId -> indicators)
    this.lastPrices = new Map(); // Mapa ostatnich cen (instanceId -> lastPrice)
    this.setupListeners();
  }

  /**
   * Konfiguruje nasłuchiwanie zdarzeń z serwisu Binance
   */
  setupListeners() {
    // Nasłuchuj zamknięte świece 15-minutowe
    binanceService.on("klineClosed", (data) => {
      const { candle, instanceId, allCandles } = data;

      // Sprawdź, czy to aktywna instancja
      if (!this.instances.has(instanceId)) {
        return;
      }

      const config = this.instances.get(instanceId);

      // Aktualizuj wskaźniki dla odpowiedniego interwału
      if (candle.interval === "15m") {
        this.updateHurstChannel(instanceId, allCandles);
      } else if (candle.interval === "1h") {
        this.updateEMA(instanceId, allCandles);
      }

      // Aktualizuj ostatnią cenę
      this.lastPrices.set(instanceId, candle.close);
    });

    // Nasłuchuj aktualizacje cen (do wykrywania sygnałów w czasie rzeczywistym)
    binanceService.on("kline", (data) => {
      const { candle, instanceId } = data;
      const currentPrice = candle.close;

      // Sprawdź, czy mamy poprzednią cenę
      if (!this.lastPrices.has(instanceId)) {
        this.lastPrices.set(instanceId, currentPrice);
        return;
      }

      const previousPrice = this.lastPrices.get(instanceId);

      // Sprawdź, czy to aktywna instancja
      if (!this.instances.has(instanceId)) {
        return;
      }

      // Jeśli to świeca 15-minutowa, aktualizuj także kanał Hursta dla bieżących danych
      if (candle.interval === "15m") {
        const config = this.instances.get(instanceId);
        const candles15m = binanceService.getCachedCandles(
          config.symbol,
          "15m"
        );

        // Aktualizuj kanał Hursta z najnowszymi danymi (również niezamkniętymi)
        if (candles15m && candles15m.length > 0) {
          // Dodaj bieżącą świecę, jeśli nie jest już zawarta w danych
          const lastCandle = candles15m[candles15m.length - 1];
          if (lastCandle.openTime !== candle.openTime) {
            const updatedCandles = [...candles15m, candle];
            this.updateHurstChannel(instanceId, updatedCandles);
          } else {
            // Aktualizuj ostatnią świecę w danych
            const updatedCandles = [...candles15m.slice(0, -1), candle];
            this.updateHurstChannel(instanceId, updatedCandles);
          }
        }
      }

      // Wykryj ewentualne sygnały
      this.detectSignals(instanceId, previousPrice, currentPrice);

      // Aktualizuj ostatnią cenę
      this.lastPrices.set(instanceId, currentPrice);
    });
  }

  /**
   * Inicjalizuje nową instancję analizy
   * @param {string} instanceId - Identyfikator instancji
   * @param {Object} config - Konfiguracja analizy
   * @returns {boolean} - Czy inicjalizacja się powiodła
   */
  async initializeInstance(instanceId, config) {
    try {
      // Sprawdź, czy instancja już istnieje
      if (this.instances.has(instanceId)) {
        logger.warn(`Instancja analizy ${instanceId} już istnieje`);
        return false;
      }

      // Pobierz wymagane interwały
      const intervals = ["15m", "1h"];

      // Inicjalizuj dane z Binance
      await binanceService.initializeInstanceData(
        config.symbol,
        intervals,
        instanceId
      );

      // Inicjalizuj wskaźniki
      const hurstConfig = config.hurst || {
        interval: "15m",
        periods: 25,
        upperDeviationFactor: 2.0,
        lowerDeviationFactor: 2.0,
      };

      const emaConfig = config.ema || {
        interval: "1h",
        periods: 30,
      };

      const hurstChannel = new HurstChannel(hurstConfig);
      const ema = new ExponentialMovingAverage(emaConfig);
      // Zapisz konfigurację i wskaźniki
      this.instances.set(instanceId, config);
      this.indicators.set(instanceId, { hurstChannel, ema });

      // Oblicz początkowe wartości wskaźników
      this.updateInitialIndicators(instanceId);

      logger.info(
        `Zainicjalizowano analizę dla instancji ${instanceId} (${config.symbol})`
      );
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas inicjalizacji analizy dla instancji ${instanceId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Oblicza początkowe wartości wskaźników
   * @param {string} instanceId - Identyfikator instancji
   */
  updateInitialIndicators(instanceId) {
    const config = this.instances.get(instanceId);

    // Pobierz dane historyczne
    const candles15m = binanceService.getCachedCandles(config.symbol, "15m");
    const candles1h = binanceService.getCachedCandles(config.symbol, "1h");

    // Oblicz kanał Hursta
    if (candles15m && candles15m.length > 0) {
      this.updateHurstChannel(instanceId, candles15m);
    }

    // Oblicz EMA
    if (candles1h && candles1h.length > 0) {
      this.updateEMA(instanceId, candles1h);
    }
  }

  /**
   * Aktualizuje kanał Hursta dla instancji
   * @param {string} instanceId - Identyfikator instancji
   * @param {Array} candles - Tablica danych świecowych
   */
  updateHurstChannel(instanceId, candles) {
    try {
      // Pobierz wskaźniki dla instancji
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.hurstChannel) {
        return;
      }

      // Oblicz kanał Hursta
      const hurstResult = indicators.hurstChannel.calculate(candles);

      if (hurstResult) {
        // Zapisz wynik
        indicators.hurstResult = hurstResult;

        // Emituj zdarzenie aktualizacji
        this.emit("hurstUpdated", {
          instanceId,
          result: hurstResult,
        });

        logger.debug(
          `Zaktualizowano kanał Hursta dla instancji ${instanceId} (H=${hurstResult.hurstExponent.toFixed(3)})`
        );
      }
    } catch (error) {
      logger.error(
        `Błąd podczas aktualizacji kanału Hursta dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

  /**
   * Aktualizuje EMA dla instancji
   * @param {string} instanceId - Identyfikator instancji
   * @param {Array} candles - Tablica danych świecowych
   */
  updateEMA(instanceId, candles) {
    try {
      // Pobierz wskaźniki dla instancji
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.ema) {
        return;
      }

      // Oblicz EMA
      const emaValue = indicators.ema.calculate(candles);

      if (emaValue !== null) {
        // Zapisz wynik
        indicators.emaValue = emaValue;

        // Emituj zdarzenie aktualizacji
        this.emit("emaUpdated", {
          instanceId,
          value: emaValue,
          candle: candles[candles.length - 1],
        });

        logger.debug(
          `Zaktualizowano EMA dla instancji ${instanceId} (EMA=${emaValue.toFixed(2)})`
        );
      }
    } catch (error) {
      logger.error(
        `Błąd podczas aktualizacji EMA dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

  /**
   * Wykrywa sygnały dla instancji na podstawie aktualnych cen i wskaźników
   * @param {string} instanceId - Identyfikator instancji
   * @param {number} previousPrice - Poprzednia cena
   * @param {number} currentPrice - Aktualna cena
   */
  detectSignals(instanceId, previousPrice, currentPrice) {
    try {
      // Pobierz wskaźniki dla instancji
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.hurstResult) {
        return;
      }

      const config = this.instances.get(instanceId);
      const hurstResult = indicators.hurstResult;
      const emaValue = indicators.emaValue;

      // 1. Sprawdź dotknięcie dolnej bandy kanału Hursta (potencjalne wejście)
      const lowerBandCross = CrossDetector.detectLevelCross(
        previousPrice,
        currentPrice,
        hurstResult.lowerBand
      );
      if (lowerBandCross && lowerBandCross.direction === "down") {
        // Sprawdź warunek trendu z wyższego timeframe'u (EMA), jeśli wymagany
        let trendConditionMet = true;
        if (config.checkEMATrend && emaValue !== null) {
          const trendDirection = currentPrice >= emaValue ? "up" : "down";
          trendConditionMet =
            trendDirection === "up" || trendDirection === "sideways";
        }

        if (trendConditionMet) {
          // Emituj sygnał wejścia
          this.emit("entrySignal", {
            instanceId,
            type: "lowerBandTouch",
            price: currentPrice,
            hurstChannel: hurstResult,
            emaValue,
            timestamp: new Date().getTime(),
          });

          logger.info(
            `Wykryto sygnał wejścia dla instancji ${instanceId} (dotknięcie dolnej bandy kanału Hursta przy cenie ${currentPrice})`
          );
        }
      }

      // 2. Sprawdź przecięcie górnej bandy kanału Hursta i powrót do kanału (potencjalne wyjście)
      const upperBandCross = CrossDetector.detectLevelCross(
        previousPrice,
        currentPrice,
        hurstResult.upperBand
      );
      if (upperBandCross && upperBandCross.direction === "down") {
        // Emituj sygnał wyjścia (po dotknięciu górnej bandy i powrocie)
        this.emit("exitSignal", {
          instanceId,
          type: "upperBandCrossDown",
          price: currentPrice,
          hurstChannel: hurstResult,
          emaValue,
          timestamp: new Date().getTime(),
        });

        logger.info(
          `Wykryto sygnał wyjścia dla instancji ${instanceId} (przecięcie górnej bandy kanału Hursta w dół przy cenie ${currentPrice})`
        );
      }

      // 3. Sprawdź przecięcie EMA (dodatkowy sygnał)
      if (emaValue !== null) {
        const emaCross = CrossDetector.detectLevelCross(
          previousPrice,
          currentPrice,
          emaValue
        );
        if (emaCross) {
          this.emit("emaCross", {
            instanceId,
            direction: emaCross.direction,
            price: currentPrice,
            emaValue,
            timestamp: new Date().getTime(),
          });

          logger.debug(
            `Wykryto przecięcie EMA dla instancji ${instanceId} (kierunek: ${emaCross.direction}, cena: ${currentPrice})`
          );
        }
      }
    } catch (error) {
      logger.error(
        `Błąd podczas wykrywania sygnałów dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

  /**
   * Pobiera aktualny stan analizy dla instancji
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Object|null} - Aktualny stan analizy lub null, jeśli instancja nie istnieje
   */
  getInstanceAnalysisState(instanceId) {
    // Sprawdź, czy instancja istnieje
    if (!this.instances.has(instanceId) || !this.indicators.has(instanceId)) {
      return null;
    }

    const config = this.instances.get(instanceId);
    const indicators = this.indicators.get(instanceId);

    return {
      symbol: config.symbol,
      hurstChannel: indicators.hurstResult || null,
      emaValue: indicators.emaValue || null,
      lastPrice: this.lastPrices.get(instanceId) || null,
      timestamp: new Date().getTime(),
    };
  }

  /**
   * Zatrzymuje analizę dla instancji
   * @param {string} instanceId - Identyfikator instancji
   * @returns {boolean} - Czy zatrzymanie się powiodło
   */
  stopInstance(instanceId) {
    try {
      // Sprawdź, czy instancja istnieje
      if (!this.instances.has(instanceId)) {
        logger.warn(
          `Próba zatrzymania nieistniejącej instancji analizy: ${instanceId}`
        );
        return false;
      }

      const config = this.instances.get(instanceId);

      // Anuluj subskrypcje WebSocket
      const intervals = ["15m", "1h"];
      intervals.forEach((interval) => {
        binanceService.unsubscribeFromKlines(
          config.symbol,
          interval,
          instanceId
        );
      });

      // Usuń instancję z map
      this.instances.delete(instanceId);
      this.indicators.delete(instanceId);
      this.lastPrices.delete(instanceId);

      logger.info(`Zatrzymano analizę dla instancji ${instanceId}`);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas zatrzymywania analizy dla instancji ${instanceId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Zatrzymuje wszystkie instancje analizy
   */
  stopAllInstances() {
    const instanceIds = [...this.instances.keys()];

    for (const instanceId of instanceIds) {
      this.stopInstance(instanceId);
    }

    logger.info("Zatrzymano wszystkie instancje analizy");
  }
}

// Eksportuj singleton
const analysisService = new AnalysisService();
module.exports = analysisService;
