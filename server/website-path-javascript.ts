export function decodeJsLiteral(literal: string): string | undefined {
  if (!isCompleteJavascriptLiteral(literal)) return;
  const contents = literal.slice(1, -1);
  if (literal[0] === "`" && contents.includes("${")) return;
  try {
    return contents.replace(/\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi, (_whole, unicode: string | undefined, unit: string | undefined, byte: string | undefined, escape: string | undefined) => {
      if (unicode || unit || byte) return String.fromCodePoint(Number.parseInt(unicode ?? unit ?? byte!, 16));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape!] ?? escape!;
    });
  } catch { return; }
}

/** An EOF or newline inside a string is not evidence of a complete URL. */
export function isCompleteJavascriptLiteral(literal: string): boolean {
  if (literal.length < 2 || !["'", '"', "`"].includes(literal[0]) || literal.at(-1) !== literal[0]) return false;
  let backslashes = 0;
  for (let index = literal.length - 2; index >= 0 && literal[index] === "\\"; index--) backslashes++;
  return backslashes % 2 === 0;
}

export interface JavascriptToken { 0: string; index: number; comment: boolean }
/** A static lexer keeps nested template literals from shifting every subsequent string boundary. */
export function javascriptTokens(text: string): JavascriptToken[] {
  const tokens: JavascriptToken[] = [];
  const commentEnd = (start: number) => text[start + 1] === "/" ? (() => {
    const end = text.indexOf("\n", start + 2); return end < 0 ? text.length : end;
  })() : (() => { const end = text.indexOf("*/", start + 2); return end < 0 ? text.length : end + 2; })();
  const regexStart = (start: number) => {
    const previous = text.slice(Math.max(0, start - 60), start).trimEnd();
    return !previous || /[=(:,!&|?;\[{]$/.test(previous) || /\b(?:return|throw|case|yield|void|typeof|delete)\s*$/.test(previous);
  };
  const regexEnd = (start: number) => {
    let characterClass = false;
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") { index++; continue; }
      if (text[index] === "\n" || text[index] === "\r") return start + 1;
      if (text[index] === "[") characterClass = true;
      else if (text[index] === "]") characterClass = false;
      else if (text[index] === "/" && !characterClass) {
        index++;
        while (/[a-z]/i.test(text[index] ?? "") && index < text.length) index++;
        return index;
      }
    }
    return start + 1;
  };
  const quotedEnd = (start: number, level: number): number => {
    if (level > 32) return text.length;
    const quote = text[start];
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === quote) return index + 1;
      if (quote !== "`" && /[\r\n]/.test(text[index])) return index;
      if (quote === "`" && text[index] === "$" && text[index + 1] === "{") {
        index += 2;
        let braces = 1;
        while (index < text.length && braces) {
          const current = text[index];
          if (["'", '"', "`"].includes(current)) { index = quotedEnd(index, level + 1); continue; }
          if (current === "/" && ["/", "*"].includes(text[index + 1])) { index = commentEnd(index); continue; }
          if (current === "/" && regexStart(index)) { index = regexEnd(index); continue; }
          if (current === "{") braces++;
          else if (current === "}") braces--;
          index++;
        }
        continue;
      }
      index++;
    }
    return index;
  };
  for (let index = 0; index < text.length;) {
    const current = text[index];
    const comment = current === "/" && ["/", "*"].includes(text[index + 1]);
    const regex = current === "/" && !comment && regexStart(index);
    if (comment || regex || ["'", '"', "`"].includes(current)) {
      const end = comment ? commentEnd(index) : regex ? regexEnd(index) : quotedEnd(index, 0);
      tokens.push({ 0: text.slice(index, end), index, comment: comment || regex });
      index = Math.max(index + 1, end);
    } else index++;
  }
  return tokens;
}
export function maskJavascriptTokens(text: string, tokens: JavascriptToken[], commentsOnly = false): string {
  const parts: string[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (commentsOnly && !token.comment) continue;
    parts.push(text.slice(offset, token.index), token[0].replace(/[^\r\n]/g, " "));
    offset = token.index + token[0].length;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}
