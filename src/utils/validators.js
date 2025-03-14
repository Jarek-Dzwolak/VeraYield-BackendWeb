/**
 * Validators - funkcje do walidacji danych
 *
 * Zawiera funkcje do weryfikacji poprawności:
 * - Danych wejściowych
 * - Parametrów konfiguracyjnych
 * - Parametrów strategii
 */

const logger = require("./logger");

/**
 * Sprawdza, czy symbol waluty jest poprawny
 * @param {string} symbol - Symbol waluty do sprawdzenia
 * @returns {boolean} - Czy symbol jest poprawny
 */
const isValidSymbol = (symbol) => {
  if (!symbol || typeof symbol !== "string") {
    return false;
  }

  // Podstawowa walidacja symbolu (np. BTCUSDT)
  const regex = /^[A-Z0-9]{2,10}[A-Z]{2,5}$/;
  return regex.test(symbol);
};

/**
 * Sprawdza, czy interwał jest obsługiwany
 * @param {string} interval - Interwał do sprawdzenia
 * @returns {boolean} - Czy interwał jest obsługiwany
 */
const isValidInterval = (interval) => {
  const validIntervals = [
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
  ];
  return validIntervals.includes(interval);
};

/**
 * Waliduje konfigurację instancji strategii
 * @param {Object} config - Konfiguracja do sprawdzenia
 * @returns {Object} - Obiekt zawierający informacje o walidacji
 */
const validateInstanceConfig = (config) => {
  const errors = [];

  // Sprawdź, czy konfiguracja istnieje
  if (!config || typeof config !== "object") {
    return {
      isValid: false,
      errors: ["Konfiguracja musi być obiektem"],
    };
  }

  // Walidacja symbolu
  if (!config.symbol) {
    errors.push("Symbol jest wymagany");
  } else if (!isValidSymbol(config.symbol)) {
    errors.push("Symbol jest niepoprawny");
  }

  // Walidacja parametrów strategii Hursta
  if (
    config.strategy &&
    config.strategy.parameters &&
    config.strategy.parameters.hurst
  ) {
    const hurstParams = config.strategy.parameters.hurst;

    // Walidacja liczby okresów
    if (hurstParams.periods !== undefined) {
      if (
        typeof hurstParams.periods !== "number" ||
        hurstParams.periods < 10 ||
        hurstParams.periods > 100
      ) {
        errors.push(
          "Liczba okresów dla kanału Hursta musi być liczbą z zakresu 10-100"
        );
      }
    }

    // Walidacja współczynnika odchylenia
    if (hurstParams.deviationFactor !== undefined) {
      if (
        typeof hurstParams.deviationFactor !== "number" ||
        hurstParams.deviationFactor < 0.5 ||
        hurstParams.deviationFactor > 5
      ) {
        errors.push(
          "Współczynnik odchylenia dla kanału Hursta musi być liczbą z zakresu 0.5-5"
        );
      }
    }
  }

  // Walidacja parametrów EMA
  if (
    config.strategy &&
    config.strategy.parameters &&
    config.strategy.parameters.ema
  ) {
    const emaParams = config.strategy.parameters.ema;

    // Walidacja liczby okresów
    if (emaParams.periods !== undefined) {
      if (
        typeof emaParams.periods !== "number" ||
        emaParams.periods < 5 ||
        emaParams.periods > 200
      ) {
        errors.push("Liczba okresów dla EMA musi być liczbą z zakresu 5-200");
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

/**
 * Waliduje parametry żądania HTTP
 * @param {Object} req - Obiekt żądania
 * @param {Array} requiredParams - Tablica wymaganych parametrów
 * @returns {Object} - Obiekt zawierający informacje o walidacji
 */
const validateRequestParams = (req, requiredParams = []) => {
  const errors = [];
  const missingParams = [];

  // Sprawdź wymagane parametry
  for (const param of requiredParams) {
    if (req.body && req.body[param] === undefined) {
      missingParams.push(param);
    }
  }

  if (missingParams.length > 0) {
    errors.push(`Brakujące wymagane parametry: ${missingParams.join(", ")}`);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

/**
 * Waliduje parametr ID instancji
 * @param {string} instanceId - ID instancji do sprawdzenia
 * @returns {Object} - Obiekt zawierający informacje o walidacji
 */
const validateInstanceId = (instanceId) => {
  const errors = [];

  if (!instanceId) {
    errors.push("ID instancji jest wymagane");
  } else if (typeof instanceId !== "string") {
    errors.push("ID instancji musi być ciągiem znaków");
  } else if (instanceId.length < 6) {
    errors.push("ID instancji musi mieć co najmniej 6 znaków");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

/**
 * Waliduje parametry filtrowania sygnałów
 * @param {Object} filters - Filtry do sprawdzenia
 * @returns {Object} - Obiekt zawierający informacje o walidacji
 */
const validateSignalFilters = (filters) => {
  const errors = [];
  const validatedFilters = {};

  // Walidacja typu sygnału
  if (filters.type) {
    if (!["entry", "exit", "all"].includes(filters.type)) {
      errors.push("Typ sygnału musi być jednym z: entry, exit, all");
    } else {
      if (filters.type === "all") {
        // Nie dodawaj filtra typu, jeśli wybrano 'all'
      } else {
        validatedFilters.type = filters.type;
      }
    }
  }

  // Walidacja symbolu
  if (filters.symbol) {
    if (!isValidSymbol(filters.symbol)) {
      errors.push("Symbol jest niepoprawny");
    } else {
      validatedFilters.symbol = filters.symbol.toUpperCase();
    }
  }

  // Walidacja zakresu dat
  if (filters.startDate || filters.endDate) {
    if (filters.startDate) {
      const startTimestamp = new Date(filters.startDate).getTime();
      if (isNaN(startTimestamp)) {
        errors.push("Data początkowa jest niepoprawna");
      } else {
        validatedFilters.timestamp = validatedFilters.timestamp || {};
        validatedFilters.timestamp.$gte = startTimestamp;
      }
    }

    if (filters.endDate) {
      const endTimestamp = new Date(filters.endDate).getTime();
      if (isNaN(endTimestamp)) {
        errors.push("Data końcowa jest niepoprawna");
      } else {
        validatedFilters.timestamp = validatedFilters.timestamp || {};
        validatedFilters.timestamp.$lte = endTimestamp;
      }
    }
  }

  // Walidacja ID instancji
  if (filters.instanceId) {
    const instanceIdValidation = validateInstanceId(filters.instanceId);
    if (!instanceIdValidation.isValid) {
      errors.push(...instanceIdValidation.errors);
    } else {
      validatedFilters.instanceId = filters.instanceId;
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    validatedFilters,
  };
};

/**
 * Sprawdza poprawność adresu e-mail
 * @param {string} email - Adres e-mail do sprawdzenia
 * @returns {boolean} - Czy adres e-mail jest poprawny
 */
const isValidEmail = (email) => {
  if (!email || typeof email !== "string") {
    return false;
  }

  // Podstawowa walidacja adresu e-mail
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return regex.test(email);
};

/**
 * Sprawdza siłę hasła
 * @param {string} password - Hasło do sprawdzenia
 * @returns {Object} - Obiekt zawierający informacje o sile hasła
 */
const checkPasswordStrength = (password) => {
  if (!password) {
    return {
      isStrong: false,
      score: 0,
      feedback: "Hasło jest wymagane",
    };
  }

  let score = 0;
  const feedback = [];

  // Długość hasła
  if (password.length < 8) {
    feedback.push("Hasło powinno mieć co najmniej 8 znaków");
  } else {
    score += 1;
  }

  // Duże litery
  if (!/[A-Z]/.test(password)) {
    feedback.push("Hasło powinno zawierać co najmniej jedną dużą literę");
  } else {
    score += 1;
  }

  // Małe litery
  if (!/[a-z]/.test(password)) {
    feedback.push("Hasło powinno zawierać co najmniej jedną małą literę");
  } else {
    score += 1;
  }

  // Cyfry
  if (!/[0-9]/.test(password)) {
    feedback.push("Hasło powinno zawierać co najmniej jedną cyfrę");
  } else {
    score += 1;
  }

  // Znaki specjalne
  if (!/[^A-Za-z0-9]/.test(password)) {
    feedback.push("Hasło powinno zawierać co najmniej jeden znak specjalny");
  } else {
    score += 1;
  }

  // Dla maksymalnej wartości wyników
  const maxScore = 5;

  return {
    isStrong: score >= 4,
    score,
    maxScore,
    feedback: feedback.length > 0 ? feedback.join(". ") : "Hasło jest silne",
  };
};

// Eksportuj funkcje
module.exports = {
  isValidSymbol,
  isValidInterval,
  validateInstanceConfig,
  validateRequestParams,
  validateInstanceId,
  validateSignalFilters,
  isValidEmail,
  checkPasswordStrength,
};
