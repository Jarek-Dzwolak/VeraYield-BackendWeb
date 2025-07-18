const phemexService = require("./phemex.service");
const accountService = require("./account.service");
const mutex = require("../utils/mutex");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");
const { EventEmitter } = require("events");
const Signal = require("../models/signal.model");
const Instance = require("../models/instance.model");
const instanceService = require("./instance.service");
const downerBandStateManager = require("../utils/downer-band-state-manager");

class SignalService extends EventEmitter {
  constructor() {
    super();
    this.activePositions = new Map();
    this.positionHistory = new Map();
    this.lastEntryTimes = new Map(); // ✅ ZACHOWANE - używane jako backup/sync z DownerBandStateManager
    this.lastRejectionLogs = new Map();
  }

  setupListeners() {
    const analysisService = require("./analysis.service");
    analysisService.setSignalService(this);

    // ✅ BEZ ZMIAN - nadal odbiera sygnały przez event emitter
    analysisService.on("entrySignal", (data) => {
      this.processEntrySignal(data);
    });

    analysisService.on("exitSignal", (data) => {
      this.processExitSignal(data);
    });
  }

  async _adjustContractQuantity(theoreticalQuantity, instrumentInfo) {
    if (!instrumentInfo) {
      instrumentInfo = {
        minOrderQty: 0.001,
        qtyStep: 0.001,
      };
    }

    // Sprawdź minimum
    if (theoreticalQuantity < instrumentInfo.minOrderQty) {
      // ✅ LOG przed pierwszym return:
      logger.info(
        `[QUANTITY] ${theoreticalQuantity.toFixed(6)} -> ${instrumentInfo.minOrderQty} BTC (below minimum)`
      );
      return instrumentInfo.minOrderQty;
    }

    // Dostosuj do kroków
    const steps = Math.floor(theoreticalQuantity / instrumentInfo.qtyStep);
    const adjustedQuantity = steps * instrumentInfo.qtyStep;

    if (adjustedQuantity < instrumentInfo.minOrderQty) {
      // ✅ LOG przed drugim return:
      logger.info(
        `[QUANTITY] ${theoreticalQuantity.toFixed(6)} -> ${instrumentInfo.minOrderQty} BTC (step adjusted, but below minimum)`
      );
      return instrumentInfo.minOrderQty;
    }

    const stepStr = instrumentInfo.qtyStep.toString();
    const precision = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
    const finalQuantity = parseFloat(adjustedQuantity.toFixed(precision));

    // ✅ LOG przed trzecim return:
    logger.info(
      `[QUANTITY] ${theoreticalQuantity.toFixed(6)} -> ${finalQuantity} BTC (step adjusted)`
    );

    return finalQuantity;
  }

  _calculateActualAllocationPercent(
    adjustedQuantity,
    price,
    leverage,
    availableBalance
  ) {
    const positionValue = adjustedQuantity * price;
    const marginUsed = positionValue / leverage;
    return (marginUsed / availableBalance) * 100;
  }

  async _calculateOptimalContractQuantity(
    allocationPercent,
    availableBalance,
    price,
    leverage,
    instrumentInfo
  ) {
    const allocationFraction = allocationPercent / 100;
    const theoreticalMargin = availableBalance * allocationFraction;
    const theoreticalPosition = theoreticalMargin * leverage;
    const theoreticalQuantity = theoreticalPosition / price;

    const adjustedQuantity = await this._adjustContractQuantity(
      theoreticalQuantity,
      instrumentInfo
    );

    const actualAllocationPercent = this._calculateActualAllocationPercent(
      adjustedQuantity,
      price,
      leverage,
      availableBalance
    );

    const actualPosition = adjustedQuantity * price;
    const actualMargin = actualPosition / leverage;

    return {
      theoreticalQuantity,
      adjustedQuantity,
      theoreticalAllocation: allocationPercent,
      actualAllocationPercent,
      theoreticalMargin,
      actualMargin,
      actualPosition,
    };
  }

  async processEntrySignal(signalData) {
    return mutex.withLock(`entry-${signalData.instanceId}`, async () => {
      try {
        const { instanceId, type, price, timestamp, trend, subType } =
          signalData;
        let currentPosition = this.activePositions.get(instanceId);

        const instance = await Instance.findOne({ instanceId });
        if (!instance) {
          return;
        }

        if (!instance.financials || instance.financials.availableBalance <= 0) {
          const rejectionKey = `${instanceId}-no-funds`;
          this.lastRejectionLogs.set(
            rejectionKey,
            TradingLogger.logSignalRejected(
              instanceId,
              instance.symbol,
              "No available funds",
              this.lastRejectionLogs.get(rejectionKey)
            )
          );
          return;
        }

        const strategyParams = instance.strategy.parameters;
        const leverage = instance.phemexConfig?.leverage || 3;

        // ✅ UŻYWAMY price z DownerBandStateManager (1M CLOSE)
        const currentPrice = await phemexService.getCurrentPrice(
          instance.symbol
        );
        const instrumentInfo = await phemexService.getCachedInstrumentInfo(
          instance.symbol
        );

        if (!currentPosition) {
          // ✅ PIERWSZE WEJŚCIE
          const firstEntryPercent =
            strategyParams.capitalAllocation?.firstEntry * 100 || 10;

          const optimalEntry = await this._calculateOptimalContractQuantity(
            firstEntryPercent,
            instance.financials.availableBalance,
            currentPrice, // Live price dla obliczeń
            leverage,
            instrumentInfo
          );

          const positionId = `position-${instanceId}-${Date.now()}`;

          const signal = await this.createSignalInDatabase({
            instanceId,
            symbol: instance.symbol,
            type: "entry",
            subType: "first",
            price, // ✅ 1M CLOSE price z DownerBandStateManager
            allocation: optimalEntry.actualAllocationPercent / 100,
            amount: optimalEntry.actualMargin,
            timestamp,
            status: "pending",
            positionId: positionId,
            metadata: {
              trend,
              positionId,
              theoreticalAllocation: firstEntryPercent / 100,
              theoreticalQuantity: optimalEntry.theoreticalQuantity,
              adjustedQuantity: optimalEntry.adjustedQuantity,
              priceSource: signalData.metadata?.priceSource || "1m_close", // ✅ DODANE
            },
          });

          try {
            await accountService.lockFundsForPosition(
              instanceId,
              optimalEntry.actualMargin,
              signal._id
            );

            // ✅ PHEMEX API CALLS (bez zmian)
            if (instance.phemexConfig && instance.phemexConfig.apiKey) {
              try {
                await phemexService.setLeverage(
                  instance.phemexConfig.apiKey,
                  instance.phemexConfig.apiSecret,
                  instance.symbol,
                  leverage
                );
                await phemexService.setMarginMode(
                  instance.phemexConfig.apiKey,
                  instance.phemexConfig.apiSecret,
                  instance.symbol,
                  instance.phemexConfig.marginMode === "isolated" ? 1 : 0
                );

                const orderResult = await phemexService.openPosition(
                  instance.phemexConfig.apiKey,
                  instance.phemexConfig.apiSecret,
                  instance.symbol,
                  "Buy",
                  optimalEntry.adjustedQuantity.toString(),
                  0,
                  instance.phemexConfig.subaccountId
                );

                TradingLogger.logPhemexSuccess(
                  instanceId,
                  instance.symbol,
                  "Order placed",
                  `ID: ${orderResult.result?.orderId}`
                );

                signal.metadata.phemexOrderId = orderResult.result?.orderId;
                signal.metadata.phemexOrderLinkId =
                  orderResult.result?.orderLinkId;
                signal.metadata.contractQuantity =
                  optimalEntry.adjustedQuantity;
                await signal.save();
              } catch (error) {
                TradingLogger.logPhemexError(
                  instanceId,
                  instance.symbol,
                  "Order placement",
                  error.message
                );
              }
            }

            // ✅ UTWORZENIE POZYCJI
            const newPosition = {
              instanceId,
              symbol: instance.symbol,
              positionId: positionId,
              entryTime: timestamp,
              entryPrice: price, // ✅ 1M CLOSE price
              capitalAllocation: optimalEntry.actualAllocationPercent / 100,
              capitalAmount: optimalEntry.actualMargin,
              status: "active",
              entries: [
                {
                  time: timestamp,
                  price, // ✅ 1M CLOSE price
                  type,
                  trend,
                  allocation: optimalEntry.actualAllocationPercent / 100,
                  amount: optimalEntry.actualMargin,
                  signalId: signal._id.toString(),
                  contractQuantity: optimalEntry.adjustedQuantity,
                  positionId: positionId,
                },
              ],
              history: [],
            };

            this.activePositions.set(instanceId, newPosition);

            // ✅ SYNC Z DOWNERBAND STATE MANAGER
            this.lastEntryTimes.set(instanceId, timestamp);
            downerBandStateManager.updateLastEntryTime(instanceId, timestamp);

            await this._atomicStateReset(instanceId);

            TradingLogger.logEntry(
              instanceId,
              instance.symbol,
              price, // ✅ 1M CLOSE price w logu
              "First entry",
              trend,
              optimalEntry.actualAllocationPercent / 100,
              optimalEntry.actualMargin,
              optimalEntry.adjustedQuantity
            );

            this.emit("newPosition", newPosition);
          } catch (error) {
            TradingLogger.logTradingError(
              instanceId,
              instance.symbol,
              error.message,
              "Lock funds failed"
            );
            await Signal.findByIdAndUpdate(signal._id, {
              status: "canceled",
              metadata: {
                cancelReason: `Nie udało się zablokować środków: ${error.message}`,
              },
            });
          }
        } else if (currentPosition.status === "active") {
          // ✅ DODATKOWE WEJŚCIA (second/third)
          const entryCount = currentPosition.entries.length;

          if (entryCount >= 3) {
            const rejectionKey = `${instanceId}-max-entries`;
            this.lastRejectionLogs.set(
              rejectionKey,
              TradingLogger.logSignalRejected(
                instanceId,
                instance.symbol,
                "Max 3 entries reached",
                this.lastRejectionLogs.get(rejectionKey)
              )
            );
            return;
          }

          // ✅ WALIDACJA CZASU - możliwość użycia z DownerBandStateManager lub lokalnej kopii
          const lastEntryTime = this.lastEntryTimes.get(instanceId) || 0;
          const minEntryTimeGap =
            strategyParams.signals?.minEntryTimeGap || 7200000;

          if (timestamp - lastEntryTime < minEntryTimeGap) {
            const rejectionKey = `${instanceId}-time-gap`;
            this.lastRejectionLogs.set(
              rejectionKey,
              TradingLogger.logSignalRejected(
                instanceId,
                instance.symbol,
                `Too soon: ${((timestamp - lastEntryTime) / 60000).toFixed(1)}min < ${minEntryTimeGap / 60000}min`,
                this.lastRejectionLogs.get(rejectionKey)
              )
            );
            return;
          }

          const remainingBalance = instance.financials.availableBalance;
          let allocationPercent = 0;
          let entryType = "";

          if (entryCount === 1) {
            allocationPercent =
              strategyParams.capitalAllocation?.secondEntry * 100 || 25;
            entryType = "second";
          } else if (entryCount === 2) {
            allocationPercent =
              strategyParams.capitalAllocation?.thirdEntry * 100 || 50;
            entryType = "third";
          }

          const optimalEntry = await this._calculateOptimalContractQuantity(
            allocationPercent,
            remainingBalance,
            currentPrice,
            leverage,
            instrumentInfo
          );

          const positionId = currentPosition.positionId;

          const signal = await this.createSignalInDatabase({
            instanceId,
            symbol: currentPosition.symbol,
            type: "entry",
            subType: entryType,
            price, // ✅ 1M CLOSE price
            allocation: optimalEntry.actualAllocationPercent / 100,
            amount: optimalEntry.actualMargin,
            timestamp,
            status: "pending",
            positionId: positionId,
            metadata: {
              trend,
              theoreticalAllocation: allocationPercent / 100,
              theoreticalQuantity: optimalEntry.theoreticalQuantity,
              adjustedQuantity: optimalEntry.adjustedQuantity,
              priceSource: signalData.metadata?.priceSource || "1m_close", // ✅ DODANE
            },
          });

          try {
            await accountService.lockFundsForPosition(
              instanceId,
              optimalEntry.actualMargin,
              signal._id
            );

            // ✅ PHEMEX API dla dodatkowych wejść (bez zmian)
            if (instance.phemexConfig && instance.phemexConfig.apiKey) {
              try {
                const orderResult = await phemexService.openPosition(
                  instance.phemexConfig.apiKey,
                  instance.phemexConfig.apiSecret,
                  instance.symbol,
                  "Buy",
                  optimalEntry.adjustedQuantity.toString(),
                  0,
                  instance.phemexConfig.subaccountId
                );

                TradingLogger.logPhemexSuccess(
                  instanceId,
                  instance.symbol,
                  `${entryType} order placed`,
                  `ID: ${orderResult.result?.orderId}`
                );

                signal.metadata.phemexOrderId = orderResult.result?.orderId;
                signal.metadata.phemexOrderLinkId =
                  orderResult.result?.orderLinkId;
                signal.metadata.contractQuantity =
                  optimalEntry.adjustedQuantity;
                await signal.save();
              } catch (error) {
                TradingLogger.logPhemexError(
                  instanceId,
                  instance.symbol,
                  `${entryType} order placement`,
                  error.message
                );
              }
            }

            // ✅ AKTUALIZACJA POZYCJI
            currentPosition.entries.push({
              time: timestamp,
              price, // ✅ 1M CLOSE price
              type,
              trend,
              allocation: optimalEntry.actualAllocationPercent / 100,
              amount: optimalEntry.actualMargin,
              signalId: signal._id.toString(),
              contractQuantity: optimalEntry.adjustedQuantity,
              positionId: positionId,
            });

            currentPosition.capitalAllocation +=
              optimalEntry.actualAllocationPercent / 100;
            currentPosition.capitalAmount += optimalEntry.actualMargin;

            // ✅ SYNC Z DOWNERBAND STATE MANAGER
            this.lastEntryTimes.set(instanceId, timestamp);
            downerBandStateManager.updateLastEntryTime(instanceId, timestamp);

            TradingLogger.logEntry(
              instanceId,
              instance.symbol,
              price, // ✅ 1M CLOSE price w logu
              `${entryType} entry`,
              trend,
              optimalEntry.actualAllocationPercent / 100,
              optimalEntry.actualMargin,
              optimalEntry.adjustedQuantity
            );

            this.emit("positionUpdated", currentPosition);
          } catch (error) {
            TradingLogger.logTradingError(
              instanceId,
              instance.symbol,
              error.message,
              `${entryType} entry lock funds failed`
            );
            await Signal.findByIdAndUpdate(signal._id, {
              status: "canceled",
              metadata: {
                cancelReason: `Nie udało się zablokować środków: ${error.message}`,
              },
            });
          }
        }
      } catch (error) {
        logger.error(
          `Błąd podczas przetwarzania sygnału wejścia: ${error.message}`
        );
      }
    });
  }

  async _atomicStateReset(instanceId) {
    return mutex.withLock(`state-reset-${instanceId}`, async () => {
      try {
        const analysisService = require("./analysis.service");
        await analysisService.resetUpperBandState(instanceId);
        // ✅ DODANE - reset stanu entry
        await analysisService.resetDownerBandState(instanceId);
        await analysisService.resetTrailingStopTracking(instanceId);
      } catch (error) {
        logger.error(`Error in atomic state reset: ${error.message}`);
      }
    });
  }

  // ✅ POZOSTAŁE METODY BEZ ZMIAN
  _isTrendValidForEntry(trend) {
    return ["up", "strong_up", "neutral"].includes(trend);
  }

  async processExitSignal(signalData) {
    return mutex.withLock(`exit-${signalData.instanceId}`, async () => {
      try {
        const { instanceId, type, price, timestamp, positionId } = signalData;
        const currentPosition = this.activePositions.get(instanceId);

        if (!currentPosition || currentPosition.status !== "active") {
          return;
        }

        const entryCount = currentPosition.entries.length;
        if (entryCount === 1) {
          const instanceForTimeCheck = await Instance.findOne({ instanceId });
          if (instanceForTimeCheck) {
            const minFirstEntryDuration =
              instanceForTimeCheck.strategy.parameters.signals
                ?.minFirstEntryDuration || 60 * 60 * 1000;
            const positionDuration = timestamp - currentPosition.entryTime;

            if (positionDuration < minFirstEntryDuration) {
              const rejectionKey = `${instanceId}-too-fresh`;
              this.lastRejectionLogs.set(
                rejectionKey,
                TradingLogger.logSignalRejected(
                  instanceId,
                  currentPosition.symbol,
                  `First entry too fresh: ${(positionDuration / 60000).toFixed(1)}min < ${minFirstEntryDuration / 60000}min`,
                  this.lastRejectionLogs.get(rejectionKey)
                )
              );
              return;
            }
          }
        }

        const entryAvgPrice = this.calculateAverageEntryPrice(currentPosition);
        const profitPercent = (price / entryAvgPrice - 1) * 100;

        let totalEntryAmount = 0;
        for (const entry of currentPosition.entries) {
          totalEntryAmount += entry.amount;
        }

        const exitAmount = totalEntryAmount * (1 + profitPercent / 100);
        const profit = exitAmount - totalEntryAmount;

        const exitSignal = await this.createSignalInDatabase({
          instanceId,
          symbol: currentPosition.symbol,
          type: "exit",
          subType: type,
          price,
          profitPercent,
          exitAmount,
          profit,
          timestamp,
          status: "pending",
          positionId: currentPosition.positionId,
          metadata: {
            entryAvgPrice,
            totalEntryAmount,
            entriesFromMemory: currentPosition.entries.length,
            ...(type === "trailingStop" && signalData.highestPrice
              ? {
                  highestPrice: signalData.highestPrice,
                  dropPercent: signalData.dropPercent,
                  trailingStopPercent: signalData.trailingStopPercent,
                }
              : {}),
            ...(type === "upperBandReturn" && signalData.metadata
              ? {
                  exitReason: signalData.metadata.exitReason,
                  totalCycleTime: signalData.metadata.totalCycleTime,
                  returnTrigger: signalData.metadata.returnTrigger,
                  finalPrice: signalData.metadata.finalPrice,
                }
              : {}),
          },
        });

        const firstEntrySignalId = currentPosition.entries[0]?.signalId;

        try {
          await accountService.finalizePosition(
            instanceId,
            firstEntrySignalId,
            exitSignal._id,
            totalEntryAmount,
            exitAmount
          );
          const instanceForExit = await Instance.findOne({ instanceId });

          if (
            instanceForExit &&
            instanceForExit.phemexConfig &&
            instanceForExit.phemexConfig.apiKey
          ) {
            try {
              let totalContractQuantity = 0;

              for (const entry of currentPosition.entries) {
                if (entry.contractQuantity) {
                  totalContractQuantity += parseFloat(entry.contractQuantity);
                }
              }

              if (totalContractQuantity === 0) {
                const allEntrySignals = await Signal.find({
                  instanceId,
                  type: "entry",
                  status: "executed",
                  timestamp: {
                    $gte: currentPosition.entryTime - 24 * 60 * 60 * 1000,
                    $lte: timestamp,
                  },
                }).sort({ timestamp: 1 });

                for (const signal of allEntrySignals) {
                  const contractQty = signal.metadata?.contractQuantity || 0;
                  if (contractQty > 0) {
                    totalContractQuantity += parseFloat(contractQty);
                  }
                }
              }

              if (totalContractQuantity === 0) {
                try {
                  const positionSize = await phemexService.getPositionSize(
                    instanceForExit.phemexConfig.apiKey,
                    instanceForExit.phemexConfig.apiSecret,
                    instanceForExit.symbol,
                    instanceForExit.phemexConfig.subaccountId
                  );
                  totalContractQuantity = positionSize;
                } catch (apiError) {
                  const currentPrice = await phemexService.getCurrentPrice(
                    instanceForExit.symbol
                  );
                  const positionValue =
                    totalEntryAmount * instanceForExit.phemexConfig.leverage;
                  const instrumentInfo =
                    await phemexService.getCachedInstrumentInfo(
                      instanceForExit.symbol
                    );
                  const theoreticalQuantity = positionValue / currentPrice;
                  totalContractQuantity = await this._adjustContractQuantity(
                    theoreticalQuantity,
                    instrumentInfo
                  );
                }
              }

              const orderResult = await phemexService.closePosition(
                instanceForExit.phemexConfig.apiKey,
                instanceForExit.phemexConfig.apiSecret,
                instanceForExit.symbol,
                "Buy",
                totalContractQuantity.toString(),
                0,
                instanceForExit.phemexConfig.subaccountId
              );

              TradingLogger.logPhemexSuccess(
                instanceId,
                instanceForExit.symbol,
                "Position closed",
                `Contract: ${totalContractQuantity}`
              );

              exitSignal.metadata.phemexOrderId = orderResult.result?.orderId;
              exitSignal.metadata.phemexOrderLinkId =
                orderResult.result?.orderLinkId;
              exitSignal.metadata.contractQuantity = totalContractQuantity;
              await exitSignal.save();
            } catch (error) {
              TradingLogger.logPhemexError(
                instanceId,
                instanceForExit.symbol,
                "Position close",
                error.message
              );
            }
          }

          currentPosition.exitTime = timestamp;
          currentPosition.exitPrice = price;
          currentPosition.exitType = type;
          currentPosition.profitPercent = profitPercent;
          currentPosition.exitAmount = exitAmount;
          currentPosition.profit = profit;
          currentPosition.status = "closed";
          currentPosition.exitSignalId = exitSignal._id;

          if (!this.positionHistory.has(instanceId)) {
            this.positionHistory.set(instanceId, []);
          }

          this.positionHistory.get(instanceId).push({ ...currentPosition });

          await this._atomicStateReset(instanceId);

          this.activePositions.delete(instanceId);
          this.lastEntryTimes.delete(instanceId);

          const duration = timestamp - currentPosition.entryTime;
          TradingLogger.logExit(
            instanceId,
            currentPosition.symbol,
            price,
            type,
            profitPercent,
            profit,
            duration
          );

          this.emit("positionClosed", currentPosition);

          const instanceForSync = await Instance.findOne({ instanceId });
          if (
            instanceForSync &&
            instanceForSync.phemexConfig &&
            instanceForSync.phemexConfig.apiKey &&
            !instanceForSync.testMode
          ) {
            setTimeout(async () => {
              try {
                await instanceService.syncInstanceBalance(instanceId);
              } catch (error) {
                TradingLogger.logTradingError(
                  instanceId,
                  currentPosition.symbol,
                  error.message,
                  "Balance sync after exit failed"
                );
              }
            }, 2000);
          }

          return exitSignal;
        } catch (error) {
          TradingLogger.logTradingError(
            instanceId,
            currentPosition.symbol,
            error.message,
            "Position finalize failed"
          );
          await Signal.findByIdAndUpdate(exitSignal._id, {
            status: "canceled",
            metadata: {
              cancelReason: `Nie udało się sfinalizować pozycji: ${error.message}`,
            },
          });
          throw error;
        }
      } catch (error) {
        logger.error(
          `Błąd podczas przetwarzania sygnału wyjścia: ${error.message}`
        );
        throw error;
      }
    });
  }

  calculateAverageEntryPrice(position) {
    let totalAllocation = 0;
    let weightedSum = 0;

    for (const entry of position.entries) {
      weightedSum += entry.price * entry.allocation;
      totalAllocation += entry.allocation;
    }

    return totalAllocation > 0 ? weightedSum / totalAllocation : 0;
  }

  async createSignalInDatabase(signalData) {
    try {
      const signal = new Signal({
        instanceId: signalData.instanceId,
        symbol: signalData.symbol,
        type: signalData.type,
        subType: signalData.subType,
        price: signalData.price,
        allocation: signalData.allocation,
        amount: signalData.amount,
        profitPercent: signalData.profitPercent,
        profit: signalData.profit,
        exitAmount: signalData.exitAmount,
        timestamp: signalData.timestamp,
        status: signalData.status || "pending",
        metadata: signalData.metadata || {},
        entrySignalId: signalData.entrySignalId,
        positionId: signalData.positionId,
      });

      await signal.save();
      return signal;
    } catch (error) {
      logger.error(
        `Błąd podczas zapisywania sygnału w bazie danych: ${error.message}`
      );
      throw error;
    }
  }

  getActivePositions(instanceId = null) {
    if (instanceId) {
      return this.activePositions.get(instanceId) || null;
    }
    return Array.from(this.activePositions.values());
  }

  getPositionHistory(instanceId = null) {
    if (instanceId) {
      return this.positionHistory.get(instanceId) || [];
    }

    const allHistory = [];
    for (const history of this.positionHistory.values()) {
      allHistory.push(...history);
    }

    return allHistory.sort((a, b) => b.exitTime - a.exitTime);
  }

  setActivePosition(instanceId, position) {
    if (!position.positionId) {
      position.positionId = `position-${instanceId}-${Date.now()}`;
    }

    this.activePositions.set(instanceId, position);

    if (position.entries && position.entries.length > 0) {
      this.lastEntryTimes.set(instanceId, position.entries[0].time);
    }
  }

  async getSignalsFromDb(filters = {}, limit = 100, skip = 0) {
    try {
      return await Signal.find(filters)
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(skip);
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania sygnałów z bazy danych: ${error.message}`
      );
      throw error;
    }
  }

  async getSignalStats(instanceId = null) {
    try {
      const filters = instanceId ? { instanceId } : {};

      const exitSignals = await Signal.find({
        ...filters,
        type: "exit",
        status: "executed",
      });

      let totalTrades = exitSignals.length;
      let profitableTrades = 0;
      let totalProfit = 0;
      let totalAmount = 0;
      let maxProfit = 0;
      let maxLoss = 0;

      for (const signal of exitSignals) {
        const profit = signal.profit || 0;
        const profitPercent = signal.profitPercent || 0;

        totalProfit += profit;

        if (signal.amount) {
          totalAmount += signal.amount;
        }

        if (profit > 0) {
          profitableTrades++;
        }

        if (profitPercent > maxProfit) {
          maxProfit = profitPercent;
        }

        if (profitPercent < maxLoss) {
          maxLoss = profitPercent;
        }
      }

      const rejectedSignals = await Signal.find({
        ...filters,
        type: "entry-rejected",
      }).count();

      return {
        totalTrades,
        profitableTrades,
        winRate: totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0,
        averageProfitPercent: totalTrades > 0 ? totalProfit / totalTrades : 0,
        totalProfit,
        totalAmount,
        maxProfitPercent: maxProfit,
        maxLossPercent: maxLoss,
        roi: totalAmount > 0 ? (totalProfit / totalAmount) * 100 : 0,
        rejectedSignals: rejectedSignals || 0,
      };
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania statystyk sygnałów: ${error.message}`
      );
      throw error;
    }
  }

  async clearSignalHistory(instanceId) {
    try {
      const result = await Signal.deleteMany({ instanceId });
      this.positionHistory.delete(instanceId);
      this.lastEntryTimes.delete(instanceId);
      this.lastRejectionLogs.delete(instanceId);

      logger.info(`Wyczyszczono historię sygnałów dla instancji ${instanceId}`);
      return result.deletedCount;
    } catch (error) {
      logger.error(
        `Błąd podczas czyszczenia historii sygnałów: ${error.message}`
      );
      throw error;
    }
  }
}

const signalService = new SignalService();
signalService.setupListeners();
module.exports = signalService;
