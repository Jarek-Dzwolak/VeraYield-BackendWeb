/**
 * Model instancji strategii
 * Przechowuje konfigurację instancji bota tradingowego
 */

const mongoose = require("mongoose");
const { Schema } = mongoose;

const InstanceSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },

  active: {
    type: Boolean,
    default: true,
  },

  symbol: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },

  // Klucze API dla tej instancji
  apiKeys: {
    apiKey: {
      type: String,
      required: true,
    },
    apiSecret: {
      type: String,
      required: true,
    },
  },

  // Konfiguracja kanału Hursta
  hurstConfig: {
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
      ],
      default: "15m",
    },
    periods: {
      type: Number,
      default: 25,
      min: 10,
      max: 100,
    },
    // Dodatkowe parametry specyficzne dla kanału Hursta
    multiplier: {
      type: Number,
      default: 2.0,
    },
  },

  // Konfiguracja linii trendu / EMA
  trendConfig: {
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
      ],
      default: "1h",
    },
    emaPeriods: {
      type: Number,
      default: 30,
      min: 5,
      max: 200,
    },
    historicalPeriods: {
      type: Number,
      default: 100,
      min: 20,
      max: 500,
    },
  },

  // Sygnały handlowe
  signalConfig: {
    enableHurstSignals: {
      type: Boolean,
      default: true,
    },
    enableTrendSignals: {
      type: Boolean,
      default: true,
    },
    minimumConfirmationTime: {
      type: Number,
      default: 0, // W milisekundach, 0 oznacza natychmiastowe potwierdzenie
    },
  },

  // Statystyki i metryki
  stats: {
    totalSignals: {
      type: Number,
      default: 0,
    },
    successfulSignals: {
      type: Number,
      default: 0,
    },
    lastSignalTime: {
      type: Date,
    },
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },

  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Pre-save hook do aktualizacji pola updatedAt
InstanceSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Metoda do sprawdzenia czy instancja ma aktywne połączenie WebSocket
InstanceSchema.methods.hasActiveWebSocket = function () {
  // Implementacja w serwisie
  return true;
};

// Metoda do uzyskania identyfikatora używanego w innych modelach
InstanceSchema.methods.getInstanceId = function () {
  return this._id;
};

const Instance = mongoose.model("Instance", InstanceSchema);

module.exports = Instance;
