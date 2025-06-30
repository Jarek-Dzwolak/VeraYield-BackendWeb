/**
 * Simulator Routes - routing dla symulatora rynku
 *
 * @temporary - Do usunięcia po testach
 */

const express = require("express");
const router = express.Router();
const simulatorController = require("../controllers/simulator.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Tylko administratorzy mogą używać symulatora
router.use(authMiddleware.verifyToken);
router.use(authMiddleware.isAdmin);

// Endpoint symulacji
router.post(
  "/market/:instanceId",
  simulatorController.simulateMarketConditions
);

// === NOWE ENDPOINTY UPPERBAND ===
// Test pełnego cyklu upperBandState
router.post(
  "/upperband/:instanceId",
  simulatorController.testUpperBandRealConditions
);

// Check aktualnego stanu upperBandState
router.get(
  "/upperband-status/:instanceId",
  simulatorController.checkUpperBandCurrentState
);
// Wstrzykiwanie zdarzeń upperBandState
router.post("/inject-spike/:instanceId", simulatorController.injectPriceSpike);

// Informacja o dostępnych scenariuszach
router.get("/scenarios", (req, res) => {
  res.json({
    available_scenarios: [
      {
        name: "lowerBandTouch",
        description:
          "Symuluje dotknięcie dolnej bandy kanału Hursta (sygnał wejścia)",
      },
      {
        name: "upperBandCross",
        description:
          "Symuluje przekroczenie górnej bandy i powrót (sygnał wyjścia)",
      },
      {
        name: "trailingStop",
        description: "Symuluje warunki aktywacji trailing stop",
      },
    ],
    usage: "POST /api/v1/simulator/market/{instanceId}",
    example: {
      scenario: "lowerBandTouch",
    },
  });
});

module.exports = router;
