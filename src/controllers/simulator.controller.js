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

module.exports = {
  simulateMarketConditions,
};
