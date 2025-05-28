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
const TradingLogger = require("../utils/trading-logger");
const { EventEmitter } = require("events");

class AnalysisService extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map(); // Mapa aktywnych instancji analizy (instanceId -> config)
    this.indicators = new Map(); // Mapa wskaźników (instanceId -> indicators)
    this.lastPrices = new Map(); // Mapa ostatnich cen (instanceId -> lastPrice)
    this.highestPrices = new Map(); // Mapa najwyższych cen dla trailing stopu
    this.extremumReached = new Map(); // Flaga czy osiągnięto ekstremum dla instancji
    this.trailingStopActivationTime = new Map(); // Czas aktywacji trailing stopu

    // ✅ THROTTLING - zapobiega duplikowanym sygnałom
    this.lastSignalEmission = new Map(); // Śledzenie ostatniego czasu emisji sygnału
    this.signalThrottleTime = 30000; // 30 sekund throttling dla tego samego typu sygnału

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
      const currentHigh = candle.high;
      const currentLow = candle.low;

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

      // Jeśli to świeca 15-minutowa i jest zamknięta, aktualizuj kanał Hursta
      if (candle.interval === "15m" && candle.isFinal) {
        const config = this.instances.get(instanceId);
        const candles15m = binanceService.getCachedCandles(
          config.symbol,
          "15m"
        );

        if (candles15m && candles15m.length > 0) {
          this.updateHurstChannel(instanceId, candles15m);
        }
      }

      // Jeśli to świeca 1-godzinna i jest zamknięta, aktualizuj EMA
      if (candle.interval === "1h" && candle.isFinal) {
        const config = this.instances.get(instanceId);
        const candles1h = binanceService.getCachedCandles(config.symbol, "1h");

        if (candles1h && candles1h.length > 0) {
          this.updateEMA(instanceId, candles1h);
        }
      }

      // Zaktualizuj najwyższą cenę dla trailing stopu
      this.updateHighestPrice(instanceId, currentHigh);

      // Wykryj ewentualne sygnały
      this.detectSignals(
        instanceId,
        previousPrice,
        currentPrice,
        currentHigh,
        currentLow
      );

      // Aktualizuj ostatnią cenę
      this.lastPrices.set(instanceId, currentPrice);
    });

    // Dodaj obsługę zdarzeń emitowanych bezpośrednio do analysisService (dla symulatora)
    this.on("kline", (data) => {
      TradingLogger.logDebugThrottled(
        `simulator-${data.instanceId}`,
        `[SIMULATOR] Otrzymano zdarzenie kline bezpośrednio dla instanceId: ${data.instanceId}`,
        60000
      );

      const { candle, instanceId } = data;
      const currentPrice = candle.close;
      const currentHigh = candle.high || currentPrice;
      const currentLow = candle.low || currentPrice;

      // Sprawdź, czy to aktywna instancja
      if (!this.instances.has(instanceId)) {
        return;
      }

      // Sprawdź, czy mamy poprzednią cenę
      if (!this.lastPrices.has(instanceId)) {
        this.lastPrices.set(instanceId, currentPrice);
        return;
      }

      const previousPrice = this.lastPrices.get(instanceId);

      // Zaktualizuj najwyższą cenę dla trailing stopu
      this.updateHighestPrice(instanceId, currentHigh);

      // Wykryj ewentualne sygnały
      this.detectSignals(
        instanceId,
        previousPrice,
        currentPrice,
        currentHigh,
        currentLow
      );

      // Aktualizuj ostatnią cenę
      this.lastPrices.set(instanceId, currentPrice);
    });
  }

  /**
   * Aktualizuje najwyższą cenę dla instancji (używane dla trailing stopu)
   * @param {string} instanceId - Identyfikator instancji
   * @param {number} currentHigh - Aktualna najwyższa cena
   */
  updateHighestPrice(instanceId, currentHigh) {
    // Tylko aktualizuj, jeśli już mamy pozycję (flagę extremumReached)
    if (
      this.extremumReached.has(instanceId) &&
      this.extremumReached.get(instanceId)
    ) {
      // Jeśli nie mamy jeszcze najwyższej ceny, inicjalizuj ją
      if (!this.highestPrices.has(instanceId)) {
        this.highestPrices.set(instanceId, currentHigh);
      }
      // Zaktualizuj tylko, jeśli nowa cena jest wyższa
      else if (currentHigh > this.highestPrices.get(instanceId)) {
        this.highestPrices.set(instanceId, currentHigh);
      }
    }
  }

  /**
   * Resetuje śledzenie trailing stopu dla instancji
   * @param {string} instanceId - Identyfikator instancji
   */
  resetTrailingStopTracking(instanceId) {
    this.extremumReached.set(instanceId, false);
    this.highestPrices.delete(instanceId);
    this.trailingStopActivationTime.delete(instanceId);
    logger.debug(
      `Zresetowano śledzenie trailing stopu dla instancji ${instanceId}`
    );
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
      const shortEma = new ExponentialMovingAverage({
        ...emaConfig,
        periods: 5,
      }); // EMA5 dla określania kierunku trendu

      // Zapisz konfigurację i wskaźniki
      this.instances.set(instanceId, config);
      this.indicators.set(instanceId, { hurstChannel, ema, shortEma });

      // Inicjalizuj flagi dla trailing stopu
      this.extremumReached.set(instanceId, false);

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
      if (!indicators || !indicators.ema || !indicators.shortEma) {
        return;
      }

      // Oblicz EMA długie (np. EMA30)
      const emaValue = indicators.ema.calculate(candles);
      // Oblicz EMA krótkie (np. EMA5)
      const shortEmaValue = indicators.shortEma.calculate(candles);

      if (emaValue !== null && shortEmaValue !== null) {
        // Zapisz wyniki
        indicators.emaValue = emaValue;
        indicators.shortEmaValue = shortEmaValue;

        // Emituj zdarzenie aktualizacji
        this.emit("emaUpdated", {
          instanceId,
          value: emaValue,
          shortValue: shortEmaValue,
          candle: candles[candles.length - 1],
        });

        logger.debug(
          `Zaktualizowano EMA dla instancji ${instanceId} (EMA=${emaValue.toFixed(2)}, EMA5=${shortEmaValue.toFixed(2)})`
        );
      }
    } catch (error) {
      logger.error(
        `Błąd podczas aktualizacji EMA dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

  /**
   * Określa aktualny trend na podstawie EMA
   * @param {number} currentPrice - Aktualna cena
   * @param {number} emaValue - Wartość EMA długiej
   * @param {number} shortEmaValue - Wartość EMA krótkiej
   * @returns {string} - Kierunek i siła trendu: "strong_up", "up", "neutral", "down", "strong_down"
   */
  determineTrend(currentPrice, emaValue, shortEmaValue) {
    if (!emaValue || !shortEmaValue) {
      return "neutral";
    }

    // Określ kierunek trendu na podstawie krótkiej EMA względem długiej
    const direction =
      shortEmaValue > emaValue
        ? "up"
        : shortEmaValue < emaValue
          ? "down"
          : "neutral";

    // Oblicz siłę trendu jako odległość ceny od długiej EMA
    const trendStrength = Math.abs((currentPrice - emaValue) / emaValue) * 100;

    // Zwróć odpowiedni trend na podstawie kierunku i siły
    if (currentPrice > emaValue && direction === "up") {
      // Trend wzrostowy
      return trendStrength > 1.5 ? "strong_up" : "up";
    } else if (currentPrice < emaValue && direction === "down") {
      // Trend spadkowy
      return trendStrength > 1.5 ? "strong_down" : "down";
    } else {
      // Trend neutralny lub mieszany
      return "neutral";
    }
  }

  /**
   * Wykrywa sygnały dla instancji na podstawie aktualnych cen i wskaźników
   * ✅ Z THROTTLING - zapobiega duplikowanym sygnałom
   * @param {string} instanceId - Identyfikator instancji
   * @param {number} previousPrice - Poprzednia cena
   * @param {number} currentPrice - Aktualna cena
   * @param {number} currentHigh - Aktualna najwyższa cena
   * @param {number} currentLow - Aktualna najniższa cena
   */
  detectSignals(
    instanceId,
    previousPrice,
    currentPrice,
    currentHigh,
    currentLow
  ) {
    try {
      // Pobierz wskaźniki dla instancji
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.hurstResult) {
        return;
      }

      const hurstResult = indicators.hurstResult;
      const emaValue = indicators.emaValue;
      const shortEmaValue = indicators.shortEmaValue;

      // Określ aktualny trend z wyższego timeframe'u
      const currentTrend = this.determineTrend(
        currentPrice,
        emaValue,
        shortEmaValue
      );

      // 1. Sprawdź dotknięcie dolnej bandy kanału Hursta (potencjalne wejście)
      let touchesLowerBand = false;
      if (
        currentLow <= hurstResult.lowerBand &&
        currentHigh >= hurstResult.lowerBand
      ) {
        touchesLowerBand = true;
      }

      if (touchesLowerBand) {
        // ✅ THROTTLING - sprawdź czy nie emitowaliśmy tego sygnału niedawno
        const signalKey = `${instanceId}-lowerBandTouch`;
        const lastEmission = this.lastSignalEmission.get(signalKey) || 0;
        const now = Date.now();

        if (now - lastEmission > this.signalThrottleTime) {
          // Sprawdź warunek trendu z wyższego timeframe'u (EMA), jeśli wymagany
          let trendConditionMet = true;
          const config = this.instances.get(instanceId);

          if (config.checkEMATrend && emaValue !== null) {
            // Dozwolone trendy: wzrostowy, silnie wzrostowy, neutralny
            trendConditionMet = ["up", "strong_up", "neutral"].includes(
              currentTrend
            );
          }

          if (trendConditionMet) {
            // Emituj sygnał wejścia i zapisz czas emisji
            this.emit("entrySignal", {
              instanceId,
              type: "lowerBandTouch",
              price: currentPrice,
              hurstChannel: hurstResult,
              emaValue,
              shortEmaValue,
              trend: currentTrend,
              timestamp: now,
            });

            this.lastSignalEmission.set(signalKey, now);

            TradingLogger.logDebugThrottled(
              `signal-${instanceId}-entry`,
              `Emitowano sygnał lowerBandTouch dla ${instanceId} @${currentPrice}`,
              60000
            );
          }
        }
        // Jeśli jest w throttle - po prostu ignoruj bez logowania
      }

      // 2. Sprawdź przekroczenie górnej bandy kanału Hursta (trigger dla trailing stopu)
      const upperBandBreak = currentHigh >= hurstResult.upperBand;
      // Jeśli przekroczono górną bandę i nie ustawiono jeszcze flagi
      if (upperBandBreak && !this.extremumReached.get(instanceId)) {
        this.extremumReached.set(instanceId, true);
        this.highestPrices.set(instanceId, currentHigh);
        // Zapisz czas aktywacji trailing stopu
        this.trailingStopActivationTime.set(instanceId, Date.now());

        logger.debug(
          `Osiągnięto górne ekstremum dla instancji ${instanceId}, aktywowano trailing stop (cena=${currentHigh})`
        );
      }

      // 3. Sprawdź przecięcie górnej bandy i powrót do kanału (wyjście)
      const upperBandCrossDown =
        currentLow <= hurstResult.upperBand &&
        currentPrice <= hurstResult.upperBand &&
        previousPrice > hurstResult.upperBand &&
        this.extremumReached.get(instanceId);

      if (upperBandCrossDown) {
        // ✅ THROTTLING dla sygnałów wyjścia
        const signalKey = `${instanceId}-upperBandCrossDown`;
        const lastEmission = this.lastSignalEmission.get(signalKey) || 0;
        const now = Date.now();

        if (now - lastEmission > this.signalThrottleTime) {
          // Emituj sygnał wyjścia (po dotknięciu górnej bandy i powrocie)
          this.emit("exitSignal", {
            instanceId,
            type: "upperBandCrossDown",
            price: currentPrice,
            hurstChannel: hurstResult,
            emaValue,
            timestamp: now,
          });

          this.lastSignalEmission.set(signalKey, now);

          TradingLogger.logDebugThrottled(
            `signal-${instanceId}-exit`,
            `Emitowano sygnał upperBandCrossDown dla ${instanceId} @${currentPrice}`,
            60000
          );

          // Resetuj flagi trailing stopu
          this.extremumReached.set(instanceId, false);
          this.highestPrices.delete(instanceId);
          this.trailingStopActivationTime.delete(instanceId);

          // Zakończ funkcję wcześniej - wyjście przez przecięcie górnej bandy ma priorytet
          return;
        }
      }

      // 4. Sprawdź trailing stop (jeśli aktywny)
      if (
        this.extremumReached.get(instanceId) &&
        this.highestPrices.has(instanceId)
      ) {
        const highestPrice = this.highestPrices.get(instanceId);
        const activationTime =
          this.trailingStopActivationTime.get(instanceId) || 0;
        const config = this.instances.get(instanceId);

        // Aktualizuj najwyższą cenę jeśli aktualny high jest wyższy
        if (currentHigh > highestPrice) {
          this.highestPrices.set(instanceId, currentHigh);
        }

        // Sprawdź, czy trailing stop jest włączony dla tej instancji
        const trailingStopEnabled =
          config?.signals?.enableTrailingStop === true;

        // Jeśli trailing stop nie jest włączony, wyjdź wcześniej
        if (!trailingStopEnabled) {
          return;
        }

        // Pobierz opóźnienie aktywacji trailing stopu (domyślnie 5 minut)
        const trailingStopDelay =
          config?.signals?.trailingStopDelay || 5 * 60 * 1000;

        // Sprawdź, czy upłynął wymagany czas od aktywacji
        const timeElapsed = Date.now() - activationTime;
        if (timeElapsed < trailingStopDelay) {
          return; // Jeszcze nie upłynął wymagany czas
        }

        // Ustaw bazowy trailing stop
        let trailingStopPercent = config?.signals?.trailingStop || 0.02; // Domyślnie 2%

        // Dynamicznie dostosuj trailing stop na podstawie trendu
        if (currentTrend === "strong_up") {
          // W silnym trendzie wzrostowym daj większe pole manewru
          trailingStopPercent = trailingStopPercent * 1.5;
        } else if (currentTrend === "down" || currentTrend === "strong_down") {
          // W trendzie spadkowym bądź bardziej restrykcyjny
          trailingStopPercent = trailingStopPercent * 0.7;
        }

        // Oblicz spadek od najwyższej ceny (jako procent)
        const dropFromHigh = (highestPrice - currentPrice) / highestPrice;

        // Jeśli spadek przekroczył trailing stop, wygeneruj sygnał wyjścia
        if (dropFromHigh >= trailingStopPercent) {
          // ✅ THROTTLING dla trailing stop
          const signalKey = `${instanceId}-trailingStop`;
          const lastEmission = this.lastSignalEmission.get(signalKey) || 0;
          const now = Date.now();

          if (now - lastEmission > this.signalThrottleTime) {
            this.emit("exitSignal", {
              instanceId,
              type: "trailingStop",
              price: currentPrice,
              highestPrice,
              dropPercent: dropFromHigh * 100,
              trailingStopPercent: trailingStopPercent * 100,
              hurstChannel: hurstResult,
              emaValue,
              timestamp: now,
            });

            this.lastSignalEmission.set(signalKey, now);

            TradingLogger.logDebugThrottled(
              `signal-${instanceId}-trailing`,
              `Emitowano sygnał trailingStop dla ${instanceId} @${currentPrice}`,
              60000
            );

            // Resetuj flagi trailing stopu
            this.extremumReached.set(instanceId, false);
            this.highestPrices.delete(instanceId);
            this.trailingStopActivationTime.delete(instanceId);
          }
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
      shortEmaValue: indicators.shortEmaValue || null,
      lastPrice: this.lastPrices.get(instanceId) || null,
      isExtremumReached: this.extremumReached.get(instanceId) || false,
      highestPrice: this.highestPrices.get(instanceId) || null,
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

      // ✅ Wyczyść throttling dla tej instancji
      for (const [key, value] of this.lastSignalEmission.entries()) {
        if (key.startsWith(`${instanceId}-`)) {
          this.lastSignalEmission.delete(key);
        }
      }

      // Usuń instancję z map
      this.instances.delete(instanceId);
      this.indicators.delete(instanceId);
      this.lastPrices.delete(instanceId);
      this.extremumReached.delete(instanceId);
      this.highestPrices.delete(instanceId);
      this.trailingStopActivationTime.delete(instanceId);

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
