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
   * @param {number} positionIdx - Indeks pozycji (nie używany)
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
      logger.info(`[PHEMEX ORDER] === MARKET ORDER ===`);
      logger.info(`[PHEMEX ORDER] Symbol: ${symbol} -> ${phemexSymbol}`);
      logger.info(`[PHEMEX ORDER] Side: ${side}, Quantity: ${quantity}`);

      // ✅ POPRAWNE PARAMETRY dla Phemex futures
      const params = {
        clOrdID: `order-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`, // Unikalny ID
        symbol: phemexSymbol, // BTCUSDT (bez prefiksu)
        side: side, // "Buy" lub "Sell"
        orderQtyRq: quantity, // ← orderQtyRq zamiast orderQty!
        ordType: "Market", // Market order
        timeInForce: "ImmediateOrCancel", // IOC dla market
        posSide: side === "Buy" ? "Long" : "Short", // ← Long/Short pozycja
      };

      // 🔍 LOG: Dokładne parametry do API
      logger.info(
        `[PHEMEX ORDER] Request params:`,
        JSON.stringify(params, null, 2)
      );
      logger.info(`[PHEMEX ORDER] Endpoint: POST ${this.baseUrl}/g-orders`);

      // ✅ POPRAWNY ENDPOINT: /g-orders
      const response = await this.makeRequest(
        "POST",
        "/g-orders",
        apiKey,
        apiSecret,
        params
      );

      // 🔍 LOG: Pełna odpowiedź
      logger.info(
        `[PHEMEX ORDER] Full response:`,
        JSON.stringify(response, null, 2)
      );

      if (response.code === 0) {
        logger.info(`[PHEMEX ORDER] ✅ SUCCESS - Order placed`);
        logger.info(`[PHEMEX ORDER] Order details:`, {
          orderID: response.data?.orderID,
          clOrdID: response.data?.clOrdID,
          symbol: response.data?.symbol,
          side: response.data?.side,
          orderQtyRq: response.data?.orderQtyRq,
          ordStatus: response.data?.ordStatus,
        });

        return {
          result: {
            orderId: response.data?.orderID,
            orderLinkId: response.data?.clOrdID,
          },
        };
      } else {
        // 🔴 LOG: Błąd API
        logger.error(`[PHEMEX ORDER] ❌ API ERROR:`);
        logger.error(`[PHEMEX ORDER] Code: ${response.code}`);
        logger.error(`[PHEMEX ORDER] Message: ${response.msg}`);
        logger.error(
          `[PHEMEX ORDER] Full error:`,
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
      logger.info(`[PHEMEX PRICE] === GETTING CURRENT PRICE ===`);
      logger.info(`[PHEMEX PRICE] Input symbol: ${symbol}`);

      const phemexSymbol = this.convertToPhemexSymbol(symbol);
      logger.info(`[PHEMEX PRICE] Converted symbol: ${phemexSymbol}`);

      // 🔍 LOG: Dokładny URL i parametry
      const url = `${this.baseUrl}/md/ticker/24hr`;
      const params = { symbol: phemexSymbol };

      logger.info(`[PHEMEX PRICE] Full URL: ${url}`);
      logger.info(`[PHEMEX PRICE] Params:`, JSON.stringify(params, null, 2));
      logger.info(`[PHEMEX PRICE] Base URL: ${this.baseUrl}`);

      let response;
      try {
        response = await axios.get(url, { params });

        // 🔍 LOG: Sukces HTTP
        logger.info(`[PHEMEX PRICE] HTTP Status: ${response.status}`);
        logger.info(
          `[PHEMEX PRICE] Response headers:`,
          JSON.stringify(response.headers, null, 2)
        );
      } catch (httpError) {
        // 🔴 LOG: Błąd HTTP
        logger.error(`[PHEMEX PRICE] ❌ HTTP ERROR:`);
        logger.error(`[PHEMEX PRICE] Status: ${httpError.response?.status}`);
        logger.error(
          `[PHEMEX PRICE] Status text: ${httpError.response?.statusText}`
        );
        logger.error(
          `[PHEMEX PRICE] Response data:`,
          JSON.stringify(httpError.response?.data, null, 2)
        );
        logger.error(`[PHEMEX PRICE] Request config:`, {
          url: httpError.config?.url,
          method: httpError.config?.method,
          params: httpError.config?.params,
        });
        throw httpError;
      }

      // 🔍 LOG: Response body
      logger.info(
        `[PHEMEX PRICE] Response body:`,
        JSON.stringify(response.data, null, 2)
      );

      if (response.data.code === 0 && response.data.result?.length > 0) {
        const ticker = response.data.result[0];
        logger.info(`[PHEMEX PRICE] Ticker data:`, {
          lastPx: ticker.lastPx,
          markPx: ticker.markPx,
          indexPx: ticker.indexPx,
        });

        const priceScale = await this.getPriceScale(phemexSymbol);
        logger.info(`[PHEMEX PRICE] Price scale: ${priceScale}`);

        const lastPrice = parseFloat(ticker.lastPx) / Math.pow(10, priceScale);
        logger.info(
          `[PHEMEX PRICE] ✅ Final price: ${lastPrice} (raw: ${ticker.lastPx}, scale: ${priceScale})`
        );

        return lastPrice;
      } else {
        // 🔴 LOG: Nieprawidłowa odpowiedź API
        logger.error(`[PHEMEX PRICE] ❌ Invalid API response:`);
        logger.error(`[PHEMEX PRICE] Code: ${response.data.code}`);
        logger.error(`[PHEMEX PRICE] Message: ${response.data.msg}`);
        logger.error(
          `[PHEMEX PRICE] Result length: ${response.data.result?.length || 0}`
        );

        throw new Error(
          `Phemex API error: ${response.data.msg || "Invalid response"}`
        );
      }
    } catch (error) {
      logger.error(`[PHEMEX PRICE] ❌ GENERAL ERROR: ${error.message}`);
      if (error.stack) {
        logger.error(`[PHEMEX PRICE] Stack trace: ${error.stack}`);
      }
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
      logger.info(`[PHEMEX INSTRUMENT] === GETTING INSTRUMENT INFO ===`);
      logger.info(`[PHEMEX INSTRUMENT] Input symbol: ${symbol}`);

      const phemexSymbol = this.convertToPhemexSymbol(symbol);
      logger.info(`[PHEMEX INSTRUMENT] Phemex symbol: ${phemexSymbol}`);

      const url = `${this.baseUrl}/public/products`;
      logger.info(`[PHEMEX INSTRUMENT] Request URL: ${url}`);

      let response;
      try {
        response = await axios.get(url);
        logger.info(`[PHEMEX INSTRUMENT] HTTP Status: ${response.status}`);
      } catch (httpError) {
        logger.error(`[PHEMEX INSTRUMENT] ❌ HTTP ERROR: ${httpError.message}`);
        logger.error(
          `[PHEMEX INSTRUMENT] Status: ${httpError.response?.status}`
        );
        logger.error(
          `[PHEMEX INSTRUMENT] Response:`,
          JSON.stringify(httpError.response?.data, null, 2)
        );
        throw httpError;
      }

      logger.info(`[PHEMEX INSTRUMENT] Response code: ${response.data.code}`);

      if (response.data.code === 0 && response.data.data?.products) {
        const products = response.data.data.products;
        logger.info(
          `[PHEMEX INSTRUMENT] Total products found: ${products.length}`
        );

        const instrument = products.find((p) => p.symbol === phemexSymbol);
        logger.info(`[PHEMEX INSTRUMENT] Instrument found: ${!!instrument}`);

        if (instrument) {
          // 🔍 LOG: Raw instrument data z API
          logger.info(`[PHEMEX INSTRUMENT] Raw instrument data:`, {
            symbol: instrument.symbol,
            minOrderQty: instrument.minOrderQty,
            maxOrderQty: instrument.maxOrderQty,
            lotSize: instrument.lotSize,
            qtyScale: instrument.qtyScale,
            priceScale: instrument.priceScale,
            minOrderValue: instrument.minOrderValue,
          });

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
          logger.info(`[PHEMEX INSTRUMENT] ✅ Processed result:`, {
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
            `[PHEMEX INSTRUMENT] ❌ Instrument ${phemexSymbol} not found`
          );
          logger.info(
            `[PHEMEX INSTRUMENT] Available symbols (first 10):`,
            products.slice(0, 10).map((p) => p.symbol)
          );
        }
      } else {
        logger.error(`[PHEMEX INSTRUMENT] ❌ Invalid API response`);
        logger.error(`[PHEMEX INSTRUMENT] Code: ${response.data.code}`);
        logger.error(`[PHEMEX INSTRUMENT] Message: ${response.data.msg}`);
      }

      // Fallback
      logger.warn(`[PHEMEX INSTRUMENT] ⚠️ Using fallback values for ${symbol}`);
      const fallback = {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 1000000,
        qtyStep: 0.001,
        minOrderValue: 10,
        priceScale: 4,
        qtyScale: 4,
      };
      logger.info(`[PHEMEX INSTRUMENT] Fallback values:`, fallback);
      return fallback;
    } catch (error) {
      logger.error(`[PHEMEX INSTRUMENT] ❌ GENERAL ERROR: ${error.message}`);
      const fallback = {
        symbol: symbol,
        minOrderQty: 0.001,
        maxOrderQty: 1000000,
        qtyStep: 0.001,
        minOrderValue: 10,
        priceScale: 4,
        qtyScale: 4,
      };
      logger.info(`[PHEMEX INSTRUMENT] Error fallback values:`, fallback);
      return fallback;
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
    logger.info(`[PHEMEX SYMBOL] Converting: ${symbol}`);

    // ✅ FUTURES - bez prefiksu 's', z USDT
    const symbolMap = {
      BTCUSDT: "BTCUSDT", // ← Zostaw jak jest dla futures
      ETHUSDT: "ETHUSDT",
      BNBUSDT: "BNBUSDT",
    };

    const result = symbolMap[symbol] || symbol;

    logger.info(`[PHEMEX SYMBOL] ✅ Futures symbol: ${symbol} -> ${result}`);
    return result;
  }
  /**
   * Pobiera scale dla ceny instrumentu
   * @param {string} symbol - Symbol instrumentu
   * @returns {Promise<number>} - Scale dla ceny
   */
  async getPriceScale(symbol) {
    try {
      logger.info(`[PHEMEX SCALE] === GETTING PRICE SCALE ===`);
      logger.info(`[PHEMEX SCALE] Symbol: ${symbol}`);

      const cached = this.scaleCache.get(`${symbol}_price`);
      if (
        cached &&
        Date.now() - cached.timestamp < this.instrumentCacheExpiry
      ) {
        logger.info(
          `[PHEMEX SCALE] ✅ Using cached price scale: ${cached.scale}`
        );
        logger.info(
          `[PHEMEX SCALE] Cache timestamp: ${new Date(cached.timestamp).toISOString()}`
        );
        return cached.scale;
      }

      logger.info(
        `[PHEMEX SCALE] Cache miss, fetching fresh instrument info...`
      );
      logger.info(
        `[PHEMEX SCALE] Cache expiry time: ${this.instrumentCacheExpiry}ms`
      );

      let instrumentInfo;
      try {
        instrumentInfo = await this.getInstrumentInfo(symbol);
        logger.info(`[PHEMEX SCALE] Instrument info received:`, {
          symbol: instrumentInfo.symbol,
          priceScale: instrumentInfo.priceScale,
          qtyScale: instrumentInfo.qtyScale,
          minOrderQty: instrumentInfo.minOrderQty,
        });
      } catch (instrumentError) {
        logger.error(
          `[PHEMEX SCALE] ❌ Error getting instrument info: ${instrumentError.message}`
        );
        logger.info(`[PHEMEX SCALE] Using fallback price scale: 4`);
        return 4;
      }

      const scale = instrumentInfo.priceScale || 4;
      logger.info(
        `[PHEMEX SCALE] ✅ Price scale result: ${scale} (fallback: ${!instrumentInfo.priceScale})`
      );

      // Cache the result
      this.scaleCache.set(`${symbol}_price`, {
        scale,
        timestamp: Date.now(),
      });

      logger.info(`[PHEMEX SCALE] Cached price scale for future use`);
      return scale;
    } catch (error) {
      logger.error(`[PHEMEX SCALE] ❌ GENERAL ERROR: ${error.message}`);
      logger.error(`[PHEMEX SCALE] Using fallback price scale: 4`);
      return 4;
    }
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
