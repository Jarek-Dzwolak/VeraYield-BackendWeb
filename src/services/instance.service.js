const Instance = require("../models/instance.model");
const analysisService = require("./analysis.service");
const signalService = require("./signal.service");
const mutex = require("../utils/mutex");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");
const { v4: uuidv4 } = require("uuid");
const phemexService = require("./phemex.service");
const Signal = require("../models/signal.model");

class InstanceService {
  constructor() {
    this.instances = new Map();
  }

  async initialize() {
    try {
      const instances = await Instance.find({ active: true });

      for (const instance of instances) {
        await this.startInstance(instance.instanceId);

        if (
          instance.financials &&
          instance.financials.openPositions &&
          instance.financials.openPositions.length > 0
        ) {
          const signalIds = instance.financials.openPositions.map(
            (p) => p.signalId
          );
          const entrySignals = await Signal.find({
            _id: { $in: signalIds },
            type: "entry",
          });

          if (entrySignals.length > 0) {
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

            signalService.setActivePosition(instance.instanceId, position);
            logger.info(
              `Odtworzono aktywną pozycję dla instancji ${instance.instanceId}`
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

  async createInstance(config) {
    return mutex.withLock(`create-${config.name}`, async () => {
      try {
        const instanceId = config.instanceId || uuidv4();
        const existingInstance = await Instance.findOne({ instanceId });

        if (existingInstance) {
          throw new Error(`Instancja o ID ${instanceId} już istnieje`);
        }

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
              ema: { interval: "1h", periods: 30 },
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

        // Ustaw konfigurację Phemex bez dekodowania - klucze przychodzą jako plain text
        if (config.phemexConfig) {
          instance.phemexConfig = {
            apiKey: config.phemexConfig.apiKey || "",
            apiSecret: config.phemexConfig.apiSecret || "",
            leverage: config.phemexConfig.leverage || 3,
            marginMode: config.phemexConfig.marginMode || "isolated",
            testnet: config.phemexConfig.testnet !== false,
          };
        }

        await instance.save();

        if (instance.active) {
          await this.startInstance(instanceId);
        }

        if (instance.phemexConfig?.apiKey && !instance.testMode) {
          setTimeout(async () => {
            try {
              await this.syncInstanceBalance(instanceId);
              TradingLogger.logInstanceState(
                instanceId,
                "Auto balance sync completed"
              );
            } catch (error) {
              TradingLogger.logTradingError(
                instanceId,
                instance.symbol,
                error.message,
                "Auto balance sync failed"
              );
            }
          }, 3000);
        }

        TradingLogger.logInstanceState(
          instanceId,
          "Created",
          `${instance.name} (${instance.symbol})`
        );
        return instance;
      } catch (error) {
        logger.error(`Błąd podczas tworzenia instancji: ${error.message}`);
        throw error;
      }
    });
  }

  async startInstance(instanceId) {
    return mutex.withLock(`start-${instanceId}`, async () => {
      try {
        const instance = await Instance.findOne({ instanceId });
        if (!instance) {
          throw new Error(`Instancja ${instanceId} nie istnieje`);
        }

        if (this.instances.has(instanceId)) {
          return true;
        }

        if (
          instance.phemexConfig &&
          instance.phemexConfig.apiKey &&
          !instance.testMode
        ) {
          await this.syncInstanceBalance(instanceId);
        }

        const analysisConfig = {
          symbol: instance.symbol,
          hurst: instance.strategy.parameters.hurst,
          ema: instance.strategy.parameters.ema,
          checkEMATrend: instance.strategy.parameters.signals.checkEMATrend,
          signals: instance.strategy.parameters.signals,
        };

        const analysisSuccess = await analysisService.initializeInstance(
          instanceId,
          analysisConfig
        );
        if (!analysisSuccess) {
          throw new Error(
            `Nie udało się zainicjalizować analizy dla instancji ${instanceId}`
          );
        }

        await analysisService.resetUpperBandState(instanceId);

        this.instances.set(instanceId, {
          ...instance.toObject(),
          lastStarted: new Date(),
        });

        instance.active = true;
        instance.updatedAt = new Date();
        await instance.save();

        TradingLogger.logInstanceState(
          instanceId,
          "Started",
          `${instance.name} (${instance.symbol})`
        );
        return true;
      } catch (error) {
        TradingLogger.logTradingError(
          instanceId,
          "UNKNOWN",
          error.message,
          "Start failed"
        );
        return false;
      }
    });
  }

  async stopInstance(instanceId) {
    return mutex.withLock(`stop-${instanceId}`, async () => {
      try {
        if (!this.instances.has(instanceId)) {
          return true;
        }

        await analysisService.resetUpperBandState(instanceId);

        analysisService.stopInstance(instanceId);
        this.instances.delete(instanceId);

        const instance = await Instance.findOne({ instanceId });
        if (instance) {
          instance.active = false;
          instance.updatedAt = new Date();
          await instance.save();
        }

        TradingLogger.logInstanceState(instanceId, "Stopped");
        return true;
      } catch (error) {
        TradingLogger.logTradingError(
          instanceId,
          "UNKNOWN",
          error.message,
          "Stop failed"
        );
        return false;
      }
    });
  }

  async updateInstance(instanceId, updateData) {
    return mutex.withLock(`update-${instanceId}`, async () => {
      try {
        const instance = await Instance.findOne({ instanceId });
        if (!instance) {
          throw new Error(`Instancja ${instanceId} nie istnieje`);
        }

        const isRunning = this.instances.has(instanceId);
        if (isRunning) {
          await this.stopInstance(instanceId);
        }

        if (updateData.name) instance.name = updateData.name;
        if (updateData.symbol) instance.symbol = updateData.symbol;
        if (updateData.active !== undefined)
          instance.active = updateData.active;

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

        if (isRunning || instance.active) {
          await this.startInstance(instanceId);
        }

        TradingLogger.logInstanceState(
          instanceId,
          "Updated",
          `${instance.name} (${instance.symbol})`
        );
        return instance;
      } catch (error) {
        TradingLogger.logTradingError(
          instanceId,
          "UNKNOWN",
          error.message,
          "Update failed"
        );
        throw error;
      }
    });
  }

  async deleteInstance(instanceId) {
    return mutex.withLock(`delete-${instanceId}`, async () => {
      try {
        const instance = await Instance.findOne({ instanceId });
        if (!instance) {
          throw new Error(`Instancja ${instanceId} nie istnieje`);
        }

        if (this.instances.has(instanceId)) {
          await this.stopInstance(instanceId);
        }

        const deletedSignals = await Signal.deleteMany({ instanceId });

        try {
          if (signalService.positionHistory) {
            signalService.positionHistory.delete(instanceId);
            signalService.lastEntryTimes.delete(instanceId);
          }
        } catch (e) {
          // Ignoruj błędy czyszczenia pamięci
        }

        await Instance.deleteOne({ instanceId });

        TradingLogger.logInstanceState(
          instanceId,
          "Deleted",
          `${instance.name} + ${deletedSignals.deletedCount} signals`
        );
        return true;
      } catch (error) {
        TradingLogger.logTradingError(
          instanceId,
          "UNKNOWN",
          error.message,
          "Delete failed"
        );
        return false;
      }
    });
  }

  async getAllInstances(activeOnly = false) {
    try {
      const filter = activeOnly ? { active: true } : {};
      return await Instance.find(filter).sort({ createdAt: -1 });
    } catch (error) {
      logger.error(`Błąd podczas pobierania instancji: ${error.message}`);
      throw error;
    }
  }

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

  getInstanceState(instanceId) {
    if (!this.instances.has(instanceId)) {
      return { running: false };
    }

    const instanceConfig = this.instances.get(instanceId);
    const analysisState = analysisService.getInstanceAnalysisState(instanceId);
    const activePosition = signalService.getActivePositions(instanceId);

    return {
      running: true,
      config: instanceConfig,
      analysis: analysisState,
      position: activePosition,
    };
  }

  async stopAllInstances() {
    const instanceIds = [...this.instances.keys()];
    for (const instanceId of instanceIds) {
      await this.stopInstance(instanceId);
    }
    logger.info("Zatrzymano wszystkie instancje");
  }

  async syncInstanceBalance(instanceId) {
    try {
      const instance = await Instance.findOne({ instanceId });

      if (!instance || !instance.phemexConfig?.apiKey || instance.testMode) {
        return false;
      }

      TradingLogger.logConfig(instanceId, "Starting balance sync", {
        hasApiKey: !!instance.phemexConfig?.apiKey,
        hasApiSecret: !!instance.phemexConfig?.apiSecret,
        testMode: instance.testMode,
      });

      const balanceData = await phemexService.getBalance(
        instance.phemexConfig.apiKey,
        instance.phemexConfig.apiSecret,
        "USDT"
      );

      if (balanceData.retCode !== 0) {
        TradingLogger.logTradingError(
          instanceId,
          instance.symbol,
          `Phemex API error: ${balanceData.retMsg}`,
          "Balance sync"
        );
        return false;
      }

      const accountInfo = balanceData.result?.list?.[0];
      const usdtBalance = accountInfo?.coin?.find(
        (coin) => coin.coin === "USDT"
      );

      if (usdtBalance) {
        const availableBalance = parseFloat(
          usdtBalance.availableToWithdraw ||
            usdtBalance.walletBalance ||
            usdtBalance.availableBalance ||
            "0"
        );

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

        const oldBalance = instance.financials.currentBalance;
        const lockedBalance = instance.financials.lockedBalance || 0;

        instance.financials.availableBalance = availableBalance - lockedBalance;
        instance.financials.currentBalance = availableBalance;
        instance.financials.allocatedCapital = availableBalance;

        await instance.save();

        TradingLogger.logBalanceSync(instanceId, oldBalance, availableBalance);
        return true;
      }

      return false;
    } catch (error) {
      TradingLogger.logTradingError(
        instanceId,
        "UNKNOWN",
        error.message,
        "Balance sync failed"
      );
      return false;
    }
  }

  async updatePhemexConfig(
    instanceId,
    { apiKey, apiSecret, leverage, marginMode, testnet }
  ) {
    return mutex.withLock(`phemex-config-${instanceId}`, async () => {
      try {
        const instance = await Instance.findOne({ instanceId });
        if (!instance) {
          throw new Error("Instance not found");
        }

        // Aktualizuj konfigurację Phemex - klucze przychodzą jako plain text
        instance.phemexConfig = {
          apiKey: apiKey || "",
          apiSecret: apiSecret || "",
          leverage: leverage || 3,
          marginMode: marginMode || "isolated",
          testnet: testnet !== false,
        };

        await instance.save();

        TradingLogger.logConfig(instanceId, "Phemex config updated", {
          leverage: instance.phemexConfig.leverage,
          marginMode: instance.phemexConfig.marginMode,
          testnet: instance.phemexConfig.testnet,
          hasApiKey: !!instance.phemexConfig.apiKey,
          hasApiSecret: !!instance.phemexConfig.apiSecret,
        });

        return instance;
      } catch (error) {
        TradingLogger.logTradingError(
          instanceId,
          "UNKNOWN",
          error.message,
          "Phemex config update failed"
        );
        throw error;
      }
    });
  }
}

const instanceService = new InstanceService();
module.exports = instanceService;
