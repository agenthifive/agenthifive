"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

const docsBaseUrl = process.env.NEXT_PUBLIC_DOCS_URL || "/docs";

interface HelpTooltipProps {
  /** Short help text shown in the popover */
  children: ReactNode;
  /** Path appended to NEXT_PUBLIC_DOCS_URL (e.g. "/getting-started/quickstart") */
  docsPath?: string | undefined;
  /** Link label (default: "Read the docs") */
  docsLabel?: string | undefined;
}

export function HelpTooltip({ children, docsPath, docsLabel = "Read the docs" }: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="ml-1 inline-flex items-center justify-center rounded-full text-muted hover:text-foreground focus:outline-none"
        aria-label="Help"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M12 16v0m0-4c0-2 1.5-2.5 2-3 .5-.5.5-1.5 0-2s-1.5-1-2.5-.5c-.7.3-1 1-1 1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-lg border border-border bg-card p-3 shadow-lg">
          <div className="text-xs text-muted leading-relaxed">
            {children}
          </div>
          {docsPath && (
            <a
              href={`${docsBaseUrl}${docsPath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
            >
              {docsLabel}
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
