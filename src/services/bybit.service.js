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
   * Otwiera pozycję futures (Market Order)
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
    const params = {
      category: "linear",
      symbol: symbol,
      side: side, // 'Buy' lub 'Sell'
      orderType: "Market",
      qty: quantity.toString(),
      positionIdx: positionIdx, // 1=Onesided, 2=Buyside, 0=Sell-side
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
  }
  /**
   * Zamyka pozycję futures
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
    const closeSide = side === "Buy" ? "Sell" : "Buy";

    return this.openPosition(
      apiKey,
      apiSecret,
      symbol,
      closeSide,
      quantity,
      positionIdx,
      subaccountId
    );
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
}

module.exports = new ByBitService();
