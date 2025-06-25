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
  symbol: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },
  active: {
    type: Boolean,
    default: true,
  },
  // Ujednolicona struktura strategii
  strategy: {
    type: {
      type: String,
      enum: ["hurst", "macd", "rsi", "custom"],
      default: "hurst",
    },
    parameters: {
      // Parametry kanału Hursta
      hurst: {
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
        upperDeviationFactor: {
          type: Number,
          default: 2.0,
        },
        lowerDeviationFactor: {
          type: Number,
          default: 2.0,
        },
      },
      // Parametry EMA
      ema: {
        interval: {
          type: String,
          enum: ["15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"],
          default: "1h",
        },
        periods: {
          type: Number,
          default: 30,
          min: 5,
          max: 200,
        },
      },
      // Konfiguracja sygnałów
      signals: {
        checkEMATrend: {
          type: Boolean,
          default: true,
        },
        minEntryTimeGap: {
          type: Number,
          default: 7200000, // 2h w milisekundach
        },
        enableTrailingStop: {
          type: Boolean,
          default: true,
        },
        trailingStop: {
          type: Number,
          default: 0.02, // 2%
        },
        trailingStopDelay: {
          type: Number,
          default: 300000, // 5 minut w milisekundach
        },
        minFirstEntryDuration: {
          type: Number,
          default: 3600000, // 1 godzina w milisekundach
        },
      },
      // Alokacja kapitału
      capitalAllocation: {
        firstEntry: {
          type: Number,
          default: 0.1,
          min: 0.01,
          max: 0.5,
        },
        secondEntry: {
          type: Number,
          default: 0.25,
          min: 0.01,
          max: 0.7,
        },
        thirdEntry: {
          type: Number,
          default: 0.5,
          min: 0.01,
          max: 0.9,
        },
      },
    },
  },

  // Dane finansowe
  financials: {
    allocatedCapital: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockedBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalProfit: {
      type: Number,
      default: 0,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Struktura openPositions - przechowuje aktywne pozycje
    openPositions: [
      {
        positionId: {
          type: String,
          required: true,
        },
        entrySignals: [
          {
            signalId: String,
            amount: Number,
            timestamp: Date,
            subType: String, // "first", "second", "third"
          },
        ],
        totalAmount: {
          type: Number,
          default: 0,
        },
        firstEntryTime: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Struktura closedPositions - przechowuje zamknięte pozycje
    closedPositions: [
      {
        positionId: {
          type: String,
          required: true,
        },
        entrySignals: [
          {
            signalId: String,
            amount: Number,
            timestamp: Date,
            subType: String,
          },
        ],
        exitSignalId: {
          type: String,
          required: true,
        },
        totalEntryAmount: {
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
  // Statystyki
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
  testMode: {
    type: Boolean,
    default: false,
  },

  phemexConfig: {
    apiKey: {
      type: String,
      default: "",
    },
    apiSecret: {
      type: String,
      default: "",
    },
    subaccountId: {
      type: String,
      default: "",
    },
    leverage: {
      type: Number,
      default: 3,
    },
    marginMode: {
      type: String,
      enum: ["isolated", "cross"],
      default: "isolated",
    },
  },
  // ❌ DEPRECATED - zachowane dla kompatybilności z istniejącymi danymi
  bybitConfig: {
    apiKey: {
      type: String,
      default: "",
    },
    apiSecret: {
      type: String,
      default: "",
    },
    subaccountId: {
      type: String,
      default: "",
    },
    leverage: {
      type: Number,
      default: 3,
    },
    marginMode: {
      type: String,
      enum: ["isolated", "cross"],
      default: "isolated",
    },
  },
});

// Metoda do uzyskania identyfikatora
InstanceSchema.methods.getInstanceId = function () {
  return this.instanceId;
};

// Pre-save hook do generowania instanceId i aktualizacji updatedAt
InstanceSchema.pre("save", function (next) {
  if (!this.instanceId) {
    this.instanceId = this._id.toString();
  }
  this.updatedAt = Date.now();
  next();
});

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
