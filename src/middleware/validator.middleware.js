/**
 * Validator Middleware - middleware do walidacji danych
 *
 * Odpowiedzialny za:
 * - Walidację danych wejściowych
 * - Zapewnienie poprawności danych przed przetworzeniem
 * - Obsługę błędów walidacji
 */

const {
  validateInstanceConfig,
  validateRequestParams,
  isValidSymbol,
} = require("../utils/validators");
const logger = require("../utils/logger");

/**
 * Waliduje dane do utworzenia instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const validateInstanceCreation = (req, res, next) => {
  try {
    // Sprawdź wymagane parametry
    const requiredParams = ["symbol", "name"];
    const paramsValidation = validateRequestParams(req, requiredParams);

    if (!paramsValidation.isValid) {
      return res.status(400).json({
        error: "Validation Error",
        message: paramsValidation.errors.join(", "),
      });
    }

    // Waliduj symbol
    if (!isValidSymbol(req.body.symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Symbol jest niepoprawny",
      });
    }

    // Waliduj konfigurację instancji
    const configValidation = validateInstanceConfig({
      symbol: req.body.symbol,
      strategy: req.body.strategy,
    });

    if (!configValidation.isValid) {
      return res.status(400).json({
        error: "Validation Error",
        message: configValidation.errors.join(", "),
      });
    }

    next();
  } catch (error) {
    logger.error(`Błąd walidacji instancji: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during validation",
    });
  }
};

/**
 * Waliduje dane do aktualizacji instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const validateInstanceUpdate = (req, res, next) => {
  try {
    // Waliduj symbol, jeśli jest podany
    if (req.body.symbol && !isValidSymbol(req.body.symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Symbol jest niepoprawny",
      });
    }

    // Waliduj konfigurację instancji, jeśli jest podana
    if (req.body.strategy) {
      const configValidation = validateInstanceConfig({
        symbol: req.body.symbol,
        strategy: req.body.strategy,
      });

      if (!configValidation.isValid) {
        return res.status(400).json({
          error: "Validation Error",
          message: configValidation.errors.join(", "),
        });
      }
    }

    next();
  } catch (error) {
    logger.error(`Błąd walidacji aktualizacji instancji: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during validation",
    });
  }
};

/**
 * Waliduje dane do aktualizacji konfiguracji instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const validateInstanceConfigUpdate = (req, res, next) => {
  try {
    // Waliduj konfigurację strategii
    const configValidation = validateInstanceConfig({
      strategy: {
        parameters: req.body,
      },
    });

    if (!configValidation.isValid) {
      return res.status(400).json({
        error: "Validation Error",
        message: configValidation.errors.join(", "),
      });
    }

    next();
  } catch (error) {
    logger.error(`Błąd walidacji konfiguracji instancji: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during validation",
    });
  }
};

/**
 * Waliduje parametry filtrowania sygnałów
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const validateSignalFilters = (req, res, next) => {
  try {
    // Waliduj symbol, jeśli jest podany
    if (req.query.symbol && !isValidSymbol(req.query.symbol)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Symbol jest niepoprawny",
      });
    }

    // Waliduj daty, jeśli są podane
    if (req.query.startDate) {
      const startDate = new Date(req.query.startDate);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({
          error: "Validation Error",
          message: "Data początkowa jest niepoprawna",
        });
      }
    }

    if (req.query.endDate) {
      const endDate = new Date(req.query.endDate);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({
          error: "Validation Error",
          message: "Data końcowa jest niepoprawna",
        });
      }
    }

    // Waliduj typ sygnału, jeśli jest podany
    if (req.query.type && !["entry", "exit", "all"].includes(req.query.type)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Typ sygnału musi być jednym z: entry, exit, all",
      });
    }

    next();
  } catch (error) {
    logger.error(`Błąd walidacji filtrów sygnałów: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during validation",
    });
  }
};

/**
 * Waliduje dane użytkownika
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 * @param {Function} next - Funkcja do przejścia do następnego middleware'a
 */
const validateUserData = (req, res, next) => {
  try {
    const { email, password } = req.body;
    const errors = [];

    // Sprawdź email
    if (!email) {
      errors.push("Email jest wymagany");
    } else {
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(email)) {
        errors.push("Email jest niepoprawny");
      }
    }

    // Sprawdź hasło przy rejestracji lub zmianie hasła
    if (req.path.includes("register") || req.path.includes("password")) {
      if (!password) {
        errors.push("Hasło jest wymagane");
      } else if (password.length < 8) {
        errors.push("Hasło musi mieć co najmniej 8 znaków");
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: "Validation Error",
        message: errors.join(", "),
      });
    }

    next();
  } catch (error) {
    logger.error(`Błąd walidacji danych użytkownika: ${error.message}`);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred during validation",
    });
  }
};

module.exports = {
  validateInstanceCreation,
  validateInstanceUpdate,
  validateInstanceConfigUpdate,
  validateSignalFilters,
  validateUserData,
};
