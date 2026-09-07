/**
 * Answering Google's Gemini consent gate — an OPERATOR switch, default off.
 *
 * Upstream refuses to click that prompt, and the reason is right: consent is the account holder's
 * decision (Vexa-ai/vexa#429). But the prompt is shown to the BOT's own account inside the bot's own
 * browser, where nobody in the meeting can reach it — so on a deployment whose bot account belongs
 * to the operator, refusing parks the bot in the lobby for the full fifteen-minute window with only
 * a log line to say why. Observed live: admitted by the host, then
 * "⚠️ Gemini consent prompt visible" every 2.5 seconds, and never in the call.
 *
 * So the operator who owns the bot account decides once, for their own account, and every other
 * deployment keeps upstream's behaviour untouched.
 *
 * Run: npx tsx src/googlemeet/consent-accept.test.ts
 */
import { acceptConsentPrompt, consentAutoAcceptEnabled } from "./admission.js";
import { googleConsentAcceptButtons } from "./selectors.js";

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

/** A page where exactly these selectors are visible; records what got clicked. */
const fakePage = (visible: string[]) => {
  const clicked: string[] = [];
  return {
    clicked,
    locator: (selector: string) => ({
      first: () => ({
        isVisible: async () => visible.includes(selector),
        click: async () => { clicked.push(selector); },
      }),
    }),
  };
};

async function run() {
  console.log("\n=== the switch ===");
  check("OFF by default — upstream behaviour preserved", consentAutoAcceptEnabled({}) === false);
  check("off for every value that is not exactly true",
    [undefined, "", "false", "0", "no", "yes", "1"].every(
      (v) => consentAutoAcceptEnabled({ BOT_GMEET_ACCEPT_GEMINI_CONSENT: v as string }) === false));
  check("on when the operator says so, case- and space-tolerant",
    consentAutoAcceptEnabled({ BOT_GMEET_ACCEPT_GEMINI_CONSENT: " TRUE " }) === true);

  console.log("\n=== clicking, and refusing to ===");
  const p1 = fakePage(['[role="dialog"] button:has-text("Got it")']);
  check("a visible accept button inside the dialog is clicked",
    (await acceptConsentPrompt(p1 as never)) === true && p1.clicked.length === 1);

  const p2 = fakePage([]);
  check("nothing visible ⇒ no click, caller falls back to the escalation",
    (await acceptConsentPrompt(p2 as never)) === false && p2.clicked.length === 0);

  // The guard that matters most. A bare button:has-text("Join now") would match the ordinary
  // pre-join button and click the bot into a call it never consented to — the exact opposite of
  // what this switch is for.
  check("every accept selector is scoped to the consent dialog",
    googleConsentAcceptButtons.every(
      (s) => s.startsWith('[role="dialog"]') || s.startsWith('[role="alertdialog"]')));

  const p3 = fakePage(['button:has-text("Join now")']);   // pre-join button, NOT in a dialog
  check("an unscoped Join-now button is never clicked",
    (await acceptConsentPrompt(p3 as never)) === false && p3.clicked.length === 0);

  const throwing = {
    locator: () => ({ first: () => ({ isVisible: async () => { throw new Error("detached"); } }) }),
  };
  check("a page that throws degrades to 'not accepted', never an exception",
    (await acceptConsentPrompt(throwing as never)) === false);

  const stops = fakePage([
    '[role="dialog"] button:has-text("Got it")',
    '[role="dialog"] button:has-text("Accept")',
  ]);
  await acceptConsentPrompt(stops as never);
  check("stops at the FIRST visible button — one consent, not a click storm",
    stops.clicked.length === 1);

  if (failed) { console.error(`\n❌ consent-accept: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log("\n✅ consent-accept: off by default; on, it clicks only inside the consent dialog.");
}
run().catch((e) => { console.error(e); process.exit(1); });
