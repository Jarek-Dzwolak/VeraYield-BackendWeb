/**
 * Server - plik uruchamiający serwer HTTP
 *
 * Odpowiedzialny za:
 * - Uruchomienie serwera HTTP
 * - Obsługę sygnałów zamknięcia
 * - Inicjalizację usług
 */

const http = require("http");
const app = require("./app");
const logger = require("./utils/logger");
const instanceService = require("./services/instance.service");
const dbService = require("./services/db.service");

// Pobierz port z zmiennych środowiskowych lub użyj domyślnego
const PORT = process.env.PORT || 3000;

// Utwórz serwer HTTP
const server = http.createServer(app);

/**
 * Funkcja inicjalizująca aplikację
 */
const initializeApp = async () => {
  try {
    // Najpierw połącz z bazą danych
    logger.info("Nawiązywanie połączenia z bazą danych...");
    const dbConnected = await dbService.connect();

    if (!dbConnected) {
      logger.error(
        "Nie udało się połączyć z bazą danych. Kończenie procesu uruchamiania."
      );
      process.exit(1);
    }

    logger.info("Połączono z bazą danych MongoDB");

    // Następnie zainicjalizuj serwis instancji
    logger.info("Inicjalizacja serwisu instancji...");
    await instanceService.initialize();
    logger.info("Zainicjalizowano serwis instancji");

    // Uruchom serwer HTTP
    server.listen(PORT, () => {
      logger.info(`Serwer HTTP uruchomiony na porcie ${PORT}`);
    });

    // Dodaj obsługę błędów serwera HTTP
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        logger.error(`Port ${PORT} jest już używany. Wybierz inny port.`);
        process.exit(1);
      } else {
        logger.error(`Błąd serwera HTTP: ${error.message}`);
      }
    });

    return true;
  } catch (error) {
    logger.error(`Błąd podczas inicjalizacji aplikacji: ${error.message}`);
    process.exit(1);
  }
};

// Uruchom aplikację
initializeApp().catch((error) => {
  logger.error(
    `Krytyczny błąd podczas uruchamiania aplikacji: ${error.message}`
  );
  process.exit(1);
});

// Obsługa zamknięcia serwera (graceful shutdown)
const shutdown = async (signal) => {
  logger.info(
    `Otrzymano sygnał ${signal || "zamknięcia"}, zamykanie serwera...`
  );

  // Zatrzymaj wszystkie instancje
  try {
    logger.info("Zatrzymywanie instancji strategii...");
    await instanceService.stopAllInstances();
    logger.info("Zatrzymano wszystkie instancje strategii");
  } catch (error) {
    logger.error(`Błąd podczas zatrzymywania instancji: ${error.message}`);
  }

  // Zamknij połączenie z bazą danych
  try {
    logger.info("Zamykanie połączenia z bazą danych...");
    await dbService.disconnect();
    logger.info("Zamknięto połączenie z bazą danych");
  } catch (error) {
    logger.error(
      `Błąd podczas zamykania połączenia z bazą danych: ${error.message}`
    );
  }

  // Zamknij serwer HTTP
  server.close(() => {
    logger.info("Serwer HTTP zamknięty");
    // Wyjdź z kodem 0 (sukces)
    process.exit(0);
  });

  // Jeśli serwer nie zamknie się w ciągu 10 sekund, wymuś zamknięcie
  setTimeout(() => {
    logger.error(
      "Przekroczono czas oczekiwania na zamknięcie serwera, wymuszam zamknięcie"
    );
    process.exit(1);
  }, 10000);
};

// Nasłuchuj sygnałów zamknięcia
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Obsługa nieobsłużonych wyjątków
process.on("uncaughtException", (error) => {
  logger.error(`Nieobsłużony wyjątek: ${error.message}`);
  logger.error(error.stack);

  // W przypadku krytycznego błędu, zamknij aplikację
  shutdown("uncaughtException");
});

// Obsługa nieobsłużonych odrzuceń Promise
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Nieobsłużone odrzucenie Promise:");
  logger.error(`Promise: ${promise}`);
  logger.error(`Powód: ${reason instanceof Error ? reason.stack : reason}`);

  // Dla nieobsłużonych odrzuceń logujemy, ale nie zamykamy serwera
  // Jeśli chcemy, aby aplikacja zamykała się również w takich przypadkach, odkomentuj:
  // shutdown("unhandledRejection");
});

// Eksportuj serwer (przydatne dla testów)
module.exports = server;
