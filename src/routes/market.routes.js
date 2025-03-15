/**
 * Market Routes - ścieżki do obsługi danych rynkowych
 *
 * Zawiera endpointy:
 * - Pobieranie aktualnych danych rynkowych
 * - Pobieranie historycznych danych
 * - Pobieranie listy dostępnych par handlowych
 */

const express = require("express");
const router = express.Router();
const marketController = require("../controllers/market.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Middleware autentykacji dla wszystkich ścieżek
router.use(authMiddleware.verifyToken);

// Pobieranie aktualnych cen dla pary handlowej
router.get("/ticker/:symbol", marketController.getCurrentPrice);

// Pobieranie historycznych danych świecowych
router.get("/klines/:symbol", marketController.getHistoricalCandles);

// Pobieranie danych świecowych z określonego zakresu
router.get(
  "/klines/:symbol/:interval",
  marketController.getHistoricalCandlesByInterval
);

// Pobieranie listy dostępnych par handlowych
router.get("/symbols", marketController.getAvailableSymbols);

// Streaming aktualnych cen (SSE - Server-Sent Events)
router.get("/stream/:symbol", marketController.streamMarketData);

// Pobieranie bieżących wskaźników technicznych dla pary
router.get("/indicators/:symbol", marketController.getIndicators);

// Pobieranie analizy rynku (połączone wskaźniki i rekomendacje)
router.get("/analysis/:symbol", marketController.getMarketAnalysis);

// Pobieranie danych o wolumenie dla pary
router.get("/volume/:symbol", marketController.getVolumeData);

// Pobieranie danych statystycznych dotyczących rynku
router.get("/stats/:symbol", marketController.getMarketStats);

router.get("/ws-info", marketController.getWebSocketInfo);

module.exports = router;
