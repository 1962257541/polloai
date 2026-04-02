"use client";

import { useDeferredValue, useState } from "react";

interface SearchableMultiSelectProps {
  label: string;
  options: string[];
  value: string[];
  onChange: (nextValue: string[]) => void;
  emptyText?: string;
}

export default function SearchableMultiSelect({
  label,
  options,
  value,
  onChange,
  emptyText = "没有匹配的模型",
}: SearchableMultiSelectProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const filteredOptions = options.filter((option) =>
    deferredQuery ? option.toLowerCase().includes(deferredQuery) : true,
  );
  const missingSelected = value.filter((item) => !options.includes(item));

  const toggleValue = (item: string) => {
    if (value.includes(item)) {
      onChange(value.filter((current) => current !== item));
      return;
    }

    onChange([...value, item]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <label
          style={{
            display: "block",
            fontSize: "0.7rem",
            fontFamily: "inherit",
            color: "var(--text-muted)",
            letterSpacing: "0.05em",
          }}
        >
          {label}
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>已选 {value.length} 项</span>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: "4px 10px", fontSize: "0.72rem" }}
            onClick={() => onChange(options)}
          >
            全选
          </button>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: "4px 10px", fontSize: "0.72rem" }}
            onClick={() => onChange([])}
          >
            清空
          </button>
        </div>
      </div>

      <input
        className="input-field"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索模型..."
      />

      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {value.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => toggleValue(item)}
              style={{
                border: "1px solid var(--border-focus)",
                background: "var(--accent-glow)",
                color: "var(--accent)",
                borderRadius: 9999,
                padding: "4px 10px",
                fontSize: "0.72rem",
                cursor: "pointer",
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-raised)",
          maxHeight: 220,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {missingSelected.map((item) => (
          <label
            key={`missing-${item}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(245,158,11,0.08)",
              color: "var(--accent)",
            }}
          >
            <input type="checkbox" checked onChange={() => toggleValue(item)} />
            <span style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{item}（未在当前目录中）</span>
          </label>
        ))}

        {filteredOptions.length === 0 ? (
          <div
            style={{
              padding: "16px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "0.8rem",
            }}
          >
            {emptyText}
          </div>
        ) : (
          filteredOptions.map((option) => {
            const checked = value.includes(option);
            return (
              <label
                key={option}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: checked ? "var(--accent-glow)" : "transparent",
                  color: checked ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleValue(option)} />
                <span style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{option}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
