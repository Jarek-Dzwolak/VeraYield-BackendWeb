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
const bybitService = require("./bybit.service");
const Signal = require("../models/signal.model");

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

        // Odtwórz aktywne pozycje w pamięci na podstawie danych z bazy
        if (
          instance.financials &&
          instance.financials.openPositions &&
          instance.financials.openPositions.length > 0
        ) {
          const signalIds = instance.financials.openPositions.map(
            (p) => p.signalId
          );

          // Pobierz sygnały dla tych pozycji
          const entrySignals = await Signal.find({
            _id: { $in: signalIds },
            type: "entry",
          });

          if (entrySignals.length > 0) {
            // Odtwórz pozycję w pamięci
            const position = {
              instanceId: instance.instanceId,
              symbol: instance.symbol,
              entryTime: instance.financials.openPositions[0].lockedAt,
              entryPrice: entrySignals[0].price,
              capitalAllocation: 0,
              capitalAmount: 0,
              status: "active",
              entries: [],
            };

            // Dodaj wszystkie wejścia
            for (const signal of entrySignals) {
              position.entries.push({
                time: signal.timestamp,
                price: signal.price,
                type: signal.subType,
                trend: signal.metadata?.trend || "unknown",
                allocation: signal.allocation,
                amount: signal.amount,
                signalId: signal._id.toString(),
              });

              position.capitalAllocation += signal.allocation || 0;
              position.capitalAmount += signal.amount || 0;
            }

            // Dodaj pozycję do mapy w pamięci
            signalService.setActivePosition(instance.instanceId, position);

            logger.info(
              `Odtworzono aktywną pozycję dla instancji ${instance.instanceId} z bazy danych`
            );
          }
        }
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

      // Utwórz nową instancję w bazie danych
      const instance = new Instance({
        instanceId,
        name: config.name || `Instancja ${instanceId.substr(0, 6)}`,
        symbol: config.symbol,
        active: config.active !== false,
        testMode: config.testMode || false,
        strategy: {
          type: config.strategy?.type || "hurst",
          parameters: config.strategy?.parameters || {
            hurst: {
              interval: "15m",
              periods: 25,
              upperDeviationFactor: 2.0,
              lowerDeviationFactor: 2.0,
            },
            ema: {
              interval: "1h",
              periods: 30,
            },
            signals: {
              checkEMATrend: true,
              minEntryTimeGap: 7200000,
              enableTrailingStop: true,
              trailingStop: 0.02,
              trailingStopDelay: 300000,
              minFirstEntryDuration: 3600000,
            },
            capitalAllocation: {
              firstEntry: 0.1,
              secondEntry: 0.25,
              thirdEntry: 0.5,
            },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Inicjalizuj dane finansowe dla KAŻDEJ instancji
      const initialFunds = config.initialFunds || 0;
      instance.financials = {
        allocatedCapital: initialFunds,
        currentBalance: initialFunds,
        availableBalance: initialFunds,
        lockedBalance: 0,
        totalProfit: 0,
        userId: config.userId || "000000000000000000000000",
        openPositions: [],
        closedPositions: [],
      };

      // Ustaw konfigurację ByBit jeśli została przekazana
      if (config.bybitConfig) {
        instance.bybitConfig = config.bybitConfig;
      }

      await instance.save();

      // Jeśli instancja ma być aktywna, uruchom ją
      if (instance.active) {
        await this.startInstance(instanceId);
      }

      // Automatyczna synchronizacja salda jeśli mamy klucze ByBit i nie jest to tryb testowy
      if (instance.bybitConfig?.apiKey && !instance.testMode) {
        setTimeout(async () => {
          try {
            await this.syncInstanceBalance(instanceId);
            logger.info(
              `Automatyczna synchronizacja salda dla nowej instancji ${instanceId}`
            );
          } catch (error) {
            logger.error(
              `Błąd automatycznej synchronizacji salda: ${error.message}`
            );
          }
        }, 3000);
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
      // Synchronizuj saldo z ByBit przy pierwszym uruchomieniu
      if (
        instance.bybitConfig &&
        instance.bybitConfig.apiKey &&
        !instance.testMode
      ) {
        logger.info(
          `Synchronizacja salda ByBit dla instancji ${instanceId}...`
        );
        await this.syncInstanceBalance(instanceId);
      }
      // Przygotuj konfigurację dla serwisu analizy
      const analysisConfig = {
        symbol: instance.symbol,
        hurst: instance.strategy.parameters.hurst,
        ema: instance.strategy.parameters.ema,
        checkEMATrend: instance.strategy.parameters.signals.checkEMATrend,
        signals: instance.strategy.parameters.signals, // Dodaj cały obiekt signals
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
  /**
   * Synchronizuje saldo instancji z ByBit
   * @param {string} instanceId - ID instancji
   * @returns {Promise<boolean>} - Czy synchronizacja się powiodła
   */
  async syncInstanceBalance(instanceId) {
    try {
      const instance = await Instance.findOne({ instanceId });

      if (!instance || !instance.bybitConfig?.apiKey || instance.testMode) {
        logger.debug(
          `Pomijam synchronizację salda dla instancji ${instanceId} (brak konfiguracji ByBit lub tryb testowy)`
        );
        return false;
      }

      logger.info(
        `Rozpoczynam synchronizację salda dla instancji ${instanceId}...`
      );

      const balanceData = await bybitService.getBalance(
        instance.bybitConfig.apiKey,
        instance.bybitConfig.apiSecret
      );

      // Znajdź saldo USDT
      const usdtBalance = balanceData.result?.list?.[0]?.coin?.find(
        (coin) => coin.coin === "USDT"
      );

      if (usdtBalance) {
        const availableBalance = parseFloat(
          usdtBalance.availableToWithdraw || usdtBalance.walletBalance
        );

        // Inicjalizuj financials jeśli nie istnieje
        if (!instance.financials) {
          instance.financials = {
            allocatedCapital: 0,
            currentBalance: 0,
            availableBalance: 0,
            lockedBalance: 0,
            totalProfit: 0,
            openPositions: [],
            closedPositions: [],
          };
        }

        // Zaktualizuj saldo zachowując zablokowane środki
        const lockedBalance = instance.financials.lockedBalance || 0;
        instance.financials.availableBalance = availableBalance - lockedBalance;
        instance.financials.currentBalance = availableBalance;
        instance.financials.allocatedCapital = availableBalance;

        await instance.save();

        logger.info(
          `Zsynchronizowano saldo dla instancji ${instanceId}: ${availableBalance} USDT (dostępne: ${instance.financials.availableBalance})`
        );
        return true;
      }

      logger.warn(`Nie znaleziono salda USDT dla instancji ${instanceId}`);
      return false;
    } catch (error) {
      logger.error(
        `Błąd synchronizacji salda dla ${instanceId}: ${error.message}`
      );
      return false;
    }
  }
}

// Eksportuj singleton
const instanceService = new InstanceService();
module.exports = instanceService;
