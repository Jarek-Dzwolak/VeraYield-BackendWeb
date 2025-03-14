/**
 * User Model - model użytkownika
 *
 * Przechowuje informacje o użytkownikach systemu, w tym:
 * - Dane logowania (e-mail, hasło)
 * - Informacje osobowe
 * - Uprawnienia
 * - Preferencje
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
    // Generuj salt
    const salt = await bcrypt.genSalt(10);
    // Hashuj hasło
    const hash = await bcrypt.hash(user.password, salt);
    // Zastąp hasło hashem
    user.password = hash;
    next();
  } catch (error) {
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
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
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
  return this.findOne({ email: email.toLowerCase() });
};

// Eksportuj model
const User = mongoose.model("User", UserSchema);
module.exports = User;
