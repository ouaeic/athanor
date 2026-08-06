import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/**
 * Every part of maths rendering behind one dynamic import: the parser that turns `$…$` into maths
 * nodes, the renderer that turns those nodes into markup, and the stylesheet that declares the
 * font faces. Splitting them would mean loading a parser whose output nothing can render, and
 * leaving the stylesheet eager would keep the @font-face declarations — and therefore the fonts —
 * in the default page.
 */
export const mathPlugins = { remark: remarkMath, rehype: rehypeKatex };
export type MathPlugins = typeof mathPlugins;
