const config = {
  hurst: {
    periods: 30,
    upperDeviationFactor: 1.6,
    lowerDeviationFactor: 1.8,
    minExponent: 0.55,
  },

  ema: {
    periods: 30,
  },

  signals: {
    minEntryTimeGap: 2 * 60 * 60 * 1000, // 2 godziny
    checkEMATrend: true,
    minFirstEntryDuration: 60 * 60 * 1000, // 1 godzina
    stopLoss: {
      enabled: true,
      percent: 0.015, // 1.5%
    },
  },

  capitalAllocation: {
    firstEntry: 0.1, // 10% kapitału
    secondEntry: 0.25, // 25% kapitału
    thirdEntry: 0.5, // 50% kapitału
    maxEntries: 3,
  },

  limits: {
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
    ema: {
      periods: {
        min: 5,
        max: 200,
      },
    },
    minEntryTimeGap: {
      min: 5 * 60 * 1000, // 5 minut
      max: 24 * 60 * 60 * 1000, // 24 godziny
    },
    minFirstEntryDuration: {
      min: 0, // 0 minut (wyłączone)
      max: 24 * 60 * 60 * 1000, // 24 godziny
    },
    stopLoss: {
      percent: {
        min: 0.005, // 0.5%
        max: 0.05, // 5%
      },
    },
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

  intervals: {
    hurst: "15m",
    ema: "1h",
  },
};

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

  // Walidacja stop loss
  if (params.signals?.stopLoss) {
    if (params.signals.stopLoss.percent !== undefined) {
      const { min, max } = config.limits.stopLoss.percent;
      if (
        params.signals.stopLoss.percent < min ||
        params.signals.stopLoss.percent > max
      ) {
        errors.push(
          `Procent stop loss musi być z zakresu ${(min * 100).toFixed(1)}%-${(max * 100).toFixed(1)}%`
        );
      }
    }
  }

  // Walidacja minimalnego czasu trwania pierwszego wejścia
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
