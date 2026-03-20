"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import MaterialLibraryModal, { MaterialLibraryMode } from "./MaterialLibraryModal";
import { api } from "../lib/api";
import { getToken } from "../lib/auth";

const DURATION_OPTIONS = [
  { value: 4, label: "4s" },
  { value: 6, label: "6s" },
  { value: 8, label: "8s" },
];

const SIZE_OPTIONS = [
  { value: "1280x720", label: "16:9", aspectRatio: "16:9" as const },
  { value: "720x1280", label: "9:16", aspectRatio: "9:16" as const },
];

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PLACEHOLDER_URL_PATTERN = /^https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:\/|$)/i;

type AspectRatioValue = "16:9" | "9:16";
type GeneratorTab = "single" | "batch";

type BatchVideoRow = {
  line: number;
  prompt: string;
  imageName?: string;
  imageUrl?: string;
  model?: string;
  aspectRatio: AspectRatioValue;
  durationSec: number;
};

interface VideoGeneratorProps {
  onCreated: () => void;
  generating?: boolean;
}

function sizeToAspectRatio(size: string) {
  return SIZE_OPTIONS.find((item) => item.value === size)?.aspectRatio || "16:9";
}

function aspectRatioToSize(aspectRatio: AspectRatioValue) {
  return aspectRatio === "9:16" ? "720x1280" : "1280x720";
}

function normalizeImageKey(value: string) {
  return value.trim().replace(/^.*[\\/]/, "").toLowerCase();
}

function isAcceptedImageFile(file: File) {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

function downloadBatchTemplate() {
  const workbook = XLSX.utils.book_new();
  const templateRows = [
    {
      prompt: "让角色轻轻转头并微笑",
      imageName: "avatar-01.png",
      imageUrl: "",
      model: "",
      aspectRatio: "16:9",
      durationSec: 4,
    },
    {
      prompt: "人物向前走一步，衣摆轻微摆动",
      imageName: "avatar-02.jpg",
      imageUrl: "",
      model: "",
      aspectRatio: "9:16",
      durationSec: 6,
    },
  ];
  const notesRows = [
    { field: "prompt", description: "必填，视频提示词。" },
    { field: "imageName", description: "推荐填写素材文件名，然后在素材库中勾选同名图片。" },
    { field: "imageUrl", description: "可选，仅用于可直接访问的公网图片直链。" },
    { field: "model", description: "可选，留空时使用当前页面的默认模型。" },
    { field: "aspectRatio", description: "可选，仅支持 16:9 或 9:16，默认 16:9。" },
    { field: "durationSec", description: "可选，仅支持 4 / 6 / 8，默认 4。" },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(templateRows), "template");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(notesRows), "notes");

  const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "video-batch-template.xlsx";
  link.click();
  URL.revokeObjectURL(url);
}

function parseBatchRows(rows: Array<Record<string, unknown>>) {
  const errors: string[] = [];
  const parsedRows: BatchVideoRow[] = [];

  rows.forEach((row, index) => {
    const line = index + 2;
    const prompt = String(row.prompt ?? "").trim();
    const imageName = String(row.imageName ?? row.imageFile ?? "").trim();
    const imageUrl = String(row.imageUrl ?? "").trim();
    const model = String(row.model ?? "").trim() || undefined;
    const aspectRatio = (String(row.aspectRatio ?? "").trim() || "16:9") as AspectRatioValue;
    const rawDuration = String(row.durationSec ?? "").trim();
    const durationSec = rawDuration ? Number(rawDuration) : 4;

    if (!prompt && !imageName && !imageUrl && !model && !rawDuration) return;
    if (!prompt) errors.push(`第 ${line} 行缺少 prompt`);
    if (!imageName && !imageUrl) errors.push(`第 ${line} 行缺少 imageName 或 imageUrl`);
    if (PLACEHOLDER_URL_PATTERN.test(imageUrl)) {
      errors.push(`第 ${line} 行的 imageUrl 还是模板占位地址，请替换成真实图片地址`);
    }
    if (!["16:9", "9:16"].includes(aspectRatio)) {
      errors.push(`第 ${line} 行的 aspectRatio 仅支持 16:9 或 9:16`);
    }
    if (![4, 6, 8].includes(durationSec)) {
      errors.push(`第 ${line} 行的 durationSec 仅支持 4 / 6 / 8`);
    }

    if (
      !prompt ||
      (!imageName && !imageUrl) ||
      PLACEHOLDER_URL_PATTERN.test(imageUrl) ||
      !["16:9", "9:16"].includes(aspectRatio) ||
      ![4, 6, 8].includes(durationSec)
    ) {
      return;
    }

    parsedRows.push({
      line,
      prompt,
      imageName: imageName || undefined,
      imageUrl: imageUrl || undefined,
      model,
      aspectRatio,
      durationSec,
    });
  });

  if (errors.length > 0) throw new Error(errors.slice(0, 5).join("；"));
  if (parsedRows.length === 0) throw new Error("Excel 中没有可导入的数据。");
  return parsedRows;
}

export default function VideoGenerator({ onCreated, generating = false }: VideoGeneratorProps) {
  const [activeTab, setActiveTab] = useState<GeneratorTab>("single");
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [size, setSize] = useState("1280x720");
  const [duration, setDuration] = useState(4);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [batchRows, setBatchRows] = useState<BatchVideoRow[]>([]);
  const [batchFileName, setBatchFileName] = useState("");
  const [batchSelectedKeys, setBatchSelectedKeys] = useState<string[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchResult, setBatchResult] = useState("");
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryMode, setLibraryMode] = useState<MaterialLibraryMode>("single");
  const [libraryFiles, setLibraryFiles] = useState<File[]>([]);
  const [librarySelection, setLibrarySelection] = useState<string[]>([]);
  const [libraryMessage, setLibraryMessage] = useState("");

  const canSubmit = Boolean(imageUrl.trim() || file);

  const libraryFileMap = useMemo(() => {
    const map = new Map<string, File>();
    for (const materialFile of libraryFiles) {
      map.set(normalizeImageKey(materialFile.name), materialFile);
    }
    return map;
  }, [libraryFiles]);

  const batchImageFiles = useMemo(
    () =>
      batchSelectedKeys
        .map((key) => libraryFileMap.get(key))
        .filter((materialFile): materialFile is File => Boolean(materialFile)),
    [batchSelectedKeys, libraryFileMap],
  );

  const batchImageMap = useMemo(() => {
    const map = new Map<string, File>();
    for (const imageFile of batchImageFiles) {
      map.set(normalizeImageKey(imageFile.name), imageFile);
    }
    return map;
  }, [batchImageFiles]);

  const batchMatchedCount = useMemo(
    () =>
      batchRows.filter((row) => {
        if (!row.imageName) return Boolean(row.imageUrl);
        return batchImageMap.has(normalizeImageKey(row.imageName));
      }).length,
    [batchImageMap, batchRows],
  );

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let active = true;
    void (async () => {
      try {
        setConfigLoading(true);
        const info = await api.getMyInfo(token);
        if (!active) return;
        const models = info.videoModels || (info.videoModel ? [info.videoModel] : []);
        setAvailableModels(models);
        setSelectedModel((current) => (current && models.includes(current) ? current : models[0] || ""));
        if (models.length === 0) {
          setError("当前账号未配置可用的图生视频模型，请先到系统设置中配置。");
        }
      } catch (requestError) {
        if (!active) return;
        setError((requestError as Error).message);
      } finally {
        if (active) setConfigLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const nextPreviewUrl = URL.createObjectURL(file);
    setPreviewUrl(nextPreviewUrl);
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [file]);

  const openMaterialLibrary = (mode: MaterialLibraryMode) => {
    setLibraryMode(mode);
    setLibrarySelection(mode === "single" ? (file ? [normalizeImageKey(file.name)] : []) : batchSelectedKeys);
    setLibraryMessage("");
    setLibraryOpen(true);
  };

  const handleLibraryUpload = (fileList: FileList | null) => {
    if (!fileList) return;
    const selectedFiles = Array.from(fileList);
    const invalidFiles = selectedFiles.filter((item) => !isAcceptedImageFile(item));
    if (invalidFiles.length > 0) {
      setLibraryMessage("素材库仅支持 PNG、JPEG 或 WebP 图片文件。");
      return;
    }

    const fileMap = new Map(libraryFiles.map((materialFile) => [normalizeImageKey(materialFile.name), materialFile]));
    const overwrittenNames: string[] = [];
    const addedKeys: string[] = [];

    for (const materialFile of selectedFiles) {
      const key = normalizeImageKey(materialFile.name);
      if (fileMap.has(key)) overwrittenNames.push(materialFile.name);
      fileMap.set(key, materialFile);
      addedKeys.push(key);
    }

    setLibraryFiles(Array.from(fileMap.values()).sort((left, right) => left.name.localeCompare(right.name)));
    setLibrarySelection((current) => {
      if (libraryMode === "single") {
        return addedKeys.length > 0 ? [addedKeys[addedKeys.length - 1]] : current;
      }
      return Array.from(new Set([...current, ...addedKeys]));
    });
    setLibraryMessage(
      overwrittenNames.length > 0
        ? `已覆盖同名素材：${overwrittenNames.slice(0, 3).join("、")}${overwrittenNames.length > 3 ? "..." : ""}`
        : `已加入 ${selectedFiles.length} 个素材。`,
    );
  };

  const toggleLibrarySelection = (key: string) => {
    setLibrarySelection((current) => {
      if (libraryMode === "single") return current[0] === key ? [] : [key];
      return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
    });
  };

  const applyLibrarySelection = () => {
    if (libraryMode === "single") {
      const nextFile = librarySelection[0] ? libraryFileMap.get(librarySelection[0]) : undefined;
      setFile(nextFile);
      if (nextFile) setImageUrl("");
      setError("");
    } else {
      setBatchSelectedKeys(librarySelection);
      setBatchError("");
      setBatchResult("");
    }
    setLibraryOpen(false);
  };

  const handleSingleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !canSubmit) return;

    const token = getToken();
    if (!token) return;
    if (!selectedModel) {
      setError("请先选择一个图生视频模型。");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await api.createVideoFromImage(
        token,
        {
          prompt: prompt.trim(),
          model: selectedModel,
          imageUrl: imageUrl || undefined,
          aspectRatio: sizeToAspectRatio(size),
          size,
          durationSec: duration,
        },
        file,
      );
      onCreated();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleBatchFileChange = async (nextFile?: File) => {
    if (!nextFile) return;
    try {
      const buffer = await nextFile.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const parsedRows = parseBatchRows(rows);
      setBatchRows(parsedRows);
      setBatchFileName(nextFile.name);
      setBatchError("");
      setBatchResult("");
      setBatchProgress({ done: 0, total: parsedRows.length });
    } catch (requestError) {
      setBatchRows([]);
      setBatchFileName("");
      setBatchError((requestError as Error).message);
      setBatchResult("");
      setBatchProgress({ done: 0, total: 0 });
    }
  };

  const handleBatchSubmit = async () => {
    const token = getToken();
    if (!token || batchRows.length === 0) return;

    setBatchSubmitting(true);
    setBatchError("");
    setBatchResult("");
    setBatchProgress({ done: 0, total: batchRows.length });

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const [index, row] of batchRows.entries()) {
        const model = row.model || selectedModel || availableModels[0];
        if (!model) {
          failures.push(`第 ${row.line} 行没有可用模型`);
          setBatchProgress({ done: index + 1, total: batchRows.length });
          continue;
        }
        if (row.model && !availableModels.includes(row.model)) {
          failures.push(`第 ${row.line} 行指定的模型不在当前账号的可用列表中`);
          setBatchProgress({ done: index + 1, total: batchRows.length });
          continue;
        }

        const localFile = row.imageName ? batchImageMap.get(normalizeImageKey(row.imageName)) : undefined;
        if (row.imageName && !localFile) {
          failures.push(`第 ${row.line} 行未找到匹配的本地素材：${row.imageName}`);
          setBatchProgress({ done: index + 1, total: batchRows.length });
          continue;
        }
        if (!localFile && !row.imageUrl) {
          failures.push(`第 ${row.line} 行缺少可用图片，需要提供 imageName 或 imageUrl`);
          setBatchProgress({ done: index + 1, total: batchRows.length });
          continue;
        }

        try {
          await api.createVideoFromImage(
            token,
            {
              prompt: row.prompt,
              model,
              imageUrl: localFile ? undefined : row.imageUrl,
              aspectRatio: row.aspectRatio,
              size: aspectRatioToSize(row.aspectRatio),
              durationSec: row.durationSec,
            },
            localFile,
          );
          successCount += 1;
        } catch (requestError) {
          failures.push(`第 ${row.line} 行提交失败：${(requestError as Error).message}`);
        } finally {
          setBatchProgress({ done: index + 1, total: batchRows.length });
        }
      }

      setBatchResult(`已提交 ${successCount}/${batchRows.length} 条任务。`);
      if (failures.length > 0) setBatchError(failures.slice(0, 5).join("；"));
      if (successCount > 0) onCreated();
    } finally {
      setBatchSubmitting(false);
    }
  };

  const renderModelSelect = (label: string) => (
    <div>
      <label
        style={{
          display: "block",
          fontSize: "0.7rem",
          fontFamily: "JetBrains Mono, monospace",
          color: "var(--text-muted)",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {label}
      </label>
      <select
        className="input-field"
        value={selectedModel}
        onChange={(event) => setSelectedModel(event.target.value)}
        disabled={configLoading || availableModels.length === 0}
      >
        {availableModels.length === 0 ? (
          <option value="">{configLoading ? "加载模型中..." : "未配置可用模型"}</option>
        ) : (
          availableModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))
        )}
      </select>
    </div>
  );

  return (
    <>
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "Syne, sans-serif",
              fontWeight: 700,
              fontSize: "1rem",
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            图生视频
          </h2>
          <p style={{ margin: "8px 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            单个生成和批量生成已合并到同一个面板，按需切换。
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
            padding: 4,
            borderRadius: 999,
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
          }}
        >
          {[
            { key: "single" as const, label: "单个生成" },
            { key: "batch" as const, label: "批量生成" },
          ].map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "10px 14px",
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "#03130f" : "var(--text-secondary)",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "single" ? (
          <form onSubmit={handleSingleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.7rem",
                  fontFamily: "JetBrains Mono, monospace",
                  color: "var(--text-muted)",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                PROMPT
              </label>
              <textarea
                className="input-field"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述视频动作和镜头效果..."
                rows={3}
                style={{ resize: "vertical", minHeight: 88 }}
              />
            </div>

            {renderModelSelect("MODEL")}

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.7rem",
                  fontFamily: "JetBrains Mono, monospace",
                  color: "var(--text-muted)",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                INPUT IMAGE
              </label>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn-ghost" onClick={() => openMaterialLibrary("single")}>
                  素材库
                </button>
                {file && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setFile(undefined);
                      setError("");
                    }}
                  >
                    清除已选素材
                  </button>
                )}
              </div>

              <input
                className="input-field"
                type="url"
                value={imageUrl}
                onChange={(event) => {
                  setImageUrl(event.target.value);
                  if (event.target.value) setFile(undefined);
                }}
                placeholder="图片 URL，与素材库二选一"
                style={{ marginTop: 10 }}
              />

              {file && previewUrl && (
                <div
                  style={{
                    marginTop: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "var(--bg-raised)",
                  }}
                >
                  <img
                    src={previewUrl}
                    alt={file.name}
                    style={{ width: "100%", display: "block", maxHeight: 220, objectFit: "cover" }}
                  />
                  <div
                    style={{
                      padding: "12px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.name}
                      >
                        {file.name}
                      </div>
                      <div style={{ marginTop: 4, fontSize: "0.72rem", color: "var(--text-muted)" }}>
                        来自素材库
                      </div>
                    </div>

                    <button type="button" className="btn-ghost" onClick={() => openMaterialLibrary("single")}>
                      重新选择
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.7rem",
                  fontFamily: "JetBrains Mono, monospace",
                  color: "var(--text-muted)",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                ASPECT RATIO
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSize(option.value)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 20,
                      border: `1px solid ${size === option.value ? "var(--accent)" : "var(--border)"}`,
                      background: size === option.value ? "var(--accent-glow)" : "transparent",
                      color: size === option.value ? "var(--accent)" : "var(--text-secondary)",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.7rem",
                  fontFamily: "JetBrains Mono, monospace",
                  color: "var(--text-muted)",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                DURATION
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {DURATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setDuration(option.value)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 20,
                      border: `1px solid ${duration === option.value ? "var(--accent)" : "var(--border)"}`,
                      background: duration === option.value ? "var(--accent-glow)" : "transparent",
                      color: duration === option.value ? "var(--accent)" : "var(--text-secondary)",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: "0.8rem",
                  color: "var(--error)",
                }}
              >
                {error}
              </div>
            )}

            <button
              className="btn-primary"
              type="submit"
              disabled={loading || generating || !prompt.trim() || !canSubmit || !selectedModel}
              style={{ width: "100%" }}
            >
              {loading ? "提交中..." : generating ? "生成中..." : "生成视频"}
            </button>
          </form>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {renderModelSelect("DEFAULT MODEL")}

            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.7 }}>
              批量规则：
              <br />
              1. 推荐在 Excel 中填写 <code>imageName</code>，然后在素材库中勾选同名图片。
              <br />
              2. 如果没有 <code>imageName</code>，才会使用 <code>imageUrl</code>。
              <br />
              3. Excel 里的 <code>model</code> 为空时，使用上面的默认模型。
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn-ghost" onClick={downloadBatchTemplate}>
                下载模板
              </button>

              <label
                className="btn-ghost"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              >
                上传 Excel
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(event) => void handleBatchFileChange(event.target.files?.[0])}
                  style={{ display: "none" }}
                />
              </label>

              <button type="button" className="btn-ghost" onClick={() => openMaterialLibrary("batch")}>
                素材库
              </button>
            </div>

            {batchFileName && (
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                已导入 Excel：{batchFileName}，共 {batchRows.length} 条。
              </div>
            )}

            {batchRows.length > 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                当前已匹配 {batchMatchedCount}/{batchRows.length} 条图片素材。
              </div>
            )}

            {batchImageFiles.length > 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.7 }}>
                已选择 {batchImageFiles.length} 张素材：
                <br />
                {batchImageFiles
                  .slice(0, 6)
                  .map((imageFile) => imageFile.name)
                  .join("、")}
                {batchImageFiles.length > 6 ? " ..." : ""}
              </div>
            )}

            {batchProgress.total > 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                进度：{batchProgress.done}/{batchProgress.total}
              </div>
            )}

            {batchResult && <div style={{ fontSize: "0.8rem", color: "var(--success)" }}>{batchResult}</div>}
            {batchError && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{batchError}</div>}

            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleBatchSubmit()}
              disabled={batchSubmitting || batchRows.length === 0 || !selectedModel}
            >
              {batchSubmitting ? "批量提交中..." : "批量生成视频"}
            </button>
          </div>
        )}
      </div>

      <MaterialLibraryModal
        open={libraryOpen}
        mode={libraryMode}
        files={libraryFiles}
        message={libraryMessage}
        selectedKeys={librarySelection}
        onClose={() => setLibraryOpen(false)}
        onApply={applyLibrarySelection}
        onToggle={toggleLibrarySelection}
        onUpload={handleLibraryUpload}
      />
    </>
  );
}
