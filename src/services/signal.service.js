const bybitService = require("./bybit.service");
const analysisService = require("./analysis.service");
const accountService = require("./account.service");
const logger = require("../utils/logger");
const { EventEmitter } = require("events");
const Signal = require("../models/signal.model");
const Instance = require("../models/instance.model");
const instanceService = require("./instance.service");

class SignalService extends EventEmitter {
  constructor() {
    super();
    this.activePositions = new Map();
    this.positionHistory = new Map();
    this.lastEntryTimes = new Map();
    this.setupListeners();
  }

  setupListeners() {
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

    if (theoreticalQuantity < instrumentInfo.minOrderQty) {
      logger.debug(
        `Wielkość kontraktu ${theoreticalQuantity} poniżej minimum ${instrumentInfo.minOrderQty}, używam wartości minimalnej`
      );
      return instrumentInfo.minOrderQty;
    }

    const steps = Math.floor(theoreticalQuantity / instrumentInfo.qtyStep);
    const adjustedQuantity = steps * instrumentInfo.qtyStep;

    if (adjustedQuantity < instrumentInfo.minOrderQty) {
      logger.debug(
        `Zaokrąglona wielkość ${adjustedQuantity} poniżej minimum, używam wartości minimalnej`
      );
      return instrumentInfo.minOrderQty;
    }

    const stepStr = instrumentInfo.qtyStep.toString();
    const precision = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;

    return parseFloat(adjustedQuantity.toFixed(precision));
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
    try {
      const { instanceId, type, price, timestamp, trend } = signalData;

      let currentPosition = this.activePositions.get(instanceId);

      const instance = await Instance.findOne({ instanceId });

      if (!instance) {
        logger.error(`Nie znaleziono instancji ${instanceId}`);
        return;
      }

      if (!instance.financials || instance.financials.availableBalance <= 0) {
        logger.warn(
          `Instancja ${instanceId} nie ma dostępnych środków - pominięto sygnał wejścia`
        );
        return;
      }

      const strategyParams = instance.strategy.parameters;

      const firstEntryPercent =
        strategyParams.capitalAllocation?.firstEntry * 100 || 10;
      const secondEntryPercent =
        strategyParams.capitalAllocation?.secondEntry * 100 || 25;
      const thirdEntryPercent =
        strategyParams.capitalAllocation?.thirdEntry * 100 || 50;

      const minEntryTimeGap =
        strategyParams.signals?.minEntryTimeGap || 7200000;

      const currentPrice = await bybitService.getCurrentPrice(instance.symbol);
      const instrumentInfo = await bybitService.getCachedInstrumentInfo(
        instance.symbol
      );

      const leverage = instance.bybitConfig?.leverage || 3;

      if (!currentPosition) {
        const checkEMATrend = strategyParams.signals?.checkEMATrend !== false;

        if (checkEMATrend && !this._isTrendValidForEntry(trend)) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - niewłaściwy trend (${trend})`
          );

          await this.createSignalInDatabase({
            instanceId,
            symbol: instance.symbol,
            type: "entry-rejected",
            subType: "trend-filter",
            price,
            timestamp,
            status: "canceled",
            metadata: { trend },
          });

          return;
        }

        const positionId = `position-${instanceId}-${Date.now()}`;

        const optimalEntry = await this._calculateOptimalContractQuantity(
          firstEntryPercent,
          instance.financials.availableBalance,
          currentPrice,
          leverage,
          instrumentInfo
        );

        logger.info(`
          Pierwsze wejście dla ${instanceId}:
          - Planowana alokacja: ${firstEntryPercent}%
          - Rzeczywista alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%
          - Teoretyczna ilość BTC: ${optimalEntry.theoreticalQuantity}
          - Dostosowana ilość BTC: ${optimalEntry.adjustedQuantity}
        `);

        const signal = await this.createSignalInDatabase({
          instanceId,
          symbol: instance.symbol,
          type: "entry",
          subType: "first",
          price,
          allocation: optimalEntry.actualAllocationPercent / 100,
          amount: optimalEntry.actualMargin,
          timestamp,
          status: "pending",
          metadata: {
            trend,
            positionId,
            theoreticalAllocation: firstEntryPercent / 100,
            theoreticalQuantity: optimalEntry.theoreticalQuantity,
            adjustedQuantity: optimalEntry.adjustedQuantity,
          },
          positionId: positionId,
        });

        try {
          await accountService.lockFundsForPosition(
            instanceId,
            optimalEntry.actualMargin,
            signal._id
          );

          if (instance.bybitConfig && instance.bybitConfig.apiKey) {
            try {
              await bybitService.setLeverage(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                leverage
              );

              await bybitService.setMarginMode(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                instance.bybitConfig.marginMode === "isolated" ? 1 : 0
              );

              const orderResult = await bybitService.openPosition(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                "Buy",
                optimalEntry.adjustedQuantity.toString(),
                0,
                instance.bybitConfig.subaccountId
              );

              logger.info(`ByBit order placed: ${JSON.stringify(orderResult)}`);

              signal.metadata.bybitOrderId = orderResult.result?.orderId;
              signal.metadata.bybitOrderLinkId =
                orderResult.result?.orderLinkId;
              signal.metadata.contractQuantity = optimalEntry.adjustedQuantity;
              await signal.save();
            } catch (error) {
              logger.error(`Error placing ByBit order: ${error.message}`);
            }
          }

          const newPosition = {
            instanceId,
            symbol: instance.symbol,
            positionId: positionId,
            entryTime: timestamp,
            entryPrice: price,
            capitalAllocation: optimalEntry.actualAllocationPercent / 100,
            capitalAmount: optimalEntry.actualMargin,
            status: "active",
            entries: [
              {
                time: timestamp,
                price,
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
          this.lastEntryTimes.set(instanceId, timestamp);
          analysisService.resetTrailingStopTracking(instanceId);

          this.emit("newPosition", newPosition);

          logger.info(
            `Utworzono nową pozycję dla instancji ${instanceId} przy cenie ${price}, alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%, wielkość kontraktu: ${optimalEntry.adjustedQuantity} BTC`
          );
        } catch (error) {
          logger.error(
            `Nie udało się zablokować środków dla pozycji: ${error.message}`
          );

          await Signal.findByIdAndUpdate(signal._id, {
            status: "canceled",
            metadata: {
              cancelReason: `Nie udało się zablokować środków: ${error.message}`,
            },
          });
        }
      } else if (currentPosition.status === "active") {
        const entryCount = currentPosition.entries.length;

        if (entryCount >= 3) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - osiągnięto limit 3 wejść`
          );
          return;
        }

        const lastEntryTime = this.lastEntryTimes.get(instanceId) || 0;

        if (timestamp - lastEntryTime < minEntryTimeGap) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - za mały odstęp czasowy (${((timestamp - lastEntryTime) / 60000).toFixed(1)} min < ${minEntryTimeGap / 60000} min)`
          );
          return;
        }

        const checkEMATrend = strategyParams.signals?.checkEMATrend !== false;

        if (checkEMATrend && !this._isTrendValidForEntry(trend)) {
          logger.info(
            `Ignorowanie sygnału kolejnego wejścia dla instancji ${instanceId} - niewłaściwy trend (${trend})`
          );

          await this.createSignalInDatabase({
            instanceId,
            symbol: instance.symbol,
            type: "entry-rejected",
            subType: `trend-filter-${entryCount + 1}`,
            price,
            timestamp,
            status: "canceled",
            metadata: { trend },
          });

          return;
        }

        const remainingBalance = instance.financials.availableBalance;

        let allocationPercent = 0;
        let entryType = "";

        if (entryCount === 1) {
          allocationPercent = secondEntryPercent;
          entryType = "second";
        } else if (entryCount === 2) {
          allocationPercent = thirdEntryPercent;
          entryType = "third";
        }

        const optimalEntry = await this._calculateOptimalContractQuantity(
          allocationPercent,
          remainingBalance,
          currentPrice,
          leverage,
          instrumentInfo
        );

        logger.info(`
          ${entryType.toUpperCase()} wejście dla ${instanceId}:
          - Pozostały bilans: ${remainingBalance}
          - Planowana alokacja: ${allocationPercent}% z pozostałego kapitału
          - Rzeczywista alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%
          - Teoretyczna ilość BTC: ${optimalEntry.theoreticalQuantity}
          - Dostosowana ilość BTC: ${optimalEntry.adjustedQuantity}
        `);

        const positionId = `position-${instanceId}-${Date.now()}`;

        const signal = await this.createSignalInDatabase({
          instanceId,
          symbol: currentPosition.symbol,
          type: "entry",
          subType: entryType,
          price,
          allocation: optimalEntry.actualAllocationPercent / 100,
          amount: optimalEntry.actualMargin,
          timestamp,
          status: "pending",
          metadata: {
            trend,
            theoreticalAllocation: allocationPercent / 100,
            theoreticalQuantity: optimalEntry.theoreticalQuantity,
            adjustedQuantity: optimalEntry.adjustedQuantity,
          },
          positionId: positionId,
        });

        try {
          await accountService.lockFundsForPosition(
            instanceId,
            optimalEntry.actualMargin,
            signal._id
          );

          if (instance.bybitConfig && instance.bybitConfig.apiKey) {
            try {
              const orderResult = await bybitService.openPosition(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                "Buy",
                optimalEntry.adjustedQuantity.toString(),
                0,
                instance.bybitConfig.subaccountId
              );

              logger.info(`ByBit order placed: ${JSON.stringify(orderResult)}`);

              signal.metadata.bybitOrderId = orderResult.result?.orderId;
              signal.metadata.bybitOrderLinkId =
                orderResult.result?.orderLinkId;
              signal.metadata.contractQuantity = optimalEntry.adjustedQuantity;
              await signal.save();
            } catch (error) {
              logger.error(`Error placing ByBit order: ${error.message}`);
            }
          }

          currentPosition.entries.push({
            time: timestamp,
            price,
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

          this.lastEntryTimes.set(instanceId, timestamp);

          this.emit("positionUpdated", currentPosition);

          logger.info(
            `Dodano ${entryType} wejście do pozycji dla instancji ${instanceId} przy cenie ${price} (alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%, kwota: ${optimalEntry.actualMargin}, wielkość kontraktu: ${optimalEntry.adjustedQuantity} BTC)`
          );
        } catch (error) {
          logger.error(
            `Nie udało się zablokować środków dla dodatkowego wejścia: ${error.message}`
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
  }

  _isTrendValidForEntry(trend) {
    return ["up", "strong_up", "neutral"].includes(trend);
  }

  async processExitSignal(signalData) {
    try {
      const { instanceId, type, price, timestamp, positionId } = signalData;

      const currentPosition = this.activePositions.get(instanceId);

      if (!currentPosition || currentPosition.status !== "active") {
        logger.debug(
          `Ignorowanie sygnału wyjścia dla instancji ${instanceId} - brak aktywnej pozycji`
        );
        return;
      }

      const entryCount = currentPosition.entries.length;
      if (entryCount === 1) {
        const instanceForTimeCheck = await Instance.findOne({ instanceId });
        if (!instanceForTimeCheck) {
          logger.error(`Nie znaleziono instancji ${instanceId} w bazie danych`);
        } else {
          const minFirstEntryDuration =
            instanceForTimeCheck.strategy.parameters.signals
              ?.minFirstEntryDuration || 60 * 60 * 1000;

          const positionDuration = timestamp - currentPosition.entryTime;

          if (positionDuration < minFirstEntryDuration) {
            logger.info(
              `Ignorowanie sygnału wyjścia dla instancji ${instanceId} - pierwsze wejście zbyt świeże (${(positionDuration / 60000).toFixed(1)} min < ${minFirstEntryDuration / 60000} min)`
            );
            return;
          }
        }
      }

      logger.info(`🔹 SYGNAŁ WYJŚCIA dla instancji ${instanceId}`);
      logger.info(
        `📊 Pozycja ma ${currentPosition.entries.length} wejść w pamięci`
      );

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
          instanceForExit.bybitConfig &&
          instanceForExit.bybitConfig.apiKey
        ) {
          try {
            let totalContractQuantity = 0;

            logger.info(
              `[EXIT] Liczba wejść w pozycji pamięci: ${currentPosition.entries.length}`
            );

            for (const entry of currentPosition.entries) {
              logger.info(
                `[EXIT] Entry contractQuantity: ${entry.contractQuantity}`
              );
              if (entry.contractQuantity) {
                totalContractQuantity += parseFloat(entry.contractQuantity);
              }
            }

            logger.info(
              `[EXIT] Całkowita wielkość z pamięci: ${totalContractQuantity}`
            );

            if (totalContractQuantity === 0) {
              logger.warn(
                `[EXIT] Brak contractQuantity w pamięci, sprawdzam wszystkie sygnały dla instancji`
              );

              const allEntrySignals = await Signal.find({
                instanceId,
                type: "entry",
                status: "executed",
                timestamp: {
                  $gte: currentPosition.entryTime - 24 * 60 * 60 * 1000,
                  $lte: timestamp,
                },
              }).sort({ timestamp: 1 });

              logger.info(
                `[EXIT] Znaleziono ${allEntrySignals.length} wykonanych sygnałów wejścia w bazie`
              );

              for (const signal of allEntrySignals) {
                const contractQty = signal.metadata?.contractQuantity || 0;
                logger.info(
                  `[EXIT] Signal ${signal._id}: contractQuantity=${contractQty}, positionId=${signal.positionId}`
                );
                if (contractQty > 0) {
                  totalContractQuantity += parseFloat(contractQty);
                }
              }

              logger.info(
                `[EXIT] Całkowita wielkość z bazy danych: ${totalContractQuantity}`
              );
            }

            if (totalContractQuantity === 0) {
              logger.warn(
                `[EXIT] Nadal brak contractQuantity, pobieranie z ByBit API`
              );

              try {
                const positionSize = await bybitService.getPositionSize(
                  instanceForExit.bybitConfig.apiKey,
                  instanceForExit.bybitConfig.apiSecret,
                  instanceForExit.symbol,
                  instanceForExit.bybitConfig.subaccountId
                );
                totalContractQuantity = positionSize;
                logger.info(
                  `[EXIT] Pobrано z ByBit rzeczywistą wielkość: ${totalContractQuantity}`
                );
              } catch (apiError) {
                logger.error(
                  `[EXIT] Błąd podczas pobierania wielkości z ByBit: ${apiError.message}`
                );
                const currentPrice = await bybitService.getCurrentPrice(
                  instanceForExit.symbol
                );
                const positionValue =
                  totalEntryAmount * instanceForExit.bybitConfig.leverage;
                const instrumentInfo =
                  await bybitService.getCachedInstrumentInfo(
                    instanceForExit.symbol
                  );
                const theoreticalQuantity = positionValue / currentPrice;
                totalContractQuantity = await this._adjustContractQuantity(
                  theoreticalQuantity,
                  instrumentInfo
                );
                logger.info(
                  `[EXIT] Obliczona wielkość kontraktu: ${totalContractQuantity}`
                );
              }
            }

            logger.info(
              `[EXIT] Próba zamknięcia pozycji na ByBit: symbol=${instanceForExit.symbol}, quantity=${totalContractQuantity}`
            );

            const orderResult = await bybitService.closePosition(
              instanceForExit.bybitConfig.apiKey,
              instanceForExit.bybitConfig.apiSecret,
              instanceForExit.symbol,
              "Buy",
              totalContractQuantity.toString(),
              0,
              instanceForExit.bybitConfig.subaccountId
            );

            logger.info(
              `[EXIT] ByBit close order placed: ${JSON.stringify(orderResult)}`
            );

            exitSignal.metadata.bybitOrderId = orderResult.result?.orderId;
            exitSignal.metadata.bybitOrderLinkId =
              orderResult.result?.orderLinkId;
            exitSignal.metadata.contractQuantity = totalContractQuantity;
            await exitSignal.save();
          } catch (error) {
            logger.error(
              `[EXIT] Error closing ByBit position: ${error.message}`
            );
            logger.error(`[EXIT] Error stack: ${error.stack}`);
          }
        } else {
          logger.warn(
            `[EXIT] Brak konfiguracji ByBit dla instancji ${instanceId}`
          );
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

        this.activePositions.delete(instanceId);

        this.lastEntryTimes.delete(instanceId);

        this.emit("positionClosed", currentPosition);

        logger.info(
          `Zamknięto pozycję dla instancji ${instanceId} przy cenie ${price} (zysk: ${profitPercent.toFixed(2)}%, kwota: ${profit.toFixed(2)}, typ: ${type})`
        );

        const instanceForSync = await Instance.findOne({ instanceId });
        if (
          instanceForSync &&
          instanceForSync.bybitConfig &&
          instanceForSync.bybitConfig.apiKey &&
          !instanceForSync.testMode
        ) {
          logger.info(
            `Synchronizacja salda po zamknięciu pozycji dla instancji ${instanceId}...`
          );

          setTimeout(async () => {
            try {
              await instanceService.syncInstanceBalance(instanceId);
            } catch (error) {
              logger.error(
                `Błąd podczas synchronizacji salda po zamknięciu pozycji: ${error.message}`
              );
            }
          }, 2000);
        }

        return exitSignal;
      } catch (error) {
        logger.error(`Nie udało się sfinalizować pozycji: ${error.message}`);

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
module.exports = signalService;
