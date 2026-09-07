/**
 * Hallucination-filter golden — pins the phrase-list + structural junk rules.
 * Run: npm test  (chained)  or  npx tsx src/hallucination-filter.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHallucination } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

// Structural rules (deterministic, no list dependency)
check("empty → dropped", isHallucination("") === true);
check("whitespace → dropped", isHallucination("   ") === true);
check("short single word → dropped", isHallucination("ok") === true);
check("long single word kept", isHallucination("internationalization") === false);
check("clean sentence kept", isHallucination("the quick brown fox jumps over") === false);
check("repetition loop (3+ ×) → dropped", isHallucination("i love it i love it i love it i love it") === true);

// Phrase-list path: a phrase actually in en.txt must be filtered (loaded the same way the brick loads).
const enPhrases = readFileSync(resolve(here, "hallucinations", "en.txt"), "utf-8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
check(`en.txt loaded (${enPhrases.length} phrases)`, enPhrases.length > 0);
check(`a known list phrase is filtered ("${enPhrases[0]}")`, isHallucination(enPhrases[0]) === true);

// #617 — the exact ja/tr "YouTube-outro" hallucinations the reporter saw leak through (the lists were
// en/es/pt/ru only). Each is > 10 chars so no structural rule catches it — only the phrase list does.
// RED at base (returns false → leaks), GREEN at head.
check('ja: "ご視聴ありがとうございました" filtered', isHallucination("ご視聴ありがとうございました") === true);
check('ja: "次の動画でお会いしましょう" filtered', isHallucination("次の動画でお会いしましょう") === true);
check('tr: "Abone olmayı unutmayın" filtered', isHallucination("Abone olmayı unutmayın") === true);
check('tr: case/punctuation-insensitive ("abone olmayı unutmayın.")', isHallucination("abone olmayı unutmayın.") === true);
check("real Spanish speech still kept (no over-filter)",
  isHallucination("empecemos con el bounded context de facturacion") === false);

// A REAL WORD IS NOT JUNK. Measured: a meeting said "…moves the data from table one, which is
// customers, to table two, which is" / "leads." — and the filter dropped "leads." as a short single
// word, so the sentence was published truncated and the answer was gone. The list already carries
// 31 single-word artifacts ("Bye.", "Yes.", "Uh-huh."), which is the check that belongs here; a
// blanket length rule cannot tell "leads." from "yeah." and guesses wrong on the content word.
check('a one-word ANSWER survives ("leads.")', isHallucination("leads.") === false);
check('…and its neighbours', isHallucination("Customers.") === false && isHallucination("Snowflake.") === false);
check('a one-word PRODUCT survives ("Partic.")', isHallucination("Partic.") === false);
// …while the known single-word junk still goes, list-driven, punctuation either way.
check('known single-word junk still dropped',
  isHallucination("Bye.") === true && isHallucination("Yes.") === true && isHallucination("Uh-huh.") === true);
check('a list entry matches without its punctuation ("ok" vs "OK.")', isHallucination("ok") === true);
check('…and with punctuation the list does not carry ("bye!!!")', isHallucination("bye!!!") === true);

// Whisper prefixes its stock outros with a conjunction, and the list is written without one. Measured
// in the same meeting: "and we'll see you next time." was published as speech nobody said.
check('an outro behind a conjunction is caught', isHallucination("and we'll see you next time.") === true);
check('…and bare', isHallucination("We'll see you next time.") === true);
check('…and other leaders', isHallucination("So, thank you.") === true && isHallucination("Well, bye.") === true);
check('a conjunction on REAL speech changes nothing',
  isHallucination("and then we move the customers table into leads") === false);

if (failed) { console.error(`\n❌ hallucination-filter: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ hallucination-filter: all checks pass — phrase-list + short/repetition junk dropped, real speech kept.`);
