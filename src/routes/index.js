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

// Bazowa ścieżka API
const API_BASE = "/api/v1";

// Konfiguruj trasy
router.use(`${API_BASE}/auth`, authRoutes);
router.use(`${API_BASE}/market`, marketRoutes);
router.use(`${API_BASE}/signals`, signalRoutes);
router.use(`${API_BASE}/instances`, instanceRoutes);

// Podstawowa trasa dla sprawdzenia działania API
router.get(`${API_BASE}`, (req, res) => {
  res.json({
    message: "Binance Trading Bot API",
    version: "1.0.0",
    status: "running",
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
