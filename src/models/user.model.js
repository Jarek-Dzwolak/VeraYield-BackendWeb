/**
 * User Model - model użytkownika
 *
 * Przechowuje informacje o użytkownikach systemu, w tym:
 * - Dane logowania (e-mail, hasło)
 * - Informacje osobowe
 * - Uprawnienia
 * - Preferencje
 * - Dane finansowe i historię transakcji
 */

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  // Adres e-mail (unikatowy identyfikator)
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      "Nieprawidłowy format adresu e-mail",
    ],
  },

  // Hasło (przechowywane jako hash)
  password: {
    type: String,
    required: true,
  },

  // Imię i nazwisko
  firstName: {
    type: String,
    trim: true,
  },
  lastName: {
    type: String,
    trim: true,
  },

  // Rola użytkownika (admin, manager, user)
  role: {
    type: String,
    enum: ["admin", "manager", "user"],
    default: "user",
  },

  // Status konta
  status: {
    type: String,
    enum: ["active", "inactive", "suspended"],
    default: "active",
  },

  // Token resetowania hasła
  resetPasswordToken: {
    type: String,
  },

  // Data ważności tokenu resetowania hasła
  resetPasswordExpires: {
    type: Date,
  },

  // Ostatnie logowanie
  lastLogin: {
    type: Date,
  },

  // Klucze API Binance (opcjonalnie, dla przyszłej implementacji handlu)
  binanceApiKeys: {
    apiKey: {
      type: String,
      default: "",
    },
    secretKey: {
      type: String,
      default: "",
    },
    // Czy klucze są aktywne
    isActive: {
      type: Boolean,
      default: false,
    },
  },

  // Przypisane instancje strategii (relacja wiele-do-wielu)
  instances: [
    {
      type: String, // instanceId
      ref: "Instance",
    },
  ],

  // Dane finansowe użytkownika
  financials: {
    // Dostępny bilans (niezaalokowany do żadnej instancji)
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Całkowity zysk ze wszystkich transakcji
    totalProfit: {
      type: Number,
      default: 0,
    },
    // Liczba wszystkich transakcji
    totalTrades: {
      type: Number,
      default: 0,
    },
    // Liczba zyskownych transakcji
    successfulTrades: {
      type: Number,
      default: 0,
    },
    // Data ostatniej transakcji
    lastTradeDate: {
      type: Date,
    },
    // Historia transakcji
    tradeHistory: [
      {
        instanceId: {
          type: String,
          required: true,
        },
        symbol: {
          type: String,
          required: true,
        },
        entryTime: {
          type: Date,
          required: true,
        },
        exitTime: {
          type: Date,
          required: true,
        },
        entryPrice: {
          type: Number,
          required: true,
        },
        exitPrice: {
          type: Number,
          required: true,
        },
        amount: {
          type: Number,
          required: true,
        },
        profit: {
          type: Number,
          required: true,
        },
        profitPercent: {
          type: Number,
          required: true,
        },
        signalIds: [
          {
            type: String,
          },
        ],
      },
    ],
  },

  // Preferencje użytkownika
  preferences: {
    // Motyw interfejsu (ciemny, jasny)
    theme: {
      type: String,
      enum: ["light", "dark"],
      default: "light",
    },
    // Język interfejsu
    language: {
      type: String,
      enum: ["pl", "en"],
      default: "pl",
    },
    // Powiadomienia
    notifications: {
      email: {
        enabled: {
          type: Boolean,
          default: true,
        },
        signalAlerts: {
          type: Boolean,
          default: true,
        },
        systemAlerts: {
          type: Boolean,
          default: true,
        },
      },
    },
  },

  // Data utworzenia konta
  createdAt: {
    type: Date,
    default: Date.now,
  },

  // Data ostatniej aktualizacji
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Middleware - przed zapisem
 * Aktualizuje datę modyfikacji i hashuje hasło, jeśli zostało zmienione
 */
UserSchema.pre("save", async function (next) {
  const user = this;

  // Aktualizuj datę modyfikacji
  user.updatedAt = new Date();

  // Hashuj hasło tylko jeśli zostało zmienione (lub jest nowe)
  if (!user.isModified("password")) {
    return next();
  }

  try {
    console.log("Generowanie nowego hashu dla hasła...");
    // Generuj salt
    const salt = await bcrypt.genSalt(10);
    console.log("Salt wygenerowany");
    // Hashuj hasło
    const hash = await bcrypt.hash(user.password, salt);
    console.log("Hasło zostało zahashowane");
    // Zastąp hasło hashem
    user.password = hash;
    next();
  } catch (error) {
    console.error("Błąd podczas hashowania hasła:", error);
    next(error);
  }
});

/**
 * Metoda - porównanie hasła
 * Porównuje podane hasło z zapisanym hashem
 * @param {string} candidatePassword - Hasło do porównania
 * @returns {Promise<boolean>} - Czy hasła są zgodne
 */
UserSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    console.log("Porównywanie hasła...");
    console.log(
      "Kandydat na hasło (fragment):",
      candidatePassword ? "***" : "null"
    );
    console.log(
      "Hash hasła w bazie (fragment):",
      this.password ? this.password.substring(0, 15) + "..." : "null"
    );

    const result = await bcrypt.compare(candidatePassword, this.password);
    console.log("Wynik porównania:", result);
    return result;
  } catch (error) {
    console.error("Błąd podczas porównywania haseł:", error);
    throw error;
  }
};

/**
 * Metoda - przygotowanie profilu użytkownika (bez danych wrażliwych)
 * @returns {Object} - Profil użytkownika bez poufnych danych
 */
UserSchema.methods.getProfile = function () {
  const user = this.toObject();

  // Usuń wrażliwe dane
  delete user.password;
  delete user.resetPasswordToken;
  delete user.resetPasswordExpires;

  // Ukryj klucz API
  if (user.binanceApiKeys) {
    if (user.binanceApiKeys.apiKey) {
      user.binanceApiKeys.apiKey =
        user.binanceApiKeys.apiKey.substring(0, 4) +
        "..." +
        user.binanceApiKeys.apiKey.substring(
          user.binanceApiKeys.apiKey.length - 4
        );
    }
    delete user.binanceApiKeys.secretKey;
  }

  return user;
};

/**
 * Statyczna metoda - znajdowanie użytkownika według adresu e-mail
 * @param {string} email - Adres e-mail
 * @returns {Promise<Object>} - Znaleziony użytkownik lub null
 */
UserSchema.statics.findByEmail = async function (email) {
  console.log("Szukam użytkownika z emailem:", email);
  const result = await this.findOne({ email: email.toLowerCase() });
  console.log("Znaleziono użytkownika:", result ? "Tak" : "Nie");
  return result;
};

/**
 * Metoda - dodawanie środków do konta użytkownika
 * @param {number} amount - Kwota do dodania
 * @returns {Promise<void>}
 */
UserSchema.methods.addFunds = async function (amount) {
  if (!this.financials) {
    this.financials = {
      balance: 0,
      totalProfit: 0,
      totalTrades: 0,
      successfulTrades: 0,
      tradeHistory: [],
    };
  }

  this.financials.balance += amount;
  await this.save();
};

/**
 * Metoda - dodawanie transakcji do historii
 * @param {Object} tradeData - Dane transakcji
 * @returns {Promise<void>}
 */
UserSchema.methods.addTradeToHistory = async function (tradeData) {
  if (!this.financials) {
    this.financials = {
      balance: 0,
      totalProfit: 0,
      totalTrades: 0,
      successfulTrades: 0,
      tradeHistory: [],
    };
  }

  this.financials.tradeHistory.push(tradeData);
  this.financials.totalTrades += 1;

  if (tradeData.profit > 0) {
    this.financials.successfulTrades += 1;
  }

  this.financials.totalProfit += tradeData.profit;
  this.financials.lastTradeDate = new Date();

  await this.save();
};

// Eksportuj model
const User = mongoose.model("User", UserSchema);
module.exports = User;
