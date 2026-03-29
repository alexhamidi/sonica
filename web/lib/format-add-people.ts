export function formatAddPeople(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `Add ${names[0]}`;
  if (names.length === 2) return `Add ${names[0]} and ${names[1]}`;
  const rest = names.slice(0, -1).join(", ");
  return `Add ${rest}, and ${names[names.length - 1]}`;
}
