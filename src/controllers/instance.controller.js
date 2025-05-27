/**
 * Instance Controller - kontroler instancji strategii
 *
 * Odpowiedzialny za:
 * - Tworzenie, aktualizację i usuwanie instancji
 * - Zarządzanie statusem instancji
 * - Pobieranie danych instancji
 */

const instanceService = require("../services/instance.service");
const signalService = require("../services/signal.service");
const logger = require("../utils/logger");
const { v4: uuidv4 } = require("uuid");
const { validateInstanceParams } = require("../config/instance.config");
const Instance = require("../models/instance.model"); // Dodany brakujący import

/**
 * Pobiera wszystkie instancje
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAllInstances = async (req, res) => {
  try {
    // Pobierz wszystkie instancje
    const instances = await instanceService.getAllInstances();

    res.json({
      count: instances.length,
      instances,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instances",
    });
  }
};

/**
 * Pobiera tylko aktywne instancje
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getActiveInstances = async (req, res) => {
  try {
    // Pobierz aktywne instancje
    const instances = await instanceService.getAllInstances(true);

    res.json({
      count: instances.length,
      instances,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania aktywnych instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching active instances",
    });
  }
};

/**
 * Pobiera konkretną instancję po ID
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Pobierz instancję
    const instance = await instanceService.getInstance(instanceId);

    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    res.json(instance);
  } catch (error) {
    logger.error(`Błąd podczas pobierania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance",
    });
  }
};

/**
 /**
 * Tworzy nową instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const createInstance = async (req, res) => {
  try {
    const {
      symbol,
      name,
      strategy,
      active,
      initialFunds,
      testMode,
      bybitConfig,
    } = req.body;

    // SZCZEGÓŁOWE DEBUGOWANIE KLUCZY API
    logger.info("=== DEBUGOWANIE KLUCZY API ===");
    if (bybitConfig && bybitConfig.apiKey) {
      logger.info(`Raw received API Key: "${bybitConfig.apiKey}"`);
      logger.info(`API Key length: ${bybitConfig.apiKey.length}`);
      logger.info(
        `API Key first 20 chars: "${bybitConfig.apiKey.substring(0, 20)}"`
      );

      try {
        // Sprawdź czy jest to Base64
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        const isBase64 = base64Regex.test(bybitConfig.apiKey);
        logger.info(`Is API Key Base64: ${isBase64}`);

        if (isBase64 && bybitConfig.apiKey.length > 10) {
          const decoded = Buffer.from(bybitConfig.apiKey, "base64").toString(
            "utf8"
          );
          logger.info(`Decoded API Key: "${decoded}"`);
          logger.info(`Decoded API Key length: ${decoded.length}`);

          // Sprawdź czy zawiera tylko alfanumeryczne znaki
          const isAlphanumeric = /^[A-Za-z0-9]+$/.test(decoded);
          logger.info(`Is decoded API Key alphanumeric: ${isAlphanumeric}`);

          if (isAlphanumeric) {
            bybitConfig.apiKey = decoded;
            logger.info("✅ API Key successfully decoded and stored");
          } else {
            logger.warn(
              "❌ Decoded API Key contains invalid characters, keeping original"
            );
          }
        } else {
          logger.info("API Key is not Base64 encoded, keeping as-is");
        }
      } catch (error) {
        logger.error(`Error decoding API Key: ${error.message}`);
      }
    }

    if (bybitConfig && bybitConfig.apiSecret) {
      logger.info(`Raw received API Secret: "${bybitConfig.apiSecret}"`);
      logger.info(`API Secret length: ${bybitConfig.apiSecret.length}`);
      logger.info(
        `API Secret first 20 chars: "${bybitConfig.apiSecret.substring(0, 20)}"`
      );

      try {
        // Sprawdź czy jest to Base64
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        const isBase64 = base64Regex.test(bybitConfig.apiSecret);
        logger.info(`Is API Secret Base64: ${isBase64}`);

        if (isBase64 && bybitConfig.apiSecret.length > 10) {
          const decoded = Buffer.from(bybitConfig.apiSecret, "base64").toString(
            "utf8"
          );
          logger.info(`Decoded API Secret: "${decoded}"`);
          logger.info(`Decoded API Secret length: ${decoded.length}`);

          // Sprawdź czy zawiera tylko alfanumeryczne znaki
          const isAlphanumeric = /^[A-Za-z0-9]+$/.test(decoded);
          logger.info(`Is decoded API Secret alphanumeric: ${isAlphanumeric}`);

          if (isAlphanumeric) {
            bybitConfig.apiSecret = decoded;
            logger.info("✅ API Secret successfully decoded and stored");
          } else {
            logger.warn(
              "❌ Decoded API Secret contains invalid characters, keeping original"
            );
          }
        } else {
          logger.info("API Secret is not Base64 encoded, keeping as-is");
        }
      } catch (error) {
        logger.error(`Error decoding API Secret: ${error.message}`);
      }
    }
    logger.info("=== KONIEC DEBUGOWANIA ===");

    // Przygotuj konfigurację instancji
    const config = {
      symbol,
      name,
      active,
      strategy,
      initialFunds, // Dodanie obsługi początkowych środków
      testMode, // Dodaj flagę testMode z formularza
      instanceId: uuidv4(), // Generuj nowy UUID
      bybitConfig: bybitConfig || {}, // Dodaj konfigurację ByBit
    };

    // Utwórz instancję
    const instance = await instanceService.createInstance(config);

    res.status(201).json({
      message: "Instance created successfully",
      instance,
    });
  } catch (error) {
    logger.error(`Błąd podczas tworzenia instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while creating instance",
    });
  }
};

/**

 * Aktualizuje instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const updateInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const updateData = req.body;

    // Aktualizuj instancję
    const instance = await instanceService.updateInstance(
      instanceId,
      updateData
    );

    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    res.json({
      message: "Instance updated successfully",
      instance,
    });
  } catch (error) {
    logger.error(`Błąd podczas aktualizacji instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while updating instance",
    });
  }
};

/**
 * Usuwa instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const deleteInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Usuń instancję
    const success = await instanceService.deleteInstance(instanceId);

    if (!success) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found or could not be deleted",
      });
    }

    res.json({
      message: "Instance deleted successfully",
    });
  } catch (error) {
    logger.error(`Błąd podczas usuwania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while deleting instance",
    });
  }
};

/**
 * Uruchamia instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const startInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Uruchom instancję
    const success = await instanceService.startInstance(instanceId);

    if (!success) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found or could not be started",
      });
    }

    res.json({
      message: "Instance started successfully",
    });
  } catch (error) {
    logger.error(`Błąd podczas uruchamiania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while starting instance",
    });
  }
};

/**
 * Zatrzymuje instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const stopInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Zatrzymaj instancję
    const success = await instanceService.stopInstance(instanceId);

    if (!success) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found or could not be stopped",
      });
    }

    res.json({
      message: "Instance stopped successfully",
    });
  } catch (error) {
    logger.error(`Błąd podczas zatrzymywania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while stopping instance",
    });
  }
};

/**
 * Pobiera bieżący stan instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getInstanceState = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Pobierz stan instancji
    const state = instanceService.getInstanceState(instanceId);

    if (!state || !state.running) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found or not running",
      });
    }

    res.json(state);
  } catch (error) {
    logger.error(`Błąd podczas pobierania stanu instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance state",
    });
  }
};

/**
 * Pobiera wyniki instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getInstanceResults = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Pobierz statystyki sygnałów
    const stats = await signalService.getSignalStats(instanceId);

    // Pobierz historię pozycji
    const positionHistory = signalService.getPositionHistory(instanceId);

    res.json({
      instanceId,
      instanceName: instance.name,
      stats,
      positionHistory,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania wyników instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance results",
    });
  }
};

/**
 * Pobiera konfigurację instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getInstanceConfig = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Pobierz instancję
    const instance = await instanceService.getInstance(instanceId);

    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Zwróć tylko konfigurację
    res.json({
      instanceId,
      symbol: instance.symbol,
      strategy: instance.strategy,
      active: instance.active,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania konfiguracji instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance configuration",
    });
  }
};

/**
 * Aktualizuje konfigurację instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const updateInstanceConfig = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const configData = req.body;

    // Pobierz instancję
    const instance = await instanceService.getInstance(instanceId);

    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Waliduj parametry konfiguracji
    const validation = validateInstanceParams(configData);

    if (!validation.isValid) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Invalid configuration parameters",
        details: validation.errors,
      });
    }

    // Przygotuj dane do aktualizacji
    const updateData = {
      strategy: {
        parameters: {},
      },
    };

    // Dodaj parametry kanału Hursta
    if (configData.hurst) {
      updateData.strategy.parameters.hurst = {
        ...instance.strategy.parameters.hurst,
        ...configData.hurst,
      };
    }

    // Dodaj parametry EMA
    if (configData.ema) {
      updateData.strategy.parameters.ema = {
        ...instance.strategy.parameters.ema,
        ...configData.ema,
      };
    }

    // Dodaj parametry sygnałów
    if (configData.signals) {
      updateData.strategy.parameters.signals = {
        ...instance.strategy.parameters.signals,
        ...configData.signals,
      };
    }

    // Dodaj parametry alokacji kapitału
    if (configData.capitalAllocation) {
      updateData.strategy.parameters.capitalAllocation = {
        ...instance.strategy.parameters.capitalAllocation,
        ...configData.capitalAllocation,
      };
    }

    // Dodaj parametry interwałów
    if (configData.intervals) {
      updateData.strategy.parameters.intervals = {
        ...instance.strategy.parameters.intervals,
        ...configData.intervals,
      };
    }

    // Aktualizuj instancję
    const updatedInstance = await instanceService.updateInstance(
      instanceId,
      updateData
    );

    res.json({
      message: "Instance configuration updated successfully",
      config: {
        instanceId,
        strategy: updatedInstance.strategy,
      },
    });
  } catch (error) {
    logger.error(
      `Błąd podczas aktualizacji konfiguracji instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while updating instance configuration",
    });
  }
};

/**
 * Klonuje instancję
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const cloneInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { name } = req.body;

    // Pobierz oryginalną instancję
    const originalInstance = await instanceService.getInstance(instanceId);

    if (!originalInstance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Przygotuj konfigurację nowej instancji
    const config = {
      symbol: originalInstance.symbol,
      name: name || `${originalInstance.name} (Clone)`,
      active: false, // Domyślnie nieaktywna
      strategy: originalInstance.strategy,
      instanceId: uuidv4(), // Nowy identyfikator
    };

    // Utwórz nową instancję
    const newInstance = await instanceService.createInstance(config);

    res.status(201).json({
      message: "Instance cloned successfully",
      originalInstanceId: instanceId,
      newInstance,
    });
  } catch (error) {
    logger.error(`Błąd podczas klonowania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while cloning instance",
    });
  }
};

/**
 * Porównuje wyniki dwóch instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const compareInstances = async (req, res) => {
  try {
    const { instanceId1, instanceId2 } = req.params;

    // Pobierz instancje
    const instance1 = await instanceService.getInstance(instanceId1);
    const instance2 = await instanceService.getInstance(instanceId2);

    if (!instance1 || !instance2) {
      return res.status(404).json({
        error: "Not Found",
        message: "One or both instances not found",
      });
    }

    // Pobierz statystyki sygnałów dla obu instancji
    const stats1 = await signalService.getSignalStats(instanceId1);
    const stats2 = await signalService.getSignalStats(instanceId2);

    // Porównaj statystyki
    const comparison = {
      instance1: {
        id: instanceId1,
        name: instance1.name,
        symbol: instance1.symbol,
        strategy: instance1.strategy,
        stats: stats1,
      },
      instance2: {
        id: instanceId2,
        name: instance2.name,
        symbol: instance2.symbol,
        strategy: instance2.strategy,
        stats: stats2,
      },
      comparison: {
        totalProfitDiff: stats1.totalProfit - stats2.totalProfit,
        winRateDiff: stats1.winRate - stats2.winRate,
        averageProfitDiff: stats1.averageProfit - stats2.averageProfit,
        totalTradesDiff: stats1.totalTrades - stats2.totalTrades,
      },
    };

    res.json(comparison);
  } catch (error) {
    logger.error(`Błąd podczas porównywania instancji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while comparing instances",
    });
  }
};

/**
 * Zatrzymuje wszystkie instancje
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const stopAllInstances = async (req, res) => {
  try {
    // Zatrzymaj wszystkie instancje
    await instanceService.stopAllInstances();

    res.json({
      message: "All instances stopped successfully",
    });
  } catch (error) {
    logger.error(
      `Błąd podczas zatrzymywania wszystkich instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while stopping all instances",
    });
  }
};

/**
 * Aktualizuje konfigurację ByBit dla instancji
 */
const updateBybitConfig = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { apiKey, apiSecret, leverage, marginMode, testnet } = req.body;

    // SZCZEGÓŁOWE DEBUGOWANIE KLUCZY API
    logger.info("=== DEBUGOWANIE UPDATE BYBIT KLUCZY ===");
    let decodedApiKey = apiKey;
    let decodedApiSecret = apiSecret;

    if (apiKey) {
      logger.info(`Raw received API Key: "${apiKey}"`);
      logger.info(`API Key length: ${apiKey.length}`);

      try {
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        const isBase64 = base64Regex.test(apiKey);
        logger.info(`Is API Key Base64: ${isBase64}`);

        if (isBase64 && apiKey.length > 10) {
          const decoded = Buffer.from(apiKey, "base64").toString("utf8");
          logger.info(`Decoded API Key: "${decoded}"`);

          const isAlphanumeric = /^[A-Za-z0-9]+$/.test(decoded);
          if (isAlphanumeric) {
            decodedApiKey = decoded;
            logger.info("✅ API Key successfully decoded");
          }
        }
      } catch (error) {
        logger.error(`Error decoding API Key: ${error.message}`);
      }
    }

    if (apiSecret) {
      logger.info(`Raw received API Secret: "${apiSecret}"`);
      logger.info(`API Secret length: ${apiSecret.length}`);

      try {
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        const isBase64 = base64Regex.test(apiSecret);
        logger.info(`Is API Secret Base64: ${isBase64}`);

        if (isBase64 && apiSecret.length > 10) {
          const decoded = Buffer.from(apiSecret, "base64").toString("utf8");
          logger.info(`Decoded API Secret: "${decoded}"`);

          const isAlphanumeric = /^[A-Za-z0-9]+$/.test(decoded);
          if (isAlphanumeric) {
            decodedApiSecret = decoded;
            logger.info("✅ API Secret successfully decoded");
          }
        }
      } catch (error) {
        logger.error(`Error decoding API Secret: ${error.message}`);
      }
    }
    logger.info("=== KONIEC UPDATE DEBUGOWANIA ===");

    const instance = await Instance.findOne({ instanceId });

    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Aktualizuj konfigurację ByBit
    instance.bybitConfig = {
      apiKey: decodedApiKey,
      apiSecret: decodedApiSecret,
      leverage: leverage || 3,
      marginMode: marginMode || "isolated",
      testnet: testnet !== false,
    };

    await instance.save();

    res.json({
      message: "ByBit configuration updated successfully",
      instanceId,
      bybitConfig: {
        ...instance.bybitConfig,
        apiSecret: "***", // Nie zwracaj sekretu w odpowiedzi
      },
    });
  } catch (error) {
    logger.error(`Error updating ByBit config: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while updating ByBit configuration",
    });
  }
};

/**
 * Synchronizuje saldo instancji z ByBit
 */
const syncInstanceBalance = async (req, res) => {
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

    // Wykonaj synchronizację
    const success = await instanceService.syncInstanceBalance(instanceId);

    if (success) {
      // Pobierz zaktualizowaną instancję
      const updatedInstance = await instanceService.getInstance(instanceId);

      res.json({
        message: "Saldo zsynchronizowane pomyślnie",
        financials: updatedInstance.financials,
      });
    } else {
      res.status(400).json({
        error: "Sync Failed",
        message:
          "Nie udało się zsynchronizować salda. Sprawdź konfigurację ByBit.",
      });
    }
  } catch (error) {
    logger.error(`Błąd podczas synchronizacji salda: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while syncing balance",
    });
  }
};

module.exports = {
  getAllInstances,
  getActiveInstances,
  getInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  startInstance,
  stopInstance,
  getInstanceState,
  getInstanceResults,
  getInstanceConfig,
  updateInstanceConfig,
  cloneInstance,
  compareInstances,
  stopAllInstances,
  updateBybitConfig,
  syncInstanceBalance,
};
