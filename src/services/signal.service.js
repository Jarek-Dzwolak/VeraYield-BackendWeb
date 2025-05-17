/**
 * Signal Service - serwis do zarządzania sygnałami handlowymi
 *
 * Odpowiedzialny za:
 * - Przetwarzanie sygnałów z serwisu analizy
 * - Generowanie i filtrowanie sygnałów handlowych
 * - Przechowywanie sygnałów w bazie danych
 * - Współpracę z AccountService w zakresie zarządzania środkami
 */
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
    this.activePositions = new Map(); // Mapa aktywnych pozycji (instanceId -> positionData)
    this.positionHistory = new Map(); // Mapa historii pozycji (instanceId -> [positionData])
    this.lastEntryTimes = new Map(); // Mapa czasów ostatniego wejścia (instanceId -> timestamp)
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
   * Dostosowuje wielkość kontraktu zgodnie z ograniczeniami Bybit
   * @private
   * @param {number} theoreticalQuantity - Teoretyczna wielkość kontraktu
   * @param {Object} instrumentInfo - Informacje o instrumencie z Bybit
   * @returns {number} - Dostosowana wielkość kontraktu
   */
  async _adjustContractQuantity(theoreticalQuantity, instrumentInfo) {
    // Jeśli nie mamy informacji o instrumencie, użyj domyślnych wartości dla BTC
    if (!instrumentInfo) {
      instrumentInfo = {
        minOrderQty: 0.001,
        qtyStep: 0.001,
      };
    }

    // Sprawdź, czy teoretyczna wielkość jest poniżej minimalnej
    if (theoreticalQuantity < instrumentInfo.minOrderQty) {
      logger.debug(
        `Wielkość kontraktu ${theoreticalQuantity} poniżej minimum ${instrumentInfo.minOrderQty}, używam wartości minimalnej`
      );
      return instrumentInfo.minOrderQty;
    }

    // Zaokrąglij do najbliższej wielokrotności qtyStep
    const steps = Math.floor(theoreticalQuantity / instrumentInfo.qtyStep);
    const adjustedQuantity = steps * instrumentInfo.qtyStep;

    // Sprawdź, czy zaokrąglona wartość nadal spełnia minimalne wymagania
    if (adjustedQuantity < instrumentInfo.minOrderQty) {
      logger.debug(
        `Zaokrąglona wielkość ${adjustedQuantity} poniżej minimum, używam wartości minimalnej`
      );
      return instrumentInfo.minOrderQty;
    }

    // Sformatuj do odpowiedniej liczby miejsc po przecinku
    // Oblicz precyzję na podstawie qtyStep
    const stepStr = instrumentInfo.qtyStep.toString();
    const precision = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;

    return parseFloat(adjustedQuantity.toFixed(precision));
  }

  /**
   * Oblicza rzeczywisty procent alokacji po dostosowaniu wielkości kontraktu
   * @private
   * @param {number} adjustedQuantity - Dostosowana wielkość kontraktu
   * @param {number} price - Aktualna cena
   * @param {number} leverage - Dźwignia
   * @param {number} availableBalance - Dostępny bilans
   * @returns {number} - Rzeczywisty procent alokacji (0-100)
   */
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

  /**
   * Oblicza optymalną wielkość kontraktu dla danego procentu alokacji
   * @private
   * @param {number} allocationPercent - Procent alokacji (0-100)
   * @param {number} availableBalance - Dostępny bilans
   * @param {number} price - Aktualna cena
   * @param {number} leverage - Dźwignia
   * @param {Object} instrumentInfo - Informacje o instrumencie
   * @returns {Object} - Informacje o obliczonej wielkości
   */
  async _calculateOptimalContractQuantity(
    allocationPercent,
    availableBalance,
    price,
    leverage,
    instrumentInfo
  ) {
    // Oblicz teoretyczną alokację
    const allocationFraction = allocationPercent / 100;
    const theoreticalMargin = availableBalance * allocationFraction;
    const theoreticalPosition = theoreticalMargin * leverage;

    // Oblicz teoretyczną wielkość kontraktu
    const theoreticalQuantity = theoreticalPosition / price;

    // Dostosuj wielkość kontraktu do ograniczeń Bybit
    const adjustedQuantity = await this._adjustContractQuantity(
      theoreticalQuantity,
      instrumentInfo
    );

    // Oblicz rzeczywisty procent alokacji
    const actualAllocationPercent = this._calculateActualAllocationPercent(
      adjustedQuantity,
      price,
      leverage,
      availableBalance
    );

    // Oblicz rzeczywistą wartość pozycji i marginu
    const actualPosition = adjustedQuantity * price;
    const actualMargin = actualPosition / leverage;

    // Zwróć wszystkie informacje
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

  /**
   * Przetwarza sygnał wejścia
   * @param {Object} signalData - Dane sygnału wejścia
   */
  async processEntrySignal(signalData) {
    try {
      const { instanceId, type, price, timestamp, trend } = signalData;

      // Pobierz bieżący stan pozycji dla instancji
      const currentPosition = this.activePositions.get(instanceId);

      // Pobierz instancję, aby uzyskać dostęp do informacji o finansach i parametrach
      const instance = await Instance.findOne({ instanceId });

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

      // Pobierz parametry strategii
      const strategyParams = instance.strategy.parameters;

      // Pobierz parametry alokacji kapitału
      const firstEntryPercent =
        strategyParams.capitalAllocation?.firstEntry * 100 || 10; // 10%
      const secondEntryPercent =
        strategyParams.capitalAllocation?.secondEntry * 100 || 25; // 25%
      const thirdEntryPercent =
        strategyParams.capitalAllocation?.thirdEntry * 100 || 50; // 50%

      // Pobierz minimalny odstęp czasowy między wejściami (domyślnie 2 godziny)
      const minEntryTimeGap =
        strategyParams.signals?.minEntryTimeGap || 7200000; // 2h w ms

      // Pobierz aktualną cenę i informacje o instrumencie z Bybit
      const currentPrice = await bybitService.getCurrentPrice(instance.symbol);
      const instrumentInfo = await bybitService.getCachedInstrumentInfo(
        instance.symbol
      );

      // Oblicz dostępną dźwignię
      const leverage = instance.bybitConfig?.leverage || 3;

      if (!currentPosition) {
        // --- PIERWSZE WEJŚCIE ---

        // Sprawdź, czy trend pozwala na wejście (jeśli włączone filtrowanie trendu)
        const checkEMATrend = strategyParams.signals?.checkEMATrend !== false;

        if (checkEMATrend && !this._isTrendValidForEntry(trend)) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - niewłaściwy trend (${trend})`
          );

          // Zapisz informację o odrzuconym sygnale
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

        // Wygeneruj unikalny identyfikator pozycji
        const positionId = `position-${instanceId}-${Date.now()}`;

        // Oblicz optymalną wielkość pierwszego wejścia
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

        // Utwórz nowy sygnał w bazie danych
        const signal = await this.createSignalInDatabase({
          instanceId,
          symbol: instance.symbol,
          type: "entry",
          subType: "first",
          price,
          allocation: optimalEntry.actualAllocationPercent / 100, // Zapisz rzeczywistą alokację
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

        // Zablokuj środki na pozycję
        try {
          await accountService.lockFundsForPosition(
            instanceId,
            optimalEntry.actualMargin,
            signal._id
          );

          // Wystaw prawdziwe zlecenie na ByBit
          if (instance.bybitConfig && instance.bybitConfig.apiKey) {
            try {
              // Ustaw dźwignię i margin mode
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

              // Otwórz pozycję z dostosowaną wielkością
              const orderResult = await bybitService.openPosition(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                "Buy",
                optimalEntry.adjustedQuantity.toString(),
                1,
                instance.bybitConfig.subaccountId
              );

              logger.info(`ByBit order placed: ${JSON.stringify(orderResult)}`);

              // Zapisz ID zlecenia w metadanych sygnału
              signal.metadata.bybitOrderId = orderResult.result?.orderId;
              signal.metadata.bybitOrderLinkId =
                orderResult.result?.orderLinkId;
              signal.metadata.contractQuantity = optimalEntry.adjustedQuantity;
              await signal.save();
            } catch (error) {
              logger.error(`Error placing ByBit order: ${error.message}`);
            }
          }

          // Utwórz nową pozycję w pamięci
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
                signalId: signal._id,
                contractQuantity: optimalEntry.adjustedQuantity,
              },
            ],
            history: [],
          };

          // Zapisz pozycję
          this.activePositions.set(instanceId, newPosition);

          // Zapisz czas ostatniego wejścia
          this.lastEntryTimes.set(instanceId, timestamp);

          // Reset Trailing stopa
          analysisService.resetTrailingStopTracking(instanceId);

          // Emituj zdarzenie
          this.emit("newPosition", newPosition);

          logger.info(
            `Utworzono nową pozycję dla instancji ${instanceId} przy cenie ${price}, alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%, wielkość kontraktu: ${optimalEntry.adjustedQuantity} BTC`
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
      } else if (currentPosition.status === "active") {
        // --- DRUGIE LUB TRZECIE WEJŚCIE ---

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
        const lastEntryTime = this.lastEntryTimes.get(instanceId) || 0;

        if (timestamp - lastEntryTime < minEntryTimeGap) {
          logger.info(
            `Ignorowanie sygnału wejścia dla instancji ${instanceId} - za mały odstęp czasowy (${((timestamp - lastEntryTime) / 60000).toFixed(1)} min < ${minEntryTimeGap / 60000} min)`
          );
          return;
        }

        // Sprawdź, czy trend pozwala na wejście (jeśli włączone filtrowanie trendu)
        const checkEMATrend = strategyParams.signals?.checkEMATrend !== false;

        if (checkEMATrend && !this._isTrendValidForEntry(trend)) {
          logger.info(
            `Ignorowanie sygnału kolejnego wejścia dla instancji ${instanceId} - niewłaściwy trend (${trend})`
          );

          // Zapisz informację o odrzuconym sygnale w DB
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

        // Oblicz już zużytą część kapitału
        const usedCapital = currentPosition.entries.reduce(
          (sum, entry) => sum + entry.amount,
          0
        );

        // Oblicz pozostały dostępny kapitał
        const remainingBalance = instance.financials.availableBalance;

        // Określ alokację kapitału i typ wejścia
        let allocationPercent = 0;
        let entryType = "";

        if (entryCount === 1) {
          // Drugie wejście - % z AKTUALNIE dostępnych środków
          allocationPercent = secondEntryPercent;
          entryType = "second";
        } else if (entryCount === 2) {
          // Trzecie wejście - % z AKTUALNIE dostępnych środków
          allocationPercent = thirdEntryPercent;
          entryType = "third";
        }

        // Oblicz optymalną wielkość kontraktu
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

        // Utwórz sygnał w bazie danych
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
          positionId: currentPosition.positionId,
        });

        // Zablokuj środki na pozycję
        try {
          await accountService.lockFundsForPosition(
            instanceId,
            optimalEntry.actualMargin,
            signal._id
          );

          // Wystaw prawdziwe zlecenie na ByBit
          if (instance.bybitConfig && instance.bybitConfig.apiKey) {
            try {
              // Otwórz pozycję
              const orderResult = await bybitService.openPosition(
                instance.bybitConfig.apiKey,
                instance.bybitConfig.apiSecret,
                instance.symbol,
                "Buy",
                optimalEntry.adjustedQuantity.toString(),
                1,
                instance.bybitConfig.subaccountId
              );

              logger.info(`ByBit order placed: ${JSON.stringify(orderResult)}`);

              // Zapisz ID zlecenia w metadanych sygnału
              signal.metadata.bybitOrderId = orderResult.result?.orderId;
              signal.metadata.bybitOrderLinkId =
                orderResult.result?.orderLinkId;
              signal.metadata.contractQuantity = optimalEntry.adjustedQuantity;
              await signal.save();
            } catch (error) {
              logger.error(`Error placing ByBit order: ${error.message}`);
            }
          }

          // Dodaj nowe wejście do pozycji
          currentPosition.entries.push({
            time: timestamp,
            price,
            type,
            trend,
            allocation: optimalEntry.actualAllocationPercent / 100,
            amount: optimalEntry.actualMargin,
            signalId: signal._id,
            contractQuantity: optimalEntry.adjustedQuantity,
          });

          // Zaktualizuj alokację kapitału i całkowitą kwotę
          currentPosition.capitalAllocation +=
            optimalEntry.actualAllocationPercent / 100;
          currentPosition.capitalAmount += optimalEntry.actualMargin;

          // Zapisz czas ostatniego wejścia
          this.lastEntryTimes.set(instanceId, timestamp);

          // Emituj zdarzenie
          this.emit("positionUpdated", currentPosition);

          logger.info(
            `Dodano ${entryType} wejście do pozycji dla instancji ${instanceId} przy cenie ${price} (alokacja: ${optimalEntry.actualAllocationPercent.toFixed(2)}%, kwota: ${optimalEntry.actualMargin}, wielkość kontraktu: ${optimalEntry.adjustedQuantity} BTC)`
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
   * Sprawdza, czy trend jest odpowiedni do wejścia (zgodnie z logiką backtestingową)
   * @param {string} trend - Trend z określenia trendu w analysisService
   * @returns {boolean} - Czy trend pozwala na wejście
   * @private
   */
  _isTrendValidForEntry(trend) {
    // Zgodnie z backtestingową logiką, dozwolone trendy to:
    // - "up" (wzrostowy)
    // - "strong_up" (silnie wzrostowy)
    // - "neutral" (neutralny)
    return ["up", "strong_up", "neutral"].includes(trend);
  }

  /**
   * Przetwarza sygnał wyjścia
   * @param {Object} signalData - Dane sygnału wyjścia
   */
  async processExitSignal(signalData) {
    try {
      const { instanceId, type, price, timestamp, positionId } = signalData;

      // Pobierz bieżący stan pozycji dla instancji
      const currentPosition = this.activePositions.get(instanceId);

      // Sprawdź, czy mamy aktywną pozycję
      if (!currentPosition || currentPosition.status !== "active") {
        logger.debug(
          `Ignorowanie sygnału wyjścia dla instancji ${instanceId} - brak aktywnej pozycji`
        );
        return;
      }

      // Sprawdź minimalny czas trwania pierwszego wejścia (tylko jeśli mamy jedno wejście)
      const entryCount = currentPosition.entries.length;
      if (entryCount === 1) {
        // Pobierz instancję, aby uzyskać dostęp do konfiguracji
        const instanceForTimeCheck = await Instance.findOne({ instanceId });
        if (!instanceForTimeCheck) {
          logger.error(`Nie znaleziono instancji ${instanceId} w bazie danych`);
          // Kontynuuj bez sprawdzania czasu, żeby nie blokować całkowicie
        } else {
          // Pobierz minimalny czas trwania pierwszego wejścia (domyślnie 1 godzina)
          const minFirstEntryDuration =
            instanceForTimeCheck.strategy.parameters.signals
              ?.minFirstEntryDuration || 60 * 60 * 1000;

          // Oblicz czas trwania pozycji
          const positionDuration = timestamp - currentPosition.entryTime;

          // Jeśli czas trwania jest zbyt krótki, ignoruj sygnał wyjścia
          if (positionDuration < minFirstEntryDuration) {
            logger.info(
              `Ignorowanie sygnału wyjścia dla instancji ${instanceId} - pierwsze wejście zbyt świeże (${(positionDuration / 60000).toFixed(1)} min < ${minFirstEntryDuration / 60000} min)`
            );
            return;
          }
        }
      }

      // Sprawdź, czy pozycja ma prawidłowe positionId
      if (positionId && currentPosition.positionId !== positionId) {
        logger.warn(
          `ID pozycji się nie zgadza: oczekiwane ${positionId}, aktualne ${currentPosition.positionId}`
        );
        // Aktualizuj ID pozycji w pamięci, jeśli nie jest zgodne
        currentPosition.positionId = positionId;
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
        subType: type, // "upperBandCrossDown" lub "trailingStop"
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
          // Dla trailing stopu dodaj dodatkowe informacje
          ...(type === "trailingStop" && signalData.highestPrice
            ? {
                highestPrice: signalData.highestPrice,
                dropPercent: signalData.dropPercent,
                trailingStopPercent: signalData.trailingStopPercent,
              }
            : {}),
        },
      });

      // Użyj entrySignalId TYLKO jeśli potrzeba dla zachowania kompatybilności
      // Preferujemy używanie positionId
      const firstEntrySignalId = currentPosition.entries[0]?.signalId;

      try {
        // Finalizuj pozycję w AccountService
        await accountService.finalizePosition(
          instanceId,
          firstEntrySignalId, // ID pierwszego sygnału wejścia
          exitSignal._id, // ID sygnału wyjścia
          totalEntryAmount,
          exitAmount
        );

        // Zamknij prawdziwą pozycję na ByBit
        const instanceForExit = await Instance.findOne({ instanceId });
        if (
          instanceForExit &&
          instanceForExit.bybitConfig &&
          instanceForExit.bybitConfig.apiKey
        ) {
          try {
            // Oblicz łączną wielkość pozycji do zamknięcia
            let totalContractQuantity = 0;

            // Zbierz wszystkie wielkości z wejść pozycji
            for (const entry of currentPosition.entries) {
              if (entry.contractQuantity) {
                totalContractQuantity += parseFloat(entry.contractQuantity);
              }
            }

            // Jeśli nie mamy zapisanej wielkości, oblicz ją na podstawie aktualnej ceny
            if (totalContractQuantity === 0) {
              const currentPrice = await bybitService.getCurrentPrice(
                instanceForExit.symbol
              );
              const positionValue =
                totalEntryAmount * instanceForExit.bybitConfig.leverage;

              // Pobierz informacje o instrumencie
              const instrumentInfo = await bybitService.getCachedInstrumentInfo(
                instanceForExit.symbol
              );

              // Oblicz teoretyczną wielkość
              const theoreticalQuantity = positionValue / currentPrice;

              // Dostosuj wielkość do ograniczeń
              totalContractQuantity = await this._adjustContractQuantity(
                theoreticalQuantity,
                instrumentInfo
              );
            }

            // Zamknij pozycję
            const orderResult = await bybitService.closePosition(
              instanceForExit.bybitConfig.apiKey,
              instanceForExit.bybitConfig.apiSecret,
              instanceForExit.symbol,
              "Sell", // Zamknięcie pozycji long
              totalContractQuantity.toString(),
              1,
              instanceForExit.bybitConfig.subaccountId
            );

            logger.info(
              `ByBit position closed: ${JSON.stringify(orderResult)}`
            );

            // Zapisz ID zlecenia zamykającego
            exitSignal.metadata.bybitOrderId = orderResult.result?.orderId;
            exitSignal.metadata.bybitOrderLinkId =
              orderResult.result?.orderLinkId;
            exitSignal.metadata.contractQuantity = totalContractQuantity;
            await exitSignal.save();
          } catch (error) {
            logger.error(`Error closing ByBit position: ${error.message}`);
          }
        }

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

        // Resetuj czas ostatniego wejścia
        this.lastEntryTimes.delete(instanceId);

        // Emituj zdarzenie
        this.emit("positionClosed", currentPosition);

        logger.info(
          `Zamknięto pozycję dla instancji ${instanceId} przy cenie ${price} (zysk: ${profitPercent.toFixed(2)}%, kwota: ${profit.toFixed(2)}, typ: ${type})`
        );

        // Synchronizuj saldo po zamknięciu pozycji
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

          // Poczekaj chwilę aby ByBit zaktualizował saldo
          setTimeout(async () => {
            try {
              await instanceService.syncInstanceBalance(instanceId);
            } catch (error) {
              logger.error(
                `Błąd podczas synchronizacji salda po zamknięciu pozycji: ${error.message}`
              );
            }
          }, 2000); // 2 sekundy opóźnienia
        }

        return exitSignal;
      } catch (error) {
        logger.error(`Nie udało się sfinalizować pozycji: ${error.message}`);

        // Oznacz sygnał wyjścia jako anulowany
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
        positionId: signalData.positionId, // Nowe pole
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
   * Ustawia aktywną pozycję dla instancji (używane przy odtwarzaniu stanu)
   * @param {string} instanceId - Identyfikator instancji
   * @param {Object} position - Obiekt pozycji
   */
  setActivePosition(instanceId, position) {
    // Upewniamy się, że pozycja ma positionId
    if (!position.positionId) {
      position.positionId = `position-${instanceId}-${Date.now()}`;
    }

    this.activePositions.set(instanceId, position);

    // Jeśli pozycja ma pierwsze wejście, ustaw ostatni czas wejścia
    if (position.entries && position.entries.length > 0) {
      this.lastEntryTimes.set(instanceId, position.entries[0].time);
    }
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

      // Statystyki odrzuconych sygnałów (jeśli je zapisujemy)
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

// Eksportuj singleton
const signalService = new SignalService();
module.exports = signalService;
