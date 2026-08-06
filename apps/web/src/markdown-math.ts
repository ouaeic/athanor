/**
 * Deciding whether a message contains maths, without loading a maths renderer to find out.
 *
 * KaTeX plus its stylesheet and font faces is the single largest thing the transcript can pull in,
 * and an agent transcript almost never contains LaTeX. Answering the question with a regular
 * expression keeps the whole maths stack out of the default experience.
 */

/** `$$ … $$`, which remark-math treats as display maths wherever it appears. */
const displayMath = /\$\$[\s\S]+?\$\$/;

/**
 * Inline `$ … $`. The delimiters are deliberately strict, because prose about money is far more
 * common than prose about mathematics: an opening `$` may not be followed by whitespace, a closing
 * `$` may not be preceded by whitespace or followed by a word character. That rejects "$5 and $7"
 * and "$50-$70" while still accepting "$x^2$".
 */
const inlineMath = /(?:^|[\s(])\$(?![\s$])[^$\n]{1,200}?(?<![\s\\])\$(?![\w$])/;

export const containsMath = (source: string): boolean =>
  source.includes('$') && (displayMath.test(source) || inlineMath.test(source));
