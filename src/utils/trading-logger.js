/**
 * Trading Logger - dedykowane funkcje logowania dla operacji tradingowych
 * Dodaj to do src/utils/trading-logger.js
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
   * Loguje błędy API ByBit
   */
  static logBybitError(instanceId, symbol, operation, error) {
    logger.error(
      `[BYBIT ERROR] ${symbol} | ${operation} failed: ${error} | Instance: ${instanceId.slice(-8)}`
    );
  }

  /**
   * Loguje sukces operacji ByBit (tylko najważniejsze)
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
}

module.exports = TradingLogger;
