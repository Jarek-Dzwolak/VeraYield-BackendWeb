/**
 * WebSocket Service - obsługa komunikacji WebSocket z klientami
 *
 * Odpowiedzialny za:
 * - Inicjalizację serwera WebSocket
 * - Obsługę połączeń klientów
 * - Przekazywanie danych z Binance do klientów
 * - Zarządzanie subskrypcjami
 */

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid"); // Jeśli nie masz uuid, zainstaluj: npm install uuid
const logger = require("../utils/logger");
const jwt = require("jsonwebtoken");
const analysisService = require("./analysis.service");

// Sekret JWT (powinien być zgodny z tym z auth.middleware.js)
const JWT_SECRET = process.env.JWT_SECRET;
class WebSocketService {
  constructor() {
    this.wss = null;
    this.binanceService = null;
    this.clients = new Map(); // Mapa klientów (WebSocket -> { id, subscriptions })
  }

  /**
   * Inicjalizuje serwer WebSocket
   * @param {WebSocket.Server} wss - Instancja serwera WebSocket
   * @param {BinanceService} binanceService - Serwis do komunikacji z Binance
   */
  initialize(wss, binanceService) {
    this.wss = wss;
    this.binanceService = binanceService;

    // Obsługa nowych połączeń
    this.wss.on("connection", (ws, req) => {
      try {
        // Pobierz token z URL (np. ?token=xxx)
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get("token");

        if (!token) {
          // Wyślij komunikat o błędzie przed zamknięciem połączenia
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Unauthorized",
              message: "No authorization token provided",
            })
          );

          // Zamknij połączenie z kodem 1008 (Policy Violation)
          ws.close(1008, "Unauthorized: No token provided");
          logger.error(`Połączenie WebSocket bez tokenu odrzucone`);
          return;
        }

        // Weryfikacja tokenu JWT
        let decoded;
        try {
          decoded = jwt.verify(token, JWT_SECRET);
        } catch (tokenError) {
          // Wyślij komunikat o błędzie przed zamknięciem połączenia
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Unauthorized",
              message: "Invalid token",
            })
          );

          ws.close(1008, "Unauthorized: Invalid token");
          logger.error(`Nieprawidłowy token JWT: ${tokenError.message}`);
          return;
        }

        // Generuj unikalny identyfikator dla klienta
        const clientId = uuidv4();

        // Dodaj klienta do mapy
        this.clients.set(ws, {
          id: clientId,
          userId: decoded.id,
          email: decoded.email,
          role: decoded.role,
          path: req.url,
          subscriptions: [],
          connected: Date.now(),
        });

        logger.info(
          `Nowe połączenie WebSocket: id=${clientId}, użytkownik=${decoded.email}, rola=${decoded.role}`
        );

        // Obsługa wiadomości od klienta
        ws.on("message", (message) => {
          try {
            const data = JSON.parse(message);
            this._handleClientMessage(ws, data);
          } catch (error) {
            logger.error(
              `Błąd podczas przetwarzania wiadomości WebSocket: ${error.message}`
            );
            this._sendError(ws, "Nieprawidłowy format wiadomości");
          }
        });

        // Obsługa zamknięcia połączenia
        ws.on("close", () => {
          const client = this.clients.get(ws);
          if (client) {
            logger.info(
              `Zamknięto połączenie WebSocket: id=${client.id}, użytkownik=${client.email}`
            );

            // Anuluj wszystkie subskrypcje
            if (this.binanceService) {
              this.binanceService.unsubscribeAllClientData(client.id);
            }

            // Usuń klienta z mapy
            this.clients.delete(ws);
          }
        });

        // Obsługa błędów
        ws.on("error", (error) => {
          const client = this.clients.get(ws);
          const clientId = client ? client.id : "nieznany";
          const userEmail = client ? client.email : "nieznany";
          logger.error(
            `Błąd WebSocket dla klienta ${clientId} (${userEmail}): ${error.message}`
          );
        });

        // Wyślij potwierdzenie połączenia
        this._sendToClient(ws, {
          type: "connection",
          status: "connected",
          clientId,
          userEmail: decoded.email,
          timestamp: Date.now(),
        });
      } catch (e) {
        logger.error(
          `Ogólny błąd podczas obsługi połączenia WebSocket: ${e.message}`
        );

        try {
          // Próba wysłania informacji o błędzie
          ws.send(
            JSON.stringify({
              type: "error",
              error: "InternalError",
              message: "Internal server error during connection setup",
            })
          );

          ws.close(1011, "Internal server error");
        } catch (sendError) {
          // Jeśli nawet nie możemy wysłać komunikatu o błędzie, po prostu logujemy
          logger.error(
            `Nie udało się wysłać komunikatu o błędzie: ${sendError.message}`
          );
        }
      }
    });

    // Nasłuchuj aktualizacji kanału Hursta
    analysisService.on("hurstUpdated", (data) => {
      // Sprawdź, czy to instancja dla frontendu
      if (data.instanceId === "frontend") {
        // Wyślij aktualizację do wszystkich klientów subskrybujących ten symbol
        this.broadcastToSymbolSubscribers(data.result.lastCandle.symbol, {
          type: "indicators",
          hurstChannel: data.result,
          timestamp: Date.now(),
        });
      }
    });

    // Nasłuchuj aktualizacji EMA
    analysisService.on("emaUpdated", (data) => {
      if (data.instanceId === "frontend") {
        this.broadcastToSymbolSubscribers(data.candle.symbol, {
          type: "indicators",
          emaValue: data.value,
          timestamp: Date.now(),
        });
      }
    });

    logger.info("Serwer WebSocket zainicjalizowany");
  }

  /**
   * Obsługuje wiadomość od klienta
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {Object} message - Wiadomość od klienta
   * @private
   */
  _handleClientMessage(ws, message) {
    const client = this.clients.get(ws);

    if (!client) {
      logger.error("Otrzymano wiadomość od niezarejestrowanego klienta");
      return;
    }

    logger.debug(
      `Otrzymano wiadomość od klienta ${client.id}: ${JSON.stringify(message)}`
    );

    // Obsługa różnych typów wiadomości
    switch (message.type) {
      case "subscribe":
        this._handleSubscribeRequest(ws, client, message);
        break;

      case "unsubscribe":
        this._handleUnsubscribeRequest(ws, client, message);
        break;

      case "ping":
        // Odpowiedz pongiem
        this._sendToClient(ws, {
          type: "pong",
          timestamp: Date.now(),
        });
        break;

      case "getStatus":
        this._handleStatusRequest(ws, client);
        break;

      default:
        logger.warn(
          `Nieznany typ wiadomości od klienta ${client.id}: ${message.type}`
        );
        this._sendError(ws, `Nieznany typ wiadomości: ${message.type}`);
    }
  }

  /**
   * Obsługuje żądanie subskrypcji danych
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {Object} client - Informacje o kliencie
   * @param {Object} message - Wiadomość od klienta
   * @private
   */
  _handleSubscribeRequest(ws, client, message) {
    // Sprawdź wymagane pola
    if (!message.symbol || !message.interval) {
      this._sendError(ws, "Brak wymaganych pól: symbol, interval");
      return;
    }

    const { symbol, interval } = message;

    // Sprawdź, czy interwał jest obsługiwany
    const supportedIntervals = [
      "1m",
      "3m",
      "5m",
      "15m",
      "30m",
      "1h",
      "2h",
      "4h",
      "6h",
      "8h",
      "12h",
      "1d",
      "3d",
      "1w",
      "1M",
    ];
    if (!supportedIntervals.includes(interval)) {
      this._sendError(ws, `Nieobsługiwany interwał: ${interval}`);
      return;
    }

    logger.info(`Klient ${client.id} subskrybuje dane: ${symbol}/${interval}`);

    // Stwórz identyfikator subskrypcji
    const subscriptionId = `${symbol}-${interval}`;

    // Sprawdź, czy subskrypcja już istnieje
    if (client.subscriptions.includes(subscriptionId)) {
      this._sendToClient(ws, {
        type: "warning",
        message: `Już subskrybujesz dane ${symbol}/${interval}`,
        subscriptionId,
      });
      return;
    }

    // Dodaj subskrypcję
    client.subscriptions.push(subscriptionId);

    // Utwórz funkcję callbacka do przekazywania danych do klienta
    const dataCallback = (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        this._sendToClient(ws, {
          type: "marketData",
          subscriptionId,
          symbol,
          interval,
          ...data,
        });
      }
    };

    // Subskrybuj dane z serwisu Binance
    this.binanceService.subscribeClientToMarketData(
      client.id,
      symbol,
      interval,
      dataCallback
    );

    // Po udanej subskrypcji, wyślij również informacje o kanale Hursta
    const instanceId = "frontend"; // Używamy stałego ID dla frontendu
    const analysisState = analysisService.getInstanceAnalysisState(instanceId);

    if (analysisState && analysisState.hurstChannel) {
      this._sendToClient(ws, {
        type: "indicators",
        subscriptionId,
        symbol,
        interval,
        hurstChannel: analysisState.hurstChannel,
        emaValue: analysisState.emaValue,
        timestamp: Date.now(),
      });
    }

    // Potwierdzenie subskrypcji
    this._sendToClient(ws, {
      type: "subscribed",
      subscriptionId,
      symbol,
      interval,
      timestamp: Date.now(),
    });
  }

  /**
   * Obsługuje żądanie anulowania subskrypcji
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {Object} client - Informacje o kliencie
   * @param {Object} message - Wiadomość od klienta
   * @private
   */
  _handleUnsubscribeRequest(ws, client, message) {
    // Sprawdź wymagane pola
    if (!message.symbol || !message.interval) {
      this._sendError(ws, "Brak wymaganych pól: symbol, interval");
      return;
    }

    const { symbol, interval } = message;
    const subscriptionId = `${symbol}-${interval}`;

    // Sprawdź, czy taka subskrypcja istnieje
    const subscriptionIndex = client.subscriptions.indexOf(subscriptionId);
    if (subscriptionIndex === -1) {
      this._sendError(ws, `Nie znaleziono subskrypcji: ${subscriptionId}`);
      return;
    }

    // Usuń subskrypcję
    client.subscriptions.splice(subscriptionIndex, 1);

    // Anuluj subskrypcję w serwisie Binance
    this.binanceService.unsubscribeClientFromMarketData(
      client.id,
      symbol,
      interval
    );

    // Potwierdzenie anulowania subskrypcji
    this._sendToClient(ws, {
      type: "unsubscribed",
      subscriptionId,
      symbol,
      interval,
      timestamp: Date.now(),
    });

    logger.info(`Klient ${client.id} anulował subskrypcję: ${subscriptionId}`);
  }

  /**
   * Obsługuje żądanie statusu
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {Object} client - Informacje o kliencie
   * @private
   */
  _handleStatusRequest(ws, client) {
    this._sendToClient(ws, {
      type: "status",
      clientId: client.id,
      userEmail: client.email,
      connected: client.connected,
      subscriptions: client.subscriptions,
      connectionTime: Date.now() - client.connected,
      timestamp: Date.now(),
    });
  }

  /**
   * Wysyła wiadomość do klienta
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {Object} data - Dane do wysłania
   * @private
   */
  _sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (error) {
        logger.error(
          `Błąd podczas wysyłania wiadomości do klienta: ${error.message}`
        );
      }
    }
  }

  /**
   * Wysyła komunikat o błędzie do klienta
   * @param {WebSocket} ws - Połączenie WebSocket klienta
   * @param {string} message - Treść błędu
   * @private
   */
  _sendError(ws, message) {
    this._sendToClient(ws, {
      type: "error",
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Wysyła wiadomość broadcast do wszystkich podłączonych klientów
   * @param {Object} data - Dane do wysłania
   * @param {Function} filter - Opcjonalna funkcja filtrująca klientów (zwraca true dla klientów, do których wysłać wiadomość)
   */
  broadcast(data, filter = null) {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        if (!filter || filter(client)) {
          client.send(JSON.stringify(data));
        }
      }
    });
  }

  /**
   * Wysyła wiadomość do wszystkich klientów subskrybujących dany symbol
   * @param {string} symbol - Symbol pary handlowej
   * @param {Object} data - Dane do wysłania
   */
  broadcastToSymbolSubscribers(symbol, data) {
    for (const [ws, client] of this.clients.entries()) {
      // Sprawdź, czy klient subskrybuje dany symbol
      const hasSymbolSubscription = client.subscriptions.some((s) =>
        s.startsWith(`${symbol.toLowerCase()}-`)
      );

      if (hasSymbolSubscription && ws.readyState === WebSocket.OPEN) {
        this._sendToClient(ws, data);
      }
    }
  }

  /**
   * Zamyka wszystkie połączenia klientów
   */
  closeAllConnections() {
    for (const [ws, client] of this.clients.entries()) {
      try {
        // Anuluj wszystkie subskrypcje
        if (this.binanceService) {
          this.binanceService.unsubscribeAllClientData(client.id);
        }

        // Wyślij komunikat o zamknięciu
        this._sendToClient(ws, {
          type: "shutdown",
          message: "Serwer zamykany",
          timestamp: Date.now(),
        });

        // Zamknij połączenie
        ws.close();

        logger.info(`Zamknięto połączenie z klientem ${client.id}`);
      } catch (error) {
        logger.error(
          `Błąd podczas zamykania połączenia z klientem ${client.id}: ${error.message}`
        );
      }
    }

    // Wyczyść mapę klientów
    this.clients.clear();
  }

  /**
   * Zwraca liczbę aktywnych klientów
   * @returns {number} - Liczba aktywnych klientów
   */
  getActiveClientCount() {
    return this.clients.size;
  }
}

// Eksportuj singleton
const wsService = new WebSocketService();
module.exports = wsService;
