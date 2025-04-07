/**
 * Signal Model - model sygnału handlowego
 *
 * Przechowuje informacje o sygnałach handlowych, w tym:
 * - Identyfikator instancji
 * - Symbol waluty
 * - Typ sygnału (wejście, wyjście)
 * - Podtyp sygnału (pierwsze wejście, drugie wejście, itp.)
 * - Cenę
 * - Alokację kapitału i rzeczywistą kwotę
 * - Procent zysku i kwotę zysku
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

  // Rzeczywista kwota alokacji - tylko dla sygnałów wejścia
  amount: {
    type: Number,
    min: 0,
  },

  // Procent zysku - tylko dla sygnałów wyjścia
  profitPercent: {
    type: Number,
  },

  // Rzeczywista kwota zysku - tylko dla sygnałów wyjścia
  profit: {
    type: Number,
  },

  // Kwota po zamknięciu pozycji - tylko dla sygnałów wyjścia
  exitAmount: {
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

  // Status sygnału (pending, executed, canceled)
  status: {
    type: String,
    enum: ["pending", "executed", "canceled"],
    default: "pending",
  },

  // Data wykonania sygnału (tylko dla status === "executed")
  executedAt: {
    type: Date,
  },

  // Dla sygnałów wyjścia - referencja do sygnału wejścia
  entrySignalId: {
    type: String,
    index: true,
  },
  entrySignalId: {
    type: String,
    index: true,
  },

  // ID pozycji handlowej (łączy wiele sygnałów wejścia z jednym wyjścia)
  positionId: {
    type: String,
    index: true,
  },

  // Dla sygnałów wyjścia - tablica referencji do wszystkich sygnałów wejścia
  entrySignalIds: [
    {
      type: String,
    },
  ],
  // Data utworzenia rekordu
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Indeks złożony dla szybszego wyszukiwania sygnałów
SignalSchema.index({ instanceId: 1, type: 1, timestamp: -1 });

/**
 * Metoda - obliczanie wartości końcowej dla sygnału wyjścia
 * @param {number} entryAmount - Kwota wejścia
 * @returns {number} - Kwota wyjścia z uwzględnieniem zysku/straty
 */
SignalSchema.methods.calculateExitAmount = function (entryAmount) {
  if (this.type !== "exit" || !this.profitPercent) {
    return null;
  }

  return entryAmount * (1 + this.profitPercent / 100);
};

/**
 * Metoda - zmiana statusu sygnału na wykonany
 * @returns {Promise<void>}
 */
SignalSchema.methods.markAsExecuted = async function () {
  this.status = "executed";
  this.executedAt = new Date();
  await this.save();
};

/**
 * Metoda - zmiana statusu sygnału na anulowany
 * @param {string} reason - Powód anulowania
 * @returns {Promise<void>}
 */
SignalSchema.methods.markAsCanceled = async function (reason) {
  this.status = "canceled";
  this.metadata.cancelReason = reason;
  await this.save();
};

// Eksportuj model
const Signal = mongoose.model("Signal", SignalSchema);
module.exports = Signal;
