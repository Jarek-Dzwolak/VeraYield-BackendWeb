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

        // ✅ NOWA LOGIKA - UJEDNOLICONA
        if (activePosition && activePosition.positionId) {
          // To kolejne wejście - używamy positionId z pamięci
          positionId = activePosition.positionId;
          entryType = activePosition.entries.length === 1 ? "second" : "third";

          logger.info(
            `📍 Kolejne wejście (${entryType}) dla pozycji: ${positionId}`
          );
          // ✅ DODAJ TEN DEBUG

          logger.info(`🔍 DEBUG BAZY przed wyszukiwaniem dla instanceId: ${instanceId}
    Szukany positionId: ${positionId}
    Pozycje w bazie (${instance.financials.openPositions.length}):
    ${JSON.stringify(
      instance.financials.openPositions.map((p, idx) => ({
        index: idx,
        positionId: p.positionId,
        totalAmount: p.totalAmount,
        hasPositionId: !!p.positionId,
      })),
      null,
      2
    )}`);
          // Znajdź pozycję w bazie PO POSITION ID
          let positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );

          if (positionIndex !== -1) {
            // Aktualizuj istniejącą pozycję
            instance.financials.openPositions[positionIndex].entrySignals.push({
              signalId,
              amount,
              timestamp: new Date(),
              subType: entryType,
            });
            instance.financials.openPositions[positionIndex].totalAmount +=
              amount;

            logger.info(
              `✅ Zaktualizowano istniejącą pozycję na indeksie ${positionIndex}, nowa suma: ${instance.financials.openPositions[positionIndex].totalAmount}`
            );
          } else {
            // Pozycja nie znaleziona w bazie - utwórz nową z tym samym positionId
            logger.warn(
              `⚠️ Pozycja ${positionId} nie znaleziona w bazie, tworzę nową`
            );

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
              `🔧 Utworzono nową pozycję w bazie z istniejącym positionId: ${positionId}`
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

          logger.info(`🆕 Utworzono nową pozycję: ${positionId}`);
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
          signal.positionId = positionId;
          await signal.save({ session });
        }

        logger.info(
          `💰 Zablokowano ${amount} środków w instancji ${instanceId} dla sygnału ${signalId}, pozycja: ${positionId}`
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

        // ✅ NOWA LOGIKA WYSZUKIWANIA POZYCJI
        let position = null;
        let positionIndex = -1;
        let totalEntryAmount = entryAmount; // fallback

        // Inicjalizuj openPositions, jeśli nie istnieje
        if (!instance.financials.openPositions) {
          instance.financials.openPositions = [];
        }

        logger.debug(
          `Liczba otwartych pozycji w bazie: ${instance.financials.openPositions.length}`
        );

        // STRATEGIA 1: Szukaj po positionId z pamięci RAM
        if (activePosition && activePosition.positionId) {
          const positionId = activePosition.positionId;
          logger.info(
            `🔍 STRATEGIA 1: Szukam pozycji po positionId z RAM: ${positionId}`
          );

          positionIndex = instance.financials.openPositions.findIndex(
            (p) => p.positionId === positionId
          );

          if (positionIndex !== -1) {
            position = instance.financials.openPositions[positionIndex];
            logger.info(
              `✅ STRATEGIA 1: Znaleziono pozycję po positionId: ${positionId}, indeks: ${positionIndex}`
            );

            // Oblicz totalEntryAmount z bazy danych
            totalEntryAmount =
              position.totalAmount ||
              position.entrySignals?.reduce(
                (sum, entry) => sum + (entry.amount || 0),
                0
              ) ||
              0;

            // Ale jeśli mamy dane z RAM, użyj ich (są bardziej aktualne)
            if (activePosition.entries && activePosition.entries.length > 0) {
              const ramTotal = activePosition.entries.reduce(
                (sum, entry) => sum + (entry.amount || 0),
                0
              );
              if (ramTotal > totalEntryAmount) {
                totalEntryAmount = ramTotal;
                logger.info(
                  `🔄 Używam sumy z pamięci RAM: ${totalEntryAmount} (baza: ${position.totalAmount})`
                );
              }
            }
          }
        }

        // STRATEGIA 2: Fallback - szukaj wszystkich wejść dla tej instancji
        if (!position) {
          logger.info(
            `🔍 STRATEGIA 2: Pozycja nie znaleziona po positionId, szukam wszystkich wejść dla instancji ${instanceId}`
          );

          // Znajdź wszystkie wykonane sygnały wejścia dla tej instancji w ostatnich 24 godzinach
          const timeWindow = 24 * 60 * 60 * 1000; // 24 godziny
          const searchStartTime = Date.now() - timeWindow;

          const allEntrySignals = await Signal.find({
            instanceId: instanceId,
            type: "entry",
            status: "executed",
            timestamp: { $gte: searchStartTime },
          })
            .sort({ timestamp: 1 })
            .session(session);

          logger.info(
            `🔍 Znaleziono ${allEntrySignals.length} sygnałów wejścia dla instancji ${instanceId} w ostatnich 24h`
          );

          if (allEntrySignals.length > 0) {
            // Grupuj sygnały po positionId (jeśli istnieje) lub weź wszystkie jako jedną grupę
            const positionGroups = new Map();

            for (const signal of allEntrySignals) {
              const groupKey = signal.positionId || "default-group";

              if (!positionGroups.has(groupKey)) {
                positionGroups.set(groupKey, []);
              }
              positionGroups.get(groupKey).push(signal);
            }

            // Weź największą grupę (prawdopodobnie aktualna pozycja)
            let largestGroup = [];
            let largestGroupKey = null;

            for (const [groupKey, signals] of positionGroups.entries()) {
              if (signals.length > largestGroup.length) {
                largestGroup = signals;
                largestGroupKey = groupKey;
              }
            }

            logger.info(
              `📊 Największa grupa sygnałów: ${largestGroup.length} wejść (klucz: ${largestGroupKey})`
            );

            // Sprawdź czy między tymi wejściami nie było już sygnału wyjścia
            const firstEntry = largestGroup[0];
            const lastEntry = largestGroup[largestGroup.length - 1];

            const exitSignalsBetween = await Signal.find({
              instanceId: instanceId,
              type: "exit",
              status: "executed",
              timestamp: {
                $gte: firstEntry.timestamp,
                $lte: lastEntry.timestamp + 60000, // +1 minuta bufor
              },
            }).session(session);

            if (exitSignalsBetween.length === 0) {
              // To są nasze wejścia bez zamknięcia - używaj ich
              totalEntryAmount = largestGroup.reduce(
                (sum, signal) => sum + (signal.amount || 0),
                0
              );

              // Odtwórz pozycję w bazie na podstawie sygnałów
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

              logger.info(
                `🔧 Odtworzono pozycję w bazie: ${largestGroup.length} wejść, suma: ${totalEntryAmount}`
              );
            } else {
              logger.warn(
                `⚠️ Znaleziono ${exitSignalsBetween.length} sygnałów wyjścia między wejściami - pozycja może być już zamknięta`
              );
            }
          }
        }

        // STRATEGIA 3: Ostateczny fallback - użyj danych z pamięci RAM
        if (!position && activePosition) {
          logger.info(
            `🔍 STRATEGIA 3: Używam danych z pamięci RAM jako ostateczny fallback`
          );

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

            logger.info(
              `🔧 Utworzono pozycję fallback z RAM: ${activePosition.entries.length} wejść, suma: ${totalEntryAmount}`
            );
          }
        }

        // Jeśli nadal nie mamy pozycji, rzuć błąd
        if (!position) {
          throw new Error(
            `❌ Nie znaleziono otwartej pozycji dla instancji ${instanceId} przy użyciu wszystkich strategii`
          );
        }

        // Oblicz zysk na podstawie rzeczywistej kwoty wejść i kwoty wyjścia
        const profit = exitAmount - totalEntryAmount;
        const profitPercent = (profit / totalEntryAmount) * 100;

        logger.info(
          `💰 Finalizacja pozycji: entryAmount=${totalEntryAmount}, exitAmount=${exitAmount}, profit=${profit}, profitPercent=${profitPercent}`
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
          `✅ Sfinalizowano pozycję w instancji ${instanceId}. Zysk: ${profit}, unlocked amount: ${totalEntryAmount}`
        );

        // ENHANCED SAFETY CHECK: Sprawdź lockedBalance vs rzeczywiste otwarte pozycje
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
          logger.warn(`⚠️ Wykryto rozbieżność w lockedBalance dla instancji ${instanceId}. 
          Zapisane: ${instance.financials.lockedBalance}, 
          Rzeczywiste z pozycji: ${actualLockedAmount}. 
          Otwarte pozycje: ${instance.financials.openPositions?.length || 0}. 
          Wykonuję korektę.`);

          const difference =
            instance.financials.lockedBalance - actualLockedAmount;
          instance.financials.lockedBalance = actualLockedAmount;
          instance.financials.availableBalance += difference;
          instance.financials.currentBalance =
            instance.financials.availableBalance +
            instance.financials.lockedBalance;

          await instance.save({ session });

          logger.info(
            `🔧 Skorygowano lockedBalance o ${difference} dla instancji ${instanceId}`
          );
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
        logger.error(`❌ Błąd podczas finalizacji pozycji: ${error.message}`);
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
