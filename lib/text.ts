/** Разбор абзацев из tan-ata/lib/text.ts; без персональных данных. */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}
