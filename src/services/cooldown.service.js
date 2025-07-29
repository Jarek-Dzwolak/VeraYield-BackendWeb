const mutex = require("../utils/mutex");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");

class CooldownService {
  constructor() {
    this.cooldowns = new Map(); // instanceId -> { startTime, durationHours }
  }

  /**
   * Ustawia cooldown dla instancji
   * @param {string} instanceId - ID instancji
   * @param {number} hours - Długość cooldown w godzinach (domyślnie 12h)
   */
  async setCooldown(instanceId, hours = 12) {
    return mutex.withLock(`cooldown-${instanceId}`, async () => {
      try {
        const startTime = Date.now();
        const durationMs = hours * 60 * 60 * 1000; // hours to milliseconds

        this.cooldowns.set(instanceId, {
          startTime,
          durationHours: hours,
          endTime: startTime + durationMs,
        });

        const endDate = new Date(startTime + durationMs);
        TradingLogger.logDebugThrottled(
          `cooldown-set-${instanceId}`,
          `[COOLDOWN] Set for ${hours}h | Ends: ${endDate.toISOString()} | Instance: ${instanceId.slice(-8)}`,
          300000
        );

        logger.info(`Cooldown set for instance ${instanceId}: ${hours} hours`);
        return true;
      } catch (error) {
        logger.error(
          `Error setting cooldown for ${instanceId}: ${error.message}`
        );
        return false;
      }
    });
  }

  /**
   * Sprawdza czy instancja jest w cooldown
   * @param {string} instanceId - ID instancji
   * @returns {boolean} - Czy instancja jest w cooldown
   */
  isInCooldown(instanceId) {
    const cooldown = this.cooldowns.get(instanceId);

    if (!cooldown) {
      return false;
    }

    const now = Date.now();

    // Sprawdź czy cooldown już minął
    if (now >= cooldown.endTime) {
      this.cooldowns.delete(instanceId);
      TradingLogger.logDebugThrottled(
        `cooldown-expired-${instanceId}`,
        `[COOLDOWN] Expired | Instance: ${instanceId.slice(-8)}`,
        300000
      );
      return false;
    }

    return true;
  }

  /**
   * Pobiera informacje o cooldown dla instancji
   * @param {string} instanceId - ID instancji
   * @returns {Object|null} - Informacje o cooldown lub null
   */
  getCooldownInfo(instanceId) {
    const cooldown = this.cooldowns.get(instanceId);

    if (!cooldown) {
      return null;
    }

    const now = Date.now();

    // Sprawdź czy cooldown już minął
    if (now >= cooldown.endTime) {
      this.cooldowns.delete(instanceId);
      return null;
    }

    const remainingMs = cooldown.endTime - now;
    const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
    const remainingMinutes = Math.ceil(
      (remainingMs % (60 * 60 * 1000)) / (60 * 1000)
    );

    return {
      startTime: cooldown.startTime,
      endTime: cooldown.endTime,
      durationHours: cooldown.durationHours,
      remainingMs,
      remainingHours,
      remainingMinutes,
      remainingText:
        remainingHours > 0
          ? `${remainingHours}h ${remainingMinutes}min`
          : `${remainingMinutes}min`,
    };
  }

  /**
   * Usuwa cooldown dla instancji (force clear)
   * @param {string} instanceId - ID instancji
   */
  clearCooldown(instanceId) {
    const hadCooldown = this.cooldowns.has(instanceId);
    this.cooldowns.delete(instanceId);

    if (hadCooldown) {
      TradingLogger.logDebugThrottled(
        `cooldown-cleared-${instanceId}`,
        `[COOLDOWN] Manually cleared | Instance: ${instanceId.slice(-8)}`,
        300000
      );
      logger.info(`Cooldown cleared for instance ${instanceId}`);
    }

    return hadCooldown;
  }

  /**
   * Pobiera wszystkie aktywne cooldowns
   * @returns {Array} - Lista aktywnych cooldowns
   */
  getAllActiveCooldowns() {
    const now = Date.now();
    const activeCooldowns = [];

    for (const [instanceId, cooldown] of this.cooldowns.entries()) {
      if (now < cooldown.endTime) {
        activeCooldowns.push({
          instanceId,
          ...this.getCooldownInfo(instanceId),
        });
      } else {
        // Usuń wygasłe cooldowns
        this.cooldowns.delete(instanceId);
      }
    }

    return activeCooldowns;
  }

  /**
   * Czyści wszystkie cooldowns (np. przy restarcie)
   */
  clearAllCooldowns() {
    const count = this.cooldowns.size;
    this.cooldowns.clear();

    if (count > 0) {
      logger.info(`Cleared ${count} cooldowns`);
    }

    return count;
  }

  /**
   * Pobiera status wszystkich instancji (dla debugowania)
   */
  getStatusSummary() {
    const activeCooldowns = this.getAllActiveCooldowns();

    return {
      totalActiveCooldowns: activeCooldowns.length,
      cooldowns: activeCooldowns.map((cd) => ({
        instanceId: cd.instanceId.slice(-8),
        remaining: cd.remainingText,
        endTime: new Date(cd.endTime).toISOString(),
      })),
    };
  }
}

const cooldownService = new CooldownService();
module.exports = cooldownService;
