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
        const exitTrigger = upperBand * 1.001;
        const returnTrigger = upperBand * 0.999;
        const exitResetTrigger = upperBand * 0.998;
        const returnResetTrigger = upperBand * 1.002;

        if (now - timers.lastLogTime > 120000) {
          this.logStateProgress(instanceId, state, currentPrice, upperBand);
          timers.lastLogTime = now;
        }

        switch (state.currentState) {
          case "waiting_for_exit":
            return this.handleWaitingForExit(
              instanceId,
              currentPrice,
              currentHigh,
              exitTrigger,
              upperBand,
              now
            );

          case "exit_counting":
            return this.handleExitCounting(
              instanceId,
              currentPrice,
              currentLow,
              upperBand,
              exitResetTrigger,
              now
            );

          case "waiting_for_return":
            return this.handleWaitingForReturn(
              instanceId,
              currentPrice,
              currentLow,
              returnTrigger,
              upperBand,
              now
            );

          case "return_counting":
            return this.handleReturnCounting(
              instanceId,
              currentPrice,
              currentHigh,
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
    return null;
  }

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
    } else if (state.resetConditionMet && currentLow > upperBand) {
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "exit_reset_cancelled",
        "Price back above band"
      );
    }

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
    return null;
  }

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
    return null;
  }

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
    } else if (state.resetConditionMet && currentHigh < upperBand) {
      state.resetConditionMet = false;
      TradingLogger.logUpperBandState(
        instanceId,
        "return_reset_cancelled",
        "Price back below band"
      );
    }

    if (timeElapsed >= 15 * 60 * 1000) {
      const exitSignal = {
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
      };

      state.currentState = "waiting_for_exit";
      state.stateStartTime = null;
      state.resetConditionMet = false;

      TradingLogger.logUpperBandState(
        instanceId,
        "return_confirmed",
        `POSITION CLOSED - Return confirmed after 15 min`
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
