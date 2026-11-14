// Type-level test for llms-ink/ai: compiled by `tsc -p test/tsconfig.json` in `npm test`, never run.
import { generateText, streamText, stepCountIs, type ToolSet } from 'ai';
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test';
import { LlmsInk } from '../dist/index.js';
import { llmsInkTools, type AgentViewOutput, type LlmsInkToolError, type LlmsTextOutput } from '../dist/ai.js';

const all = llmsInkTools();
const asToolSet: ToolSet = all;

const v4 = await generateText({ model: new MockLanguageModelV4(), tools: llmsInkTools(), stopWhen: stepCountIs(5), prompt: 'Read llmstxt.org' });
for (const result of v4.toolResults) {
  if (result.dynamic) continue;
  if (result.toolName === 'llmsTxt') {
    const output: LlmsTextOutput | LlmsInkToolError = result.output;
    if (!('error' in output)) output.truncated satisfies boolean;
  }
  if (result.toolName === 'agentView') result.output satisfies AgentViewOutput | LlmsInkToolError;
}

await generateText({ model: new MockLanguageModelV3(), tools: llmsInkTools({ client: new LlmsInk(), maxChars: 10_000 }), prompt: 'x' });
streamText({ model: new MockLanguageModelV4(), tools: { ...llmsInkTools({ client: { key: 'lk_x' } }) }, prompt: 'x' });

// include narrows the returned tools.
const some = llmsInkTools({ include: ['llmsTxt', 'checkLlmsTxt'] });
some.llmsTxt satisfies NonNullable<unknown>;
some.checkLlmsTxt satisfies NonNullable<unknown>;
// @ts-expect-error agentView wasn't included
some.agentView;
// @ts-expect-error not a tool name
llmsInkTools({ include: ['fetch'] });

// Inputs are typed from the zod schemas.
await all.llmsFullTxt.execute?.({ url: 'example.com', fresh: true }, { toolCallId: '1', messages: [], context: {} });
// @ts-expect-error url is required
await all.agentView.execute?.({}, { toolCallId: '1', messages: [], context: {} });

export { asToolSet };
