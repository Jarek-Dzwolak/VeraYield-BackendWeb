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
    periods: 30,
    // Współczynnik odchylenia standardowego dla górnej bandy
    upperDeviationFactor: 1.6,
    // Współczynnik odchylenia standardowego dla dolnej bandy
    lowerDeviationFactor: 1.8,
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
    // Czy włączyć trailing stop
    enableTrailingStop: true,
    // Opóźnienie aktywacji trailing stopu po przekroczeniu górnej bandy (ms)
    trailingStopDelay: 5 * 60 * 1000, // 5 minut
    // Minimalny czas trwania pierwszego wejścia (ms)
    // Używane do uniknięcia fałszywych sygnałów w krótkim czasie
    minFirstEntryDuration: 60 * 60 * 1000, // 1 godzina - minimalny czas trwania pierwszego wejścia
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
      upperDeviationFactor: {
        min: 0.5,
        max: 5.0,
      },
      lowerDeviationFactor: {
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
    // Limity dla minimalnego odstępu czasowego między wejściami
    minEntryTimeGap: {
      min: 5 * 60 * 1000, // 5 minut
      max: 24 * 60 * 60 * 1000, // 24 godziny
    },
    // Limity dla minimalnego czasu trwania pierwszego wejścia
    minFirstEntryDuration: {
      min: 0, // 0 minut (wyłączone)
      max: 24 * 60 * 60 * 1000, // 24 godziny
    },
    // Limity alokacji kapitału
    capitalAllocation: {
      firstEntry: {
        min: 0.01, // 1%
        max: 0.5, // 50%
      },
      secondEntry: {
        min: 0.01, // 1%
        max: 0.7, // 70%
      },
      thirdEntry: {
        min: 0.01, // 1%
        max: 0.9, // 90%
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

    if (params.hurst.upperDeviationFactor !== undefined) {
      const { min, max } = config.limits.hurst.upperDeviationFactor;
      if (
        params.hurst.upperDeviationFactor < min ||
        params.hurst.upperDeviationFactor > max
      ) {
        errors.push(
          `Współczynnik odchylenia górnej bandy Hursta musi być z zakresu ${min}-${max}`
        );
      }
    }

    if (params.hurst.lowerDeviationFactor !== undefined) {
      const { min, max } = config.limits.hurst.lowerDeviationFactor;
      if (
        params.hurst.lowerDeviationFactor < min ||
        params.hurst.lowerDeviationFactor > max
      ) {
        errors.push(
          `Współczynnik odchylenia dolnej bandy Hursta musi być z zakresu ${min}-${max}`
        );
      }
    }
    // Walidacja trailing stopu
    if (params.signals?.trailingStop !== undefined) {
      if (
        params.signals.trailingStop < 0.005 ||
        params.signals.trailingStop > 0.1
      ) {
        errors.push("Wartość trailing stopu musi być w zakresie 0.5%-10%");
      }
    }

    if (params.signals?.trailingStopDelay !== undefined) {
      if (
        params.signals.trailingStopDelay < 0 ||
        params.signals.trailingStopDelay > 3600000
      ) {
        errors.push("Opóźnienie trailing stopu musi być w zakresie 0-60 minut");
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

  // Walidacja minnimalnego czsu trwania pierwszego wejścia
  if (params.signals?.minFirstEntryDuration !== undefined) {
    if (
      params.signals.minFirstEntryDuration < 0 ||
      params.signals.minFirstEntryDuration > 24 * 60 * 60 * 1000
    ) {
      errors.push(
        "Minimalny czas trwania pierwszego wejścia musi być w zakresie 0-24 godzin"
      );
    }
  }
  // Walidacja minimalnego odstępu czasowego
  if (params.signals && params.signals.minEntryTimeGap !== undefined) {
    const { min, max } = config.limits.minEntryTimeGap;
    if (
      params.signals.minEntryTimeGap < min ||
      params.signals.minEntryTimeGap > max
    ) {
      errors.push(
        `Minimalny odstęp czasowy musi być z zakresu ${min / (60 * 1000)}-${max / (60 * 1000)} minut`
      );
    }
  }

  // Walidacja alokacji kapitału
  if (params.capitalAllocation) {
    if (params.capitalAllocation.firstEntry !== undefined) {
      const { min, max } = config.limits.capitalAllocation.firstEntry;
      if (
        params.capitalAllocation.firstEntry < min ||
        params.capitalAllocation.firstEntry > max
      ) {
        errors.push(
          `Alokacja dla pierwszego wejścia musi być z zakresu ${min * 100}%-${max * 100}%`
        );
      }
    }

    if (params.capitalAllocation.secondEntry !== undefined) {
      const { min, max } = config.limits.capitalAllocation.secondEntry;
      if (
        params.capitalAllocation.secondEntry < min ||
        params.capitalAllocation.secondEntry > max
      ) {
        errors.push(
          `Alokacja dla drugiego wejścia musi być z zakresu ${min * 100}%-${max * 100}%`
        );
      }
    }

    if (params.capitalAllocation.thirdEntry !== undefined) {
      const { min, max } = config.limits.capitalAllocation.thirdEntry;
      if (
        params.capitalAllocation.thirdEntry < min ||
        params.capitalAllocation.thirdEntry > max
      ) {
        errors.push(
          `Alokacja dla trzeciego wejścia musi być z zakresu ${min * 100}%-${max * 100}%`
        );
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
