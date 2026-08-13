import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type SecretKeyInputHandle = {
  clear: () => void;
  focus: () => void;
  read: () => string;
};

export const SecretKeyInput = forwardRef<SecretKeyInputHandle, {
  disabled?: boolean;
  mode: "evm" | "solana";
  onDirty?: () => void;
}>(function SecretKeyInput({ disabled = false, mode, onDirty }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [lineCount, setLineCount] = useState(0);

  useEffect(() => {
    const clearDomValue = () => {
      if (textareaRef.current) textareaRef.current.value = "";
      setLineCount(0);
    };
    const clearRestoredValue = (event: PageTransitionEvent) => {
      if (event.persisted) clearDomValue();
    };
    window.addEventListener("pagehide", clearDomValue);
    window.addEventListener("pageshow", clearRestoredValue);
    return () => {
      window.removeEventListener("pagehide", clearDomValue);
      window.removeEventListener("pageshow", clearRestoredValue);
      if (textareaRef.current) textareaRef.current.value = "";
    };
  }, []);

  useImperativeHandle(ref, () => ({
    clear() {
      if (textareaRef.current) textareaRef.current.value = "";
      setLineCount(0);
    },
    focus() {
      textareaRef.current?.focus();
    },
    read() {
      return textareaRef.current?.value || "";
    }
  }), []);

  const placeholder = mode === "evm"
    ? "每行一个私钥，或：备注,0x私钥\n示例：运营钱包 01,0x…"
    : "每行一个 Base58 / JSON 数组私钥，或：备注,私钥\n示例：运营钱包 01,[12,34,…]";

  return (
    <div className="secret-input">
      <div className="secret-input-heading">
        <label htmlFor={`${mode}-secret-keys`}>来源钱包密钥</label>
        <span aria-live="polite">{lineCount ? `${lineCount} 行待解析` : "尚未输入"}</span>
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
        onInput={(event) => {
          const value = event.currentTarget.value;
          setLineCount(value.split(/\r?\n/).filter((line) => line.trim()).length);
          onDirty?.();
        }}
        placeholder={placeholder}
        ref={textareaRef}
        rows={8}
        spellCheck={false}
      />
      <p className="hint secret-help" id={`${mode}-secret-help`}>
        密钥仅在当前页面内存中解析和签名，不会写入浏览器存储或发送到本站服务器。任务结束后请立即清除。
      </p>
    </div>
  );
});
