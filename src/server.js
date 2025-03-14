/**
 * Server configuration file
 * Zarządza ustawieniami serwera HTTP i jego uruchomieniem
 */

const http = require("http");
const app = require("./app");
const logger = require("./utils/logger");
const { connectDB, closeDB } = require("./config/db.config");

// Załaduj zmienne środowiskowe
require("dotenv").config();

// Pobierz port ze zmiennych środowiskowych i zapisz w Express
const port = process.env.PORT || 3000;
app.set("port", port);

// Utwórz serwer HTTP
const server = http.createServer(app);

// Ustawienie WebSocket servera (jeśli potrzebne)
// To zostanie zaimplementowane w przyszłości w ramach serwisu Binance
// const { setupWebSocketServer } = require('./services/binance.service');
// setupWebSocketServer(server);

// Obsługa nieobsłużonych wyjątków
process.on("uncaughtException", (error) => {
  logger.error(`Nieobsłużony wyjątek: ${error.message}`, {
    stack: error.stack,
  });
  process.exit(1);
});

// Obsługa nieobsłużonych odrzuceń obietnic
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Nieobsłużone odrzucenie obietnicy:", promise, "powód:", reason);
  process.exit(1);
});

// Obsługa "graceful shutdown"
const shutdown = () => {
  logger.info("Otrzymano sygnał zakończenia, zamykanie serwera...");

  // Zamknij połączenia HTTP
  server.close(() => {
    logger.info("Serwer HTTP zamknięty");

    // Zamknij połączenie z bazą danych
    closeDB()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

  // Wymuszenie zamknięcia po 10s
  setTimeout(() => {
    logger.error("Nie można zamknąć połączeń w czasie, wymuszam zamknięcie");
    process.exit(1);
  }, 10000);
};

// Nasłuchiwanie sygnałów zakończenia
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Funkcja connectDB jest teraz zaimportowana z config/db.config.js

// Uruchomienie serwera
const startServer = async () => {
  try {
    // Połącz z bazą danych
    await connectDB();

    // Uruchom nasłuchiwanie HTTP
    server.listen(port);

    server.on("error", (error) => {
      if (error.syscall !== "listen") {
        throw error;
      }

      const bind = typeof port === "string" ? `pipe ${port}` : `port ${port}`;

      // Obsługa specyficznych błędów nasłuchiwania
      switch (error.code) {
        case "EACCES":
          logger.error(`${bind} wymaga podwyższonych uprawnień`);
          process.exit(1);
          break;
        case "EADDRINUSE":
          logger.error(`${bind} jest już używany`);
          process.exit(1);
          break;
        default:
          throw error;
      }
    });

    server.on("listening", () => {
      const addr = server.address();
      const bind =
        typeof addr === "string" ? `pipe ${addr}` : `port ${addr.port}`;
      logger.info(`Serwer nasłuchuje na ${bind}`);
    });

    logger.info(`Serwer uruchomiony na porcie ${port}`);
    logger.info(`Środowisko: ${process.env.NODE_ENV || "development"}`);
  } catch (error) {
    logger.error(`Nie udało się uruchomić serwera: ${error.message}`);
    process.exit(1);
  }
};

// Uruchom serwer
startServer();

module.exports = server; // Dla celów testowych
