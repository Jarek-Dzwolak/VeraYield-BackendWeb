/**
 * Database Service - serwis do obsługi bazy danych
 *
 * Odpowiedzialny za:
 * - Nawiązanie połączenia z MongoDB
 * - Zarządzanie połączeniem
 * - Operacje na bazie danych
 */

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const {
  getConnectionUri,
  getConnectionOptions,
} = require("../config/db.config");

class DatabaseService {
  constructor() {
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
  }

  /**
   * Nawiązuje połączenie z bazą danych MongoDB
   * @param {string} [uri=null] - Opcjonalne URI połączenia MongoDB, jeśli nie podane, użyje z konfiguracji
   * @returns {Promise<boolean>} - Czy połączenie zostało nawiązane
   */
  async connect(uri = null) {
    try {
      if (this.isConnected && mongoose.connection.readyState === 1) {
        logger.info("Połączenie z bazą danych już istnieje");
        return true;
      }

      // Jeśli podano URI, użyj go, w przeciwnym razie pobierz z konfiguracji
      const connectionUri = uri || getConnectionUri();
      const connectionOptions = getConnectionOptions();

      this.connectionAttempts++;
      logger.info(
        `Nawiązywanie połączenia z MongoDB... (próba ${this.connectionAttempts}/${this.maxConnectionAttempts})`
      );

      // Zamknij istniejące połączenie, jeśli istnieje
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        logger.info("Zamknięto poprzednie połączenie z MongoDB");
      }

      // Dodaj listenery zdarzeń
      mongoose.connection.on("connected", () => {
        this.isConnected = true;
        this.connectionAttempts = 0;
        logger.info("Połączono z bazą danych MongoDB");
      });

      mongoose.connection.on("error", (err) => {
        this.isConnected = false;
        logger.error(`Błąd połączenia z MongoDB: ${err.message}`);

        // Automatyczne ponowne połączenie, jeśli nie przekroczono limitu prób
        if (this.connectionAttempts < this.maxConnectionAttempts) {
          logger.info("Próba ponownego połączenia za 5 sekund...");
          setTimeout(() => this.connect(connectionUri), 5000);
        } else {
          logger.error(
            `Przekroczono maksymalną liczbę prób połączenia (${this.maxConnectionAttempts})`
          );
          this.connectionAttempts = 0;
        }
      });

      mongoose.connection.on("disconnected", () => {
        this.isConnected = false;
        logger.warn("Rozłączono z bazą danych MongoDB");
      });

      // Nawiąż połączenie
      await mongoose.connect(connectionUri, connectionOptions);

      // Sprawdź stan połączenia
      this.isConnected = mongoose.connection.readyState === 1;

      if (this.isConnected) {
        // Resetuj licznik prób po udanym połączeniu
        this.connectionAttempts = 0;

        // Konfiguracja indeksów (opcjonalnie)
        await this._setupIndexes();
      }

      return this.isConnected;
    } catch (error) {
      this.isConnected = false;
      logger.error(`Błąd podczas łączenia z bazą danych: ${error.message}`);

      // Jeśli błąd zawiera informacje o połączeniu Atlas
      if (error.message.includes("atlas") || error.message.includes("srv")) {
        logger.info(
          "Wskazówka: Sprawdź, czy używasz prawidłowego connection string dla MongoDB Atlas"
        );
        logger.info(
          "Format: mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>"
        );
      }
      // Jeśli jest to problem z lokalnym połączeniem
      else if (error.message.includes("ECONNREFUSED")) {
        logger.info(
          "Wskazówka: Lokalny serwer MongoDB nie jest uruchomiony lub jest niedostępny."
        );
        logger.info(
          "Uruchom MongoDB lokalnie lub skonfiguruj połączenie z MongoDB Atlas."
        );
      }

      // Automatyczne ponowne połączenie, jeśli nie przekroczono limitu prób
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        const retryDelay = Math.min(1000 * this.connectionAttempts, 10000); // Maksymalnie 10 sekund
        logger.info(
          `Próba ponownego połączenia za ${retryDelay / 1000} sekund...`
        );
        setTimeout(() => this.connect(uri), retryDelay);
        return false;
      } else {
        logger.error(
          `Przekroczono maksymalną liczbę prób połączenia (${this.maxConnectionAttempts})`
        );
        this.connectionAttempts = 0;
        return false;
      }
    }
  }

  /**
   * Rozłącza połączenie z bazą danych
   * @returns {Promise<boolean>} - Czy rozłączenie się powiodło
   */
  async disconnect() {
    try {
      if (!this.isConnected || mongoose.connection.readyState === 0) {
        logger.info("Brak aktywnego połączenia z bazą danych");
        return true;
      }

      await mongoose.disconnect();
      this.isConnected = false;
      logger.info("Rozłączono z bazą danych MongoDB");
      return true;
    } catch (error) {
      logger.error(`Błąd podczas rozłączania z bazą danych: ${error.message}`);
      return false;
    }
  }

  /**
   * Sprawdza stan połączenia z bazą danych
   * @returns {boolean} - Czy połączenie jest aktywne
   */
  isConnectedToDatabase() {
    const connectionState = mongoose.connection.readyState;
    this.isConnected = connectionState === 1;
    return this.isConnected;
  }

  /**
   * Konfiguruje indeksy w bazie danych
   * @private
   */
  async _setupIndexes() {
    try {
      // Implementacja konfiguracji indeksów dla modeli
      // (tutaj można dodać kod do automatycznego tworzenia indeksów)

      // Przykładowa weryfikacja indeksów dla kolekcji sygnałów
      const signalIndexes = [
        { instanceId: 1, createdAt: -1 },
        { instanceId: 1, type: 1 },
        { instanceId: 1, symbol: 1 },
      ];

      // Tworzymy indeksy na kolekcji sygnałów, jeśli istnieje
      if (mongoose.connection.db.collection("signals")) {
        for (const index of signalIndexes) {
          await mongoose.connection.db.collection("signals").createIndex(index);
        }
      }

      logger.debug("Skonfigurowano indeksy bazy danych");
      return true;
    } catch (error) {
      logger.error(`Błąd podczas konfiguracji indeksów: ${error.message}`);
      return false;
    }
  }

  /**
   * Wykonuje zapytanie do bazy danych
   * @param {Function} queryFn - Funkcja wykonująca zapytanie
   * @param {number} [retryCount=3] - Liczba prób wykonania zapytania
   * @returns {Promise<any>} - Wynik zapytania
   */
  async executeQuery(queryFn, retryCount = 3) {
    let attempts = 0;

    const execute = async () => {
      try {
        attempts++;

        if (!this.isConnectedToDatabase()) {
          // Jeśli nie jesteśmy połączeni, spróbuj ponownie się połączyć
          logger.warn(
            "Brak połączenia z bazą danych, próba ponownego połączenia..."
          );
          const connected = await this.connect();

          if (!connected) {
            throw new Error("Nie można połączyć się z bazą danych");
          }
        }

        return await queryFn();
      } catch (error) {
        logger.error(
          `Błąd podczas wykonywania zapytania (próba ${attempts}/${retryCount}): ${error.message}`
        );

        // Jeśli to błąd połączenia i mamy jeszcze próby, spróbuj ponownie
        if (
          attempts < retryCount &&
          (error.name === "MongoNetworkError" ||
            error.message.includes("ECONNREFUSED"))
        ) {
          logger.info(`Ponowna próba wykonania zapytania za 1 sekundę...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return await execute();
        }

        throw error;
      }
    };

    return await execute();
  }

  /**
   * Tworzy transakcję bazodanową
   * @returns {Promise<mongoose.ClientSession>} - Sesja transakcji
   */
  async startTransaction() {
    try {
      if (!this.isConnectedToDatabase()) {
        // Spróbuj ponownie się połączyć
        const connected = await this.connect();

        if (!connected) {
          throw new Error("Brak połączenia z bazą danych");
        }
      }

      const session = await mongoose.startSession();
      session.startTransaction();
      return session;
    } catch (error) {
      logger.error(`Błąd podczas rozpoczynania transakcji: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wykonuje operacje w ramach transakcji
   * @param {Function} operationsFn - Funkcja wykonująca operacje
   * @returns {Promise<any>} - Wynik operacji
   */
  async withTransaction(operationsFn) {
    let session = null;
    try {
      session = await this.startTransaction();

      // Wykonaj operacje
      const result = await operationsFn(session);

      // Zatwierdź transakcję
      await session.commitTransaction();
      session.endSession();

      return result;
    } catch (error) {
      logger.error(`Błąd podczas wykonywania transakcji: ${error.message}`);

      // Wycofaj transakcję w przypadku błędu
      if (session) {
        await session.abortTransaction();
        session.endSession();
      }

      throw error;
    }
  }

  /**
   * Wykonuje kopię zapasową kolekcji
   * @param {string} collectionName - Nazwa kolekcji
   * @returns {Promise<Array>} - Dane z kolekcji
   */
  async backupCollection(collectionName) {
    try {
      if (!this.isConnectedToDatabase()) {
        const connected = await this.connect();

        if (!connected) {
          throw new Error("Brak połączenia z bazą danych");
        }
      }

      const collection = mongoose.connection.collection(collectionName);
      return await collection.find({}).toArray();
    } catch (error) {
      logger.error(
        `Błąd podczas tworzenia kopii zapasowej kolekcji ${collectionName}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Przywraca kolekcję z kopii zapasowej
   * @param {string} collectionName - Nazwa kolekcji
   * @param {Array} data - Dane do przywrócenia
   * @returns {Promise<boolean>} - Czy przywrócenie się powiodło
   */
  async restoreCollection(collectionName, data) {
    try {
      if (!this.isConnectedToDatabase()) {
        const connected = await this.connect();

        if (!connected) {
          throw new Error("Brak połączenia z bazą danych");
        }
      }

      const collection = mongoose.connection.collection(collectionName);

      // Usuń istniejące dokumenty
      await collection.deleteMany({});

      // Wstaw dane z kopii zapasowej
      if (data.length > 0) {
        await collection.insertMany(data);
      }

      logger.info(
        `Przywrócono kolekcję ${collectionName} z kopii zapasowej (${data.length} dokumentów)`
      );
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas przywracania kolekcji ${collectionName}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Pobiera statystyki bazy danych
   * @returns {Promise<Object>} - Statystyki bazy danych
   */
  async getDatabaseStats() {
    try {
      if (!this.isConnectedToDatabase()) {
        const connected = await this.connect();

        if (!connected) {
          throw new Error("Brak połączenia z bazą danych");
        }
      }

      const db = mongoose.connection.db;
      const stats = await db.stats();

      // Pobierz statystyki kolekcji
      const collections = await db.listCollections().toArray();
      const collectionStats = {};

      for (const collection of collections) {
        const collectionName = collection.name;
        const collStat = await db.collection(collectionName).stats();

        collectionStats[collectionName] = {
          count: collStat.count,
          size: collStat.size,
          avgObjSize: collStat.avgObjSize,
        };
      }

      return {
        database: stats.db,
        collections: stats.collections,
        totalDocuments: stats.objects,
        dataSize: stats.dataSize,
        storageSize: stats.storageSize,
        collectionStats,
      };
    } catch (error) {
      logger.error(
        `Błąd podczas pobierania statystyk bazy danych: ${error.message}`
      );
      throw error;
    }
  }
}

// Eksportuj singleton
const dbService = new DatabaseService();
module.exports = dbService;
