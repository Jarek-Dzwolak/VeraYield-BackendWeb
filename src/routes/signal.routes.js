/**
 * Signal Routes - ścieżki do obsługi sygnałów handlowych
 *
 * Zawiera endpointy:
 * - Pobieranie sygnałów handlowych
 * - Filtrowanie sygnałów
 * - Statystyki sygnałów
 */

const express = require("express");
const router = express.Router();
const signalController = require("../controllers/signal.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Middleware autentykacji dla wszystkich ścieżek
router.use(authMiddleware.verifyToken);

// Pobieranie wszystkich sygnałów
router.get("/", signalController.getAllSignals);

// Pobieranie sygnałów dla konkretnej instancji
router.get("/instance/:instanceId", signalController.getSignalsByInstance);

// Pobieranie konkretnego sygnału po ID
router.get("/:signalId", signalController.getSignalById);

// Pobieranie statystyk sygnałów
router.get("/stats", signalController.getSignalStats);

// Pobieranie statystyk sygnałów dla konkretnej instancji
router.get(
  "/stats/instance/:instanceId",
  signalController.getSignalStatsByInstance
);

// Pobieranie aktywnych pozycji
router.get("/positions/active", signalController.getActivePositions);

// Pobieranie historii pozycji
router.get("/positions/history", signalController.getPositionHistory);

// Pobieranie sygnałów wejścia
router.get("/entry", signalController.getEntrySignals);

// Pobieranie sygnałów wyjścia
router.get("/exit", signalController.getExitSignals);

// Pobieranie najnowszych sygnałów
router.get("/latest", signalController.getLatestSignals);

// Czyszczenie historii sygnałów dla instancji (tylko dla admina)
router.delete(
  "/instance/:instanceId",
  authMiddleware.isAdmin,
  signalController.clearSignalHistory
);

// Eksport sygnałów do CSV
router.get("/export", signalController.exportSignalsToCSV);

// Pobieranie sygnałów z określonego zakresu dat
router.get("/date-range", signalController.getSignalsByDateRange);

// Testowe routy
router.post("/test-entry/:instanceId", signalController.testEntrySignal);
router.post("/test-exit/:instanceId", signalController.testExitSignal);

module.exports = router;
