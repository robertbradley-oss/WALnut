/** One retained sample per operation; observers can collect their own bounded history. */
export function timed<T>(name: string, operation: () => T): T {
  const start = performance.now();
  try {
    return operation();
  } finally {
    performance.clearMeasures(name);
    performance.measure(name, { start, duration: performance.now() - start });
  }
}
