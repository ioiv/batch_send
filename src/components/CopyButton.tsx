import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { copyText } from "@/lib/clipboard";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  return <Button size="sm" variant="outline" type="button" aria-label={`${label}${feedback ? `：${feedback}` : ""}`}
    onClick={async () => {
      const copied = await copyText(value);
      if (!mounted.current) return;
      clearTimeout(timer.current);
      setFeedback(copied ? "已复制" : "复制失败，请手动选择");
      timer.current = setTimeout(() => setFeedback(""), 2500);
    }}><span role="status">{feedback || label}</span></Button>;
}
