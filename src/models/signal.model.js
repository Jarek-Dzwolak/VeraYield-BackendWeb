/**
 * Signal Model - model sygnału handlowego
 *
 * Przechowuje informacje o sygnałach handlowych, w tym:
 * - Identyfikator instancji
 * - Symbol waluty
 * - Typ sygnału (wejście, wyjście)
 * - Podtyp sygnału (pierwsze wejście, drugie wejście, itp.)
 * - Cenę
 * - Alokację kapitału
 * - Procent zysku
 * - Znacznik czasu
 * - Metadane
 */

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SignalSchema = new Schema({
  // Identyfikator instancji, która wygenerowała sygnał
  instanceId: {
    type: String,
    required: true,
    index: true,
  },

  // Symbol waluty (np. BTCUSDT)
  symbol: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },

  // Typ sygnału (wejście, wyjście)
  type: {
    type: String,
    enum: ["entry", "exit"],
    required: true,
  },

  // Podtyp sygnału
  // Dla entry: 'first', 'second', 'third'
  // Dla exit: 'upperBandCrossDown', 'trailingStop', etc.
  subType: {
    type: String,
    required: true,
  },

  // Cena w momencie sygnału
  price: {
    type: Number,
    required: true,
  },

  // Alokacja kapitału (0-1) - tylko dla sygnałów wejścia
  allocation: {
    type: Number,
    min: 0,
    max: 1,
  },

  // Procent zysku - tylko dla sygnałów wyjścia
  profitPercent: {
    type: Number,
  },

  // Znacznik czasu sygnału
  timestamp: {
    type: Number,
    required: true,
    index: true,
  },

  // Metadane sygnału (dane wskaźników, parametry, itp.)
  metadata: {
    type: Object,
    default: {},
  },

  // Data utworzenia rekordu
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Eksportuj model
const Signal = mongoose.model("Signal", SignalSchema);
module.exports = Signal;
