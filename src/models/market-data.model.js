/**
 * Market Data Model - model danych rynkowych
 *
 * Przechowuje dane rynkowe, w tym:
 * - Symbol waluty
 * - Typ danych (świece, ticki)
 * - Interwał czasowy (dla świec)
 * - Znacznik czasu
 * - Dane (cena, objętość, itp.)
 */

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const MarketDataSchema = new Schema({
  // Identyfikator instancji (opcjonalnie)
  instanceId: {
    type: String,
    index: true,
  },

  // Symbol waluty (np. BTCUSDT)
  symbol: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    index: true,
  },

  // Typ danych ('candle', 'ticker')
  type: {
    type: String,
    enum: ["candle", "ticker"],
    required: true,
  },

  // Interwał czasowy (tylko dla świec)
  interval: {
    type: String,
    enum: [
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
    ],
    index: true,
  },

  // Znacznik czasu
  timestamp: {
    type: Number,
    required: true,
    index: true,
  },

  // Czas otwarcia (tylko dla świec)
  openTime: {
    type: Number,
  },

  // Czas zamknięcia (tylko dla świec)
  closeTime: {
    type: Number,
  },

  // Cena otwarcia (tylko dla świec)
  open: {
    type: Number,
  },

  // Najwyższa cena (tylko dla świec)
  high: {
    type: Number,
  },

  // Najniższa cena (tylko dla świec)
  low: {
    type: Number,
  },

  // Cena zamknięcia (tylko dla świec) lub aktualna cena (dla tickerów)
  close: {
    type: Number,
    required: true,
  },

  // Objętość
  volume: {
    type: Number,
  },

  // Czy świeca jest zamknięta (tylko dla świec)
  isFinal: {
    type: Boolean,
  },

  // Liczba transakcji (tylko dla świec)
  numberOfTrades: {
    type: Number,
  },

  // Dodatkowe dane
  data: {
    type: Object,
    default: {},
  },

  // Data utworzenia rekordu
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400 * 30, // 30 dni TTL
  },
});

// Indeks złożony dla szybkiego wyszukiwania świec
MarketDataSchema.index({ symbol: 1, type: 1, interval: 1, timestamp: -1 });

// Eksportuj model
const MarketData = mongoose.model("MarketData", MarketDataSchema);
module.exports = MarketData;
