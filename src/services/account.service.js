/**
 * Account Service - serwis zarządzania środkami
 *
 * Odpowiedzialny za:
 * - Zarządzanie środkami użytkownika
 * - Alokację kapitału do instancji
 * - Śledzenie pozycji i aktualizację bilansów
 * - Obliczanie zysków i strat
 * - Przechowywanie historii transakcji
 */

const User = require("../models/user.model");
const Instance = require("../models/instance.model");
const Signal = require("../models/signal.model");
const logger = require("../utils/logger");
const dbService = require("./db.service");
const { EventEmitter } = require("events");

class AccountService extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Dodaje środki do konta użytkownika
   * @param {string} userId - ID użytkownika
   * @param {number} amount - Kwota do dodania
   * @returns {Promise<Object>} - Zaktualizowany użytkownik
   */
  async addFundsToUser(userId, amount) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      if (amount <= 0) {
        throw new Error("Kwota musi być większa od zera");
      }

      // Inicjalizuj financials, jeśli nie istnieje
      if (!user.financials) {
        user.financials = {
          balance: 0,
          totalProfit: 0,
          totalTrades: 0,
          successfulTrades: 0,
          tradeHistory: [],
        };
      }

      // Dodaj środki do bilansu
      user.financials.balance += amount;
      await user.save();

      logger.info(`Dodano ${amount} środków do konta użytkownika ${userId}`);

      // Emituj zdarzenie
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

  /**
   * Alokuje kapitał do instancji
   * @param {string} userId - ID użytkownika
   * @param {string} instanceId - ID instancji
   * @param {number} amount - Kwota do alokacji
   * @returns {Promise<Object>} - Zaktualizowana instancja
   */
  async allocateCapitalToInstance(userId, instanceId, amount) {
    return await dbService.withTransaction(async (session) => {
      try {
        // Pobierz użytkownika i instancję
        const user = await User.findById(userId).session(session);
        const instance = await Instance.findById(instanceId).session(session);

        if (!user) {
          throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
        }

        if (!instance) {
          throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
        }

        if (amount <= 0) {
          throw new Error("Kwota alokacji musi być większa od zera");
        }

        // Sprawdź, czy użytkownik ma wystarczające środki
        if (!user.financials || user.financials.balance < amount) {
          throw new Error(
            `Niewystarczające środki. Dostępne: ${user.financials ? user.financials.balance : 0}, Wymagane: ${amount}`
          );
        }

        // Odejmij środki z konta użytkownika
        user.financials.balance -= amount;
        await user.save({ session });

        // Inicjalizuj financials dla instancji, jeśli nie istnieje
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

        // Aktualizuj kapitał instancji
        instance.financials.allocatedCapital += amount;
        instance.financials.currentBalance += amount;
        instance.financials.availableBalance += amount;

        // Upewnij się, że instancja ma przypisanego użytkownika
        instance.financials.userId = user._id;

        await instance.save({ session });

        logger.info(
          `Alokowano ${amount} kapitału do instancji ${instanceId} użytkownika ${userId}`
        );

        // Emituj zdarzenie
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

  /**
   * Blokuje środki na pozycję
   * @param {string} instanceId - ID instancji
   * @param {number} amount - Kwota do zablokowania
   * @param {string} signalId - ID sygnału wejścia
   * @returns {Promise<Object>} - Zaktualizowana instancja
   */
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

        // Sprawdź dostępne środki
        if (instance.financials.availableBalance < amount) {
          throw new Error(
            `Niewystarczające środki w instancji. Dostępne: ${instance.financials.availableBalance}, Wymagane: ${amount}`
          );
        }

        // Inicjalizuj tablicę openPositions, jeśli nie istnieje
        if (!instance.financials.openPositions) {
          instance.financials.openPositions = [];
        }

        // Pobierz aktywną pozycję z pamięci
        const signalService = require("./signal.service");
        const activePosition = signalService.getActivePositions(instanceId);

        let positionId;
        let entryType = "first";

        // Sprawdź, czy mamy już otwartą pozycję dla tej instancji
        if (activePosition) {
          // To jest kolejne wejście - użyj istniejącego ID pozycji
          positionId = activePosition.positionId || `position-${instanceId}`;
          entryType = activePosition.entries.length === 1 ? "second" : "third";

          // Znajdź istniejącą pozycję w bazie danych
          const positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );

          if (positionIndex !== -1) {
            // Dodaj nowy sygnał do istniejącej pozycji
            instance.financials.openPositions[positionIndex].entrySignals.push({
              signalId,
              amount,
              timestamp: new Date(),
              subType: entryType,
            });
            instance.financials.openPositions[positionIndex].totalAmount +=
              amount;

            logger.info(
              `Dodano kolejny sygnał wejścia do istniejącej pozycji: ${positionId}, typ: ${entryType}`
            );
          } else {
            // Utwórz nową pozycję, jeśli nie znaleziono (sytuacja niestandardowa)
            instance.financials.openPositions.push({
              positionId,
              entrySignals: [
                {
                  signalId,
                  amount,
                  timestamp: new Date(),
                  subType: entryType,
                },
              ],
              totalAmount: amount,
              firstEntryTime: new Date(),
            });

            logger.info(
              `Utworzono nową pozycję (mimo że istnieje w pamięci): ${positionId}, typ: ${entryType}`
            );
          }
        } else {
          // To pierwsze wejście - utwórz nową pozycję
          positionId = `position-${instanceId}-${Date.now()}`;

          instance.financials.openPositions.push({
            positionId,
            entrySignals: [
              {
                signalId,
                amount,
                timestamp: new Date(),
                subType: "first",
              },
            ],
            totalAmount: amount,
            firstEntryTime: new Date(),
          });

          logger.info(`Utworzono nową pozycję handlową: ${positionId}`);
        }

        // Aktualizuj bilans instancji
        instance.financials.availableBalance -= amount;
        instance.financials.lockedBalance += amount;

        await instance.save({ session });

        // Pobierz i zaktualizuj sygnał
        const signal = await Signal.findById(signalId).session(session);
        if (signal) {
          signal.amount = amount;
          signal.status = "executed";
          signal.executedAt = new Date();
          signal.positionId = positionId; // Dodaj referencję do pozycji
          await signal.save({ session });
        }

        logger.info(
          `Zablokowano ${amount} środków w instancji ${instanceId} dla sygnału ${signalId}, pozycja: ${positionId}`
        );

        // Emituj zdarzenie
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

  /**
   * Aktualizuje bilans po zamknięciu pozycji
   * @param {string} instanceId - ID instancji
   * @param {string} entrySignalId - ID sygnału wejścia lub null jeśli używamy positionId
   * @param {string} exitSignalId - ID sygnału wyjścia
   * @param {number} entryAmount - Kwota wejścia (używana tylko jeśli nie znaleziono pozycji)
   * @param {number} exitAmount - Kwota wyjścia (z zyskiem/stratą)
   * @returns {Promise<Object>} - Zaktualizowana instancja i użytkownik
   */
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

        // Pobierz aktywną pozycję z pamięci
        const activePosition = signalService.getActivePositions(instanceId);
        logger.debug(
          `Aktywna pozycja z pamięci RAM: ${activePosition ? JSON.stringify(activePosition) : "brak"}`
        );

        // Przygotuj się do wyszukania pozycji w bazie
        let positionId = null;
        if (activePosition) {
          positionId = activePosition.positionId;
          logger.debug(`Znaleziono ID pozycji w pamięci RAM: ${positionId}`);
        }

        // Znajdź pozycję w instancji
        let position = null;
        let positionIndex = -1;

        // Inicjalizuj openPositions, jeśli nie istnieje
        if (!instance.financials.openPositions) {
          instance.financials.openPositions = [];
        }

        logger.debug(
          `Liczba otwartych pozycji w bazie: ${instance.financials.openPositions.length}`
        );

        // Jeśli mamy positionId, znajdź pozycję po tym ID
        if (positionId) {
          positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );
          if (positionIndex !== -1) {
            position = instance.financials.openPositions[positionIndex];
            logger.info(
              `Znaleziono pozycję po ID pozycji: ${positionId}, indeks: ${positionIndex}`
            );
          }
        }

        // Jeśli nie znaleziono po positionId, spróbuj znaleźć po ID sygnału
        if (!position && entrySignalId) {
          for (let i = 0; i < instance.financials.openPositions.length; i++) {
            const pos = instance.financials.openPositions[i];
            const foundSignal =
              pos.entrySignals &&
              pos.entrySignals.some(
                (entry) =>
                  entry.signalId === entrySignalId ||
                  String(entry.signalId) === String(entrySignalId)
              );

            if (foundSignal) {
              position = pos;
              positionIndex = i;
              logger.info(
                `Znaleziono pozycję po ID sygnału wejścia: ${entrySignalId}, indeks: ${i}`
              );
              break;
            }
          }
        }

        // Jeśli nadal nie znaleziono, a mamy aktywną pozycję w pamięci, odtwórz ją
        if (
          !position &&
          activePosition &&
          activePosition.entries &&
          activePosition.entries.length > 0
        ) {
          logger.info(
            `Odtwarzanie pozycji z pamięci RAM dla instancji ${instanceId}`
          );

          // Utwórz nową pozycję bazując na danych z pamięci
          const totalEntryAmount = activePosition.entries.reduce(
            (sum, entry) => sum + (entry.amount || 0),
            0
          );
          const newPosition = {
            positionId:
              activePosition.positionId ||
              `position-${instanceId}-${Date.now()}`,
            entrySignals: activePosition.entries.map((entry) => ({
              signalId: entry.signalId,
              amount:
                entry.amount || entryAmount / activePosition.entries.length,
              timestamp: new Date(entry.time || Date.now()),
              subType: entry.type || "first",
            })),
            totalAmount: totalEntryAmount || entryAmount,
            firstEntryTime: new Date(activePosition.entryTime || Date.now()),
          };

          // Dodaj pozycję do instancji
          instance.financials.openPositions.push(newPosition);
          positionIndex = instance.financials.openPositions.length - 1;
          position = newPosition;

          logger.info(
            `Odtworzono pozycję w bazie danych: ${JSON.stringify(newPosition)}`
          );
        }

        // Jeśli nadal nie mamy pozycji, rzuć błąd
        if (!position) {
          throw new Error(
            `Nie znaleziono otwartej pozycji dla instancji ${instanceId}`
          );
        }

        // Oblicz łączną kwotę wejść
        // Upewnij się, że używamy totalAmount do obliczenia rzeczywistej kwoty wejść
        const totalEntryAmount =
          position.totalAmount ||
          position.entrySignals.reduce((sum, entry) => sum + entry.amount, 0) ||
          entryAmount;

        // Oblicz zysk na podstawie rzeczywistej kwoty wejść i kwoty wyjścia
        const profit = exitAmount - totalEntryAmount;
        const profitPercent = (profit / totalEntryAmount) * 100;

        logger.info(
          `Finalizacja pozycji: entryAmount=${totalEntryAmount}, exitAmount=${exitAmount}, profit=${profit}, profitPercent=${profitPercent}`
        );

        // Pobierz szczegóły pozycji przed usunięciem
        const positionDetails = JSON.parse(JSON.stringify(position));

        // Usuń pozycję z otwartych
        instance.financials.openPositions.splice(positionIndex, 1);

        // Dodaj do zamkniętych pozycji
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

        // Aktualizuj bilans instancji
        instance.financials.lockedBalance -= totalEntryAmount;
        instance.financials.availableBalance += exitAmount;
        instance.financials.currentBalance =
          instance.financials.availableBalance +
          instance.financials.lockedBalance;
        instance.financials.totalProfit += profit;

        await instance.save({ session });

        // Pobierz i zaktualizuj sygnał wyjścia
        const exitSignal = await Signal.findById(exitSignalId).session(session);
        if (exitSignal) {
          exitSignal.profit = profit;
          exitSignal.profitPercent = profitPercent;
          exitSignal.exitAmount = exitAmount;
          exitSignal.status = "executed";
          exitSignal.executedAt = new Date();
          exitSignal.positionId = position.positionId;

          // Dodaj referencje do wszystkich sygnałów wejścia
          if (position.entrySignals && position.entrySignals.length > 0) {
            exitSignal.entrySignalIds = position.entrySignals.map(
              (entry) => entry.signalId
            );
            // Dla zachowania kompatybilności wstecz
            exitSignal.entrySignalId = position.entrySignals[0].signalId;
          } else if (entrySignalId) {
            exitSignal.entrySignalId = entrySignalId;
          }

          await exitSignal.save({ session });
        }

        // Aktualizuj dane użytkownika
        const user = await User.findById(instance.financials.userId).session(
          session
        );

        if (user) {
          // Inicjalizuj financials, jeśli nie istnieje
          if (!user.financials) {
            user.financials = {
              balance: 0,
              totalProfit: 0,
              totalTrades: 0,
              successfulTrades: 0,
              tradeHistory: [],
            };
          }

          // Pobierz sygnały, aby uzyskać więcej informacji
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

          // Dodaj transakcję do historii użytkownika
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

          // Aktualizuj statystyki użytkownika
          user.financials.totalProfit += profit;
          user.financials.totalTrades += 1;

          if (profit > 0) {
            user.financials.successfulTrades += 1;
          }

          user.financials.lastTradeDate = new Date();

          await user.save({ session });
        }

        logger.info(
          `Sfinalizowano pozycję w instancji ${instanceId}. Zysk: ${profit}`
        );

        // SIMPLE SAFETY CHECK: Jeśli nie ma otwartych pozycji, wyzeruj lockedBalance
        if (
          !instance.financials.openPositions ||
          instance.financials.openPositions.length === 0
        ) {
          if (instance.financials.lockedBalance > 0.01) {
            logger.warn(
              `Wykryto wiszący lockedBalance (${instance.financials.lockedBalance}) bez otwartych pozycji dla instancji ${instanceId}. Wykonuję korektę.`
            );

            instance.financials.availableBalance +=
              instance.financials.lockedBalance;
            instance.financials.lockedBalance = 0;
            instance.financials.currentBalance =
              instance.financials.availableBalance;

            await instance.save({ session });

            logger.info(
              `Skorygowano lockedBalance dla instancji ${instanceId} - uwolniono wiszące środki`
            );
          }
        }

        // Emituj zdarzenie
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

  /**
   * Pobiera informacje o saldzie użytkownika
   * @param {string} userId - ID użytkownika
   * @returns {Promise<Object>} - Informacje o saldzie
   */
  async getUserBalance(userId) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      // Pobierz wszystkie instancje użytkownika
      const instances = await Instance.find({ "financials.userId": userId });

      // Oblicz całkowity zaalokowany kapitał i bieżący bilans
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

  /**
   * Pobiera historię transakcji użytkownika
   * @param {string} userId - ID użytkownika
   * @param {number} limit - Limit wyników
   * @param {number} skip - Liczba pominiętych wyników
   * @returns {Promise<Array>} - Historia transakcji
   */
  async getUserTradeHistory(userId, limit = 50, skip = 0) {
    try {
      const user = await User.findById(userId);

      if (!user) {
        throw new Error(`Użytkownik o ID ${userId} nie istnieje`);
      }

      if (!user.financials || !user.financials.tradeHistory) {
        return [];
      }

      // Sortuj według daty zamknięcia (od najnowszych)
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

  /**
   * Pobiera szczegóły instancji z perspektywy finansowej
   * @param {string} instanceId - ID instancji
   * @returns {Promise<Object>} - Szczegóły instancji
   */
  async getInstanceFinancialDetails(instanceId) {
    try {
      const instance = await Instance.findById(instanceId);

      if (!instance) {
        throw new Error(`Instancja o ID ${instanceId} nie istnieje`);
      }

      // Pobierz aktywne sygnały
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

      // Pobierz historię sygnałów
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

// Eksportuj singleton
const accountService = new AccountService();
module.exports = accountService;
