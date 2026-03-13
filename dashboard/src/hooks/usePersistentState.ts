import { Dispatch, SetStateAction, useEffect, useMemo, useState } from "react";

import { readStoredValue, writeStoredValue } from "../lib/safe";

type PersistentOptions<T> = {
  deserialize?: (raw: string) => T;
  serialize?: (value: T) => string;
};

export function usePersistentState<T>(
  key: string,
  fallback: T,
  options: PersistentOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const deserialize = useMemo(
    () => options.deserialize ?? ((raw: string) => raw as T),
    [options.deserialize],
  );
  const serialize = useMemo(
    () => options.serialize ?? ((value: T) => String(value)),
    [options.serialize],
  );

  const [value, setValue] = useState<T>(() => {
    const stored = readStoredValue(key, "");
    if (!stored) {
      return fallback;
    }
    try {
      return deserialize(stored);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      writeStoredValue(key, serialize(value));
    } catch {
      // Ignore serialization failures and keep the in-memory state stable.
    }
  }, [key, serialize, value]);

  return [value, setValue];
}
