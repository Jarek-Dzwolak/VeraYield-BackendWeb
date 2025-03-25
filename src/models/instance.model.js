/**
 * Model instancji strategii
 * Przechowuje konfigurację instancji bota tradingowego
 */

const mongoose = require("mongoose");
const { Schema } = mongoose;

const InstanceSchema = new Schema({
  instanceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
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

  // Klucze API dla tej instancji - dodane optional: true dla trybu testowego
  apiKeys: {
    apiKey: {
      type: String,
      // ZMIANA: Usunięto required: true
    },
    apiSecret: {
      type: String,
      // ZMIANA: Usunięto required: true
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

  // Finansowe dane instancji
  financials: {
    // Przydzielony kapitał dla instancji
    allocatedCapital: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Aktualny saldo instancji (dostępne + zablokowane w pozycjach)
    currentBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Dostępne saldo (nie wykorzystane w pozycjach)
    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Zablokowane saldo (aktualnie w pozycjach)
    lockedBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Całkowity zysk instancji
    totalProfit: {
      type: Number,
      default: 0,
    },
    // Referencja do właściciela
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // ZMIANA: Usunięto required: true
    },
    // Aktywne pozycje
    openPositions: [
      {
        signalId: {
          type: String,
          required: true,
        },
        amount: {
          type: Number,
          required: true,
        },
        lockedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Historia zamkniętych pozycji
    closedPositions: [
      {
        entrySignalId: {
          type: String,
          required: true,
        },
        exitSignalId: {
          type: String,
          required: true,
        },
        entryAmount: {
          type: Number,
          required: true,
        },
        exitAmount: {
          type: Number,
          required: true,
        },
        profit: {
          type: Number,
          required: true,
        },
        closedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
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

  // DODANO: Flaga trybu testowego
  testMode: {
    type: Boolean,
    default: false,
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
  return this.instanceId || this._id.toString();
};

/**
 * Metoda - aktualizacja bilansu instancji
 * @param {Object} balanceUpdate - Dane do aktualizacji bilansu
 * @returns {Promise<void>}
 */
InstanceSchema.methods.updateBalance = async function (balanceUpdate) {
  if (!this.financials) {
    this.financials = {
      allocatedCapital: 0,
      currentBalance: 0,
      availableBalance: 0,
      lockedBalance: 0,
      totalProfit: 0,
      openPositions: [],
      closedPositions: [],
    };
  }

  if (balanceUpdate.allocatedCapital) {
    this.financials.allocatedCapital += balanceUpdate.allocatedCapital;
    this.financials.currentBalance += balanceUpdate.allocatedCapital;
    this.financials.availableBalance += balanceUpdate.allocatedCapital;
  }

  if (balanceUpdate.lockAmount) {
    this.financials.availableBalance -= balanceUpdate.lockAmount;
    this.financials.lockedBalance += balanceUpdate.lockAmount;
  }

  if (balanceUpdate.unlockAmount) {
    this.financials.lockedBalance -= balanceUpdate.unlockAmount;
  }

  if (balanceUpdate.addAmount) {
    this.financials.availableBalance += balanceUpdate.addAmount;
    this.financials.currentBalance =
      this.financials.availableBalance + this.financials.lockedBalance;
  }

  if (balanceUpdate.profit) {
    this.financials.totalProfit += balanceUpdate.profit;
  }

  await this.save();
};

const Instance = mongoose.model("Instance", InstanceSchema);

module.exports = Instance;
