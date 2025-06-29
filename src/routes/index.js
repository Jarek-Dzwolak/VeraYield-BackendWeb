/**
 * Routes Index - główny plik eksportujący wszystkie trasy API
 *
 * Odpowiedzialny za:
 * - Eksportowanie wszystkich modułów tras
 * - Konfigurację bazowych ścieżek API
 */

const express = require("express");
const router = express.Router();

// Importuj moduły tras
const authRoutes = require("./auth.routes");
const marketRoutes = require("./market.routes");
const signalRoutes = require("./signal.routes");
const instanceRoutes = require("./instance.routes");
const simulatorRoutes = require("./simulator.routes"); // Tylko do testów

// ✅ NOWE - Import kontrolera danych frontendowych i middleware autentykacji
const frontendDataController = require("../controllers/frontend-data.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Bazowa ścieżka API
const API_BASE = "/api/v1";

// Konfiguruj trasy
router.use(`${API_BASE}/auth`, authRoutes);
router.use(`${API_BASE}/market`, marketRoutes);
router.use(`${API_BASE}/signals`, signalRoutes);
router.use(`${API_BASE}/instances`, instanceRoutes);
router.use(`${API_BASE}/simulator`, simulatorRoutes); // Tylko do testów

// ✅ NOWE - Routing dla danych frontendowych z autentykacją
router.get(
  `${API_BASE}/frontend-data`,
  authMiddleware.verifyToken,
  frontendDataController.getAvailableFunctions
);
router.get(
  `${API_BASE}/frontend-data/hurst-history/:instanceId`,
  authMiddleware.verifyToken,
  frontendDataController.getHurstHistory
);
router.get(
  `${API_BASE}/frontend-data/parameters/:instanceId`,
  authMiddleware.verifyToken,
  frontendDataController.getInstanceParameters
);

// Podstawowa trasa dla sprawdzenia działania API
router.get(`${API_BASE}`, (req, res) => {
  // Pobierz host i protokół z nagłówków
  const host = req.get("host") || "localhost:3000";
  const wsProtocol = req.protocol === "https" ? "wss" : "ws";

  res.json({
    message: "Binance Trading Bot API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      auth: `${API_BASE}/auth`,
      market: `${API_BASE}/market`,
      signals: `${API_BASE}/signals`,
      instances: `${API_BASE}/instances`,
      frontendData: `${API_BASE}/frontend-data`, // ✅ NOWE
    },
    webSocket: {
      url: `${wsProtocol}://${host}`,
      endpoints: {
        trading: "/trading",
        marketData: "/market-data",
      },
      info: `${API_BASE}/market/ws-info`,
    },
  });
});

// Obsługa nieznanych tras API
router.all(`${API_BASE}/*`, (req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested endpoint does not exist",
  });
});

module.exports = router;
