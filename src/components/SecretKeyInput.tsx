import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent } from "react";
import { readSecretKeyFile, SecretKeyImportError } from "../lib/secret-key-import";

export type SecretKeyInputHandle = {
  clear: () => void;
  focus: () => void;
  read: () => string;
};

const maximumSecretInputCharacters = 512 * 1024;
const maximumSecretInputLines = 1_000;

function countSecretInputLines(value: string) {
  let count = 0;
  let lineHasContent = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character !== "\n" && character !== undefined) {
      if (!/\s/u.test(character)) lineHasContent = true;
      continue;
    }
    if (lineHasContent) {
      count += 1;
      if (count > maximumSecretInputLines) return count;
    }
    lineHasContent = false;
  }
  return count;
}

export const SecretKeyInput = forwardRef<SecretKeyInputHandle, {
  disabled?: boolean;
  mode: "evm" | "solana";
  onDirty?: () => void;
  onImportingChange?: (importing: boolean) => void;
  onLineCountChange?: (lineCount: number) => void;
}>(function SecretKeyInput({
  disabled = false,
  mode,
  onDirty,
  onImportingChange,
  onLineCountChange
}, ref) {
  const disabledRef = useRef(disabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const importRequestRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileStatus, setFileStatus] = useState<
    | { kind: "error" | "idle" | "loading"; message: string }
    | { fileName: string; kind: "success"; lineCount: number }
  >({ kind: "idle", message: "支持 TXT、CSV、JSON，最大 512 KB" });
  const [lineCount, setLineCount] = useState(0);
  disabledRef.current = disabled;

  const updateLineCount = useCallback((nextLineCount: number) => {
    setLineCount(nextLineCount);
    onLineCountChange?.(nextLineCount);
  }, [onLineCountChange]);

  const setImportActive = useCallback((active: boolean) => {
    if (importingRef.current === active) return;
    importingRef.current = active;
    onImportingChange?.(active);
  }, [onImportingChange]);

  const cancelPendingImport = useCallback(() => {
    importRequestRef.current += 1;
    setImportActive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [setImportActive]);

  useEffect(() => {
    const clearDomValue = () => {
      cancelPendingImport();
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.value = "";
      setFileStatus({ kind: "idle", message: "支持 TXT、CSV、JSON，最大 512 KB" });
      updateLineCount(0);
    };
    const clearRestoredValue = (event: PageTransitionEvent) => {
      if (event.persisted) clearDomValue();
    };
    window.addEventListener("pagehide", clearDomValue);
    window.addEventListener("pageshow", clearRestoredValue);
    return () => {
      window.removeEventListener("pagehide", clearDomValue);
      window.removeEventListener("pageshow", clearRestoredValue);
      cancelPendingImport();
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.value = "";
    };
  }, [cancelPendingImport, updateLineCount]);

  useImperativeHandle(ref, () => ({
    clear() {
      cancelPendingImport();
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.value = "";
      setFileStatus({ kind: "idle", message: "支持 TXT、CSV、JSON，最大 512 KB" });
      updateLineCount(0);
    },
    focus() {
      textareaRef.current?.focus();
    },
    read() {
      return textareaRef.current?.value || "";
    }
  }), [cancelPendingImport, updateLineCount]);

  useEffect(() => {
    if (!disabled) return;
    cancelPendingImport();
    setFileStatus((current) => current.kind === "loading"
      ? { kind: "idle", message: "文件导入已取消" }
      : current);
  }, [cancelPendingImport, disabled]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Retaining a selected filename in a file control can expose it through
    // browser restoration. Keep only the File reference needed for this read.
    input.value = "";
    if (!file) return;

    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;
    setImportActive(true);
    setFileStatus({ kind: "loading", message: "正在本地读取文件…" });

    try {
      const imported = await readSecretKeyFile(file, mode);
      if (requestId !== importRequestRef.current || disabledRef.current || !textareaRef.current) return;

      textareaRef.current.value = imported.value;
      updateLineCount(imported.lineCount);
      setFileStatus({
        fileName: imported.fileName,
        kind: "success",
        lineCount: imported.lineCount
      });
      onDirty?.();
    } catch (error) {
      if (requestId !== importRequestRef.current) return;
      setFileStatus({
        kind: "error",
        message: error instanceof SecretKeyImportError
          ? error.message
          : "文件导入失败，请重新选择文件"
      });
    } finally {
      // Clear again after the asynchronous read so the same file can be chosen
      // twice and no browser-visible file selection remains behind.
      input.value = "";
      if (requestId === importRequestRef.current) setImportActive(false);
    }
  };

  const placeholder = mode === "evm"
    ? "每行一个私钥，或：备注,0x私钥\n示例：运营钱包 01,0x…"
    : "每行一个 Base58 / JSON 数组私钥，或：备注,私钥\n示例：运营钱包 01,[12,34,…]";

  return (
    <div className="secret-input">
      <div className="secret-input-heading">
        <label htmlFor={`${mode}-secret-keys`}>来源钱包密钥</label>
        <span aria-live="polite">{lineCount > maximumSecretInputLines
          ? `超过 ${maximumSecretInputLines} 行上限`
          : lineCount ? `${lineCount} 行待解析` : "尚未输入"}</span>
      </div>
      <div className="secret-file-import">
        <label className={`button ghost compact-button secret-file-button${disabled ? " is-disabled" : ""}`}>
          选择本地文件
          <input
            accept=".txt,.csv,.json,text/plain,text/csv,application/json"
            aria-describedby={`${mode}-secret-file-status ${mode}-secret-help`}
            disabled={disabled}
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
          />
        </label>
        <span
          aria-live="polite"
          className={`secret-file-status${fileStatus.kind === "error" ? " is-error" : ""}`}
          id={`${mode}-secret-file-status`}
        >
          {fileStatus.kind === "success"
            ? `${fileStatus.fileName} · 已载入 ${fileStatus.lineCount} 行`
            : fileStatus.message}
        </span>
      </div>
      <textarea
        aria-describedby={`${mode}-secret-help`}
        autoCapitalize="none"
        autoComplete="off"
        className="secret-textarea"
        data-1p-ignore="true"
        data-bwignore="true"
        disabled={disabled}
        id={`${mode}-secret-keys`}
        maxLength={maximumSecretInputCharacters}
        onInput={(event) => {
          cancelPendingImport();
          const value = event.currentTarget.value;
          updateLineCount(countSecretInputLines(value));
          setFileStatus({ kind: "idle", message: "已手动编辑 · 文件来源状态已清除" });
          onDirty?.();
        }}
        placeholder={placeholder}
        ref={textareaRef}
        rows={8}
        spellCheck={false}
      />
      <p className="hint secret-help" id={`${mode}-secret-help`}>
        密钥和导入文件仅在当前页面内存中解析、签名，不会写入浏览器存储或发送到本站服务器；文件控件读取后会立即清空。任务结束后请立即清除。
      </p>
    </div>
  );
});
