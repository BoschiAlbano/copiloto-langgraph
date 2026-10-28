// Minúsculas y sin acentos: "Giménez" y "gimenez" se comparan como iguales.
export const ACCENTS_FROM = "áéíóúüñ";
export const ACCENTS_TO = "aeiouun";

export const normalize = (value: string) =>
  [...value.toLowerCase()].map((c) => ACCENTS_TO[ACCENTS_FROM.indexOf(c)] ?? c).join("");
