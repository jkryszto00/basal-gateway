"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef } from "react";

type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Cloudflare Turnstile widget. It adds a hidden `cf-turnstile-response` field to the surrounding form. A token is
 * valid once, so the widget is reset whenever `resetOn` changes (each server action result).
 */
export function Turnstile({ siteKey, action, resetOn }: { siteKey: string; action: string; resetOn?: unknown }) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);

  const render = useCallback(() => {
    if (!el.current || !window.turnstile || id.current) return;
    id.current = window.turnstile.render(el.current, { sitekey: siteKey, action, size: "flexible", theme: "auto" });
  }, [siteKey, action]);

  useEffect(() => {
    render(); // the script may already be loaded after a client-side navigation
    return () => {
      if (id.current) window.turnstile?.remove(id.current);
      id.current = null;
    };
  }, [render]);

  useEffect(() => {
    if (resetOn !== undefined && id.current) window.turnstile?.reset(id.current);
  }, [resetOn]);

  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={render} />
      <div ref={el} data-turnstile className="min-h-[65px]" />
    </>
  );
}
