/**
 * Text sanitizer — strips raw function-call XML tags that some AI models
 * output as text instead of proper tool calls.
 *
 * Some models (especially older Claude/Anthropic models or models fine-tuned
 * on function-calling corpora) emit XML-style tags like:
 *   <function_calls>, <function_results>, <antc_invocation>,
 *   <invoke>, <output>, <parameter>, etc.
 *
 * These should be parsed as tool calls by the runtime, but when they leak
 * into the text stream they show up as raw XML in the chat bubble. This
 * module strips them so the user only sees clean markdown.
 */

/**
 * Strip function-call XML tags + their content from a text string.
 * Also strips any residual unclosed tags.
 *
 * Tags stripped (with content):
 *   <function_results>...</function_results>
 *   <function_calls>...</function_calls>
 *   <antc_invocation>...</antc_invocation>
 *   <invoke>...</invoke>
 *   <output>...</output>
 *   <parameter>...</parameter>
 *   <antml:parameter>...</antml:parameter>
 *   <antml:invoke>...</antml:invoke>
 *
 * Also strips unclosed opening tags (e.g. "<function_calls>" at the end
 * of a streaming chunk) and stray closing tags.
 */
export function stripFunctionCallTags(text: string): string {
  if (!text) return text;

  let result = text;

  // Strip paired tags WITH content (case-insensitive, multiline).
  // Matches: <tag>...</tag> where tag is one of the known function-call tags.
  // The [s\S]*? is a non-greedy match that spans newlines.
  const pairedTagPattern =
    /<(function_results|function_calls|antc_invocation|antc_invocation|invoke|output|parameter|antml:parameter|antml:invoke|antml:function_calls|antml:function_results|antml:output|antml:artifact|artifact|system|tool_call|tool_result)\b[^>]*>[\s\S]*?<\/\1>/gi;
  result = result.replace(pairedTagPattern, "");

  // Strip unclosed opening tags (e.g. "<function_calls>" at end of stream).
  // This matches an opening tag with NO corresponding closing tag.
  const unclosedTagPattern =
    /<(function_results|function_calls|antc_invocation|invoke|output|parameter|antml:parameter|antml:invoke|antml:function_calls|antml:function_results|antml:output|antml:artifact|artifact|system|tool_call|tool_result)\b[^>]*>/gi;
  result = result.replace(unclosedTagPattern, "");

  // Strip stray closing tags (no matching opening tag).
  const strayClosingPattern =
    /<\/(function_results|function_calls|antc_invocation|invoke|output|parameter|antml:parameter|antml:invoke|antml:function_calls|antml:function_results|antml:output|antml:artifact|artifact|system|tool_call|tool_result)>/gi;
  result = result.replace(strayClosingPattern, "");

  // Strip "ERROR:TOOL_OUTPUT_PARSE_FAILED" style error messages that some
  // models emit when they fail to parse their own tool output.
  result = result.replace(/ERROR:\s*TOOL_OUTPUT_PARSE_FAILED[^\n]*/gi, "");

  // Clean up: remove excessive blank lines left behind by the stripping.
  // 3+ consecutive newlines → 2 newlines (one blank line).
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim trailing whitespace/lines.
  result = result.replace(/\s+$/g, "");

  return result;
}
