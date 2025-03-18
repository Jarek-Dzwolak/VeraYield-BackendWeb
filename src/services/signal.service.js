/**
 * Signal Service - serwis do zarządzania sygnałami handlowymi
 *
 * Odpowiedzialny za:
 * - Przetwarzanie sygnałów z serwisu analizy
 * - Generowanie i filtrowanie sygnałów handlowych
 * - Przechowywanie sygnałów w bazie danych
 * - Współpracę z AccountService w zakresie zarządzania środkami
 */

const analysisService = require("./analysis.service");
const accountService = require("./account.service");
const logger = require("../utils/logger");
const { EventEmitter } = require("events");
const Signal = require("../models/signal.model");
const Instance = require("../models/instance.model");

class SignalService extends EventEmitter {
  constructor() {
    super();
    this.activePositions = new Map(); // Mapa aktywnych pozycji (instanceId -> positionData)
    this.positionHistory = new Map(); // Mapa historii pozycji (instanceId -> [positionData])
    this.setupListeners();
  }

  /**
   * Konfiguruje nasłuchiwanie zdarzeń z serwisu analizy
   */
  setupListeners() {
    // Nasłuchuj sygnałów wejścia
    analysisService.on("entrySignal", (data) => {
      this.processEntrySignal(data);
    });

    // Nasłuchuj sygnałów wyjścia
    analysisService.on("exitSignal", (data) => {
      this.processExitSignal(data);
    });
  }

  /**
   * Przetwarza sygnał wejścia
   * @param {Object} signalData - Dane sygnału wejścia
   */
  async processEntrySignal(signalData) {
    try {
      const { instanceId, type, price, timestamp } = signalData;

      // Pobierz bieżący stan pozycji dla instancji
      const currentPosition = this.activePositions.get(instanceId);

      // Pobierz instancję, aby uzyskać dostęp do informacji o finansach
      const instance = await Instance.findById(instanceId);

      if (!instance) {
        logger.error(`Nie znaleziono instancji ${instanceId}`);
        return;
      }

      // Sprawdź, czy instancja ma dane finansowe
      if (!instance.financials || instance.financials.availableBalance <= 0) {
        logger.warn(
          `Instancja ${instanceId} nie ma dostępnych środków - pominięto sygnał wejścia`
        );
        return;
      }

      // Jeśli nie mamy aktywnej pozycji, to jest to pierwsze wejście
      if (!currentPosition) {
        // Określ kwotę alokacji (10% dostępnych środków)
        const allocationPercent = 0.1;
        const allocationAmount =
          instance.financials.availableBalance * allocationPercent;

        // Utwórz nowy sygnał w bazie danych
        const signal = await this.createSignalInDatabase({
          instanceId,
          symbol: instance.symbol,
          type: "entry",
          subType: "first",
          price,
          allocation: allocationPercent,
          amount: allocationAmount,
          timestamp,
          status: "pending", // Przed wykonaniem przez AccountService
        });

        // Zablokuj środki na pozycję
        try {
          await accountService.lockFundsForPosition(
            instanceId,
            allocationAmount,
            signal._id
          );

          // Utwórz nową pozycję w pamięci
          const newPosition = {
            instanceId,
            symbol: instance.symbol,
            entryTime: timestamp,
            entryPrice: price,
            entryType: "first",
            capitalAllocation: allocationPercent,
            capitalAmount: allocationAmount,
            signalId: signal._id,
            status: "active",
            entries: [
              {
                time: timestamp,
                price,
                type,
                allocation: allocationPercent,
                amount: allocationAmount,
                signalId: signal._id,
              },
            ],
            history: [],
          };

          // Zapisz pozycję
          this.activePositions.set(instanceId, newPosition);

          // Emituj zdarzenie
          this.emit("newPosition", newPosition);

          logger.info(
            `Utworzono nową pozycję dla instancji ${instanceId} przy cenie ${price}, alokacja: ${allocationAmount}`
          );
        } catch (error) {
          logger.error(
            `Nie udało się zablokować środków dla pozycji: ${error.message}`
          );

          // Oznacz sygnał jako anulowany
          await Signal.findByIdAndUpdate(signal._id, {
            status: "canceled",
            metadata: {
              cancelReason: `Nie udało się zablokować środków: ${error.message}`,
            },
          });
        }
      }
      // Jeśli mamy już pozycję, sprawdź, czy to drugie lub trzecie wejście
      else if (currentPosition.status === "active") {
        // Określ typ wejścia na podstawie liczby dotychczasowych wejść
        const entryCount = currentPosition.entries.length;

        // Sprawdź, czy limit wejść nie został osiągnięty
        if (entryCount >= 3) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - osiągnięto limit 3 wejść`
          );
          return;
        }

        // Sprawdź minimalny odstęp czasowy od poprzedniego wejścia
        const lastEntryTime = currentPosition.entries[entryCount - 1].time;
        const minTimeGap = 2 * 60 * 60 * 1000; // 2 godziny w milisekundach

        if (timestamp - lastEntryTime < minTimeGap) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - za mały odstęp czasowy`
          );
          return;
        }

        // Określ alokację kapitału i typ wejścia
        let allocationPercent = 0;
        let entryType = "";

        if (entryCount === 1) {
          // Drugie wejście: 25% kapitału
          allocationPercent = 0.25;
          entryType = "second";
        } else if (entryCount === 2) {
          // Trzecie wejście: 50% kapitału
          allocationPercent = 0.5;
          entryType = "third";
        }

        // Oblicz kwotę na podstawie dostępnych środków
        const allocationAmount =
          instance.financials.availableBalance * allocationPercent;

        // Utwórz sygnał w bazie danych
        const signal = await this.createSignalInDatabase({
          instanceId,
          symbol: currentPosition.symbol,
          type: "entry",
          subType: entryType,
          price,
          allocation: allocationPercent,
          amount: allocationAmount,
          timestamp,
          status: "pending",
        });

        // Zablokuj środki na pozycję
        try {
          await accountService.lockFundsForPosition(
            instanceId,
            allocationAmount,
            signal._id
          );

          // Dodaj nowe wejście do pozycji
          currentPosition.entries.push({
            time: timestamp,
            price,
            type,
            allocation: allocationPercent,
            amount: allocationAmount,
            signalId: signal._id,
          });

          // Zaktualizuj alokację kapitału
          currentPosition.capitalAllocation += allocationPercent;
          currentPosition.capitalAmount =
            (currentPosition.capitalAmount || 0) + allocationAmount;

          // Emituj zdarzenie
          this.emit("positionUpdated", currentPosition);

          logger.info(
            `Dodano ${entryType} wejście do pozycji dla instancji ${instanceId} przy cenie ${price} (alokacja: ${allocationPercent * 100}%, kwota: ${allocationAmount})`
          );
        } catch (error) {
          logger.error(
            `Nie udało się zablokować środków dla dodatkowego wejścia: ${error.message}`
          );

          // Oznacz sygnał jako anulowany
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

  /**
   * Przetwarza sygnał wyjścia
   * @param {Object} signalData - Dane sygnału wyjścia
   */
  async processExitSignal(signalData) {
    try {
      const { instanceId, type, price, timestamp } = signalData;

      // Pobierz bieżący stan pozycji dla instancji
      const currentPosition = this.activePositions.get(instanceId);

      // Sprawdź, czy mamy aktywną pozycję
      if (!currentPosition || currentPosition.status !== "active") {
        logger.debug(
          `Ignorowanie sygnału wyjścia dla instancji ${instanceId} - brak aktywnej pozycji`
        );
        return;
      }

      // Oblicz wynik dla pozycji
      const entryAvgPrice = this.calculateAverageEntryPrice(currentPosition);
      const profitPercent = (price / entryAvgPrice - 1) * 100;

      // Oblicz łączną kwotę wejściową
      let totalEntryAmount = 0;
      for (const entry of currentPosition.entries) {
        totalEntryAmount += entry.amount;
      }

      // Oblicz wartość końcową
      const exitAmount = totalEntryAmount * (1 + profitPercent / 100);
      const profit = exitAmount - totalEntryAmount;

      // Utwórz sygnał wyjścia w bazie danych
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
      });

      try {
        // Finalizuj pozycję w AccountService
        await accountService.finalizePosition(
          instanceId,
          currentPosition.entries[0].signalId, // ID pierwszego sygnału wejścia
          exitSignal._id, // ID sygnału wyjścia
          totalEntryAmount,
          exitAmount
        );

        // Zaktualizuj pozycję w pamięci
        currentPosition.exitTime = timestamp;
        currentPosition.exitPrice = price;
        currentPosition.exitType = type;
        currentPosition.profitPercent = profitPercent;
        currentPosition.exitAmount = exitAmount;
        currentPosition.profit = profit;
        currentPosition.status = "closed";
        currentPosition.exitSignalId = exitSignal._id;

        // Dodaj do historii
        if (!this.positionHistory.has(instanceId)) {
          this.positionHistory.set(instanceId, []);
        }

        this.positionHistory.get(instanceId).push({ ...currentPosition });

        // Usuń z aktywnych pozycji
        this.activePositions.delete(instanceId);

        // Emituj zdarzenie
        this.emit("positionClosed", currentPosition);

        logger.info(
          `Zamknięto pozycję dla instancji ${instanceId} przy cenie ${price} (zysk: ${profitPercent.toFixed(2)}%, kwota: ${profit.toFixed(2)})`
        );
      } catch (error) {
        logger.error(`Nie udało się sfinalizować pozycji: ${error.message}`);

        // Oznacz sygnał wyjścia jako anulowany
        await Signal.findByIdAndUpdate(exitSignal._id, {
          status: "canceled",
          metadata: {
            cancelReason: `Nie udało się sfinalizować pozycji: ${error.message}`,
          },
        });
      }
    } catch (error) {
      logger.error(
        `Błąd podczas przetwarzania sygnału wyjścia: ${error.message}`
      );
    }
  }

  /**
   * Oblicza średnią cenę wejścia dla pozycji
   * @param {Object} position - Obiekt pozycji
   * @returns {number} - Średnia ważona cena wejścia
   */
  calculateAverageEntryPrice(position) {
    let totalAllocation = 0;
    let weightedSum = 0;

    for (const entry of position.entries) {
      weightedSum += entry.price * entry.allocation;
      totalAllocation += entry.allocation;
    }

    return totalAllocation > 0 ? weightedSum / totalAllocation : 0;
  }

  /**
   * Tworzy sygnał w bazie danych
   * @param {Object} signalData - Dane sygnału
   * @returns {Promise<Object>} - Utworzony sygnał
   */
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

  /**
   * Pobiera aktywne pozycje dla instancji
   * @param {string} instanceId - Identyfikator instancji (opcjonalnie)
   * @returns {Array|Object} - Tablica aktywnych pozycji lub pojedyncza pozycja
   */
  getActivePositions(instanceId = null) {
    if (instanceId) {
      return this.activePositions.get(instanceId) || null;
    }

    return Array.from(this.activePositions.values());
  }

  /**
   * Pobiera historię pozycji dla instancji
   * @param {string} instanceId - Identyfikator instancji (opcjonalnie)
   * @returns {Array} - Tablica historii pozycji
   */
  getPositionHistory(instanceId = null) {
    if (instanceId) {
      return this.positionHistory.get(instanceId) || [];
    }

    // Zwróć wszystkie historie pozycji
    const allHistory = [];
    for (const history of this.positionHistory.values()) {
      allHistory.push(...history);
    }

    // Sortuj według czasu zamknięcia (od najnowszych)
    return allHistory.sort((a, b) => b.exitTime - a.exitTime);
  }

  /**
   * Pobiera sygnały z bazy danych
   * @param {Object} filters - Filtry do zapytania
   * @param {number} limit - Limit wyników
   * @param {number} skip - Liczba pominiętych wyników
   * @returns {Promise<Array>} - Tablica sygnałów
   */
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

  /**
   * Pobiera statystyki sygnałów
   * @param {string} instanceId - Identyfikator instancji (opcjonalnie)
   * @returns {Promise<Object>} - Statystyki sygnałów
   */
  async getSignalStats(instanceId = null) {
    try {
      const filters = instanceId ? { instanceId } : {};

      // Pobierz wszystkie sygnały wyjścia
      const exitSignals = await Signal.find({
        ...filters,
        type: "exit",
        status: "executed",
      });

      // Oblicz statystyki
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
      };
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania statystyk sygnałów: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Czyści historię sygnałów dla instancji
   * @param {string} instanceId - Identyfikator instancji
   * @returns {Promise<number>} - Liczba usuniętych sygnałów
   */
  async clearSignalHistory(instanceId) {
    try {
      // Usuń sygnały z bazy danych
      const result = await Signal.deleteMany({ instanceId });

      // Usuń z lokalnych map
      this.positionHistory.delete(instanceId);

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

// Eksportuj singleton
const signalService = new SignalService();
module.exports = signalService;
