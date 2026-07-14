const confusableCharacters: Readonly<Record<string, string>> = {
  "а": "a",
  "α": "a",
  "в": "b",
  "β": "b",
  "с": "c",
  "ԁ": "d",
  "е": "e",
  "ε": "e",
  "н": "h",
  "һ": "h",
  "і": "i",
  "ι": "i",
  "ј": "j",
  "к": "k",
  "κ": "k",
  "м": "m",
  "о": "o",
  "ο": "o",
  "р": "p",
  "ρ": "p",
  "ѕ": "s",
  "т": "t",
  "τ": "t",
  "х": "x",
  "χ": "x",
  "у": "y",
  "υ": "y",
};

const confusablePattern = /[аαвβсԁеεнһіιјкκмоοрρѕтτхχуυ]/gu;

export function canonicalizeCoachSafetyText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[’‘ʼ＇]/g, "'")
    .toLowerCase()
    .replace(confusablePattern, (character) => confusableCharacters[character] ?? character)
    .replace(/\s+/g, " ")
    .trim();
}
