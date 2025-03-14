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

class DatabaseService {
  constructor() {
    this.isConnected = false;
    this.connectionOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };
  }

  /**
   * Nawiązuje połączenie z bazą danych MongoDB
   * @param {string} uri - URI połączenia MongoDB
   * @returns {Promise<boolean>} - Czy połączenie zostało nawiązane
   */
  async connect(uri) {
    try {
      if (this.isConnected) {
        logger.info("Połączenie z bazą danych już istnieje");
        return true;
      }

      logger.info("Nawiązywanie połączenia z MongoDB...");

      // Dodaj listenery zdarzeń
      mongoose.connection.on("connected", () => {
        this.isConnected = true;
        logger.info("Połączono z bazą danych MongoDB");
      });

      mongoose.connection.on("error", (err) => {
        this.isConnected = false;
        logger.error(`Błąd połączenia z MongoDB: ${err.message}`);
      });

      mongoose.connection.on("disconnected", () => {
        this.isConnected = false;
        logger.warn("Rozłączono z bazą danych MongoDB");
      });

      // Nawiąż połączenie
      await mongoose.connect(uri, this.connectionOptions);

      // Konfiguracja indeksów (opcjonalnie)
      this._setupIndexes();

      return true;
    } catch (error) {
      this.isConnected = false;
      logger.error(`Błąd podczas łączenia z bazą danych: ${error.message}`);
      return false;
    }
  }

  /**
   * Rozłącza połączenie z bazą danych
   * @returns {Promise<boolean>} - Czy rozłączenie się powiodło
   */
  async disconnect() {
    try {
      if (!this.isConnected) {
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
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  /**
   * Konfiguruje indeksy w bazie danych
   * @private
   */
  _setupIndexes() {
    try {
      // Indeksy są zazwyczaj konfigurowane w modelach,
      // ale tutaj można dodać dodatkowe indeksy
      logger.debug("Skonfigurowano indeksy bazy danych");
    } catch (error) {
      logger.error(`Błąd podczas konfiguracji indeksów: ${error.message}`);
    }
  }

  /**
   * Wykonuje zapytanie do bazy danych
   * @param {Function} queryFn - Funkcja wykonująca zapytanie
   * @returns {Promise<any>} - Wynik zapytania
   */
  async executeQuery(queryFn) {
    try {
      if (!this.isConnectedToDatabase()) {
        throw new Error("Brak połączenia z bazą danych");
      }

      return await queryFn();
    } catch (error) {
      logger.error(`Błąd podczas wykonywania zapytania: ${error.message}`);
      throw error;
    }
  }

  /**
   * Tworzy transakcję bazodanową
   * @returns {Promise<mongoose.ClientSession>} - Sesja transakcji
   */
  async startTransaction() {
    try {
      if (!this.isConnectedToDatabase()) {
        throw new Error("Brak połączenia z bazą danych");
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
        throw new Error("Brak połączenia z bazą danych");
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
        throw new Error("Brak połączenia z bazą danych");
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
        throw new Error("Brak połączenia z bazą danych");
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
