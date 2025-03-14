/**
 * Główny plik aplikacji
 * Konfiguruje Express i middleware
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const logger = require("./utils/logger");
const path = require("path");

// Utwórz aplikację Express
const app = express();

// Załaduj zmienne środowiskowe
require("dotenv").config();

// Podstawowe middleware bezpieczeństwa
app.use(helmet());

// Konfiguracja CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Logowanie requestów
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Parsowanie JSON body
app.use(express.json({ limit: "10mb" }));

// Parsowanie danych w URL
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serwowanie statycznych plików (jeśli potrzebne)
// app.use(express.static(path.join(__dirname, 'public')));

// Ustawienie zmiennych aplikacji
app.set("env", process.env.NODE_ENV || "development");

// Import tras API
// Na początku zakomentowane, odkomentuj gdy zaimplementujesz moduł routes
// const routes = require('./routes');
// app.use('/api', routes);

// Trasa sprawdzająca stan serwera
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: app.get("env"),
    uptime: process.uptime(),
  });
});

// Podstawowa trasa
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Binance Trading Bot API",
    version: "1.0.0",
    documentation: "/api/docs", // W przyszłości można dodać dokumentację API
  });
});

// Middleware obsługi błędów
app.use((err, req, res, next) => {
  logger.error(`Błąd: ${err.message}`, { stack: err.stack });

  // Obsługa błędów walidacji
  if (err.name === "ValidationError") {
    return res.status(400).json({
      error: "Błąd walidacji",
      details: err.details || err.message,
    });
  }

  // Obsługa błędów JWT
  if (err.name === "UnauthorizedError") {
    return res.status(401).json({
      error: "Nieautoryzowany",
      details: "Nieprawidłowy token lub token wygasł",
    });
  }

  // Domyślna odpowiedź błędu
  const statusCode = err.statusCode || 500;
  const message = err.statusCode ? err.message : "Wewnętrzny błąd serwera";

  res.status(statusCode).json({
    error: message,
    details: app.get("env") === "development" ? err.stack : null,
  });
});

// Handler dla tras, które nie istnieją (404)
app.use((req, res) => {
  res.status(404).json({
    error: "Nie znaleziono",
    details: `Trasa ${req.method} ${req.url} nie istnieje`,
  });
});

module.exports = app;
