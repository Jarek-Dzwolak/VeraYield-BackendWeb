/**
 * WebSocket Utility - narzędzie pomocnicze do zarządzania połączeniami WebSocket
 *
 * Funkcje użytkowe do obsługi połączeń WebSocket, w tym:
 * - Śledzenie stanu połączenia
 * - Automatyczne ponowne łączenie
 * - Obsługa pingów/pongów
 */

const WebSocket = require("ws");
const logger = require("./logger");
const { EventEmitter } = require("events");

class WebSocketManager extends EventEmitter {
  /**
   * Tworzy nowy manager WebSocket
   * @param {Object} options - Opcje konfiguracyjne
   * @param {number} options.reconnectInterval - Czas w ms pomiędzy próbami ponownego połączenia (domyślnie: 5000)
   * @param {number} options.pingInterval - Czas w ms pomiędzy pingami (domyślnie: 30 * 60 * 1000 = 30 minut)
   * @param {number} options.maxReconnectAttempts - Maksymalna liczba prób ponownego połączenia (domyślnie: Infinity)
   */
  constructor(options = {}) {
    super();
    this.options = {
      reconnectInterval: 5000,
      pingInterval: 30 * 60 * 1000, // 30 minut
      maxReconnectAttempts: Infinity,
      ...options,
    };

    this.connections = new Map(); // url -> { ws, pingInterval, reconnectAttempts, status }
  }

  /**
   * Tworzy nowe połączenie WebSocket
   * @param {string} url - URL dla połączenia WebSocket
   * @param {string} id - Unikalny identyfikator połączenia (opcjonalnie)
   * @returns {WebSocket} - Instancja połączenia WebSocket
   */
  connect(url, id = url) {
    // Sprawdź, czy połączenie już istnieje
    if (this.connections.has(id)) {
      logger.warn(`Połączenie WebSocket dla ${id} już istnieje`);
      return this.connections.get(id).ws;
    }

    logger.info(`Nawiązywanie połączenia WebSocket dla ${id}`);

    // Utwórz nowe połączenie
    const ws = new WebSocket(url);

    // Utwórz obiekt stanu połączenia
    const connectionState = {
      ws,
      pingInterval: null,
      reconnectAttempts: 0,
      status: "connecting",
      url,
    };

    // Zapisz połączenie w mapie
    this.connections.set(id, connectionState);

    // Dodaj handlery zdarzeń
    this._setupEventHandlers(ws, id);

    return ws;
  }

  /**
   * Konfiguruje handlery zdarzeń dla połączenia WebSocket
   * @param {WebSocket} ws - Instancja WebSocket
   * @param {string} id - Identyfikator połączenia
   * @private
   */
  _setupEventHandlers(ws, id) {
    const connectionState = this.connections.get(id);

    ws.on("open", () => {
      logger.info(`Połączenie WebSocket otwarte dla ${id}`);

      // Zresetuj licznik prób ponownego połączenia
      connectionState.reconnectAttempts = 0;
      connectionState.status = "open";

      // Uruchom interwał pingowania
      connectionState.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          logger.debug(`Ping wysłany dla ${id}`);
        }
      }, this.options.pingInterval);

      // Emituj zdarzenie otwarcia
      this.emit("open", { id });
    });

    ws.on("message", (data) => {
      // Emituj zdarzenie message z danymi i identyfikatorem
      this.emit("message", {
        id,
        data: data instanceof Buffer ? data.toString() : data,
        raw: data,
      });
    });

    ws.on("pong", () => {
      logger.debug(`Otrzymano pong dla ${id}`);
      this.emit("pong", { id });
    });

    ws.on("error", (error) => {
      logger.error(`Błąd WebSocket dla ${id}: ${error.message}`);
      this.emit("error", { id, error });
    });

    ws.on("close", (code, reason) => {
      logger.warn(
        `Połączenie WebSocket zamknięte dla ${id}: kod=${code}, powód=${reason}`
      );

      // Wyczyść interwał pingowania
      if (connectionState.pingInterval) {
        clearInterval(connectionState.pingInterval);
        connectionState.pingInterval = null;
      }

      connectionState.status = "closed";

      // Emituj zdarzenie zamknięcia
      this.emit("close", { id, code, reason });

      // Automatyczne ponowne połączenie, jeśli nie przekroczono limitu prób
      if (
        connectionState.reconnectAttempts < this.options.maxReconnectAttempts
      ) {
        const reconnectDelay = this.options.reconnectInterval;

        logger.info(
          `Próba ponownego połączenia dla ${id} za ${reconnectDelay}ms (próba ${connectionState.reconnectAttempts + 1})`
        );

        // Zaplanuj ponowne połączenie
        setTimeout(() => {
          // Zwiększ licznik prób
          connectionState.reconnectAttempts++;

          // Utwórz nowe połączenie
          const newWs = new WebSocket(connectionState.url);

          // Aktualizuj stan
          connectionState.ws = newWs;
          connectionState.status = "connecting";

          // Skonfiguruj handlery zdarzeń dla nowego połączenia
          this._setupEventHandlers(newWs, id);

          // Emituj zdarzenie reconnect
          this.emit("reconnect", {
            id,
            attempts: connectionState.reconnectAttempts,
          });
        }, reconnectDelay);
      } else {
        logger.error(
          `Osiągnięto maksymalną liczbę prób ponownego połączenia dla ${id}`
        );

        // Usuń połączenie z mapy
        this.connections.delete(id);

        // Emituj zdarzenie maxReconnectAttemptsReached
        this.emit("maxReconnectAttemptsReached", { id });
      }
    });
  }

  /**
   * Wysyła dane przez połączenie WebSocket
   * @param {string} id - Identyfikator połączenia
   * @param {string|Object} data - Dane do wysłania (obiekt zostanie skonwertowany do JSON)
   * @returns {boolean} - Czy wysłanie się powiodło
   */
  send(id, data) {
    const connection = this.connections.get(id);

    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      logger.error(`Próba wysłania danych przez niepołączone WebSocket: ${id}`);
      return false;
    }

    // Konwertuj obiekt do JSON, jeśli to konieczne
    const messageData = typeof data === "object" ? JSON.stringify(data) : data;

    try {
      connection.ws.send(messageData);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas wysyłania danych przez WebSocket ${id}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Zamyka połączenie WebSocket
   * @param {string} id - Identyfikator połączenia
   * @param {number} code - Kod zamknięcia (opcjonalnie)
   * @param {string} reason - Powód zamknięcia (opcjonalnie)
   * @returns {boolean} - Czy zamknięcie się powiodło
   */
  close(id, code = 1000, reason = "Normal closure") {
    const connection = this.connections.get(id);

    if (!connection) {
      logger.warn(
        `Próba zamknięcia nieistniejącego połączenia WebSocket: ${id}`
      );
      return false;
    }

    try {
      // Wyczyść interwał pingowania
      if (connection.pingInterval) {
        clearInterval(connection.pingInterval);
      }

      // Zamknij połączenie
      connection.ws.close(code, reason);

      // Usuń połączenie z mapy
      this.connections.delete(id);

      logger.info(`Połączenie WebSocket zamknięte dla ${id}`);
      return true;
    } catch (error) {
      logger.error(
        `Błąd podczas zamykania połączenia WebSocket ${id}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Zamyka wszystkie połączenia WebSocket
   */
  closeAll() {
    for (const [id, connection] of this.connections.entries()) {
      // Wyczyść interwał pingowania
      if (connection.pingInterval) {
        clearInterval(connection.pingInterval);
      }

      // Zamknij połączenie
      connection.ws.close(1000, "Manager closed all connections");

      logger.info(`Połączenie WebSocket zamknięte dla ${id}`);
    }

    // Wyczyść mapę połączeń
    this.connections.clear();

    logger.info("Wszystkie połączenia WebSocket zostały zamknięte");
  }

  /**
   * Sprawdza, czy połączenie WebSocket jest aktywne
   * @param {string} id - Identyfikator połączenia
   * @returns {boolean} - Czy połączenie jest aktywne
   */
  isConnected(id) {
    const connection = this.connections.get(id);
    return connection && connection.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Pobiera status połączenia WebSocket
   * @param {string} id - Identyfikator połączenia
   * @returns {string|null} - Status połączenia ('connecting', 'open', 'closing', 'closed') lub null, jeśli nie istnieje
   */
  getConnectionStatus(id) {
    const connection = this.connections.get(id);

    if (!connection) {
      return null;
    }

    return connection.status;
  }

  /**
   * Pobiera wszystkie aktywne połączenia
   * @returns {Array} - Tablica identyfikatorów aktywnych połączeń
   */
  getActiveConnections() {
    const activeConnections = [];

    for (const [id, connection] of this.connections.entries()) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        activeConnections.push(id);
      }
    }

    return activeConnections;
  }
}

// Eksportuj singleton
const webSocketManager = new WebSocketManager();
module.exports = webSocketManager;
