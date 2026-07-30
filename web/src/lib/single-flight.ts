export type SingleFlightState<T> = {
  current: Promise<T> | null;
};

export function createSingleFlightState<T>(): SingleFlightState<T> {
  return { current: null };
}

export function runSingleFlight<T>(state: SingleFlightState<T>, operation: () => Promise<T>): Promise<T> {
  if (state.current) {
    return state.current;
  }

  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error: unknown) {
    return Promise.reject(error);
  }

  const active = operationPromise.then(
    (value) => {
      if (state.current === active) {
        state.current = null;
      }
      return value;
    },
    (error: unknown) => {
      if (state.current === active) {
        state.current = null;
      }
      throw error;
    },
  );
  state.current = active;
  return active;
}
