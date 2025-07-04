/**
 * Server - plik uruchamiający serwer HTTP
 *
 * Odpowiedzialny za:
 * - Uruchomienie serwera HTTP
 * - Obsługę sygnałów zamknięcia
 * - Inicjalizację usług
 * - Konfigurację serwera WebSocket
 */

const http = require("http");
const WebSocket = require("ws");
const app = require("./app");
const logger = require("./utils/logger");
const instanceService = require("./services/instance.service");
const dbService = require("./services/db.service");
const binanceService = require("./services/binance.service");
const wsService = require("./services/ws.service");

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

    // Inicjalizacja serwera WebSocket
    logger.info("Inicjalizacja serwera WebSocket...");

    // Utwórz serwer WebSocket
    const wss = new WebSocket.Server({
      server,
      // Opcjonalna konfiguracja CORS jeśli frontend i backend są na różnych domenach
      verifyClient: (info, callback) => {
        // Sprawdź, czy żądanie pochodzi z dozwolonych źródeł
        const origin = info.req.headers.origin;
        const allowedOrigins = [
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          // Dodaj tutaj inne dozwolone originy dla Twojej aplikacji
        ];

        // W środowisku deweloperskim można pominąć weryfikację origin
        if (
          process.env.NODE_ENV === "development" ||
          !origin ||
          allowedOrigins.includes(origin)
        ) {
          callback(true);
        } else {
          callback(false, 403, "Niedozwolone źródło");
        }
        if (!process.env.JWT_SECRET) {
          console.error(
            "BŁĄD: Brak wymaganej zmiennej środowiskowej JWT_SECRET"
          );
          process.exit(1);
        }
      },
    });

    // Przekaż serwer WebSocket do serwisu WebSocket
    wsService.initialize(wss, binanceService);

    logger.info("Zainicjalizowano serwer WebSocket");

    // ZAKOMENTOWANE: Instancja "frontend" powoduje podwójne generowanie sygnałów
    // await analysisService.initializeInstance("frontend", {
    //   symbol: "BTCUSDT",
    //   hurst: { periods: 25, deviationFactor: 2.0 },
    //   ema: { periods: 30 },
    //   checkEMATrend: true,
    // });
    // logger.info("Zainicjalizowano instancję analizy dla frontendu");

    // Uruchom serwer HTTP
    server.listen(PORT, () => {
      logger.info(`Serwer HTTP uruchomiony na porcie ${PORT}`);
      logger.info(`Serwer WebSocket uruchomiony na ws://localhost:${PORT}`);
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

// Zamień istniejącą funkcję shutdown na tę:
const shutdown = async (signal) => {
  logger.info(
    `Otrzymano sygnał ${signal || "zamknięcia"}, zamykanie serwera...`
  );

  try {
    // KLUCZOWE: Najpierw zatrzymaj wszystkie instancje
    logger.info("Zatrzymywanie instancji strategii...");
    await instanceService.stopAllInstances();
    logger.info("Zatrzymano wszystkie instancje strategii");
  } catch (error) {
    logger.error(`Błąd podczas zatrzymywania instancji: ${error.message}`);
  }

  try {
    // Zamknij połączenia WebSocket
    logger.info("Zamykanie połączeń WebSocket...");
    binanceService.closeAllConnections();
    logger.info("Zamknięto wszystkie połączenia WebSocket");
  } catch (error) {
    logger.error(`Błąd podczas zamykania połączeń WebSocket: ${error.message}`);
  }

  try {
    // NOWE: Wyczyść cache przed zamknięciem
    logger.info("Czyszczenie cache danych rynkowych...");
    binanceService.clearAllCache();
    logger.info("Wyczyszczono cache danych rynkowych");
  } catch (error) {
    logger.error(`Błąd podczas czyszczenia cache: ${error.message}`);
  }

  try {
    // Zamknij połączenie z bazą danych
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
