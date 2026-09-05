/** Transcription languages — the closed code set a join request may force.
 *
 *  Ported from the 0.11 dashboard's `lib/languages.ts` (dropped with `clients/dashboard` in
 *  deefda3b). The set mirrors what the Whisper family tokenizes; meeting-api does NOT validate
 *  `language` (it forwards the code straight to the STT backend as a multipart field —
 *  modules/whisper/src/transcription-client.ts), so THIS list is the only thing standing between a
 *  typo and a backend 400. Keep it closed.
 */

export const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  af: "Afrikaans",
  am: "Amharic",
  ar: "Arabic",
  as: "Assamese",
  az: "Azerbaijani",
  ba: "Bashkir",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bengali",
  bo: "Tibetan",
  br: "Breton",
  bs: "Bosnian",
  ca: "Catalan",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fo: "Faroese",
  fr: "French",
  gl: "Galician",
  gu: "Gujarati",
  ha: "Hausa",
  haw: "Hawaiian",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  ht: "Haitian Creole",
  hu: "Hungarian",
  hy: "Armenian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  jw: "Javanese",
  ka: "Georgian",
  kk: "Kazakh",
  km: "Khmer",
  kn: "Kannada",
  ko: "Korean",
  la: "Latin",
  lb: "Luxembourgish",
  ln: "Lingala",
  lo: "Lao",
  lt: "Lithuanian",
  lv: "Latvian",
  mg: "Malagasy",
  mi: "Maori",
  mk: "Macedonian",
  ml: "Malayalam",
  mn: "Mongolian",
  mr: "Marathi",
  ms: "Malay",
  mt: "Maltese",
  my: "Myanmar",
  ne: "Nepali",
  nl: "Dutch",
  nn: "Norwegian Nynorsk",
  no: "Norwegian",
  oc: "Occitan",
  pa: "Punjabi",
  pl: "Polish",
  ps: "Pashto",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sa: "Sanskrit",
  sd: "Sindhi",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  sn: "Shona",
  so: "Somali",
  sq: "Albanian",
  sr: "Serbian",
  su: "Sundanese",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  tg: "Tajik",
  th: "Thai",
  tk: "Turkmen",
  tl: "Tagalog",
  tr: "Turkish",
  tt: "Tatar",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  yi: "Yiddish",
  yo: "Yoruba",
  zh: "Chinese",
  yue: "Cantonese",
};

const POPULARITY_ORDER: string[] = [
  "en", "es", "zh", "hi", "ar", "pt", "bn", "ru", "ja", "pa", "de", "jw", "ko", "fr",
  "te", "mr", "tr", "vi", "ta", "ur", "id", "pl", "nl", "it", "uk", "th", "gu", "fa",
  "sw", "ro", "ml", "kn", "my", "yo", "ha", "am", "ne", "si", "sv", "cs", "el", "hu",
  "fi", "da", "he", "sk", "bg", "no", "hr", "sr", "ca", "lt", "sl", "et", "lv", "tl",
  "af", "sq", "hy", "az", "eu", "gl", "mk", "ka", "lo", "km", "ps", "sd", "uz", "kk",
  "mn", "tg", "tk", "so", "sn", "mg", "oc", "br", "cy", "yi", "la", "bo", "sa", "fo",
  "lb", "ln", "tt", "ba", "su", "haw", "mi", "yue",
];

/** All Whisper language codes (no "auto"). Sorted by popularity then by name. */
export const WHISPER_LANGUAGE_CODES = (() => {
  const byName = (a: string, b: string) =>
    WHISPER_LANGUAGE_NAMES[a].localeCompare(WHISPER_LANGUAGE_NAMES[b]);
  const rank = (code: string) => {
    const i = POPULARITY_ORDER.indexOf(code);
    return i === -1 ? 1e4 : i;
  };
  return Object.keys(WHISPER_LANGUAGE_NAMES).sort((a, b) => {
    const r = rank(a) - rank(b);
    return r !== 0 ? r : byName(a, b);
  });
})();


/** The sentinel meaning "let the STT backend detect it" — never sent on the wire. */
export const AUTO_LANGUAGE = "auto";

/** A code is valid iff it is `auto` or a known Whisper code. */
export function isLanguageCode(code: string): boolean {
  return code === AUTO_LANGUAGE || WHISPER_LANGUAGE_NAMES[code] != null;
}

/** Human label for a code (`auto` → "Auto-detect"; an unknown code shows itself, upper-cased). */
export function languageDisplayName(code: string): string {
  if (code === AUTO_LANGUAGE) return "Auto-detect";
  return WHISPER_LANGUAGE_NAMES[code] ?? code.toUpperCase();
}
