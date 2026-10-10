"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";
import { inputClass } from "./ui";

const request = (apiUrl: string, model: string | null) => `curl ${apiUrl}/v1/systemone \\
  -H "Authorization: Bearer $BASAL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{${model ? `"model": "${model}",\n       ` : ""}"state": "Order #1042 arrived damaged, I want my money back.",
       "questions": {"intent": {"type": "choice", "instructions": "What does the customer want?",
         "criteria": {"refund": "Refund", "replace": "Replacement", "info": "Information"}}}}'`;

/** The example request, for the model picked here (the default model needs no "model" field). */
export function QuickStart({
  apiUrl,
  models,
  defaultModel,
}: {
  apiUrl: string;
  models: string[];
  defaultModel?: string;
}) {
  const [model, setModel] = useState(defaultModel ?? models[0] ?? "");
  const curl = request(apiUrl, model && model !== defaultModel ? model : null);
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2">
        {models.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputClass} w-auto py-1`}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === defaultModel ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto">
          <CopyButton text={curl} />
        </div>
      </div>
      <pre className="overflow-x-auto rounded-md bg-bg p-4 font-mono text-xs leading-relaxed">{curl}</pre>
    </div>
  );
}
