/**
 * dc-detect.mjs — decide which converter a design file belongs to.
 *
 * There are two translators now, `dc-to-react.mjs` and `dc-to-astro.mjs`, and
 * the whole reason this file exists is that the choice between them must not be
 * a judgment call. The file itself carries the answer:
 *
 *   a Claude Design component  -> an `<x-dc>` template and a `text/x-dc` logic
 *                                 script, which only React can host
 *   a plain static html page   -> no dc runtime at all, so it stays static and
 *                                 becomes `.astro`, keeping the head meta, the
 *                                 JSON-LD and the prerendered output
 *
 * `dc-gen.mjs` defaults `--target` to what `detect()` reports and routes a
 * contradicting flag through `assertTarget()`, which throws. A wrong flag is a
 * loud stop, never a silently mistranslated page.
 *
 * Pure string work on purpose: no parse5, no dependency, cheap enough to run on
 * every file of a bundle before anything is written.
 */

export const TARGETS = ['react', 'astro'];

/* ---------- markers ------------------------------------------------------ */

/**
 * The dc runtime announces itself two ways and either one is conclusive.
 * `<x-dc` is matched with a following `>` or whitespace so the string "x-dc"
 * sitting in ordinary prose or a class name cannot trigger it.
 */
const X_DC_ELEMENT = /<x-dc[\s>]/i;
const X_DC_SCRIPT = /<script[^>]+type\s*=\s*["']text\/x-dc["']/i;

/**
 * The logic class dc-to-react.mjs needs. `extractLogic` in that module applies
 * the same test and dc-gen throws without it; reported here so the driver can
 * say which file is missing it before it starts writing.
 */
const LOGIC_CLASS = /class\s+Component\s+extends\s+(DCLogic|StreamableLogic)\b/;

/** A complete document rather than a fragment. Either marker will do. */
const HTML_DOCTYPE = /<!DOCTYPE\s+html/i;
const HTML_ELEMENT = /<html[\s>]/i;

/* ---------- detect ------------------------------------------------------- */

/**
 * @param {string} src  the file's contents
 * @returns {{ target: 'react'|'astro'|null, evidence: string, hasLogic: boolean }}
 *
 * Never throws. An unrecognized shape comes back as `target: null` with the
 * reason in `evidence`, and the caller decides what to do about it. Swallowing
 * that into a default would be exactly the wrong guess.
 */
export function detect(src) {
  const text = String(src ?? '');
  const hasLogic = LOGIC_CLASS.test(text);

  // Order is load-bearing. A .dc.html file is ALSO a complete html document, so
  // checking for <html> first would read every design component as astro.
  const script = X_DC_SCRIPT.test(text);
  const element = X_DC_ELEMENT.test(text);
  if (script || element) {
    const markers = [element && '<x-dc> template', script && 'text/x-dc logic script']
      .filter(Boolean)
      .join(' and ');
    return {
      target: 'react',
      hasLogic,
      // A dc template with no logic class is a react-target file that is broken,
      // not an astro file. dc-gen's existing error names it precisely; saying
      // "unknown" here would replace a good message with a vague one.
      evidence: hasLogic
        ? `react: ${markers}`
        : `react: ${markers}, but no "class Component extends DCLogic"`,
    };
  }

  if (HTML_DOCTYPE.test(text) || HTML_ELEMENT.test(text)) {
    return {
      target: 'astro',
      hasLogic,
      evidence: 'astro: plain html document, no <x-dc> and no text/x-dc script',
    };
  }

  return {
    target: null,
    hasLogic,
    evidence: 'no target: no <x-dc> and no <html> element, so this is a fragment, not a page',
  };
}

/* ---------- assertTarget ------------------------------------------------- */

/**
 * The enforcement seam. Agrees, or throws with the evidence.
 *
 * @param {object} a
 * @param {ReturnType<typeof detect>} a.detected  what the file says
 * @param {string} [a.requested]                  what --target asked for
 * @param {string} [a.file]                       path, for the message only
 * @returns {'react'|'astro'}
 */
export function assertTarget({ detected, requested, file = 'the entry file' }) {
  if (!detected || typeof detected !== 'object') {
    throw new Error(`dc-detect: ${file}: detect() result is required`);
  }

  if (requested !== undefined && !TARGETS.includes(requested)) {
    throw new Error(
      `dc-detect: ${file}: --target ${requested} is not a target. ` +
        `Known targets: ${TARGETS.join(', ')}.`,
    );
  }

  if (detected.target === null) {
    throw new Error(
      `dc-detect: ${file}: cannot tell which converter this belongs to. ` +
        `${detected.evidence}. Point --entry at a page, not a fragment.`,
    );
  }

  if (requested === undefined) return detected.target;

  if (requested !== detected.target) {
    throw new Error(
      `dc-detect: ${file}: --target ${requested} contradicts the file, which is ` +
        `${detected.target}. Evidence: ${detected.evidence}. ` +
        `Drop the flag and let the file decide, or fix the file.`,
    );
  }

  return detected.target;
}
