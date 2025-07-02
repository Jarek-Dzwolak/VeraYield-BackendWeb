const mutex = require("./mutex");
const TradingLogger = require("./trading-logger");
const logger = require("./logger");

class UpperBandStateManager {
  constructor() {
    this.upperBandStates = new Map();
    this.upperBandTimers = new Map();
    this.lastActivityTimestamp = new Map();
  }

  async forceCleanAllState(instanceId) {
    return mutex.withLock(`cleanup-${instanceId}`, async () => {
      try {
        const timers = this.upperBandTimers.get(instanceId);
        if (timers) {
          if (timers.stateTimer) clearTimeout(timers.stateTimer);
          if (timers.resetTimer) clearTimeout(timers.resetTimer);
        }

        this.upperBandStates.delete(instanceId);
        this.upperBandTimers.delete(instanceId);
        this.lastActivityTimestamp.delete(instanceId);

        TradingLogger.logUpperBandReset(instanceId, "Force cleanup");
      } catch (error) {
        logger.error(`Error in forceCleanAllState: ${error.message}`);
      }
    });
  }

  async initializeState(instanceId) {
    return mutex.withLock(`init-${instanceId}`, async () => {
      try {
        await this.forceCleanAllState(instanceId);

        this.upperBandStates.set(instanceId, {
          currentState: "waiting_for_exit",
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

        this.lastActivityTimestamp.set(instanceId, Date.now());

        TradingLogger.logUpperBandState(
          instanceId,
          "initialized",
          "waiting_for_exit"
        );
      } catch (error) {
        logger.error(`Error in initializeState: ${error.message}`);
      }
    });
  }

  // ✅ NOWA METODA: Pobierz 1m CLOSE cenę
  async _get1MinutePrice(instanceId) {
    try {
      const binanceService = require("../services/binance.service");
      const analysisService = require("../services/analysis.service");

      // Pobierz konfigurację instancji
      const instances = analysisService.instances;
      const config = instances?.get(instanceId);

      if (!config?.symbol) {
        return null; // Fallback do 15m danych
      }

      const candles1m = binanceService.getCachedCandles(config.symbol, "1m");

      if (!candles1m || candles1m.length === 0) {
        return null; // Fallback do 15m danych
      }

      // Ostatnia zamknięta 1m świeca
      const lastCandle = candles1m[candles1m.length - 1];
      return lastCandle.close;
    } catch (error) {
      logger.error(
        `Error getting 1m price for ${instanceId}: ${error.message}`
      );
      return null; // Fallback do 15m danych
    }
  }

  async updateState(
    instanceId,
    currentPrice,
    currentHigh,
    currentLow,
    hurstResult,
    getActivePositionFn
  ) {
    return mutex.withLock(`update-${instanceId}`, async () => {
      try {
        this.lastActivityTimestamp.set(instanceId, Date.now());

        const activePosition = getActivePositionFn(instanceId);

        if (!activePosition || activePosition.status !== "active") {
          if (this.upperBandStates.has(instanceId)) {
            await this.forceCleanAllState(instanceId);
            TradingLogger.logUpperBandState(
              instanceId,
              "reset_no_position",
              "No active position - state cleared"
            );
          }
          return null;
        }

        if (!this.upperBandStates.has(instanceId)) {
          await this.initializeState(instanceId);
        }

        const state = this.upperBandStates.get(instanceId);
        const timers = this.upperBandTimers.get(instanceId);
        const now = Date.now();

        const upperBand = hurstResult.upperBand;
        const exitTrigger = upperBand * 1.0009;
        const returnTrigger = upperBand * 0.999;
        const exitResetTrigger = upperBand * 0.999;
        const returnResetTrigger = upperBand * 1.0009;

        // ✅ NOWE: Pobierz 1m cenę do decyzji
        const oneMinPrice = await this._get1MinutePrice(instanceId);
        const priceForDecisions = oneMinPrice || currentPrice; // Fallback na 15m

        // Log info o źródle danych
        if (oneMinPrice) {
          TradingLogger.logDebugThrottled(
            `1m-price-${instanceId}`,
            `[1M PRICE] Using 1m CLOSE: ${oneMinPrice} vs 15m: ${currentPrice}`,
            300000 // co 5 minut
          );
        }

        if (now - timers.lastLogTime > 120000) {
          this.logStateProgress(
            instanceId,
            state,
            priceForDecisions,
            upperBand
          );
          timers.lastLogTime = now;
        }

        switch (state.currentState) {
          case "waiting_for_exit":
            return this.handleWaitingForExit(
              instanceId,
              priceForDecisions,
              exitTrigger,
              upperBand,
              now
            );

          case "exit_counting":
            return this.handleExitCounting(
              instanceId,
              priceForDecisions,
              upperBand,
              exitResetTrigger,
              now
            );

          case "waiting_for_return":
            return this.handleWaitingForReturn(
              instanceId,
              priceForDecisions,
              returnTrigger,
              upperBand,
              now
            );

          case "return_counting":
            return this.handleReturnCounting(
              instanceId,
              priceForDecisions,
              upperBand,
              returnResetTrigger,
              now
            );
        }
        return null;
      } catch (error) {
        logger.error(`Error in updateState: ${error.message}`);
        await this.forceCleanAllState(instanceId);
        return null;
      }
    });
  }

  // ✅ ZMIENIONE: Używa 1m CLOSE zamiast 15m HIGH
  handleWaitingForExit(
    instanceId,
    priceForDecisions,
    exitTrigger,
    upperBand,
    now
  ) {
    if (priceForDecisions >= exitTrigger) {
      // ← 1m CLOSE zamiast currentHigh
      const state = this.upperBandStates.get(instanceId);
      state.currentState = "exit_counting";
      state.stateStartTime = now;
      state.triggerPrice = priceForDecisions;
      state.bandLevel = upperBand;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "exit_started",
        `1m CLOSE ${priceForDecisions} >= trigger ${exitTrigger.toFixed(2)}`
      );
    }
    return null;
  }

  // ✅ ZMIENIONE: Używa 1m CLOSE zamiast 15m LOW
  handleExitCounting(
    instanceId,
    priceForDecisions,
    upperBand,
    exitResetTrigger,
    now
  ) {
    const state = this.upperBandStates.get(instanceId);
    const timeElapsed = now - state.stateStartTime;

    if (priceForDecisions <= exitResetTrigger) {
      // ← 1m CLOSE zamiast currentLow
      if (!state.resetConditionMet) {
        state.resetConditionMet = true;
        state.resetStartTime = now;
        TradingLogger.logUpperBandState(
          instanceId,
          "exit_reset_warning",
          `1m CLOSE ${priceForDecisions} <= reset ${exitResetTrigger.toFixed(2)} (-0.2%), reset timer started`
        );
      } else {
        const resetTimeElapsed = now - state.resetStartTime;
        if (resetTimeElapsed >= 7.5 * 60 * 1000) {
          state.currentState = "waiting_for_exit";
          state.stateStartTime = null;
          state.resetConditionMet = false;
          TradingLogger.logUpperBandState(
            instanceId,
            "exit_reset",
            "Reset to waiting_for_exit"
          );
          return null;
        }
      }
    } else if (state.resetConditionMet && priceForDecisions > upperBand) {
      // ← 1m CLOSE
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "exit_reset_cancelled",
        "1m CLOSE back above band"
      );
    }

    if (timeElapsed >= 7.5 * 60 * 1000) {
      state.currentState = "waiting_for_return";
      state.stateStartTime = null;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "exit_confirmed",
        `EXIT CONFIRMED after 15 min. Ready for return signal.`
      );
    }
    return null;
  }

  // ✅ ZMIENIONE: Używa 1m CLOSE zamiast 15m LOW
  handleWaitingForReturn(
    instanceId,
    priceForDecisions,
    returnTrigger,
    upperBand,
    now
  ) {
    if (priceForDecisions <= returnTrigger) {
      // ← 1m CLOSE zamiast currentLow
      const state = this.upperBandStates.get(instanceId);
      state.currentState = "return_counting";
      state.stateStartTime = now;
      state.triggerPrice = priceForDecisions;
      state.bandLevel = upperBand;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "return_started",
        `1m CLOSE ${priceForDecisions} <= trigger ${returnTrigger.toFixed(2)} (-0.1%)`
      );
    }
    return null;
  }

  // ✅ ZMIENIONE: Używa 1m CLOSE zamiast 15m HIGH
  handleReturnCounting(
    instanceId,
    priceForDecisions,
    upperBand,
    returnResetTrigger,
    now
  ) {
    const state = this.upperBandStates.get(instanceId);
    const timeElapsed = now - state.stateStartTime;

    if (priceForDecisions >= returnResetTrigger) {
      // ← 1m CLOSE zamiast currentHigh
      if (!state.resetConditionMet) {
        state.resetConditionMet = true;
        state.resetStartTime = now;
        TradingLogger.logUpperBandState(
          instanceId,
          "return_reset_warning",
          `1m CLOSE ${priceForDecisions} >= reset ${returnResetTrigger.toFixed(2)} (+0.2%), reset timer started`
        );
      } else {
        const resetTimeElapsed = now - state.resetStartTime;
        if (resetTimeElapsed >= 7.5 * 60 * 1000) {
          state.currentState = "waiting_for_return";
          state.stateStartTime = null;
          state.resetConditionMet = false;
          TradingLogger.logUpperBandState(
            instanceId,
            "return_reset",
            "Reset to waiting_for_return"
          );
          return null;
        }
      }
    } else if (state.resetConditionMet && priceForDecisions < upperBand) {
      // ← 1m CLOSE
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "return_reset_cancelled",
        "1m CLOSE back below band"
      );
    }

    if (timeElapsed >= 7.5 * 60 * 1000) {
      const exitSignal = {
        instanceId,
        type: "upperBandReturn",
        price: priceForDecisions, // ← 1m CLOSE
        hurstChannel: { upperBand },
        timestamp: now,
        metadata: {
          exitReason: "Confirmed return to channel after 15 minutes",
          totalCycleTime: "30+ minutes",
          returnTrigger: state.bandLevel * 0.999,
          finalPrice: priceForDecisions, // ← 1m CLOSE
          priceSource: "1m_close", // ← Info o źródle
        },
      };

      state.currentState = "waiting_for_exit";
      state.stateStartTime = null;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "return_confirmed",
        `POSITION CLOSED - Return confirmed after 15 min (1m CLOSE: ${priceForDecisions})`
      );

      return exitSignal;
    }
    return null;
  }

  logStateProgress(instanceId, state, currentPrice, upperBand) {
    if (!state.stateStartTime) return;

    const timeElapsed = Date.now() - state.stateStartTime;
    const minutesElapsed = Math.floor(timeElapsed / 60000);
    const symbol = "BTCUSDT";

    TradingLogger.logUpperBandProgress(
      instanceId,
      symbol,
      state.currentState,
      minutesElapsed,
      currentPrice,
      upperBand
    );
  }

  getState(instanceId) {
    return this.upperBandStates.get(instanceId) || null;
  }

  hasActiveState(instanceId) {
    return this.upperBandStates.has(instanceId);
  }
}

const upperBandStateManager = new UpperBandStateManager();
module.exports = upperBandStateManager;
