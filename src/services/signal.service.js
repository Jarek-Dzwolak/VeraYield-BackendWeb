/**
 * Signal Service - serwis do zarządzania sygnałami handlowymi
 *
 * Odpowiedzialny za:
 * - Przetwarzanie sygnałów z serwisu analizy
 * - Generowanie i filtrowanie sygnałów handlowych
 * - Przechowywanie sygnałów w bazie danych
 */

const analysisService = require("./analysis.service");
const logger = require("../utils/logger");
const { EventEmitter } = require("events");
const Signal = require("../models/signal.model");

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

      // Jeśli nie mamy aktywnej pozycji, to jest to pierwsze wejście
      if (!currentPosition) {
        // Utwórz nową pozycję
        const newPosition = {
          instanceId,
          symbol: analysisService.instances.get(instanceId).symbol,
          entryTime: timestamp,
          entryPrice: price,
          entryType: "first",
          capitalAllocation: 0.1, // 10% kapitału
          status: "active",
          entries: [
            {
              time: timestamp,
              price,
              type,
              allocation: 0.1, // 10% kapitału
            },
          ],
          history: [],
        };

        // Zapisz pozycję
        this.activePositions.set(instanceId, newPosition);

        // Generuj sygnał w bazie danych
        await this.createSignalInDatabase({
          instanceId,
          symbol: newPosition.symbol,
          type: "entry",
          subType: "first",
          price,
          allocation: 0.1,
          timestamp,
        });

        // Emituj zdarzenie
        this.emit("newPosition", newPosition);

        logger.info(
          `Utworzono nową pozycję dla instancji ${instanceId} przy cenie ${price}`
        );
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

        // Określ alokację kapitału
        let allocation = 0;
        let entryType = "";

        if (entryCount === 1) {
          // Drugie wejście: 25% kapitału
          allocation = 0.25;
          entryType = "second";
        } else if (entryCount === 2) {
          // Trzecie wejście: 50% kapitału
          allocation = 0.5;
          entryType = "third";
        }

        // Dodaj nowe wejście do pozycji
        currentPosition.entries.push({
          time: timestamp,
          price,
          type,
          allocation,
        });

        // Zaktualizuj alokację kapitału
        currentPosition.capitalAllocation += allocation;

        // Generuj sygnał w bazie danych
        await this.createSignalInDatabase({
          instanceId,
          symbol: currentPosition.symbol,
          type: "entry",
          subType: entryType,
          price,
          allocation,
          timestamp,
        });

        // Emituj zdarzenie
        this.emit("positionUpdated", currentPosition);

        logger.info(
          `Dodano ${entryType} wejście do pozycji dla instancji ${instanceId} przy cenie ${price} (alokacja: ${allocation * 100}%)`
        );
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

      // Zamknij pozycję
      currentPosition.exitTime = timestamp;
      currentPosition.exitPrice = price;
      currentPosition.exitType = type;
      currentPosition.profitPercent = profitPercent;
      currentPosition.status = "closed";

      // Dodaj do historii
      if (!this.positionHistory.has(instanceId)) {
        this.positionHistory.set(instanceId, []);
      }

      this.positionHistory.get(instanceId).push({ ...currentPosition });

      // Usuń z aktywnych pozycji
      this.activePositions.delete(instanceId);

      // Generuj sygnał w bazie danych
      await this.createSignalInDatabase({
        instanceId,
        symbol: currentPosition.symbol,
        type: "exit",
        subType: type,
        price,
        profitPercent,
        timestamp,
      });

      // Emituj zdarzenie
      this.emit("positionClosed", currentPosition);

      logger.info(
        `Zamknięto pozycję dla instancji ${instanceId} przy cenie ${price} (zysk: ${profitPercent.toFixed(2)}%)`
      );
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
        profitPercent: signalData.profitPercent,
        timestamp: signalData.timestamp,
        metadata: signalData.metadata || {},
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
      });

      // Oblicz statystyki
      let totalTrades = exitSignals.length;
      let profitableTrades = 0;
      let totalProfit = 0;
      let maxProfit = 0;
      let maxLoss = 0;

      for (const signal of exitSignals) {
        const profit = signal.profitPercent || 0;

        totalProfit += profit;

        if (profit > 0) {
          profitableTrades++;
        }

        if (profit > maxProfit) {
          maxProfit = profit;
        }

        if (profit < maxLoss) {
          maxLoss = profit;
        }
      }

      return {
        totalTrades,
        profitableTrades,
        winRate: totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0,
        averageProfit: totalTrades > 0 ? totalProfit / totalTrades : 0,
        totalProfit,
        maxProfit,
        maxLoss,
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
