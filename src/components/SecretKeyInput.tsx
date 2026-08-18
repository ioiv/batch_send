import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  >({ kind: "idle", message: "尚未导入文件" });
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
    const fileElement = fileInputRef.current;
    const textareaElement = textareaRef.current;
    const clearDomValue = () => {
      cancelPendingImport();
      const currentFileElement = fileInputRef.current || fileElement;
      const currentTextareaElement = textareaRef.current || textareaElement;
      if (currentFileElement) currentFileElement.value = "";
      if (currentTextareaElement) currentTextareaElement.value = "";
      setFileStatus({ kind: "idle", message: "尚未导入文件" });
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
      if (fileElement) fileElement.value = "";
      if (textareaElement) textareaElement.value = "";
    };
  }, [cancelPendingImport, updateLineCount]);

  useImperativeHandle(ref, () => ({
    clear() {
      cancelPendingImport();
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.value = "";
      setFileStatus({ kind: "idle", message: "尚未导入文件" });
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
    <Field className="secret-input">
      <div className="secret-input-heading">
        <FieldLabel htmlFor={`${mode}-secret-keys`}>来源钱包密钥</FieldLabel>
        <Badge aria-live="polite" variant="outline">{lineCount > maximumSecretInputLines
          ? `超过 ${maximumSecretInputLines} 行上限`
          : lineCount ? `${lineCount} 行待解析` : "尚未输入"}</Badge>
      </div>
      <div className="secret-file-import">
        <Input
          accept=".txt,.csv,.json,text/plain,text/csv,application/json"
          aria-describedby={`${mode}-secret-file-status ${mode}-secret-help`}
          className="sr-only"
          disabled={disabled}
          onChange={handleFileChange}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <Button
          className="secret-file-button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          type="button"
          variant="outline"
        >
          导入钱包文件
        </Button>
        {fileStatus.kind !== "error" ? (
          <span aria-live="polite" className="secret-file-status" id={`${mode}-secret-file-status`}>
            {fileStatus.kind === "success"
              ? `${fileStatus.fileName} · 已载入 ${fileStatus.lineCount} 行`
              : fileStatus.message}
          </span>
        ) : null}
      </div>
      <Textarea
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
      {fileStatus.kind === "error" ? (
        <Alert id={`${mode}-secret-file-status`} variant="destructive"><AlertDescription>{fileStatus.message}</AlertDescription></Alert>
      ) : null}
      <FieldDescription className="sr-only" id={`${mode}-secret-help`}>
        每行一个来源钱包密钥。密钥只保留在当前 DOM 输入中。
      </FieldDescription>
    </Field>
  );
});
