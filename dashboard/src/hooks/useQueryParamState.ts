import { Dispatch, SetStateAction, useEffect, useState } from "react";

import { safeTrim } from "../lib/safe";

function readQueryParam(key: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const url = new URL(window.location.href);
    return safeTrim(url.searchParams.get(key)) || fallback;
  } catch {
    return fallback;
  }
}

export function useQueryParamState(key: string, fallback: string): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(() => readQueryParam(key, fallback));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const url = new URL(window.location.href);
      const next = safeTrim(value);
      if (next) {
        url.searchParams.set(key, next);
      } else {
        url.searchParams.delete(key);
      }
      window.history.replaceState({}, "", url.toString());
    } catch {
      // Ignore invalid history environments.
    }
  }, [key, value]);

  return [value, setValue];
}
