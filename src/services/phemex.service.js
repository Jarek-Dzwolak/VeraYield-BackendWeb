const crypto = require("crypto");
const axios = require("axios");
const logger = require("../utils/logger");

class PhemexService {
  constructor() {
    this.baseUrl = "https://api.phemex.com";
    this.instrumentInfoCache = new Map();
    this.instrumentCacheExpiry = 3600000; // 1 hour
    this.scaleCache = new Map(); // Cache dla scale info
  }

  /**
   * Tworzy podpis dla Phemex API
   * @param {string} queryString - Query string
   * @param {string} requestBody - Ciało żądania (JSON string)
   * @param {number} expiry - Timestamp wygaśnięcia
   * @param {string} accessToken - Access token (API key)
   * @param {string} secretKey - Secret key
   * @returns {string} - Podpis HMAC
   */
  createSignature(queryString, requestBody, expiry, accessToken, secretKey) {
    const urlPath = "/g-accounts/accountPositions";
    const message = urlPath + queryString + expiry + requestBody;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(message)
      .digest("hex");

    return signature;
  }

  /**
   * Wykonuje żądanie do Phemex API
   * @param {string} method - Metoda HTTP
   * @param {string} endpoint - Endpoint API
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {Object} params - Parametry żądania
   * @returns {Promise<Object>} - Odpowiedź z API
   */
  async makeRequest(method, endpoint, apiKey, apiSecret, params = {}) {
    try {
      const expiry = Math.floor(Date.now() / 1000) + 60; // 60 sekund do wygaśnięcia
      let queryString = "";
      let requestBody = "";

      if (method === "GET" && Object.keys(params).length > 0) {
        queryString = Object.keys(params)
          .sort()
          .map((key) => `${key}=${encodeURIComponent(params[key])}`)
          .join("&");
      } else if (method === "POST" || method === "PUT") {
        requestBody =
          Object.keys(params).length > 0 ? JSON.stringify(params) : "";
      }

      const signature = this.createSignature(
        queryString,
        requestBody,
        expiry,
        apiKey,
        apiSecret
      );

      const headers = {
        "x-phemex-access-token": apiKey,
        "x-phemex-request-signature": signature,
        "x-phemex-request-expiry": expiry.toString(),
        "Content-Type": "application/json",
      };

      let config = {
        method,
        url: `${this.baseUrl}${endpoint}`,
        headers,
      };

      if (method === "GET" && queryString) {
        config.url += `?${queryString}`;
      } else if ((method === "POST" || method === "PUT") && requestBody) {
        config.data = requestBody;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      logger.error(`Phemex API error: ${error.message}`);
      if (error.response?.data) {
        logger.error(`Phemex response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Pobiera saldo konta z Phemex
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} currency - Waluta (domyślnie USDT)
   * @returns {Promise<Object>} - Dane salda
   */
  async getBalance(apiKey, apiSecret, currency = "USDT") {
    try {
      const response = await this.makeRequest(
        "GET",
        "/g-accounts/accountPositions",
        apiKey,
        apiSecret,
        { currency }
      );

      if (response.code !== 0) {
        logger.error(`[PHEMEX] API Error: ${response.msg}`);
        return {
          retCode: response.code,
          retMsg: response.msg,
          result: null,
        };
      }

      // Phemex structure: response.data.account contains balance info
      const accountData = response.data?.account;

      if (accountData) {
        // Phemex używa scaled values - obliczamy dostępne saldo
        const accountBalanceRv = parseFloat(
          accountData.accountBalanceRv || "0"
        );
        const usedBalanceRv = parseFloat(accountData.usedBalanceRv || "0");
        const availBalanceRv = accountBalanceRv - usedBalanceRv;

        logger.info(`[PHEMEX] Account Balance: ${accountBalanceRv}`);
        logger.info(`[PHEMEX] Used Balance: ${usedBalanceRv}`);
        logger.info(`[PHEMEX] Available Balance: ${availBalanceRv}`);

        // Zwracamy w formacie kompatybilnym z poprzednim kodem
        return {
          retCode: 0,
          result: {
            list: [
              {
                accountType: "CONTRACT",
                coin: [
                  {
                    coin: currency,
                    walletBalance: accountBalanceRv.toString(),
                    availableToWithdraw: availBalanceRv.toString(),
                  },
                ],
              },
            ],
          },
        };
      }

      // Fallback - zwróć pustą odpowiedź
      return {
        retCode: 0,
        result: {
          list: [
            {
              accountType: "CONTRACT",
              coin: [
                {
                  coin: currency,
                  walletBalance: "0",
                  availableToWithdraw: "0",
                },
              ],
            },
          ],
        },
      };
    } catch (error) {
      logger.error(`[PHEMEX] Error getting balance: ${error.message}`);

      return {
        retCode: -1,
        retMsg: error.message,
        result: {
          list: [
            {
              accountType: "CONTRACT",
              coin: [
                {
                  coin: currency,
                  walletBalance: "0",
                  availableToWithdraw: "0",
                },
              ],
            },
          ],
        },
      };
    }
  }

  /**
   * Otwiera pozycję na Phemex
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} symbol - Symbol instrumentu
   * @param {string} side - Strona (Buy/Sell)
   * @param {string} quantity - Wielkość pozycji
   * @param {number} positionIdx - Indeks pozycji (nie używany w Phemex)
   * @param {string} subaccountId - ID subkonta (nie używany)
   * @returns {Promise<Object>} - Odpowiedź z API
   */
  async openPosition(
    apiKey,
    apiSecret,
    symbol,
    side,
    quantity,
    positionIdx = 0,
    subaccountId = null
  ) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      // 🔍 LOG: Parametry wejściowe
      logger.info(
        `[PHEMEX ORDER] Attempting order: ${symbol} -> ${phemexSymbol}`
      );
      logger.info(`[PHEMEX ORDER] Raw quantity: ${quantity}, side: ${side}`);

      const params = {
        symbol: phemexSymbol,
        side: side,
        orderQty: parseFloat(quantity),
        ordType: "Market",
        timeInForce: "ImmediateOrCancel",
        reduceOnly: false,
      };

      // 🔍 LOG: Dokładne parametry wysyłane do API
      logger.info(
        `[PHEMEX ORDER] Sending to API:`,
        JSON.stringify(params, null, 2)
      );

      const response = await this.makeRequest(
        "POST",
        "/orders",
        apiKey,
        apiSecret,
        params
      );

      // 🔍 LOG: Pełna odpowiedź z API
      logger.info(
        `[PHEMEX ORDER] Full API response:`,
        JSON.stringify(response, null, 2)
      );

      if (response.code === 0) {
        logger.info(
          `[PHEMEX ORDER] ✅ SUCCESS - Order ID: ${response.data?.orderID}`
        );
        return {
          result: {
            orderId: response.data?.orderID,
            orderLinkId: response.data?.clOrdID,
          },
        };
      } else {
        // 🔴 LOG: Szczegółowy błąd
        logger.error(`[PHEMEX ORDER] ❌ API ERROR:`);
        logger.error(`[PHEMEX ORDER] Code: ${response.code}`);
        logger.error(`[PHEMEX ORDER] Message: ${response.msg}`);
        logger.error(
          `[PHEMEX ORDER] Full response:`,
          JSON.stringify(response, null, 2)
        );
        throw new Error(response.msg || "Order placement failed");
      }
    } catch (error) {
      // 🔴 LOG: Błąd HTTP/Network
      logger.error(`[PHEMEX ORDER] ❌ NETWORK ERROR: ${error.message}`);
      if (error.response?.data) {
        logger.error(
          `[PHEMEX ORDER] HTTP Response:`,
          JSON.stringify(error.response.data, null, 2)
        );
      }
      if (error.response?.status) {
        logger.error(`[PHEMEX ORDER] HTTP Status: ${error.response.status}`);
      }
      throw error;
    }
  }

  /**
   * Zamyka pozycję na Phemex
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} symbol - Symbol instrumentu
   * @param {string} side - Strona oryginalnej pozycji
   * @param {string} quantity - Wielkość do zamknięcia
   * @param {number} positionIdx - Indeks pozycji
   * @param {string} subaccountId - ID subkonta
   * @returns {Promise<Object>} - Odpowiedź z API
   */
  async closePosition(
    apiKey,
    apiSecret,
    symbol,
    side,
    quantity,
    positionIdx = 0,
    subaccountId = null
  ) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      // Odwróć stronę dla zamknięcia pozycji
      const closeSide = side === "Buy" ? "Sell" : "Buy";

      const params = {
        symbol: phemexSymbol,
        side: closeSide,
        orderQty: parseFloat(quantity),
        ordType: "Market",
        timeInForce: "ImmediateOrCancel",
        reduceOnly: true,
      };

      const response = await this.makeRequest(
        "POST",
        "/orders",
        apiKey,
        apiSecret,
        params
      );

      if (response.code === 0) {
        return {
          result: {
            orderId: response.data?.orderID,
            orderLinkId: response.data?.clOrdID,
          },
        };
      } else {
        throw new Error(response.msg || "Position close failed");
      }
    } catch (error) {
      logger.error(`Error closing position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ustawia dźwignię dla symbolu
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} symbol - Symbol instrumentu
   * @param {number} leverage - Wartość dźwigni
   * @returns {Promise<Object>} - Odpowiedź z API
   */
  async setLeverage(apiKey, apiSecret, symbol, leverage) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      const params = {
        symbol: phemexSymbol,
        leverage: leverage,
      };

      const response = await this.makeRequest(
        "PUT",
        "/positions/leverage",
        apiKey,
        apiSecret,
        params
      );

      return response;
    } catch (error) {
      logger.error(`Error setting leverage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ustawia tryb margin (Phemex automatycznie zarządza margin mode)
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} symbol - Symbol instrumentu
   * @param {number} tradeMode - Tryb margin (1 = isolated, 0 = cross)
   * @returns {Promise<Object>} - Odpowiedź z API
   */
  async setMarginMode(apiKey, apiSecret, symbol, tradeMode) {
    try {
      logger.info(
        `[PHEMEX] Margin mode management is automatic, skipping manual setting`
      );

      return {
        code: 0,
        msg: "Margin mode is managed automatically by Phemex",
      };
    } catch (error) {
      logger.error(`Error setting margin mode: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera aktualną cenę instrumentu
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<number>} - Aktualna cena
   */
  async getCurrentPrice(symbol) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      const response = await axios.get(`${this.baseUrl}/md/ticker/24hr`, {
        params: {
          symbol: phemexSymbol,
        },
      });

      if (response.data.code === 0 && response.data.result?.length > 0) {
        const ticker = response.data.result[0];

        // Phemex używa scaled pricing - trzeba przeskalować
        const priceScale = await this.getPriceScale(phemexSymbol);
        const lastPrice = parseFloat(ticker.lastPx) / Math.pow(10, priceScale);

        return lastPrice;
      }

      throw new Error("Unable to fetch price from Phemex");
    } catch (error) {
      logger.error(`Error fetching Phemex price: ${error.message}`);
      throw error;
    }
  }

  /**
   * Pobiera informacje o instrumencie
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<Object>} - Informacje o instrumencie
   */
  async getInstrumentInfo(symbol) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      const response = await axios.get(`${this.baseUrl}/public/products`);

      if (response.data.code === 0 && response.data.data?.products) {
        const instrument = response.data.data.products.find(
          (p) => p.symbol === phemexSymbol
        );

        if (instrument) {
          // 🔍 LOG: Raw instrument data z API
          logger.info(
            `[PHEMEX SCALE] Raw instrument data for ${phemexSymbol}:`,
            {
              symbol: instrument.symbol,
              minOrderQty: instrument.minOrderQty,
              maxOrderQty: instrument.maxOrderQty,
              lotSize: instrument.lotSize,
              qtyScale: instrument.qtyScale,
              priceScale: instrument.priceScale,
              minOrderValue: instrument.minOrderValue,
            }
          );

          const qtyScale = instrument.qtyScale || 4;
          const priceScale = instrument.priceScale || 4;

          const result = {
            symbol: instrument.symbol,
            minOrderQty:
              parseFloat(instrument.minOrderQty || "0.001") /
              Math.pow(10, qtyScale),
            maxOrderQty:
              parseFloat(instrument.maxOrderQty || "1000000") /
              Math.pow(10, qtyScale),
            qtyStep:
              parseFloat(instrument.lotSize || "0.001") /
              Math.pow(10, qtyScale),
            minOrderValue: parseFloat(instrument.minOrderValue || "10"),
            priceScale,
            qtyScale,
          };

          // 🔍 LOG: Przetworzone dane (po scale)
          logger.info(`[PHEMEX SCALE] Processed instrument data:`, {
            minOrderQty: result.minOrderQty,
            qtyStep: result.qtyStep,
            qtyScale: result.qtyScale,
            priceScale: result.priceScale,
            calculation: `Raw ${instrument.minOrderQty} / 10^${qtyScale} = ${result.minOrderQty}`,
          });

          return result;
        } else {
          // 🔴 LOG: Nie znaleziono instrumentu
          logger.error(
            `[PHEMEX SCALE] ❌ Instrument ${phemexSymbol} not found in products list`
          );
          logger.error(
            `[PHEMEX SCALE] Available symbols:`,
            response.data.data.products.slice(0, 5).map((p) => p.symbol)
          );
        }
      }

      // Fallback
      logger.warn(`[PHEMEX SCALE] ⚠️ Using fallback values for ${symbol}`);
      return {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 1000000,
        qtyStep: 0.001,
        minOrderValue: 10,
        priceScale: 4,
        qtyScale: 4,
      };
    } catch (error) {
      logger.error(
        `[PHEMEX SCALE] ❌ Error fetching instrument info: ${error.message}`
      );
      // Zwróć fallback values
      return {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 1000000,
        qtyStep: 0.001,
        minOrderValue: 10,
        priceScale: 4,
        qtyScale: 4,
      };
    }
  }
  /**
   * Pobiera informacje o instrumencie z cache
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<Object>} - Informacje o instrumencie
   */
  async getCachedInstrumentInfo(symbol) {
    const cached = this.instrumentInfoCache.get(symbol);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.instrumentCacheExpiry) {
      return cached.data;
    }

    const instrumentInfo = await this.getInstrumentInfo(symbol);

    this.instrumentInfoCache.set(symbol, {
      data: instrumentInfo,
      timestamp: now,
    });

    return instrumentInfo;
  }

  /**
   * Pobiera aktualny rozmiar pozycji
   * @param {string} apiKey - Klucz API
   * @param {string} apiSecret - Sekret API
   * @param {string} symbol - Symbol instrumentu
   * @param {string} subaccountId - ID subkonta
   * @returns {Promise<number>} - Rozmiar pozycji
   */
  async getPositionSize(apiKey, apiSecret, symbol, subaccountId = null) {
    try {
      const phemexSymbol = this.convertToPhemexSymbol(symbol);

      const response = await this.makeRequest(
        "GET",
        "/accounts/accountPositions",
        apiKey,
        apiSecret,
        { currency: "USDT" }
      );

      if (response.code === 0 && response.data?.positions) {
        const position = response.data.positions.find(
          (p) => p.symbol === phemexSymbol
        );

        if (position) {
          const qtyScale = await this.getQtyScale(phemexSymbol);
          return parseFloat(position.size || "0") / Math.pow(10, qtyScale);
        }
      }

      return 0;
    } catch (error) {
      logger.error(`Error getting position size: ${error.message}`);
      throw error;
    }
  }

  /**
   * Konwertuje symbol Binance na format Phemex
   * @param {string} symbol - Symbol w formacie Binance (np. BTCUSDT)
   * @returns {string} - Symbol w formacie Phemex
   */
  convertToPhemexSymbol(symbol) {
    // 🔍 LOG: Konwersja symbolu
    logger.info(`[PHEMEX SYMBOL] Converting: ${symbol}`);

    const symbolMap = {
      BTCUSDT: "BTCUSDT",
      ETHUSDT: "ETHUSDT",
      BNBUSDT: "BNBUSDT",
    };

    const result = symbolMap[symbol] || symbol;

    if (symbolMap[symbol]) {
      logger.info(`[PHEMEX SYMBOL] ✅ Mapped: ${symbol} -> ${result}`);
    } else {
      logger.warn(
        `[PHEMEX SYMBOL] ⚠️ No mapping found, using original: ${symbol}`
      );
    }

    return result;
  }

  /**
   * Pobiera scale dla ceny instrumentu
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<number>} - Scale dla ceny
   */
  async getPriceScale(symbol) {
    const cached = this.scaleCache.get(`${symbol}_price`);
    if (cached && Date.now() - cached.timestamp < this.instrumentCacheExpiry) {
      return cached.scale;
    }

    const instrumentInfo = await this.getInstrumentInfo(symbol);
    const scale = instrumentInfo.priceScale || 4;

    this.scaleCache.set(`${symbol}_price`, {
      scale,
      timestamp: Date.now(),
    });

    return scale;
  }

  /**
   * Pobiera scale dla quantity instrumentu
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<number>} - Scale dla quantity
   */
  async getQtyScale(symbol) {
    const cached = this.scaleCache.get(`${symbol}_qty`);
    if (cached && Date.now() - cached.timestamp < this.instrumentCacheExpiry) {
      return cached.scale;
    }

    const instrumentInfo = await this.getInstrumentInfo(symbol);
    const scale = instrumentInfo.qtyScale || 4;

    this.scaleCache.set(`${symbol}_qty`, {
      scale,
      timestamp: Date.now(),
    });

    return scale;
  }
}

module.exports = new PhemexService();
