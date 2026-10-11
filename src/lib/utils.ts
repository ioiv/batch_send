import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const mergeClasses = extendTailwindMerge({
  extend: {
    theme: {
      text: ["ui-caption", "ui-label", "ui-body", "ui-title", "ui-heading"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return mergeClasses(clsx(inputs))
}
