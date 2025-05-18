/**
 * ByBit Service - serwis do wystawiania zleceń na ByBit
 */

const crypto = require("crypto");
const axios = require("axios");
const logger = require("../utils/logger");

class ByBitService {
  constructor() {
    this.baseUrl =
      process.env.BYBIT_TESTNET === "true"
        ? "https://api-testnet.bybit.com"
        : "https://api.bybit.com";
    this.instrumentInfoCache = new Map(); // Keszowanie informacji o instrumentach
    this.instrumentCacheExpiry = 3600000; // 1 godzina w ms
  }

  /**
   * Tworzy podpis dla żądania
   */
  createSignature(apiKey, apiSecret, params, method = "GET") {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";

    let paramStr = "";

    if (method === "POST") {
      // Dla POST użyj JSON string
      paramStr = JSON.stringify(params);
    } else {
      // Dla GET użyj query string
      paramStr = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    }

    const signStr = timestamp + apiKey + recvWindow + paramStr;

    const sign = crypto
      .createHmac("sha256", apiSecret)
      .update(signStr)
      .digest("hex");

    return { sign, timestamp };
  }

  /**
   * Wykonuje żądanie do API ByBit
   */
  async makeRequest(method, endpoint, apiKey, apiSecret, params = {}) {
    try {
      // Stwórz kopię parametrów, żeby nie modyfikować oryginału
      const paramsCopy = { ...params };

      // Jeśli jest subaccountId, wyciągnij go przed utworzeniem podpisu
      const subaccountId = paramsCopy.subaccountId;
      if (subaccountId) {
        delete paramsCopy.subaccountId;
      }

      const { sign, timestamp } = this.createSignature(
        apiKey,
        apiSecret,
        paramsCopy,
        method
      );

      const headers = {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
        "Content-Type": "application/json",
      };

      // Dodaj Referer dla subkonta jeśli istnieje
      if (subaccountId) {
        headers["Referer"] = "ref-subaccount-" + subaccountId;
      }

      let config = {
        method,
        url: `${this.baseUrl}${endpoint}`,
        headers,
      };

      if (method === "GET") {
        const queryString = Object.keys(paramsCopy)
          .map((key) => `${key}=${encodeURIComponent(paramsCopy[key])}`)
          .join("&");

        if (queryString) {
          config.url += `?${queryString}`;
        }
      } else {
        config.data = paramsCopy;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      logger.error(`ByBit API error: ${error.message}`);
      if (error.response?.data) {
        logger.error(`ByBit response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Pobiera saldo konta
   */
  async getBalance(apiKey, apiSecret, subUid = null) {
    try {
      // Sprawdzamy UNIFIED account (tam są środki)
      const response = await this.makeRequest(
        "GET",
        "/v5/asset/transfer/query-account-coins-balance",
        apiKey,
        apiSecret,
        {
          accountType: "UNIFIED",
          coin: "USDT",
          memberId: subUid || undefined,
        }
      );

      if (response.result?.balance?.length > 0) {
        const balance = response.result.balance[0];
        return {
          retCode: 0,
          result: {
            list: [
              {
                accountType: "UNIFIED",
                coin: [
                  {
                    coin: "USDT",
                    walletBalance: balance.walletBalance,
                    availableToWithdraw: balance.transferBalance,
                  },
                ],
              },
            ],
          },
        };
      }
    } catch (error) {
      logger.error(`Error getting balance: ${error.message}`);
    }

    // Zwróć zero jeśli błąd lub brak środków
    return {
      retCode: 0,
      result: {
        list: [
          {
            accountType: "UNIFIED",
            coin: [
              {
                coin: "USDT",
                walletBalance: "0",
                availableToWithdraw: "0",
              },
            ],
          },
        ],
      },
    };
  }

  /**
   * Pobiera aktualny tryb pozycji konta
   */
  async getPositionMode(apiKey, apiSecret, subaccountId = null) {
    try {
      const params = {
        category: "linear",
      };

      if (subaccountId) {
        params.subaccountId = subaccountId;
      }

      const response = await this.makeRequest(
        "GET",
        "/v5/position/position-mode",
        apiKey,
        apiSecret,
        params
      );

      if (response.retCode === 0) {
        return response.result.mode; // 0: Merged Single (One-Way), 3: Both Sides (Hedge)
      }

      return null;
    } catch (error) {
      logger.error(`Error getting position mode: ${error.message}`);
      return null;
    }
  }

  /**
   * Ustawia tryb pozycji konta (One-Way Mode)
   */
  async setPositionMode(apiKey, apiSecret, subaccountId = null) {
    try {
      const params = {
        category: "linear",
        coin: "USDT", // Wymagane przy przełączaniu globalnego trybu pozycji
        mode: 0, // 0: Merged Single (One-Way Mode)
      };

      if (subaccountId) {
        params.subaccountId = subaccountId;
      }

      const response = await this.makeRequest(
        "POST",
        "/v5/position/switch-mode",
        apiKey,
        apiSecret,
        params
      );

      logger.info(
        `Ustawiono tryb pozycji na One-Way Mode: ${JSON.stringify(response)}`
      );
      return response;
    } catch (error) {
      logger.error(`Error setting position mode: ${error.message}`);
      throw error;
    }
  }

  /**
   * Otwiera pozycję futures (Market Order) - zawsze używa One-Way Mode
   */
  async openPosition(
    apiKey,
    apiSecret,
    symbol,
    side,
    quantity,
    positionIdx,
    subaccountId = null
  ) {
    try {
      // Najpierw upewnij się, że konto jest w trybie One-Way Mode
      await this.setPositionMode(apiKey, apiSecret, subaccountId);

      const params = {
        category: "linear",
        symbol: symbol,
        side: side, // 'Buy' lub 'Sell'
        orderType: "Market",
        qty: quantity.toString(),
        positionIdx: 0, // 0 = One-Way Mode (zawsze używamy tej wartości)
        timeInForce: "IOC",
        closeOnTrigger: false,
      };

      // Dodaj subaccountId jeśli został przekazany
      if (subaccountId) {
        params.subaccountId = subaccountId;
      }

      return this.makeRequest(
        "POST",
        "/v5/order/create",
        apiKey,
        apiSecret,
        params
      );
    } catch (error) {
      logger.error(`Error opening position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Zamyka pozycję futures - zawsze używa One-Way Mode
   */
  async closePosition(
    apiKey,
    apiSecret,
    symbol,
    side,
    quantity,
    positionIdx,
    subaccountId = null
  ) {
    try {
      const closeSide = side === "Buy" ? "Sell" : "Buy";

      const params = {
        category: "linear",
        symbol: symbol,
        side: closeSide,
        orderType: "Market",
        qty: quantity.toString(),
        positionIdx: 0, // 0 = One-Way Mode (zawsze używamy tej wartości)
        timeInForce: "IOC",
        closeOnTrigger: true, // Ustawione na true dla zamykania pozycji
      };

      // Dodaj subaccountId jeśli został przekazany
      if (subaccountId) {
        params.subaccountId = subaccountId;
      }

      return this.makeRequest(
        "POST",
        "/v5/order/create",
        apiKey,
        apiSecret,
        params
      );
    } catch (error) {
      logger.error(`Error closing position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ustawia dźwignię dla symbolu
   */
  async setLeverage(apiKey, apiSecret, symbol, leverage) {
    const params = {
      category: "linear",
      symbol: symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString(),
    };

    return this.makeRequest(
      "POST",
      "/v5/position/set-leverage",
      apiKey,
      apiSecret,
      params
    );
  }

  /**
   * Ustawia tryb marginu (isolated/cross)
   */
  async setMarginMode(apiKey, apiSecret, symbol, tradeMode) {
    const params = {
      category: "linear",
      symbol: symbol,
      tradeMode: tradeMode, // 0=cross, 1=isolated
    };

    return this.makeRequest(
      "POST",
      "/v5/position/switch-isolated",
      apiKey,
      apiSecret,
      params
    );
  }

  /**
   * Pobiera aktualną cenę
   */
  async getCurrentPrice(symbol) {
    try {
      const response = await axios.get(`${this.baseUrl}/v5/market/tickers`, {
        params: {
          category: "linear",
          symbol: symbol,
        },
      });

      if (response.data.retCode === 0 && response.data.result.list.length > 0) {
        return parseFloat(response.data.result.list[0].lastPrice);
      }

      throw new Error("Unable to fetch price");
    } catch (error) {
      logger.error(`Error fetching ByBit price: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera informacje o instrumencie handlowym (limity, krok wielkości itp.)
   */
  async getInstrumentInfo(symbol) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v5/market/instruments-info`,
        {
          params: {
            category: "linear",
            symbol: symbol,
          },
        }
      );

      if (response.data.retCode === 0 && response.data.result.list.length > 0) {
        const instrument = response.data.result.list[0];

        // Pobierz filtry dla wielkości zlecenia (lotSizeFilter)
        const lotSizeFilter = instrument.lotSizeFilter || {};

        return {
          symbol: instrument.symbol,
          minOrderQty: parseFloat(lotSizeFilter.minOrderQty || "0.001"),
          maxOrderQty: parseFloat(lotSizeFilter.maxOrderQty || "100"),
          qtyStep: parseFloat(lotSizeFilter.qtyStep || "0.001"),
          minOrderValue: parseFloat(instrument.minOrderValue || "10"),
        };
      }

      // Jeśli nie znaleziono informacji, zwróć domyślne wartości dla BTC/USDT
      logger.warn(
        `Nie znaleziono informacji o instrumencie ${symbol}, używam domyślnych wartości`
      );
      return {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 100,
        qtyStep: 0.001,
        minOrderValue: 10,
      };
    } catch (error) {
      logger.error(`Error fetching instrument info: ${error.message}`);
      // Zwróć domyślne wartości dla BTC/USDT w przypadku błędu
      return {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 100,
        qtyStep: 0.001,
        minOrderValue: 10,
      };
    }
  }

  /**
   * Pobiera zakeszowane informacje o instrumencie (dla optymalizacji wydajności)
   */
  async getCachedInstrumentInfo(symbol) {
    // Sprawdź, czy mamy zakeszowane informacje i czy nie wygasły
    const cached = this.instrumentInfoCache.get(symbol);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.instrumentCacheExpiry) {
      return cached.data;
    }

    // Pobierz nowe informacje z API
    const instrumentInfo = await this.getInstrumentInfo(symbol);

    // Zakeszuj nowe informacje
    this.instrumentInfoCache.set(symbol, {
      data: instrumentInfo,
      timestamp: now,
    });

    return instrumentInfo;
  }
}

module.exports = new ByBitService();
