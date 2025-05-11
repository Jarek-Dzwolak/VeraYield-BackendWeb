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
  /**
   * Tworzy podpis dla żądania
   */

  createSignature(apiKey, apiSecret, params) {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";

    // Sortuj parametry i utwórz query string
    const queryString = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");

    // Dla ByBit API v5: timestamp + apiKey + recvWindow + queryString
    const signStr = timestamp + apiKey + recvWindow + queryString;

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
      // Przekaż apiKey do createSignature
      const { sign, timestamp } = this.createSignature(
        apiKey,
        apiSecret,
        params
      );

      const headers = {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
        "Content-Type": "application/json",
      };

      let config = {
        method,
        url: `${this.baseUrl}${endpoint}`,
        headers,
      };

      // Dla GET requestów parametry idą w URL
      if (method === "GET") {
        const queryString = Object.keys(params)
          .map((key) => `${key}=${encodeURIComponent(params[key])}`)
          .join("&");

        if (queryString) {
          config.url += `?${queryString}`;
        }
      } else {
        // Dla POST requestów parametry idą w body
        config.data = params;
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
  // Dodaj tę nową funkcję:
  async getAccountInfo(apiKey, apiSecret) {
    // Używamy endpointu account info który może działać z uprawnieniami Contract
    return this.makeRequest("GET", "/v5/account/info", apiKey, apiSecret, {});
  }

  async getBalance(apiKey, apiSecret, subUid = null) {
    try {
      console.log("=== GETTING BALANCE ===");
      console.log(
        "Using endpoint: /v5/asset/transfer/query-account-coins-balance"
      );

      // Używamy właściwego endpointu z dokumentacji
      const response = await this.makeRequest(
        "GET",
        "/v5/asset/transfer/query-account-coins-balance",
        apiKey,
        apiSecret,
        {
          accountType: "UNIFIED",
          coin: "USDT", // Możemy też nie podawać, żeby dostać wszystkie
          memberId: subUid || undefined, // Dodajemy memberId jeśli mamy subUid
        }
      );

      console.log("Balance response:", JSON.stringify(response, null, 2));

      if (response.result?.balance?.length > 0) {
        // Przekształcamy odpowiedź do formatu, którego oczekuje reszta aplikacji
        return {
          retCode: 0,
          result: {
            list: [
              {
                accountType: "UNIFIED",
                coin: response.result.balance.map((b) => ({
                  coin: b.coin,
                  walletBalance: b.walletBalance,
                  availableToWithdraw: b.transferBalance,
                })),
              },
            ],
          },
        };
      }

      // Jeśli UNIFIED nie zwróciło danych, spróbuj FUND
      const fundResponse = await this.makeRequest(
        "GET",
        "/v5/asset/transfer/query-account-coins-balance",
        apiKey,
        apiSecret,
        {
          accountType: "FUND",
          coin: "USDT",
          memberId: subUid || undefined,
        }
      );

      console.log("FUND response:", JSON.stringify(fundResponse, null, 2));

      if (fundResponse.result?.balance?.length > 0) {
        return {
          retCode: 0,
          result: {
            list: [
              {
                accountType: "FUND",
                coin: fundResponse.result.balance.map((b) => ({
                  coin: b.coin,
                  walletBalance: b.walletBalance,
                  availableToWithdraw: b.transferBalance,
                })),
              },
            ],
          },
        };
      }
    } catch (error) {
      console.log("Error getting balance:", error.message);
      if (error.response?.data) {
        console.log(
          "Error response:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
    }

    // Jeśli wszystko zawiodło, zwróć pustą odpowiedź
    return {
      retCode: 0,
      result: {
        list: [
          {
            accountType: "UNIFIED",
            coin: [],
          },
        ],
      },
    };
  }

  /**
   * Otwiera pozycję futures (Market Order)
   */
  async openPosition(apiKey, apiSecret, symbol, side, quantity, positionIdx) {
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
  async closePosition(apiKey, apiSecret, symbol, side, quantity, positionIdx) {
    // Odwrotny side do zamknięcia
    const closeSide = side === "Buy" ? "Sell" : "Buy";

    return this.openPosition(
      apiKey,
      apiSecret,
      symbol,
      closeSide,
      quantity,
      positionIdx
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
