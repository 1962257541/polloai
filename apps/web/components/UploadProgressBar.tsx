"use client";

interface UploadProgressBarProps {
  currentFileIndex: number;
  totalFiles: number;
  currentFileName: string;
  percent: number;
}

export default function UploadProgressBar({
  currentFileIndex,
  totalFiles,
  currentFileName,
  percent,
}: UploadProgressBarProps) {
  const label =
    totalFiles > 1
      ? `上传中 (${currentFileIndex + 1}/${totalFiles}): ${currentFileName}`
      : `上传中: ${currentFileName}`;

  return (
    <div
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: "0.78rem",
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            marginRight: 8,
          }}
          title={currentFileName}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {percent}%
        </span>
      </div>

      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg-overlay)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            borderRadius: 3,
            background: "var(--accent)",
            width: `${percent}%`,
            transition: "width 0.15s ease",
          }}
        />
      </div>
    </div>
  );
}
