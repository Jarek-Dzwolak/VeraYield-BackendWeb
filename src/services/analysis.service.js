const {
  HurstChannel,
  ExponentialMovingAverage,
} = require("../utils/technical");
const binanceService = require("./binance.service");
const upperBandStateManager = require("../utils/upper-band-state-manager");
const mutex = require("../utils/mutex");
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
    this.extremumReached = new Map();
    this.trailingStopActivationTime = new Map();

    this.lastSignalEmission = new Map();
    this.signalThrottleTime = 30000;

    this.setupListeners();
  }

  async resetUpperBandState(instanceId) {
    return upperBandStateManager.forceCleanAllState(instanceId);
  }

  async resetTrailingStopTracking(instanceId) {
    return mutex.withLock(`trailing-${instanceId}`, async () => {
      this.extremumReached.set(instanceId, false);
      this.highestPrices.delete(instanceId);
      this.trailingStopActivationTime.delete(instanceId);

      await upperBandStateManager.forceCleanAllState(instanceId);
      TradingLogger.logUpperBandReset(instanceId, "Trailing stop reset");
    });
  }

  setupListeners() {
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

  async detectSignals(instanceId, currentPrice, currentHigh, currentLow) {
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

      const getActivePositionFn = (id) => {
        if (!this._injectedSignalService) return null;
        return this._injectedSignalService.getActivePositions(id);
      };

      const exitSignal = await upperBandStateManager.updateState(
        instanceId,
        currentPrice,
        currentHigh,
        currentLow,
        hurstResult,
        getActivePositionFn
      );

      if (exitSignal) {
        this.emit("exitSignal", exitSignal);
      }

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

                await this.resetTrailingStopTracking(instanceId);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(
        `Błąd podczas wykrywania sygnałów dla instancji ${instanceId}: ${error.message}`
      );
    }
  }

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

  setSignalService(signalService) {
    this._injectedSignalService = signalService;
  }

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

  async stopInstance(instanceId) {
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

      for (const [key, value] of this.lastSignalEmission.entries()) {
        if (
          key.startsWith(`${instanceId}-lowerBandTouch`) ||
          key.startsWith(`${instanceId}-trailingStop`)
        ) {
          this.lastSignalEmission.delete(key);
        }
      }

      await upperBandStateManager.forceCleanAllState(instanceId);

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

  stopAllInstances() {
    const instanceIds = [...this.instances.keys()];
    for (const instanceId of instanceIds) {
      this.stopInstance(instanceId);
    }
    logger.info("Zatrzymano wszystkie instancje analizy");
  }

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

  getInstanceAnalysisState(instanceId) {
    if (!this.instances.has(instanceId) || !this.indicators.has(instanceId)) {
      return null;
    }

    const config = this.instances.get(instanceId);
    const indicators = this.indicators.get(instanceId);
    const upperBandState = upperBandStateManager.getState(instanceId);

    return {
      symbol: config.symbol,
      hurstChannel: indicators.hurstResult || null,
      emaValue: indicators.emaValue || null,
      shortEmaValue: indicators.shortEmaValue || null,
      lastPrice: this.lastPrices.get(instanceId) || null,
      isExtremumReached: this.extremumReached.get(instanceId) || false,
      highestPrice: this.highestPrices.get(instanceId) || null,
      upperBandState: upperBandState || null,
      timestamp: new Date().getTime(),
    };
  }
}

const analysisService = new AnalysisService();
module.exports = analysisService;
