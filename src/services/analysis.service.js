/**
 * Analysis Service - serwis analizy danych z nową logiką górnej bandy
 */

const {
  HurstChannel,
  ExponentialMovingAverage,
} = require("../utils/technical");
const binanceService = require("./binance.service");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");
const { EventEmitter } = require("events");

class AnalysisService extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map();
    this.indicators = new Map();
    this.lastPrices = new Map();
    this.highestPrices = new Map();
    this.extremumReached = new Map(); // Zachowane dla trailing stop
    this.trailingStopActivationTime = new Map();

    // ✅ NOWY STATE MANAGER DLA GÓRNEJ BANDY
    this.upperBandStates = new Map(); // instanceId -> state object
    this.upperBandTimers = new Map(); // instanceId -> timer info

    // ✅ THROTTLING - tylko dla dolnej bandy, nie dla górnej bandy
    this.lastSignalEmission = new Map();
    this.signalThrottleTime = 30000; // 30 sekund tylko dla dolnej bandy

    this.setupListeners();
  }

  /**
   * ✅ NOWA METODA - Inicjalizacja stanu górnej bandy dla instancji
   */
  initializeUpperBandState(instanceId) {
    this.upperBandStates.set(instanceId, {
      currentState: "waiting_for_exit", // waiting_for_exit | exit_counting | waiting_for_return | return_counting
      stateStartTime: null,
      triggerPrice: null,
      bandLevel: null,
      resetConditionMet: false,
      resetStartTime: null,
    });

    this.upperBandTimers.set(instanceId, {
      stateTimer: null,
      resetTimer: null,
      lastLogTime: 0,
    });

    TradingLogger.logUpperBandState(
      instanceId,
      "initialized",
      "waiting_for_exit"
    );
  }

  /**
   * ✅ NOWA METODA - Reset stanu górnej bandy
   */
  resetUpperBandState(instanceId) {
    if (this.upperBandStates.has(instanceId)) {
      const timers = this.upperBandTimers.get(instanceId);

      // Wyczyść timery jeśli istnieją
      if (timers) {
        if (timers.stateTimer) clearTimeout(timers.stateTimer);
        if (timers.resetTimer) clearTimeout(timers.resetTimer);
      }

      // Usuń state
      this.upperBandStates.delete(instanceId);
      this.upperBandTimers.delete(instanceId);

      // ✅ NOWY ZWIĘZŁY LOG
      TradingLogger.logUpperBandReset(instanceId, "Manual reset");
    }
  }

  /**
   * ✅ POPRAWIONA METODA - Aktualizacja stanu górnej bandy TYLKO gdy istnieje pozycja
   */
  updateUpperBandState(
    instanceId,
    currentPrice,
    currentHigh,
    currentLow,
    hurstResult
  ) {
    // ✅ SPRAWDŹ CZY MAMY AKTYWNĄ POZYCJĘ
    const signalService = require("./signal.service");
    const activePosition = signalService.getActivePositions(instanceId);

    // ❌ JEŚLI BRAK POZYCJI - NIE ROBIMY NIC Z GÓRNĄ BANDĄ
    if (!activePosition || activePosition.status !== "active") {
      // Jeśli był aktywny stan, zresetuj go
      if (this.upperBandStates.has(instanceId)) {
        this.resetUpperBandState(instanceId);
        TradingLogger.logUpperBandState(
          instanceId,
          "reset_no_position",
          "No active position - state cleared"
        );
      }
      return;
    }

    // ✅ MAMY POZYCJĘ - KONTYNUUJ NORMALNĄ LOGIKĘ
    if (!this.upperBandStates.has(instanceId)) {
      this.initializeUpperBandState(instanceId);
    }

    const state = this.upperBandStates.get(instanceId);
    const timers = this.upperBandTimers.get(instanceId);
    const now = Date.now();

    const upperBand = hurstResult.upperBand;
    const exitTrigger = upperBand * 1.002; // +0.2%
    const returnTrigger = upperBand * 0.998; // -0.2%
    const exitResetTrigger = upperBand * 0.9975; // -0.25% (było -0.5%)
    const returnResetTrigger = upperBand * 1.0025; // +0.25% (było +0.5%)

    // ✅ LOG PROGRESS CO 2 MINUTY
    if (now - timers.lastLogTime > 120000) {
      // 2 minuty
      this.logStateProgress(instanceId, state, currentPrice, upperBand);
      timers.lastLogTime = now;
    }

    switch (state.currentState) {
      case "waiting_for_exit":
        this.handleWaitingForExit(
          instanceId,
          currentPrice,
          currentHigh,
          exitTrigger,
          upperBand,
          now
        );
        break;

      case "exit_counting":
        this.handleExitCounting(
          instanceId,
          currentPrice,
          currentLow,
          upperBand,
          exitResetTrigger,
          now
        );
        break;

      case "waiting_for_return":
        this.handleWaitingForReturn(
          instanceId,
          currentPrice,
          currentLow,
          returnTrigger,
          upperBand,
          now
        );
        break;

      case "return_counting":
        this.handleReturnCounting(
          instanceId,
          currentPrice,
          currentHigh,
          upperBand,
          returnResetTrigger,
          now
        );
        break;
    }
  }

  /**
   * ✅ Stan: Czekanie na wyjście z kanału
   */
  handleWaitingForExit(
    instanceId,
    currentPrice,
    currentHigh,
    exitTrigger,
    upperBand,
    now
  ) {
    if (currentHigh >= exitTrigger) {
      const state = this.upperBandStates.get(instanceId);
      state.currentState = "exit_counting";
      state.stateStartTime = now;
      state.triggerPrice = currentPrice;
      state.bandLevel = upperBand;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "exit_started",
        `Counting exit (${currentPrice} > ${exitTrigger.toFixed(2)} +0.2%)`
      );
    }
  }

  /**
   * ✅ Stan: Liczenie wyjścia z kanału (15 minut) - USUNIĘTO timeElapsedMinutes
   */
  handleExitCounting(
    instanceId,
    currentPrice,
    currentLow,
    upperBand,
    exitResetTrigger,
    now
  ) {
    const state = this.upperBandStates.get(instanceId);
    const timeElapsed = now - state.stateStartTime;

    // ✅ WARUNEK RESET: -0.5% pod bandą przez 15 minut
    if (currentLow <= exitResetTrigger) {
      if (!state.resetConditionMet) {
        state.resetConditionMet = true;
        state.resetStartTime = now;
        TradingLogger.logUpperBandState(
          instanceId,
          "exit_reset_warning",
          `Price ${currentPrice} < ${exitResetTrigger.toFixed(2)} (-0.5%), reset timer started`
        );
      } else {
        const resetTimeElapsed = now - state.resetStartTime;
        if (resetTimeElapsed >= 15 * 60 * 1000) {
          // 15 minut
          // RESET DO POCZĄTKOWEGO STANU
          state.currentState = "waiting_for_exit";
          state.stateStartTime = null;
          state.resetConditionMet = false;
          TradingLogger.logUpperBandState(
            instanceId,
            "exit_reset",
            "Reset to waiting_for_exit"
          );
          return;
        }
      }
    } else if (state.resetConditionMet && currentLow > upperBand) {
      // Anuluj reset jeśli cena wróci nad bandę
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "exit_reset_cancelled",
        "Price back above band"
      );
    }

    // ✅ SPRAWDŹ CZY MINĘŁO 15 MINUT
    if (timeElapsed >= 15 * 60 * 1000) {
      state.currentState = "waiting_for_return";
      state.stateStartTime = null;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "exit_confirmed",
        `EXIT CONFIRMED after 15 min. Ready for return signal.`
      );
    }
  }

  /**
   * ✅ Stan: Czekanie na powrót do kanału
   */
  handleWaitingForReturn(
    instanceId,
    currentPrice,
    currentLow,
    returnTrigger,
    upperBand,
    now
  ) {
    if (currentLow <= returnTrigger) {
      const state = this.upperBandStates.get(instanceId);
      state.currentState = "return_counting";
      state.stateStartTime = now;
      state.triggerPrice = currentPrice;
      state.bandLevel = upperBand;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "return_started",
        `Counting return (${currentPrice} < ${returnTrigger.toFixed(2)} -0.2%)`
      );
    }
  }

  /**
   * ✅ Stan: Liczenie powrotu do kanału (15 minut)
   */
  handleReturnCounting(
    instanceId,
    currentPrice,
    currentHigh,
    upperBand,
    returnResetTrigger,
    now
  ) {
    const state = this.upperBandStates.get(instanceId);
    const timeElapsed = now - state.stateStartTime;

    // ✅ WARUNEK RESET: +0.5% nad bandą przez 15 minut
    if (currentHigh >= returnResetTrigger) {
      if (!state.resetConditionMet) {
        state.resetConditionMet = true;
        state.resetStartTime = now;
        TradingLogger.logUpperBandState(
          instanceId,
          "return_reset_warning",
          `Price ${currentPrice} > ${returnResetTrigger.toFixed(2)} (+0.5%), reset timer started`
        );
      } else {
        const resetTimeElapsed = now - state.resetStartTime;
        if (resetTimeElapsed >= 15 * 60 * 1000) {
          // 15 minut
          // RESET DO OCZEKIWANIA NA POWRÓT
          state.currentState = "waiting_for_return";
          state.stateStartTime = null;
          state.resetConditionMet = false;
          TradingLogger.logUpperBandState(
            instanceId,
            "return_reset",
            "Reset to waiting_for_return"
          );
          return;
        }
      }
    } else if (state.resetConditionMet && currentHigh < upperBand) {
      // Anuluj reset jeśli cena wróci pod bandę
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "return_reset_cancelled",
        "Price back below band"
      );
    }

    // ✅ SPRAWDŹ CZY MINĘŁO 15 MINUT - ZAMKNIJ POZYCJĘ!
    if (timeElapsed >= 15 * 60 * 1000) {
      // WYGENERUJ SYGNAŁ WYJŚCIA
      this.emit("exitSignal", {
        instanceId,
        type: "upperBandReturn",
        price: currentPrice,
        hurstChannel: { upperBand },
        timestamp: now,
        metadata: {
          exitReason: "Confirmed return to channel after 15 minutes",
          totalCycleTime: "30+ minutes",
          returnTrigger: state.bandLevel * 0.998,
          finalPrice: currentPrice,
        },
      });

      // RESET STANU
      state.currentState = "waiting_for_exit";
      state.stateStartTime = null;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "return_confirmed",
        `POSITION CLOSED - Return confirmed after 15 min`
      );
    }
  }

  /**
   * ✅ NOWA METODA - Logowanie postępu stanu
   */
  logStateProgress(instanceId, state, currentPrice, upperBand) {
    if (!state.stateStartTime) return;

    const timeElapsed = Date.now() - state.stateStartTime;
    const minutesElapsed = Math.floor(timeElapsed / 60000);
    const symbol = this.instances.get(instanceId)?.symbol || "UNKNOWN";

    TradingLogger.logUpperBandProgress(
      instanceId,
      symbol,
      state.currentState,
      minutesElapsed,
      currentPrice,
      upperBand
    );
  }

  /**
   * Konfiguruje nasłuchiwanie zdarzeń z serwisu Binance
   */
  setupListeners() {
    // Nasłuchuj zamknięte świece 15-minutowe
    binanceService.on("klineClosed", (data) => {
      const { candle, instanceId, allCandles } = data;

      if (!this.instances.has(instanceId)) {
        return;
      }

      const config = this.instances.get(instanceId);

      if (candle.interval === "15m") {
        this.updateHurstChannel(instanceId, allCandles);
      } else if (candle.interval === "1h") {
        this.updateEMA(instanceId, allCandles);
      }

      this.lastPrices.set(instanceId, candle.close);
    });

    // Nasłuchuj aktualizacje cen
    binanceService.on("kline", (data) => {
      const { candle, instanceId } = data;
      const currentPrice = candle.close;
      const currentHigh = candle.high;
      const currentLow = candle.low;

      if (!this.lastPrices.has(instanceId)) {
        this.lastPrices.set(instanceId, currentPrice);
        return;
      }

      if (!this.instances.has(instanceId)) {
        return;
      }

      // Aktualizuj kanał Hursta dla zamkniętych świec 15m
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

      // Aktualizuj EMA dla zamkniętych świec 1h
      if (candle.interval === "1h" && candle.isFinal) {
        const config = this.instances.get(instanceId);
        const candles1h = binanceService.getCachedCandles(config.symbol, "1h");
        if (candles1h && candles1h.length > 0) {
          this.updateEMA(instanceId, candles1h);
        }
      }

      this.updateHighestPrice(instanceId, currentHigh);
      this.detectSignals(instanceId, currentPrice, currentHigh, currentLow);
      this.lastPrices.set(instanceId, currentPrice);
    });

    // Obsługa zdarzeń emitowanych bezpośrednio (dla symulatora)
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

      if (!this.instances.has(instanceId)) {
        return;
      }

      if (!this.lastPrices.has(instanceId)) {
        this.lastPrices.set(instanceId, currentPrice);
        return;
      }

      this.updateHighestPrice(instanceId, currentHigh);
      this.detectSignals(instanceId, currentPrice, currentHigh, currentLow);
      this.lastPrices.set(instanceId, currentPrice);
    });
  }

  /**
   * Aktualizuje najwyższą cenę dla instancji (dla trailing stopu) - TYLKO JEŚLI TRAILING STOP WŁĄCZONY
   */
  updateHighestPrice(instanceId, currentHigh) {
    const config = this.instances.get(instanceId);
    const trailingStopEnabled = config?.signals?.enableTrailingStop === true;

    if (
      trailingStopEnabled &&
      this.extremumReached.has(instanceId) &&
      this.extremumReached.get(instanceId)
    ) {
      if (!this.highestPrices.has(instanceId)) {
        this.highestPrices.set(instanceId, currentHigh);
      } else if (currentHigh > this.highestPrices.get(instanceId)) {
        this.highestPrices.set(instanceId, currentHigh);
      }
    }
  }

  /**
   * ✅ POPRAWIONA METODA - Resetuje śledzenie trailing stopu i stanu górnej bandy dla instancji
   */
  resetTrailingStopTracking(instanceId) {
    this.extremumReached.set(instanceId, false);
    this.highestPrices.delete(instanceId);
    this.trailingStopActivationTime.delete(instanceId);

    // ✅ NOWE - Reset stanu górnej bandy
    this.resetUpperBandState(instanceId);

    TradingLogger.logUpperBandReset(instanceId, "Trailing stop reset");
  }

  /**
   * ✅ ZAKTUALIZOWANA METODA - detectSignals bez previousPrice i z poprawioną logiką trailing stop
   */
  detectSignals(instanceId, currentPrice, currentHigh, currentLow) {
    try {
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.hurstResult) {
        return;
      }

      const hurstResult = indicators.hurstResult;
      const emaValue = indicators.emaValue;
      const shortEmaValue = indicators.shortEmaValue;
      const config = this.instances.get(instanceId);

      const currentTrend = this.determineTrend(
        currentPrice,
        emaValue,
        shortEmaValue
      );

      // ✅ 1. NOWA LOGIKA GÓRNEJ BANDY - bez throttling + sprawdzanie pozycji
      this.updateUpperBandState(
        instanceId,
        currentPrice,
        currentHigh,
        currentLow,
        hurstResult
      );

      // ✅ 2. STARA LOGIKA DOLNEJ BANDY - z throttling (zachowane)
      let touchesLowerBand = false;
      if (
        currentLow <= hurstResult.lowerBand &&
        currentHigh >= hurstResult.lowerBand
      ) {
        touchesLowerBand = true;
      }

      if (touchesLowerBand) {
        const signalKey = `${instanceId}-lowerBandTouch`;
        const lastEmission = this.lastSignalEmission.get(signalKey) || 0;
        const now = Date.now();

        if (now - lastEmission > this.signalThrottleTime) {
          let trendConditionMet = true;

          if (config.checkEMATrend && emaValue !== null) {
            trendConditionMet = ["up", "strong_up", "neutral"].includes(
              currentTrend
            );
          }

          if (trendConditionMet) {
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
      }

      // ✅ 3. TRAILING STOP - TYLKO JEŚLI WŁĄCZONY
      const trailingStopEnabled = config?.signals?.enableTrailingStop === true;

      if (trailingStopEnabled) {
        const upperBandBreak = currentHigh >= hurstResult.upperBand;

        if (upperBandBreak && !this.extremumReached.get(instanceId)) {
          this.extremumReached.set(instanceId, true);
          this.highestPrices.set(instanceId, currentHigh);
          this.trailingStopActivationTime.set(instanceId, Date.now());

          logger.debug(
            `Osiągnięto górne ekstremum dla instancji ${instanceId}, aktywowano trailing stop (cena=${currentHigh})`
          );
        }

        if (
          this.extremumReached.get(instanceId) &&
          this.highestPrices.has(instanceId)
        ) {
          const highestPrice = this.highestPrices.get(instanceId);
          const activationTime =
            this.trailingStopActivationTime.get(instanceId) || 0;

          if (currentHigh > highestPrice) {
            this.highestPrices.set(instanceId, currentHigh);
          }

          const trailingStopDelay =
            config?.signals?.trailingStopDelay || 5 * 60 * 1000;
          const timeElapsed = Date.now() - activationTime;

          if (timeElapsed >= trailingStopDelay) {
            let trailingStopPercent = config?.signals?.trailingStop || 0.02;

            if (currentTrend === "strong_up") {
              trailingStopPercent = trailingStopPercent * 1.5;
            } else if (
              currentTrend === "down" ||
              currentTrend === "strong_down"
            ) {
              trailingStopPercent = trailingStopPercent * 0.7;
            }

            const dropFromHigh = (highestPrice - currentPrice) / highestPrice;

            if (dropFromHigh >= trailingStopPercent) {
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

                this.resetTrailingStopTracking(instanceId);
              }
            }
          }
        }
      }
      // ✅ JEŚLI TRAILING STOP WYŁĄCZONY, SYSTEM NIE ROBI NIC ZWIĄZANEGO Z TRACKING
    } catch (error) {
      logger.error(
        `Błąd podczas wykrywania sygnałów dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

  /**
   * Określa aktualny trend na podstawie EMA
   */
  determineTrend(currentPrice, emaValue, shortEmaValue) {
    if (!emaValue || !shortEmaValue) {
      return "neutral";
    }

    const direction =
      shortEmaValue > emaValue
        ? "up"
        : shortEmaValue < emaValue
          ? "down"
          : "neutral";
    const trendStrength = Math.abs((currentPrice - emaValue) / emaValue) * 100;

    if (currentPrice > emaValue && direction === "up") {
      return trendStrength > 1.5 ? "strong_up" : "up";
    } else if (currentPrice < emaValue && direction === "down") {
      return trendStrength > 1.5 ? "strong_down" : "down";
    } else {
      return "neutral";
    }
  }

  /**
   * Inicjalizuje nową instancję analizy
   */
  async initializeInstance(instanceId, config) {
    try {
      if (this.instances.has(instanceId)) {
        logger.warn(`Instancja analizy ${instanceId} już istnieje`);
        return false;
      }

      const intervals = ["15m", "1h"];
      await binanceService.initializeInstanceData(
        config.symbol,
        intervals,
        instanceId
      );

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
      });

      this.instances.set(instanceId, config);
      this.indicators.set(instanceId, { hurstChannel, ema, shortEma });
      this.extremumReached.set(instanceId, false);

      // ✅ INICJALIZACJA NOWEGO STANU GÓRNEJ BANDY - ALE TYLKO JEŚLI MAMY POZYCJĘ
      // (nie robimy tego tutaj automatycznie, zostanie zainicjalizowane przy pierwszym sprawdzeniu pozycji)

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
   * Zatrzymuje analizę dla instancji
   */
  stopInstance(instanceId) {
    try {
      if (!this.instances.has(instanceId)) {
        logger.warn(
          `Próba zatrzymania nieistniejącej instancji analizy: ${instanceId}`
        );
        return false;
      }

      const config = this.instances.get(instanceId);

      const intervals = ["15m", "1h"];
      intervals.forEach((interval) => {
        binanceService.unsubscribeFromKlines(
          config.symbol,
          interval,
          instanceId
        );
      });

      // Wyczyść throttling dla dolnej bandy
      for (const [key, value] of this.lastSignalEmission.entries()) {
        if (
          key.startsWith(`${instanceId}-lowerBandTouch`) ||
          key.startsWith(`${instanceId}-trailingStop`)
        ) {
          this.lastSignalEmission.delete(key);
        }
      }

      // ✅ WYCZYŚĆ NOWY STAN GÓRNEJ BANDY
      this.resetUpperBandState(instanceId);

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

  /**
   * Oblicza początkowe wartości wskaźników
   */
  updateInitialIndicators(instanceId) {
    const config = this.instances.get(instanceId);
    const candles15m = binanceService.getCachedCandles(config.symbol, "15m");
    const candles1h = binanceService.getCachedCandles(config.symbol, "1h");

    if (candles15m && candles15m.length > 0) {
      this.updateHurstChannel(instanceId, candles15m);
    }

    if (candles1h && candles1h.length > 0) {
      this.updateEMA(instanceId, candles1h);
    }
  }

  /**
   * Aktualizuje kanał Hursta dla instancji
   */
  updateHurstChannel(instanceId, candles) {
    try {
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.hurstChannel) {
        return;
      }

      const hurstResult = indicators.hurstChannel.calculate(candles);

      if (hurstResult) {
        indicators.hurstResult = hurstResult;

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
   */
  updateEMA(instanceId, candles) {
    try {
      const indicators = this.indicators.get(instanceId);
      if (!indicators || !indicators.ema || !indicators.shortEma) {
        return;
      }

      const emaValue = indicators.ema.calculate(candles);
      const shortEmaValue = indicators.shortEma.calculate(candles);

      if (emaValue !== null && shortEmaValue !== null) {
        indicators.emaValue = emaValue;
        indicators.shortEmaValue = shortEmaValue;

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
   * Pobiera aktualny stan analizy dla instancji
   */
  getInstanceAnalysisState(instanceId) {
    if (!this.instances.has(instanceId) || !this.indicators.has(instanceId)) {
      return null;
    }

    const config = this.instances.get(instanceId);
    const indicators = this.indicators.get(instanceId);
    const upperBandState = this.upperBandStates.get(instanceId);

    return {
      symbol: config.symbol,
      hurstChannel: indicators.hurstResult || null,
      emaValue: indicators.emaValue || null,
      shortEmaValue: indicators.shortEmaValue || null,
      lastPrice: this.lastPrices.get(instanceId) || null,
      isExtremumReached: this.extremumReached.get(instanceId) || false,
      highestPrice: this.highestPrices.get(instanceId) || null,
      upperBandState: upperBandState || null, // ✅ NOWY STAN
      timestamp: new Date().getTime(),
    };
  }
}

// Eksportuj singleton
const analysisService = new AnalysisService();
module.exports = analysisService;
