import { useEffect, useState } from "react";

interface HealthResponse {
  status: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

type State =
  | { kind: "loading" }
  | { kind: "ok"; data: HealthResponse }
  | { kind: "error"; message: string };

export default function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/healthz`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthResponse;
      })
      .then((data) => {
        if (!cancelled) setState({ kind: "ok", data });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <header>
        <h1>Termina</h1>
        <p className="tagline">Self-hosted Kalender, Phase 0.</p>
      </header>

      <section className="status">
        <h2>Backend-Verbindung</h2>
        {state.kind === "loading" && <p>Pruefe Backend unter {API_BASE} ...</p>}
        {state.kind === "ok" && (
          <p className="ok">
            OK - Backend antwortet mit Status <code>{state.data.status}</code>.
          </p>
        )}
        {state.kind === "error" && (
          <p className="error">
            Verbindung fehlgeschlagen: {state.message}
            <br />
            <small>
              Erwartet wird <code>{API_BASE}/healthz</code>. Laeuft der Backend-Container?
            </small>
          </p>
        )}
      </section>
    </main>
  );
}
