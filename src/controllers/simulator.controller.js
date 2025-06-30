/**
 * Simulator Controller - kontroler symulacji rynku
 *
 * @temporary - Do usunięcia po testach
 */

const MarketSimulator = require("../utils/market-simulator");
const analysisService = require("../services/analysis.service");
const Instance = require("../models/instance.model");
const logger = require("../utils/logger");

/**
 * Symuluje warunki rynkowe
 */
const simulateMarketConditions = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { scenario = "lowerBandTouch" } = req.body;

    logger.info(
      `[SIMULATOR] Otrzymano żądanie symulacji: ${scenario} dla instancji ${instanceId}`
    );

    // Sprawdź czy instancja istnieje
    const instance = await Instance.findOne({ instanceId });
    if (!instance) {
      return res.status(404).json({
        error: "Instance not found",
        message: "Nie znaleziono instancji o podanym ID",
      });
    }

    // Pobierz aktualny stan analizy
    const analysisState = analysisService.getInstanceAnalysisState(instanceId);
    if (!analysisState) {
      return res.status(400).json({
        error: "Instance analysis not active",
        message:
          "Analiza dla tej instancji nie jest aktywna. Upewnij się, że instancja jest uruchomiona.",
      });
    }

    // Sprawdź czy mamy kanał Hursta
    if (!analysisState.hurstChannel) {
      return res.status(400).json({
        error: "Hurst channel not calculated",
        message:
          "Kanał Hursta nie został jeszcze obliczony. Poczekaj chwilę i spróbuj ponownie.",
      });
    }

    // Wykonaj symulację
    let result;
    switch (scenario) {
      case "lowerBandTouch":
        result = MarketSimulator.simulateLowerBandTouch(
          instanceId,
          analysisState
        );
        break;

      case "upperBandCross":
        result = MarketSimulator.simulateUpperBandCross(
          instanceId,
          analysisState
        );
        break;

      case "trailingStop":
        result = MarketSimulator.simulateTrailingStop(
          instanceId,
          analysisState
        );
        break;

      default:
        return res.status(400).json({
          error: "Unknown scenario",
          message: `Nieznany scenariusz: ${scenario}. Dostępne: lowerBandTouch, upperBandCross, trailingStop`,
        });
    }

    logger.info(
      `[SIMULATOR] Zakończono symulację ${scenario} dla instancji ${instanceId}`
    );

    return res.json({
      message: `Symulacja ${scenario} zakończona`,
      instanceId,
      scenario,
      timestamp: new Date().toISOString(),
      details: result,
      warning: "To jest symulacja testowa. Dane rynkowe są sztuczne.",
    });
  } catch (error) {
    logger.error(`[SIMULATOR] Błąd podczas symulacji: ${error.message}`);
    res.status(500).json({
      error: "Simulation error",
      message: error.message,
    });
  }
};
/**
 * Test pełnego cyklu upperBandState - symuluje rzeczywiste warunki
 */
const testUpperBandRealConditions = async (req, res) => {
  try {
    const { instanceId } = req.params;

    logger.info(
      `[UPPERBAND TEST] Rozpoczęcie testu dla instancji ${instanceId}`
    );

    // Sprawdź instancję
    const instanceService = require("../services/instance.service");
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Instance not found",
        message: `Nie znaleziono instancji ${instanceId}`,
      });
    }

    // Pobierz analysisService
    const analysisService = require("../services/analysis.service");
    const analysisState = analysisService.getInstanceAnalysisState(instanceId);

    if (!analysisState?.hurstChannel) {
      return res.status(400).json({
        error: "No Hurst Channel",
        message: "Brak kanału Hursta - uruchom instancję i poczekaj na dane",
      });
    }

    // Sprawdź pozycję
    const signalService = require("../services/signal.service");
    const activePosition = signalService.getActivePositions(instanceId);

    if (!activePosition || activePosition.status !== "active") {
      return res.status(400).json({
        error: "No Active Position",
        message:
          "Brak aktywnej pozycji - użyj /api/v1/signals/test-entry/{instanceId}",
      });
    }

    const currentPrice = analysisState.lastPrice || 70000;
    const upperBand = analysisState.hurstChannel.upperBand;
    const exitTrigger = upperBand * 1.001;

    logger.info(
      `[UPPERBAND TEST] Current: ${currentPrice}, UpperBand: ${upperBand}, ExitTrigger: ${exitTrigger}`
    );

    // === KROK 1: Symuluj przekroczenie exit trigger ===
    const triggerPrice = exitTrigger + 50;
    const triggerHigh = triggerPrice + 20;

    logger.info(
      `[UPPERBAND TEST] KROK 1: Symulacja przekroczenia exit trigger (${triggerPrice})`
    );

    // Wywołaj detectSignals bezpośrednio z triggering warunkami
    await analysisService.detectSignals(
      instanceId,
      triggerPrice, // currentPrice
      triggerHigh, // currentHigh
      triggerPrice - 30 // currentLow
    );

    // Poczekaj chwilę
    await sleep(1000);

    // === KROK 2: Sprawdź stan upperBandState ===
    const upperBandStateManager = require("../utils/upper-band-state-manager");
    const upperBandState = upperBandStateManager.getState(instanceId);

    logger.info(
      `[UPPERBAND TEST] KROK 2: Stan upperBandState: ${upperBandState?.currentState || "NULL"}`
    );

    // === KROK 3: Symuluj 15 minut w exit_counting ===
    if (upperBandState?.currentState === "exit_counting") {
      logger.info(
        `[UPPERBAND TEST] KROK 3: Symulacja 15 minut w exit_counting...`
      );

      // Wymuś przeskok czasu w upperBandState
      upperBandState.stateStartTime = Date.now() - (15 * 60 * 1000 + 1000); // 15 min + 1s

      // Wywołaj detectSignals ponownie
      await analysisService.detectSignals(
        instanceId,
        triggerPrice + 10,
        triggerPrice + 30,
        triggerPrice - 10
      );

      await sleep(1000);
    }

    // === KROK 4: Sprawdź czy przeszło do waiting_for_return ===
    const stateAfterExit = upperBandStateManager.getState(instanceId);
    logger.info(
      `[UPPERBAND TEST] KROK 4: Stan po exit counting: ${stateAfterExit?.currentState || "NULL"}`
    );

    // === KROK 5: Symuluj return trigger ===
    if (stateAfterExit?.currentState === "waiting_for_return") {
      const returnTrigger = upperBand * 0.999;
      const returnPrice = returnTrigger - 20;

      logger.info(
        `[UPPERBAND TEST] KROK 5: Symulacja return trigger (${returnPrice})`
      );

      await analysisService.detectSignals(
        instanceId,
        returnPrice,
        returnTrigger + 10,
        returnPrice - 10 // currentLow poniżej return trigger
      );

      await sleep(1000);
    }

    // === KROK 6: Wymusz 15 minut w return_counting ===
    const stateAfterReturn = upperBandStateManager.getState(instanceId);
    if (stateAfterReturn?.currentState === "return_counting") {
      logger.info(
        `[UPPERBAND TEST] KROK 6: Symulacja 15 minut w return_counting...`
      );

      // Wymuś przeskok czasu
      stateAfterReturn.stateStartTime = Date.now() - (15 * 60 * 1000 + 1000);

      // Ostateczne wywołanie - powinno zamknąć pozycję
      await analysisService.detectSignals(
        instanceId,
        upperBand * 0.995, // Cena poniżej bandy
        upperBand * 0.996,
        upperBand * 0.99
      );
    }

    // === WYNIK ===
    const finalPosition = signalService.getActivePositions(instanceId);
    const finalState = upperBandStateManager.getState(instanceId);

    res.json({
      success: true,
      message: "Test upperBandState zakończony",
      instanceId,
      initialConditions: {
        currentPrice,
        upperBand: upperBand.toFixed(2),
        exitTrigger: exitTrigger.toFixed(2),
      },
      results: {
        finalPositionStatus: finalPosition?.status || "CLOSED",
        finalUpperBandState: finalState?.currentState || "RESET",
        positionClosed: !finalPosition || finalPosition.status !== "active",
      },
      steps: [
        "1. Symulacja przekroczenia exit trigger",
        "2. Sprawdzenie inicjalizacji upperBandState",
        "3. Wymuszenie 15 min w exit_counting",
        "4. Przejście do waiting_for_return",
        "5. Symulacja return trigger",
        "6. Wymuszenie 15 min w return_counting",
        "7. Zamknięcie pozycji",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[UPPERBAND TEST] Błąd: ${error.message}`);
    res.status(500).json({
      error: "Test failed",
      message: error.message,
      stack: error.stack,
    });
  }
};

/**
 * Sprawdź aktualny stan upperBandState
 */
const checkUpperBandCurrentState = async (req, res) => {
  try {
    const { instanceId } = req.params;

    const analysisService = require("../services/analysis.service");
    const upperBandStateManager = require("../utils/upper-band-state-manager");
    const signalService = require("../services/signal.service");

    const analysisState = analysisService.getInstanceAnalysisState(instanceId);
    const upperBandState = upperBandStateManager.getState(instanceId);
    const activePosition = signalService.getActivePositions(instanceId);

    const currentPrice = analysisState?.lastPrice || "N/A";
    const upperBand = analysisState?.hurstChannel?.upperBand || "N/A";

    res.json({
      instanceId: instanceId.slice(-8),
      timestamp: new Date().toISOString(),

      currentPrice,
      upperBand:
        typeof upperBand === "number" ? upperBand.toFixed(2) : upperBand,
      exitTrigger:
        typeof upperBand === "number" ? (upperBand * 1.001).toFixed(2) : "N/A",

      position: activePosition
        ? {
            status: activePosition.status,
            entries: activePosition.entries.length,
            positionId: activePosition.positionId?.slice(-8),
          }
        : "NO_POSITION",

      upperBandState: upperBandState
        ? {
            currentState: upperBandState.currentState,
            stateStartTime: upperBandState.stateStartTime,
            timeInState: upperBandState.stateStartTime
              ? `${Math.floor((Date.now() - upperBandState.stateStartTime) / 60000)} min`
              : null,
          }
        : "NOT_INITIALIZED",

      readyForTest: !!(
        analysisState?.hurstChannel && activePosition?.status === "active"
      ),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DODAJ DO EKSPORTÓW w simulator.controller.js:
module.exports = {
  simulateMarketConditions, // istniejący
  testUpperBandRealConditions, // NOWY
  checkUpperBandCurrentState, // NOWY
};
