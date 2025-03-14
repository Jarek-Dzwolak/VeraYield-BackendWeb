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

// Inicjalizuj serwis instancji
(async () => {
  try {
    await instanceService.initialize();
    logger.info("Zainicjalizowano serwis instancji");
  } catch (error) {
    logger.error(
      `Błąd podczas inicjalizacji serwisu instancji: ${error.message}`
    );
  }
})();

// Uruchom serwer
server.listen(PORT, () => {
  logger.info(`Serwer HTTP uruchomiony na porcie ${PORT}`);
});

// Obsługa zamknięcia serwera (graceful shutdown)
const shutdown = async () => {
  logger.info("Otrzymano sygnał zamknięcia, zamykanie serwera...");

  // Zatrzymaj wszystkie instancje
  await instanceService.stopAllInstances();
  logger.info("Zatrzymano wszystkie instancje strategii");

  // Zamknij połączenie z bazą danych
  await dbService.disconnect();
  logger.info("Zamknięto połączenie z bazą danych");

  // Zamknij serwer HTTP
  server.close(() => {
    logger.info("Serwer HTTP zamknięty");
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
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Obsługa nieobsłużonych wyjątków
process.on("uncaughtException", (error) => {
  logger.error(`Nieobsłużony wyjątek: ${error.message}`);
  logger.error(error.stack);

  // W przypadku krytycznego błędu, zamknij aplikację
  shutdown();
});

// Obsługa nieobsłużonych odrzuceń Promise
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Nieobsłużone odrzucenie Promise:");
  logger.error(`Promise: ${promise}`);
  logger.error(`Powód: ${reason}`);

  // Dla nieobsłużonych odrzuceń, logujemy, ale nie zamykamy serwera
});
