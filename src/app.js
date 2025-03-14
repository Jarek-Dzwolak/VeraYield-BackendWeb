/**
 * Main Application - główny plik aplikacji
 *
 * Odpowiedzialny za:
 * - Konfigurację serwera Express
 * - Inicjalizację middleware'ów
 * - Rejestrację tras
 * - Obsługę błędów
 */

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const compression = require("compression");
const routes = require("./routes");
const dbService = require("./services/db.service");
const logger = require("./utils/logger");
const { config } = require("./config/db.config");

// Utwórz aplikację Express
const app = express();

// Konfiguracja middleware'ów
app.use(helmet()); // Bezpieczeństwo HTTP
app.use(cors()); // Obsługa Cross-Origin Resource Sharing
app.use(compression()); // Kompresja odpowiedzi
app.use(express.json()); // Parsowanie JSON
app.use(express.urlencoded({ extended: true })); // Parsowanie formularzy
app.use(morgan("dev")); // Logowanie żądań HTTP

// Połącz z bazą danych
(async () => {
  try {
    await dbService.connect(config.uri);
    logger.info("Połączono z bazą danych MongoDB");
  } catch (error) {
    logger.error(`Błąd podczas łączenia z bazą danych: ${error.message}`);
  }
})();

// Zarejestruj wszystkie trasy
app.use(routes);

// Obsługa błędu 404 (nie znaleziono)
app.use((req, res, next) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested resource does not exist",
  });
});

// Obsługa błędów
app.use((err, req, res, next) => {
  logger.error(`Błąd aplikacji: ${err.message}`);

  // Obsługa błędów walidacji
  if (err.name === "ValidationError") {
    return res.status(400).json({
      error: "Validation Error",
      message: err.message,
      details: err.errors,
    });
  }

  // Obsługa błędów MongoDB
  if (err.name === "MongoError" || err.name === "MongoServerError") {
    return res.status(500).json({
      error: "Database Error",
      message: "An error occurred when interacting with the database",
    });
  }

  // Obsługa pozostałych błędów
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.name || "Internal Server Error",
    message: err.message || "Something went wrong on the server",
  });
});

module.exports = app;
