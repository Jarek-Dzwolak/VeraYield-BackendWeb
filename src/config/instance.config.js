/**
 * Instance Configuration - konfiguracja instancji strategii
 *
 * Odpowiedzialny za:
 * - Przechowywanie domyślnych parametrów strategii
 * - Konfigurację limitów alokacji kapitału
 * - Konfigurację parametrów sygnałów
 */

const config = {
  // Domyślne parametry strategii Hursta
  hurst: {
    // Liczba okresów do analizy
    periods: 25,
    // Współczynnik odchylenia standardowego dla band
    deviationFactor: 2.0,
    // Minimalna wartość wykładnika Hursta do uznania trendu
    minExponent: 0.55,
  },

  // Domyślne parametry EMA
  ema: {
    // Liczba okresów EMA
    periods: 30,
  },

  // Domyślna konfiguracja sygnałów
  signals: {
    // Minimalny odstęp czasowy pomiędzy wejściami (ms)
    minEntryTimeGap: 2 * 60 * 60 * 1000, // 2 godziny
    // Czy sprawdzać trend EMA przed wejściem
    checkEMATrend: true,
    // Wartość trailing stop (procent od maksimum)
    trailingStop: 0.02, // 2%
  },

  // Domyślna alokacja kapitału
  capitalAllocation: {
    // Pierwsze wejście
    firstEntry: 0.1, // 10% kapitału
    // Drugie wejście
    secondEntry: 0.25, // 25% kapitału
    // Trzecie wejście
    thirdEntry: 0.5, // 50% kapitału
    // Maksymalna liczba wejść
    maxEntries: 3,
  },

  // Limity parametrów
  limits: {
    // Limity dla parametrów kanału Hursta
    hurst: {
      periods: {
        min: 10,
        max: 100,
      },
      deviationFactor: {
        min: 0.5,
        max: 5.0,
      },
    },
    // Limity dla parametrów EMA
    ema: {
      periods: {
        min: 5,
        max: 200,
      },
    },
  },

  // Domyślne interwały używane w strategii
  intervals: {
    // Interwał dla kanału Hursta
    hurst: "15m",
    // Interwał dla EMA
    ema: "1h",
  },
};

/**
 * Waliduje parametry instancji
 * @param {Object} params - Parametry do walidacji
 * @returns {Object} - Wynik walidacji z ewentualnymi błędami
 */
const validateInstanceParams = (params) => {
  const errors = [];

  // Walidacja parametrów Hursta
  if (params.hurst) {
    if (params.hurst.periods !== undefined) {
      const { min, max } = config.limits.hurst.periods;
      if (params.hurst.periods < min || params.hurst.periods > max) {
        errors.push(
          `Liczba okresów dla kanału Hursta musi być z zakresu ${min}-${max}`
        );
      }
    }

    if (params.hurst.deviationFactor !== undefined) {
      const { min, max } = config.limits.hurst.deviationFactor;
      if (
        params.hurst.deviationFactor < min ||
        params.hurst.deviationFactor > max
      ) {
        errors.push(
          `Współczynnik odchylenia dla kanału Hursta musi być z zakresu ${min}-${max}`
        );
      }
    }
  }

  // Walidacja parametrów EMA
  if (params.ema) {
    if (params.ema.periods !== undefined) {
      const { min, max } = config.limits.ema.periods;
      if (params.ema.periods < min || params.ema.periods > max) {
        errors.push(`Liczba okresów dla EMA musi być z zakresu ${min}-${max}`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

/**
 * Zwraca domyślne parametry instancji
 * @returns {Object} - Domyślne parametry
 */
const getDefaultInstanceParams = () => {
  return {
    hurst: { ...config.hurst },
    ema: { ...config.ema },
    signals: { ...config.signals },
    capitalAllocation: { ...config.capitalAllocation },
    intervals: { ...config.intervals },
  };
};

module.exports = {
  config,
  validateInstanceParams,
  getDefaultInstanceParams,
};
