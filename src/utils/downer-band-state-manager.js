const mutex = require("./mutex");
const TradingLogger = require("./trading-logger");
const logger = require("./logger");

class DownerBandStateManager {
  constructor() {
    this.downerBandStates = new Map();
    this.lastEntryTimes = new Map();
    this.lastSignalEmission = new Map();
    this.signalThrottleTime = 30000; // 30 sekund między sygnałami
  }

  async forceCleanAllState(instanceId) {
    return mutex.withLock(`cleanup-entry-${instanceId}`, async () => {
      try {
        this.downerBandStates.delete(instanceId);
        this.lastEntryTimes.delete(instanceId);
        this.lastSignalEmission.delete(instanceId);

        TradingLogger.logDebugThrottled(
          `entry-state-reset-${instanceId}`,
          `[ENTRY STATE] Force cleanup completed | Instance: ${instanceId.slice(-8)}`,
          120000
        );
      } catch (error) {
        logger.error(`Error in forceCleanAllState (entry): ${error.message}`);
      }
    });
  }

  async initializeState(instanceId) {
    return mutex.withLock(`init-entry-${instanceId}`, async () => {
      try {
        await this.forceCleanAllState(instanceId);

        this.downerBandStates.set(instanceId, {
          currentState: "waiting_for_entry",
          lastCheckTime: null,
        });

        TradingLogger.logDebugThrottled(
          `entry-state-init-${instanceId}`,
          `[ENTRY STATE] Initialized waiting_for_entry | Instance: ${instanceId.slice(-8)}`,
          300000
        );
      } catch (error) {
        logger.error(`Error in initializeState (entry): ${error.message}`);
      }
    });
  }

  //  _get1MinutePrice
  async _get1MinutePrice(instanceId) {
    const MAX_WAIT_TIME = 30000; // 30 sekund max
    const RETRY_INTERVAL = 2000; // Co 2 sekundy
    const startTime = Date.now();

    try {
      const binanceService = require("../services/binance.service");
      const analysisService = require("../services/analysis.service");

      const instances = analysisService.instances;
      const config = instances?.get(instanceId);

      if (!config?.symbol) {
        logger.warn(`[1M PRICE] No config for instance ${instanceId}`);
        return null;
      }

      // Pętla czekania na świeże dane
      while (Date.now() - startTime < MAX_WAIT_TIME) {
        // Sprawdź cache
        const candles1m = binanceService.getCachedCandles(config.symbol, "1m");

        if (candles1m && candles1m.length > 0) {
          const lastCandle = candles1m[candles1m.length - 1];
          const age = Date.now() - lastCandle.openTime;

          // Akceptuj świece do 90 sekund
          if (age <= 90000) {
            logger.debug(
              `[1M PRICE] Using ${lastCandle.isFinal ? "final" : "live"} candle, age: ${age / 1000}s`
            );
            return lastCandle.close;
          } else {
            logger.warn(
              `[1M PRICE] Data too old: ${age / 1000}s, waiting for fresh data...`
            );
          }
        } else {
          logger.warn(`[1M PRICE] No 1m candles in cache`);
        }

        // Sprawdź czy WebSocket działa
        if (
          !binanceService.isWebSocketConnected(config.symbol, "1m", instanceId)
        ) {
          logger.error(
            `[1M PRICE] WebSocket not connected, forcing reconnect...`
          );
          await binanceService.forceReconnect(config.symbol, "1m", instanceId);
        }

        // Poczekaj przed następną próbą
        logger.info(
          `[1M PRICE] Waiting ${RETRY_INTERVAL / 1000}s for fresh data...`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
      }

      // Po 30 sekundach - alert ale nie rezygnuj
      logger.error(
        `[1M PRICE] CRITICAL: Could not get fresh 1m data after ${MAX_WAIT_TIME / 1000}s!`
      );
      logger.error(
        `[1M PRICE] Instance ${instanceId} may have connection issues`
      );

      // Spróbuj pobrać jedną świecę przez REST API jako last resort
      try {
        logger.info(
          `[1M PRICE] Attempting to fetch fresh candle via REST API...`
        );
        await binanceService.getHistoricalCandles(config.symbol, "1m", 1);

        const freshCandles = binanceService.getCachedCandles(
          config.symbol,
          "1m"
        );
        if (freshCandles && freshCandles.length > 0) {
          const lastCandle = freshCandles[freshCandles.length - 1];
          logger.info(`[1M PRICE] Got fresh candle from REST API`);
          return lastCandle.close;
        }
      } catch (apiError) {
        logger.error(`[1M PRICE] REST API failed: ${apiError.message}`);
      }

      // Zwróć undefined - to spowoduje pominięcie tej iteracji
      return undefined;
    } catch (error) {
      logger.error(`[1M PRICE] Error: ${error.message}`);
      return undefined;
    }
  }

  async updateState(
    instanceId,
    currentPrice,
    currentHigh,
    currentLow,
    hurstResult,
    emaValue,
    shortEmaValue,
    trend,
    config,
    getActivePositionFn
  ) {
    return mutex.withLock(`update-entry-${instanceId}`, async () => {
      try {
        const activePosition = getActivePositionFn(instanceId);

        // Jeśli już mamy aktywną pozycję, sprawdź czy można dodać kolejne wejście
        if (activePosition && activePosition.status === "active") {
          return this.handleMultipleEntries(
            instanceId,
            currentPrice,
            currentHigh,
            currentLow,
            hurstResult,
            emaValue,
            shortEmaValue,
            trend,
            config,
            activePosition
          );
        }

        // Inicjalizuj stan jeśli nie istnieje
        if (!this.downerBandStates.has(instanceId)) {
          await this.initializeState(instanceId);
        }

        const state = this.downerBandStates.get(instanceId);
        const now = Date.now();

        // ✅ GŁÓWNA LOGIKA - sprawdź warunki dla pierwszego wejścia
        return this.handleFirstEntry(
          instanceId,
          currentPrice,
          currentHigh,
          currentLow,
          hurstResult,
          emaValue,
          shortEmaValue,
          trend,
          config,
          now
        );
      } catch (error) {
        logger.error(`Error in updateState (entry): ${error.message}`);
        return null;
      }
    });
  }

  async handleFirstEntry(
    instanceId,
    currentPrice,
    currentHigh,
    currentLow,
    hurstResult,
    emaValue,
    shortEmaValue,
    trend,
    config,
    now
  ) {
    // ✅ NOWE: Pobierz 1m cenę do decyzji (jak w UpperBandStateManager)
    const oneMinPrice = await this._get1MinutePrice(instanceId);
    const priceForDecisions = oneMinPrice || currentPrice; // Fallback na 15m

    // Log info o źródle danych
    if (oneMinPrice) {
      TradingLogger.logDebugThrottled(
        `1m-entry-price-${instanceId}`,
        `[1M ENTRY] Using 1m CLOSE: ${oneMinPrice} vs 15m: ${currentPrice} | Instance: ${instanceId.slice(-8)}`,
        300000 // co 5 minut
      );
    }

    // ✅ NOWA LOGIKA: TYLKO 1M CLOSE <= lowerBand (identycznie jak UpperBandStateManager)
    const touchesLowerBand = priceForDecisions <= hurstResult.lowerBand;

    if (touchesLowerBand) {
      // ✅ THROTTLING - nie częściej niż co 30s
      const signalKey = `${instanceId}-lowerBandTouch`;
      const lastEmission = this.lastSignalEmission.get(signalKey) || 0;

      if (now - lastEmission > this.signalThrottleTime) {
        // ✅ SPRAWDZENIE TRENDU EMA
        let trendConditionMet = true;
        if (config.checkEMATrend && emaValue !== null) {
          trendConditionMet = ["up", "strong_up", "neutral"].includes(trend);
        }

        if (trendConditionMet) {
          // ✅ GENEROWANIE SYGNAŁU WEJŚCIA
          const entrySignal = {
            instanceId,
            type: "lowerBandTouch",
            price: priceForDecisions, // ← 1M CLOSE
            hurstChannel: hurstResult,
            emaValue,
            shortEmaValue,
            trend,
            timestamp: now,
            metadata: {
              priceSource: oneMinPrice ? "1m_close" : "15m_fallback",
              lowerBand: hurstResult.lowerBand,
              priceVsBand: (
                (priceForDecisions / hurstResult.lowerBand - 1) *
                100
              ).toFixed(3),
              entryLogic: "pure_1m_close", // ← Nowa informacja
            },
          };

          this.lastSignalEmission.set(signalKey, now);

          TradingLogger.logDebugThrottled(
            `signal-${instanceId}-entry`,
            `[ENTRY SIGNAL] ${config.symbol} | 1m CLOSE: ${priceForDecisions} <= band: ${hurstResult.lowerBand.toFixed(2)} | Trend: ${trend} | Instance: ${instanceId.slice(-8)}`,
            60000
          );

          return entrySignal;
        } else {
          // ✅ LOG ODRZUCENIA przez trend
          TradingLogger.logDebugThrottled(
            `entry-trend-reject-${instanceId}`,
            `[ENTRY REJECTED] Bad trend: ${trend} (1m CLOSE: ${priceForDecisions} <= band: ${hurstResult.lowerBand.toFixed(2)}) | Instance: ${instanceId.slice(-8)}`,
            120000
          );
        }
      } else {
        // ✅ LOG THROTTLING
        const timeSinceLastSignal = Math.floor((now - lastEmission) / 1000);
        TradingLogger.logDebugThrottled(
          `entry-throttle-${instanceId}`,
          `[ENTRY THROTTLED] 1m CLOSE: ${priceForDecisions} <= band, but last signal ${timeSinceLastSignal}s ago | Instance: ${instanceId.slice(-8)}`,
          60000
        );
      }
    }

    return null;
  }

  async handleMultipleEntries(
    instanceId,
    currentPrice,
    currentHigh,
    currentLow,
    hurstResult,
    emaValue,
    shortEmaValue,
    trend,
    config,
    activePosition
  ) {
    const now = Date.now();
    const entryCount = activePosition.entries.length;

    // ✅ SPRAWDŹ MAKSYMALNĄ LICZBĘ WEJŚĆ
    if (entryCount >= 3) {
      return null; // Maksymalnie 3 wejścia
    }

    // ✅ SPRAWDŹ MINIMALNY ODSTĘP CZASOWY
    const lastEntryTime = this.lastEntryTimes.get(instanceId) || 0;
    const minEntryTimeGap = config.signals?.minEntryTimeGap || 7200000; // 2h default

    if (now - lastEntryTime < minEntryTimeGap) {
      const minutesSinceLastEntry = Math.floor((now - lastEntryTime) / 60000);
      const minutesRequired = Math.floor(minEntryTimeGap / 60000);

      TradingLogger.logDebugThrottled(
        `entry-timegap-${instanceId}`,
        `[ENTRY BLOCKED] Time gap: ${minutesSinceLastEntry}min < ${minutesRequired}min required | Instance: ${instanceId.slice(-8)}`,
        300000
      );
      return null;
    }

    // ✅ SPRAWDŹ WARUNKI TECHNICZNE - NOWA LOGIKA (tylko 1M CLOSE)
    const oneMinPrice = await this._get1MinutePrice(instanceId);
    const priceForDecisions = oneMinPrice || currentPrice;

    // ✅ NOWA LOGIKA: TYLKO 1M CLOSE <= lowerBand
    const touchesLowerBand = priceForDecisions <= hurstResult.lowerBand;

    if (touchesLowerBand) {
      // ✅ SPRAWDŹ TREND dla dodatkowego wejścia
      let trendConditionMet = true;
      if (config.checkEMATrend && emaValue !== null) {
        trendConditionMet = ["up", "strong_up", "neutral"].includes(trend);
      }

      if (trendConditionMet) {
        const entryType = entryCount === 1 ? "second" : "third";

        const entrySignal = {
          instanceId,
          type: "lowerBandTouch",
          subType: entryType,
          price: priceForDecisions, // ← 1M CLOSE
          hurstChannel: hurstResult,
          emaValue,
          shortEmaValue,
          trend,
          timestamp: now,
          metadata: {
            priceSource: oneMinPrice ? "1m_close" : "15m_fallback",
            entryNumber: entryCount + 1,
            lowerBand: hurstResult.lowerBand,
            priceVsBand: (
              (priceForDecisions / hurstResult.lowerBand - 1) *
              100
            ).toFixed(3),
            entryLogic: "pure_1m_close", // ← Nowa informacja
          },
        };

        // ✅ AKTUALIZUJ CZAS OSTATNIEGO WEJŚCIA
        this.lastEntryTimes.set(instanceId, now);

        TradingLogger.logDebugThrottled(
          `signal-${instanceId}-${entryType}`,
          `[${entryType.toUpperCase()} ENTRY] ${config.symbol} | 1m CLOSE: ${priceForDecisions} <= band: ${hurstResult.lowerBand.toFixed(2)} | Instance: ${instanceId.slice(-8)}`,
          60000
        );

        return entrySignal;
      } else {
        // ✅ LOG ODRZUCENIA przez trend dla multiple entries
        TradingLogger.logDebugThrottled(
          `entry-trend-reject-multiple-${instanceId}`,
          `[MULTIPLE ENTRY REJECTED] Bad trend: ${trend} (1m CLOSE: ${priceForDecisions} <= band: ${hurstResult.lowerBand.toFixed(2)}) | Instance: ${instanceId.slice(-8)}`,
          120000
        );
      }
    }

    return null;
  }

  // ✅ CALLBACK do aktualizacji czasu ostatniego wejścia z signalService
  updateLastEntryTime(instanceId, timestamp) {
    this.lastEntryTimes.set(instanceId, timestamp);
  }

  getState(instanceId) {
    return this.downerBandStates.get(instanceId) || null;
  }

  hasActiveState(instanceId) {
    return this.downerBandStates.has(instanceId);
  }
}

const downerBandStateManager = new DownerBandStateManager();
module.exports = downerBandStateManager;
