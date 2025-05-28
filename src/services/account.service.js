const User = require("../models/user.model");
const Instance = require("../models/instance.model");
const Signal = require("../models/signal.model");
const logger = require("../utils/logger");
const TradingLogger = require("../utils/trading-logger");
const dbService = require("./db.service");
const { EventEmitter } = require("events");

class AccountService extends EventEmitter {
  constructor() {
    super();
  }

  async addFundsToUser(userId, amount) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      if (amount <= 0) {
        throw new Error("Kwota musi być większa od zera");
      }

      if (!user.financials) {
        user.financials = {
          balance: 0,
          totalProfit: 0,
          totalTrades: 0,
          successfulTrades: 0,
          tradeHistory: [],
        };
      }

      user.financials.balance += amount;
      await user.save();

      logger.info(`Dodano ${amount} środków do konta użytkownika ${userId}`);
      this.emit("fundsAdded", {
        userId,
        amount,
        newBalance: user.financials.balance,
      });

      return user;
    } catch (error) {
      logger.error(`Błąd podczas dodawania środków: ${error.message}`);
      throw error;
    }
  }

  async allocateCapitalToInstance(userId, instanceId, amount) {
    return await dbService.withTransaction(async (session) => {
      try {
        const user = await User.findById(userId).session(session);
        const instance = await Instance.findById(instanceId).session(session);

        if (!user) throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
        if (!instance)
          throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
        if (amount <= 0)
          throw new Error("Kwota alokacji musi być większa od zera");

        if (!user.financials || user.financials.balance < amount) {
          throw new Error(
            `Niewystarczające środki. Dostępne: ${user.financials ? user.financials.balance : 0}, Wymagane: ${amount}`
          );
        }

        user.financials.balance -= amount;
        await user.save({ session });

        if (!instance.financials) {
          instance.financials = {
            allocatedCapital: 0,
            currentBalance: 0,
            availableBalance: 0,
            lockedBalance: 0,
            totalProfit: 0,
            userId: user._id,
            openPositions: [],
            closedPositions: [],
          };
        }

        instance.financials.allocatedCapital += amount;
        instance.financials.currentBalance += amount;
        instance.financials.availableBalance += amount;
        instance.financials.userId = user._id;

        await instance.save({ session });

        logger.info(
          `Alokowano ${amount} kapitału do instancji ${instanceId} użytkownika ${userId}`
        );
        this.emit("capitalAllocated", {
          userId,
          instanceId,
          amount,
          userBalance: user.financials.balance,
          instanceBalance: instance.financials.currentBalance,
        });

        return instance;
      } catch (error) {
        logger.error(`Błąd podczas alokacji kapitału: ${error.message}`);
        throw error;
      }
    });
  }

  async lockFundsForPosition(instanceId, amount, signalId) {
    return await dbService.withTransaction(async (session) => {
      try {
        const instance = await Instance.findOne({ instanceId }).session(
          session
        );
        if (!instance) {
          throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
        }

        if (!instance.financials) {
          throw new Error(
            `Instancja ${instanceId} nie ma zainicjalizowanych danych finansowych`
          );
        }

        if (instance.financials.availableBalance < amount) {
          throw new Error(
            `Niewystarczające środki w instancji. Dostępne: ${instance.financials.availableBalance}, Wymagane: ${amount}`
          );
        }

        if (!instance.financials.openPositions) {
          instance.financials.openPositions = [];
        }

        const signalService = require("./signal.service");
        const activePosition = signalService.getActivePositions(instanceId);

        let positionId;
        let entryType = "first";

        if (activePosition && activePosition.positionId) {
          positionId = activePosition.positionId;
          entryType = activePosition.entries.length === 1 ? "second" : "third";

          let positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );

          if (positionIndex !== -1) {
            instance.financials.openPositions[positionIndex].entrySignals.push({
              signalId,
              amount,
              timestamp: new Date(),
              subType: entryType,
            });
            instance.financials.openPositions[positionIndex].totalAmount +=
              amount;
          } else {
            instance.financials.openPositions.push({
              positionId,
              entrySignals: [
                { signalId, amount, timestamp: new Date(), subType: entryType },
              ],
              totalAmount: amount,
              firstEntryTime: new Date(),
            });
          }
        } else {
          const signal = await Signal.findById(signalId).session(session);
          if (signal && signal.positionId) {
            positionId = signal.positionId;
          } else {
            positionId = `position-${instanceId}-${Date.now()}`;
          }

          instance.financials.openPositions.push({
            positionId,
            entrySignals: [
              { signalId, amount, timestamp: new Date(), subType: "first" },
            ],
            totalAmount: amount,
            firstEntryTime: new Date(),
          });
        }

        instance.financials.availableBalance -= amount;
        instance.financials.lockedBalance += amount;

        await instance.save({ session });

        const signal = await Signal.findById(signalId).session(session);
        if (signal) {
          signal.amount = amount;
          signal.status = "executed";
          signal.executedAt = new Date();
          signal.positionId = positionId;
          await signal.save({ session });
        }

        // Tylko jeden log dla każdego wejścia w pozycję
        logger.debug(
          `Zablokowano ${amount} środków dla pozycji ${positionId} (${entryType} entry)`
        );

        this.emit("fundsLocked", {
          instanceId,
          signalId,
          positionId,
          amount,
          availableBalance: instance.financials.availableBalance,
          lockedBalance: instance.financials.lockedBalance,
        });

        return instance;
      } catch (error) {
        logger.error(`Błąd podczas blokowania środków: ${error.message}`);
        throw error;
      }
    });
  }

  async finalizePosition(
    instanceId,
    entrySignalId,
    exitSignalId,
    entryAmount,
    exitAmount
  ) {
    const signalService = require("./signal.service");

    return await dbService.withTransaction(async (session) => {
      try {
        const instance = await Instance.findOne({ instanceId }).session(
          session
        );
        if (!instance) {
          throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
        }

        if (!instance.financials) {
          throw new Error(
            `Instancja ${instanceId} nie ma zainicjalizowanych danych finansowych`
          );
        }

        const activePosition = signalService.getActivePositions(instanceId);
        let position = null;
        let positionIndex = -1;
        let totalEntryAmount = entryAmount;

        if (!instance.financials.openPositions) {
          instance.financials.openPositions = [];
        }

        // Znajdź pozycję po positionId z pamięci RAM
        if (activePosition && activePosition.positionId) {
          const positionId = activePosition.positionId;
          positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );

          if (positionIndex !== -1) {
            position = instance.financials.openPositions[positionIndex];
            totalEntryAmount =
              position.totalAmount ||
              position.entrySignals?.reduce(
                (sum, entry) => sum + (entry.amount || 0),
                0
              ) ||
              0;

            if (activePosition.entries && activePosition.entries.length > 0) {
              const ramTotal = activePosition.entries.reduce(
                (sum, entry) => sum + (entry.amount || 0),
                0
              );
              if (ramTotal > totalEntryAmount) {
                totalEntryAmount = ramTotal;
              }
            }
          }
        }

        // Fallback - szukaj wszystkich wejść dla tej instancji
        if (!position) {
          const timeWindow = 24 * 60 * 60 * 1000;
          const searchStartTime = Date.now() - timeWindow;

          const allEntrySignals = await Signal.find({
            instanceId: instanceId,
            type: "entry",
            status: "executed",
            timestamp: { $gte: searchStartTime },
          })
            .sort({ timestamp: 1 })
            .session(session);

          if (allEntrySignals.length > 0) {
            const positionGroups = new Map();
            for (const signal of allEntrySignals) {
              const groupKey = signal.positionId || "default-group";
              if (!positionGroups.has(groupKey)) {
                positionGroups.set(groupKey, []);
              }
              positionGroups.get(groupKey).push(signal);
            }

            let largestGroup = [];
            let largestGroupKey = null;
            for (const [groupKey, signals] of positionGroups.entries()) {
              if (signals.length > largestGroup.length) {
                largestGroup = signals;
                largestGroupKey = groupKey;
              }
            }

            const firstEntry = largestGroup[0];
            const lastEntry = largestGroup[largestGroup.length - 1];

            const exitSignalsBetween = await Signal.find({
              instanceId: instanceId,
              type: "exit",
              status: "executed",
              timestamp: {
                $gte: firstEntry.timestamp,
                $lte: lastEntry.timestamp + 60000,
              },
            }).session(session);

            if (exitSignalsBetween.length === 0) {
              totalEntryAmount = largestGroup.reduce(
                (sum, signal) => sum + (signal.amount || 0),
                0
              );

              const reconstructedPosition = {
                positionId: largestGroupKey,
                entrySignals: largestGroup.map((signal) => ({
                  signalId: signal._id.toString(),
                  amount: signal.amount || 0,
                  timestamp: new Date(signal.timestamp),
                  subType: signal.subType || "unknown",
                })),
                totalAmount: totalEntryAmount,
                firstEntryTime: new Date(firstEntry.timestamp),
              };

              instance.financials.openPositions.push(reconstructedPosition);
              positionIndex = instance.financials.openPositions.length - 1;
              position = reconstructedPosition;
            }
          }
        }

        // Ostateczny fallback - użyj danych z pamięci RAM
        if (!position && activePosition) {
          if (activePosition.entries && activePosition.entries.length > 0) {
            totalEntryAmount = activePosition.entries.reduce(
              (sum, entry) => sum + (entry.amount || 0),
              0
            );

            const fallbackPosition = {
              positionId:
                activePosition.positionId ||
                `fallback-${instanceId}-${Date.now()}`,
              entrySignals: activePosition.entries.map((entry) => ({
                signalId: entry.signalId || `unknown-${Date.now()}`,
                amount: entry.amount || 0,
                timestamp: new Date(entry.time || Date.now()),
                subType: entry.type || "unknown",
              })),
              totalAmount: totalEntryAmount,
              firstEntryTime: new Date(activePosition.entryTime || Date.now()),
            };

            instance.financials.openPositions.push(fallbackPosition);
            positionIndex = instance.financials.openPositions.length - 1;
            position = fallbackPosition;
          }
        }

        if (!position) {
          throw new Error(
            `Nie znaleziono otwartej pozycji dla instancji ${instanceId}`
          );
        }

        const profit = exitAmount - totalEntryAmount;
        const profitPercent = (profit / totalEntryAmount) * 100;

        // Tylko jeden główny log finalizacji pozycji
        logger.debug(
          `Finalizacja pozycji ${position.positionId}: entry=${totalEntryAmount}, exit=${exitAmount}, profit=${profit.toFixed(2)}`
        );

        const positionDetails = JSON.parse(JSON.stringify(position));
        instance.financials.openPositions.splice(positionIndex, 1);

        if (!instance.financials.closedPositions) {
          instance.financials.closedPositions = [];
        }

        instance.financials.closedPositions.push({
          positionId: position.positionId,
          entrySignals: position.entrySignals,
          exitSignalId,
          totalEntryAmount,
          exitAmount,
          profit,
          closedAt: new Date(),
        });

        instance.financials.lockedBalance -= totalEntryAmount;
        instance.financials.availableBalance += exitAmount;
        instance.financials.currentBalance =
          instance.financials.availableBalance +
          instance.financials.lockedBalance;
        instance.financials.totalProfit += profit;

        await instance.save({ session });

        const exitSignal = await Signal.findById(exitSignalId).session(session);
        if (exitSignal) {
          exitSignal.profit = profit;
          exitSignal.profitPercent = profitPercent;
          exitSignal.exitAmount = exitAmount;
          exitSignal.status = "executed";
          exitSignal.executedAt = new Date();
          exitSignal.positionId = position.positionId;

          if (position.entrySignals && position.entrySignals.length > 0) {
            exitSignal.entrySignalIds = position.entrySignals.map(
              (entry) => entry.signalId
            );
            exitSignal.entrySignalId = position.entrySignals[0].signalId;
          } else if (entrySignalId) {
            exitSignal.entrySignalId = entrySignalId;
          }

          await exitSignal.save({ session });
        }

        const user = await User.findById(instance.financials.userId).session(
          session
        );
        if (user) {
          if (!user.financials) {
            user.financials = {
              balance: 0,
              totalProfit: 0,
              totalTrades: 0,
              successfulTrades: 0,
              tradeHistory: [],
            };
          }

          let entryPrice = 0;
          let exitPrice = 0;

          if (position.entrySignals && position.entrySignals.length > 0) {
            const firstEntrySignalId = position.entrySignals[0].signalId;
            const entrySignal =
              await Signal.findById(firstEntrySignalId).session(session);
            if (entrySignal) {
              entryPrice = entrySignal.price;
            }
          }

          if (exitSignal) {
            exitPrice = exitSignal.price;
          }

          user.financials.tradeHistory.push({
            instanceId,
            symbol: instance.symbol || "UNKNOWN",
            entryTime: position.firstEntryTime || new Date(),
            exitTime: new Date(),
            entryPrice: entryPrice,
            exitPrice: exitPrice,
            amount: totalEntryAmount,
            profit,
            profitPercent,
            signalIds: [
              ...(position.entrySignals
                ? position.entrySignals.map((e) => e.signalId)
                : []),
              exitSignalId,
            ],
          });

          user.financials.totalProfit += profit;
          user.financials.totalTrades += 1;

          if (profit > 0) {
            user.financials.successfulTrades += 1;
          }

          user.financials.lastTradeDate = new Date();
          await user.save({ session });
        }

        // Sprawdź spójność lockedBalance
        const actualLockedAmount = instance.financials.openPositions
          ? instance.financials.openPositions.reduce(
              (sum, pos) => sum + (pos.totalAmount || 0),
              0
            )
          : 0;

        if (
          Math.abs(instance.financials.lockedBalance - actualLockedAmount) >
          0.01
        ) {
          const difference =
            instance.financials.lockedBalance - actualLockedAmount;
          instance.financials.lockedBalance = actualLockedAmount;
          instance.financials.availableBalance += difference;
          instance.financials.currentBalance =
            instance.financials.availableBalance +
            instance.financials.lockedBalance;
          await instance.save({ session });
        }

        this.emit("positionClosed", {
          instanceId,
          positionId: position.positionId,
          entrySignals: position.entrySignals,
          exitSignalId,
          totalEntryAmount,
          exitAmount,
          profit,
          profitPercent,
          userId: instance.financials.userId,
        });

        return { instance, user };
      } catch (error) {
        logger.error(`Błąd podczas finalizacji pozycji: ${error.message}`);
        throw error;
      }
    });
  }

  async getUserBalance(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      const instances = await Instance.find({ "financials.userId": userId });

      let totalAllocated = 0;
      let totalCurrent = 0;

      for (const instance of instances) {
        if (instance.financials) {
          totalAllocated += instance.financials.allocatedCapital || 0;
          totalCurrent += instance.financials.currentBalance || 0;
        }
      }

      return {
        userId,
        balance: user.financials ? user.financials.balance : 0,
        totalAllocated,
        totalCurrent,
        totalProfit: user.financials ? user.financials.totalProfit : 0,
        winRate: user.financials
          ? user.financials.totalTrades > 0
            ? (user.financials.successfulTrades / user.financials.totalTrades) *
              100
            : 0
          : 0,
        totalTrades: user.financials ? user.financials.totalTrades : 0,
        instances: instances.map((i) => ({
          id: i._id,
          name: i.name,
          symbol: i.symbol,
          allocatedCapital: i.financials ? i.financials.allocatedCapital : 0,
          currentBalance: i.financials ? i.financials.currentBalance : 0,
          availableBalance: i.financials ? i.financials.availableBalance : 0,
          lockedBalance: i.financials ? i.financials.lockedBalance : 0,
          profit: i.financials ? i.financials.totalProfit : 0,
          openPositions: i.financials ? i.financials.openPositions.length : 0,
          active: i.active,
        })),
      };
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania salda użytkownika: ${error.message}`
      );
      throw error;
    }
  }

  async getUserTradeHistory(userId, limit = 50, skip = 0) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      if (!user.financials || !user.financials.tradeHistory) {
        return [];
      }

      const sortedHistory = user.financials.tradeHistory
        .sort((a, b) => b.exitTime - a.exitTime)
        .slice(skip, skip + limit);

      return sortedHistory;
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania historii transakcji: ${error.message}`
      );
      throw error;
    }
  }

  async getInstanceFinancialDetails(instanceId) {
    try {
      const instance = await Instance.findById(instanceId);
      if (!instance) {
        throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
      }

      const activeSignals = await Signal.find({
        instanceId,
        type: "entry",
        status: "executed",
        _id: {
          $in:
            instance.financials && instance.financials.openPositions
              ? instance.financials.openPositions.map((p) => p.signalId)
              : [],
        },
      });

      const historicalSignals = await Signal.find({
        instanceId,
        type: "exit",
        status: "executed",
      })
        .sort({ timestamp: -1 })
        .limit(50);

      return {
        instanceId,
        name: instance.name,
        symbol: instance.symbol,
        active: instance.active,
        financials: instance.financials || {
          allocatedCapital: 0,
          currentBalance: 0,
          availableBalance: 0,
          lockedBalance: 0,
          totalProfit: 0,
        },
        activePositions: activeSignals.map((signal) => ({
          signalId: signal._id,
          price: signal.price,
          amount: signal.amount,
          allocation: signal.allocation,
          timestamp: signal.timestamp,
          createdAt: signal.createdAt,
        })),
        tradeHistory: historicalSignals.map((signal) => ({
          exitSignalId: signal._id,
          entrySignalId: signal.entrySignalId,
          exitPrice: signal.price,
          profit: signal.profit,
          profitPercent: signal.profitPercent,
          timestamp: signal.timestamp,
          closedAt: signal.executedAt || signal.createdAt,
        })),
      };
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania szczegółów instancji: ${error.message}`
      );
      throw error;
    }
  }
}

const accountService = new AccountService();
module.exports = accountService;
