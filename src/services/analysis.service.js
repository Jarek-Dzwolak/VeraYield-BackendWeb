const {
  HurstChannel,
  ExponentialMovingAverage,
} = require("../utils/technical");
const binanceService = require("./binance.service");
const upperBandStateManager = require("../utils/upper-band-state-manager");
const downerBandStateManager = require("../utils/downer-band-state-manager");
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

    this.setupListeners();
  }

  async resetUpperBandState(instanceId) {
    return upperBandStateManager.forceCleanAllState(instanceId);
  }

  async resetDownerBandState(instanceId) {
    return downerBandStateManager.forceCleanAllState(instanceId);
  }

  async resetStopLossTracking(instanceId) {
    return mutex.withLock(`stoploss-${instanceId}`, async () => {
      await upperBandStateManager.forceCleanAllState(instanceId);
      await downerBandStateManager.forceCleanAllState(instanceId);
      TradingLogger.logDebugThrottled(
        `stoploss-reset-${instanceId}`,
        `[STOP LOSS] Reset completed | Instance: ${instanceId.slice(-8)}`,
        120000
      );
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
      TradingLogger.logDebugThrottled(
        `kline-received-${instanceId}`,
        `[KLINE RECEIVED] Instance: ${instanceId} | Symbol: ${candle.symbol} | Price: ${candle.close} | High: ${candle.high}`,
        60000
      );
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

      this.detectSignals(instanceId, currentPrice, currentHigh, currentLow);
      this.lastPrices.set(instanceId, currentPrice);
    });
  }

  async detectSignals(instanceId, currentPrice, currentHigh, currentLow) {
    // ✅ MUTEX LOCK dla thread safety
    return mutex.withLock(`detect-signals-${instanceId}`, async () => {
      try {
        TradingLogger.logDebugThrottled(
          `detect-signals-${instanceId}`,
          `[DETECT SIGNALS] Instance: ${instanceId} | Price: ${currentPrice} | High: ${currentHigh} | Low: ${currentLow}`,
          30000
        );

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

        // SPRAWDZENIE SYGNAŁÓW WYJŚCIA (upper band)
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

        // SPRAWDZENIE STOP LOSS (tylko po 3 wejściach)
        const activePosition = getActivePositionFn(instanceId);
        if (
          activePosition &&
          activePosition.entries &&
          activePosition.entries.length === 3
        ) {
          const stopLossSignal = this.checkStopLoss(
            instanceId,
            currentPrice,
            activePosition,
            config
          );
          if (stopLossSignal) {
            this.emit("exitSignal", stopLossSignal);
          }
        }

        // SPRAWDZENIE SYGNAŁÓW WEJŚCIA
        const entrySignal = await downerBandStateManager.updateState(
          instanceId,
          currentPrice,
          currentHigh,
          currentLow,
          hurstResult,
          emaValue,
          shortEmaValue,
          currentTrend,
          config,
          getActivePositionFn
        );

        if (entrySignal) {
          this.emit("entrySignal", entrySignal);
        }
      } catch (error) {
        logger.error(
          `Błąd podczas wykrywania sygnałów dla instancji ${instanceId}: ${error.message}`
        );
      }
    });
  }

  checkStopLoss(instanceId, currentPrice, activePosition, config) {
    // Sprawdź czy stop loss jest włączony
    const stopLossConfig = config?.stopLoss || config?.signals?.stopLoss;
    if (!stopLossConfig || !stopLossConfig.enabled) {
      return null;
    }

    // Oblicz średnią ważoną cenę wejścia
    const avgEntryPrice =
      this.calculateWeightedAverageEntryPrice(activePosition);

    // Sprawdź czy cena spadła o 1.5% od średniej
    const stopLossPrice =
      avgEntryPrice * (1 - (stopLossConfig.percent || 0.015));

    if (currentPrice <= stopLossPrice) {
      TradingLogger.logDebugThrottled(
        `stoploss-trigger-${instanceId}`,
        `[STOP LOSS] Triggered | Price: ${currentPrice} <= Stop: ${stopLossPrice.toFixed(2)} (avg: ${avgEntryPrice.toFixed(2)}) | Instance: ${instanceId.slice(-8)}`,
        60000
      );

      return {
        instanceId,
        type: "stopLoss",
        price: currentPrice,
        hurstChannel: this.indicators.get(instanceId)?.hurstResult,
        timestamp: Date.now(),
        metadata: {
          avgEntryPrice,
          stopLossPrice,
          dropPercent: (
            ((avgEntryPrice - currentPrice) / avgEntryPrice) *
            100
          ).toFixed(2),
          entriesCount: activePosition.entries.length,
        },
      };
    }

    return null;
  }

  calculateWeightedAverageEntryPrice(position) {
    let totalAllocation = 0;
    let weightedSum = 0;

    for (const entry of position.entries) {
      weightedSum += entry.price * entry.allocation;
      totalAllocation += entry.allocation;
    }

    return totalAllocation > 0 ? weightedSum / totalAllocation : 0;
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

      const intervals = ["15m", "1h", "1m"];
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

      const intervals = ["15m", "1h", "1m"];
      intervals.forEach((interval) => {
        binanceService.unsubscribeFromKlines(
          config.symbol,
          interval,
          instanceId
        );
      });

      await upperBandStateManager.forceCleanAllState(instanceId);
      await downerBandStateManager.forceCleanAllState(instanceId);

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
    const downerBandState = downerBandStateManager.getState(instanceId);

    return {
      symbol: config.symbol,
      hurstChannel: indicators.hurstResult || null,
      emaValue: indicators.emaValue || null,
      shortEmaValue: indicators.shortEmaValue || null,
      lastPrice: this.lastPrices.get(instanceId) || null,
      upperBandState: upperBandState || null,
      downerBandState: downerBandState || null,
      timestamp: new Date().getTime(),
    };
  }
}

const analysisService = new AnalysisService();
module.exports = analysisService;
