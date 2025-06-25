/**
 * Trading Logger - dedykowane funkcje logowania dla operacji tradingowych
 * ✅ ZAKTUALIZOWANE O LOGI PHEMEX
 */

const logger = require("./logger");

class TradingLogger {
  /**
   * Loguje wejście w pozycję (tylko gdy rzeczywiście następuje)
   */
  static logEntry(
    instanceId,
    symbol,
    price,
    type,
    trend,
    allocation,
    amount,
    contractQuantity
  ) {
    logger.info(
      `[ENTRY] ${symbol} @${price} | ${type} | Trend: ${trend} | ${(allocation * 100).toFixed(1)}% (${amount} USDT) | Contract: ${contractQuantity} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * Loguje wyjście z pozycji
   */
  static logExit(
    instanceId,
    symbol,
    price,
    type,
    profitPercent,
    profit,
    duration
  ) {
    const profitSign = profit >= 0 ? "+" : "";
    const durationStr = duration ? this.formatDuration(duration) : "Unknown";
    logger.info(
      `[EXIT] ${symbol} @${price} | ${type} | Profit: ${profitSign}${profitPercent.toFixed(2)}% (${profitSign}${profit.toFixed(2)} USDT) | Duration: ${durationStr} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ NOWE LOGI - Stan górnej bandy
   */
  static logUpperBandState(instanceId, action, details = "") {
    const actionEmojis = {
      initialized: "🔧",
      exit_started: "🚀",
      exit_confirmed: "✅",
      exit_reset: "🔄",
      exit_reset_warning: "⚠️",
      exit_reset_cancelled: "❌",
      return_started: "🔽",
      return_confirmed: "🎯",
      return_reset: "🔄",
      return_reset_warning: "⚠️",
      return_reset_cancelled: "❌",
    };

    const emoji = actionEmojis[action] || "📊";

    logger.info(
      `[UPPER BAND] ${emoji} ${action.toUpperCase()} | ${details} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ NOWE LOGI - Postęp czasowy górnej bandy
   */
  static logUpperBandProgress(
    instanceId,
    symbol,
    state,
    minutesElapsed,
    currentPrice,
    upperBand
  ) {
    const stateNames = {
      exit_counting: "EXIT COUNTING",
      return_counting: "RETURN COUNTING",
    };

    const stateName = stateNames[state] || state.toUpperCase();
    const priceVsBand = ((currentPrice / upperBand - 1) * 100).toFixed(2);
    const priceDirection = priceVsBand >= 0 ? "+" : "";

    logger.info(
      `[UPPER BAND] 📊 ${stateName} | ${symbol} | ${minutesElapsed}/15 min | Price: ${currentPrice} (${priceDirection}${priceVsBand}%) | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * Loguje odrzucenie sygnału (tylko raz na instancję)
   */
  static logSignalRejected(instanceId, symbol, reason, lastLogTime = null) {
    const now = Date.now();
    // Loguj tylko raz na 5 minut dla tej samej instancji i powodu
    if (!lastLogTime || now - lastLogTime > 5 * 60 * 1000) {
      logger.warn(
        `[REJECTED] ${symbol} | ${reason} | Instance: ${instanceId.slice(-8)}`
      );
      return now;
    }
    return lastLogTime;
  }

  /**
   * Loguje debug z throttling - max raz na minutę na typ
   */
  static logDebugThrottled(key, message, throttleMs = 60000) {
    if (!this.debugThrottle) {
      this.debugThrottle = new Map();
    }

    const now = Date.now();
    const lastLog = this.debugThrottle.get(key) || 0;

    if (now - lastLog > throttleMs) {
      logger.debug(message);
      this.debugThrottle.set(key, now);
      return true;
    }
    return false;
  }

  /**
   * Loguje błędy związane z tradingiem
   */
  static logTradingError(instanceId, symbol, error, context = "") {
    logger.error(
      `[TRADING ERROR] ${symbol} | ${error} ${context ? "| " + context : ""} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ PHEMEX - Loguje błędy API Phemex
   */
  static logPhemexError(instanceId, symbol, operation, error) {
    logger.error(
      `[PHEMEX ERROR] ${symbol} | ${operation} failed: ${error} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ PHEMEX - Loguje sukces operacji Phemex (tylko najważniejsze)
   */
  static logPhemexSuccess(instanceId, symbol, operation, details = "") {
    logger.info(
      `[PHEMEX] ${symbol} | ${operation} successful ${details ? "| " + details : ""} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ❌ DEPRECATED - Loguje błędy API ByBit (zachowane dla kompatybilności)
   */
  static logBybitError(instanceId, symbol, operation, error) {
    logger.error(
      `[BYBIT ERROR] ${symbol} | ${operation} failed: ${error} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ❌ DEPRECATED - Loguje sukces operacji ByBit (zachowane dla kompatybilności)
   */
  static logBybitSuccess(instanceId, symbol, operation, details = "") {
    logger.info(
      `[BYBIT] ${symbol} | ${operation} successful ${details ? "| " + details : ""} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * Loguje synchronizację salda
   */
  static logBalanceSync(instanceId, oldBalance, newBalance) {
    logger.info(
      `[BALANCE] ${oldBalance} → ${newBalance} USDT | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * Formatuje czas trwania
   */
  static formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}min`;
    } else {
      return `${minutes}min`;
    }
  }

  /**
   * Loguje zmianę stanu instancji
   */
  static logInstanceState(instanceId, action, details = "") {
    logger.info(
      `[INSTANCE] ${action} | Instance: ${instanceId.slice(-8)} ${details ? "| " + details : ""}`
    );
  }

  /**
   * Loguje konfigurację bez wrażliwych danych
   */
  static logConfig(instanceId, action, config) {
    const safeConfig = { ...config };
    // Usuń wrażliwe dane
    if (safeConfig.phemexConfig) {
      safeConfig.phemexConfig = {
        ...safeConfig.phemexConfig,
        apiKey: safeConfig.phemexConfig.apiKey ? "***" : "not set",
        apiSecret: safeConfig.phemexConfig.apiSecret ? "***" : "not set",
      };
    }
    // DEPRECATED - zachowane dla kompatybilności
    if (safeConfig.bybitConfig) {
      safeConfig.bybitConfig = {
        ...safeConfig.bybitConfig,
        apiKey: safeConfig.bybitConfig.apiKey ? "***" : "not set",
        apiSecret: safeConfig.bybitConfig.apiSecret ? "***" : "not set",
      };
    }
    logger.info(
      `[CONFIG] ${action} | Instance: ${instanceId.slice(-8)} | ${JSON.stringify(safeConfig)}`
    );
  }

  /**
   * ✅ NOWE LOGI - Szczegółowe logowanie cyklu górnej bandy
   */
  static logUpperBandCycleStart(instanceId, symbol, triggerPrice, upperBand) {
    const percentAbove = ((triggerPrice / upperBand - 1) * 100).toFixed(2);
    logger.info(
      `[UPPER BAND] 🚀 CYCLE START | ${symbol} | Trigger: ${triggerPrice} (+${percentAbove}% above ${upperBand.toFixed(2)}) | Instance: ${instanceId.slice(-8)}`
    );
  }

  static logUpperBandCycleComplete(
    instanceId,
    symbol,
    exitPrice,
    totalMinutes
  ) {
    logger.info(
      `[UPPER BAND] 🎯 CYCLE COMPLETE | ${symbol} | Exit: ${exitPrice} | Total time: ${totalMinutes} min | POSITION CLOSED | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ NOWE LOGI - Diagnostyka reset warunków
   */
  static logUpperBandResetDiagnostic(
    instanceId,
    symbol,
    resetType,
    currentPrice,
    threshold,
    remainingTime
  ) {
    const timeStr = this.formatDuration(remainingTime);
    logger.warn(
      `[UPPER BAND] ⚠️ RESET RISK | ${symbol} | ${resetType} | Price: ${currentPrice} vs threshold: ${threshold.toFixed(2)} | Time to reset: ${timeStr} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ NOWE LOGI - Status okresowy (co 5 minut)
   */
  static logUpperBandPeriodicStatus(
    instanceId,
    symbol,
    state,
    progress,
    additionalInfo = ""
  ) {
    logger.info(
      `[UPPER BAND] 📊 STATUS | ${symbol} | State: ${state} | Progress: ${progress} ${additionalInfo} | Instance: ${instanceId.slice(-8)}`
    );
  }
  /**
   * ✅ NOWE - Loguje reset stanu górnej bandy (zwięźle)
   */
  static logUpperBandReset(instanceId, reason = "") {
    logger.debug(
      `[UPPER BAND] 🔄 RESET | ${reason} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * ✅ NOWE - Loguje pobranie danych do wykresu (grupowanie)
   */
  static logChartDataFetch(symbol, intervals, totalCandles) {
    logger.info(
      `[CHART] 📊 Data fetched | ${symbol} | Intervals: ${intervals.join(",")} | Total: ${totalCandles} candles`
    );
  }
}

module.exports = TradingLogger;
