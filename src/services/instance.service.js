/**
 * Instance Service - serwis zarządzania instancjami strategii
 *
 * Odpowiedzialny za:
 * - Tworzenie, aktualizację i usuwanie instancji strategii
 * - Przechowywanie konfiguracji instancji
 * - Koordynację serwisów dla każdej instancji
 */

const Instance = require("../models/instance.model");
const analysisService = require("./analysis.service");
const signalService = require("./signal.service");
const logger = require("../utils/logger");
const { v4: uuidv4 } = require("uuid");

class InstanceService {
  constructor() {
    this.instances = new Map(); // Mapa aktywnych instancji (instanceId -> instanceConfig)
  }

  /**
   * Inicjalizuje serwis instancji
   */
  async initialize() {
    try {
      // Pobierz wszystkie instancje z bazy danych
      const instances = await Instance.find({ active: true });

      // Uruchom aktywne instancje
      for (const instance of instances) {
        await this.startInstance(instance.instanceId);
      }

      logger.info(
        `Zainicjalizowano serwis instancji: ${instances.length} aktywnych instancji`
      );
    } catch (error) {
      logger.error(
        `Błąd podczas inicjalizacji serwisu instancji: ${error.message}`
      );
    }
  }

  /**
   * Tworzy nową instancję strategii
   * @param {Object} config - Konfiguracja instancji
   * @returns {Promise<Object>} - Utworzona instancja
   */
  async createInstance(config) {
    try {
      // Wygeneruj identyfikator instancji, jeśli nie istnieje
      const instanceId = config.instanceId || uuidv4();

      // Sprawdź, czy instancja o danym ID już istnieje
      const existingInstance = await Instance.findOne({ instanceId });
      if (existingInstance) {
        throw new Error(`Instancja o ID ${instanceId} już istnieje`);
      }

      // Sprawdź, czy jest to tryb testowy
      const isTestMode = config.testMode === true;

      // Utwórz nową instancję w bazie danych
      // Utwórz nową instancję w bazie danych
      const instance = new Instance({
        instanceId,
        name: config.name || `Instancja ${instanceId.substr(0, 6)}`,
        symbol: config.symbol,
        active: config.active !== false,
        testMode: isTestMode,
        strategy: {
          type: config.strategy?.type || "hurst",
          parameters: {
            hurst: config.strategy?.parameters?.hurst || {
              interval: "15m",
              periods: 25,
              upperDeviationFactor: 2.0,
              lowerDeviationFactor: 2.0,
            },
            ema: config.strategy?.parameters?.ema || {
              interval: "1h",
              periods: 30,
            },
            signals: config.strategy?.parameters?.signals || {
              checkEMATrend: true,
              minEntryTimeGap: 7200000,
            },
            capitalAllocation: config.strategy?.parameters
              ?.capitalAllocation || {
              firstEntry: 0.1,
              secondEntry: 0.25,
              thirdEntry: 0.5,
            },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Dla trybu testowego dodajemy przykładowe dane API i finansowe
      if (isTestMode) {
        // Dodaj przykładowe klucze API dla trybu testowego
        instance.apiKeys = {
          apiKey: "test_api_key",
          apiSecret: "test_api_secret",
        };

        // Dodaj przykładowe dane finansowe dla trybu testowego z uwzględnieniem initialFunds
        const initialFunds = config.initialFunds || 1000; // Używamy przekazanej wartości lub domyślnej 1000

        instance.financials = {
          allocatedCapital: initialFunds,
          currentBalance: initialFunds,
          availableBalance: initialFunds,
          lockedBalance: 0,
          totalProfit: 0,
          userId: "000000000000000000000000", // Fikcyjny ID użytkownika
          openPositions: [],
          closedPositions: [],
        };

        logger.info(
          `Inicjalizacja instancji testowej ${instanceId} z ${initialFunds} środków`
        );
      }
      await instance.save();

      // Jeśli instancja ma być aktywna, uruchom ją
      if (instance.active) {
        await this.startInstance(instanceId);
      }

      logger.info(`Utworzono nową instancję: ${instance.name} (${instanceId})`);
      return instance;
    } catch (error) {
      logger.error(`Błąd podczas tworzenia instancji: ${error.message}`);
      throw error;
    }
  }

  /**
   * Uruchamia instancję strategii
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Promise<boolean>} - Czy uruchomienie się powiodło
   */
  async startInstance(instanceId) {
    try {
      // Pobierz instancję z bazy danych
      const instance = await Instance.findOne({ instanceId });

      if (!instance) {
        throw new Error(`Instancja ${instanceId} nie istnieje`);
      }

      // Sprawdź, czy instancja nie jest już uruchomiona
      if (this.instances.has(instanceId)) {
        logger.warn(`Instancja ${instanceId} jest już uruchomiona`);
        return true;
      }

      // Przygotuj konfigurację dla serwisu analizy
      const analysisConfig = {
        symbol: instance.symbol,
        hurst: instance.strategy.parameters.hurst,
        ema: instance.strategy.parameters.ema,
        checkEMATrend: instance.strategy.parameters.signals.checkEMATrend,
      };

      // Uruchom analizę dla instancji
      const analysisSuccess = await analysisService.initializeInstance(
        instanceId,
        analysisConfig
      );

      if (!analysisSuccess) {
        throw new Error(
          `Nie udało się zainicjalizować analizy dla instancji ${instanceId}`
        );
      }

      // Zapisz konfigurację w pamięci
      this.instances.set(instanceId, {
        ...instance.toObject(),
        lastStarted: new Date(),
      });

      // Aktualizuj status w bazie danych
      instance.active = true;
      instance.updatedAt = new Date();
      await instance.save();

      logger.info(`Uruchomiono instancję: ${instance.name} (${instanceId})`);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas uruchamiania instancji ${instanceId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Zatrzymuje instancję strategii
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Promise<boolean>} - Czy zatrzymanie się powiodło
   */
  async stopInstance(instanceId) {
    try {
      // Sprawdź, czy instancja jest uruchomiona
      if (!this.instances.has(instanceId)) {
        logger.warn(`Instancja ${instanceId} nie jest uruchomiona`);
        return true;
      }

      // Zatrzymaj analizę dla instancji
      analysisService.stopInstance(instanceId);

      // Usuń instancję z pamięci
      this.instances.delete(instanceId);

      // Aktualizuj status w bazie danych
      const instance = await Instance.findOne({ instanceId });

      if (instance) {
        instance.active = false;
        instance.updatedAt = new Date();
        await instance.save();
      }

      logger.info(`Zatrzymano instancję: ${instanceId}`);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas zatrzymywania instancji ${instanceId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Aktualizuje konfigurację instancji
   * @param {string} instanceId - Identyfikator instancji
   * @param {Object} updateData - Dane do aktualizacji
   * @returns {Promise<Object>} - Zaktualizowana instancja
   */
  async updateInstance(instanceId, updateData) {
    try {
      // Pobierz instancję z bazy danych
      const instance = await Instance.findOne({ instanceId });

      if (!instance) {
        throw new Error(`Instancja ${instanceId} nie istnieje`);
      }

      // Sprawdź, czy instancja jest uruchomiona
      const isRunning = this.instances.has(instanceId);

      // Jeśli instancja jest uruchomiona, zatrzymaj ją przed aktualizacją
      if (isRunning) {
        await this.stopInstance(instanceId);
      }

      // Aktualizuj dane instancji
      if (updateData.name) instance.name = updateData.name;
      if (updateData.symbol) instance.symbol = updateData.symbol;
      if (updateData.active !== undefined) instance.active = updateData.active;

      // Aktualizuj parametry strategii
      if (updateData.strategy?.parameters?.hurst) {
        instance.strategy.parameters.hurst = {
          ...instance.strategy.parameters.hurst,
          ...updateData.strategy.parameters.hurst,
        };
      }

      if (updateData.strategy?.parameters?.ema) {
        instance.strategy.parameters.ema = {
          ...instance.strategy.parameters.ema,
          ...updateData.strategy.parameters.ema,
        };
      }

      if (updateData.strategy?.parameters?.checkEMATrend !== undefined) {
        instance.strategy.parameters.checkEMATrend =
          updateData.strategy.parameters.checkEMATrend;
      }

      instance.updatedAt = new Date();
      await instance.save();

      // Jeśli instancja była uruchomiona lub ma być aktywna, uruchom ją ponownie
      if (isRunning || instance.active) {
        await this.startInstance(instanceId);
      }

      logger.info(`Zaktualizowano instancję: ${instance.name} (${instanceId})`);
      return instance;
    } catch (error) {
      logger.error(
        `Błąd podczas aktualizacji instancji ${instanceId}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Usuwa instancję strategii
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Promise<boolean>} - Czy usunięcie się powiodło
   */
  async deleteInstance(instanceId) {
    try {
      // Sprawdź, czy instancja istnieje
      const instance = await Instance.findOne({ instanceId });

      if (!instance) {
        throw new Error(`Instancja ${instanceId} nie istnieje`);
      }

      // Jeśli instancja jest uruchomiona, zatrzymaj ją
      if (this.instances.has(instanceId)) {
        await this.stopInstance(instanceId);
      }

      // Usuń sygnały powiązane z instancją
      await signalService.clearSignalHistory(instanceId);

      // Usuń instancję z bazy danych
      await Instance.deleteOne({ instanceId });

      logger.info(`Usunięto instancję: ${instance.name} (${instanceId})`);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas usuwania instancji ${instanceId}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Pobiera wszystkie instancje
   * @param {boolean} activeOnly - Czy pobierać tylko aktywne instancje
   * @returns {Promise<Array>} - Tablica instancji
   */
  async getAllInstances(activeOnly = false) {
    try {
      const filter = activeOnly ? { active: true } : {};
      return await Instance.find(filter).sort({ createdAt: -1 });
    } catch (error) {
      logger.error(`Błąd podczas pobierania instancji: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera instancję po ID
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Promise<Object>} - Instancja
   */
  async getInstance(instanceId) {
    try {
      return await Instance.findOne({ instanceId });
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania instancji ${instanceId}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Pobiera stan instancji (dane z pamięci)
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Object} - Stan instancji
   */
  getInstanceState(instanceId) {
    // Sprawdź, czy instancja jest uruchomiona
    if (!this.instances.has(instanceId)) {
      return { running: false };
    }

    // Pobierz dane z pamięci
    const instanceConfig = this.instances.get(instanceId);

    // Pobierz aktualny stan analizy
    const analysisState = analysisService.getInstanceAnalysisState(instanceId);

    // Pobierz aktywne pozycje
    const activePosition = signalService.getActivePositions(instanceId);

    return {
      running: true,
      config: instanceConfig,
      analysis: analysisState,
      position: activePosition,
    };
  }

  /**
   * Zatrzymuje wszystkie instancje
   */
  async stopAllInstances() {
    const instanceIds = [...this.instances.keys()];

    for (const instanceId of instanceIds) {
      await this.stopInstance(instanceId);
    }

    logger.info("Zatrzymano wszystkie instancje");
  }
}

// Eksportuj singleton
const instanceService = new InstanceService();
module.exports = instanceService;
