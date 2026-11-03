import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CircleAlert, RotateCcw } from "lucide-react";
import { api } from "./api";
import { Shell } from "./Shell";
import { DonationsPage } from "./pages/Donations";
import { DonorsPage } from "./pages/Donors";
import { Login } from "./pages/Login";
import { OverviewPage } from "./pages/Overview";
import { SystemPage } from "./pages/System";
import type { SessionInfo } from "./types";
import { Mark, ToastProvider } from "./ui";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onUnauthorized = () => {
      setSession(null);
      setError(null);
      setAttempt((value) => value + 1);
    };
    window.addEventListener("d2m:unauthorized", onUnauthorized);
    return () => window.removeEventListener("d2m:unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<SessionInfo>("/admin/api/session")
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not reach the Worker.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  let content: ReactNode;
  if (error) {
    content = (
      <BootError
        message={error}
        onRetry={() => {
          setError(null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  } else if (!session) {
    content = <Splash />;
  } else if (!session.authenticated || !session.admin) {
    content = <Login session={session} />;
  } else {
    content = (
      <BrowserRouter basename="/admin">
        <Routes>
          <Route element={<Shell admin={session.admin} />}>
            <Route index element={<OverviewPage />} />
            <Route path="donations" element={<DonationsPage />} />
            <Route path="donors" element={<DonorsPage />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    );
  }

  return <ToastProvider>{content}</ToastProvider>;
}

function Splash() {
  return (
    <div className="boot">
      <div className="boot-mark">
        <Mark size={46} />
        <span className="boot-ring" aria-hidden="true" />
      </div>
      <p>Opening control room</p>
    </div>
  );
}

function BootError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="boot">
      <div className="boot-error">
        <span className="boot-error-icon">
          <CircleAlert size={20} />
        </span>
        <h1>Could not open the console</h1>
        <p>{message}</p>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <RotateCcw size={15} /> Try again
        </button>
      </div>
    </div>
  );
}
