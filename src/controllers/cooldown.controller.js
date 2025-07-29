const cooldownService = require("../services/cooldown.service");
const instanceService = require("../services/instance.service");
const logger = require("../utils/logger");

/**
 * Pobiera informacje o cooldown dla konkretnej instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getCooldownInfo = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    const cooldownInfo = cooldownService.getCooldownInfo(instanceId);
    const isInCooldown = cooldownService.isInCooldown(instanceId);

    res.json({
      instanceId,
      instanceName: instance.name,
      isInCooldown,
      cooldownInfo,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania cooldown info: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching cooldown information",
    });
  }
};

/**
 * Pobiera wszystkie aktywne cooldowns
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAllCooldowns = async (req, res) => {
  try {
    const activeCooldowns = cooldownService.getAllActiveCooldowns();
    const statusSummary = cooldownService.getStatusSummary();

    res.json({
      activeCooldowns,
      summary: statusSummary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania wszystkich cooldowns: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching cooldowns",
    });
  }
};

/**
 * Manualnie czyści cooldown dla instancji (tylko admin)
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const clearCooldown = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    const hadCooldown = cooldownService.clearCooldown(instanceId);

    res.json({
      success: true,
      instanceId,
      instanceName: instance.name,
      message: hadCooldown
        ? "Cooldown cleared successfully"
        : "No active cooldown found",
      hadCooldown,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Błąd podczas czyszczenia cooldown: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while clearing cooldown",
    });
  }
};

/**
 * Manualnie ustawia cooldown dla instancji (tylko admin)
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const setCooldown = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { hours = 12 } = req.body;

    // Walidacja hours
    if (isNaN(hours) || hours < 0 || hours > 48) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Hours must be a number between 0 and 48",
      });
    }

    // Sprawdź czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    const success = await cooldownService.setCooldown(instanceId, hours);

    if (success) {
      const cooldownInfo = cooldownService.getCooldownInfo(instanceId);

      res.json({
        success: true,
        instanceId,
        instanceName: instance.name,
        message: `Cooldown set for ${hours} hours`,
        cooldownInfo,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to set cooldown",
      });
    }
  } catch (error) {
    logger.error(`Błąd podczas ustawiania cooldown: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while setting cooldown",
    });
  }
};

/**
 * Czyści wszystkie cooldowns (tylko admin)
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const clearAllCooldowns = async (req, res) => {
  try {
    const clearedCount = cooldownService.clearAllCooldowns();

    res.json({
      success: true,
      message: `Cleared ${clearedCount} cooldowns`,
      clearedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(
      `Błąd podczas czyszczenia wszystkich cooldowns: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while clearing all cooldowns",
    });
  }
};

module.exports = {
  getCooldownInfo,
  getAllCooldowns,
  clearCooldown,
  setCooldown,
  clearAllCooldowns,
};
